// Runs real Git against throwaway repositories in the OS temp directory. The
// identity used for test commits is passed per command; no Git configuration
// is written anywhere.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { inspectWorkspaceFolder, readWorkspaceRootCommits } from '@/modules/project-workspaces/workspace-inspector.js';
import { computeWorkspaceChangesDigest } from '@/modules/project-workspaces/workspace-snapshot.contract.js';
import { classifyWorkspaceState } from '@/modules/project-workspaces/workspace-state.js';

const GIT_TEST_IDENTITY = ['-c', 'user.name=CloudCLI Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main'];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', [...GIT_TEST_IDENTITY, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function withRepository(runTest: (directory: string, repository: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workspace-inspector-'));
  const repository = path.join(directory, 'app');
  await mkdir(repository);
  git(repository, 'init', '-q');
  await writeFile(path.join(repository, 'README.md'), '# app\n');
  await writeFile(path.join(repository, '.gitignore'), 'ignored.txt\n');
  git(repository, 'add', '.');
  git(repository, 'commit', '-q', '--no-verify', '-m', 'init');
  try {
    await runTest(directory, repository);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('a missing folder and a folder without Git are reported as such, never as clean', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workspace-inspector-plain-'));
  try {
    const missing = await inspectWorkspaceFolder(path.join(directory, 'nope'));
    assert.deepEqual([missing.folder, missing.folderReason], ['missing', 'folder_not_found']);

    const plain = await inspectWorkspaceFolder(directory);
    assert.deepEqual([plain.folder, plain.git], ['available', { state: 'not_repository' }]);
    assert.equal(classifyWorkspaceState({ observation: plain, expectedRootCommits: null }).state, 'unknown');

    const noGit = await inspectWorkspaceFolder(directory, {
      runGit: async () => {
        throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
      },
    });
    assert.deepEqual(noGit.git, { state: 'unknown', reason: 'git_unavailable' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a clean repository reports its branch, HEAD and root-commit identity, and inspection writes nothing', async () => {
  await withRepository(async (_directory, repository) => {
    const head = git(repository, 'rev-parse', 'HEAD').trim();
    const indexBefore = await readFile(path.join(repository, '.git', 'index'));

    const clean = await inspectWorkspaceFolder(repository);
    assert.equal(clean.git.state, 'repository');
    assert.ok(clean.git.state === 'repository');
    assert.deepEqual([clean.git.branch, clean.git.headCommit, clean.git.rootCommits, clean.git.rootIsFolder], ['main', head, [head], true]);
    assert.equal(clean.changes?.total, 0);
    assert.equal(clean.sync?.changesDigest, computeWorkspaceChangesDigest([]));
    assert.deepEqual(await readWorkspaceRootCommits(repository), [head]);
    assert.equal(classifyWorkspaceState({ observation: clean, expectedRootCommits: [head] }).state, 'clean');
    assert.deepEqual(await readFile(path.join(repository, '.git', 'index')), indexBefore, 'no index refresh was written');
    assert.equal(git(repository, 'status', '--porcelain'), '');
  });
});

test('dirty work is counted and classified; secrets by name or content never enter the digest; no name leaves', async () => {
  await withRepository(async (directory, repository) => {
    await writeFile(path.join(repository, 'README.md'), '# app\nchanged\n');
    await writeFile(path.join(repository, 'notes.md'), 'todo\n');
    await writeFile(path.join(repository, '.env'), 'API_KEY=value\n');
    await writeFile(path.join(repository, 'config.json'), '{"key": "-----BEGIN RSA PRIVATE KEY-----\\nabc"}\n');
    await writeFile(path.join(repository, 'ignored.txt'), 'ignored\n');
    await mkdir(path.join(repository, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(path.join(repository, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');

    const first = await inspectWorkspaceFolder(repository);
    assert.deepEqual(first.changes, { staged: 0, modified: 1, added: 0, deleted: 0, renamed: 0, untracked: 4, conflicted: 0, total: 5, truncated: false });
    assert.deepEqual(
      { ...first.sync, changesDigest: typeof first.sync?.changesDigest },
      { syncable: 2, localOnly: 1, secret: 2, userExcluded: 0, secretContent: 1, changesDigest: 'string', digestReason: null },
    );
    assert.equal(classifyWorkspaceState({ observation: first, expectedRootCommits: null }).state, 'dirty');

    const serialized = JSON.stringify(first);
    for (const leaked of ['notes.md', '.env', 'config.json', 'node_modules', 'README', directory, repository.replace(/\\/g, '/')]) {
      assert.equal(serialized.includes(leaked), false, `leaked ${leaked}`);
    }

    const again = await inspectWorkspaceFolder(repository);
    assert.equal(again.sync?.changesDigest, first.sync?.changesDigest, 'the same working copy yields the same digest');

    await writeFile(path.join(repository, '.env'), 'API_KEY=rotated\n');
    assert.equal((await inspectWorkspaceFolder(repository)).sync?.changesDigest, first.sync?.changesDigest, 'secret content never influences the digest');

    await writeFile(path.join(repository, 'notes.md'), 'todo, updated\n');
    assert.notEqual((await inspectWorkspaceFolder(repository)).sync?.changesDigest, first.sync?.changesDigest);
  });
});

test('divergence from the upstream and a different repository are detected locally, with no fetch', async () => {
  await withRepository(async (directory, repository) => {
    const clone = path.join(directory, 'clone');
    git(directory, 'clone', '-q', repository, clone);
    await writeFile(path.join(repository, 'upstream.md'), 'upstream\n');
    git(repository, 'add', '.');
    git(repository, 'commit', '-q', '--no-verify', '-m', 'upstream change');
    await writeFile(path.join(clone, 'local.md'), 'local\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '-q', '--no-verify', '-m', 'local change');
    git(clone, 'fetch', '-q', 'origin');

    const diverged = await inspectWorkspaceFolder(clone);
    assert.ok(diverged.git.state === 'repository');
    assert.deepEqual(diverged.git.upstream, { ahead: 1, behind: 1 });
    const root = git(repository, 'rev-list', '--max-parents=0', 'HEAD').trim();
    assert.equal(classifyWorkspaceState({ observation: diverged, expectedRootCommits: [root] }).state, 'diverged');

    const unrelated = path.join(directory, 'unrelated');
    await mkdir(unrelated);
    git(unrelated, 'init', '-q');
    await writeFile(path.join(unrelated, 'x.md'), 'x\n');
    git(unrelated, 'add', '.');
    git(unrelated, 'commit', '-q', '--no-verify', '-m', 'other history');
    const foreign = await inspectWorkspaceFolder(unrelated);
    assert.equal(classifyWorkspaceState({ observation: foreign, expectedRootCommits: [root] }).state, 'identity_mismatch');

    const subfolder = path.join(clone, 'docs');
    await mkdir(subfolder);
    const nested = await inspectWorkspaceFolder(subfolder);
    assert.ok(nested.git.state === 'repository');
    assert.equal(nested.git.rootIsFolder, false, 'a folder inside a larger repository says so');
    assert.equal(nested.changes?.total, 0, 'changes outside the mapped folder are not counted');
  });
});
