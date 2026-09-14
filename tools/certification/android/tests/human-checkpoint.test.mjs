import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatHumanActionBanner,
  promptAndConfirm,
  runHumanCheckpoint,
  waitForObservableOutcome,
} from '../lib/human-checkpoint.mjs';

function fakeClock(startAt = 0) {
  let current = startAt;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

test('formatHumanActionBanner produces the fixed large-banner shape from the mission brief', () => {
  const banner = formatHumanActionBanner({ title: 'Turn airplane mode ON now.', instructions: 'Waiting for disconnect...' });
  const lines = banner.split('\n');
  assert.equal(lines[0], '='.repeat(50));
  assert.equal(lines[1], 'HUMAN ACTION REQUIRED');
  assert.equal(lines[2], 'Turn airplane mode ON now.');
  assert.equal(lines[3], 'Waiting for disconnect...');
  assert.equal(lines[4], '='.repeat(50));
});

test('formatHumanActionBanner accepts multiple instruction lines', () => {
  const banner = formatHumanActionBanner({ title: 'Lock the Pixel screen now.', instructions: ['Do not unlock for 5 minutes.', 'Timer started.'] });
  assert.deepEqual(banner.split('\n').slice(3, 5), ['Do not unlock for 5 minutes.', 'Timer started.']);
});

test('promptAndConfirm writes the banner once and resolves only after readLine resolves', async () => {
  const written = [];
  let readLineCalled = false;
  const readLine = async () => {
    readLineCalled = true;
  };
  const clock = fakeClock(1000);
  const result = await promptAndConfirm({ banner: 'BANNER TEXT', readLine, now: clock.now, write: (text) => written.push(text) });
  assert.deepEqual(written, ['BANNER TEXT\n']);
  assert.equal(readLineCalled, true);
  assert.equal(result.confirmedAt, 1000);
});

test('waitForObservableOutcome returns "detected" as soon as detect() reports a non-null result, without waiting out the full timeout', async () => {
  const clock = fakeClock();
  let calls = 0;
  const detect = async () => {
    calls += 1;
    return calls >= 3 ? { reconnected: true } : null;
  };
  const ticks = [];
  const result = await waitForObservableOutcome({
    detect,
    timeoutMs: 100_000,
    pollIntervalMs: 500,
    now: clock.now,
    sleep: async (ms) => clock.advance(ms),
    onTick: (elapsed) => ticks.push(elapsed),
  });
  assert.deepEqual(result, { outcome: 'detected', elapsedMs: 1000, detail: { reconnected: true } });
  assert.equal(calls, 3);
  assert.deepEqual(ticks, [0, 500]);
});

test('waitForObservableOutcome times out explicitly when detect() never reports a result', async () => {
  const clock = fakeClock();
  const result = await waitForObservableOutcome({
    detect: async () => null,
    timeoutMs: 3_000,
    pollIntervalMs: 1_000,
    now: clock.now,
    sleep: async (ms) => clock.advance(ms),
  });
  assert.deepEqual(result, { outcome: 'timed_out', elapsedMs: 3_000, detail: null });
});

test('waitForObservableOutcome never calls detect after the timeout boundary — no late false "detected"', async () => {
  const clock = fakeClock();
  let callsAfterTimeout = 0;
  const detect = async () => {
    if (clock.now() >= 2_000) callsAfterTimeout += 1;
    return null;
  };
  await waitForObservableOutcome({ detect, timeoutMs: 2_000, pollIntervalMs: 1_000, now: clock.now, sleep: async (ms) => clock.advance(ms) });
  assert.equal(callsAfterTimeout, 0);
});

test('runHumanCheckpoint chains confirm -> observe, and the elapsed time is measured from confirmation, not from process start', async () => {
  const clock = fakeClock(5_000);
  let detectCalls = 0;
  const result = await runHumanCheckpoint({
    banner: 'B',
    readLine: async () => undefined,
    write: () => undefined,
    detect: async () => {
      detectCalls += 1;
      return detectCalls >= 2 ? { ok: true } : null;
    },
    timeoutMs: 60_000,
    pollIntervalMs: 1_000,
    now: clock.now,
    sleep: async (ms) => clock.advance(ms),
  });
  assert.equal(result.outcome, 'detected');
  assert.equal(result.confirmedAt, 5_000);
  assert.equal(result.elapsedMs, 1_000);
});

test('runHumanCheckpoint fails closed as "error" (never mistaken for a timeout or a detection) when detect() throws', async () => {
  const clock = fakeClock();
  const result = await runHumanCheckpoint({
    banner: 'B',
    readLine: async () => undefined,
    write: () => undefined,
    detect: async () => {
      throw new Error('agent.log unreadable');
    },
    timeoutMs: 10_000,
    now: clock.now,
    sleep: async (ms) => clock.advance(ms),
  });
  assert.equal(result.outcome, 'error');
  assert.match(result.error, /agent\.log unreadable/);
});
