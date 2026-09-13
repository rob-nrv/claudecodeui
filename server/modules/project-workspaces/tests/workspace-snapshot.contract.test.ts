import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assessWorkspaceRestore,
  computeWorkspaceChangesDigest,
  validateWorkspaceSnapshotManifest,
  WORKSPACE_SNAPSHOT_SCHEMA,
  type WorkspaceSnapshotChange,
  type WorkspaceSnapshotManifestV1,
} from '@/modules/project-workspaces/workspace-snapshot.contract.js';
import type { WorkspaceObservation } from '@/modules/project-workspaces/workspace-state.js';

const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);
const ROOT = 'c'.repeat(40);
const SHA = 'd'.repeat(64);

const changes: WorkspaceSnapshotChange[] = [
  { path: 'src/app.ts', change: 'modified', previousPath: null, contentSha256: SHA, sizeBytes: 120, mode: 'file' },
  { path: 'docs/removed.md', change: 'deleted', previousPath: null, contentSha256: null, sizeBytes: null, mode: null },
  { path: 'src/new-name.ts', change: 'renamed', previousPath: 'src/old-name.ts', contentSha256: SHA, sizeBytes: 10, mode: 'file' },
];

const manifest = (overrides: Partial<Record<keyof WorkspaceSnapshotManifestV1, unknown>> = {}): Record<string, unknown> => ({
  schema: WORKSPACE_SNAPSHOT_SCHEMA,
  version: 1,
  snapshotId: '0f8fad5b-d9cb-469f-a165-70867728950e',
  projectId: 'project-1',
  createdAt: '2026-09-13T12:00:00.000Z',
  sourceNodeId: 'pc-node',
  parentSnapshotId: null,
  git: { rootCommits: [ROOT], branch: 'main', headCommit: HEAD },
  changes,
  exclusions: { localOnly: 3, secret: 1, userExcluded: 0, policy: { version: 1, userExcludePatterns: [] } },
  changesDigest: computeWorkspaceChangesDigest(changes),
  payload: { transport: 'none' },
  ...overrides,
});

test('the change digest is order-independent and covers path, kind, origin and content', () => {
  const digest = computeWorkspaceChangesDigest(changes);
  assert.equal(computeWorkspaceChangesDigest([...changes].reverse()), digest);
  assert.notEqual(computeWorkspaceChangesDigest([{ ...changes[0], contentSha256: 'e'.repeat(64) }, changes[1], changes[2]]), digest);
  assert.notEqual(computeWorkspaceChangesDigest([changes[0], changes[1], { ...changes[2], previousPath: 'src/other.ts' }]), digest);
  assert.match(computeWorkspaceChangesDigest([]), /^[0-9a-f]{64}$/);
});

test('a valid manifest validates, and the validated copy carries only contract fields', () => {
  const result = validateWorkspaceSnapshotManifest(manifest());
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.manifest.changes.length, 3);
});

test('credentials can never ride in a snapshot: unknown fields, secret paths and local-only paths are refused', () => {
  const errorsOf = (value: unknown) => {
    const result = validateWorkspaceSnapshotManifest(value);
    return result.ok ? [] : result.errors;
  };
  assert.ok(errorsOf(manifest({ claudeCredentials: { accessToken: 'sk-ant-oat01-x' } } as never)).includes('unknown_manifest_fields'));
  assert.ok(errorsOf(manifest({ git: { rootCommits: [ROOT], branch: 'main', headCommit: HEAD, remoteUrl: 'https://u:t@x' } })).includes('invalid_git'));

  const withSecret = [...changes, { path: '.env', change: 'added', previousPath: null, contentSha256: SHA, sizeBytes: 5, mode: 'file' }];
  assert.ok(errorsOf(manifest({ changes: withSecret, changesDigest: computeWorkspaceChangesDigest(withSecret as WorkspaceSnapshotChange[]) })).includes('non_syncable_change_path'));

  const renamedFromKey = [{ path: 'notes.txt', change: 'renamed', previousPath: 'deploy/id_rsa', contentSha256: SHA, sizeBytes: 5, mode: 'file' }];
  assert.ok(errorsOf(manifest({ changes: renamedFromKey })).includes('non_syncable_change_path'));

  const localOnly = [{ path: 'node_modules/x/index.js', change: 'added', previousPath: null, contentSha256: SHA, sizeBytes: 5, mode: 'file' }];
  assert.ok(errorsOf(manifest({ changes: localOnly })).includes('non_syncable_change_path'));

  const excludedByProject = [{ path: 'media/intro.mp4', change: 'added', previousPath: null, contentSha256: SHA, sizeBytes: 5, mode: 'file' }];
  assert.ok(errorsOf(manifest({
    changes: excludedByProject,
    exclusions: { localOnly: 0, secret: 0, userExcluded: 1, policy: { version: 1, userExcludePatterns: ['media/'] } },
  })).includes('non_syncable_change_path'));

  for (const unsafe of ['/etc/passwd', '../outside.ts', 'C:\\Users\\x.ts', 'src/../../x.ts', 'src\\win.ts']) {
    const entry = [{ path: unsafe, change: 'added', previousPath: null, contentSha256: SHA, sizeBytes: 5, mode: 'file' }];
    assert.ok(errorsOf(manifest({ changes: entry })).includes('unsafe_change_path'), unsafe);
  }
});

