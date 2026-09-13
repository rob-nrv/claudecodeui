import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { closeConnection, getConnection, initializeDatabase, runtimeNodesDb } from '@/modules/database/index.js';
import { createRuntimeNodesRouter } from '@/modules/runtime-nodes/runtime-nodes.routes.js';
import { createRuntimeNodesService } from '@/modules/runtime-nodes/runtime-nodes.service.js';
import type { RuntimeNodeCapabilityId, RuntimeNodeProbeOutcome } from '@/shared/types.js';

const NOW = Date.UTC(2026, 8, 13, 12, 0, 0);

type ProbeResult = Record<RuntimeNodeCapabilityId, RuntimeNodeProbeOutcome>;

const provenProbe = async (): Promise<ProbeResult> => ({
  'claude-cli': { outcome: 'proven', detail: '2.1.220 (Claude Code)' },
  'git-cli': { outcome: 'proven', detail: 'git version 2.45.0' },
  'workspace-filesystem': { outcome: 'proven' },
  'background-execution': { outcome: 'not_probed', reason: 'no_probe_available' },
});

async function withIsolatedDatabase(runTest: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'runtime-nodes-service-'));

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

test('the local node id is minted once and survives restarts and refreshed host facts', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    let minted = 0;
    const createNodeId = () => `node-${++minted}`;
    const first = createRuntimeNodesService({
      createNodeId,
      readHostFacts: () => ({ hostname: 'desk', platform: 'win32', arch: 'x64' }),
    });
    const registered = first.registerLocalNode('1.37.2');

    // A restart: a new service instance over the same database, after an upgrade and a hostname change.
    const afterRestart = createRuntimeNodesService({
      createNodeId,
      readHostFacts: () => ({ hostname: 'desk-renamed', platform: 'win32', arch: 'x64' }),
    });
    const again = afterRestart.registerLocalNode('1.38.0');

    assert.equal(again.nodeId, registered.nodeId);
    assert.equal(afterRestart.getLocalNodeId(), registered.nodeId);
    assert.equal(again.label, 'desk-renamed');
    assert.equal(again.runtimeVersion, '1.38.0');
    assert.equal(runtimeNodesDb.count(), 1);
  });
});

test('registering never probes and never claims availability or capabilities', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    let probes = 0;
    const service = createRuntimeNodesService({
      probeCapabilities: async () => {
        probes += 1;
        return provenProbe();
      },
    });
    const view = service.registerLocalNode('1.37.2');

    assert.equal(probes, 0);
    assert.equal(view.availability.state, 'unknown');
    assert.ok(view.capabilities.every((capability) => capability.status === 'unknown'));
  });
});

test('listing probes once, reuses fresh evidence and single-flights concurrent readers', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    let clock = NOW;
    let probes = 0;
    const service = createRuntimeNodesService({
      now: () => clock,
      probeCapabilities: async () => {
        probes += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return provenProbe();
      },
    });

    const [first, second] = await Promise.all([service.listNodes(), service.listNodes()]);
    assert.equal(probes, 1);
    assert.equal(first.nodes[0].availability.state, 'available');
    assert.deepEqual(second.nodes, first.nodes);

    clock += 30_000;
    await service.listNodes();
    assert.equal(probes, 1, 'fresh evidence is reused without re-running the CLIs');

    clock += 1_000;
    await service.listNodes({ refresh: true });
    assert.equal(probes, 2, 'an explicit refresh re-probes once the minimum interval has passed');

    await service.listNodes({ refresh: true });
    assert.equal(probes, 2, 'refresh spam cannot re-probe inside the minimum interval');

    clock += 61_000;
    await service.listNodes();
    assert.equal(probes, 3);
  });
});

test('evidence that stopped being refreshed ages into unavailable instead of staying online', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    let clock = NOW;
    await createRuntimeNodesService({ now: () => clock, probeCapabilities: provenProbe }).listNodes();

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const failingProbe = createRuntimeNodesService({
        now: () => clock,
        probeCapabilities: async () => {
          throw new Error('probe crashed');
        },
      });
      clock += 6 * 60_000;
      const listing = await failingProbe.listNodes();

      assert.equal(listing.nodes[0].availability.state, 'unavailable');
      assert.equal(listing.nodes[0].availability.reason, 'probe_stale');
      assert.equal(listing.nodes[0].availability.lastSeenAt, new Date(NOW).toISOString());
    } finally {
      console.warn = originalWarn;
    }
  });
});

