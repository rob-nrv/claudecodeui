import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import {
  createClaudeLiveUsageService,
  evaluateClaudeLiveUsageSnapshot,
} from '@/modules/claude-profiles/claude-live-usage.service.js';
import { createClaudeProfilesRouter } from '@/modules/claude-profiles/claude-profiles.routes.js';
import { claudeProfilesService } from '@/modules/claude-profiles/claude-profiles.service.js';
import {
  CLAUDE_LIVE_USAGE_SNAPSHOT_FILE_NAME,
  parseStatusLineBridgeCommand,
} from '@/modules/claude-profiles/claude-statusline-bridge.js';
import { claudeProfilesDb, closeConnection, initializeDatabase } from '@/modules/database/index.js';
import type { ClaudeLiveUsage } from '@/shared/types.js';

const NOW = Date.UTC(2026, 8, 13, 12, 0, 0);
const NOW_SECONDS = NOW / 1000;
const WORK_DIRECTORY = path.resolve('claude-config', 'work');

const snapshotFor = (configDirectory: string, overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  source: 'claude-statusline',
  configDirectory,
  capturedAt: NOW - 60_000,
  rateLimits: {
    five_hour: { used_percentage: 23.5, resets_at: NOW_SECONDS + 3600 },
    seven_day: { used_percentage: 41.2, resets_at: NOW_SECONDS + 3 * 86_400 },
  },
  ...overrides,
});

const evaluate = (raw: unknown, now = NOW) =>
  evaluateClaudeLiveUsageSnapshot(raw, { expectedConfigDirectory: WORK_DIRECTORY, now, platform: process.platform });

const hasNoNumber = (window: ClaudeLiveUsage['fiveHour']): boolean => !('usedPercentage' in window);

// ----------------- snapshot evaluation -----------------

test('both windows present and fresh are reported exactly as observed', () => {
  const result = evaluate(snapshotFor(WORK_DIRECTORY));

  assert.deepEqual(result.snapshot, {
    status: 'available',
    reason: null,
    capturedAt: new Date(NOW - 60_000).toISOString(),
    freshness: 'fresh',
  });
  assert.deepEqual(result.fiveHour, { state: 'available', usedPercentage: 23.5, resetsAt: new Date((NOW_SECONDS + 3600) * 1000).toISOString() });
  assert.deepEqual(result.sevenDay, { state: 'available', usedPercentage: 41.2, resetsAt: new Date((NOW_SECONDS + 3 * 86_400) * 1000).toISOString() });
});

test('one absent window is unavailable on its own, never 0%, while the other stays available', () => {
  const onlyFiveHour = evaluate(snapshotFor(WORK_DIRECTORY, {
    rateLimits: { five_hour: { used_percentage: 7, resets_at: NOW_SECONDS + 600 } },
  }));
  assert.equal(onlyFiveHour.fiveHour.state, 'available');
  assert.deepEqual(onlyFiveHour.sevenDay, { state: 'unavailable', reason: 'not_reported' });

  const onlySevenDay = evaluate(snapshotFor(WORK_DIRECTORY, {
    rateLimits: { seven_day: { used_percentage: 64, resets_at: NOW_SECONDS + 86_400 } },
  }));
  assert.deepEqual(onlySevenDay.fiveHour, { state: 'unavailable', reason: 'not_reported' });
  assert.equal(onlySevenDay.sevenDay.state, 'available');
});

test('no rate limits ever captured means unavailable with no number anywhere', () => {
  const result = evaluate(null);
  assert.deepEqual(result.snapshot, { status: 'unavailable', reason: 'no_snapshot', capturedAt: null, freshness: null });
  assert.ok(hasNoNumber(result.fiveHour) && hasNoNumber(result.sevenDay));
});

