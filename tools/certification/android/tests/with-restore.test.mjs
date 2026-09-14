import assert from 'node:assert/strict';
import test from 'node:test';

import { runWithRestore } from '../lib/with-restore.mjs';

test('restore always runs on the success path, and the result reports it', async () => {
  const calls = [];
  const result = await runWithRestore({
    apply: async () => calls.push('apply'),
    run: async () => {
      calls.push('run');
      return 'value';
    },
    restore: async () => calls.push('restore'),
  });
  assert.deepEqual(calls, ['apply', 'run', 'restore']);
  assert.deepEqual(result, { ok: true, value: 'value', applyError: null, runError: null, restoreError: null, restored: true });
});

test('restore still runs when run() throws — e.g. the storage-floor test itself fails — and the failure is reported without hiding it', async () => {
  const calls = [];
  const result = await runWithRestore({
    apply: async () => calls.push('apply'),
    run: async () => {
      calls.push('run');
      throw new Error('send did not produce the expected refusal');
    },
    restore: async () => calls.push('restore'),
  });
  assert.deepEqual(calls, ['apply', 'run', 'restore']);
  assert.equal(result.ok, false);
  assert.match(result.runError, /did not produce the expected refusal/);
  assert.equal(result.restored, true, 'the device was still put back, even though the test failed');
});

test('restore still runs when apply() itself throws (e.g. the agent failed to restart with the test flag)', async () => {
  const calls = [];
  const result = await runWithRestore({
    apply: async () => {
      calls.push('apply');
      throw new Error('agent did not come back up with --min-free-storage-mb 1048576');
    },
    run: async () => calls.push('run'),
    restore: async () => calls.push('restore'),
  });
  assert.deepEqual(calls, ['apply', 'restore'], 'run() never executes if apply() failed');
  assert.equal(result.ok, false);
  assert.match(result.applyError, /did not come back up/);
  assert.equal(result.restored, true);
});

test('a failing restore is reported explicitly (restored: false) and never silently treated as success', async () => {
  const result = await runWithRestore({
    apply: async () => undefined,
    run: async () => 'value',
    restore: async () => {
      throw new Error('agent refused to restart with the default flags');
    },
  });
  assert.equal(result.ok, false, 'a test cannot be VALIDATED if the device was not actually restored');
  assert.equal(result.restored, false);
  assert.match(result.restoreError, /refused to restart/);
});

test('a failing run AND a failing restore both surface — neither error hides the other', async () => {
  const result = await runWithRestore({
    apply: async () => undefined,
    run: async () => {
      throw new Error('refusal message did not match');
    },
    restore: async () => {
      throw new Error('restore also failed');
    },
  });
  assert.match(result.runError, /refusal message did not match/);
  assert.match(result.restoreError, /restore also failed/);
  assert.equal(result.ok, false);
});
