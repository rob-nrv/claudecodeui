import assert from 'node:assert/strict';
import test from 'node:test';

import { createRuntimeStartService } from '../runtime-start.service.js';
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
const STARTING = status({ state: 'starting', reason: 'awaiting-health', ownedByMarker: false, instanceId: null });
const FOREIGN_PORT = status({ state: 'error', reason: 'instance-mismatch', ownedByMarker: false, instanceId: 'someone-elses' });

/** Scripts the observations start sees, with a clock that only moves when it waits. */
function createHarness(options: {
  initialStatus?: RuntimeStatus;
  statuses?: RuntimeStatus[];
  launchError?: Error;
}) {
  const statuses = options.statuses ?? [];
  const events: string[] = [];
  let clock = new Date('2026-08-28T12:00:00.000Z').getTime();
  let index = 0;
  let statusCalls = 0;

  const service = createRuntimeStartService({
    controller: {
      status: async () => {
        events.push('status');
        statusCalls += 1;
        if (statusCalls === 1) return options.initialStatus ?? STOPPED;
        return statuses[Math.min(index++, statuses.length - 1)] ?? STOPPED;
      },
      stop: async () => {
        throw new Error('start must never call stop');
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

test('nothing running launches and confirms a verified identity came online', async () => {
  const harness = createHarness({
    initialStatus: STOPPED,
    statuses: [status({ instanceId: 'instance-b' })],
  });

  const result = await harness.service.start();

  assert.equal(result.outcome, 'started');
  assert.equal(result.newInstanceId, 'instance-b');
  assert.deepEqual(harness.events, ['status', 'launch', 'status']);
});

test('an already-online runtime is left alone: no launch attempted', async () => {
  const harness = createHarness({ initialStatus: status() });

  const result = await harness.service.start();

  assert.equal(result.outcome, 'already-running');
  assert.equal(result.newInstanceId, 'instance-a');
  assert.deepEqual(harness.events, ['status']);
});

test('a start already in flight (fresh marker, no health yet) is not duplicated', async () => {
  const harness = createHarness({ initialStatus: STARTING });

  const result = await harness.service.start();

  assert.equal(result.outcome, 'already-starting');
  assert.deepEqual(harness.events, ['status']);
});

test('a port held by an unowned instance is refused, never launched onto', async () => {
  const harness = createHarness({ initialStatus: FOREIGN_PORT });

  const result = await harness.service.start();

  assert.equal(result.outcome, 'blocked-foreign-instance');
  assert.deepEqual(harness.events, ['status']);
});

test('a launcher failure is reported with its reason and no health polling', async () => {
  const harness = createHarness({
    initialStatus: STOPPED,
    launchError: new Error('CloudCLI has not been built yet (/app/dist-server/server/index.js is missing). Run "npm run build" first.'),
  });

  const result = await harness.service.start();

  assert.equal(result.outcome, 'launch-failed');
  assert.match(result.launchError ?? '', /has not been built yet/);
  assert.deepEqual(harness.events, ['status', 'launch']);
});

test('a launch that never becomes healthy times out instead of looping forever', async () => {
  const harness = createHarness({ initialStatus: STOPPED, statuses: [STOPPED] });

  const result = await harness.service.start({ timeoutMs: 2_000, pollIntervalMs: 500 });

  assert.equal(result.outcome, 'start-timeout');
  assert.equal(result.status.state, 'error');
  assert.equal(result.status.reason, 'start-timeout');
  assert.equal(harness.events.filter((event) => event === 'launch').length, 1);
});

test('a slow boot is waited for rather than declared failed early', async () => {
  const harness = createHarness({
    initialStatus: STOPPED,
    statuses: [
      STARTING,
      status({ instanceId: 'instance-b' }),
    ],
  });

  const result = await harness.service.start({ timeoutMs: 90_000, pollIntervalMs: 500 });

  assert.equal(result.outcome, 'started');
  assert.equal(result.newInstanceId, 'instance-b');
});

test('a runtime that comes back without an identity still counts as started', async () => {
  const harness = createHarness({
    initialStatus: STOPPED,
    statuses: [status({ reason: 'unverified-identity', ownedByMarker: false, instanceId: null })],
  });

  const result = await harness.service.start();

  assert.equal(result.outcome, 'started');
  assert.equal(result.newInstanceId, null);
});

test('start never calls stop, unlike restart', async () => {
  const harness = createHarness({ initialStatus: STOPPED, statuses: [status()] });

  await harness.service.start();

  assert.equal(harness.events.includes('stop'), false);
});
