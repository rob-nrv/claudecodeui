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
  runtimeNodesDb,
  sessionHandoffsDb,
  sessionsDb,
} from '@/modules/database/index.js';

async function withDatabasePath(runTest: (databasePath: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'runtime-nodes-migration-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

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
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

const columnsOf = (tableName: string): string[] =>
  (getConnection().prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>).map((column) => column.name);

test('a fresh database gets the runtime_nodes table and runtime binding columns', { concurrency: false }, async () => {
  await withDatabasePath(async () => {
    await initializeDatabase();

    assert.ok(columnsOf('sessions').includes('runtime_node_id'));
    assert.ok(columnsOf('session_handoffs').includes('source_runtime_node_id'));
    assert.ok(columnsOf('session_handoffs').includes('target_runtime_node_id'));
    assert.deepEqual(columnsOf('runtime_nodes'), [
      'node_id',
      'label',
      'is_local',
      'platform',
      'arch',
      'runtime_version',
      'last_seen_at',
      'capabilities_json',
      'created_at',
      'updated_at',
    ]);
    // Registering is a service concern: a migration never invents a node.
    assert.equal(runtimeNodesDb.count(), 0);
  });
});

test('at most one local node can exist', { concurrency: false }, async () => {
  await withDatabasePath(async () => {
    await initializeDatabase();
    const db = getConnection();
    db.prepare("INSERT INTO runtime_nodes (node_id, label, is_local) VALUES ('local-a', 'A', 1)").run();
    assert.throws(() => db.prepare("INSERT INTO runtime_nodes (node_id, label, is_local) VALUES ('local-b', 'B', 1)").run());
    db.prepare("INSERT INTO runtime_nodes (node_id, label, is_local) VALUES ('remote-a', 'Remote', 0)").run();
    db.prepare("INSERT INTO runtime_nodes (node_id, label, is_local) VALUES ('remote-b', 'Remote 2', 0)").run();
    assert.equal(runtimeNodesDb.count(), 3);
  });
});

test('an upgraded pre-FT-M07 database keeps its sessions and handoffs, with runtime provenance left unrecorded', { concurrency: false }, async () => {
  await withDatabasePath(async (databasePath) => {
    // Build the exact pre-FT-M07 shape of the tables this migration touches.
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
        FOREIGN KEY (target_session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      );
      INSERT INTO projects (project_id, project_path) VALUES ('p1', '/workspace/app');
      INSERT INTO sessions (session_id, provider, provider_session_id, custom_name, project_path, claude_profile_id)
        VALUES ('legacy-source', 'claude', 'native-1', 'Old work', '/workspace/app', 'profile-work');
      INSERT INTO sessions (session_id, provider, custom_name, project_path, claude_profile_id)
        VALUES ('legacy-target', 'claude', 'Old handoff', '/workspace/app', 'profile-personal');
      INSERT INTO session_handoffs (handoff_id, target_session_id, source_session_id, task_root_session_id, source_provider, target_provider, handoff_package)
        VALUES ('h1', 'legacy-target', 'legacy-source', 'legacy-source', 'claude', 'claude', 'package');
    `);
    legacy.close();

    await initializeDatabase();

    const source = sessionsDb.getSessionById('legacy-source');
    assert.equal(source?.custom_name, 'Old work');
    assert.equal(source?.claude_profile_id, 'profile-work', 'provider bindings are never rewritten');
    assert.equal(source?.provider_session_id, 'native-1');
    assert.equal(source?.runtime_node_id, null, 'today\'s machine is never stamped onto historical runs');
    assert.equal(sessionsDb.getSessionById('legacy-target')?.runtime_node_id, null);

    const handoff = sessionHandoffsDb.getByTargetSessionId('legacy-target');
    assert.equal(handoff?.source_runtime_node_id, null);
    assert.equal(handoff?.target_runtime_node_id, null);
    assert.equal(handoff?.handoff_package, 'package');

    // Running the migrations again on the upgraded database changes nothing.
    closeConnection();
    await initializeDatabase();
    assert.equal(sessionsDb.getSessionById('legacy-source')?.runtime_node_id, null);
    assert.equal(sessionHandoffsDb.getByTargetSessionId('legacy-target')?.target_runtime_node_id, null);
    assert.equal(runtimeNodesDb.count(), 0);
  });
});
