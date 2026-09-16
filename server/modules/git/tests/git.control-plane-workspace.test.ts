// FT-M10 strict targeting for Git: every request resolves exactly the
// RuntimeNode it targets (X-CloudCLI-Runtime-Node/-Project). The local node
// runs git only in this machine's copy; a remote or unusable target is refused
// and git never runs — not in this machine's folder, another node's folder or
// the current directory. Real router and middleware over HTTP; every git spawn
// is recorded; temporary databases only.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  projectsDb,
  runtimeNodeWorkspacesDb,
} from '@/modules/database/index.js';
import {
  resolveRequestWorkspacePath,
  runtimeTargetMiddleware,
  setRuntimeLinkPresence,
} from '@/modules/project-registry/index.js';

import { createGitRouter } from '../git.routes.js';

const NOW = Date.UTC(2026, 8, 16, 12, 0, 0);

async function withIsolatedDatabase(runTest: (directory: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'git-targeting-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await fs.writeFile(process.env.DATABASE_PATH, '');
  const originalLog = console.log;
  console.log = () => undefined;
  try {
    await initializeDatabase();
  } finally {
    console.log = originalLog;
  }
  try {
    await runTest(directory);
  } finally {
    setRuntimeLinkPresence({ isUsable: () => false });
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
}

/** Same fleet as the Files test: this machine, Pixel (online), NAS (offline), Tablet (unmapped), a revoked and a never-enrolled node. */
function seedFleet(directory: string) {
  const db = getConnection();
  db.prepare("INSERT INTO runtime_nodes (node_id, label, is_local) VALUES ('pc-node', 'Windows PC', 1)").run();
  for (const [nodeId, status] of [['pixel-node', 'active'], ['nas-node', 'active'], ['tablet-node', 'active'], ['old-node', 'revoked']]) {
    db.prepare('INSERT INTO runtime_nodes (node_id, label, is_local) VALUES (?, ?, 0)').run(nodeId, nodeId);
    db.prepare('INSERT INTO runtime_node_credentials (node_id, public_key, status, enrolled_at) VALUES (?, ?, ?, ?)').run(nodeId, `key-${nodeId}`, status, NOW);
  }
  db.prepare("INSERT INTO runtime_nodes (node_id, label, is_local) VALUES ('stray-node', 'Never enrolled', 0)").run();
  setRuntimeLinkPresence({ isUsable: (nodeId) => ['pixel-node', 'tablet-node', 'old-node', 'stray-node'].includes(nodeId) });

  const localCopy = path.join(directory, 'pc', 'app');
  const pixelCopy = path.join(directory, 'pixel', 'app');
  const app = projectsDb.createProjectPath(localCopy).project!;
  const pixelOnly = projectsDb.createProjectWithoutControlPlaneCopy('Pixel-only app');
  const map = (nodeId: string, projectId: string, nodePath: string) =>
    runtimeNodeWorkspacesDb.upsert({ nodeId, projectId, nodePath, status: 'verified', reason: null, verifiedAt: NOW, gitRootCommits: null });
  map('pixel-node', app.project_id, pixelCopy);
  map('nas-node', app.project_id, '/volume1/code/app');
  map('old-node', app.project_id, '/sdcard/app');
  map('pixel-node', pixelOnly.project_id, path.join(directory, 'pixel', 'pixel-only'));
  return { appId: app.project_id, localCopy, pixelCopy, pixelOnlyId: pixelOnly.project_id };
}

const target = (projectId: string, nodeId: string) => ({ 'X-CloudCLI-Runtime-Project': projectId, 'X-CloudCLI-Runtime-Node': nodeId });

test('Git: the targeted local node runs git only in its own copy; a remote or unusable target is refused and git never runs', { concurrency: false }, async () => {
  await withIsolatedDatabase(async (directory) => {
    const { appId, localCopy, pixelCopy, pixelOnlyId } = seedFleet(directory);
    // Both folders really exist, so only the targeting decides which one git may use.
    await fs.mkdir(localCopy, { recursive: true });
    await fs.mkdir(pixelCopy, { recursive: true });
    const spawned: string[] = [];
    const unexpectedProvider = async (): Promise<never> => { throw new Error('provider should not be called'); };
    const app = express();
    app.use(express.json());
    app.use('/api/git', runtimeTargetMiddleware, createGitRouter({
      fileSystem: fs,
      spawnProcess: ((_command: string, _args: string[], options: { cwd?: string }) => {
        spawned.push(String(options?.cwd));
        throw new Error('git is not run in this test');
      }) as never,
      resolveProjectPathById: (projectId) => resolveRequestWorkspacePath(projectId),
      queryClaude: unexpectedProvider,
      queryCursor: unexpectedProvider,
    }));
    app.use((error: { statusCode?: number; code?: string; message: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(error.statusCode ?? 500).json({ code: error.code, error: error.message });
    });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const originalError = console.error;
    console.error = () => undefined;
    const status = async (projectId: string, headers: Record<string, string> = {}) => {
      const response = await fetch(`${base}/api/git/status?project=${projectId}`, { headers });
      return { status: response.status, text: await response.text() };
    };
    const commit = async (projectId: string, headers: Record<string, string>) => {
      const response = await fetch(`${base}/api/git/commit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ project: projectId, message: 'x', files: ['a.txt'] }),
      });
      return { status: response.status, text: await response.text() };
    };

    try {
      // A/B: a local target (explicit or implied) runs git in exactly this machine's copy.
      for (const headers of [target(appId, 'pc-node'), {}]) {
        spawned.length = 0;
        await status(appId, headers);
        assert.ok(spawned.length > 0, 'git was attempted for the local copy');
        assert.deepEqual([...new Set(spawned)], [path.resolve(localCopy)], 'only the local copy');
      }

      // B/C/D: remote and unusable targets are refused by their own reason; git never runs.
      spawned.length = 0;
      const refusals: Array<[string, string, RegExp]> = [
        [appId, 'pixel-node', /on another runtime node; this operation is not available there/],
        [appId, 'nas-node', /offline; no other copy of the project is used instead/],
        [appId, 'tablet-node', /no working copy on the chosen runtime node/],
        [appId, 'old-node', /was revoked/],
        [appId, 'stray-node', /not enrolled/],
        [appId, 'ghost-node', /Runtime node not found/],
        [pixelOnlyId, 'pc-node', /no working copy on the chosen runtime node/],
        [pixelOnlyId, 'pixel-node', /on another runtime node; this operation is not available there/],
      ];
      for (const [projectId, nodeId, reason] of refusals) {
        for (const response of [await status(projectId, target(projectId, nodeId)), await commit(projectId, target(projectId, nodeId))]) {
          assert.match(response.text, reason, `${projectId}@${nodeId}`);
          for (const folder of [localCopy, pixelCopy, '/volume1', '/sdcard']) {
            assert.equal(response.text.includes(folder.replace(/\\/g, '\\\\')), false, `${projectId}@${nodeId}: no path in the refusal`);
          }
        }
      }
      assert.deepEqual(spawned, [], 'git never ran for a refused target — not here, not in another folder, not in the current directory');

      // A half-sent target is refused before any git work.
      const half = await status(appId, { 'X-CloudCLI-Runtime-Node': 'pixel-node' });
      assert.equal(half.status, 400);
      assert.match(half.text, /RUNTIME_TARGET_INVALID/);
      assert.deepEqual(spawned, []);
    } finally {
      console.error = originalError;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
