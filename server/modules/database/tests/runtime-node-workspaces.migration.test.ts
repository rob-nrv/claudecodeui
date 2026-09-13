import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { closeConnection, getConnection, initializeDatabase, runtimeNodeWorkspacesDb } from '@/modules/database/index.js';

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

const columnsOf = (tableName: string): string[] =>
  (getConnection().prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>).map((column) => column.name);

test('a fresh database keys workspace mappings by project id, with no control-plane path column', { concurrency: false }, async () => {
  await withDatabasePath(async () => {
    await initializeDatabase();
    assert.deepEqual(columnsOf('runtime_node_workspaces'), ['node_id', 'project_id', 'node_path', 'status', 'reason', 'verified_at', 'git_root_commits']);
  });
});

test('FT-M08 path-keyed mappings are carried over to the project id; orphans are dropped; re-running changes nothing', { concurrency: false }, async () => {
  await withDatabasePath(async (databasePath) => {
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE projects (
        project_id TEXT PRIMARY KEY NOT NULL,
        project_path TEXT NOT NULL UNIQUE,
        custom_project_name TEXT DEFAULT NULL,
        isStarred BOOLEAN DEFAULT 0,
        isArchived BOOLEAN DEFAULT 0
      );
      CREATE TABLE runtime_nodes (
        node_id TEXT PRIMARY KEY NOT NULL,
        label TEXT NOT NULL,
        is_local BOOLEAN NOT NULL DEFAULT 0,
        platform TEXT, arch TEXT, runtime_version TEXT, last_seen_at INTEGER, capabilities_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
      INSERT INTO projects (project_id, project_path) VALUES ('project-1', 'D:\\Claude\\app');
      INSERT INTO runtime_nodes (node_id, label, is_local) VALUES ('pixel-node', 'Pixel', 0);
      INSERT INTO runtime_node_workspaces VALUES ('pixel-node', 'D:\\Claude\\app', '/root/cloudcli-workspaces/app', 'verified', NULL, 1757764800000);
      INSERT INTO runtime_node_workspaces VALUES ('pixel-node', 'D:\\Claude\\deleted', '/root/cloudcli-workspaces/old', 'verified', NULL, 1757764800000);
    `);
    legacy.close();

    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (...values: unknown[]) => logs.push(values.join(' '));
    try {
      await initializeDatabase();
    } finally {
      console.log = originalLog;
    }

    assert.equal(columnsOf('runtime_node_workspaces').includes('project_path'), false);
    assert.deepEqual(runtimeNodeWorkspacesDb.get('pixel-node', 'project-1'), {
      nodeId: 'pixel-node',
      projectId: 'project-1',
      nodePath: '/root/cloudcli-workspaces/app',
      status: 'verified',
      reason: null,
      verifiedAt: 1757764800000,
      gitRootCommits: null,
    });
    assert.equal((getConnection().prepare('SELECT COUNT(*) AS count FROM runtime_node_workspaces').get() as { count: number }).count, 1);
    assert.ok(logs.some((line) => /1 workspace mapping\(s\) named a project that no longer exists/.test(line)));

    closeConnection();
    await initializeDatabase();
    assert.equal(runtimeNodeWorkspacesDb.listByProject('project-1').length, 1);
  });
});