test('invalid snapshots and invalid windows are rejected instead of being coerced', () => {
  for (const raw of ['string', [], {}, snapshotFor(WORK_DIRECTORY, { schemaVersion: 2 }), snapshotFor(WORK_DIRECTORY, { capturedAt: 'now' }), snapshotFor(WORK_DIRECTORY, { source: 'scraper' })]) {
    const result = evaluate(raw);
    assert.equal(result.snapshot.reason, 'snapshot_invalid', JSON.stringify(raw));
    assert.ok(hasNoNumber(result.fiveHour) && hasNoNumber(result.sevenDay));
  }

  for (const fiveHour of [
    { used_percentage: 140, resets_at: NOW_SECONDS + 60 },
    { used_percentage: -1, resets_at: NOW_SECONDS + 60 },
    { used_percentage: '23', resets_at: NOW_SECONDS + 60 },
    { used_percentage: 23 },
    { used_percentage: 23, resets_at: NOW_SECONDS + 30 * 86_400 },
  ]) {
    const result = evaluate(snapshotFor(WORK_DIRECTORY, { rateLimits: { five_hour: fiveHour } }));
    assert.deepEqual(result.fiveHour, { state: 'unavailable', reason: 'not_reported' }, JSON.stringify(fiveHour));
  }
});

test('a window whose reset time has passed is reported as reset, not as its old percentage', () => {
  const result = evaluate(snapshotFor(WORK_DIRECTORY), NOW + 2 * 3600_000);
  assert.deepEqual(result.fiveHour, { state: 'unavailable', reason: 'window_reset' });
  assert.equal(result.sevenDay.state, 'available');
});

test('an old capture is still labeled stale rather than current, and a future capture is refused', () => {
  const stale = evaluate(snapshotFor(WORK_DIRECTORY, { capturedAt: NOW - 20 * 60_000 }));
  assert.equal(stale.snapshot.freshness, 'stale');
  assert.equal(stale.fiveHour.state, 'available');

  const future = evaluate(snapshotFor(WORK_DIRECTORY, { capturedAt: NOW + 60 * 60_000 }));
  assert.equal(future.snapshot.reason, 'snapshot_from_future');
  assert.ok(hasNoNumber(future.fiveHour));
});

test('a snapshot recorded for another config directory is never attributed to this account', () => {
  const result = evaluate(snapshotFor(path.resolve('claude-config', 'personal')));
  assert.equal(result.snapshot.reason, 'attribution_mismatch');
  assert.ok(hasNoNumber(result.fiveHour) && hasNoNumber(result.sevenDay));
});

// ----------------- service over a real filesystem -----------------

type Fixture = {
  home: string;
  workDirectory: string;
  personalDirectory: string;
  service: ReturnType<typeof createClaudeLiveUsageService>;
};

async function withLiveUsageFixture(runTest: (fixture: Fixture) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const home = await mkdtemp(path.join(os.tmpdir(), 'claude-live-usage-'));
  const workDirectory = path.join(home, '.cloudcli', 'claude-profiles', 'profile-work');
  const personalDirectory = path.join(home, '.cloudcli', 'claude-profiles', 'profile-personal');
  await mkdir(workDirectory, { recursive: true });
  await mkdir(personalDirectory, { recursive: true });

  closeConnection();
  process.env.DATABASE_PATH = path.join(home, 'auth.db');
  await writeFile(process.env.DATABASE_PATH, '');
  await initializeDatabase();
  claudeProfilesDb.create({ id: 'profile-work', displayName: 'Work', configDirectory: workDirectory, isDefault: true });
  claudeProfilesDb.create({ id: 'profile-personal', displayName: 'Personal', configDirectory: personalDirectory, isDefault: false });

  const service = createClaudeLiveUsageService({
    homeDirectory: home,
    platform: process.platform,
    nodeExecutablePath: process.execPath,
    pathEnvironment: path.dirname(process.execPath),
  });

  try {
    await runTest({ home, workDirectory, personalDirectory, service });
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(home, { recursive: true, force: true });
  }
}

const liveSnapshot = (configDirectory: string, usedPercentage: number) => ({
  schemaVersion: 1,
  source: 'claude-statusline',
  configDirectory,
  capturedAt: Date.now() - 1_000,
  rateLimits: { five_hour: { used_percentage: usedPercentage, resets_at: Math.floor(Date.now() / 1000) + 3600 } },
});

