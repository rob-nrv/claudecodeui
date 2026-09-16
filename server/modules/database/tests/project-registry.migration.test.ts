// FT-M09 -> FT-M10 migration (Project Registry): projects may exist without a
// control-plane copy, sessions reference their project by id. Fixtures
// reproduce the schema a real control plane has after HC-06, in temporary
// databases only.
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
  runtimeNodeWorkspacesDb,
  sessionsDb,
} from '@/modules/database/index.js';

const VERIFIED_AT = 1757764800000;
const ROOT_A = 'a'.repeat(40);

async function withDatabasePath(runTest: (databasePath: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'project-registry-migration-'));
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

/** The FT-M09 (HC-06) shape of every table this migration reads or must leave intact, plus seed rows. */
function createFtM09Database(databasePath: string, seed: string): void {
  const legacy = new Database(databasePath);
  try {
    // Seeded like a long-lived install: legacy rows (a blank folder) predate enforced foreign keys.
    legacy.exec(`
    PRAGMA foreign_keys = OFF;
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
      custom_name TEXT,
      project_path TEXT,
      jsonl_path TEXT,
      isArchived BOOLEAN DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      provider_session_id TEXT,
      model TEXT,
      effort TEXT,
      claude_profile_id TEXT,
      runtime_node_id TEXT,
      PRIMARY KEY (session_id),
      FOREIGN KEY (project_path) REFERENCES projects(project_path) ON DELETE SET NULL ON UPDATE CASCADE
    );
    CREATE TABLE session_handoffs (
      handoff_id TEXT PRIMARY KEY NOT NULL,
      target_session_id TEXT NOT NULL UNIQUE,
      source_session_id TEXT NOT NULL,
      task_root_session_id TEXT NOT NULL,
      source_provider TEXT NOT NULL,
      source_claude_profile_id TEXT,
      source_provider_session_id TEXT,
      source_model TEXT,
      source_effort TEXT,
      source_title TEXT,
      target_provider TEXT NOT NULL,
      target_claude_profile_id TEXT,
      handoff_package TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      source_runtime_node_id TEXT,
      target_runtime_node_id TEXT,
      FOREIGN KEY (target_session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );
    CREATE TABLE queued_messages (
      session_id TEXT PRIMARY KEY NOT NULL,
      content TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
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
      project_id TEXT NOT NULL,
      node_path TEXT NOT NULL,
      status TEXT NOT NULL,
      reason TEXT,
      verified_at INTEGER NOT NULL,
      git_root_commits TEXT,
      PRIMARY KEY (node_id, project_id),
      FOREIGN KEY (node_id) REFERENCES runtime_nodes(node_id) ON DELETE CASCADE,
      FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE
    );
    ${seed}
  `);
  } finally {
    legacy.close();
  }
}