test('a manifest that lies about its change set, its ids or its transport is refused', () => {
  const errorsOf = (value: unknown) => {
    const result = validateWorkspaceSnapshotManifest(value);
    return result.ok ? [] : result.errors;
  };
  assert.deepEqual(errorsOf(manifest({ changesDigest: 'f'.repeat(64) })), ['changes_digest_mismatch']);
  assert.ok(errorsOf(manifest({ snapshotId: 'snapshot-1' })).includes('invalid_snapshot_id'));
  assert.ok(errorsOf(manifest({ projectId: '/home/robin/app' })).includes('invalid_project_id'));
  assert.ok(errorsOf(manifest({ payload: { transport: 's3', bucket: 'x' } })).includes('unsupported_payload_transport'), 'no storage transport exists in FT-M09');
  assert.ok(errorsOf(manifest({ version: 2 })).includes('unsupported_schema'));
  const duplicate = [changes[0], { ...changes[0] }];
  assert.ok(errorsOf(manifest({ changes: duplicate, changesDigest: computeWorkspaceChangesDigest(duplicate) })).includes('duplicate_change_path'));
  const deletedWithHash = [{ ...changes[1], contentSha256: SHA }];
  assert.ok(errorsOf(manifest({ changes: deletedWithHash })).includes('invalid_change_entry'));
  assert.deepEqual(errorsOf(null), ['manifest_not_object']);
});

const target = (overrides: Partial<WorkspaceObservation> = {}): WorkspaceObservation => ({
  folder: 'available',
  folderReason: null,
  git: { state: 'repository', rootIsFolder: true, branch: 'main', detached: false, headCommit: HEAD, rootCommits: [ROOT], upstream: null },
  changes: { staged: 0, modified: 0, added: 0, deleted: 0, renamed: 0, untracked: 0, conflicted: 0, total: 0, truncated: false },
  sync: { syncable: 0, localOnly: 0, secret: 0, userExcluded: 0, secretContent: 0, changesDigest: computeWorkspaceChangesDigest([]), digestReason: null },
  ...overrides,
});

test('restore assessment applies only onto a clean copy at the same revision, and never overwrites local work', () => {
  const validated = validateWorkspaceSnapshotManifest(manifest());
  assert.ok(validated.ok);
  const snapshot = validated.manifest;
  const dirty = (digest: string | null, truncated = false) => ({
    changes: { staged: 0, modified: 3, added: 0, deleted: 0, renamed: 0, untracked: 0, conflicted: 0, total: 3, truncated },
    sync: { syncable: 3, localOnly: 0, secret: 0, userExcluded: 0, secretContent: 0, changesDigest: digest, digestReason: digest ? null : 'change_too_large' },
  });

  assert.deepEqual(assessWorkspaceRestore({ target: target(), snapshot }), { decision: 'apply', blockers: [] });
  assert.deepEqual(assessWorkspaceRestore({ target: target(dirty(snapshot.changesDigest)), snapshot }), { decision: 'up_to_date', blockers: [] });
  assert.deepEqual(assessWorkspaceRestore({ target: target(dirty(snapshot.changesDigest, true)), snapshot }).blockers, ['target_has_local_changes'], 'a truncated count is not identity');
  assert.deepEqual(assessWorkspaceRestore({ target: target(dirty('9'.repeat(64))), snapshot }).blockers, ['target_has_local_changes']);
  assert.deepEqual(assessWorkspaceRestore({ target: target(dirty(null)), snapshot }).blockers, ['target_has_local_changes']);

  const otherRevision = target({ git: { state: 'repository', rootIsFolder: true, branch: 'main', detached: false, headCommit: OTHER_HEAD, rootCommits: [ROOT], upstream: null } });
  assert.deepEqual(assessWorkspaceRestore({ target: otherRevision, snapshot }).blockers, ['revision_differs'], 'ancestry is never guessed across nodes');

  const foreign = target({ git: { state: 'repository', rootIsFolder: true, branch: 'main', detached: false, headCommit: HEAD, rootCommits: ['e'.repeat(40)], upstream: null } });
  assert.deepEqual(assessWorkspaceRestore({ target: foreign, snapshot }).blockers, ['identity_mismatch']);

  const diverged = target({
    git: { state: 'repository', rootIsFolder: true, branch: 'main', detached: false, headCommit: HEAD, rootCommits: [ROOT], upstream: { ahead: 1, behind: 1 } },
    changes: { staged: 0, modified: 0, added: 0, deleted: 0, renamed: 0, untracked: 0, conflicted: 2, total: 2, truncated: false },
  });
  assert.deepEqual(assessWorkspaceRestore({ target: diverged, snapshot }).blockers, ['target_has_unmerged_paths', 'target_diverged', 'target_has_local_changes']);

  assert.deepEqual(assessWorkspaceRestore({ target: target({ folder: 'missing', folderReason: 'folder_not_found' }), snapshot }).blockers, ['target_missing']);
  assert.deepEqual(assessWorkspaceRestore({ target: target({ folder: 'unavailable', folderReason: 'x' }), snapshot }).blockers, ['target_unavailable']);
  assert.deepEqual(assessWorkspaceRestore({ target: target({ git: { state: 'unknown', reason: 'git_timeout' } }), snapshot }).blockers, ['target_state_unknown']);
  assert.deepEqual(assessWorkspaceRestore({ target: target({ git: { state: 'not_repository' } }), snapshot }).blockers, ['git_state_mismatch']);
});
