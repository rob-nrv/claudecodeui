// FT-M09 portable project identity: a project is its id; every RuntimeNode maps
// it to its own local folder; workspace state is inspected by the machine that
// owns the folder. Remote nodes sit behind a fake link and a fake remote
// execution service over a temporary database.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  runtimeNodesDb,
  runtimeNodeWorkspacesDb,
  sessionsDb,
} from '@/modules/database/index.js';
import type { RuntimeNodeLinkService } from '@/modules/runtime-nodes/runtime-node-link.service.js';
import type { RuntimeNodeRemoteExecutionService } from '@/modules/runtime-nodes/runtime-node-remote-execution.service.js';
import { createRuntimeNodesRouter } from '@/modules/runtime-nodes/runtime-nodes.routes.js';
import { createRuntimeNodesService } from '@/modules/runtime-nodes/runtime-nodes.service.js';
import type { RuntimeNodeCapabilityId, RuntimeNodeProbeOutcome } from '@/shared/types.js';

const NOW = Date.UTC(2026, 8, 13, 12, 0, 0);
const ROOT_A = 'a'.repeat(40);
const ROOT_B = 'b'.repeat(40);
// The real commit hash from the HC-06 hardware failure this file's identity
// tests reproduce (HC06-IDENTITY-REPAIR-R1).
const ROOT_MISMATCH = 'ea2c8da60fc8131776a931782bce9f01c17dbe45';

const provenProbe = async (): Promise<Record<RuntimeNodeCapabilityId, RuntimeNodeProbeOutcome>> => ({
  'node-runtime': { outcome: 'proven', detail: 'Node 22.12.0 linux x64' },
  'claude-cli': { outcome: 'proven', detail: '2.1.220 (Claude Code)' },
  'claude-auth': { outcome: 'proven', detail: 'signed in' },
  'claude-headless': { outcome: 'not_probed', reason: 'no_run_observer' },
  'git-cli': { outcome: 'proven', detail: 'git version 2.45.0' },
  'workspace-filesystem': { outcome: 'proven' },
  'background-execution': { outcome: 'not_probed', reason: 'requires_device_verification' },
});

