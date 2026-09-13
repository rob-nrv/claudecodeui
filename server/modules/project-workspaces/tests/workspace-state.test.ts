import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyWorkspaceState,
  parseGitStatusPorcelainV2,
  parseWorkspaceObservation,
  resolveWorkspaceIdentity,
  summarizeWorkspaceChanges,
  type WorkspaceObservation,
} from '@/modules/project-workspaces/workspace-state.js';

const HEAD = '1'.repeat(40);
const ROOT = '2'.repeat(40);
const OTHER_ROOT = '3'.repeat(40);

const statusOutput = [
  `# branch.oid ${HEAD}`,
  '# branch.head feature/login flow',
  '# branch.upstream origin/feature',
  '# branch.ab +2 -3',
  `1 .M N... 100644 100644 100644 ${HEAD} ${HEAD} src/app with space.ts`,
  `1 A. N... 000000 100644 100644 ${HEAD} ${HEAD} src/new.ts`,
  `1 .D N... 100644 100644 000000 ${HEAD} ${HEAD} old.ts`,
  `2 R. N... 100644 100644 100644 ${HEAD} ${HEAD} R100 renamed.ts`,
  'original.ts',
  `u UU N... 100644 100644 100644 100644 ${HEAD} ${HEAD} ${HEAD} conflict.ts`,
  '? .env',
  '? node_modules/pkg/index.js',
  '? notes.md',
  '',
].join('\0');

test('porcelain v2 is parsed record by record, keeping paths with spaces and rename origins', () => {
  const parsed = parseGitStatusPorcelainV2(statusOutput);
  assert.equal(parsed.headCommit, HEAD);
  assert.equal(parsed.branch, null, 'a branch name outside the safe charset is dropped, not echoed');
  assert.deepEqual(parsed.upstream, { ahead: 2, behind: 3 });
  assert.deepEqual(parsed.entries.map((entry) => [entry.kind, entry.path, entry.previousPath, entry.staged]), [
    ['modified', 'src/app with space.ts', null, false],
    ['added', 'src/new.ts', null, true],
    ['deleted', 'old.ts', null, false],
    ['renamed', 'renamed.ts', 'original.ts', true],
    ['conflicted', 'conflict.ts', null, false],
    ['untracked', '.env', null, false],
    ['untracked', 'node_modules/pkg/index.js', null, false],
    ['untracked', 'notes.md', null, false],
  ]);

  const unborn = parseGitStatusPorcelainV2('# branch.oid (initial)\0# branch.head main\0');
  assert.deepEqual([unborn.headCommit, unborn.branch, unborn.detached], [null, 'main', false]);
  assert.equal(parseGitStatusPorcelainV2('# branch.head (detached)\0').detached, true);

  const truncated = parseGitStatusPorcelainV2(statusOutput, 3);
  assert.deepEqual([truncated.entries.length, truncated.truncated], [3, true]);
});

test('changes are counted by kind and by sync class, the strictest side of a rename winning', () => {
  const { changes, sync } = summarizeWorkspaceChanges(parseGitStatusPorcelainV2(statusOutput));
  assert.deepEqual(changes, { staged: 2, modified: 1, added: 1, deleted: 1, renamed: 1, untracked: 3, conflicted: 1, total: 8, truncated: false });
  assert.deepEqual(sync, { syncable: 6, localOnly: 1, secret: 1, userExcluded: 0 });

  const renameOfSecret = summarizeWorkspaceChanges({ entries: [{ path: 'config.txt', previousPath: '.env', kind: 'renamed', staged: true }], truncated: false });
  assert.equal(renameOfSecret.sync.secret, 1);
});

const observation = (overrides: Partial<WorkspaceObservation> = {}): WorkspaceObservation => ({
  folder: 'available',
  folderReason: null,
  git: { state: 'repository', rootIsFolder: true, branch: 'main', detached: false, headCommit: HEAD, rootCommits: [ROOT], upstream: null },
  changes: { staged: 0, modified: 0, added: 0, deleted: 0, renamed: 0, untracked: 0, conflicted: 0, total: 0, truncated: false },
  sync: { syncable: 0, localOnly: 0, secret: 0, userExcluded: 0, secretContent: 0, changesDigest: 'a'.repeat(64), digestReason: null },
  ...overrides,
});

