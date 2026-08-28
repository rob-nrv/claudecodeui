import assert from 'node:assert/strict';
import test from 'node:test';

import type { LocalServerMarker } from '../runtime-marker.js';
import { resolveHealthUrl } from '../runtime-marker.js';
import { type RuntimeProbeDependencies, createRuntimeProbe } from '../runtime-probe.js';

const MARKER: LocalServerMarker = {
  instanceId: 'instance-a',
  pid: 4242,
  startedAt: '2026-08-28T10:00:00.000Z',
  host: '127.0.0.1',
  port: 3001,
  url: 'http://localhost:3001',
  installMode: 'git',
  appRoot: '/opt/cloudcli',
  version: '1.37.2',
  updatedAt: '2026-08-28T10:00:00.000Z',
};

const HEALTHY = { status: 'ok', installMode: 'git', runtime: { instanceId: 'instance-a', startedAt: MARKER.startedAt } };

function createProbe(overrides: Partial<RuntimeProbeDependencies> = {}) {
  return createRuntimeProbe({
    readMarker: async () => MARKER,
    fetchHealth: async () => HEALTHY,
    isProcessAlive: () => true,
    ...overrides,
  });
}

test('health is probed over loopback, not over the display host in the marker', () => {
  // marker.url says "localhost", which can resolve to ::1 while the server bound
  // 127.0.0.1 — probing it would report a healthy runtime as unreachable.
  assert.equal(resolveHealthUrl(MARKER), 'http://127.0.0.1:3001/health');
  assert.equal(resolveHealthUrl({ host: 'localhost', port: 3001 }), 'http://127.0.0.1:3001/health');
  assert.equal(resolveHealthUrl({ host: '0.0.0.0', port: 8080 }), 'http://127.0.0.1:8080/health');
  assert.equal(resolveHealthUrl({ host: '::', port: 8080 }), 'http://127.0.0.1:8080/health');
  assert.equal(resolveHealthUrl({ host: '::1', port: 8080 }), 'http://[::1]:8080/health');
  assert.equal(resolveHealthUrl({ host: '192.168.1.4', port: 3001 }), 'http://192.168.1.4:3001/health');
});

test('the marker address is the one probed', async () => {
  const probed: string[] = [];
  const probe = createProbe({
    fetchHealth: async (healthUrl) => {
      probed.push(healthUrl);
      return HEALTHY;
    },
  });

  await probe.collect();

  assert.deepEqual(probed, ['http://127.0.0.1:3001/health']);
});

test('liveness is not checked when the runtime already answered', async () => {
  let livenessChecks = 0;
  const probe = createProbe({
    isProcessAlive: () => {
      livenessChecks += 1;
      return true;
    },
  });

  const evidence = await probe.collect();

  assert.equal(livenessChecks, 0);
  assert.equal(evidence.processAlive, null);
  assert.equal(evidence.health?.instanceId, 'instance-a');
});

test('liveness is checked only once health is silent', async () => {
  const checked: number[] = [];
  const probe = createProbe({
    fetchHealth: async () => {
      throw new Error('ECONNREFUSED');
    },
    isProcessAlive: (pid) => {
      checked.push(pid);
      return false;
    },
  });

  const evidence = await probe.collect();

  assert.deepEqual(checked, [4242]);
  assert.equal(evidence.processAlive, false);
  assert.equal(evidence.health, null);
});

test('a rejected health request degrades to no evidence rather than throwing', async () => {
  const probe = createProbe({ fetchHealth: async () => { throw new Error('timed out'); } });

  const evidence = await probe.collect();

  assert.equal(evidence.health, null);
  assert.notEqual(evidence.marker, null);
});

test('a non-CloudCLI responder is not accepted as health evidence', async () => {
  const probe = createProbe({ fetchHealth: async () => ({ status: 'ok' }) });

  assert.equal((await probe.collect()).health, null);
});

test('without a marker nothing is probed unless a fallback address is given', async () => {
  let calls = 0;
  const probe = createProbe({
    readMarker: async () => null,
    fetchHealth: async () => {
      calls += 1;
      return HEALTHY;
    },
  });

  const evidence = await probe.collect();

  assert.equal(calls, 0);
  assert.deepEqual(evidence, { marker: null, health: null, processAlive: null });
});

test('the fallback address finds a running server that left no marker', async () => {
  const probed: string[] = [];
  const probe = createProbe({
    readMarker: async () => null,
    fetchHealth: async (healthUrl) => {
      probed.push(healthUrl);
      return HEALTHY;
    },
  });

  const evidence = await probe.collect({ fallbackHealthUrl: 'http://127.0.0.1:3001/health' });

  assert.deepEqual(probed, ['http://127.0.0.1:3001/health']);
  assert.equal(evidence.health?.instanceId, 'instance-a');
  assert.equal(evidence.marker, null);
});
