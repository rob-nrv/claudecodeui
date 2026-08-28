import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createDetachedServerLauncher, resolveServerEntryPath } from '../runtime.module.js';

async function createAppRoot(entrySource?: string): Promise<string> {
  const appRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-launcher-'));
  if (entrySource !== undefined) {
    const entry = resolveServerEntryPath(appRoot);
    await fs.mkdir(path.dirname(entry), { recursive: true });
    await fs.writeFile(entry, entrySource, 'utf8');
  }
  return appRoot;
}

async function waitForFile(filePath: string, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await fs.readFile(filePath, 'utf8');
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`${filePath} never appeared`);
}

test('the server entry is the built one, not the TypeScript source', () => {
  assert.equal(
    resolveServerEntryPath('/opt/cloudcli'),
    path.join('/opt/cloudcli', 'dist-server', 'server', 'index.js'),
  );
});

test('an unbuilt installation fails with an actionable message instead of spawning', async () => {
  const launch = createDetachedServerLauncher({ appRoot: await createAppRoot() });

  await assert.rejects(launch, /has not been built yet.*npm run build/s);
});

test('a launch actually starts the built entrypoint in the app root', async () => {
  const appRoot = await createAppRoot(`
    const fs = require('node:fs');
    fs.writeFileSync(process.env.LAUNCH_PROOF_PATH, JSON.stringify({ cwd: process.cwd() }));
  `);
  const proofPath = path.join(appRoot, 'proof.json');
  const launch = createDetachedServerLauncher({
    appRoot,
    environment: { ...process.env, LAUNCH_PROOF_PATH: proofPath },
  });

  await launch();

  const proof = JSON.parse(await waitForFile(proofPath));
  assert.equal(await fs.realpath(proof.cwd), await fs.realpath(appRoot));
});

test('the launched server is its own process group leader, so it survives its caller', {
  // The pgid is read from procfs, which is the reliable way to assert this on
  // the platform that matters here (Linux, including proot on the phone).
  skip: process.platform !== 'linux' ? 'procfs pgid check is Linux-only' : false,
}, async () => {
  const appRoot = await createAppRoot(`
    const fs = require('node:fs');
    const stat = fs.readFileSync('/proc/self/stat', 'utf8');
    // Fields after the comm field, which may itself contain spaces.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    fs.writeFileSync(process.env.LAUNCH_PROOF_PATH, JSON.stringify({
      pid: process.pid,
      pgid: Number(fields[2]),
    }));
  `);
  const proofPath = path.join(appRoot, 'proof.json');
  const launch = createDetachedServerLauncher({
    appRoot,
    environment: { ...process.env, LAUNCH_PROOF_PATH: proofPath },
  });

  await launch();

  const proof = JSON.parse(await waitForFile(proofPath));
  // detached:true puts the child in a new process group, so a SIGHUP aimed at
  // the caller's group cannot reach the replacement server.
  assert.equal(proof.pgid, proof.pid);
  assert.notEqual(proof.pid, process.pid);
});
