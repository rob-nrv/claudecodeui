// FT-M10: Git runs only in this machine's own copy of a project, resolved by
// project id; a project without one is refused explicitly and git never runs
// in another folder or the current directory. Temporary databases only.
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
import { createProjectWorkspaceLocator, resolveControlPlaneWorkspacePath } from '@/modules/project-registry/index.js';

import { createGitRouter } from '../git.routes.js';

async function withIsolatedDatabase(runTest: (directory: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'git-registry-'));
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
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('Git runs only in this machine\'s own copy; a project without one is refused explicitly and git never runs', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    getConnection().prepare("INSERT INTO runtime_nodes (node_id, label, is_local) VALUES ('pixel-node', 'Pixel', 0)").run();
    getConnection().prepare("INSERT INTO runtime_node_credentials (node_id, public_key, status, enrolled_at) VALUES ('pixel-node', 'key', 'active', 1)").run();
    const pixelOnly = projectsDb.createProjectWithoutControlPlaneCopy('Pixel-only app');
    runtimeNodeWorkspacesDb.upsert({ nodeId: 'pixel-node', projectId: pixelOnly.project_id, nodePath: '/root/ws/pixel-only', status: 'verified', reason: null, verifiedAt: 1, gitRootCommits: null });
    const locator = createProjectWorkspaceLocator({ isUsable: () => true });

    const spawned: Array<{ cwd?: string }> = [];
    const unexpectedProvider = async (): Promise<never> => { throw new Error('provider should not be called'); };
    const app = express();
    app.use(express.json());
    app.use('/api/git', createGitRouter({
      fileSystem: fs,
      spawnProcess: ((_command: string, _args: string[], options: { cwd?: string }) => {
        spawned.push(options);
        throw new Error('git must not run');
      }) as never,
      resolveProjectPathById: (projectId) => resolveControlPlaneWorkspacePath(locator, projectId),
      queryClaude: unexpectedProvider,
      queryCursor: unexpectedProvider,
    }));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const originalError = console.error;
    console.error = () => undefined;
    try {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/git/status?project=${pixelOnly.project_id}`);
      const body = await response.json() as { error?: string; details?: string };
      assert.equal(body.error, 'Git operation failed');
      assert.match(body.details ?? '', /no working copy on the chosen runtime node/);
      assert.deepEqual(spawned, [], 'git never ran in any folder, neither Pixel\'s path nor the current directory');
    } finally {
      console.error = originalError;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
