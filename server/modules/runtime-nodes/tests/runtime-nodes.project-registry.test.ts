// FT-M10 on the runtime-nodes service: runs route by the session's project id
// to the bound node's own folder (also for a project with no copy on this
// machine), nothing is substituted, and a remap never re-baselines identity.
// Fake node links over temporary databases.
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
  sessionsDb,
} from '@/modules/database/index.js';
import { createProjectWorkspaceLocator } from '@/modules/project-registry/index.js';
import type { RuntimeNodeLinkService } from '@/modules/runtime-nodes/runtime-node-link.service.js';
import type { RuntimeNodeRemoteExecutionService } from '@/modules/runtime-nodes/runtime-node-remote-execution.service.js';
import { createRuntimeNodesService } from '@/modules/runtime-nodes/runtime-nodes.service.js';
import type { RuntimeNodeCapabilityId, RuntimeNodeProbeOutcome } from '@/shared/types.js';

const NOW = Date.UTC(2026, 8, 16, 12, 0, 0);
const ROOT_A = 'a'.repeat(40);
const ROOT_B = 'b'.repeat(40);

async function withIsolatedDatabase(runTest: (directory: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-nodes-registry-'));
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

/** `app` has a copy here and folders on Pixel and the NAS; `pixelOnly` has no copy here and a folder on Pixel only. */
function seedFleet(directory: string) {
  const db = getConnection();
  db.prepare("INSERT INTO runtime_nodes (node_id, label, is_local, platform, arch) VALUES ('pc-node', 'Windows PC', 1, 'win32', 'x64')").run();
  for (const [nodeId, label] of [['pixel-node', 'Pixel'], ['nas-node', 'NAS']]) {
    db.prepare('INSERT INTO runtime_nodes (node_id, label, is_local, platform, arch) VALUES (?, ?, 0, ?, ?)').run(nodeId, label, 'linux', 'arm64');
    db.prepare("INSERT INTO runtime_node_credentials (node_id, public_key, status, enrolled_at) VALUES (?, ?, 'active', ?)").run(nodeId, `key-${nodeId}`, NOW);
  }
  const app = projectsDb.createProjectPath(path.join(directory, 'control-plane', 'app')).project!;
  const pixelOnly = projectsDb.createProjectWithoutControlPlaneCopy('Pixel-only app');
  const map = (nodeId: string, projectId: string, nodePath: string) =>
    runtimeNodeWorkspacesDb.upsert({ nodeId, projectId, nodePath, status: 'verified', reason: null, verifiedAt: NOW, gitRootCommits: [ROOT_A] });
  map('pixel-node', app.project_id, '/root/cloudcli-workspaces/app');
  map('nas-node', app.project_id, '/volume1/code/app');
  map('pixel-node', pixelOnly.project_id, '/root/cloudcli-workspaces/pixel-only');
  return { appId: app.project_id, pixelOnlyId: pixelOnly.project_id };
}

const provenProbe = async (): Promise<Record<RuntimeNodeCapabilityId, RuntimeNodeProbeOutcome>> => ({
  'node-runtime': { outcome: 'proven', detail: 'Node 22.12.0' },
  'claude-cli': { outcome: 'proven', detail: '2.1.220' },
  'claude-auth': { outcome: 'proven', detail: 'signed in' },
  'claude-headless': { outcome: 'not_probed', reason: 'no_run_observer' },
  'git-cli': { outcome: 'proven', detail: 'git version 2.45.0' },
  'workspace-filesystem': { outcome: 'proven' },
  'background-execution': { outcome: 'not_probed', reason: 'requires_device_verification' },
});

function repositoryObservation(rootCommit: string) {
  return {
    folder: 'available',
    git: { state: 'repository', rootIsFolder: true, branch: 'main', detached: false, headCommit: rootCommit, rootCommits: [rootCommit], upstream: null },
    changes: { staged: 0, modified: 0, added: 0, deleted: 0, renamed: 0, untracked: 0, conflicted: 0, total: 0, truncated: false },
    sync: null,
  };
}

function runtimeService(online: Set<string>) {
  const state = { verifyRootCommits: [ROOT_A], observedRoot: ROOT_A };
  const link = {
    path: '/api/runtime-node-link',
    getLinkInfo: (nodeId: string) => (online.has(nodeId) ? { connectedAt: NOW - 60_000, lastFrameAt: NOW, protocolCompatible: true, runtimeVersion: '1.38.0' } : null),
    isUsable: (nodeId: string) => online.has(nodeId),
    hasIdentityConflict: () => false,
    onLinkOpened: () => undefined,
    onLinkClosed: () => undefined,
    disconnect: () => undefined,
  } as unknown as RuntimeNodeLinkService;
  const remoteExecution = {
    probe: async () => ({ outcomes: { 'claude-cli': { outcome: 'proven', detail: '2.1.220' } }, resources: null }),
    verifyWorkspace: async (_nodeId: string, requested: string) => ({ ok: true, reason: null, path: requested, rootCommits: state.verifyRootCommits }),
    inspectWorkspace: async () => ({ ok: true, observation: repositoryObservation(state.observedRoot) }),
    failNodeRuns: () => undefined,
  } as unknown as RuntimeNodeRemoteExecutionService;
  const service = createRuntimeNodesService({ now: () => NOW, probeCapabilities: provenProbe, link, remoteExecution, isDirectory: async () => true });
  return { service, state };
}

const insertBoundSession = (sessionId: string, projectId: string, projectPath: string | null, nodeId: string) =>
  getConnection().prepare(`
    INSERT INTO sessions (session_id, provider, provider_session_id, project_id, project_path, runtime_node_id)
    VALUES (?, 'claude', ?, ?, ?, ?)
  `).run(sessionId, `native-${sessionId}`, projectId, projectPath, nodeId);

test('runs route by the session\'s project id to the bound node\'s own folder, including a project with no copy on this machine', { concurrency: false }, async () => {
  await withIsolatedDatabase(async (directory) => {
    const { appId, pixelOnlyId } = seedFleet(directory);
    const online = new Set(['pixel-node']);
    const { service } = runtimeService(online);
    const session = (sessionId: string) => sessionsDb.getSessionById(sessionId) as never;

    insertBoundSession('run-pixel-only', pixelOnlyId, null, 'pixel-node');
    assert.deepEqual(service.resolveSessionExecution(session('run-pixel-only')),
      { kind: 'remote', nodeId: 'pixel-node', nodeLabel: 'Pixel', cwd: '/root/cloudcli-workspaces/pixel-only', projectId: pixelOnlyId });

    // Its folder on this machine now belongs to another project: the session still runs where its own project lives.
    const other = projectsDb.createProjectPath(path.join(directory, 'control-plane', 'other')).project!;
    insertBoundSession('run-app-on-pixel', appId, other.project_path, 'pixel-node');
    assert.deepEqual(service.resolveSessionExecution(session('run-app-on-pixel')),
      { kind: 'remote', nodeId: 'pixel-node', nodeLabel: 'Pixel', cwd: '/root/cloudcli-workspaces/app', projectId: appId });

    insertBoundSession('run-app-on-nas', appId, null, 'nas-node');
    const offline = service.resolveSessionExecution(session('run-app-on-nas'));
    assert.equal((offline as { code: string }).code, 'RUNTIME_NODE_OFFLINE');
    assert.equal(JSON.stringify(offline).includes('/root/'), false, 'Pixel\'s folder is never offered to a NAS run');

    online.add('nas-node');
    insertBoundSession('run-pixel-only-on-nas', pixelOnlyId, null, 'nas-node');
    const unmapped = service.resolveSessionExecution(session('run-pixel-only-on-nas'));
    assert.equal((unmapped as { code: string }).code, 'RUNTIME_NODE_WORKSPACE_UNAVAILABLE');
    assert.equal(JSON.stringify(unmapped).includes('/root/'), false);

    assert.doesNotThrow(() => service.assertNodeCanRun('pixel-node', { provider: 'claude', claudeProfileId: null, projectId: pixelOnlyId }));
    assert.throws(() => service.assertNodeCanRun('nas-node', { provider: 'claude', claudeProfileId: null, projectId: pixelOnlyId }), { code: 'RUNTIME_NODE_WORKSPACE_UNAVAILABLE' });

    const listing = await service.listNodes({ projectId: pixelOnlyId });
    const local = listing.nodes.find((node) => node.isLocal);
    assert.deepEqual(local?.workspace, { state: 'unavailable', reason: 'no_control_plane_copy', verifiedAt: null }, 'no false local availability');
    const localState = await service.inspectProjectWorkspace(service.getLocalNodeId(), pixelOnlyId);
    assert.deepEqual([localState.state, localState.reason, localState.git], ['unmapped', 'no_control_plane_copy', null]);
  });
});

test('identity safety: a remap onto another repository keeps the recorded baseline, reads as identity_mismatch and never moves to another node', { concurrency: false }, async () => {
  await withIsolatedDatabase(async (directory) => {
    const { appId } = seedFleet(directory);
    const online = new Set(['pixel-node', 'nas-node']);
    const { service, state } = runtimeService(online);
    const locator = createProjectWorkspaceLocator({ isUsable: (nodeId) => online.has(nodeId) });

    state.verifyRootCommits = [ROOT_B];
    state.observedRoot = ROOT_B;
    await service.mapWorkspace({ nodeId: 'pixel-node', projectId: appId, path: '/root/cloudcli-workspaces/unrelated' });

    assert.deepEqual(runtimeNodeWorkspacesDb.get('pixel-node', appId)?.gitRootCommits, [ROOT_A], 'no silent re-baseline');
    const inspected = await service.inspectProjectWorkspace('pixel-node', appId);
    assert.deepEqual([inspected.state, inspected.identity], ['identity_mismatch', 'mismatch']);
    assert.deepEqual(locator.resolve({ projectId: appId, nodeId: 'pixel-node' }),
      { ok: true, projectId: appId, nodeId: 'pixel-node', isLocalNode: false, path: '/root/cloudcli-workspaces/unrelated', recordedIdentity: [ROOT_A] },
      'the mismatch is surfaced on the chosen node; the NAS copy is not substituted');
    assert.equal(projectsDb.getProjectById(appId)?.project_id, appId, 'the project identity is untouched');
    assert.deepEqual(runtimeNodeWorkspacesDb.get('nas-node', appId)?.gitRootCommits, [ROOT_A], 'other nodes are untouched');
  });
});
