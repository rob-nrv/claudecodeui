// Workspace Snapshot contract, version 1 (FT-M09). A snapshot describes enough
// of one project's local working copy for another RuntimeNode to compare with,
// or later reconstruct, that state. It COMPLEMENTS Git: committed history
// travels through Git (branch, HEAD, root commits); a snapshot adds the
// uncommitted, syncable change set on top of that HEAD.
//
// Not implemented in FT-M09, on purpose: building snapshot payloads, any
// upload/storage transport, and applying a snapshot. `payload.transport` is
// therefore always `none`. The validator and the restore assessment exist so
// the next mission can add transport without redefining identity, exclusions
// or the conflict model.
import { createHash } from 'node:crypto';

import {
  classifyWorkspacePath,
  DEFAULT_WORKSPACE_SYNC_POLICY,
  normalizeWorkspaceRelativePath,
  normalizeWorkspaceSyncPolicy,
  type WorkspaceSyncPolicy,
} from '@/modules/project-workspaces/workspace-sync-policy.js';
import { isCommitHash, type WorkspaceObservation } from '@/modules/project-workspaces/workspace-state.js';

export const WORKSPACE_SNAPSHOT_SCHEMA = 'cloudcli.workspace-snapshot';

export type WorkspaceSnapshotChange = {
  /** Project-relative POSIX path of a SYNCABLE file. */
  path: string;
  change: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';
  previousPath: string | null;
  /** SHA-256 of the file content (link target for a symlink); null only for a deletion. */
  contentSha256: string | null;
  sizeBytes: number | null;
  mode: 'file' | 'executable' | 'symlink' | null;
};

export type WorkspaceSnapshotManifestV1 = {
  schema: typeof WORKSPACE_SNAPSHOT_SCHEMA;
  version: 1;
  snapshotId: string;
  /** Global project identity; never a filesystem path. */
  projectId: string;
  createdAt: string;
  /** The RuntimeNode whose local working copy was captured. */
  sourceNodeId: string;
  /** The snapshot this one was taken on top of, when known: lineage for three-way conflict checks. */
  parentSnapshotId: string | null;
  /** Null when the workspace is not a Git repository. */
  git: {
    rootCommits: string[];
    branch: string | null;
    /** The commit the change set applies on top of. */
    headCommit: string | null;
  } | null;
  changes: WorkspaceSnapshotChange[];
  /** What was left out, as counts only: excluded file names are never recorded. */
  exclusions: { localOnly: number; secret: number; userExcluded: number; policy: WorkspaceSyncPolicy };
  /** `computeWorkspaceChangesDigest(changes)`; the conflict basis compared across nodes. */
  changesDigest: string;
  payload: { transport: 'none' };
};

export type SnapshotValidation = { ok: true; manifest: WorkspaceSnapshotManifestV1 } | { ok: false; errors: string[] };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const BRANCH_PATTERN = /^[A-Za-z0-9._/+-]{1,200}$/;
const MAX_CHANGES = 50_000;
const MAX_FILE_BYTES = 1024 ** 3;
const MANIFEST_KEYS = ['schema', 'version', 'snapshotId', 'projectId', 'createdAt', 'sourceNodeId', 'parentSnapshotId', 'git', 'changes', 'exclusions', 'changesDigest', 'payload'];
const CHANGE_KEYS = ['path', 'change', 'previousPath', 'contentSha256', 'sizeBytes', 'mode'];
const CHANGE_KINDS = new Set(['modified', 'added', 'deleted', 'renamed', 'untracked']);
const MODES = new Set(['file', 'executable', 'symlink']);

/**
 * Deterministic digest of a change set: order-independent, covers paths,
 * kinds, previous paths and content hashes. Two nodes with the same HEAD and
 * the same digest hold the same syncable working copy.
 */
export function computeWorkspaceChangesDigest(changes: Array<Pick<WorkspaceSnapshotChange, 'path' | 'change' | 'previousPath' | 'contentSha256'>>): string {
  const lines = changes
    .map((change) => [change.change, change.path, change.previousPath ?? '', change.contentSha256 ?? 'deleted'].join('\0'))
    .sort();
  const hash = createHash('sha256');
  for (const line of lines) {
    hash.update(line);
    hash.update('\n');
  }
  return hash.digest('hex');
}

