import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase, remoteAccessDb } from '@/modules/database/index.js';
import { createRemoteAccessService } from '@/modules/remote-access/remote-access.service.js';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

async function withDatabase(runTest: () => Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'remote-access-service-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();
  try {
    await runTest();
  } finally {
    closeConnection();
    if (previous === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previous;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

function createFixture() {
  const clock = { now: Date.UTC(2026, 8, 13, 12) };
  const users = new Map([[1, { id: 1, username: 'robin', password_hash: 'hash:correct horse' }]]);
  const service = createRemoteAccessService({
    users: {
      getUserByUsername: (username) => [...users.values()].find((user) => user.username === username),
      getUserById: (userId) => users.get(userId),
    },
    comparePassword: async (password, hash) => hash === `hash:${password}`,
    hashPassword: async (password) => `hash:${password}`,
    store: remoteAccessDb,
    now: () => clock.now,
  });
  const pair = (pairingCode: string, password = 'correct horse', clientKey = '203.0.113.7') =>
    service.pairBrowser({ username: 'robin', password, pairingCode, clientKey, userAgent: 'Mozilla/5.0 (iPhone) Safari/604.1' });
  return { clock, users, service, pair };
}

test('pairing needs the password AND an unused pairing code, and returns a session token that only exists as a hash', { concurrency: false }, async () => {
  await withDatabase(async () => {
    const { service, pair } = createFixture();
    const { code } = service.createPairingCode(1);

    const paired = await pair(code);
    assert.match(paired.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(paired.user.username, 'robin');
    assert.equal(service.authenticate(paired.token)?.user.id, 1);

    await assert.rejects(pair(code), { code: 'REMOTE_PAIRING_FAILED' }, 'a code is single-use');

    const stored = JSON.stringify([
      getConnection().prepare('SELECT * FROM remote_pairing_codes').all(),
      getConnection().prepare('SELECT * FROM remote_browser_sessions').all(),
    ]);
    assert.equal(stored.includes(code.replace(/-/g, '')), false);
    assert.equal(stored.includes(paired.token), false);
    assert.equal(service.listSessions(paired.sessionId)[0].label, 'Safari on iOS');
  });
});

test('a wrong password or an unknown user burns the presented code, so a known code cannot be used to guess', { concurrency: false }, async () => {
  await withDatabase(async () => {
    const { service, pair } = createFixture();
    const first = service.createPairingCode(1);
    await assert.rejects(pair(first.code, 'wrong'), { code: 'REMOTE_PAIRING_FAILED' });
    await assert.rejects(pair(first.code), { code: 'REMOTE_PAIRING_FAILED' }, 'burned by the failed attempt');

    const second = service.createPairingCode(1);
    await assert.rejects(
      service.pairBrowser({ username: 'nobody', password: 'x', pairingCode: second.code, clientKey: 'k', userAgent: null }),
      { code: 'REMOTE_PAIRING_FAILED' },
    );
    await assert.rejects(pair(second.code), { code: 'REMOTE_PAIRING_FAILED' });
  });
});

test('expired codes fail, and too many failures are refused before any code is touched', { concurrency: false }, async () => {
  await withDatabase(async () => {
    const { clock, service, pair } = createFixture();
    const expiring = service.createPairingCode(1);
    clock.now += 10 * MINUTE + 1;
    await assert.rejects(pair(expiring.code), { code: 'REMOTE_PAIRING_FAILED' });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await assert.rejects(pair('0000-0000-0000', 'wrong', 'attacker'), { code: 'REMOTE_PAIRING_FAILED' });
    }
    const valid = service.createPairingCode(1);
    await assert.rejects(pair(valid.code, 'correct horse', 'attacker'), { code: 'REMOTE_PAIRING_RATE_LIMITED' });

    clock.now += 15 * MINUTE;
    const renewed = service.createPairingCode(1);
    const paired = await pair(renewed.code, 'correct horse', 'attacker');
    assert.ok(paired.token, 'the window passed and a fresh code works');
  });
});

test('outstanding pairing codes are capped', { concurrency: false }, async () => {
  await withDatabase(async () => {
    const { service } = createFixture();
    for (let index = 0; index < 5; index += 1) {
      service.createPairingCode(1);
    }
    assert.throws(() => service.createPairingCode(1), { code: 'REMOTE_PAIRING_CODE_LIMIT' });
  });
});

test('sessions end on revocation, idle timeout, absolute lifetime or a deleted user', { concurrency: false }, async () => {
  await withDatabase(async () => {
    const { clock, users, service, pair } = createFixture();
    const revokedIds: string[] = [];
    service.onSessionsRevoked((ids) => revokedIds.push(...ids));

    const revoked = await pair(service.createPairingCode(1).code);
    assert.equal(service.revokeSession(revoked.sessionId), true);
    assert.equal(service.authenticate(revoked.token), null);
    assert.deepEqual(revokedIds, [revoked.sessionId]);

    const idle = await pair(service.createPairingCode(1).code);
    clock.now += 7 * DAY + 1;
    assert.equal(service.authenticate(idle.token), null, 'unused for longer than the idle timeout');

    const active = await pair(service.createPairingCode(1).code);
    for (let day = 0; day < 29; day += 1) {
      clock.now += DAY;
      assert.ok(service.authenticate(active.token), `still active on day ${day + 1}`);
    }
    clock.now += DAY + 1;
    assert.equal(service.authenticate(active.token), null, 'no session outlives its absolute lifetime');

    const orphan = await pair(service.createPairingCode(1).code);
    users.delete(1);
    assert.equal(service.authenticate(orphan.token), null);

    assert.equal(service.authenticate('short'), null);
    assert.equal(service.authenticate(undefined), null);
  });
});

test('revoking every remote browser reports each revoked session', { concurrency: false }, async () => {
  await withDatabase(async () => {
    const { service, pair } = createFixture();
    const revokedIds: string[] = [];
    service.onSessionsRevoked((ids) => revokedIds.push(...ids));
    const a = await pair(service.createPairingCode(1).code);
    const b = await pair(service.createPairingCode(1).code);

    assert.equal(service.revokeAllSessions(), 2);
    assert.deepEqual(revokedIds.sort(), [a.sessionId, b.sessionId].sort());
    assert.equal(service.isSessionActive(a.sessionId), false);
    assert.deepEqual(service.listSessions(null), []);
  });
});
