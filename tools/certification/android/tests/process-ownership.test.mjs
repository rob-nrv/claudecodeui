import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isSafeKillCommand,
  planSafeSignal,
  recordOwnedProcess,
  verifyStillOwned,
} from '../lib/process-ownership.mjs';

test('recordOwnedProcess refuses a pid that is not a positive integer above 1', () => {
  assert.throws(() => recordOwnedProcess({ pid: 1, role: 'agent', commandSubstring: 'cli.js node start', cmdlineAtCapture: 'node cli.js node start' }), /pid 1 and below/);
  assert.throws(() => recordOwnedProcess({ pid: 0, role: 'agent', commandSubstring: 'x', cmdlineAtCapture: 'x' }), /pid 1 and below/);
  assert.throws(() => recordOwnedProcess({ pid: -5, role: 'agent', commandSubstring: 'x', cmdlineAtCapture: 'x' }), /pid 1 and below/);
});

test('recordOwnedProcess refuses to claim a cmdline that does not even contain the expected command', () => {
  assert.throws(
    () => recordOwnedProcess({ pid: 1234, role: 'agent', commandSubstring: 'cli.js node start', cmdlineAtCapture: 'bash -lc sleep 60' }),
    /does not even contain/,
  );
});

test('verifyStillOwned: high confidence only when both cmdline and start time match', () => {
  const record = recordOwnedProcess({ pid: 1234, role: 'agent', commandSubstring: 'cli.js node start', cmdlineAtCapture: 'node cli.js node start --max-concurrent-runs 1', startTime: 'Sun Sep 14 10:00:00 2026' });
  const same = verifyStillOwned(record, { pid: 1234, cmdline: 'node cli.js node start --max-concurrent-runs 1', startTime: 'Sun Sep 14 10:00:00 2026' });
  assert.deepEqual(same, { owned: true, confidence: 'high', reason: 'cmdline and start time both match' });
});

test('verifyStillOwned: low confidence, not auto-trusted, when no start time is available on either side', () => {
  const record = recordOwnedProcess({ pid: 1234, role: 'agent', commandSubstring: 'cli.js node start', cmdlineAtCapture: 'node cli.js node start', startTime: null });
  const result = verifyStillOwned(record, { pid: 1234, cmdline: 'node cli.js node start', startTime: null });
  assert.deepEqual(result, { owned: true, confidence: 'low', reason: 'cmdline matches, but no start time was available to rule out pid reuse' });
});

test('verifyStillOwned: pid reuse is caught when start times disagree, even if the cmdline happens to match', () => {
  const record = recordOwnedProcess({ pid: 1234, role: 'agent', commandSubstring: 'cli.js node start', cmdlineAtCapture: 'node cli.js node start', startTime: 'T1' });
  const result = verifyStillOwned(record, { pid: 1234, cmdline: 'node cli.js node start', startTime: 'T2' });
  assert.equal(result.owned, false);
  assert.match(result.reason, /reused/);
});

test('verifyStillOwned: a different cmdline on the same pid is never owned — the pid was reused by something else', () => {
  const record = recordOwnedProcess({ pid: 1234, role: 'agent', commandSubstring: 'cli.js node start', cmdlineAtCapture: 'node cli.js node start' });
  const result = verifyStillOwned(record, { pid: 1234, cmdline: 'python3 unrelated-thing.py', startTime: null });
  assert.equal(result.owned, false);
});

test('verifyStillOwned: a process that no longer exists reads as not owned, not as an error', () => {
  const record = recordOwnedProcess({ pid: 1234, role: 'agent', commandSubstring: 'cli.js node start', cmdlineAtCapture: 'node cli.js node start' });
  assert.deepEqual(verifyStillOwned(record, null), { owned: false, confidence: 'none', reason: 'process no longer exists' });
});

test('verifyStillOwned throws if the caller passes a lookup for the wrong pid — a caller bug, not a runtime decision', () => {
  const record = recordOwnedProcess({ pid: 1234, role: 'agent', commandSubstring: 'x', cmdlineAtCapture: 'x' });
  assert.throws(() => verifyStillOwned(record, { pid: 9999, cmdline: 'x', startTime: null }), /does not match the record/);
});

test('isSafeKillCommand accepts only a plain kill of one explicit pid', () => {
  assert.deepEqual(isSafeKillCommand('kill -9 4242'), { safe: true, pid: 4242 });
  assert.deepEqual(isSafeKillCommand('kill 4242'), { safe: true, pid: 4242 });
  assert.equal(isSafeKillCommand('pkill -9 claude').safe, false);
  assert.equal(isSafeKillCommand('killall node').safe, false);
  assert.equal(isSafeKillCommand('kill -9 $(pgrep -f claude)').safe, false);
  assert.equal(isSafeKillCommand('kill -9 1234 5678').safe, false, 'never more than one pid at a time');
  assert.equal(isSafeKillCommand('kill -9 1').safe, false, 'refuses pid 1');
  assert.equal(isSafeKillCommand('kill -9 -4242').safe, false, 'a negative pid means "process group" — refused');
});

test('planSafeSignal only clears pids with a verified, matching ownership record', () => {
  const records = [
    recordOwnedProcess({ pid: 100, role: 'agent', commandSubstring: 'cli.js node start', cmdlineAtCapture: 'node cli.js node start', startTime: 'T1' }),
    recordOwnedProcess({ pid: 200, role: 'claude-child', commandSubstring: 'claude', cmdlineAtCapture: 'claude --dangerously...', startTime: 'T2' }),
  ];
  const lookups = [
    { pid: 100, current: { pid: 100, cmdline: 'node cli.js node start', startTime: 'T1' } },
    { pid: 200, current: { pid: 200, cmdline: 'claude --dangerously...', startTime: 'DIFFERENT' } }, // reused
    { pid: 999, current: { pid: 999, cmdline: 'bash sleep 60', startTime: 'T3' } }, // never recorded
  ];
  const plan = planSafeSignal(records, lookups);
  assert.deepEqual(plan.verified, [{ pid: 100, role: 'agent', confidence: 'high' }]);
  assert.deepEqual(plan.needsHumanConfirmation.map((entry) => entry.pid), [200, 999]);
});

test('planSafeSignal never widens to "signal everything that looks similar" — an unrecorded pid always needs confirmation', () => {
  const plan = planSafeSignal([], [{ pid: 500, current: { pid: 500, cmdline: 'claude', startTime: 'T' } }]);
  assert.deepEqual(plan.verified, []);
  assert.equal(plan.needsHumanConfirmation.length, 1);
});
