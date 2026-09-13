import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatUsedPercentage,
  getBridgeAction,
  getResetHint,
  getUsageLevel,
} from './liveUsage';

const NOW = Date.UTC(2026, 8, 13, 12, 0, 0);

test('percentages round for display without turning a small observed value into 0%', () => {
  assert.equal(formatUsedPercentage(0), '0%');
  assert.equal(formatUsedPercentage(0.4), '<1%');
  assert.equal(formatUsedPercentage(23.5), '24%');
  assert.equal(formatUsedPercentage(41.2), '41%');
  assert.equal(formatUsedPercentage(100), '100%');
});

test('usage level escalates at 75% and 90%', () => {
  assert.equal(getUsageLevel(74.9), 'normal');
  assert.equal(getUsageLevel(75), 'elevated');
  assert.equal(getUsageLevel(89.9), 'elevated');
  assert.equal(getUsageLevel(90), 'high');
});

test('reset hints are relative when near, absolute when far, and absent once passed', () => {
  assert.deepEqual(getResetHint(new Date(NOW + 30_000).toISOString(), NOW), { kind: 'minutes', minutes: 1 });
  assert.deepEqual(getResetHint(new Date(NOW + 42 * 60_000).toISOString(), NOW), { kind: 'minutes', minutes: 42 });
  assert.deepEqual(getResetHint(new Date(NOW + (3 * 60 + 5) * 60_000).toISOString(), NOW), { kind: 'hours', hours: 3, minutes: 5 });

  const far = getResetHint(new Date(NOW + 3 * 86_400_000).toISOString(), NOW);
  assert.equal(far?.kind, 'date');

  assert.equal(getResetHint(new Date(NOW - 1).toISOString(), NOW), null);
  assert.equal(getResetHint('not a date', NOW), null);
});

test('each bridge state offers exactly one truthful action', () => {
  assert.equal(getBridgeAction('not_installed'), 'enable');
  assert.equal(getBridgeAction('installed'), 'disable');
  assert.equal(getBridgeAction('outdated'), 'repair');
  assert.equal(getBridgeAction('broken'), 'repair');
  assert.equal(getBridgeAction('settings_unreadable'), 'none');
});
