import assert from 'node:assert/strict';
import test from 'node:test';

import { confirmStableOnline } from '../runtime-stability.js';
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

test('an instance that keeps answering online with the same identity is stable', async () => {
  const waits: number[] = [];
  const result = await confirmStableOnline(
    status(),
    {
      status: async () => status(),
      wait: async (ms) => {
        waits.push(ms);
      },
    },
  );

  assert.equal(result.stable, true);
  assert.equal(result.status.instanceId, 'instance-a');
  assert.equal(waits.length, 2);
});

test('an instance that goes offline mid-confirmation is not stable', async () => {
  const readings = [status({ state: 'stopped', reason: 'stale-marker', instanceId: null, url: null, pid: null })];
  let index = 0;

  const result = await confirmStableOnline(
    status(),
    {
      status: async () => readings[Math.min(index++, readings.length - 1)],
      wait: async () => {},
    },
  );

  assert.equal(result.stable, false);
  assert.equal(result.status.state, 'stopped');
});

test('an instance whose identity changes mid-confirmation is not stable', async () => {
  const result = await confirmStableOnline(
    status({ instanceId: 'instance-a' }),
    {
      status: async () => status({ instanceId: 'instance-z' }),
      wait: async () => {},
    },
  );

  assert.equal(result.stable, false);
  assert.equal(result.status.instanceId, 'instance-z');
});

test('the number of confirmation checks is configurable and bounded', async () => {
  let calls = 0;

  await confirmStableOnline(
    status(),
    {
      status: async () => {
        calls += 1;
        return status();
      },
      wait: async () => {},
    },
    { checks: 5 },
  );

  assert.equal(calls, 5);
});
