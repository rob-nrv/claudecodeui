import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { userDb } from '@/modules/database/repositories/users.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'users-db-'));
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

test('a freshly migrated user starts with no display name override', async () => {
  await withIsolatedDatabase(() => {
    const created = userDb.createUser('cedric', 'hash');

    const byId = userDb.getUserById(Number(created.id));
    const first = userDb.getFirstUser();

    assert.equal(byId?.username, 'cedric');
    assert.equal(byId?.display_name, null);
    assert.equal(first?.display_name, null);
  });
});

test('the display name round-trips through both public user lookups', async () => {
  await withIsolatedDatabase(() => {
    const created = userDb.createUser('cedric', 'hash');
    const userId = Number(created.id);

    userDb.updateDisplayName(userId, 'Cédric');

    assert.equal(userDb.getUserById(userId)?.display_name, 'Cédric');
    assert.equal(userDb.getFirstUser()?.display_name, 'Cédric');
  });
});

test('clearing the display name falls the record back to the username alone', async () => {
  await withIsolatedDatabase(() => {
    const created = userDb.createUser('cedric', 'hash');
    const userId = Number(created.id);

    userDb.updateDisplayName(userId, 'Cédric');
    userDb.updateDisplayName(userId, null);

    const reread = userDb.getUserById(userId);
    assert.equal(reread?.display_name, null);
    assert.equal(reread?.username, 'cedric');
  });
});

test('public user lookups never expose the password hash', async () => {
  await withIsolatedDatabase(() => {
    const created = userDb.createUser('cedric', 'super-secret-hash');

    const byId = userDb.getUserById(Number(created.id)) as Record<string, unknown>;

    assert.equal('password_hash' in byId, false);
  });
});
