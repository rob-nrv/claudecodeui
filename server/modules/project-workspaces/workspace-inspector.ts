// Bounded, read-only inspection of one local working copy (FT-M09). Runs on
// the machine that owns the folder: the node agent for its mapped folders, the
// control plane for its own local copy. Git runs with optional locks disabled
// and fsmonitor off, so inspecting never rewrites the index or starts a
// repository-configured helper; it never commits, stashes, resets or fetches.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { computeWorkspaceChangesDigest, type WorkspaceSnapshotChange } from '@/modules/project-workspaces/workspace-snapshot.contract.js';
import {
  isCommitHash,
  parseGitStatusPorcelainV2,
  summarizeWorkspaceChanges,
  type WorkspaceObservation,
} from '@/modules/project-workspaces/workspace-state.js';
import {
  classifyWorkspacePath,
  DEFAULT_WORKSPACE_SYNC_POLICY,
  detectSecretContentMarkers,
  SECRET_MARKER_SCAN_BYTES,
  type WorkspaceSyncPolicy,
} from '@/modules/project-workspaces/workspace-sync-policy.js';

export type GitRunner = (args: string[], cwd: string, timeoutMs: number) => Promise<string>;

export type WorkspaceInspectorOptions = {
  runGit?: GitRunner;
  policy?: WorkspaceSyncPolicy;
  maxEntries?: number;
  /** Largest single file hashed for the change digest. */
  maxFileBytes?: number;
  /** Total bytes hashed per inspection; beyond it the digest is reported as unavailable. */
  maxTotalBytes?: number;
};

const REV_PARSE_TIMEOUT_MS = 5_000;
const STATUS_TIMEOUT_MS = 15_000;
const ROOTS_TIMEOUT_MS = 10_000;
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;

function runGitCommand(args: string[], cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...args],
      {
        cwd,
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        // English messages so failures can be told apart; no prompt can ever block.
        env: { ...process.env, LC_ALL: 'C', LANG: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stderr: String(stderr ?? '') }));
          return;
        }
        resolve(String(stdout));
      },
    );
  });
}

