// FT-M11: in a Hosted Relay the RuntimeNode service has no local node. Nothing
// is registered, probed, implied or executed on the relay host, and every
// session names an enrolled remote node or is refused.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  projectsDb,
  runtimeNodeCredentialsDb,
  runtimeNodesDb,
  runtimeNodeWorkspacesDb,
} from '@/modules/database/index.js';
import { createRuntimeNodesService } from '@/modules/runtime-nodes/runtime-nodes.service.js';

async function withIsolatedDatabase(runTest: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'runtime-nodes-relay-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await writeFile(process.env.DATABASE_PATH, '');
  await initializeDatabase();
  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

function insertRemote(nodeId: string, label: string) {
  getConnection().prepare('INSERT INTO runtime_nodes (node_id, label, is_local) VALUES (?, ?, 0)').run(nodeId, label);
}

function enrollRemote(nodeId: string, label: string) {
  insertRemote(nodeId, label);
  getConnection()
    .prepare("INSERT INTO runtime_node_credentials (node_id, public_key, status, enrolled_at) VALUES (?, ?, 'active', ?)")
    .run(nodeId, `key-${nodeId}`, Date.now());
}

const relayService = (probes: { count: number }) => createRuntimeNodesService({
  hasLocalNode: () => false,
  probeCapabilities: async () => {
    probes.count += 1;
    throw new Error('a relay must never probe itself');
  },
});

test('a relay lists nodes without registering, probing or naming a local node', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    const probes = { count: 0 };
    const service = relayService(probes);

    const listing = await service.listNodes({ refresh: true });
    assert.deepEqual(listing, { localNodeId: null, nodes: [] });
    assert.equal(runtimeNodesDb.count(), 0, 'no local node row was created');
    assert.equal(probes.count, 0, 'the relay host was never probed');
    assert.throws(() => service.registerLocalNode('1.37.2'), { code: 'HOSTED_RELAY_NO_LOCAL_NODE' });
    assert.throws(() => service.getLocalNodeId(), { code: 'HOSTED_RELAY_NO_LOCAL_NODE' });
    assert.deepEqual(service.checkSessionRunsHere(null), { ok: false, code: 'HOSTED_RELAY_NO_LOCAL_NODE' });
    assert.equal(runtimeNodesDb.count(), 0);
  });
});

test('a relay never implies a target, even with a single enrolled node, and refuses unusable ones explicitly', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    const service = relayService({ count: 0 });
    enrollRemote('nas-node', 'NAS');

    assert.throws(() => service.resolveExecutionTarget(), { code: 'RUNTIME_NODE_REQUIRED' });
    assert.throws(() => service.resolveExecutionTarget(null), { code: 'RUNTIME_NODE_REQUIRED' });
    assert.throws(() => service.resolveExecutionTarget('nas-node'), { code: 'RUNTIME_NODE_UNAVAILABLE' }, 'enrolled but offline');
    assert.throws(() => service.resolveExecutionTarget('ghost-node'), { code: 'RUNTIME_NODE_NOT_FOUND' });

    insertRemote('unenrolled-node', 'Unenrolled');
    assert.throws(() => service.resolveExecutionTarget('unenrolled-node'), { code: 'RUNTIME_NODE_NOT_EXECUTABLE' });

    runtimeNodeCredentialsDb.revoke('nas-node', Date.now());
    assert.throws(() => service.resolveExecutionTarget('nas-node'), { code: 'RUNTIME_NODE_REVOKED' });
  });
});

test('a local node row in a relay database is never listed, targeted or executed', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    const localRow = runtimeNodesDb.upsertLocal('copied-local', { label: 'old-control-plane', platform: 'win32', arch: 'x64', runtimeVersion: '1.37.2' });
    enrollRemote('nas-node', 'NAS');
    const service = relayService({ count: 0 });

    const listing = await service.listNodes();
    assert.deepEqual(listing.nodes.map((node) => node.nodeId), ['nas-node']);
    assert.equal(listing.localNodeId, null);
    assert.throws(() => service.resolveExecutionTarget(localRow.nodeId), { code: 'HOSTED_RELAY_NO_LOCAL_NODE' });
    assert.throws(
      () => service.assertNodeCanRun(localRow.nodeId, { provider: 'claude', claudeProfileId: null, projectPath: '/srv/app' }),
      { code: 'HOSTED_RELAY_NO_LOCAL_NODE' },
    );
  });
});

test('an existing session without an enrolled remote binding is refused, never run on the relay', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    const service = relayService({ count: 0 });
    const localRow = runtimeNodesDb.upsertLocal('copied-local', { label: 'old-control-plane', platform: 'win32', arch: 'x64', runtimeVersion: null });
    enrollRemote('nas-node', 'NAS');
    const project = projectsDb.createProjectWithoutControlPlaneCopy('Relay project');
    runtimeNodeWorkspacesDb.upsert({
      nodeId: 'nas-node',
      projectId: project.project_id,
      nodePath: '/volume1/code/app',
      status: 'verified',
      reason: null,
      verifiedAt: Date.now(),
      gitRootCommits: [],
    });
    const binding = (runtimeNodeId: string | null) => ({
      session_id: 's-1',
      provider: 'claude',
      runtime_node_id: runtimeNodeId,
      claude_profile_id: null,
      project_id: project.project_id,
      provider_session_id: null,
    });

    for (const bound of [null, localRow.nodeId]) {
      const target = service.resolveSessionExecution(binding(bound));
      assert.equal(target.kind, 'refused');
      assert.equal((target as { code: string }).code, 'HOSTED_RELAY_NO_LOCAL_NODE');
    }
    const offline = service.resolveSessionExecution(binding('nas-node'));
    assert.deepEqual([offline.kind, (offline as { code: string }).code], ['refused', 'RUNTIME_NODE_OFFLINE']);
    const unknown = service.resolveSessionExecution(binding('ghost-node'));
    assert.deepEqual([unknown.kind, (unknown as { code: string }).code], ['refused', 'RUNTIME_NODE_MISMATCH']);
    assert.equal(JSON.stringify(offline).includes('/volume1'), false, 'a refusal never carries the node path');
  });
});
