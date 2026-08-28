import assert from 'node:assert/strict';
import test from 'node:test';

import type { CliOutput } from '@/shared/types.js';
import type { RuntimeRestartResult, RuntimeStartResult, RuntimeStatus, RuntimeStopResult } from '@/modules/runtime/index.js';

import { createRuntimeCommandService } from '../runtime-command.service.js';

const ONLINE: RuntimeStatus = {
  state: 'online',
  reason: 'verified',
  ownedByMarker: true,
  instanceId: 'instance-a',
  url: 'http://localhost:3001',
  pid: 4242,
};

const STOPPED: RuntimeStatus = {
  state: 'stopped',
  reason: 'no-runtime',
  ownedByMarker: false,
  instanceId: null,
  url: null,
  pid: null,
};

const RESTARTED: RuntimeRestartResult = {
  outcome: 'restarted',
  previousInstanceId: 'instance-a',
  newInstanceId: 'instance-b',
  status: { state: 'online', reason: 'verified', ownedByMarker: true, instanceId: 'instance-b', url: 'http://localhost:3001', pid: 5150 },
  launchError: null,
};

const STARTED: RuntimeStartResult = {
  outcome: 'started',
  newInstanceId: 'instance-b',
  status: { state: 'online', reason: 'verified', ownedByMarker: true, instanceId: 'instance-b', url: 'http://localhost:3001', pid: 5150 },
  launchError: null,
};

function createHarness(overrides: {
  status?: RuntimeStatus;
  stopResult?: RuntimeStopResult;
  restartResult?: RuntimeRestartResult;
  startResult?: RuntimeStartResult;
} = {}) {
  const logMessages: string[] = [];
  const errorMessages: string[] = [];
  const statusCalls: unknown[] = [];
  const stopCalls: unknown[] = [];
  const restartCalls: unknown[] = [];
  const startCalls: unknown[] = [];
  const output: CliOutput = {
    log: (message = '') => logMessages.push(message),
    error: (message = '') => errorMessages.push(message),
  };

  const service = createRuntimeCommandService({
    output,
    fallbackHealthUrl: 'http://127.0.0.1:3001/health',
    controller: {
      status: async (options) => {
        statusCalls.push(options);
        return overrides.status ?? ONLINE;
      },
      stop: async (options) => {
        stopCalls.push(options);
        return overrides.stopResult ?? { outcome: 'stopped', status: STOPPED, signalled: { instanceId: 'instance-a', pid: 4242 } };
      },
    },
    restartService: {
      restart: async (options) => {
        restartCalls.push(options);
        return overrides.restartResult ?? RESTARTED;
      },
    },
    startService: {
      start: async (options) => {
        startCalls.push(options);
        return overrides.startResult ?? STARTED;
      },
    },
  });

  return { service, logMessages, errorMessages, statusCalls, stopCalls, restartCalls, startCalls };
}

test('status --json emits the RuntimeStatus contract verbatim for a wrapper app', async () => {
  const harness = createHarness();

  const exitCode = await harness.service.execute(['status', '--json']);

  assert.equal(exitCode, 0);
  assert.equal(harness.logMessages.length, 1);
  assert.deepEqual(JSON.parse(harness.logMessages[0]), ONLINE);
});

test('status always exits 0 so an offline runtime never reads as a crashed command', async () => {
  const harness = createHarness({ status: STOPPED });

  assert.equal(await harness.service.execute(['status', '--json']), 0);
});

test('human status explains the state without printing a reason code', async () => {
  const harness = createHarness({
    status: { ...STOPPED, reason: 'stale-marker-unverified' },
  });

  await harness.service.execute(['status']);
  const printed = harness.logMessages.join('\n');

  assert.match(printed, /STOPPED/);
  assert.match(printed, /looks left over from an earlier run/);
  assert.doesNotMatch(printed, /stale-marker-unverified/);
});

test('the fallback address is passed through so a marker-less server is still found', async () => {
  const harness = createHarness();

  await harness.service.execute(['status']);

  assert.deepEqual(harness.statusCalls, [{ fallbackHealthUrl: 'http://127.0.0.1:3001/health' }]);
});

test('stop exits 0 when the runtime stopped', async () => {
  const harness = createHarness();

  assert.equal(await harness.service.execute(['stop']), 0);
  assert.match(harness.logMessages.join('\n'), /CloudCLI stopped/);
});

test('stop exits 0 when there was nothing to stop', async () => {
  const harness = createHarness({
    stopResult: { outcome: 'already-stopped', status: STOPPED, signalled: null },
  });

  assert.equal(await harness.service.execute(['stop']), 0);
  assert.match(harness.logMessages.join('\n'), /was not running/);
});

test('stop exits 1 and explains itself when it refuses to signal a runtime it does not own', async () => {
  const harness = createHarness({
    stopResult: {
      outcome: 'refused-not-owned',
      status: { ...ONLINE, reason: 'instance-mismatch', state: 'error', ownedByMarker: false },
      signalled: null,
    },
  });

  assert.equal(await harness.service.execute(['stop']), 1);
  assert.match(harness.logMessages.join('\n'), /cannot confirm it started it, so it was left alone/);
});

test('stop exits 1 on timeout', async () => {
  const harness = createHarness({
    stopResult: {
      outcome: 'timeout',
      status: { ...ONLINE, state: 'error', reason: 'stop-timeout' },
      signalled: { instanceId: 'instance-a', pid: 4242 },
    },
  });

  assert.equal(await harness.service.execute(['stop', '--timeout', '4000']), 1);
  assert.match(harness.logMessages.join('\n'), /did not stop within 4s/);
});

