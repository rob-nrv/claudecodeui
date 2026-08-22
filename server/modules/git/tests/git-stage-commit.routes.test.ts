import assert from 'node:assert/strict';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import spawn from 'cross-spawn';
import express from 'express';

import { createGitRouter } from '../git.routes.js';

// These exercise /stage and /commit against a real, temporary Git repository
// and the real `git` binary (via the same `cross-spawn` dependency the app
// wires up in production — see git.module.ts) rather than a mocked
// spawnProcess. The bug this covers — `git add -- <file>` failing with
// `fatal: pathspec ... did not match any files` once a deletion is already
// staged — is a real quirk of Git's pathspec matching that a hand-rolled
// mock could easily fail to reproduce (or silently "fix" by construction).

function runGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr!.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`git ${args.join(' ')} failed (${code}): ${stderr}`));
      }
    });
  });
}

async function createTempRepoWithCommittedFile(fileName: string, content: string): Promise<string> {
  const repoPath = await fs.mkdtemp(path.join(tmpdir(), 'git-stage-commit-'));
  await runGit(['init', '-q'], repoPath);
  await runGit(['config', 'user.email', 'test@test.com'], repoPath);
  await runGit(['config', 'user.name', 'Test'], repoPath);
  await fs.writeFile(path.join(repoPath, fileName), content, 'utf8');
  await runGit(['add', '--', fileName], repoPath);
  await runGit(['commit', '-q', '-m', 'initial'], repoPath);
  return repoPath;
}

function createRouterForRepo(repoPath: string): express.Router {
  const unexpectedProvider = async (): Promise<never> => { throw new Error('provider should not be called'); };
  return createGitRouter({
    fileSystem: fs,
    spawnProcess: spawn,
    resolveProjectPathById: () => repoPath,
    queryClaude: unexpectedProvider,
    queryCursor: unexpectedProvider,
  });
}

async function withGitServer(
  repoPath: string,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/git', createRouterForRepo(repoPath));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function statusFor(repoPath: string, fileName: string): Promise<string> {
  const { stdout } = await runGit(['status', '--porcelain', '--', fileName], repoPath);
  return stdout;
}

test('stage: an unstaged deletion is staged correctly', async () => {
  const repoPath = await createTempRepoWithCommittedFile('file.txt', 'hello\n');
  try {
    await fs.unlink(path.join(repoPath, 'file.txt'));
    assert.equal(await statusFor(repoPath, 'file.txt'), ' D file.txt\n');

    await withGitServer(repoPath, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/git/stage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project: 'p', files: ['file.txt'] }),
      });
      assert.equal(response.status, 200);
      const body = await response.json() as { success: boolean };
      assert.equal(body.success, true);
    });

    assert.equal(await statusFor(repoPath, 'file.txt'), 'D  file.txt\n');
  } finally {
    await fs.rm(repoPath, { recursive: true, force: true });
  }
});

test('commit: an already-staged deletion commits without re-running an invalid git add', async () => {
  const repoPath = await createTempRepoWithCommittedFile('file.txt', 'hello\n');
  try {
    await fs.unlink(path.join(repoPath, 'file.txt'));
    // Stage the deletion ourselves first, so /commit's internal staging step
    // sees a deletion that is *already* fully staged — the exact case that
    // used to crash with `fatal: pathspec 'file.txt' did not match any files`.
    await runGit(['add', '--', 'file.txt'], repoPath);
    assert.equal(await statusFor(repoPath, 'file.txt'), 'D  file.txt\n');

    await withGitServer(repoPath, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/git/commit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project: 'p', message: 'remove file', files: ['file.txt'] }),
      });
      const body = await response.json() as { success: boolean; error?: string };
      assert.equal(response.status, 200, body.error);
      assert.equal(body.success, true);
    });

    assert.equal(await statusFor(repoPath, 'file.txt'), '');
    const { stdout: nameStatus } = await runGit(['show', '--name-status', '--format=', 'HEAD'], repoPath);
    assert.equal(nameStatus.trim(), 'D\tfile.txt');
  } finally {
    await fs.rm(repoPath, { recursive: true, force: true });
  }
});

test('commit: a normal modified file is staged and committed unchanged', async () => {
  const repoPath = await createTempRepoWithCommittedFile('file.txt', 'hello\n');
  try {
    await fs.writeFile(path.join(repoPath, 'file.txt'), 'changed\n', 'utf8');
    assert.equal(await statusFor(repoPath, 'file.txt'), ' M file.txt\n');

    await withGitServer(repoPath, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/git/commit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project: 'p', message: 'update file', files: ['file.txt'] }),
      });
      const body = await response.json() as { success: boolean; error?: string };
      assert.equal(response.status, 200, body.error);
      assert.equal(body.success, true);
    });

    assert.equal(await statusFor(repoPath, 'file.txt'), '');
    const { stdout } = await runGit(['show', 'HEAD:file.txt'], repoPath);
    assert.equal(stdout, 'changed\n');
  } finally {
    await fs.rm(repoPath, { recursive: true, force: true });
  }
});

test('commit: an already-staged modified file is committed without a redundant re-add', async () => {
  const repoPath = await createTempRepoWithCommittedFile('file.txt', 'hello\n');
  try {
    await fs.writeFile(path.join(repoPath, 'file.txt'), 'changed\n', 'utf8');
    await runGit(['add', '--', 'file.txt'], repoPath);
    assert.equal(await statusFor(repoPath, 'file.txt'), 'M  file.txt\n');

    await withGitServer(repoPath, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/git/commit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project: 'p', message: 'update file', files: ['file.txt'] }),
      });
      const body = await response.json() as { success: boolean; error?: string };
      assert.equal(response.status, 200, body.error);
      assert.equal(body.success, true);
    });

    assert.equal(await statusFor(repoPath, 'file.txt'), '');
  } finally {
    await fs.rm(repoPath, { recursive: true, force: true });
  }
});

test('stage: a new untracked file is staged unchanged', async () => {
  const repoPath = await createTempRepoWithCommittedFile('existing.txt', 'hello\n');
  try {
    await fs.writeFile(path.join(repoPath, 'new.txt'), 'brand new\n', 'utf8');
    assert.equal(await statusFor(repoPath, 'new.txt'), '?? new.txt\n');

    await withGitServer(repoPath, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/git/stage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project: 'p', files: ['new.txt'] }),
      });
      assert.equal(response.status, 200);
      const body = await response.json() as { success: boolean };
      assert.equal(body.success, true);
    });

    assert.equal(await statusFor(repoPath, 'new.txt'), 'A  new.txt\n');
  } finally {
    await fs.rm(repoPath, { recursive: true, force: true });
  }
});

test('commit: a new file commits unchanged', async () => {
  const repoPath = await createTempRepoWithCommittedFile('existing.txt', 'hello\n');
  try {
    await fs.writeFile(path.join(repoPath, 'new.txt'), 'brand new\n', 'utf8');

    await withGitServer(repoPath, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/git/commit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project: 'p', message: 'add new file', files: ['new.txt'] }),
      });
      const body = await response.json() as { success: boolean; error?: string };
      assert.equal(response.status, 200, body.error);
      assert.equal(body.success, true);
    });

    assert.equal(await statusFor(repoPath, 'new.txt'), '');
    const { stdout } = await runGit(['show', 'HEAD:new.txt'], repoPath);
    assert.equal(stdout, 'brand new\n');
  } finally {
    await fs.rm(repoPath, { recursive: true, force: true });
  }
});