test('Work and Personal usage are each read only from their own config directory', { concurrency: false }, async () => {
  await withLiveUsageFixture(async ({ service, workDirectory, personalDirectory }) => {
    await writeFile(path.join(workDirectory, CLAUDE_LIVE_USAGE_SNAPSHOT_FILE_NAME), JSON.stringify(liveSnapshot(workDirectory, 31)));

    const work = await service.getLiveUsage('profile-work');
    const personal = await service.getLiveUsage('profile-personal');
    assert.deepEqual(work.fiveHour.state === 'available' ? work.fiveHour.usedPercentage : null, 31);
    assert.equal(personal.snapshot.reason, 'no_snapshot');
    assert.ok(hasNoNumber(personal.fiveHour));

    // Work's snapshot copied into Personal's directory is refused, not shown as Personal's usage.
    await writeFile(path.join(personalDirectory, CLAUDE_LIVE_USAGE_SNAPSHOT_FILE_NAME), JSON.stringify(liveSnapshot(workDirectory, 31)));
    const copied = await service.getLiveUsage('profile-personal');
    assert.equal(copied.snapshot.reason, 'attribution_mismatch');
    assert.ok(hasNoNumber(copied.fiveHour));
  });
});

test('enabling wraps an existing statusLine without touching anything else, and disabling restores the file byte for byte', { concurrency: false }, async () => {
  await withLiveUsageFixture(async ({ service, home, workDirectory, personalDirectory }) => {
    const settingsPath = path.join(workDirectory, 'settings.json');
    const originalSettings = {
      model: 'opus',
      env: { ANTHROPIC_API_KEY: 'sk-ant-api03-not-a-real-secret-value' },
      statusLine: { type: 'command', command: '~/.claude/statusline.sh', padding: 1 },
    };
    const originalRaw = `${JSON.stringify(originalSettings, null, 4)}\n`;
    await writeFile(settingsPath, originalRaw);

    const enabled = await service.enableBridge('profile-work');
    assert.deepEqual(enabled.bridge, { state: 'installed', wrapsExistingStatusLine: true, hasUserStatusLine: false });

    const writtenRaw = await readFile(settingsPath, 'utf8');
    const written = JSON.parse(writtenRaw);
    assert.deepEqual(written.env, originalSettings.env);
    assert.equal(written.model, 'opus');
    assert.equal(written.statusLine.padding, 1);
    assert.equal(parseStatusLineBridgeCommand(written.statusLine.command)?.wrappedCommand, '~/.claude/statusline.sh');
    assert.ok(writtenRaw.startsWith('{\n    "model"'), 'indentation is preserved');
    assert.ok((await stat(path.join(home, '.cloudcli', 'bin', 'claude-statusline-bridge.mjs'))).isFile());
    await assert.rejects(stat(path.join(personalDirectory, 'settings.json')), 'another account is never modified');

    const disabled = await service.disableBridge('profile-work');
    assert.deepEqual(disabled.bridge, { state: 'not_installed', wrapsExistingStatusLine: false, hasUserStatusLine: true });
    assert.equal(await readFile(settingsPath, 'utf8'), originalRaw);

    const serializedViews = JSON.stringify([enabled, disabled]);
    assert.equal(serializedViews.includes('sk-ant-api03'), false, 'settings content never reaches the API view');
    assert.equal(serializedViews.includes(path.basename(home)), false, 'no config path reaches the API view');
  });
});

test('enabling on an account without settings, then disabling, leaves no statusLine behind', { concurrency: false }, async () => {
  await withLiveUsageFixture(async ({ service, workDirectory }) => {
    const enabled = await service.enableBridge('profile-work');
    assert.deepEqual(enabled.bridge, { state: 'installed', wrapsExistingStatusLine: false, hasUserStatusLine: false });

    await service.disableBridge('profile-work');
    assert.deepEqual(JSON.parse(await readFile(path.join(workDirectory, 'settings.json'), 'utf8')), {});
  });
});