test('a node without a proven Claude CLI is degraded, and a platform name never adds capabilities', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    const service = createRuntimeNodesService({
      readHostFacts: () => ({ hostname: 'phone', platform: 'android', arch: 'arm64' }),
      // A probe result missing an entry must not make that capability appear either.
      probeCapabilities: async () => ({
        'claude-cli': { outcome: 'failed', reason: 'executable_not_found' },
        'git-cli': { outcome: 'failed', reason: 'executable_not_found' },
        'workspace-filesystem': { outcome: 'proven' },
      }) as unknown as ProbeResult,
    });

    const [node] = (await service.listNodes()).nodes;
    assert.equal(node.platform, 'android');
    assert.equal(node.availability.state, 'degraded');
    assert.deepEqual(
      Object.fromEntries(node.capabilities.map((capability) => [capability.id, capability.status])),
      {
        'claude-cli': 'unavailable',
        'git-cli': 'unavailable',
        'workspace-filesystem': 'available',
        'background-execution': 'unknown',
      },
    );
  });
});

test('an execution target is implied only while exactly one node exists, and explicit ids are validated', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    const service = createRuntimeNodesService({ probeCapabilities: provenProbe });
    const localNodeId = service.getLocalNodeId();

    assert.equal(service.resolveExecutionTarget(), localNodeId);
    assert.equal(service.resolveExecutionTarget(null), localNodeId);
    assert.equal(service.resolveExecutionTarget(localNodeId), localNodeId);
    assert.throws(() => service.resolveExecutionTarget('missing-node'), { code: 'RUNTIME_NODE_NOT_FOUND' });

    // Once a second node is known, nothing may be implied, and it cannot execute from this server.
    getConnection()
      .prepare("INSERT INTO runtime_nodes (node_id, label, is_local) VALUES ('nas-node', 'NAS', 0)")
      .run();
    assert.throws(() => service.resolveExecutionTarget(), { code: 'RUNTIME_NODE_REQUIRED' });
    assert.throws(() => service.resolveExecutionTarget('nas-node'), { code: 'RUNTIME_NODE_NOT_EXECUTABLE' });
    assert.equal(service.resolveExecutionTarget(localNodeId), localNodeId);

    const listing = await service.listNodes();
    assert.deepEqual(listing.nodes.map((node) => [node.nodeId, node.canExecute]), [[localNodeId, true], ['nas-node', false]]);
    const nasNode = listing.nodes.find((node) => node.nodeId === 'nas-node');
    assert.equal(nasNode?.availability.state, 'unknown');
  });
});

test('a session runs only on its own node; unrecorded legacy bindings keep running locally', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    const service = createRuntimeNodesService();
    const localNodeId = service.getLocalNodeId();

    assert.deepEqual(service.checkSessionRunsHere(null), { ok: true });
    assert.deepEqual(service.checkSessionRunsHere(localNodeId), { ok: true });
    assert.deepEqual(service.checkSessionRunsHere('another-node'), { ok: false, code: 'RUNTIME_NODE_MISMATCH' });
  });
});

test('GET /api/runtime-nodes returns probed nodes without paths, and rejects a malformed refresh flag', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    const service = createRuntimeNodesService({
      probeCapabilities: provenProbe,
      readHostFacts: () => ({ hostname: 'desk', platform: 'linux', arch: 'x64' }),
    });
    const app = express();
    app.use('/api/runtime-nodes', createRuntimeNodesRouter(service));
    app.use((error: { statusCode?: number; code?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(error.statusCode ?? 500).json({ success: false, error: { code: error.code } });
    });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');

    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const response = await fetch(`${baseUrl}/api/runtime-nodes?refresh=1`);
      assert.equal(response.status, 200);
      const body = await response.json() as { data: { localNodeId: string; nodes: Array<Record<string, unknown>> } };
      assert.equal(body.data.nodes.length, 1);
      assert.equal(body.data.nodes[0].nodeId, body.data.localNodeId);
      assert.equal(body.data.nodes[0].label, 'desk');
      assert.deepEqual(body.data.nodes[0].availability && (body.data.nodes[0].availability as { state: string }).state, 'available');
      assert.equal(/[\\/]/.test(JSON.stringify(body.data.nodes[0].capabilities)), false);

      const invalid = await fetch(`${baseUrl}/api/runtime-nodes?refresh=maybe`);
      assert.equal(invalid.status, 400);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
