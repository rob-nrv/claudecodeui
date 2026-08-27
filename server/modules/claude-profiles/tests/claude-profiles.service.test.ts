import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase } from '@/modules/database/index.js';
import { createClaudeProfilesService } from '@/modules/claude-profiles/claude-profiles.service.js';
import { claudeHomeFor, legacyClaudeHome } from '@/modules/claude-profiles/claude-home.resolver.js';

async function withIsolatedDatabase(runTest: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-profiles-service-'));
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

const directoryExists = async (directoryPath: string): Promise<boolean> => {
  try {
    return (await stat(directoryPath)).isDirectory();
  } catch {
    return false;
  }
};

test('createProfile: never returns configDirectory, and the isolated directory is created on disk', async () => {
  await withIsolatedDatabase(async () => {
    const service = createClaudeProfilesService();
    const profile = await service.createProfile({ displayName: 'Work' });

    assert.equal(profile.displayName, 'Work');
    assert.equal(profile.isDefault, true, 'first profile becomes the default');
    assert.equal((profile as unknown as { configDirectory?: string }).configDirectory, undefined);

    const expectedDir = claudeHomeFor(profile.id);
    assert.notEqual(expectedDir, legacyClaudeHome());
    assert.equal(await directoryExists(expectedDir), true);
  });
});

test('createProfile: a second profile is not made default, and each profile has a distinct isolated directory', async () => {
  await withIsolatedDatabase(async () => {
    const service = createClaudeProfilesService();
    const first = await service.createProfile({ displayName: 'Personal' });
    const second = await service.createProfile({ displayName: 'Work' });

    assert.equal(first.isDefault, true);
    assert.equal(second.isDefault, false);
    assert.notEqual(claudeHomeFor(first.id), claudeHomeFor(second.id));

    const listed = service.listProfiles();
    assert.deepEqual(listed.map((p) => p.id).sort(), [first.id, second.id].sort());
  });
});

test('createProfile: rejects an empty or overlong displayName', async () => {
  await withIsolatedDatabase(async () => {
    const service = createClaudeProfilesService();
    await assert.rejects(() => service.createProfile({ displayName: '   ' }));
    await assert.rejects(() => service.createProfile({ displayName: 'x'.repeat(61) }));
  });
});

test('renameProfile / setDefaultProfile: update the targeted row and leave ids stable', async () => {
  await withIsolatedDatabase(async () => {
    const service = createClaudeProfilesService();
    const first = await service.createProfile({ displayName: 'Personal' });
    const second = await service.createProfile({ displayName: 'Work' });

    const renamed = service.renameProfile(second.id, 'Work (secondary)');
    assert.equal(renamed.id, second.id);
    assert.equal(renamed.displayName, 'Work (secondary)');

    const promoted = service.setDefaultProfile(second.id);
    assert.equal(promoted.isDefault, true);
    assert.equal(service.listProfiles().find((p) => p.id === first.id)?.isDefault, false);
  });
});

test('removeProfile: deletes only the registration row, never the isolated config directory', async () => {
  await withIsolatedDatabase(async () => {
    const service = createClaudeProfilesService();
    const profile = await service.createProfile({ displayName: 'Personal' });
    const configDirectory = claudeHomeFor(profile.id);

    const removed = service.removeProfile(profile.id);
    assert.equal(removed.id, profile.id);
    assert.equal(service.listProfiles().length, 0);
    assert.equal(await directoryExists(configDirectory), true, 'config dir must survive CloudCLI-side removal');
  });
});

test('removeProfile: promotes the next-oldest profile to default when the default is removed', async () => {
  await withIsolatedDatabase(async () => {
    const service = createClaudeProfilesService();
    const first = await service.createProfile({ displayName: 'Personal' });
    const second = await service.createProfile({ displayName: 'Work' });

    service.removeProfile(first.id);
    const remaining = service.listProfiles();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, second.id);
    assert.equal(remaining[0].isDefault, true);
  });
});

