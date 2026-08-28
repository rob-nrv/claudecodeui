import assert from 'node:assert/strict';
import test from 'node:test';

import type { LocalServerMarker, RuntimeHealth } from '../runtime-marker.js';
import { type RuntimeEvidence, DEFAULT_STARTUP_GRACE_MS, resolveRuntimeStatus } from '../runtime-status.js';

const NOW = new Date('2026-08-28T12:00:00.000Z');

function markerAt(offsetMs: number, overrides: Partial<LocalServerMarker> = {}): LocalServerMarker {
  const startedAt = new Date(NOW.getTime() - offsetMs).toISOString();
  return {
    instanceId: 'instance-a',
    pid: 4242,
    startedAt,
    host: '127.0.0.1',
    port: 3001,
    url: 'http://localhost:3001',
    installMode: 'git',
    appRoot: '/opt/cloudcli',
    version: '1.37.2',
    updatedAt: startedAt,
    ...overrides,
  };
}

function health(instanceId: string | null): RuntimeHealth {
  return { instanceId, startedAt: '2026-08-28T11:59:00.000Z' };
}

function resolve(evidence: Partial<RuntimeEvidence>, intent?: Parameters<typeof resolveRuntimeStatus>[0]['intent']) {
  return resolveRuntimeStatus({
    evidence: { marker: null, health: null, processAlive: null, ...evidence },
    intent,
    now: NOW,
  });
}

test('no marker and no answer is a stopped runtime', () => {
  const status = resolve({});

  assert.equal(status.state, 'stopped');
  assert.equal(status.reason, 'no-runtime');
  assert.equal(status.ownedByMarker, false);
});

test('matching marker and health identities prove the runtime is ours', () => {
  const status = resolve({ marker: markerAt(60_000), health: health('instance-a') });

  assert.equal(status.state, 'online');
  assert.equal(status.reason, 'verified');
  assert.equal(status.ownedByMarker, true);
  assert.equal(status.url, 'http://localhost:3001');
  assert.equal(status.pid, 4242);
});

test('a different CloudCLI instance on our port is an error, never online', () => {
  const status = resolve({ marker: markerAt(60_000), health: health('instance-z') });

  assert.equal(status.state, 'error');
  assert.equal(status.reason, 'instance-mismatch');
  assert.equal(status.ownedByMarker, false);
  assert.equal(status.instanceId, 'instance-z');
});

test('a server too old to publish an identity is online but not claimed as ours', () => {
  const status = resolve({ marker: markerAt(60_000), health: health(null) });

  assert.equal(status.state, 'online');
  assert.equal(status.reason, 'unverified-identity');
  assert.equal(status.ownedByMarker, false);
});

test('a marker with no identity cannot claim a healthy server either', () => {
  const status = resolve({ marker: markerAt(60_000, { instanceId: '' }), health: health('instance-a') });

  assert.equal(status.state, 'online');
  assert.equal(status.reason, 'unverified-identity');
  assert.equal(status.ownedByMarker, false);
});

test('a healthy server without any marker is reported but not owned', () => {
  const status = resolve({ health: health('instance-a') });

  assert.equal(status.state, 'online');
  assert.equal(status.reason, 'foreign-instance');
  assert.equal(status.ownedByMarker, false);
  assert.equal(status.pid, null);
});

test('a young silent marker reads as starting, not as offline', () => {
  const status = resolve({ marker: markerAt(DEFAULT_STARTUP_GRACE_MS - 1_000), processAlive: true });

  assert.equal(status.state, 'starting');
  assert.equal(status.reason, 'awaiting-health');
});

test('a live process that never became healthy is an error, not a slow start', () => {
  const status = resolve({ marker: markerAt(DEFAULT_STARTUP_GRACE_MS + 1_000), processAlive: true });

  assert.equal(status.state, 'error');
  assert.equal(status.reason, 'health-timeout');
});

test('a dead process settles the state even inside the startup grace window', () => {
  const status = resolve({ marker: markerAt(1_000), processAlive: false });

  assert.equal(status.state, 'stopped');
  assert.equal(status.reason, 'stale-marker');
});

test('an old marker with unverifiable liveness reads as stopped, and says so', () => {
  const status = resolve({ marker: markerAt(DEFAULT_STARTUP_GRACE_MS + 1_000), processAlive: null });

  assert.equal(status.state, 'stopped');
  assert.equal(status.reason, 'stale-marker-unverified');
});

test('a marker with an unparseable start time is never treated as still starting', () => {
  const status = resolve({ marker: markerAt(0, { startedAt: '', updatedAt: '' }), processAlive: true });

  assert.equal(status.state, 'error');
  assert.equal(status.reason, 'health-timeout');
});

test('a pending start holds STARTING while the runtime has not appeared yet', () => {
  const status = resolve(
    {},
    { kind: 'start', since: new Date(NOW.getTime() - 5_000).toISOString(), deadlineMs: 60_000 },
  );

  assert.equal(status.state, 'starting');
  assert.equal(status.reason, 'start-pending');
});

test('a pending start never reports ONLINE without a healthy answer', () => {
  const status = resolve(
    { marker: markerAt(1_000), processAlive: true },
    { kind: 'start', since: NOW.toISOString(), deadlineMs: 60_000 },
  );

  assert.notEqual(status.state, 'online');
});

test('a pending start resolves to ONLINE once identity is confirmed', () => {
  const status = resolve(
    { marker: markerAt(2_000), health: health('instance-a') },
    { kind: 'start', since: NOW.toISOString(), deadlineMs: 60_000 },
  );

  assert.equal(status.state, 'online');
  assert.equal(status.reason, 'verified');
});

test('a start that runs past its deadline fails instead of spinning', () => {
  const status = resolve(
    {},
    { kind: 'start', since: new Date(NOW.getTime() - 61_000).toISOString(), deadlineMs: 60_000 },
  );

  assert.equal(status.state, 'error');
  assert.equal(status.reason, 'start-timeout');
});

test('a start blocked by another instance reports that reason immediately', () => {
  const status = resolve(
    { marker: markerAt(60_000), health: health('instance-z') },
    { kind: 'start', since: NOW.toISOString(), deadlineMs: 60_000 },
  );

  assert.equal(status.state, 'error');
  assert.equal(status.reason, 'instance-mismatch');
});

test('a pending stop shows STOPPING while the runtime still answers', () => {
  const status = resolve(
    { marker: markerAt(60_000), health: health('instance-a') },
    { kind: 'stop', since: new Date(NOW.getTime() - 1_000).toISOString(), deadlineMs: 15_000 },
  );

  assert.equal(status.state, 'stopping');
  assert.equal(status.reason, 'stop-pending');
});

test('a stop completes as soon as the runtime is observably gone', () => {
  const status = resolve(
    { marker: markerAt(60_000), processAlive: false },
    { kind: 'stop', since: NOW.toISOString(), deadlineMs: 15_000 },
  );

  assert.equal(status.state, 'stopped');
  assert.equal(status.reason, 'stale-marker');
});

test('a stop that outlives its deadline surfaces as an error', () => {
  const status = resolve(
    { marker: markerAt(60_000), health: health('instance-a') },
    { kind: 'stop', since: new Date(NOW.getTime() - 20_000).toISOString(), deadlineMs: 15_000 },
  );

  assert.equal(status.state, 'error');
  assert.equal(status.reason, 'stop-timeout');
});