test('state classification has a fixed precedence and never reports clean without evidence', () => {
  const classify = (value: WorkspaceObservation, expected: string[] | null = [ROOT]) => {
    const result = classifyWorkspaceState({ observation: value, expectedRootCommits: expected });
    return [result.state, result.reason, result.identity];
  };
  const changes = (total: number, conflicted = 0) => ({ staged: 0, modified: total, added: 0, deleted: 0, renamed: 0, untracked: 0, conflicted, total, truncated: false });
  const git = (rootCommits: string[], upstream: { ahead: number; behind: number } | null = null) =>
    ({ state: 'repository' as const, rootIsFolder: true, branch: 'main', detached: false, headCommit: HEAD, rootCommits, upstream });

  assert.deepEqual(classify(observation()), ['clean', null, 'match']);
  assert.deepEqual(classify(observation(), null), ['clean', null, 'unrecorded']);
  assert.deepEqual(classify(observation({ folder: 'missing', folderReason: 'folder_not_found' })), ['missing', 'folder_not_found', 'unknown']);
  assert.deepEqual(classify(observation({ folder: 'unavailable', folderReason: null })), ['unavailable', 'folder_unavailable', 'unknown']);
  assert.deepEqual(classify(observation({ git: { state: 'not_repository' } })), ['unknown', 'not_git_repository', 'unknown']);
  assert.deepEqual(classify(observation({ git: { state: 'unknown', reason: 'git_timeout' } })), ['unknown', 'git_timeout', 'unknown']);
  assert.deepEqual(classify(observation({ changes: null })), ['unknown', 'changes_unreadable', 'match']);
  assert.deepEqual(classify(observation({ git: git([OTHER_ROOT], { ahead: 1, behind: 1 }), changes: changes(3) })), ['identity_mismatch', 'different_repository_history', 'mismatch']);
  assert.deepEqual(classify(observation({ git: git([ROOT], { ahead: 1, behind: 1 }), changes: changes(1, 1) })), ['dirty', 'unmerged_paths', 'match']);
  assert.deepEqual(classify(observation({ git: git([ROOT], { ahead: 1, behind: 1 }), changes: changes(2) })), ['diverged', 'diverged_from_upstream', 'match']);
  assert.deepEqual(classify(observation({ git: git([ROOT], { ahead: 4, behind: 0 }), changes: changes(2) })), ['dirty', 'uncommitted_changes', 'match']);
  assert.deepEqual(classify(observation({ git: git([], null) })), ['clean', null, 'unknown'], 'an unborn repository cannot prove its identity');

  assert.equal(resolveWorkspaceIdentity([ROOT, OTHER_ROOT], [OTHER_ROOT]), 'match');
  assert.equal(resolveWorkspaceIdentity([ROOT], []), 'unrecorded');
});

test('a node observation is rebuilt from known shapes: no path, no file name, no extra field survives', () => {
  const parsed = parseWorkspaceObservation({
    folder: 'available',
    folderReason: '/root/cloudcli-workspaces/app',
    path: '/root/cloudcli-workspaces/app',
    git: {
      state: 'repository',
      rootIsFolder: true,
      branch: 'main; rm -rf /',
      detached: false,
      headCommit: 'not-a-commit',
      rootCommits: [ROOT, ROOT, 'zz', OTHER_ROOT, '4'.repeat(40), '5'.repeat(40)],
      upstream: { ahead: 1, behind: -1 },
      remoteUrl: 'https://user:token@example.com/repo.git',
    },
    changes: { staged: 0, modified: 1, added: 0, deleted: 0, renamed: 0, untracked: 0, conflicted: 0, total: 1, truncated: false, files: ['secret.txt'] },
    sync: { syncable: 1, localOnly: 0, secret: 0, userExcluded: 0, secretContent: 0, changesDigest: 'short', digestReason: 'x/y' },
  });
  assert.ok(parsed);
  assert.deepEqual(parsed.git, { state: 'repository', rootIsFolder: true, branch: null, detached: false, headCommit: null, rootCommits: [ROOT, OTHER_ROOT, '4'.repeat(40)], upstream: null });
  assert.equal(parsed.folderReason, null);
  assert.equal(parsed.sync?.changesDigest, null);
  const serialized = JSON.stringify(parsed);
  for (const leaked of ['/root', 'token', 'secret.txt', 'rm -rf', 'remoteUrl']) {
    assert.equal(serialized.includes(leaked), false, leaked);
  }

  assert.equal(parseWorkspaceObservation({ folder: 'elsewhere' }), null);
  assert.equal(parseWorkspaceObservation('clean'), null);
  const missing = parseWorkspaceObservation({ folder: 'missing', folderReason: 'folder_not_found', changes: { total: 3 } });
  assert.deepEqual(missing, { folder: 'missing', folderReason: 'folder_not_found', git: { state: 'unknown', reason: 'folder_unavailable' }, changes: null, sync: null });
  assert.equal(parseWorkspaceObservation({ folder: 'available', git: { state: 'repository' }, changes: { total: 'many' } })?.changes, null);
});
