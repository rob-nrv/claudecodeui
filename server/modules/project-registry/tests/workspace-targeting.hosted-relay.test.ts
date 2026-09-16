// FT-M11: a Hosted Relay keeps no working copies. Even with a folder recorded
// in its database, "no target" and "the local node" resolve to refusals, never
// to a path on the relay host.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase, projectsDb } from '@/modules/database/index.js';
import { createProjectWorkspaceLocator, resolveWorkspacePathForTarget } from '@/modules/project-registry/index.js';
import { setServerRole } from '@/shared/utils.js';

test('a relay never resolves a project folder on its own host', { concurrency: false }, async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-targeting-relay-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();
  try {
    const folder = path.join(directory, 'app');
    await fs.mkdir(folder);
    projectsDb.createProjectPath(folder);
    const projectId = projectsDb.getProjectPath(folder)?.project_id as string;
    getConnection().prepare("INSERT INTO runtime_nodes (node_id, label, is_local) VALUES ('copied-local', 'old-control-plane', 1)").run();
    const locator = createProjectWorkspaceLocator({ isUsable: () => true });

    assert.equal(resolveWorkspacePathForTarget(locator, projectId, null), folder, 'control plane baseline');

    setServerRole('hosted-relay');
    assert.deepEqual(
      locator.resolveOnControlPlane(projectId),
      { ok: false, projectId, nodeId: 'copied-local', code: 'WORKSPACE_NOT_ON_NODE', reason: 'hosted_relay' },
    );
    assert.throws(() => resolveWorkspacePathForTarget(locator, projectId, null), { code: 'WORKSPACE_NOT_ON_NODE' });
    assert.throws(() => resolveWorkspacePathForTarget(locator, projectId, 'copied-local'), { code: 'RUNTIME_NODE_NOT_FOUND' });
    assert.equal(resolveWorkspacePathForTarget(locator, 'missing', null), null, 'unknown projects keep the not-found contract');
  } finally {
    setServerRole('control-plane');
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
});
