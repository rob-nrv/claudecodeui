import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { sessionHandoffsDb } from '@/modules/database/repositories/session-handoffs.db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';

async function withIsolatedDatabase(runTest: (databasePath: string) => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'session-handoffs-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await writeFile(databasePath, '');
  await initializeDatabase();

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

const baseInput = {
  handoffId: 'handoff-1',
  targetSessionId: 'target-1',
  targetProvider: 'claude',
  targetClaudeProfileId: 'profile-personal',
  targetName: '↪ Fix login',
  projectPath: '/workspace/demo',
  sourceSessionId: 'source-1',
  taskRootSessionId: 'source-1',
  sourceProvider: 'claude',
  sourceClaudeProfileId: 'profile-work',
  sourceProviderSessionId: 'native-source',
  sourceModel: 'claude-opus-5',
  sourceEffort: 'high',
  sourceTitle: 'Fix login',
  handoffPackage: 'Handoff package',
};

function seedSource(): void {
  sessionsDb.createAppSession('source-1', 'claude', '/workspace/demo', 'Fix login', 'profile-work');
  sessionsDb.assignProviderSessionId('source-1', 'native-source');
}

test('creating a handoff target writes the new session and its lineage together', async () => {
  await withIsolatedDatabase(() => {
    seedSource();
    sessionHandoffsDb.createTargetSession(baseInput);

    const target = sessionsDb.getSessionById('target-1');
    assert.equal(target?.claude_profile_id, 'profile-personal');
    assert.equal(target?.provider_session_id, null);
    assert.equal(target?.custom_name, '↪ Fix login');

    const incoming = sessionHandoffsDb.getByTargetSessionId('target-1');
    assert.equal(incoming?.source_session_id, 'source-1');
    assert.equal(incoming?.source_claude_profile_id, 'profile-work');
    assert.equal(incoming?.source_provider_session_id, 'native-source');
    assert.deepEqual(
      sessionHandoffsDb.listBySourceSessionId('source-1').map((row) => row.target_session_id),
      ['target-1'],
    );
  });
});

test('a failed lineage insert leaves no target session behind', async () => {
  await withIsolatedDatabase(() => {
    seedSource();
    sessionHandoffsDb.createTargetSession(baseInput);

    // Same handoff id: the lineage insert violates its primary key after the
    // session insert already ran inside the transaction.
    assert.throws(() => sessionHandoffsDb.createTargetSession({ ...baseInput, targetSessionId: 'target-2' }));

    assert.equal(sessionsDb.getSessionById('target-2'), null);
    assert.equal(sessionsDb.getSessionById('source-1')?.claude_profile_id, 'profile-work');
    assert.equal(sessionHandoffsDb.listBySourceSessionId('source-1').length, 1);
  });
});

test('lineage outlives the source session but not the target session', async () => {
  await withIsolatedDatabase(() => {
    seedSource();
    sessionHandoffsDb.createTargetSession(baseInput);

    sessionsDb.deleteSessionById('source-1');
    assert.equal(sessionHandoffsDb.getByTargetSessionId('target-1')?.source_title, 'Fix login');

    sessionsDb.deleteSessionById('target-1');
    assert.equal(sessionHandoffsDb.getByTargetSessionId('target-1'), null);
  });
});

test('lineage is still there after the database connection is reopened', async () => {
  await withIsolatedDatabase(async () => {
    seedSource();
    sessionHandoffsDb.createTargetSession(baseInput);

    closeConnection();
    await initializeDatabase();

    assert.equal(sessionHandoffsDb.getByTargetSessionId('target-1')?.task_root_session_id, 'source-1');
    // The startup provider-id backfill must not turn an unsent target into a
    // "started" run resuming a native session that does not exist.
    assert.equal(sessionsDb.getSessionById('target-1')?.provider_session_id, null);
    assert.equal(sessionsDb.getSessionById('source-1')?.provider_session_id, 'native-source');
    assert.equal(getConnection().prepare('PRAGMA foreign_keys').pluck().get(), 1);
  });
});

test('a pending handoff target is never claimed as some other pending provider session', async () => {
  await withIsolatedDatabase(() => {
    seedSource();
    sessionHandoffsDb.createTargetSession({ ...baseInput, targetProvider: 'opencode', targetClaudeProfileId: null });

    assert.equal(sessionsDb.findLatestPendingAppSession('opencode', '/workspace/demo'), null);

    sessionsDb.createAppSession('composer-pending', 'opencode', '/workspace/demo', 'New chat');
    assert.equal(sessionsDb.findLatestPendingAppSession('opencode', '/workspace/demo')?.session_id, 'composer-pending');
  });
});
