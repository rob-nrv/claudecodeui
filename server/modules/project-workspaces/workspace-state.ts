// Local workspace state for one project on one RuntimeNode (FT-M09). Pure: the
// inspector produces an observation on the node that owns the folder, the
// control plane re-validates it as untrusted input, and classification turns
// it into a state that never guesses. Nothing here commits, resets, stashes,
// merges, overwrites or deletes.
import {
  classifyWorkspacePath,
  DEFAULT_WORKSPACE_SYNC_POLICY,
  type WorkspaceSyncPolicy,
} from '@/modules/project-workspaces/workspace-sync-policy.js';

export type WorkspaceChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'type_changed' | 'untracked' | 'conflicted';

export type GitStatusEntry = {
  /** Repository-relative POSIX path as Git reports it. */
  path: string;
  previousPath: string | null;
  kind: WorkspaceChangeKind;
  staged: boolean;
};

export type ParsedGitStatus = {
  branch: string | null;
  detached: boolean;
  /** Null for a repository without any commit yet. */
  headCommit: string | null;
  upstream: { ahead: number; behind: number } | null;
  entries: GitStatusEntry[];
  truncated: boolean;
};

export type WorkspaceChangeCounts = {
  staged: number;
  modified: number;
  added: number;
  deleted: number;
  renamed: number;
  untracked: number;
  conflicted: number;
  total: number;
  /** True when the node stopped counting at its limit: totals are lower bounds. */
  truncated: boolean;
};

export type WorkspaceSyncCounts = {
  syncable: number;
  localOnly: number;
  secret: number;
  userExcluded: number;
  /** Syncable-by-name files escalated to secret because their content carried a credential marker. */
  secretContent: number;
  /** SHA-256 over the syncable change set (paths, kinds, content hashes); the future conflict basis. */
  changesDigest: string | null;
  digestReason: string | null;
};

export type WorkspaceGitObservation =
  | {
    state: 'repository';
    /** Whether the Git work tree root is the mapped folder itself (false for a folder inside a larger repository). */
    rootIsFolder: boolean;
    branch: string | null;
    detached: boolean;
    headCommit: string | null;
    /** Root commits of HEAD's history (at most 3, sorted): repository identity that needs no remote URL. */
    rootCommits: string[];
    upstream: { ahead: number; behind: number } | null;
  }
  | { state: 'not_repository' }
  | { state: 'unknown'; reason: string };

/** What a node observed about one folder, with no path and no file name in it. */
export type WorkspaceObservation = {
  folder: 'available' | 'missing' | 'unavailable';
  folderReason: string | null;
  git: WorkspaceGitObservation;
  changes: WorkspaceChangeCounts | null;
  sync: WorkspaceSyncCounts | null;
};

export type WorkspaceStateClass = 'clean' | 'dirty' | 'missing' | 'unavailable' | 'identity_mismatch' | 'diverged' | 'unknown';
export type WorkspaceIdentityMatch = 'match' | 'mismatch' | 'unrecorded' | 'unknown';

const COMMIT_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const BRANCH_PATTERN = /^[A-Za-z0-9._/+-]{1,200}$/;
const MAX_COUNT = 10_000_000;

export function isCommitHash(value: unknown): value is string {
  return typeof value === 'string' && COMMIT_PATTERN.test(value);
}

function sanitizeReason(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  return value.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 64) || null;
}

function changeKind(code: string): WorkspaceChangeKind {
  if (code.includes('D')) return 'deleted';
  if (code.includes('A')) return 'added';
  if (code.includes('R')) return 'renamed';
  if (code.includes('C')) return 'copied';
  if (code.includes('T')) return 'type_changed';
  return 'modified';
}

/**
 * Parses `git status --porcelain=v2 --branch -z`. Paths may contain spaces,
 * so each record is split only up to its fixed field count. Unknown records
 * are skipped rather than guessed.
 */