test('settings that are not a JSON object are never rewritten, and nothing is installed', { concurrency: false }, async () => {
  await withLiveUsageFixture(async ({ service, home, workDirectory }) => {
    const settingsPath = path.join(workDirectory, 'settings.json');
    await writeFile(settingsPath, '{ "model": "opus", ');

    await assert.rejects(service.enableBridge('profile-work'), { code: 'LIVE_USAGE_SETTINGS_UNREADABLE' });
    await assert.rejects(service.disableBridge('profile-work'), { code: 'LIVE_USAGE_SETTINGS_UNREADABLE' });
    assert.equal(await readFile(settingsPath, 'utf8'), '{ "model": "opus", ');
    await assert.rejects(stat(path.join(home, '.cloudcli', 'bin', 'claude-statusline-bridge.mjs')));
    assert.equal((await service.getLiveUsage('profile-work')).bridge.state, 'settings_unreadable');
  });
});

test('a bridge whose script disappeared is reported broken, and an unknown account is refused', { concurrency: false }, async () => {
  await withLiveUsageFixture(async ({ service, home }) => {
    await service.enableBridge('profile-work');
    await rm(path.join(home, '.cloudcli', 'bin', 'claude-statusline-bridge.mjs'));

    assert.equal((await service.getLiveUsage('profile-work')).bridge.state, 'broken');
    await assert.rejects(service.getLiveUsage('does-not-exist'), { code: 'CLAUDE_PROFILE_NOT_FOUND' });
    await assert.rejects(service.enableBridge('does-not-exist'), { code: 'CLAUDE_PROFILE_NOT_FOUND' });
  });
});

test('the historical account reads <home>/.claude and never a profile directory', { concurrency: false }, async () => {
  await withLiveUsageFixture(async ({ service, home }) => {
    const legacyDirectory = path.join(home, '.claude');
    await mkdir(legacyDirectory);
    await writeFile(path.join(legacyDirectory, CLAUDE_LIVE_USAGE_SNAPSHOT_FILE_NAME), JSON.stringify(liveSnapshot(legacyDirectory, 55)));

    const legacy = await service.getLiveUsage(null);
    assert.equal(legacy.fiveHour.state === 'available' ? legacy.fiveHour.usedPercentage : null, 55);
    assert.equal((await service.getLiveUsage('profile-work')).snapshot.reason, 'no_snapshot');
  });
});

// ----------------- routes -----------------

test('live usage routes address the historical account and profiles explicitly', async () => {
  const calls: string[] = [];
  const view = { source: 'claude_statusline' } as ClaudeLiveUsage;
  const recorder = (action: string) => async (profileId: string | null) => {
    calls.push(`${action}:${profileId === null ? 'legacy' : profileId}`);
    return view;
  };

  const app = express();
  app.use(express.json());
  app.use('/api/claude-profiles', createClaudeProfilesRouter(claudeProfilesService, {
    getLiveUsage: recorder('get'),
    enableBridge: recorder('enable'),
    disableBridge: recorder('disable'),
  }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/claude-profiles`;
    for (const [method, url] of [
      ['GET', `${baseUrl}/legacy-home/live-usage`],
      ['POST', `${baseUrl}/legacy-home/live-usage/bridge`],
      ['DELETE', `${baseUrl}/legacy-home/live-usage/bridge`],
      ['GET', `${baseUrl}/profile-work/live-usage`],
      ['POST', `${baseUrl}/profile-work/live-usage/bridge`],
      ['DELETE', `${baseUrl}/profile-work/live-usage/bridge`],
    ] as const) {
      const response = await fetch(url, { method });
      assert.equal(response.status, 200, `${method} ${url}`);
      assert.deepEqual((await response.json() as { data: { liveUsage: ClaudeLiveUsage } }).data.liveUsage, view);
    }
    assert.deepEqual(calls, [
      'get:legacy',
      'enable:legacy',
      'disable:legacy',
      'get:profile-work',
      'enable:profile-work',
      'disable:profile-work',
    ]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
