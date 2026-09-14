import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createResultStore,
  importResult,
  isFullyValidated,
  overallStatus,
  recordResult,
  summarize,
  worstOf,
} from '../lib/classification.mjs';

test('worstOf picks FAILED over everything else, and VALIDATED only when nothing else is present', () => {
  assert.equal(worstOf(['VALIDATED', 'VALIDATED']), 'VALIDATED');
  assert.equal(worstOf(['VALIDATED', 'SKIPPED']), 'SKIPPED');
  assert.equal(worstOf(['VALIDATED', 'SKIPPED', 'UNKNOWN']), 'UNKNOWN');
  assert.equal(worstOf(['VALIDATED', 'CONDITIONAL', 'FAILED']), 'FAILED');
  assert.equal(worstOf(['CONDITIONAL', 'CONDITIONAL']), 'CONDITIONAL');
  assert.throws(() => worstOf([]), /at least one status/);
  assert.throws(() => worstOf(['NOT_A_STATUS']), /unknown status/);
});

test('a CONDITIONAL result never rounds up to VALIDATED in the overall status, even surrounded by passes', () => {
  const store = createResultStore();
  recordResult(store, { id: 'reconnect-short', name: 'Short reconnect', status: 'VALIDATED' });
  recordResult(store, { id: 'sigkill-cleanup', name: 'SIGKILL orphan cleanup', status: 'CONDITIONAL', notes: 'Claude child survived SIGKILL' });
  recordResult(store, { id: 'governor-concurrency', name: 'Governor concurrency', status: 'VALIDATED' });
  assert.equal(overallStatus(store), 'CONDITIONAL');
  assert.equal(isFullyValidated(store, ['reconnect-short', 'sigkill-cleanup', 'governor-concurrency']), false);
});

test('an empty store is UNKNOWN, never VALIDATED — no evidence means nothing is proven', () => {
  const store = createResultStore();
  assert.equal(overallStatus(store), 'UNKNOWN');
  assert.equal(isFullyValidated(store, []), true, 'vacuously true for an empty requirement list');
  assert.equal(isFullyValidated(store, ['anything']), false);
});

test('a single FAILED test blocks the overall status even if every other test is VALIDATED', () => {
  const store = createResultStore();
  for (const id of ['a', 'b', 'c']) {
    recordResult(store, { id, name: id, status: 'VALIDATED' });
  }
  recordResult(store, { id: 'd', name: 'd', status: 'FAILED' });
  assert.equal(overallStatus(store), 'FAILED');
});

test('importing a manual result twice is refused unless supersede is explicit, so a CONDITIONAL import can never be quietly overwritten', () => {
  const store = createResultStore();
  importResult(store, { id: 'sigkill-cleanup', name: 'SIGKILL orphan cleanup', status: 'CONDITIONAL', notes: 'manual HC-06 2026-09-14' });
  assert.throws(
    () => importResult(store, { id: 'sigkill-cleanup', name: 'SIGKILL orphan cleanup', status: 'VALIDATED' }),
    /already exists/,
  );
  assert.equal(store.results['sigkill-cleanup'].current.status, 'CONDITIONAL', 'the refused import changed nothing');

  importResult(store, { id: 'sigkill-cleanup', name: 'SIGKILL orphan cleanup', status: 'VALIDATED', notes: 're-tested clean' }, { supersede: true });
  assert.equal(store.results['sigkill-cleanup'].current.status, 'VALIDATED', 'an explicit supersede is honored');
  assert.equal(store.results['sigkill-cleanup'].history.length, 2, 'the prior classification is kept in history, not erased');
});

test('recordResult always supersedes and always appends to history, so a re-run is visible but the prior run is not lost', () => {
  const store = createResultStore();
  recordResult(store, { id: 'offline-refusal', name: 'Offline refusal', status: 'UNKNOWN', notes: 'first attempt: timed out waiting for the offline error' });
  recordResult(store, { id: 'offline-refusal', name: 'Offline refusal', status: 'VALIDATED', notes: 'second attempt: explicit refusal observed' });
  assert.equal(store.results['offline-refusal'].current.status, 'VALIDATED');
  assert.deepEqual(store.results['offline-refusal'].history.map((entry) => entry.status), ['UNKNOWN', 'VALIDATED']);
});

test('summarize is stable-sorted by id and reflects only the current classification', () => {
  const store = createResultStore();
  recordResult(store, { id: 'z-test', name: 'Z', status: 'SKIPPED' });
  recordResult(store, { id: 'a-test', name: 'A', status: 'VALIDATED' });
  assert.deepEqual(summarize(store).map((entry) => entry.id), ['a-test', 'z-test']);
  assert.deepEqual(summarize(store).map((entry) => entry.status), ['VALIDATED', 'SKIPPED']);
});

test('rejects an unknown status rather than silently accepting it', () => {
  const store = createResultStore();
  assert.throws(() => recordResult(store, { id: 'x', name: 'X', status: 'PASS' }), /unknown status/);
  assert.throws(() => importResult(store, { id: 'x', name: 'X', status: 'PASS' }), /unknown status/);
});
