// FT-M08 -> FT-M09 migration of runtime_node_workspaces (path-keyed -> project-id-keyed).
// Fixtures reproduce the FT-M08 schema a real control plane has after HC-05, in
// temporary databases only.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  projectsDb,
  runtimeNodeCredentialsDb,
  runtimeNodeWorkspacesDb,
  sessionsDb,
} from '@/modules/database/index.js';

const VERIFIED_AT = 1757764800000;

async function withDatabasePath(runTest: (databasePath: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workspaces-migration-'));
  const databasePath = path.join(directory, 'auth.db');
  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  try {
    await runTest(databasePath);
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

/** The FT-M08 shape of every table this migration reads, plus seed rows. */
function createFtM08Database(databasePath: string, seed: string): void {
  const legacy = new Database(databasePath);
  legacy.exec(`
    CREATE TABLE projects (
      project_id TEXT PRIMARY KEY NOT NULL,
      project_path TEXT NOT NULL UNIQUE,
      custom_project_name TEXT DEFAULT NULL,
      isStarred BOOLEAN DEFAULT 0,
      isArchived BOOLEAN DEFAULT 0
    );
    CREATE TABLE sessions (
      session_id TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'claude',
      provider_session_id TEXT,
      custom_name TEXT,
      project_path TEXT,
      jsonl_path TEXT,
      model TEXT,
      effort TEXT,
      isArchived BOOLEAN DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      claude_profile_id TEXT,
      runtime_node_id TEXT,
      PRIMARY KEY (session_id),
      FOREIGN KEY (project_path) REFERENCES projects(project_path) ON DELETE SET NULL ON UPDATE CASCADE
    );
    CREATE TABLE runtime_nodes (
      node_id TEXT PRIMARY KEY NOT NULL,
      label TEXT NOT NULL,
      is_local BOOLEAN NOT NULL DEFAULT 0,
      platform TEXT, arch TEXT, runtime_version TEXT, last_seen_at INTEGER, capabilities_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX idx_runtime_nodes_single_local ON runtime_nodes(is_local) WHERE is_local = 1;
    CREATE TABLE runtime_node_credentials (
      node_id TEXT PRIMARY KEY NOT NULL,
      public_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active',
      enrolled_at INTEGER NOT NULL,
      revoked_at INTEGER,
      FOREIGN KEY (node_id) REFERENCES runtime_nodes(node_id) ON DELETE CASCADE
    );
    CREATE TABLE runtime_node_workspaces (
      node_id TEXT NOT NULL,
      project_path TEXT NOT NULL,
      node_path TEXT NOT NULL,
      status TEXT NOT NULL,
      reason TEXT,
      verified_at INTEGER NOT NULL,
      PRIMARY KEY (node_id, project_path),
      FOREIGN KEY (node_id) REFERENCES runtime_nodes(node_id) ON DELETE CASCADE
    );
    ${seed}
  `);
  legacy.close();
}

const NODES_SEED = `
  INSERT INTO runtime_nodes (node_id, label, is_local, platform, arch) VALUES ('pc-node', 'Windows PC', 1, 'win32', 'x64');
  INSERT INTO runtime_nodes (node_id, label, is_local, platform, arch) VALUES ('pixel-node', 'Pixel', 0, 'linux', 'arm64');
  INSERT INTO runtime_nodes (node_id, label, is_local, platform, arch) VALUES ('nas-node', 'NAS', 0, 'linux', 'x64');
  INSERT INTO runtime_node_credentials (node_id, public_key, status, enrolled_at) VALUES ('pixel-node', 'pixel-public-key', 'active', ${VERIFIED_AT});
  INSERT INTO runtime_node_credentials (node_id, public_key, status, enrolled_at) VALUES ('nas-node', 'nas-public-key', 'active', ${VERIFIED_AT});
`;

async function initializeQuietly(): Promise<string[]> {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => logs.push(values.join(' '));
  try {
    await initializeDatabase();
  } finally {
    console.log = originalLog;
  }
  return logs;
}

const columnsOf = (tableName: string): string[] =>
  (getConnection().prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>).map((column) => column.name);

const allMappings = () => getConnection()
  .prepare('SELECT node_id, project_id, node_path, status, reason, verified_at, git_root_commits FROM runtime_node_workspaces ORDER BY node_id, project_id')
  .all();

test('a fresh database keys workspace mappings by project id, with no control-plane path column', { concurrency: false }, async () => {
  await withDatabasePath(async () => {
    await initializeQuietly();
    assert.deepEqual(columnsOf('runtime_node_workspaces'), ['node_id', 'project_id', 'node_path', 'status', 'reason', 'verified_at', 'git_root_commits']);
  });
});

test('the HC-05 shape: local node, enrolled Pixel, its mapping and a session bound to it all survive the re-key', { concurrency: false }, async () => {
  await withDatabasePath(async (databasePath) => {
    createFtM08Database(databasePath, `
      ${NODES_SEED}
      INSERT INTO projects (project_id, project_path) VALUES ('project-cloudcli', 'D:\\Claude\\PROJET CLOUDCLI V2\\claudecodeui');
      INSERT INTO sessions (session_id, provider, provider_session_id, project_path, runtime_node_id)
        VALUES ('session-on-pixel', 'claude', 'native-1', 'D:\\Claude\\PROJET CLOUDCLI V2\\claudecodeui', 'pixel-node');
      INSERT INTO runtime_node_workspaces VALUES ('pixel-node', 'D:\\Claude\\PROJET CLOUDCLI V2\\claudecodeui', '/root/cloudcli-workspaces/claudecodeui-ftm08', 'verified', NULL, ${VERIFIED_AT});
    `);

    const logs = await initializeQuietly();
    assert.ok(logs.some((line) => /Re-keying runtime_node_workspaces by project_id/.test(line)));
    assert.equal(logs.some((line) => /no longer exists/.test(line)), false, 'nothing was dropped');
    assert.equal(columnsOf('runtime_node_workspaces').includes('project_path'), false);
    assert.deepEqual(runtimeNodeWorkspacesDb.get('pixel-node', 'project-cloudcli'), {
      nodeId: 'pixel-node',
      projectId: 'project-cloudcli',
      nodePath: '/root/cloudcli-workspaces/claudecodeui-ftm08',
      status: 'verified',
      reason: null,
      verifiedAt: VERIFIED_AT,
      gitRootCommits: null,
    });
    const session = sessionsDb.getSessionById('session-on-pixel');
    assert.deepEqual([session?.runtime_node_id, session?.provider_session_id], ['pixel-node', 'native-1'], 'session bindings are untouched');
    assert.equal(runtimeNodeCredentialsDb.getByNodeId('pixel-node')?.status, 'active', 'credentials are untouched');
  });
});

test('several projects and nodes: every mapping lands on its own project, none crosses and none duplicates', { concurrency: false }, async () => {
  await withDatabasePath(async (databasePath) => {
    createFtM08Database(databasePath, `
      ${NODES_SEED}
      INSERT INTO projects (project_id, project_path) VALUES ('project-app', '/work/app');
      INSERT INTO projects (project_id, project_path) VALUES ('project-app-2', '/work/app-2');
      INSERT INTO projects (project_id, project_path) VALUES ('project-app-sub', '/work/app/sub');
      INSERT INTO runtime_node_workspaces VALUES ('pixel-node', '/work/app', '/root/ws/app', 'verified', NULL, ${VERIFIED_AT});
      INSERT INTO runtime_node_workspaces VALUES ('pixel-node', '/work/app-2', '/root/ws/app-2', 'unavailable', 'rejected_by_node', ${VERIFIED_AT + 1});
      INSERT INTO runtime_node_workspaces VALUES ('nas-node', '/work/app', '/volume1/code/app', 'verified', NULL, ${VERIFIED_AT + 2});
      INSERT INTO runtime_node_workspaces VALUES ('nas-node', '/work/app/sub', '/volume1/code/app-sub', 'verified', NULL, ${VERIFIED_AT + 3});
    `);

    await initializeQuietly();
    assert.deepEqual(allMappings(), [
      { node_id: 'nas-node', project_id: 'project-app', node_path: '/volume1/code/app', status: 'verified', reason: null, verified_at: VERIFIED_AT + 2, git_root_commits: null },
      { node_id: 'nas-node', project_id: 'project-app-sub', node_path: '/volume1/code/app-sub', status: 'verified', reason: null, verified_at: VERIFIED_AT + 3, git_root_commits: null },
      { node_id: 'pixel-node', project_id: 'project-app', node_path: '/root/ws/app', status: 'verified', reason: null, verified_at: VERIFIED_AT, git_root_commits: null },
      { node_id: 'pixel-node', project_id: 'project-app-2', node_path: '/root/ws/app-2', status: 'unavailable', reason: 'rejected_by_node', verified_at: VERIFIED_AT + 1, git_root_commits: null },
    ]);
    assert.equal(runtimeNodeWorkspacesDb.get('nas-node', 'project-app-2'), null, 'no mapping is invented for a project a node never mapped');
    assert.throws(
      () => getConnection().prepare("INSERT INTO runtime_node_workspaces (node_id, project_id, node_path, status, verified_at) VALUES ('pixel-node', 'project-app', '/elsewhere', 'verified', 1)").run(),
      /UNIQUE|PRIMARY KEY/,
      'one mapping per node and project',
    );
  });
});

test('orphans are dropped explicitly: a deleted project, and a project moved on this machine before the upgrade, must be mapped again', { concurrency: false }, async () => {
  await withDatabasePath(async (databasePath) => {
    createFtM08Database(databasePath, `
      ${NODES_SEED}
      INSERT INTO projects (project_id, project_path) VALUES ('project-kept', '/work/kept');
      INSERT INTO projects (project_id, project_path) VALUES ('project-moved', '/work/new-location');
      INSERT INTO runtime_node_workspaces VALUES ('pixel-node', '/work/kept', '/root/ws/kept', 'verified', NULL, ${VERIFIED_AT});
      INSERT INTO runtime_node_workspaces VALUES ('pixel-node', '/work/deleted', '/root/ws/deleted', 'verified', NULL, ${VERIFIED_AT});
      INSERT INTO runtime_node_workspaces VALUES ('nas-node', '/work/old-location', '/volume1/code/moved', 'verified', NULL, ${VERIFIED_AT});
    `);

    const logs = await initializeQuietly();
    assert.ok(logs.some((line) => /2 workspace mapping\(s\) named a project that no longer exists and were not carried over/.test(line)));
    assert.deepEqual((allMappings() as Array<{ project_id: string }>).map((row) => row.project_id), ['project-kept']);
    assert.equal(runtimeNodeWorkspacesDb.listByProject('project-moved').length, 0, 'a path-keyed row cannot follow a move that happened before the upgrade');
  });
});

test('after the re-key, moving this machine\'s copy keeps every mapping; re-running migrations changes nothing', { concurrency: false }, async () => {
  await withDatabasePath(async (databasePath) => {
    createFtM08Database(databasePath, `
      ${NODES_SEED}
      INSERT INTO projects (project_id, project_path) VALUES ('project-app', '/work/app');
      INSERT INTO runtime_node_workspaces VALUES ('pixel-node', '/work/app', '/root/ws/app', 'verified', NULL, ${VERIFIED_AT});
      INSERT INTO runtime_node_workspaces VALUES ('nas-node', '/work/app', '/volume1/code/app', 'verified', NULL, ${VERIFIED_AT});
    `);
    await initializeQuietly();
    const migrated = allMappings();

    getConnection().prepare("UPDATE projects SET project_path = '/work/renamed-app' WHERE project_id = 'project-app'").run();
    assert.deepEqual(
      getConnection().prepare("SELECT project_path FROM projects WHERE project_id = 'project-app'").get(),
      { project_path: '/work/renamed-app' },
    );
    assert.deepEqual(allMappings(), migrated, 'mappings follow the project id, not the path');

    for (let run = 0; run < 2; run += 1) {
      closeConnection();
      const logs = await initializeQuietly();
      assert.equal(logs.some((line) => /Re-keying/.test(line)), false, 'the re-key runs once');
      assert.deepEqual(allMappings(), migrated);
    }
  });
});

test('deleting a project or a node removes exactly its mappings', { concurrency: false }, async () => {
  await withDatabasePath(async (databasePath) => {
    createFtM08Database(databasePath, `
      ${NODES_SEED}
      INSERT INTO projects (project_id, project_path) VALUES ('project-a', '/work/a');
      INSERT INTO projects (project_id, project_path) VALUES ('project-b', '/work/b');
      INSERT INTO runtime_node_workspaces VALUES ('pixel-node', '/work/a', '/root/ws/a', 'verified', NULL, ${VERIFIED_AT});
      INSERT INTO runtime_node_workspaces VALUES ('pixel-node', '/work/b', '/root/ws/b', 'verified', NULL, ${VERIFIED_AT});
      INSERT INTO runtime_node_workspaces VALUES ('nas-node', '/work/a', '/volume1/a', 'verified', NULL, ${VERIFIED_AT});
    `);
    await initializeQuietly();

    projectsDb.deleteProjectById('project-a');
    assert.deepEqual((allMappings() as Array<{ node_id: string; project_id: string }>).map((row) => `${row.node_id}/${row.project_id}`), ['pixel-node/project-b']);

    getConnection().prepare("DELETE FROM runtime_nodes WHERE node_id = 'pixel-node'").run();
    assert.deepEqual(allMappings(), []);
  });
});

test('a migration that fails part-way rolls back: the FT-M08 table and its rows are left exactly as they were', { concurrency: false }, async () => {
  await withDatabasePath(async (databasePath) => {
    createFtM08Database(databasePath, `
      ${NODES_SEED}
      INSERT INTO projects (project_id, project_path) VALUES ('project-app', '/work/app');
      INSERT INTO runtime_node_workspaces VALUES ('pixel-node', '/work/app', '/root/ws/app', 'verified', NULL, ${VERIFIED_AT});
      -- Deterministic failure injection: once the old table is dropped, renaming the new one
      -- re-validates the schema and this view (which needs project_path) no longer resolves.
      CREATE VIEW legacy_workspace_report AS SELECT node_id, project_path FROM runtime_node_workspaces;
    `);

    const originalError = console.error;
    console.error = () => undefined;
    try {
      await assert.rejects(() => initializeQuietly());
    } finally {
      console.error = originalError;
    }
    closeConnection();

    const raw = new Database(databasePath, { readonly: true });
    try {
      const columns = (raw.prepare('PRAGMA table_info(runtime_node_workspaces)').all() as Array<{ name: string }>).map((column) => column.name);
      assert.deepEqual(columns, ['node_id', 'project_path', 'node_path', 'status', 'reason', 'verified_at']);
      assert.deepEqual(raw.prepare('SELECT node_id, project_path, node_path FROM runtime_node_workspaces').all(), [
        { node_id: 'pixel-node', project_path: '/work/app', node_path: '/root/ws/app' },
      ]);
      assert.equal(raw.prepare("SELECT name FROM sqlite_master WHERE name = 'runtime_node_workspaces__new'").get(), undefined, 'no half-built table is left');
    } finally {
      raw.close();
    }
  });
});
