import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { queuedMessagesDb } from '@/modules/database/repositories/queued-messages.db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'queued-messages-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
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

test('save then get round-trips the opaque content blob', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('session-a', 'claude', '/workspace/demo');
    queuedMessagesDb.save('session-a', '{"content":"hello"}');

    const row = queuedMessagesDb.get('session-a');
    assert.equal(row?.content, '{"content":"hello"}');
  });
});

test('save overwrites a previous queued message for the same session (single-slot queue)', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('session-a', 'claude', '/workspace/demo');
    queuedMessagesDb.save('session-a', '{"content":"first"}');
    queuedMessagesDb.save('session-a', '{"content":"second"}');

    const row = queuedMessagesDb.get('session-a');
    assert.equal(row?.content, '{"content":"second"}');
  });
});

test('claim deletes the row only when the token matches and reports success once', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('session-a', 'claude', '/workspace/demo');
    queuedMessagesDb.save('session-a', '{"content":"hello"}');

    const staleClaim = queuedMessagesDb.claim('session-a', '{"content":"stale"}');
    assert.equal(staleClaim, false, 'a stale token must not claim the row');
    assert.ok(queuedMessagesDb.get('session-a'), 'row must still be present after a failed claim');

    const firstClaim = queuedMessagesDb.claim('session-a', '{"content":"hello"}');
    assert.equal(firstClaim, true);
    assert.equal(queuedMessagesDb.get('session-a'), null, 'row is gone once claimed');

    const secondClaim = queuedMessagesDb.claim('session-a', '{"content":"hello"}');
    assert.equal(secondClaim, false, 'a second claim of the same token must not double-claim');
  });
});

test('restore puts a claimed message back so it can be retried', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('session-a', 'claude', '/workspace/demo');
    queuedMessagesDb.save('session-a', '{"content":"hello"}');
    assert.equal(queuedMessagesDb.claim('session-a', '{"content":"hello"}'), true);

    queuedMessagesDb.restore('session-a', '{"content":"hello"}');

    const row = queuedMessagesDb.get('session-a');
    assert.equal(row?.content, '{"content":"hello"}');
  });
});

test('restore never clobbers a newer message queued after the claim', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('session-a', 'claude', '/workspace/demo');
    queuedMessagesDb.save('session-a', '{"content":"hello"}');
    assert.equal(queuedMessagesDb.claim('session-a', '{"content":"hello"}'), true);

    // The user queued a fresh message in the gap between claim and restore
    // (e.g. the dispatch failed, and while it was in flight the user edited
    // and re-queued).
    queuedMessagesDb.save('session-a', '{"content":"edited-while-in-flight"}');

    // The failed dispatch now tries to restore its stale claim.
    queuedMessagesDb.restore('session-a', '{"content":"hello"}');

    const row = queuedMessagesDb.get('session-a');
    assert.equal(row?.content, '{"content":"edited-while-in-flight"}', 'the newer queue must survive');
  });
});

test('clear removes the row unconditionally, regardless of its content', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('session-a', 'claude', '/workspace/demo');
    queuedMessagesDb.save('session-a', '{"content":"hello"}');

    queuedMessagesDb.clear('session-a');

    assert.equal(queuedMessagesDb.get('session-a'), null);
  });
});

test('deleting the session cascades to its queued message', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('session-a', 'claude', '/workspace/demo');
    queuedMessagesDb.save('session-a', '{"content":"hello"}');

    sessionsDb.deleteSessionById('session-a');

    assert.equal(queuedMessagesDb.get('session-a'), null);
  });
});

test('two sessions never see each other\'s queued message', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('session-a', 'claude', '/workspace/demo');
    sessionsDb.createAppSession('session-b', 'claude', '/workspace/demo');
    queuedMessagesDb.save('session-a', '{"content":"for-a"}');

    assert.equal(queuedMessagesDb.get('session-b'), null);
    assert.equal(queuedMessagesDb.get('session-a')?.content, '{"content":"for-a"}');
  });
});
