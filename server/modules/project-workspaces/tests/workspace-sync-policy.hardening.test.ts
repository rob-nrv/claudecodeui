// Night audit (post FT-M09-R1): spellings of Git metadata and credentials that
// resolve to the same files on case-insensitive filesystems, gitlink files and
// nested Claude local settings. Found by probing the contract, not assumed.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeWorkspaceChangesDigest,
  validateWorkspaceSnapshotManifest,
  type WorkspaceSnapshotChange,
} from '@/modules/project-workspaces/workspace-snapshot.contract.js';
import { classifyWorkspacePath } from '@/modules/project-workspaces/workspace-sync-policy.js';

test('Git metadata is never syncable, in any letter case, as a folder, a gitlink file or an NTFS short name', () => {
  for (const file of ['.git/HEAD', '.GIT/hooks/pre-commit', '.Git/config', 'sub/.git', 'packages/app/.GIT', 'vendor/lib/.git/objects/ab/cd', 'GIT~1/hooks/post-checkout']) {
    assert.deepEqual(classifyWorkspacePath(file), { syncClass: 'local_only', rule: 'local:git_metadata' }, file);
  }
  for (const file of ['.gitignore', '.gitattributes', '.gitmodules', '.github/workflows/ci.yml', 'docs/git.md', 'src/.gitkeep']) {
    assert.equal(classifyWorkspacePath(file).syncClass, 'syncable', file);
  }
});

test('credential folders and Claude local settings are denied in any letter case and at any depth', () => {
  for (const file of ['.SSH/config', '.Docker/config.json', '.KUBE/config', '.Config/GCloud/application_default_credentials.json', 'home/.AWS/config', 'packages/app/.claude/settings.local.json', 'apps/api/.Claude/.credentials.json']) {
    assert.equal(classifyWorkspacePath(file).syncClass, 'secret', file);
  }
  assert.deepEqual(classifyWorkspacePath('certs/AuthKey_ABC123DEF4.p8'), { syncClass: 'secret', rule: 'secret:key_material' });
  assert.equal(classifyWorkspacePath('packages/app/.claude/settings.json').syncClass, 'syncable', 'shared Claude settings stay project content');
});

test('a snapshot can never carry a path that would restore into Git metadata or a credential folder', () => {
  const change = (path: string, previousPath: string | null = null): WorkspaceSnapshotChange => ({
    path,
    change: previousPath ? 'renamed' : 'added',
    previousPath,
    contentSha256: 'd'.repeat(64),
    sizeBytes: 12,
    mode: 'file',
  });
  const manifest = (changes: WorkspaceSnapshotChange[]) => ({
    schema: 'cloudcli.workspace-snapshot',
    version: 1,
    snapshotId: '0f8fad5b-d9cb-469f-a165-70867728950e',
    projectId: 'project-1',
    createdAt: '2026-09-13T22:00:00.000Z',
    sourceNodeId: 'pc-node',
    parentSnapshotId: null,
    git: null,
    changes,
    exclusions: { localOnly: 0, secret: 0, userExcluded: 0, policy: { version: 1, userExcludePatterns: [] } },
    changesDigest: computeWorkspaceChangesDigest(changes),
    payload: { transport: 'none' },
  });

  for (const changes of [
    [change('.GIT/hooks/pre-commit')],
    [change('sub/.git')],
    [change('scripts/hook.sh', '.Git/hooks/pre-push')],
    [change('.Docker/config.json')],
    [change('packages/app/.claude/settings.local.json')],
  ]) {
    const result = validateWorkspaceSnapshotManifest(manifest(changes));
    assert.equal(result.ok, false, JSON.stringify(changes.map((entry) => entry.path)));
    assert.ok(!result.ok && result.errors.includes('non_syncable_change_path'));
  }
});