test('--timeout is forwarded, and a nonsense value falls back to the default', async () => {
  const harness = createHarness();

  await harness.service.execute(['stop', '--timeout=8000']);
  await harness.service.execute(['stop', '--timeout', 'soon']);
  await harness.service.execute(['stop', '--timeout', '-5']);

  assert.deepEqual(harness.stopCalls, [
    { fallbackHealthUrl: 'http://127.0.0.1:3001/health', timeoutMs: 8000 },
    { fallbackHealthUrl: 'http://127.0.0.1:3001/health', timeoutMs: undefined },
    { fallbackHealthUrl: 'http://127.0.0.1:3001/health', timeoutMs: undefined },
  ]);
});

test('stop --json emits the full result including what was signalled', async () => {
  const harness = createHarness();

  await harness.service.execute(['stop', '--json']);

  assert.deepEqual(JSON.parse(harness.logMessages[0]), {
    outcome: 'stopped',
    status: STOPPED,
    signalled: { instanceId: 'instance-a', pid: 4242 },
  });
});

test('an unknown or missing subcommand exits 1 with usage', async () => {
  const harness = createHarness();

  assert.equal(await harness.service.execute(['reboot']), 1);
  assert.equal(await harness.service.execute([]), 1);
  assert.match(harness.errorMessages.join('\n'), /Unknown runtime command: reboot/);
  assert.match(harness.errorMessages.join('\n'), /Unknown runtime command: \(none\)/);
  assert.match(harness.logMessages.join('\n'), /cloudcli runtime status/);
});

test('start exits 0 and reports the new instance', async () => {
  const harness = createHarness();

  assert.equal(await harness.service.execute(['start']), 0);
  assert.match(harness.logMessages.join('\n'), /CloudCLI started/);
  assert.deepEqual(harness.startCalls, [
    { fallbackHealthUrl: 'http://127.0.0.1:3001/health', timeoutMs: undefined },
  ]);
});

test('start --json emits the full result', async () => {
  const harness = createHarness();

  await harness.service.execute(['start', '--json', '--timeout=120000']);

  assert.deepEqual(JSON.parse(harness.logMessages[0]), STARTED);
  assert.deepEqual(harness.startCalls, [
    { fallbackHealthUrl: 'http://127.0.0.1:3001/health', timeoutMs: 120000 },
  ]);
});

test('start exits 0 and is a no-op when already running', async () => {
  const harness = createHarness({
    startResult: { ...STARTED, outcome: 'already-running', newInstanceId: 'instance-a' },
  });

  assert.equal(await harness.service.execute(['start']), 0);
  assert.match(harness.logMessages.join('\n'), /already running/);
});

test('start exits 1 without launching a second server onto a foreign-held port', async () => {
  const harness = createHarness({
    startResult: { ...STARTED, outcome: 'blocked-foreign-instance', newInstanceId: null },
  });

  assert.equal(await harness.service.execute(['start']), 1);
  assert.match(harness.logMessages.join('\n'), /unverified process is using this port/);
});

test('start surfaces a launch failure the same way restart does', async () => {
  const harness = createHarness({
    startResult: {
      ...STARTED,
      outcome: 'launch-failed',
      newInstanceId: null,
      launchError: 'CloudCLI has not been built yet (/app/dist-server/server/index.js is missing). Run "npm run build" first.',
    },
  });

  assert.equal(await harness.service.execute(['start']), 1);
  assert.match(harness.logMessages.join('\n'), /has not been built yet/);
});

test('restart exits 0 and reports the new instance', async () => {
  const harness = createHarness();

  assert.equal(await harness.service.execute(['restart']), 0);
  assert.match(harness.logMessages.join('\n'), /CloudCLI restarted/);
  assert.deepEqual(harness.restartCalls, [
    { fallbackHealthUrl: 'http://127.0.0.1:3001/health', timeoutMs: undefined },
  ]);
});

test('restart --json carries both instance ids so a wrapper can verify the swap', async () => {
  const harness = createHarness();

  await harness.service.execute(['restart', '--json', '--timeout=120000']);

  assert.deepEqual(JSON.parse(harness.logMessages[0]), RESTARTED);
  assert.deepEqual(harness.restartCalls, [
    { fallbackHealthUrl: 'http://127.0.0.1:3001/health', timeoutMs: 120000 },
  ]);
});

test('a restart that left the previous instance running exits 1 and says so', async () => {
  const harness = createHarness({
    restartResult: { ...RESTARTED, outcome: 'same-instance', newInstanceId: 'instance-a' },
  });

  assert.equal(await harness.service.execute(['restart']), 1);
  assert.match(harness.logMessages.join('\n'), /previous CloudCLI is still running/);
});

test('a restart blocked by a failed stop exits 1 without claiming anything started', async () => {
  const harness = createHarness({
    restartResult: { ...RESTARTED, outcome: 'stop-failed', newInstanceId: null },
  });

  assert.equal(await harness.service.execute(['restart']), 1);
  assert.match(harness.logMessages.join('\n'), /Could not stop the running CloudCLI/);
});

test('a launch failure surfaces the underlying reason', async () => {
  const harness = createHarness({
    restartResult: {
      ...RESTARTED,
      outcome: 'launch-failed',
      newInstanceId: null,
      launchError: 'CloudCLI has not been built yet (/app/dist-server/server/index.js is missing). Run "npm run build" first.',
    },
  });

  assert.equal(await harness.service.execute(['restart']), 1);
  assert.match(harness.logMessages.join('\n'), /has not been built yet/);
});
