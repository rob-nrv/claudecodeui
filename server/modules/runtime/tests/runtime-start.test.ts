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
  // One poll finds it online, then two more agreeing observations confirm it
  // before the outcome is reported as started.
  assert.deepEqual(harness.events, ['status', 'launch', 'status', 'status', 'status']);
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

test('a process that appears then disappears before ever answering health never reports started', async () => {
  // The marker is written and the port briefly reads as starting — then the
  // child dies before /health ever answers once. This must fail the same way
  // as a process that never appeared at all, never as a success.
  const harness = createHarness({
    initialStatus: STOPPED,
    statuses: [STARTING, STOPPED],
  });

  const result = await harness.service.start({ timeoutMs: 2_000, pollIntervalMs: 500 });

  assert.equal(result.outcome, 'start-timeout');
  assert.equal(result.newInstanceId, null);
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

test('an instance that answers a health check once and is gone on the next look is not reported as started', async () => {
  // This is the exact shape of the real bug: `start` sees ONLINE, and the very
  // next status read — same as a user immediately running `runtime status` —
  // finds the process already gone.
  const harness = createHarness({
    initialStatus: STOPPED,
    statuses: [
      status({ instanceId: 'instance-b' }),
      STOPPED,
    ],
  });

  const result = await harness.service.start();

  assert.equal(result.outcome, 'unstable');
  assert.equal(result.newInstanceId, null);
  assert.equal(harness.events.filter((event) => event === 'launch').length, 1);
});

test('a marker that goes stale mid-confirmation is not reported as started', async () => {
  const STALE_MARKER = status({
    state: 'stopped',
    reason: 'stale-marker',
    ownedByMarker: false,
    instanceId: null,
    url: null,
    pid: null,
  });
  const harness = createHarness({
    initialStatus: STOPPED,
    statuses: [status({ instanceId: 'instance-b' }), STALE_MARKER],
  });

  const result = await harness.service.start();

  assert.equal(result.outcome, 'unstable');
  assert.equal(result.status.reason, 'stale-marker');
});

test('an instance whose identity changes mid-confirmation is not reported as started', async () => {
  // A foreign process taking the port between the first sighting and the
  // confirmation checks must fail confirmation, not read as a verified start.
  const harness = createHarness({
    initialStatus: STOPPED,
    statuses: [
      status({ instanceId: 'instance-b' }),
      status({ instanceId: 'instance-c', reason: 'instance-mismatch', state: 'error', ownedByMarker: false }),
    ],
  });

  const result = await harness.service.start();

  assert.equal(result.outcome, 'unstable');
  assert.equal(result.newInstanceId, null);
});

test('a start attempt launches exactly once regardless of how many status polls it takes', async () => {
  const harness = createHarness({
    initialStatus: STOPPED,
    statuses: [STARTING, STARTING, status({ instanceId: 'instance-b' })],
  });

  const result = await harness.service.start({ timeoutMs: 90_000, pollIntervalMs: 500 });

  assert.equal(result.outcome, 'started');
  assert.equal(result.newInstanceId, 'instance-b');
  assert.equal(harness.events.filter((event) => event === 'launch').length, 1);
});
