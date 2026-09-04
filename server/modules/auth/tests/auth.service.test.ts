import assert from 'node:assert/strict';
import test from 'node:test';

import { AppError } from '@/shared/utils.js';

import { createAuthService } from '../auth.service.js';

type AuthDependencies = Parameters<typeof createAuthService>[0];

function createDependencies(overrides: Partial<AuthDependencies> = {}): AuthDependencies {
  return {
    users: {
      hasUsers: () => false,
      createUser: (username, passwordHash) => ({ id: 1, username, password_hash: passwordHash }),
      getUserByUsername: () => undefined,
      updateLastLogin: () => undefined,
      updateDisplayName: () => undefined,
    },
    transaction: {
      begin: () => undefined,
      commit: () => undefined,
      rollback: () => undefined,
    },
    hashPassword: async () => 'hashed-password',
    comparePassword: async () => false,
    generateToken: () => 'signed-token',
    ...overrides,
  };
}

test('register hashes credentials and commits through injected dependencies', async () => {
  const operations: string[] = [];
  const service = createAuthService(createDependencies({
    transaction: {
      begin: () => operations.push('begin'),
      commit: () => operations.push('commit'),
      rollback: () => operations.push('rollback'),
    },
    hashPassword: async (password) => {
      operations.push(`hash:${password}`);
      return 'hash';
    },
    users: {
      hasUsers: () => false,
      createUser: (username, passwordHash) => {
        operations.push(`create:${username}:${passwordHash}`);
        return { id: 1, username, password_hash: passwordHash };
      },
      getUserByUsername: () => undefined,
      updateLastLogin: (userId) => operations.push(`login:${userId}`),
      updateDisplayName: () => undefined,
    },
  }));

  const result = await service.register('alice', 'secret12');

  assert.equal(result.token, 'signed-token');
  assert.deepEqual(operations, ['begin', 'hash:secret12', 'create:alice:hash', 'commit', 'login:1']);
});

test('login rejects an invalid password without issuing a token', async () => {
  let tokenIssued = false;
  const service = createAuthService(createDependencies({
    users: {
      hasUsers: () => true,
      createUser: () => { throw new Error('unused'); },
      getUserByUsername: () => ({ id: 1, username: 'alice', password_hash: 'hash' }),
      updateLastLogin: () => undefined,
      updateDisplayName: () => undefined,
    },
    comparePassword: async () => false,
    generateToken: () => {
      tokenIssued = true;
      return 'token';
    },
  }));

  await assert.rejects(
    service.login('alice', 'wrong-password'),
    (error: unknown) => error instanceof AppError && error.code === 'AUTH_INVALID_CREDENTIALS',
  );
  assert.equal(tokenIssued, false);
});

test('refreshSession issues a replacement token for the authenticated user', () => {
  let tokenUser: { id: number | bigint; username: string } | undefined;
  const service = createAuthService(createDependencies({
    generateToken: (user) => {
      tokenUser = user;
      return 'replacement-token';
    },
  }));

  const result = service.refreshSession({ id: 7, username: 'alice' });

  assert.deepEqual(result, { token: 'replacement-token' });
  assert.deepEqual(tokenUser, { id: 7, username: 'alice' });
});

// ---------------------------------------------------------------------------
// App user profile (display name)
// ---------------------------------------------------------------------------

test('getCurrentUser exposes the stored display name in camelCase', () => {
  const service = createAuthService(createDependencies());

  const result = service.getCurrentUser({ id: 1, username: 'cedric', display_name: 'Cédric' });

  assert.deepEqual(result.user, {
    id: 1,
    username: 'cedric',
    display_name: 'Cédric',
    displayName: 'Cédric',
  });
});

test('getCurrentUser reports a null display name when none is configured', () => {
  const service = createAuthService(createDependencies());

  for (const stored of [null, '', '   ', undefined]) {
    const result = service.getCurrentUser({ id: 1, username: 'cedric', display_name: stored });
    assert.equal((result.user as { displayName: unknown }).displayName, null);
  }
});

test('getCurrentUser does not invent a display name for a missing user', () => {
  const service = createAuthService(createDependencies());

  assert.deepEqual(service.getCurrentUser(null), { user: null });
  assert.deepEqual(service.getCurrentUser(undefined), { user: undefined });
});

test('updateProfile persists a trimmed display name for the authenticated user', () => {
  const writes: Array<[number, string | null]> = [];
  const service = createAuthService(createDependencies({
    users: {
      hasUsers: () => true,
      createUser: () => { throw new Error('unused'); },
      getUserByUsername: () => undefined,
      updateLastLogin: () => undefined,
      updateDisplayName: (userId, displayName) => writes.push([userId, displayName]),
    },
  }));

  const result = service.updateProfile({ id: 4, username: 'cedric' }, '  Cédric  ');

  assert.deepEqual(writes, [[4, 'Cédric']]);
  assert.equal((result.user as { displayName: unknown }).displayName, 'Cédric');
});

test('updateProfile clears the override instead of storing an empty name', () => {
  const writes: Array<string | null> = [];
  const service = createAuthService(createDependencies({
    users: {
      hasUsers: () => true,
      createUser: () => { throw new Error('unused'); },
      getUserByUsername: () => undefined,
      updateLastLogin: () => undefined,
      updateDisplayName: (_userId, displayName) => writes.push(displayName),
    },
  }));

  service.updateProfile({ id: 4, username: 'cedric' }, '   ');
  service.updateProfile({ id: 4, username: 'cedric' }, null);

  assert.deepEqual(writes, [null, null]);
});

test('updateProfile rejects an over-long or non-string display name', () => {
  let wrote = false;
  const service = createAuthService(createDependencies({
    users: {
      hasUsers: () => true,
      createUser: () => { throw new Error('unused'); },
      getUserByUsername: () => undefined,
      updateLastLogin: () => undefined,
      updateDisplayName: () => { wrote = true; },
    },
  }));

  assert.throws(
    () => service.updateProfile({ id: 4, username: 'cedric' }, 'x'.repeat(61)),
    (error: unknown) => error instanceof AppError && error.code === 'AUTH_DISPLAY_NAME_TOO_LONG',
  );
  assert.throws(
    () => service.updateProfile({ id: 4, username: 'cedric' }, 42),
    (error: unknown) => error instanceof AppError && error.code === 'AUTH_DISPLAY_NAME_INVALID',
  );
  assert.equal(wrote, false);
});

test('updateProfile refuses to write without an authenticated user', () => {
  let wrote = false;
  const service = createAuthService(createDependencies({
    users: {
      hasUsers: () => true,
      createUser: () => { throw new Error('unused'); },
      getUserByUsername: () => undefined,
      updateLastLogin: () => undefined,
      updateDisplayName: () => { wrote = true; },
    },
  }));

  assert.throws(
    () => service.updateProfile(null, 'Cédric'),
    (error: unknown) => error instanceof AppError && error.code === 'AUTH_USER_REQUIRED',
  );
  assert.equal(wrote, false);
});