function exactKeys(record: Record<string, unknown>, allowed: string[]): string[] {
  const allowedSet = new Set(allowed);
  return Object.keys(record).filter((key) => !allowedSet.has(key));
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_CHANGES * 100;

/**
 * Validates an untrusted manifest. Unknown fields are rejected (nothing can
 * ride along, such as a token or a config path), every changed path must be a
 * safe relative path that the sync policy classifies as syncable, and the
 * digest must match the change set it claims to describe.
 */
export function validateWorkspaceSnapshotManifest(value: unknown): SnapshotValidation {
  const errors: string[] = [];
  const record = readRecord(value);
  if (!record) {
    return { ok: false, errors: ['manifest_not_object'] };
  }
  const extra = exactKeys(record, MANIFEST_KEYS);
  if (extra.length > 0) errors.push('unknown_manifest_fields');
  if (record.schema !== WORKSPACE_SNAPSHOT_SCHEMA || record.version !== 1) errors.push('unsupported_schema');
  if (typeof record.snapshotId !== 'string' || !UUID_PATTERN.test(record.snapshotId)) errors.push('invalid_snapshot_id');
  if (typeof record.projectId !== 'string' || !ID_PATTERN.test(record.projectId)) errors.push('invalid_project_id');
  if (typeof record.sourceNodeId !== 'string' || !ID_PATTERN.test(record.sourceNodeId)) errors.push('invalid_source_node_id');
  if (record.parentSnapshotId !== null && (typeof record.parentSnapshotId !== 'string' || !UUID_PATTERN.test(record.parentSnapshotId))) {
    errors.push('invalid_parent_snapshot_id');
  }
  if (typeof record.createdAt !== 'string' || Number.isNaN(Date.parse(record.createdAt))) errors.push('invalid_created_at');

  const exclusions = readRecord(record.exclusions);
  const policyResult = normalizeWorkspaceSyncPolicy(exclusions?.policy);
  const policy = policyResult.policy;
  if (!exclusions || exactKeys(exclusions, ['localOnly', 'secret', 'userExcluded', 'policy']).length > 0
    || !isCount(exclusions.localOnly) || !isCount(exclusions.secret) || !isCount(exclusions.userExcluded)
    || policyResult.rejectedPatterns > 0) {
    errors.push('invalid_exclusions');
  }

  let git: WorkspaceSnapshotManifestV1['git'] = null;
  if (record.git !== null) {
    const gitRecord = readRecord(record.git);
    if (!gitRecord || exactKeys(gitRecord, ['rootCommits', 'branch', 'headCommit']).length > 0
      || !Array.isArray(gitRecord.rootCommits) || gitRecord.rootCommits.length > 3 || !gitRecord.rootCommits.every(isCommitHash)
      || (gitRecord.branch !== null && (typeof gitRecord.branch !== 'string' || !BRANCH_PATTERN.test(gitRecord.branch)))
      || (gitRecord.headCommit !== null && !isCommitHash(gitRecord.headCommit))) {
      errors.push('invalid_git');
    } else {
      git = { rootCommits: [...gitRecord.rootCommits as string[]], branch: gitRecord.branch as string | null, headCommit: gitRecord.headCommit as string | null };
    }
  }

  const changes: WorkspaceSnapshotChange[] = [];
  if (!Array.isArray(record.changes) || record.changes.length > MAX_CHANGES) {
    errors.push('invalid_changes');
  } else {
    const seen = new Set<string>();
    for (const entry of record.changes) {
      const change = readRecord(entry);
      if (!change || exactKeys(change, CHANGE_KEYS).length > 0 || !CHANGE_KINDS.has(String(change.change))) {
        errors.push('invalid_change_entry');
        continue;
      }
      const pathValue = normalizeWorkspaceRelativePath(change.path);
      const previousPath = change.previousPath === null ? null : normalizeWorkspaceRelativePath(change.previousPath);
      if (!pathValue || pathValue !== change.path || (change.previousPath !== null && (!previousPath || previousPath !== change.previousPath))) {
        errors.push('unsafe_change_path');
        continue;
      }
      const classes = [classifyWorkspacePath(pathValue, policy).syncClass, ...(previousPath ? [classifyWorkspacePath(previousPath, policy).syncClass] : [])];
      if (classes.some((syncClass) => syncClass !== 'syncable')) {
        errors.push('non_syncable_change_path');
        continue;
      }
      const deleted = change.change === 'deleted';
      const hashOk = deleted ? change.contentSha256 === null : typeof change.contentSha256 === 'string' && SHA256_PATTERN.test(change.contentSha256);
      const sizeOk = deleted ? change.sizeBytes === null : typeof change.sizeBytes === 'number' && Number.isInteger(change.sizeBytes) && change.sizeBytes >= 0 && change.sizeBytes <= MAX_FILE_BYTES;
      const modeOk = deleted ? change.mode === null : MODES.has(String(change.mode));
      const renameOk = change.change === 'renamed' ? previousPath !== null : previousPath === null;
      if (!hashOk || !sizeOk || !modeOk || !renameOk) {
        errors.push('invalid_change_entry');
        continue;
      }
      if (seen.has(pathValue)) {
        errors.push('duplicate_change_path');
        continue;
      }
      seen.add(pathValue);
      changes.push({
        path: pathValue,
        change: change.change as WorkspaceSnapshotChange['change'],
        previousPath,
        contentSha256: change.contentSha256 as string | null,
        sizeBytes: change.sizeBytes as number | null,
        mode: change.mode as WorkspaceSnapshotChange['mode'],
      });
    }
  }

  if (typeof record.changesDigest !== 'string' || !SHA256_PATTERN.test(record.changesDigest)) {
    errors.push('invalid_changes_digest');
  } else if (errors.length === 0 && computeWorkspaceChangesDigest(changes) !== record.changesDigest) {
    errors.push('changes_digest_mismatch');
  }

  const payload = readRecord(record.payload);
  if (!payload || exactKeys(payload, ['transport']).length > 0 || payload.transport !== 'none') {
    errors.push('unsupported_payload_transport');
  }

  if (errors.length > 0) {
    return { ok: false, errors: [...new Set(errors)] };
  }
  return {
    ok: true,
    manifest: {
      schema: WORKSPACE_SNAPSHOT_SCHEMA,
      version: 1,
      snapshotId: record.snapshotId as string,
      projectId: record.projectId as string,
      createdAt: record.createdAt as string,
      sourceNodeId: record.sourceNodeId as string,
      parentSnapshotId: record.parentSnapshotId as string | null,
      git,
      changes,
      exclusions: {
        localOnly: (exclusions as Record<string, number>).localOnly,
        secret: (exclusions as Record<string, number>).secret,
        userExcluded: (exclusions as Record<string, number>).userExcluded,
        policy: policy ?? DEFAULT_WORKSPACE_SYNC_POLICY,
      },
      changesDigest: record.changesDigest as string,
      payload: { transport: 'none' },
    },
  };
}

export type WorkspaceRestoreBlocker =
  | 'target_missing'
  | 'target_unavailable'
  | 'target_state_unknown'
  | 'identity_mismatch'
  | 'target_has_unmerged_paths'
  | 'target_diverged'
  | 'target_has_local_changes'
  | 'revision_differs'
  | 'git_state_mismatch';

export type WorkspaceRestoreAssessment =
  | { decision: 'up_to_date'; blockers: [] }
  | { decision: 'apply'; blockers: [] }
  | { decision: 'blocked'; blockers: WorkspaceRestoreBlocker[] };

/**
 * Decides whether a snapshot could be applied to a target node's working copy
 * WITHOUT losing anything. It never guesses: any local change, divergence,
 * foreign history or unknown state blocks, and a different HEAD blocks too
 * (ancestry across nodes cannot be judged without fetching, which this does
 * not do). A future "Continue Here" must stop on `blocked` and show the
 * blockers to the user.
 */
export function assessWorkspaceRestore(input: { target: WorkspaceObservation; snapshot: WorkspaceSnapshotManifestV1 }): WorkspaceRestoreAssessment {
  const { target, snapshot } = input;
  const blocked = (...blockers: WorkspaceRestoreBlocker[]): WorkspaceRestoreAssessment => ({ decision: 'blocked', blockers });

  if (target.folder === 'missing') return blocked('target_missing');
  if (target.folder !== 'available') return blocked('target_unavailable');

  const git = target.git;
  if (git.state === 'unknown' || !target.changes || !target.sync) return blocked('target_state_unknown');
  if ((git.state === 'repository') !== (snapshot.git !== null)) return blocked('git_state_mismatch');

  const blockers: WorkspaceRestoreBlocker[] = [];
  if (git.state === 'repository' && snapshot.git) {
    const snapshotRoots = new Set(snapshot.git.rootCommits);
    if (git.rootCommits.length === 0 || snapshotRoots.size === 0 || !git.rootCommits.some((commit) => snapshotRoots.has(commit))) {
      return blocked('identity_mismatch');
    }
    if (target.changes.conflicted > 0) blockers.push('target_has_unmerged_paths');
    if (git.upstream && git.upstream.ahead > 0 && git.upstream.behind > 0) blockers.push('target_diverged');
  }

  const sameRevision = git.state !== 'repository' || (snapshot.git !== null && git.headCommit === snapshot.git.headCommit);
  if (target.changes.total > 0) {
    const identical = sameRevision && target.sync.changesDigest !== null && target.sync.changesDigest === snapshot.changesDigest && !target.changes.truncated;
    if (identical && blockers.length === 0) {
      return { decision: 'up_to_date', blockers: [] };
    }
    blockers.push('target_has_local_changes');
  }
  if (!sameRevision) blockers.push('revision_differs');

  if (blockers.length > 0) {
    return blocked(...blockers);
  }
  return snapshot.changes.length === 0 ? { decision: 'up_to_date', blockers: [] } : { decision: 'apply', blockers: [] };
}
