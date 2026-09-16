// FT-M10 Project Registry: one contract run against the local SQLite adapter
// and the in-memory fake, the pure no-fallback resolver, and the additive
// registry routes. Temporary databases only.
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
  runtimeNodeWorkspacesDb,
} from '@/modules/database/index.js';
import {
  createInMemoryProjectRegistry,
  createLocalProjectRegistry,
  createProjectRegistryRouter,
  createProjectWorkspaceLocator,
  parseCheckpointReference,
  resolveProjectWorkspace,
  type ProjectRegistry,
  type WorkspaceResolutionFacts,
} from '@/modules/project-registry/index.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST = 'd'.repeat(64);
const ROOT_A = 'a'.repeat(40);
const VERIFIED_AT = Date.UTC(2026, 8, 16, 9, 0, 0);

async function withIsolatedDatabase(runTest: (directory: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'project-registry-'));
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

/** The contract every ProjectRegistry adapter must meet, local now and hosted later. */
async function assertRegistryContract(registry: ProjectRegistry): Promise<void> {
  const registered = await registry.registerProject({ displayName: '  Mobile app  ' });
  assert.match(registered.projectId, UUID_PATTERN, 'the identity is a minted id, never a path');
  assert.deepEqual(registered, {
    projectId: registered.projectId,
    displayName: 'Mobile app',
    isStarred: false,
    isArchived: false,
    latestCheckpoint: null,
  });

  assert.deepEqual(await registry.getProject(registered.projectId), registered, 'lookup returns the same identity');
  assert.deepEqual(await registry.getProject(registered.projectId), await registry.getProject(registered.projectId), 'identity is stable across reads');
  assert.equal(await registry.getProject('no-such-project'), null);
  assert.ok((await registry.listProjects()).some((project) => project.projectId === registered.projectId));
  assert.ok((await registry.listProjects('all')).some((project) => project.projectId === registered.projectId));
  assert.equal((await registry.listProjects('archived')).some((project) => project.projectId === registered.projectId), false);
  assert.deepEqual(await registry.listNodeAssociations(registered.projectId), [], 'no association is invented for a new project');

  const second = await registry.registerProject({ displayName: 'Mobile app' });
  assert.notEqual(second.projectId, registered.projectId, 'the same name never merges two projects');

  for (const displayName of ['', '   ', 'x'.repeat(121), 'bad\nname', 42, null]) {
    await assert.rejects(() => registry.registerProject({ displayName }), { code: 'PROJECT_DISPLAY_NAME_INVALID' });
  }
}

test('the in-memory fake meets the ProjectRegistry contract', async () => {
  await assertRegistryContract(createInMemoryProjectRegistry());
});

test('the local SQLite adapter meets the ProjectRegistry contract and needs no control-plane copy', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    const registry = createLocalProjectRegistry();
    await assertRegistryContract(registry);

    const [hosted] = (await registry.listProjects()).filter((project) => project.displayName === 'Mobile app');
    const row = projectsDb.getProjectById(hosted.projectId);
    assert.equal(row?.project_path, null, 'nothing was written as a folder');
    assert.equal(projectsDb.getProjectPaths().some((entry) => entry.project_id === hosted.projectId), false);

    const locator = createProjectWorkspaceLocator();
    assert.deepEqual(locator.resolveOnControlPlane(hosted.projectId), {
      ok: false,
      projectId: hosted.projectId,
      nodeId: 'local',
      code: 'WORKSPACE_NOT_ON_NODE',
      reason: 'no_control_plane_copy',
    });
  });
});

test('a project with a copy here: display name from its folder, associations without node paths, latestCheckpoint null until one is recorded', { concurrency: false }, async () => {
  await withIsolatedDatabase(async (directory) => {
    const folder = path.join(directory, 'work', 'shop');
    const project = projectsDb.createProjectPath(folder).project!;
    const db = getConnection();
    db.prepare("INSERT INTO runtime_nodes (node_id, label, is_local) VALUES ('pixel-node', 'Pixel', 0)").run();
    runtimeNodeWorkspacesDb.upsert({
      nodeId: 'pixel-node', projectId: project.project_id, nodePath: '/root/ws/shop', status: 'verified', reason: null, verifiedAt: VERIFIED_AT, gitRootCommits: [ROOT_A],
    });

    const registry = createLocalProjectRegistry();
    const registered = await registry.getProject(project.project_id);
    assert.equal(registered?.displayName, 'shop');
    assert.equal(registered?.latestCheckpoint, null, 'no snapshot storage exists: unknown stays null');
    const associations = await registry.listNodeAssociations(project.project_id);
    assert.deepEqual(associations, [{
      projectId: project.project_id,
      nodeId: 'pixel-node',
      status: 'verified',
      reason: null,
      verifiedAt: new Date(VERIFIED_AT).toISOString(),
      repositoryIdentity: [ROOT_A],
    }]);
    assert.equal(JSON.stringify(associations).includes('/root/ws/shop'), false, 'a node-local path never enters the registry');

    db.prepare(`UPDATE projects SET latest_checkpoint_snapshot_id = 'snap-1', latest_checkpoint_changes_digest = ?, latest_checkpoint_head_commit = ?,
                latest_checkpoint_node_id = 'pixel-node', latest_checkpoint_at = ? WHERE project_id = ?`).run(DIGEST, ROOT_A, VERIFIED_AT, project.project_id);
    assert.deepEqual((await registry.getProject(project.project_id))?.latestCheckpoint, {
      snapshotId: 'snap-1', changesDigest: DIGEST, headCommit: ROOT_A, sourceNodeId: 'pixel-node', createdAt: new Date(VERIFIED_AT).toISOString(),
    });
    db.prepare('UPDATE projects SET latest_checkpoint_changes_digest = NULL WHERE project_id = ?').run(project.project_id);
    assert.equal((await registry.getProject(project.project_id))?.latestCheckpoint, null, 'a partial reference is unknown, never half-invented');
  });
});