export function parseGitStatusPorcelainV2(output: string, maxEntries = 50_000): ParsedGitStatus {
  const result: ParsedGitStatus = { branch: null, detached: false, headCommit: null, upstream: null, entries: [], truncated: false };
  const tokens = output.split('\0');
  const push = (entry: GitStatusEntry) => {
    if (result.entries.length >= maxEntries) {
      result.truncated = true;
      return;
    }
    result.entries.push(entry);
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;

    if (token.startsWith('# ')) {
      const [, key, ...rest] = token.split(' ');
      const value = rest.join(' ');
      if (key === 'branch.oid') {
        result.headCommit = isCommitHash(value) ? value : null;
      } else if (key === 'branch.head') {
        result.detached = value === '(detached)';
        result.branch = !result.detached && BRANCH_PATTERN.test(value) ? value : null;
      } else if (key === 'branch.ab') {
        const match = /^\+(\d+) -(\d+)$/.exec(value);
        if (match) {
          result.upstream = { ahead: Math.min(Number(match[1]), MAX_COUNT), behind: Math.min(Number(match[2]), MAX_COUNT) };
        }
      }
      continue;
    }

    const type = token[0];
    if (type === '1') {
      const fields = token.split(' ');
      const pathValue = fields.slice(8).join(' ');
      if (fields.length < 9 || !pathValue) continue;
      const code = fields[1] ?? '..';
      push({ path: pathValue, previousPath: null, kind: changeKind(code), staged: code[0] !== '.' });
    } else if (type === '2') {
      const fields = token.split(' ');
      const pathValue = fields.slice(9).join(' ');
      const previousPath = tokens[index + 1] ?? null;
      index += 1;
      if (fields.length < 10 || !pathValue) continue;
      const code = fields[1] ?? '..';
      push({ path: pathValue, previousPath, kind: code.includes('C') ? 'copied' : 'renamed', staged: code[0] !== '.' });
    } else if (type === 'u') {
      const fields = token.split(' ');
      const pathValue = fields.slice(10).join(' ');
      if (fields.length < 11 || !pathValue) continue;
      push({ path: pathValue, previousPath: null, kind: 'conflicted', staged: false });
    } else if (type === '?') {
      const pathValue = token.slice(2);
      if (pathValue) push({ path: pathValue, previousPath: null, kind: 'untracked', staged: false });
    }
    // `!` (ignored) records are not requested and never counted.
  }
  return result;
}

/** Counts changes by kind and by sync class. No content is read here. */
export function summarizeWorkspaceChanges(
  status: Pick<ParsedGitStatus, 'entries' | 'truncated'>,
  policy: WorkspaceSyncPolicy = DEFAULT_WORKSPACE_SYNC_POLICY,
): { changes: WorkspaceChangeCounts; sync: Omit<WorkspaceSyncCounts, 'secretContent' | 'changesDigest' | 'digestReason'> } {
  const changes: WorkspaceChangeCounts = {
    staged: 0, modified: 0, added: 0, deleted: 0, renamed: 0, untracked: 0, conflicted: 0, total: 0, truncated: status.truncated,
  };
  const sync = { syncable: 0, localOnly: 0, secret: 0, userExcluded: 0 };
  for (const entry of status.entries) {
    changes.total += 1;
    if (entry.staged) changes.staged += 1;
    if (entry.kind === 'untracked') changes.untracked += 1;
    else if (entry.kind === 'conflicted') changes.conflicted += 1;
    else if (entry.kind === 'deleted') changes.deleted += 1;
    else if (entry.kind === 'added') changes.added += 1;
    else if (entry.kind === 'renamed' || entry.kind === 'copied') changes.renamed += 1;
    else changes.modified += 1;

    const classes = [classifyWorkspacePath(entry.path, policy).syncClass];
    if (entry.previousPath) classes.push(classifyWorkspacePath(entry.previousPath, policy).syncClass);
    // The strictest class of either side of a rename wins.
    if (classes.includes('secret')) sync.secret += 1;
    else if (classes.includes('user_excluded')) sync.userExcluded += 1;
    else if (classes.includes('local_only')) sync.localOnly += 1;
    else sync.syncable += 1;
  }
  return { changes, sync };
}

export function resolveWorkspaceIdentity(currentRootCommits: string[], expectedRootCommits: string[] | null): WorkspaceIdentityMatch {
  if (!expectedRootCommits || expectedRootCommits.length === 0) {
    return 'unrecorded';
  }
  if (currentRootCommits.length === 0) {
    return 'unknown';
  }
  const expected = new Set(expectedRootCommits);
  return currentRootCommits.some((commit) => expected.has(commit)) ? 'match' : 'mismatch';
}

/**
 * Turns an observation into one state. Precedence: missing/unavailable >
 * unknown > identity_mismatch > dirty with unmerged paths > diverged > dirty >
 * clean. `expectedRootCommits` is the identity the node recorded when the
 * folder was mapped; without it identity is `unrecorded`, never assumed.
 */