async function withIsolatedDatabase(runTest: (directory: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'runtime-nodes-portable-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await writeFile(process.env.DATABASE_PATH, '');
  await initializeDatabase();
  try {
    await runTest(directory);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

type InspectAnswer = { ok: true; observation: unknown } | { ok: false; reason: string };

/** Two enrolled remote nodes behind a fake link and a fake remote execution service. */
function remoteNodesHarness(directory: string) {
  const state = {
    usable: true,
    inspect: async (): Promise<InspectAnswer> => ({ ok: false, reason: 'folder_not_found' }),
    // HC06-IDENTITY-REPAIR-R1: what the node claims a newly-mapped folder's
    // root commits are. Defaults to ROOT_A so every existing test (which
    // never touches this) is unaffected; identity tests below flip it to
    // simulate mapping onto a different repository.
    verifyRootCommits: [ROOT_A] as string[],
  };
  const link = {
    path: '/api/runtime-node-link',
    getLinkInfo: () => (state.usable ? { connectedAt: NOW - 60_000, lastFrameAt: NOW, protocolCompatible: true, runtimeVersion: '1.38.0' } : null),
    isUsable: () => state.usable,
    hasIdentityConflict: () => false,
    onLinkOpened: () => undefined,
    onLinkClosed: () => undefined,
    disconnect: () => undefined,
  } as unknown as RuntimeNodeLinkService;
  const remoteExecution = {
    probe: async () => ({
      outcomes: { 'claude-cli': { outcome: 'proven', detail: '2.1.220' }, 'root-shell': { outcome: 'proven' } },
      resources: {
        admission: 'accepting',
        restriction: null,
        activeRuns: 0,
        maxConcurrentRuns: 1,
        storage: { state: 'known', freeBytes: 10 * 1024 ** 3, minFreeBytes: 512 * 1024 ** 2 },
        battery: { state: 'unknown', reason: 'battery_unreadable' },
        thermal: { state: 'unknown', reason: 'no_portable_source' },
      },
    }),
    verifyWorkspace: async (_nodeId: string, requested: string) => ({ ok: true, reason: null, path: requested, rootCommits: state.verifyRootCommits }),
    inspectWorkspace: async () => state.inspect(),
    failNodeRuns: () => undefined,
  } as unknown as RuntimeNodeRemoteExecutionService;

  const db = getConnection();
  for (const [nodeId, label] of [['pixel-node', 'Pixel'], ['nas-node', 'NAS']]) {
    db.prepare('INSERT INTO runtime_nodes (node_id, label, is_local, platform, arch) VALUES (?, ?, 0, ?, ?)').run(nodeId, label, 'linux', 'arm64');
    db.prepare("INSERT INTO runtime_node_credentials (node_id, public_key, status, enrolled_at) VALUES (?, ?, 'active', ?)").run(nodeId, `key-${nodeId}`, NOW);
  }
  const project = projectsDb.createProjectPath(path.join(directory, 'control-plane', 'app')).project;
  const service = createRuntimeNodesService({
    now: () => NOW,
    probeCapabilities: provenProbe,
    link,
    remoteExecution,
    isDirectory: async () => true,
  });
  return { state, service, projectId: project?.project_id as string, projectPath: project?.project_path as string };
}

test('one project, two RuntimeNodes, two different local folders: identity is the project id, never a path', { concurrency: false }, async () => {
  await withIsolatedDatabase(async (directory) => {
    const { service, projectId, projectPath } = remoteNodesHarness(directory);

    await service.mapWorkspace({ nodeId: 'pixel-node', projectId, path: '/root/cloudcli-workspaces/app' });
    await service.mapWorkspace({ nodeId: 'nas-node', projectId, path: '/volume1/code/app' });

    assert.deepEqual(runtimeNodeWorkspacesDb.listByProject(projectId).map((mapping) => [mapping.nodeId, mapping.nodePath, mapping.gitRootCommits]), [
      ['nas-node', '/volume1/code/app', [ROOT_A]],
      ['pixel-node', '/root/cloudcli-workspaces/app', [ROOT_A]],
    ]);

    sessionsDb.createAppSession('session-pixel', 'claude', projectPath, 'On Pixel', null, 'pixel-node');
    sessionsDb.createAppSession('session-nas', 'claude', projectPath, 'On NAS', null, 'nas-node');
    assert.deepEqual(
      service.resolveSessionExecution(sessionsDb.getSessionById('session-pixel') as never),
      { kind: 'remote', nodeId: 'pixel-node', nodeLabel: 'Pixel', cwd: '/root/cloudcli-workspaces/app', projectId },
    );
    assert.deepEqual(
      service.resolveSessionExecution(sessionsDb.getSessionById('session-nas') as never),
      { kind: 'remote', nodeId: 'nas-node', nodeLabel: 'NAS', cwd: '/volume1/code/app', projectId },
    );

    // This machine moves its own copy: the project, and every node's mapping of it, stay the same.
    const movedPath = path.join(directory, 'control-plane', 'moved-app');
    getConnection().prepare('UPDATE projects SET project_path = ? WHERE project_id = ?').run(movedPath, projectId);
    assert.doesNotThrow(() => service.assertNodeCanRun('pixel-node', { provider: 'claude', claudeProfileId: null, projectPath: movedPath }));
    assert.throws(
      () => service.assertNodeCanRun('pixel-node', { provider: 'claude', claudeProfileId: null, projectPath: path.join(directory, 'other') }),
      { code: 'RUNTIME_NODE_WORKSPACE_UNAVAILABLE' },
      'a path that is not a registered project resolves to no mapping',
    );

    const listing = await service.listNodes({ projectId });
    const byNode = Object.fromEntries(listing.nodes.map((node) => [node.isLocal ? 'local' : node.nodeId, node]));
    assert.deepEqual(
      Object.fromEntries(Object.entries(byNode).map(([key, node]) => [key, node.workspace?.state])),
      { local: 'available', 'pixel-node': 'mapped', 'nas-node': 'mapped' },
    );
    const serialized = JSON.stringify(listing);
    assert.equal(serialized.includes('/root/cloudcli-workspaces') || serialized.includes('/volume1'), false, 'node-local paths never leave the server');
    assert.equal(serialized.includes('root-shell'), false, 'a node cannot add a capability id');

    const pixel = byNode['pixel-node'];
    assert.equal(pixel.capabilities.find((capability) => capability.id === 'claude-cli')?.freshness, 'fresh');
    assert.equal(pixel.capabilities.find((capability) => capability.id === 'background-execution')?.verification, 'device_check');
    assert.equal(pixel.resources?.admission, 'accepting');
    assert.deepEqual(pixel.resources?.battery, { state: 'unknown', reason: 'battery_unreadable' });

    // Deleting the project removes what named it; nothing dangles by path.
    projectsDb.deleteProjectById(projectId);
    assert.deepEqual(runtimeNodeWorkspacesDb.listByProject(projectId), []);
  });
});

test('workspace state is inspected by the machine that owns the folder and classified without guessing', { concurrency: false }, async () => {
  await withIsolatedDatabase(async (directory) => {
    const { state, service, projectId } = remoteNodesHarness(directory);
    const gitWith = (rootCommits: string[], upstream: { ahead: number; behind: number } | null = null) =>
      ({ state: 'repository', rootIsFolder: true, branch: 'main', detached: false, headCommit: 'c'.repeat(40), rootCommits, upstream });
    const repository = (overrides: Record<string, unknown> = {}) => ({
      folder: 'available',
      folderReason: null,
      git: gitWith([ROOT_A]),
      changes: { staged: 0, modified: 0, added: 0, deleted: 0, renamed: 0, untracked: 0, conflicted: 0, total: 0, truncated: false },
      sync: { syncable: 0, localOnly: 0, secret: 0, userExcluded: 0, secretContent: 0, changesDigest: 'd'.repeat(64), digestReason: null },
      ...overrides,
    });

    assert.equal((await service.inspectProjectWorkspace('pixel-node', projectId)).state, 'unmapped', 'no folder mapped on that node: nothing is assumed');
    await service.mapWorkspace({ nodeId: 'pixel-node', projectId, path: '/root/cloudcli-workspaces/app' });

    state.inspect = async () => ({ ok: true, observation: repository() });
    const clean = await service.inspectProjectWorkspace('pixel-node', projectId);
    assert.deepEqual([clean.state, clean.identity, clean.git?.branch], ['clean', 'match', 'main']);

    state.inspect = async () => ({
      ok: true,
      observation: repository({
        changes: { staged: 0, modified: 2, added: 0, deleted: 0, renamed: 0, untracked: 1, conflicted: 0, total: 3, truncated: false },
        path: '/root/secret',
      }),
    });
    const dirty = await service.inspectProjectWorkspace('pixel-node', projectId);
    assert.deepEqual([dirty.state, dirty.reason, dirty.changes?.total], ['dirty', 'uncommitted_changes', 3]);
    assert.equal(JSON.stringify(dirty).includes('/root'), false);

    state.inspect = async () => ({ ok: true, observation: repository({ git: gitWith([ROOT_B], { ahead: 1, behind: 2 }) }) });
    assert.equal((await service.inspectProjectWorkspace('pixel-node', projectId)).state, 'identity_mismatch', 'another repository in the mapped folder');

    state.inspect = async () => ({ ok: true, observation: repository({ git: gitWith([ROOT_A], { ahead: 1, behind: 2 }) }) });
    assert.equal((await service.inspectProjectWorkspace('pixel-node', projectId)).state, 'diverged');

    state.inspect = async () => ({ ok: false, reason: 'folder_not_found' });
    assert.equal((await service.inspectProjectWorkspace('pixel-node', projectId)).state, 'missing');

    state.inspect = async () => ({ ok: true, observation: { folder: 'sideways' } });
    assert.equal((await service.inspectProjectWorkspace('pixel-node', projectId)).reason, 'malformed_node_answer');

    state.usable = false;
    const offline = await service.inspectProjectWorkspace('pixel-node', projectId);
    assert.deepEqual([offline.state, offline.reason], ['unavailable', 'node_offline'], 'an offline node is never inspected through another machine');

    const local = createRuntimeNodesService({
      now: () => NOW,
      probeCapabilities: provenProbe,
      inspectLocalWorkspace: async () => repository({
        changes: { staged: 1, modified: 1, added: 0, deleted: 0, renamed: 0, untracked: 0, conflicted: 1, total: 1, truncated: false },
      }) as never,
    });
    const localState = await local.inspectProjectWorkspace(local.getLocalNodeId(), projectId);
    assert.deepEqual([localState.state, localState.reason, localState.identity], ['dirty', 'unmerged_paths', 'unrecorded']);
    await assert.rejects(() => local.inspectProjectWorkspace(local.getLocalNodeId(), 'missing-project'), { code: 'PROJECT_NOT_FOUND' });
  });
});

// HC06-IDENTITY-REPAIR-R1: the real Pixel HC-06 failure this reproduces —
// mapping a project onto an unrelated repository must not silently
// re-baseline the recorded identity, or the mapped-onto repository always
// reads back as a trivial match against itself. See
// server/modules/database/repositories/runtime-node-workspaces.db.ts's
// `upsert` for the fix and server/modules/database/tests/
// runtime-node-workspaces.db.test.ts for the direct persistence-layer proof.
test('mapping onto an unrelated repository does not replace the recorded identity, surfaces identity_mismatch, and remapping back restores clean/match', { concurrency: false }, async () => {
  await withIsolatedDatabase(async (directory) => {
    const { state, service, projectId } = remoteNodesHarness(directory);
    const gitWith = (rootCommits: string[]) =>
      ({ state: 'repository', rootIsFolder: true, branch: 'master', detached: false, headCommit: rootCommits[0], rootCommits, upstream: null });
    const cleanObservation = (rootCommits: string[]) => ({
      folder: 'available',
      folderReason: null,
      git: gitWith(rootCommits),
      changes: { staged: 0, modified: 0, added: 0, deleted: 0, renamed: 0, untracked: 0, conflicted: 0, total: 0, truncated: false },
      sync: { syncable: 0, localOnly: 0, secret: 0, userExcluded: 0, secretContent: 0, changesDigest: 'e'.repeat(64), digestReason: null },
    });

    // 1-2: map project P to repository A; root identity A is recorded.
    state.verifyRootCommits = [ROOT_A];
    await service.mapWorkspace({ nodeId: 'pixel-node', projectId, path: '/root/cloudcli-workspaces-hc06/claudecodeui' });
    assert.deepEqual(runtimeNodeWorkspacesDb.get('pixel-node', projectId)?.gitRootCommits, [ROOT_A]);

    // 3: remap the SAME (node, project) to an unrelated repository B.
    state.verifyRootCommits = [ROOT_MISMATCH];
    const remapped = await service.mapWorkspace({ nodeId: 'pixel-node', projectId, path: '/root/cloudcli-workspaces-hc06/hc06-identity-mismatch' });
    assert.equal(remapped.state, 'mapped', 'the mapping operation itself still succeeds — this is a normal RuntimeNode folder pointer, not a rejection');

    // 4: expected identity A is NOT replaced by B.
    assert.deepEqual(runtimeNodeWorkspacesDb.get('pixel-node', projectId)?.gitRootCommits, [ROOT_A], 'the recorded baseline must stay A');

    // 5: workspace state reports identity_mismatch (current B vs expected A).
    state.inspect = async () => ({ ok: true, observation: cleanObservation([ROOT_MISMATCH]) });
    const mismatch = await service.inspectProjectWorkspace('pixel-node', projectId);
    assert.equal(mismatch.state, 'identity_mismatch');
    assert.equal(mismatch.reason, 'different_repository_history');
    assert.equal(mismatch.identity, 'mismatch');

    // Mismatch never leaks a filesystem path or a repository URL to the browser.
    const serializedMismatch = JSON.stringify(mismatch);
    assert.equal(serializedMismatch.includes('/root/cloudcli-workspaces-hc06'), false);
    assert.equal(serializedMismatch.includes('hc06-identity-mismatch'), false);

    // 6: remap to repository A.
    state.verifyRootCommits = [ROOT_A];
    await service.mapWorkspace({ nodeId: 'pixel-node', projectId, path: '/root/cloudcli-workspaces-hc06/claudecodeui' });
    assert.deepEqual(runtimeNodeWorkspacesDb.get('pixel-node', projectId)?.gitRootCommits, [ROOT_A]);

    // 7: state returns to match/clean.
    state.inspect = async () => ({ ok: true, observation: cleanObservation([ROOT_A]) });
    const clean = await service.inspectProjectWorkspace('pixel-node', projectId);
    assert.deepEqual([clean.state, clean.identity, clean.reason], ['clean', 'match', null]);
  });
});

test('remapping to a different clone of the SAME repository (matching root identity) is allowed and never reads as a mismatch', { concurrency: false }, async () => {
  await withIsolatedDatabase(async (directory) => {
    const { state, service, projectId } = remoteNodesHarness(directory);
    const gitWith = (rootCommits: string[]) =>
      ({ state: 'repository', rootIsFolder: true, branch: 'main', detached: false, headCommit: rootCommits[0], rootCommits, upstream: null });
    const cleanObservation = (rootCommits: string[]) => ({
      folder: 'available',
      folderReason: null,
      git: gitWith(rootCommits),
      changes: { staged: 0, modified: 0, added: 0, deleted: 0, renamed: 0, untracked: 0, conflicted: 0, total: 0, truncated: false },
      sync: { syncable: 0, localOnly: 0, secret: 0, userExcluded: 0, secretContent: 0, changesDigest: 'f'.repeat(64), digestReason: null },
    });

    state.verifyRootCommits = [ROOT_A];
    await service.mapWorkspace({ nodeId: 'pixel-node', projectId, path: '/root/ws/app-clone-1' });

    // A second, independent clone of the exact same repository history,
    // mapped at a different local path on the same node.
    state.verifyRootCommits = [ROOT_A];
    await service.mapWorkspace({ nodeId: 'pixel-node', projectId, path: '/root/ws/app-clone-2' });
    assert.deepEqual(runtimeNodeWorkspacesDb.get('pixel-node', projectId)?.gitRootCommits, [ROOT_A]);

    state.inspect = async () => ({ ok: true, observation: cleanObservation([ROOT_A]) });
    const result = await service.inspectProjectWorkspace('pixel-node', projectId);
    assert.deepEqual([result.state, result.identity], ['clean', 'match']);
  });
});

test('the first-ever mapping for a project still initializes its identity correctly', { concurrency: false }, async () => {
  await withIsolatedDatabase(async (directory) => {
    const { state, service, projectId } = remoteNodesHarness(directory);
    state.verifyRootCommits = [ROOT_B];
    assert.equal(runtimeNodeWorkspacesDb.get('pixel-node', projectId), null, 'nothing mapped yet');
    await service.mapWorkspace({ nodeId: 'pixel-node', projectId, path: '/root/ws/fresh-project' });
    assert.deepEqual(runtimeNodeWorkspacesDb.get('pixel-node', projectId)?.gitRootCommits, [ROOT_B]);
  });
});

test('browsers cannot author capability evidence: no write route exists for it, and the state route is read-only', { concurrency: false }, async () => {
  await withIsolatedDatabase(async (directory) => {
    const service = createRuntimeNodesService({
      probeCapabilities: provenProbe,
      inspectLocalWorkspace: async () => ({ folder: 'missing', folderReason: 'folder_not_found', git: { state: 'unknown', reason: 'folder_unavailable' }, changes: null, sync: null }),
    });
    const localNodeId = service.getLocalNodeId();
    const project = projectsDb.createProjectPath(path.join(directory, 'route-project')).project;
    const app = express();
    app.use(express.json());
    app.use('/api/runtime-nodes', createRuntimeNodesRouter(service));
    app.use((error: { statusCode?: number; code?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(error.statusCode ?? 500).json({ success: false, error: { code: error.code } });
    });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/runtime-nodes`;
      const forged = JSON.stringify({ capabilities: [{ id: 'claude-cli', status: 'available', probedAt: NOW }] });
      for (const [method, url] of [['POST', `${baseUrl}/${localNodeId}/capabilities`], ['PUT', `${baseUrl}/${localNodeId}`], ['PATCH', baseUrl]] as const) {
        const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: forged });
        assert.equal(response.status, 404, `${method} ${url}`);
      }
      assert.equal(runtimeNodesDb.getById(localNodeId)?.capabilitiesJson ?? null, null, 'nothing was recorded');

      const stateResponse = await fetch(`${baseUrl}/${localNodeId}/workspaces/${project?.project_id}/state`);
      assert.equal(stateResponse.status, 200);
      const body = await stateResponse.json() as { data: { workspace: { state: string } } };
      assert.equal(body.data.workspace.state, 'missing');
      assert.equal((await fetch(`${baseUrl}/${localNodeId}/workspaces/${encodeURIComponent('../../etc')}/state`)).status, 400);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