/** A control plane after HC-06: a local PC, an enrolled Pixel, projects, runs local and remote, a handoff, a queued message. */
const HC06_SEED = `
  INSERT INTO runtime_nodes (node_id, label, is_local, platform, arch) VALUES ('pc-node', 'Windows PC', 1, 'win32', 'x64');
  INSERT INTO runtime_nodes (node_id, label, is_local, platform, arch) VALUES ('pixel-node', 'Pixel', 0, 'linux', 'arm64');
  INSERT INTO runtime_node_credentials (node_id, public_key, status, enrolled_at) VALUES ('pixel-node', 'pixel-public-key', 'active', ${VERIFIED_AT});
  INSERT INTO projects (project_id, project_path, custom_project_name, isStarred, isArchived) VALUES ('project-cloudcli', 'D:\\Claude\\PROJET CLOUDCLI V2\\claudecodeui', 'CloudCLI', 1, 0);
  INSERT INTO projects (project_id, project_path, custom_project_name, isStarred, isArchived) VALUES ('project-app', '/work/app', NULL, 0, 0);
  INSERT INTO projects (project_id, project_path, custom_project_name, isStarred, isArchived) VALUES ('project-app-sub', '/work/app/sub', NULL, 0, 1);
  INSERT INTO sessions (session_id, provider, custom_name, project_path, jsonl_path, isArchived, created_at, updated_at, provider_session_id, model, effort, claude_profile_id, runtime_node_id)
    VALUES ('session-local', 'claude', 'Local run', 'D:\\Claude\\PROJET CLOUDCLI V2\\claudecodeui', 'C:\\Users\\me\\.claude\\projects\\x\\native-local.jsonl', 0, '2026-09-10 10:00:00', '2026-09-10 11:00:00', 'native-local', 'claude-opus-5', 'high', 'work', 'pc-node');
  INSERT INTO sessions (session_id, provider, custom_name, project_path, isArchived, created_at, updated_at, provider_session_id, runtime_node_id)
    VALUES ('session-on-pixel', 'claude', 'On Pixel', 'D:\\Claude\\PROJET CLOUDCLI V2\\claudecodeui', 0, '2026-09-14 10:00:00', '2026-09-14 11:00:00', 'native-pixel', 'pixel-node');
  INSERT INTO sessions (session_id, provider, custom_name, project_path, isArchived, created_at, updated_at, provider_session_id)
    VALUES ('session-app', 'codex', NULL, '/work/app', 1, '2026-09-01 10:00:00', '2026-09-01 10:00:00', 'native-app');
  INSERT INTO sessions (session_id, provider, custom_name, project_path, isArchived, created_at, updated_at, provider_session_id)
    VALUES ('session-app-sub', 'claude', NULL, '/work/app/sub', 0, '2026-09-02 10:00:00', '2026-09-02 10:00:00', 'native-sub');
  INSERT INTO sessions (session_id, provider, custom_name, project_path, isArchived, created_at, updated_at, provider_session_id)
    VALUES ('session-no-path', 'claude', 'Legacy without folder', NULL, 0, '2026-08-01 10:00:00', '2026-08-01 10:00:00', 'native-no-path');
  INSERT INTO sessions (session_id, provider, custom_name, project_path, isArchived, created_at, updated_at, provider_session_id)
    VALUES ('session-blank-path', 'claude', NULL, '   ', 0, '2026-08-01 10:00:00', '2026-08-01 10:00:00', 'native-blank');
  INSERT INTO sessions (session_id, provider, custom_name, project_path, isArchived, created_at, updated_at, provider_session_id, runtime_node_id)
    VALUES ('session-handoff-target', 'claude', '↪ On Pixel', 'D:\\Claude\\PROJET CLOUDCLI V2\\claudecodeui', 0, '2026-09-15 10:00:00', '2026-09-15 10:00:00', NULL, 'pc-node');
  INSERT INTO session_handoffs (handoff_id, target_session_id, source_session_id, task_root_session_id, source_provider, source_provider_session_id, source_title, target_provider, handoff_package, source_runtime_node_id, target_runtime_node_id)
    VALUES ('handoff-1', 'session-handoff-target', 'session-on-pixel', 'session-on-pixel', 'claude', 'native-pixel', 'On Pixel', 'claude', '{"v":1}', 'pixel-node', 'pc-node');
  INSERT INTO queued_messages (session_id, content, updated_at) VALUES ('session-local', '{"content":"next"}', '2026-09-10 11:00:00');
  INSERT INTO runtime_node_workspaces VALUES ('pixel-node', 'project-cloudcli', '/root/cloudcli-workspaces/claudecodeui', 'verified', NULL, ${VERIFIED_AT}, '${ROOT_A}');
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

type ColumnInfo = { name: string; notnull: number };
const columnsOf = (tableName: string): ColumnInfo[] =>
  getConnection().prepare(`PRAGMA table_info(${tableName})`).all() as ColumnInfo[];

const projectRows = () => getConnection()
  .prepare('SELECT project_id, project_path, custom_project_name, isStarred, isArchived FROM projects ORDER BY project_id')
  .all();
const sessionRowsWithoutProjectId = () => getConnection()
  .prepare(`SELECT session_id, provider, custom_name, project_path, jsonl_path, isArchived, created_at, updated_at,
                   provider_session_id, model, effort, claude_profile_id, runtime_node_id
            FROM sessions ORDER BY session_id`)
  .all();
const sessionProjectIds = () => Object.fromEntries(
  (getConnection().prepare('SELECT session_id, project_id FROM sessions ORDER BY session_id').all() as Array<{ session_id: string; project_id: string | null }>)
    .map((row) => [row.session_id, row.project_id]),
);
const untouchedTables = () => ({
  handoffs: getConnection().prepare('SELECT * FROM session_handoffs ORDER BY handoff_id').all(),
  queued: getConnection().prepare('SELECT * FROM queued_messages ORDER BY session_id').all(),
  mappings: getConnection().prepare('SELECT * FROM runtime_node_workspaces ORDER BY node_id, project_id').all(),
  nodes: getConnection().prepare('SELECT node_id, label, is_local FROM runtime_nodes ORDER BY node_id').all(),
  credentials: getConnection().prepare('SELECT * FROM runtime_node_credentials ORDER BY node_id').all(),
});

function snapshotLegacy(databasePath: string) {
  const legacy = new Database(databasePath, { readonly: true });
  try {
    return {
      projects: legacy.prepare('SELECT project_id, project_path, custom_project_name, isStarred, isArchived FROM projects ORDER BY project_id').all(),
      sessions: legacy.prepare(`SELECT session_id, provider, custom_name, project_path, jsonl_path, isArchived, created_at, updated_at,
                                       provider_session_id, model, effort, claude_profile_id, runtime_node_id
                                FROM sessions ORDER BY session_id`).all(),
      handoffs: legacy.prepare('SELECT * FROM session_handoffs ORDER BY handoff_id').all(),
      queued: legacy.prepare('SELECT * FROM queued_messages ORDER BY session_id').all(),
      mappings: legacy.prepare('SELECT * FROM runtime_node_workspaces ORDER BY node_id, project_id').all(),
      nodes: legacy.prepare('SELECT node_id, label, is_local FROM runtime_nodes ORDER BY node_id').all(),
      credentials: legacy.prepare('SELECT * FROM runtime_node_credentials ORDER BY node_id').all(),
    };
  } finally {
    legacy.close();
  }
}

test('a fresh database: project_path is nullable, checkpoint reference columns exist and sessions carry project_id', { concurrency: false }, async () => {
  await withDatabasePath(async () => {
    await initializeQuietly();
    const projectColumns = columnsOf('projects');
    assert.equal(projectColumns.find((column) => column.name === 'project_path')?.notnull, 0);
    for (const column of ['latest_checkpoint_snapshot_id', 'latest_checkpoint_changes_digest', 'latest_checkpoint_head_commit', 'latest_checkpoint_node_id', 'latest_checkpoint_at']) {
      assert.ok(projectColumns.some((entry) => entry.name === column), `${column} exists`);
    }
    assert.ok(columnsOf('sessions').some((column) => column.name === 'project_id'));
    const foreignKeys = getConnection().prepare('PRAGMA foreign_key_list(sessions)').all() as Array<{ table: string; from: string; to: string }>;
    assert.ok(foreignKeys.some((key) => key.from === 'project_id' && key.table === 'projects' && key.to === 'project_id'));
    assert.ok((getConnection().prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_sessions_project_id'").get()));

    const created = projectsDb.createProjectWithoutControlPlaneCopy('Hosted only');
    assert.equal(created.project_path, null);
    assert.throws(
      () => getConnection().prepare("INSERT INTO projects (project_id, project_path, custom_project_name) VALUES ('nameless', NULL, '  ')").run(),
      /CHECK/,
      'a project without a copy here must carry its own name',
    );
  });
});

test('the HC-06 shape: every project, session, handoff, queued message, mapping and credential survives; sessions gain the project that owns their exact path', { concurrency: false }, async (t) => {
  await withDatabasePath(async (databasePath) => {
    createFtM09Database(databasePath, HC06_SEED);
    const before = snapshotLegacy(databasePath);

    const logs = await initializeQuietly();
    assert.ok(logs.some((line) => /Allowing projects without a control-plane copy/.test(line)));
    assert.equal(columnsOf('projects').find((column) => column.name === 'project_path')?.notnull, 0);

    assert.deepEqual(projectRows(), before.projects, 'the same projects: ids, paths, names and flags unchanged, none added');
    assert.deepEqual(sessionRowsWithoutProjectId(), before.sessions, 'every session column except the new one is unchanged');
    assert.deepEqual(untouchedTables(), {
      handoffs: before.handoffs,
      queued: before.queued,
      mappings: before.mappings,
      nodes: before.nodes,
      credentials: before.credentials,
    });

    await t.test('project_id is backfilled only from an exact path match', () => {
      const scoped = sessionProjectIds();
      assert.equal(scoped['session-local'], 'project-cloudcli');
      assert.equal(scoped['session-on-pixel'], 'project-cloudcli');
      assert.equal(scoped['session-handoff-target'], 'project-cloudcli');
      assert.equal(scoped['session-app'], 'project-app');
      assert.equal(scoped['session-app-sub'], 'project-app-sub', 'a nested folder is its own project, never its parent');
      assert.equal(scoped['session-no-path'], null, 'no folder recorded: no project is invented');
      assert.equal(scoped['session-blank-path'], null, 'a blank folder names no project');
    });

    await t.test('project-scoped readers list exactly the migrated sessions, archived ones included where asked', () => {
      assert.deepEqual(sessionsDb.getSessionsByProjectIdIncludingArchived('project-cloudcli').map((row) => row.session_id).sort(), ['session-handoff-target', 'session-local', 'session-on-pixel']);
      assert.equal(sessionsDb.countSessionsByProjectId('project-app'), 0, 'the archived session is not counted as active');
      assert.deepEqual(sessionsDb.getSessionsByProjectIdIncludingArchived('project-app').map((row) => row.session_id), ['session-app']);
    });

    await t.test('a mapping keeps its identity baseline', () => {
      assert.deepEqual(runtimeNodeWorkspacesDb.get('pixel-node', 'project-cloudcli')?.gitRootCommits, [ROOT_A]);
    });
  });
});

test('rerunning the migrations changes nothing, and an already scoped session is never re-scoped by its path', { concurrency: false }, async () => {
  await withDatabasePath(async (databasePath) => {
    createFtM09Database(databasePath, HC06_SEED);
    await initializeQuietly();

    // A session recorded under project-app whose folder now belongs to another project.
    getConnection().prepare("UPDATE sessions SET project_path = '/work/app/sub' WHERE session_id = 'session-app'").run();
    const projectsAfterFirst = projectRows();
    const sessionsAfterFirst = getConnection().prepare('SELECT * FROM sessions ORDER BY session_id').all();

    closeConnection();
    const logs = await initializeQuietly();
    assert.equal(logs.some((line) => /Allowing projects without a control-plane copy/.test(line)), false, 'no second rebuild');
    assert.equal(logs.some((line) => /Scoped \d+ session/.test(line)), false, 'nothing left to scope');
    assert.deepEqual(projectRows(), projectsAfterFirst);
    assert.deepEqual(getConnection().prepare('SELECT * FROM sessions ORDER BY session_id').all(), sessionsAfterFirst);
    assert.equal(sessionProjectIds()['session-app'], 'project-app');

    // The synchronizer re-indexing it under its new folder does not re-scope it either.
    sessionsDb.createSession('native-app', 'codex', '/work/app/sub');
    assert.equal(sessionsDb.getSessionById('session-app')?.project_id, 'project-app');
  });
});

test('a project without a control-plane copy survives restarts and keeps its sessions scoped by id', { concurrency: false }, async () => {
  await withDatabasePath(async (databasePath) => {
    createFtM09Database(databasePath, HC06_SEED);
    await initializeQuietly();
    const hosted = projectsDb.createProjectWithoutControlPlaneCopy('Pixel-only project');
    getConnection().prepare(`
      INSERT INTO sessions (session_id, provider, provider_session_id, project_id, project_path, runtime_node_id)
      VALUES ('session-pixel-only', 'claude', 'native-pixel-only', ?, NULL, 'pixel-node')
    `).run(hosted.project_id);

    closeConnection();
    await initializeQuietly();

    assert.equal(projectsDb.getProjectById(hosted.project_id)?.project_path, null);
    assert.equal(projectsDb.getProjectPaths().some((row) => row.project_id === hosted.project_id), false, 'path-based lists only name projects with a copy here');
    assert.deepEqual(sessionsDb.getSessionsByProjectIdIncludingArchived(hosted.project_id).map((row) => row.session_id), ['session-pixel-only']);
  });
});
