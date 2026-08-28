import assert from 'node:assert/strict';
import test from 'node:test';

import { formatElapsedDuration } from './utils';

test('formatElapsedDuration renders sub-minute durations as seconds', () => {
  const startedAt = 1_000;
  const currentTime = new Date(startedAt + 12_000);

  assert.equal(formatElapsedDuration(startedAt, currentTime), '12s');
});

test('formatElapsedDuration renders minute-scale durations as "Xm Ys"', () => {
  const startedAt = 0;
  const currentTime = new Date((2 * 60 + 14) * 1000);

  assert.equal(formatElapsedDuration(startedAt, currentTime), '2m 14s');
});

test('formatElapsedDuration never goes negative when the clock is momentarily behind startedAt', () => {
  const startedAt = 10_000;
  const currentTime = new Date(9_000);

  assert.equal(formatElapsedDuration(startedAt, currentTime), '0s');
});

test('formatElapsedDuration stops advancing once given the same currentTime again (derived, not a timer)', () => {
  const startedAt = 0;
  const frozen = new Date(5_000);

  assert.equal(formatElapsedDuration(startedAt, frozen), formatElapsedDuration(startedAt, frozen));
});
