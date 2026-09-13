import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  normalizeServerOrigin,
  readNodeAgentCredential,
  resolveNodeAgentHome,
  writeNodeAgentCredential,
} from '@/modules/node-agent/node-agent-credential.store.js';
import { resolveNodeWorkspacePath, validateNodeWorkspaceRoot } from '@/modules/node-agent/node-agent-workspace.js';

async function withFolders(runTest: (folders: { root: string; project: string; outside: string; file: string }) => Promise<void>) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'node-agent-workspace-'));
  const root = path.join(base, 'workspaces');
  const project = path.join(root, 'app');
  const outside = path.join(base, 'secrets');
  const file = path.join(root, 'notes.txt');
  await mkdir(project, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(file, 'x');
  try {
    await runTest({ root, project, outside, file });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

test('a mapped folder must resolve inside the node workspace root', async () => {
  await withFolders(async ({ root, project, outside, file }) => {
    assert.deepEqual(await resolveNodeWorkspacePath(root, project), { ok: true, path: await realpath(project) });
    assert.deepEqual(await resolveNodeWorkspacePath(root, path.join(project, '..', '..', 'secrets')), { ok: false, reason: 'outside_workspace_root' });
    assert.deepEqual(await resolveNodeWorkspacePath(root, outside), { ok: false, reason: 'outside_workspace_root' });
    assert.deepEqual(await resolveNodeWorkspacePath(root, 'app'), { ok: false, reason: 'path_not_absolute' });
    assert.deepEqual(await resolveNodeWorkspacePath(root, path.join(root, 'missing')), { ok: false, reason: 'folder_not_found' });
    assert.deepEqual(await resolveNodeWorkspacePath(root, file), { ok: false, reason: 'not_a_directory' });
    assert.deepEqual(await resolveNodeWorkspacePath(root, `${project}\0`), { ok: false, reason: 'path_invalid' });
    assert.deepEqual(await resolveNodeWorkspacePath(root, 42), { ok: false, reason: 'path_invalid' });
  });
});

test('a link inside the root that points outside it is refused', async () => {
  await withFolders(async ({ root, outside }) => {
    const escape = path.join(root, 'escape');
    // A directory junction needs no elevated rights on Windows; elsewhere it is a symlink.
    await symlink(outside, escape, process.platform === 'win32' ? 'junction' : 'dir');
    assert.deepEqual(await resolveNodeWorkspacePath(root, escape), { ok: false, reason: 'outside_workspace_root' });
  });
});

test('the agent refuses a filesystem root or a missing folder as its workspace root', async () => {
  await withFolders(async ({ root }) => {
    assert.equal((await validateNodeWorkspaceRoot(root)).ok, true);
    assert.equal((await validateNodeWorkspaceRoot(path.parse(root).root)).ok, false);
    assert.equal((await validateNodeWorkspaceRoot(path.join(root, 'missing'))).ok, false);
  });
});

test('control plane addresses must be https unless they are on this machine, and carry nothing else', () => {
  assert.deepEqual(normalizeServerOrigin('https://pc.example:3443'), {
    ok: true,
    origin: 'https://pc.example:3443',
    linkUrl: 'wss://pc.example:3443/runtime-node-link',
  });
  assert.deepEqual(normalizeServerOrigin('http://127.0.0.1:3001'), {
    ok: true,
    origin: 'http://127.0.0.1:3001',
    linkUrl: 'ws://127.0.0.1:3001/runtime-node-link',
  });
  for (const refused of ['http://pc.example', 'https://u:p@pc.example', 'https://pc.example/x', 'https://pc.example?code=1', 'ftp://pc.example', '', 42]) {
    assert.equal(normalizeServerOrigin(refused).ok, false, String(refused));
  }
});

test('the node credential is written atomically, owner-only, and read back', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'node-agent-credential-'));
  try {
    assert.equal(await readNodeAgentCredential(stateDir), null);
    const credential = {
      version: 1 as const,
      serverOrigin: 'https://pc.example',
      nodeId: 'node-1',
      // Round-trip fixture only: not key material, never parsed as a key.
      privateKeyPem: 'test-fixture-private-key-placeholder',
      publicKeyPem: 'test-fixture-public-key-placeholder',
      enrolledAt: '2026-09-13T12:00:00.000Z',
    };
    const file = await writeNodeAgentCredential(stateDir, credential);
    assert.deepEqual(await readNodeAgentCredential(stateDir), credential);
    if (process.platform !== 'win32') {
      assert.equal((await stat(file)).mode & 0o777, 0o600);
    }
    await writeFile(file, '{"version":2}');
    assert.equal(await readNodeAgentCredential(stateDir), null, 'an unexpected file shape is not a credential');
    assert.ok((await readFile(file, 'utf8')).length > 0);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }

  assert.equal(resolveNodeAgentHome({ env: {}, homeDirectory: path.join(path.sep, 'home', 'robin') }), path.resolve(path.sep, 'home', 'robin', '.cloudcli', 'node-agent'));
  assert.equal(resolveNodeAgentHome({ env: { CLOUDCLI_NODE_AGENT_HOME: path.join(path.sep, 'agent') }, homeDirectory: 'x' }), path.resolve(path.sep, 'agent'));
});
