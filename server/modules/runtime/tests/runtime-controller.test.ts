import assert from 'node:assert/strict';
import test from 'node:test';

import { createRuntimeController } from '../runtime-controller.service.js';
import type { LocalServerMarker } from '../runtime-marker.js';
import type { RuntimeEvidence } from '../runtime-status.js';

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

const ONLINE: RuntimeEvidence = {
  marker: MARKER,
  health: { instanceId: 'instance-a', startedAt: MARKER.startedAt },
  processAlive: null,
};
const GONE: RuntimeEvidence = { marker: null, health: null, processAlive: null };

/**
 * Drives the controller against a scripted sequence of observations, with a
 * clock that only advances when the controller waits. Every stop path is
 * therefore deterministic and instant.
 */
function createHarness(observations: RuntimeEvidence[]) {
  const signals: Array<{ pid: number; signal: string }> = [];
  const waits: number[] = [];
  let clock = new Date('2026-08-28T12:00:00.000Z').getTime();
  let index = 0;

  const controller = createRuntimeController({
    probe: {
      collect: async () => observations[Math.min(index++, observations.length - 1)],
    },
    sendSignal: (pid, signal) => {
      signals.push({ pid, signal });
    },
    wait: async (milliseconds) => {
      waits.push(milliseconds);
      clock += milliseconds;
    },
    now: () => new Date(clock),
  });

  return { controller, signals, waits, advance: (ms: number) => { clock += ms; } };
}

test('status reports the resolved state without signalling anything', async () => {
  const harness = createHarness([ONLINE]);

  const status = await harness.controller.status();

  assert.equal(status.state, 'online');
  assert.equal(status.ownedByMarker, true);
  assert.deepEqual(harness.signals, []);
});

test('stopping an already stopped runtime signals nothing and succeeds', async () => {
  const harness = createHarness([GONE]);

  const result = await harness.controller.stop();

  assert.equal(result.outcome, 'already-stopped');
  assert.deepEqual(harness.signals, []);
  assert.equal(result.signalled, null);
});

test('a graceful stop signals the marker pid once and confirms it went away', async () => {
  const harness = createHarness([ONLINE, GONE]);

  const result = await harness.controller.stop();

  assert.equal(result.outcome, 'stopped');
  assert.deepEqual(harness.signals, [{ pid: 4242, signal: 'SIGTERM' }]);
  assert.deepEqual(result.signalled, { instanceId: 'instance-a', pid: 4242 });
  assert.equal(result.status.state, 'stopped');
});

test('a runtime we cannot prove is ours is never signalled', async () => {
  // A different CloudCLI holds the port: ownedByMarker is false, so stopping it
  // would mean killing a process this installation did not start.
  const foreign: RuntimeEvidence = {
    marker: MARKER,
    health: { instanceId: 'instance-z', startedAt: null },
    processAlive: null,
  };
  const harness = createHarness([foreign]);

  const result = await harness.controller.stop();

  assert.equal(result.outcome, 'refused-not-owned');
  assert.deepEqual(harness.signals, []);
  assert.equal(result.status.reason, 'instance-mismatch');
});

test('a server too old to publish an identity is left alone rather than guessed at', async () => {
  const unverified: RuntimeEvidence = {
    marker: MARKER,
    health: { instanceId: null, startedAt: null },
    processAlive: null,
  };
  const harness = createHarness([unverified]);

  const result = await harness.controller.stop();

  assert.equal(result.outcome, 'refused-not-owned');
  assert.deepEqual(harness.signals, []);
});

test('a marker-less server on the port is reported but never signalled', async () => {
  const foreign: RuntimeEvidence = {
    marker: null,
    health: { instanceId: 'instance-z', startedAt: null },
    processAlive: null,
  };
  const harness = createHarness([foreign]);

  const result = await harness.controller.stop();

  assert.equal(result.outcome, 'refused-not-owned');
  assert.deepEqual(harness.signals, []);
});

test('a failed signal is reported instead of being retried or escalated', async () => {
  const harness = createHarness([ONLINE, GONE]);
  const controller = createRuntimeController({
    probe: { collect: async () => ONLINE },
    sendSignal: () => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    },
    wait: async () => undefined,
    now: () => new Date('2026-08-28T12:00:00.000Z'),
  });

  const result = await controller.stop();

  assert.equal(result.outcome, 'signal-failed');
  assert.deepEqual(result.signalled, { instanceId: 'instance-a', pid: 4242 });
  assert.deepEqual(harness.signals, []);
});

test('a runtime that outlives the stop timeout fails without escalating to SIGKILL', async () => {
  const harness = createHarness([ONLINE]);

  const result = await harness.controller.stop({ timeoutMs: 1_000, pollIntervalMs: 250 });

  assert.equal(result.outcome, 'timeout');
  assert.equal(result.status.state, 'error');
  assert.equal(result.status.reason, 'stop-timeout');
  // One SIGTERM, and only SIGTERM.
  assert.deepEqual(harness.signals, [{ pid: 4242, signal: 'SIGTERM' }]);
  assert.deepEqual(harness.waits, [250, 250, 250, 250]);
});

test('a stop waits out a slow but successful shutdown', async () => {
  const harness = createHarness([ONLINE, ONLINE, ONLINE, GONE]);

  const result = await harness.controller.stop({ timeoutMs: 5_000, pollIntervalMs: 500 });

  assert.equal(result.outcome, 'stopped');
  assert.deepEqual(harness.waits, [500, 500, 500]);
  assert.deepEqual(harness.signals, [{ pid: 4242, signal: 'SIGTERM' }]);
});

test('a stale marker left behind by a dead server counts as stopped', async () => {
  const stale: RuntimeEvidence = { marker: MARKER, health: null, processAlive: false };
  const harness = createHarness([stale]);

  const result = await harness.controller.stop();

  assert.equal(result.outcome, 'already-stopped');
  assert.deepEqual(harness.signals, []);
});
