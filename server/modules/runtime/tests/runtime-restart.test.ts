import assert from 'node:assert/strict';
import test from 'node:test';

import type { RuntimeStopResult } from '../runtime-controller.service.js';
import { createRuntimeRestartService } from '../runtime-restart.service.js';
import type { RuntimeStatus } from '../runtime-status.js';

function status(overrides: Partial<RuntimeStatus> = {}): RuntimeStatus {
  return {
    state: 'online',
    reason: 'verified',
    ownedByMarker: true,
    instanceId: 'instance-a',
    url: 'http://localhost:3001',
    pid: 4242,
    ...overrides,
  };
}

const STOPPED = status({ state: 'stopped', reason: 'no-runtime', ownedByMarker: false, instanceId: null, url: null, pid: null });

const STOP_SUCCEEDED: RuntimeStopResult = {
  outcome: 'stopped',
  status: STOPPED,
  signalled: { instanceId: 'instance-a', pid: 4242 },
};

const NOTHING_TO_STOP: RuntimeStopResult = {
  outcome: 'already-stopped',
  status: STOPPED,
  signalled: null,
};

/** Scripts the observations the restart sees, with a clock that only moves when it waits. */
function createHarness(options: {
  stopResult?: RuntimeStopResult;
  statuses?: RuntimeStatus[];
  launchError?: Error;
}) {
  const statuses = options.statuses ?? [];
  const events: string[] = [];
  let clock = new Date('2026-08-28T12:00:00.000Z').getTime();
  let index = 0;

  const service = createRuntimeRestartService({
    controller: {
      status: async () => {
        events.push('status');
        return statuses[Math.min(index++, statuses.length - 1)] ?? STOPPED;
      },
      stop: async () => {
        events.push('stop');
        return options.stopResult ?? STOP_SUCCEEDED;
      },
    },
    launch: async () => {
      events.push('launch');
      if (options.launchError) throw options.launchError;
    },
    wait: async (milliseconds) => {
      clock += milliseconds;
    },
    now: () => new Date(clock),
  });

  return { service, events };
}

test('a restart stops first, then launches, and confirms a different instance answered', async () => {
  const harness = createHarness({ statuses: [status({ instanceId: 'instance-b' })] });

  const result = await harness.service.restart();

  assert.equal(result.outcome, 'restarted');
  assert.equal(result.previousInstanceId, 'instance-a');
  assert.equal(result.newInstanceId, 'instance-b');
  assert.deepEqual(harness.events.slice(0, 2), ['stop', 'launch']);
});

test('nothing running is a start, not a restart', async () => {
  const harness = createHarness({
    stopResult: NOTHING_TO_STOP,
    statuses: [status({ instanceId: 'instance-b' })],
  });

  const result = await harness.service.restart();

  assert.equal(result.outcome, 'started');
  assert.equal(result.previousInstanceId, null);
  assert.equal(result.newInstanceId, 'instance-b');
});

test('an old process that survived SIGTERM is caught instead of passing as a restart', async () => {
  // The port is still held by the instance we thought we replaced. Without the
  // identity check this reads as a clean success and the user keeps running the
  // old build believing it was updated.
  const harness = createHarness({ statuses: [status({ instanceId: 'instance-a' })] });

  const result = await harness.service.restart();

  assert.equal(result.outcome, 'same-instance');
  assert.equal(result.newInstanceId, 'instance-a');
});

test('a runtime that could not be stopped is never followed by a launch', async () => {
  const harness = createHarness({
    stopResult: { outcome: 'refused-not-owned', status: status(), signalled: null },
  });

  const result = await harness.service.restart();

  assert.equal(result.outcome, 'stop-failed');
  assert.equal(harness.events.includes('launch'), false);
});

test('a stop timeout blocks the restart rather than starting a second server', async () => {
  const harness = createHarness({
    stopResult: {
      outcome: 'timeout',
      status: status({ state: 'error', reason: 'stop-timeout' }),
      signalled: { instanceId: 'instance-a', pid: 4242 },
    },
  });

  const result = await harness.service.restart();

  assert.equal(result.outcome, 'stop-failed');
  assert.equal(result.previousInstanceId, 'instance-a');
  assert.equal(harness.events.includes('launch'), false);
});

test('a launcher failure is reported with its reason and no health polling', async () => {
  const harness = createHarness({
    launchError: new Error('CloudCLI has not been built yet (/app/dist-server/server/index.js is missing). Run "npm run build" first.'),
  });

  const result = await harness.service.restart();

  assert.equal(result.outcome, 'launch-failed');
  assert.match(result.launchError ?? '', /has not been built yet/);
  assert.deepEqual(harness.events, ['stop', 'launch']);
});

test('a replacement that never becomes healthy times out instead of looping forever', async () => {
  const harness = createHarness({ statuses: [STOPPED] });

  const result = await harness.service.restart({ timeoutMs: 2_000, pollIntervalMs: 500 });

  assert.equal(result.outcome, 'start-timeout');
  assert.equal(result.status.state, 'error');
  assert.equal(result.status.reason, 'start-timeout');
  // Exactly one launch: a failed restart must never turn into a restart loop.
  assert.equal(harness.events.filter((event) => event === 'launch').length, 1);
});

test('a slow replacement is waited for rather than declared failed early', async () => {
  const harness = createHarness({
    statuses: [
      STOPPED,
      status({ state: 'starting', reason: 'awaiting-health', ownedByMarker: false, instanceId: 'instance-b' }),
      status({ instanceId: 'instance-b' }),
    ],
  });

  const result = await harness.service.restart({ timeoutMs: 90_000, pollIntervalMs: 500 });

  assert.equal(result.outcome, 'restarted');
  assert.equal(result.newInstanceId, 'instance-b');
  assert.equal(harness.events.filter((event) => event === 'status').length, 3);
});

test('a runtime that comes back without an identity still counts as replaced', async () => {
  // Downgrade path: the replacement is an older build. It answers, its identity
  // is unprovable, but it is demonstrably not the instance we just stopped.
  const harness = createHarness({
    statuses: [status({ reason: 'unverified-identity', ownedByMarker: false, instanceId: null })],
  });

  const result = await harness.service.restart();

  assert.equal(result.outcome, 'restarted');
  assert.equal(result.newInstanceId, null);
});