test('verifyProfile: loggedIn true with an email maps to connected + verified identity', async () => {
  await withIsolatedDatabase(async () => {
    const service = createClaudeProfilesService({
      probeAuthStatus: async () => ({
        loggedIn: true,
        authMethod: 'claude.ai',
        apiProvider: 'firstParty',
        email: 'robin@example.com',
        orgId: 'org_1',
        orgName: 'Acme',
        subscriptionType: 'pro',
      }),
    });
    const profile = await service.createProfile({ displayName: 'Personal' });

    const verified = await service.verifyProfile(profile.id);
    assert.equal(verified.connectionState, 'connected');
    assert.equal(verified.verifiedIdentity?.value, 'robin@example.com');
    assert.equal(verified.verifiedIdentity?.tier, 'pro');
    assert.equal(verified.verifiedIdentity?.method, 'cli_probe');
  });
});

test('verifyProfile: loggedIn false maps to not_authenticated and clears any prior identity', async () => {
  await withIsolatedDatabase(async () => {
    const service = createClaudeProfilesService({
      probeAuthStatus: async () => ({
        loggedIn: false,
        authMethod: 'none',
        apiProvider: 'firstParty',
        email: null,
        orgId: null,
        orgName: null,
        subscriptionType: null,
      }),
    });
    const profile = await service.createProfile({ displayName: 'Personal' });

    const verified = await service.verifyProfile(profile.id);
    assert.equal(verified.connectionState, 'not_authenticated');
    assert.equal(verified.verifiedIdentity, null);
  });
});

test('verifyProfile: a probe failure (command error / bad JSON) maps to unknown, never to connected', async () => {
  await withIsolatedDatabase(async () => {
    const service = createClaudeProfilesService({
      probeAuthStatus: async () => null,
    });
    const profile = await service.createProfile({ displayName: 'Personal' });

    const verified = await service.verifyProfile(profile.id);
    assert.equal(verified.connectionState, 'unknown');
    assert.equal(verified.verifiedIdentity, null);
  });
});

test('verifyProfile: probes with the profile\'s own configDirectory, not another profile\'s', async () => {
  await withIsolatedDatabase(async () => {
    const seenConfigDirectories: Array<string | undefined> = [];
    const service = createClaudeProfilesService({
      probeAuthStatus: async (configDirectory) => {
        seenConfigDirectories.push(configDirectory);
        return { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'a@example.com', orgId: null, orgName: null, subscriptionType: null };
      },
    });
    const first = await service.createProfile({ displayName: 'Personal' });
    const second = await service.createProfile({ displayName: 'Work' });

    await service.verifyProfile(second.id);

    assert.equal(seenConfigDirectories.length, 1);
    assert.equal(seenConfigDirectories[0], claudeHomeFor(second.id));
    assert.notEqual(seenConfigDirectories[0], claudeHomeFor(first.id));
  });
});

test('createProfile / verifyProfile: never mutate process.env.CLAUDE_CONFIG_DIR (or leave it set)', async () => {
  await withIsolatedDatabase(async () => {
    const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
    assert.equal(originalConfigDir, undefined, 'test precondition: CLAUDE_CONFIG_DIR must start unset');

    const service = createClaudeProfilesService({
      probeAuthStatus: async () => ({
        loggedIn: true,
        authMethod: 'claude.ai',
        apiProvider: 'firstParty',
        email: 'robin@example.com',
        orgId: null,
        orgName: null,
        subscriptionType: 'pro',
      }),
    });

    const profile = await service.createProfile({ displayName: 'Personal' });
    assert.equal(process.env.CLAUDE_CONFIG_DIR, undefined, 'createProfile must never set the global env var');

    await service.verifyProfile(profile.id);
    assert.equal(process.env.CLAUDE_CONFIG_DIR, undefined, 'verifyProfile must never set the global env var, even though it probes a specific config dir');
  });
});

test('migrations: running twice against the same DB does not fail and keeps claude_profiles intact', async () => {
  await withIsolatedDatabase(async () => {
    const service = createClaudeProfilesService();
    await service.createProfile({ displayName: 'Personal' });

    // initializeDatabase() runs INIT_SCHEMA_SQL + runMigrations again, exactly
    // as it would on a second server start against the same DB file.
    await initializeDatabase();

    const columns = getConnection().prepare('PRAGMA table_info(claude_profiles)').all() as Array<{ name: string }>;
    assert.ok(columns.some((column) => column.name === 'config_directory'));
    assert.equal(service.listProfiles().length, 1);
  });
});