export function classifyWorkspaceState(input: {
  observation: WorkspaceObservation;
  expectedRootCommits: string[] | null;
}): { state: WorkspaceStateClass; reason: string | null; identity: WorkspaceIdentityMatch } {
  const { observation } = input;
  if (observation.folder === 'missing') {
    return { state: 'missing', reason: observation.folderReason ?? 'folder_not_found', identity: 'unknown' };
  }
  if (observation.folder !== 'available') {
    return { state: 'unavailable', reason: observation.folderReason ?? 'folder_unavailable', identity: 'unknown' };
  }
  const git = observation.git;
  if (git.state === 'not_repository') {
    return { state: 'unknown', reason: 'not_git_repository', identity: 'unknown' };
  }
  if (git.state !== 'repository') {
    return { state: 'unknown', reason: git.reason, identity: 'unknown' };
  }
  const identity = resolveWorkspaceIdentity(git.rootCommits, input.expectedRootCommits);
  if (identity === 'mismatch') {
    return { state: 'identity_mismatch', reason: 'different_repository_history', identity };
  }
  if (!observation.changes) {
    return { state: 'unknown', reason: 'changes_unreadable', identity };
  }
  if (observation.changes.conflicted > 0) {
    return { state: 'dirty', reason: 'unmerged_paths', identity };
  }
  if (git.upstream && git.upstream.ahead > 0 && git.upstream.behind > 0) {
    return { state: 'diverged', reason: 'diverged_from_upstream', identity };
  }
  if (observation.changes.total > 0) {
    return { state: 'dirty', reason: 'uncommitted_changes', identity };
  }
  return { state: 'clean', reason: null, identity };
}

function readCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_COUNT ? value : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * Re-validates an observation received from a RuntimeNode. Every field is
 * rebuilt from known shapes, so a node can never smuggle a path, a file name
 * or an unknown field to the control plane or a browser. Returns null when
 * the answer is unusable.
 */
export function parseWorkspaceObservation(value: unknown): WorkspaceObservation | null {
  const record = readRecord(value);
  if (!record || !['available', 'missing', 'unavailable'].includes(String(record.folder))) {
    return null;
  }
  const folder = record.folder as WorkspaceObservation['folder'];

  const gitRecord = readRecord(record.git);
  let git: WorkspaceGitObservation;
  if (gitRecord?.state === 'repository') {
    const upstreamRecord = readRecord(gitRecord.upstream);
    const ahead = readCount(upstreamRecord?.ahead);
    const behind = readCount(upstreamRecord?.behind);
    git = {
      state: 'repository',
      rootIsFolder: gitRecord.rootIsFolder === true,
      branch: typeof gitRecord.branch === 'string' && BRANCH_PATTERN.test(gitRecord.branch) ? gitRecord.branch : null,
      detached: gitRecord.detached === true,
      headCommit: isCommitHash(gitRecord.headCommit) ? gitRecord.headCommit : null,
      rootCommits: Array.isArray(gitRecord.rootCommits) ? [...new Set(gitRecord.rootCommits.filter(isCommitHash))].sort().slice(0, 3) : [],
      upstream: ahead !== null && behind !== null ? { ahead, behind } : null,
    };
  } else if (gitRecord?.state === 'not_repository') {
    git = { state: 'not_repository' };
  } else {
    git = { state: 'unknown', reason: sanitizeReason(gitRecord?.reason) ?? 'not_reported' };
  }

  let changes: WorkspaceChangeCounts | null = null;
  const changesRecord = readRecord(record.changes);
  if (changesRecord) {
    const keys = ['staged', 'modified', 'added', 'deleted', 'renamed', 'untracked', 'conflicted', 'total'] as const;
    const values = keys.map((key) => readCount(changesRecord[key]));
    if (values.every((entry) => entry !== null)) {
      changes = Object.fromEntries(keys.map((key, index) => [key, values[index]])) as Omit<WorkspaceChangeCounts, 'truncated'> as WorkspaceChangeCounts;
      changes.truncated = changesRecord.truncated === true;
    }
  }

  let sync: WorkspaceSyncCounts | null = null;
  const syncRecord = readRecord(record.sync);
  if (syncRecord) {
    const keys = ['syncable', 'localOnly', 'secret', 'userExcluded', 'secretContent'] as const;
    const values = keys.map((key) => readCount(syncRecord[key]));
    if (values.every((entry) => entry !== null)) {
      const digest = typeof syncRecord.changesDigest === 'string' && DIGEST_PATTERN.test(syncRecord.changesDigest) ? syncRecord.changesDigest : null;
      sync = {
        ...(Object.fromEntries(keys.map((key, index) => [key, values[index]])) as Pick<WorkspaceSyncCounts, typeof keys[number]>),
        changesDigest: digest,
        digestReason: digest ? null : sanitizeReason(syncRecord.digestReason) ?? 'not_reported',
      };
    }
  }

  return {
    folder,
    folderReason: folder === 'available' ? null : sanitizeReason(record.folderReason) ?? 'not_reported',
    git: folder === 'available' ? git : { state: 'unknown', reason: 'folder_unavailable' },
    changes: folder === 'available' ? changes : null,
    sync: folder === 'available' ? sync : null,
  };
}