test('checkpoint references are all-or-nothing', () => {
  const valid = { snapshotId: 'snap', changesDigest: DIGEST, headCommit: null, sourceNodeId: 'node', createdAt: VERIFIED_AT };
  assert.deepEqual(parseCheckpointReference(valid), { ...valid, createdAt: new Date(VERIFIED_AT).toISOString() });
  for (const broken of [
    { snapshotId: null },
    { snapshotId: '  ' },
    { changesDigest: 'short' },
    { headCommit: 'not-a-commit' },
    { sourceNodeId: null },
    { createdAt: null },
    { createdAt: 0 },
    { createdAt: '2026-09-16' },
  ]) {
    assert.equal(parseCheckpointReference({ ...valid, ...broken }), null, JSON.stringify(broken));
  }
});

test('the resolver only ever consults the targeted node and never returns a substitute path', () => {
  const base: WorkspaceResolutionFacts = {
    projectId: 'project-1',
    nodeId: 'nas-node',
    project: { controlPlanePath: '/control-plane/app' },
    node: { isLocal: false, credentialStatus: 'active' },
    mapping: { nodePath: '/volume1/code/app', status: 'verified', reason: null, gitRootCommits: [ROOT_A] },
    linkUsable: true,
  };
  assert.deepEqual(resolveProjectWorkspace(base), {
    ok: true, projectId: 'project-1', nodeId: 'nas-node', isLocalNode: false, path: '/volume1/code/app', recordedIdentity: [ROOT_A],
  });

  const cases: Array<[Partial<WorkspaceResolutionFacts>, string, string | null]> = [
    [{ project: null }, 'PROJECT_NOT_FOUND', null],
    [{ node: null }, 'RUNTIME_NODE_NOT_FOUND', null],
    [{ node: { isLocal: false, credentialStatus: null } }, 'RUNTIME_NODE_NOT_ENROLLED', null],
    [{ node: { isLocal: false, credentialStatus: 'revoked' } }, 'RUNTIME_NODE_REVOKED', null],
    [{ mapping: null }, 'WORKSPACE_NOT_ON_NODE', 'not_mapped'],
    [{ mapping: { ...base.mapping!, status: 'unavailable', reason: 'rejected_by_node' } }, 'WORKSPACE_UNAVAILABLE', 'rejected_by_node'],
    [{ linkUsable: false }, 'RUNTIME_NODE_OFFLINE', null],
    [{ node: { isLocal: true, credentialStatus: null }, project: { controlPlanePath: null } }, 'WORKSPACE_NOT_ON_NODE', 'no_control_plane_copy'],
    [{ node: { isLocal: true, credentialStatus: null }, project: { controlPlanePath: '   ' } }, 'WORKSPACE_NOT_ON_NODE', 'no_control_plane_copy'],
  ];
  for (const [override, code, reason] of cases) {
    const resolution = resolveProjectWorkspace({ ...base, ...override });
    assert.deepEqual(resolution, { ok: false, projectId: 'project-1', nodeId: 'nas-node', code, reason }, code);
    assert.equal(JSON.stringify(resolution).includes('/'), false, `${code} carries no path`);
  }

  const local = resolveProjectWorkspace({ ...base, node: { isLocal: true, credentialStatus: null } });
  assert.deepEqual(local, { ok: true, projectId: 'project-1', nodeId: 'nas-node', isLocalNode: true, path: '/control-plane/app', recordedIdentity: null },
    'the local node uses its own copy, never a remote mapping');
});

test('registry routes list every project whatever its copies, never expose a path, and refuse invalid input explicitly', { concurrency: false }, async () => {
  await withIsolatedDatabase(async (directory) => {
    const withCopy = projectsDb.createProjectPath(path.join(directory, 'work', 'site')).project!;
    const app = express();
    app.use(express.json());
    app.use('/api/projects/registry', createProjectRegistryRouter({ registry: createLocalProjectRegistry(), locator: createProjectWorkspaceLocator() }));
    app.use((error: { statusCode?: number; code?: string; message: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(error.statusCode ?? 500).json({ code: error.code, message: error.message });
    });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/registry`;
    try {
      const created = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ displayName: 'Pixel only' }) });
      assert.equal(created.status, 201);
      const createdBody = await created.json() as { data: { project: { projectId: string; controlPlaneCopy: string } } };
      assert.equal(createdBody.data.project.controlPlaneCopy, 'absent');

      const listing = await fetch(base);
      const listingText = await listing.text();
      const projects = (JSON.parse(listingText) as { data: { projects: Array<{ projectId: string; controlPlaneCopy: string }> } }).data.projects;
      assert.deepEqual(
        Object.fromEntries(projects.map((project) => [project.projectId, project.controlPlaneCopy])),
        { [withCopy.project_id]: 'present', [createdBody.data.project.projectId]: 'absent' },
      );
      assert.equal(listingText.includes(directory.replace(/\\/g, '\\\\')), false, 'no control-plane path in the registry API');

      const detail = await fetch(`${base}/${createdBody.data.project.projectId}`);
      assert.equal(detail.status, 200);
      assert.deepEqual((await detail.json() as { data: { associations: unknown[] } }).data.associations, []);

      assert.equal((await fetch(`${base}/unknown-project`)).status, 404);
      assert.equal((await fetch(`${base}?filter=everything`)).status, 400);
      const invalid = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ displayName: '' }) });
      assert.equal(invalid.status, 400);
      assert.equal((await invalid.json() as { code: string }).code, 'PROJECT_DISPLAY_NAME_INVALID');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
