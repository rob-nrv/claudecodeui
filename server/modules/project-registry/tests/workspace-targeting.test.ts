// FT-M10 workspace targeting: one project id, several RuntimeNodes, a
// different node-local folder on each. Every resolution consults only the node
// that was chosen and refuses instead of offering another folder. Temporary
// databases only.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  projectsDb,
  runtimeNodeWorkspacesDb,
} from '@/modules/database/index.js';
import { createProjectWorkspaceLocator } from '@/modules/project-registry/index.js';

const NOW = Date.UTC(2026, 8, 16, 12, 0, 0);
const ROOT_A = 'a'.repeat(40);

async function withIsolatedDatabase(runTest: (directory: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-targeting-'));
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

/**
 * This machine (pc-node, local), three enrolled remote nodes, one revoked and
 * one never enrolled. `app` has a copy here and a folder on Pixel and on the
 * NAS; `pixelOnly` has no copy here and a folder on Pixel only.
 */
function seedFleet(directory: string) {
  const db = getConnection();
  db.prepare("INSERT INTO runtime_nodes (node_id, label, is_local, platform, arch) VALUES ('pc-node', 'Windows PC', 1, 'win32', 'x64')").run();
  for (const [nodeId, label, status] of [['pixel-node', 'Pixel', 'active'], ['nas-node', 'NAS', 'active'], ['tablet-node', 'Tablet', 'active'], ['old-node', 'Old phone', 'revoked']]) {
    db.prepare('INSERT INTO runtime_nodes (node_id, label, is_local, platform, arch) VALUES (?, ?, 0, ?, ?)').run(nodeId, label, 'linux', 'arm64');
    db.prepare('INSERT INTO runtime_node_credentials (node_id, public_key, status, enrolled_at) VALUES (?, ?, ?, ?)').run(nodeId, `key-${nodeId}`, status, NOW);
  }
  db.prepare("INSERT INTO runtime_nodes (node_id, label, is_local) VALUES ('stray-node', 'Never enrolled', 0)").run();

  const app = projectsDb.createProjectPath(path.join(directory, 'control-plane', 'app')).project!;
  const pixelOnly = projectsDb.createProjectWithoutControlPlaneCopy('Pixel-only app');
  const map = (nodeId: string, projectId: string, nodePath: string) =>
    runtimeNodeWorkspacesDb.upsert({ nodeId, projectId, nodePath, status: 'verified', reason: null, verifiedAt: NOW, gitRootCommits: [ROOT_A] });
  map('pixel-node', app.project_id, '/root/cloudcli-workspaces/app');
  map('nas-node', app.project_id, '/volume1/code/app');
  map('old-node', app.project_id, '/sdcard/app');
  map('pixel-node', pixelOnly.project_id, '/root/cloudcli-workspaces/pixel-only');
  return { appId: app.project_id, controlPlanePath: app.project_path!, pixelOnlyId: pixelOnly.project_id };
}

test('one project id on several nodes: each node resolves its own folder, and every unusable target is refused without a substitute', { concurrency: false }, async () => {
  await withIsolatedDatabase(async (directory) => {
    const { appId, controlPlanePath, pixelOnlyId } = seedFleet(directory);
    const online = new Set(['pixel-node', 'tablet-node', 'old-node', 'stray-node']);
    const locator = createProjectWorkspaceLocator({ isUsable: (nodeId) => online.has(nodeId) });

    const mappings = runtimeNodeWorkspacesDb.listByProject(appId);
    assert.equal(new Set(mappings.map((mapping) => mapping.projectId)).size, 1, 'one global identity');
    assert.equal(new Set(mappings.map((mapping) => mapping.nodePath)).size, mappings.length, 'no two nodes share a folder');

    assert.deepEqual(locator.resolve({ projectId: appId, nodeId: 'pc-node' }),
      { ok: true, projectId: appId, nodeId: 'pc-node', isLocalNode: true, path: controlPlanePath, recordedIdentity: null });
    assert.deepEqual(locator.resolve({ projectId: appId, nodeId: 'pixel-node' }),
      { ok: true, projectId: appId, nodeId: 'pixel-node', isLocalNode: false, path: '/root/cloudcli-workspaces/app', recordedIdentity: [ROOT_A] });

    const refusal = (nodeId: string, projectId = appId) => {
      const resolution = locator.resolve({ projectId, nodeId });
      assert.equal(resolution.ok, false, `${nodeId} must be refused`);
      assert.equal(JSON.stringify(resolution).includes('/'), false, `${nodeId}: no folder is offered instead`);
      return resolution.ok ? null : [resolution.code, resolution.reason];
    };
    assert.deepEqual(refusal('nas-node'), ['RUNTIME_NODE_OFFLINE', null], 'an offline node is not replaced by Pixel or by this machine');
    assert.deepEqual(refusal('tablet-node'), ['WORKSPACE_NOT_ON_NODE', 'not_mapped']);
    assert.deepEqual(refusal('old-node'), ['RUNTIME_NODE_REVOKED', null]);
    assert.deepEqual(refusal('stray-node'), ['RUNTIME_NODE_NOT_ENROLLED', null]);
    assert.deepEqual(refusal('ghost-node'), ['RUNTIME_NODE_NOT_FOUND', null]);
    assert.deepEqual(refusal('pixel-node', 'ghost-project'), ['PROJECT_NOT_FOUND', null]);

    online.add('nas-node');
    assert.equal((locator.resolve({ projectId: appId, nodeId: 'nas-node' }) as { path: string }).path, '/volume1/code/app');
    runtimeNodeWorkspacesDb.markUnavailable('nas-node', appId, 'rejected_by_node', NOW + 1);
    assert.deepEqual(refusal('nas-node'), ['WORKSPACE_UNAVAILABLE', 'rejected_by_node']);

    // A project known only on Pixel: this machine has no copy and says so.
    assert.deepEqual(refusal('pc-node', pixelOnlyId), ['WORKSPACE_NOT_ON_NODE', 'no_control_plane_copy']);
    assert.deepEqual(refusal('tablet-node', pixelOnlyId), ['WORKSPACE_NOT_ON_NODE', 'not_mapped']);
    assert.equal((locator.resolve({ projectId: pixelOnlyId, nodeId: 'pixel-node' }) as { path: string }).path, '/root/cloudcli-workspaces/pixel-only');
  });
});