/** Machine reason only; git error text can contain paths. */
function describeGitFailure(error: unknown): string {
  const candidate = (error ?? {}) as { code?: unknown; killed?: unknown; stderr?: unknown };
  if (candidate.code === 'ENOENT') return 'git_unavailable';
  if (candidate.killed === true || candidate.code === 'ETIMEDOUT') return 'git_timeout';
  if (candidate.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'git_output_too_large';
  const stderr = typeof candidate.stderr === 'string' ? candidate.stderr : '';
  if (/dubious ownership/i.test(stderr)) return 'git_refused_repository';
  if (/not a git repository/i.test(stderr)) return 'not_git_repository';
  return 'git_failed';
}

async function comparableRealPath(value: string): Promise<string> {
  const real = await fs.realpath(value);
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

type HashResult = { ok: true; sha256: string; size: number; mode: WorkspaceSnapshotChange['mode']; markers: string[] } | { ok: false; reason: string };

/**
 * Hashes one changed file. `root` is the Git top level (paths are relative to
 * it); `confinementReal` is the mapped folder's real path: a file whose real
 * location is outside it — through a linked parent folder — is never read.
 */
async function hashChangedFile(root: string, confinementReal: string, relativePath: string, maxFileBytes: number): Promise<HashResult> {
  const absolute = path.join(root, ...relativePath.split('/'));
  let stats;
  try {
    stats = await fs.lstat(absolute);
  } catch {
    return { ok: false, reason: 'change_unreadable' };
  }
  if (stats.isSymbolicLink()) {
    const target = await fs.readlink(absolute).catch(() => null);
    if (target === null) return { ok: false, reason: 'change_unreadable' };
    return { ok: true, sha256: createHash('sha256').update(target).digest('hex'), size: Buffer.byteLength(target), mode: 'symlink', markers: [] };
  }
  if (!stats.isFile()) {
    return { ok: false, reason: 'change_not_regular_file' };
  }
  if (stats.size > maxFileBytes) {
    return { ok: false, reason: 'change_too_large' };
  }
  try {
    // A parent folder that links out of the mapped folder is never followed.
    const real = process.platform === 'win32' ? (await fs.realpath(absolute)).toLowerCase() : await fs.realpath(absolute);
    const relative = path.relative(confinementReal, real);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      return { ok: false, reason: 'change_outside_workspace' };
    }
    const content = await fs.readFile(absolute);
    return {
      ok: true,
      sha256: createHash('sha256').update(content).digest('hex'),
      size: content.byteLength,
      mode: (stats.mode & 0o111) !== 0 && process.platform !== 'win32' ? 'executable' : 'file',
      markers: detectSecretContentMarkers(content.subarray(0, SECRET_MARKER_SCAN_BYTES)),
    };
  } catch {
    return { ok: false, reason: 'change_unreadable' };
  }
}

/**
 * Root commits of the repository containing `folder` (at most 3, sorted), or
 * an empty list when it is not a repository, has no commit yet, or Git could
 * not answer. Used when a folder is mapped, to record which history it holds.
 */
export async function readWorkspaceRootCommits(folder: string, runGit: GitRunner = runGitCommand): Promise<string[]> {
  try {
    if ((await runGit(['rev-parse', '--is-inside-work-tree'], folder, REV_PARSE_TIMEOUT_MS)).trim() !== 'true') {
      return [];
    }
    const output = await runGit(['rev-list', '--max-parents=0', 'HEAD'], folder, ROOTS_TIMEOUT_MS);
    return [...new Set(output.split(/\s+/).filter(isCommitHash))].sort().slice(0, 3);
  } catch {
    return [];
  }
}

/**
 * Inspects `folder` (already confined by the caller to its workspace root).
 * Returns counts, identity and a change digest — no path and no file name
 * leave this function.
 */
export async function inspectWorkspaceFolder(folder: string, options: WorkspaceInspectorOptions = {}): Promise<WorkspaceObservation> {
  const runGit = options.runGit ?? runGitCommand;
  const policy = options.policy ?? DEFAULT_WORKSPACE_SYNC_POLICY;
  const maxEntries = options.maxEntries ?? 20_000;
  const maxFileBytes = options.maxFileBytes ?? 16 * 1024 * 1024;
  const maxTotalBytes = options.maxTotalBytes ?? 64 * 1024 * 1024;

  try {
    const stats = await fs.stat(folder);
    if (!stats.isDirectory()) {
      return { folder: 'unavailable', folderReason: 'not_a_directory', git: { state: 'unknown', reason: 'folder_unavailable' }, changes: null, sync: null };
    }
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return code === 'ENOENT'
      ? { folder: 'missing', folderReason: 'folder_not_found', git: { state: 'unknown', reason: 'folder_unavailable' }, changes: null, sync: null }
      : { folder: 'unavailable', folderReason: 'folder_not_accessible', git: { state: 'unknown', reason: 'folder_unavailable' }, changes: null, sync: null };
  }

  const available = (git: WorkspaceObservation['git'], extra: Partial<WorkspaceObservation> = {}): WorkspaceObservation =>
    ({ folder: 'available', folderReason: null, git, changes: null, sync: null, ...extra });

  let topLevel: string;
  try {
    const [inside, top] = (await runGit(['rev-parse', '--is-inside-work-tree', '--show-toplevel'], folder, REV_PARSE_TIMEOUT_MS)).split(/\r?\n/);
    if (inside?.trim() !== 'true' || !top?.trim()) {
      return available({ state: 'not_repository' });
    }
    topLevel = top.trim();
  } catch (error) {
    const reason = describeGitFailure(error);
    return available(reason === 'not_git_repository' ? { state: 'not_repository' } : { state: 'unknown', reason });
  }

  let rootIsFolder = false;
  let folderReal = folder;
  try {
    folderReal = await comparableRealPath(folder);
    rootIsFolder = await comparableRealPath(topLevel) === folderReal;
  } catch {
    return available({ state: 'unknown', reason: 'git_root_unreadable' });
  }

  let status;
  try {
    // Limited to the mapped folder, even inside a larger repository.
    status = parseGitStatusPorcelainV2(
      await runGit(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all', '--', '.'], folder, STATUS_TIMEOUT_MS),
      maxEntries,
    );
  } catch (error) {
    return available({ state: 'unknown', reason: describeGitFailure(error) });
  }

  let rootCommits: string[] = [];
  if (status.headCommit) {
    try {
      const output = await runGit(['rev-list', '--max-parents=0', 'HEAD'], folder, ROOTS_TIMEOUT_MS);
      rootCommits = [...new Set(output.split(/\s+/).filter(isCommitHash))].sort().slice(0, 3);
    } catch {
      rootCommits = [];
    }
  }

  const summary = summarizeWorkspaceChanges(status, policy);
  let secretContent = 0;
  let digestReason: string | null = status.truncated ? 'change_set_truncated' : null;
  const digestEntries: Array<Pick<WorkspaceSnapshotChange, 'path' | 'change' | 'previousPath' | 'contentSha256'>> = [];
  let hashedBytes = 0;

  for (const entry of status.entries) {
    if (digestReason) break;
    const classes = [classifyWorkspacePath(entry.path, policy).syncClass, ...(entry.previousPath ? [classifyWorkspacePath(entry.previousPath, policy).syncClass] : [])];
    if (classes.some((syncClass) => syncClass !== 'syncable')) {
      continue;
    }
    if (entry.kind === 'conflicted') {
      digestReason = 'unmerged_paths';
      break;
    }
    const change: WorkspaceSnapshotChange['change'] = entry.kind === 'copied' ? 'added'
      : entry.kind === 'type_changed' ? 'modified'
        : entry.kind;
    if (change === 'deleted') {
      digestEntries.push({ path: entry.path, change, previousPath: null, contentSha256: null });
      continue;
    }
    const hashed = await hashChangedFile(topLevel, folderReal, entry.path, maxFileBytes);
    if (!hashed.ok) {
      digestReason = hashed.reason;
      break;
    }
    hashedBytes += hashed.size;
    if (hashed.markers.length > 0) {
      // Content wins over the name: this file is treated as secret and left out.
      secretContent += 1;
      continue;
    }
    if (hashedBytes > maxTotalBytes) {
      digestReason = 'change_set_too_large';
      break;
    }
    digestEntries.push({ path: entry.path, change, previousPath: change === 'renamed' ? entry.previousPath : null, contentSha256: hashed.sha256 });
  }

  return available(
    {
      state: 'repository',
      rootIsFolder,
      branch: status.branch,
      detached: status.detached,
      headCommit: status.headCommit,
      rootCommits,
      upstream: status.upstream,
    },
    {
      changes: summary.changes,
      sync: {
        syncable: Math.max(0, summary.sync.syncable - secretContent),
        localOnly: summary.sync.localOnly,
        secret: summary.sync.secret + secretContent,
        userExcluded: summary.sync.userExcluded,
        secretContent,
        changesDigest: digestReason ? null : computeWorkspaceChangesDigest(digestEntries),
        digestReason,
      },
    },
  );
}
