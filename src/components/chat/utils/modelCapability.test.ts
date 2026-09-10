import assert from 'node:assert/strict';
import test from 'node:test';

import { formatModelCapability } from './modelCapability';

test('formatModelCapability combines context window and max output', () => {
  assert.equal(
    formatModelCapability({ contextWindowTokens: 200_000, maxOutputTokens: 64_000 }),
    '200K context · 64K max output',
  );
});

test('formatModelCapability formats context windows at or above 1M in millions', () => {
  assert.equal(
    formatModelCapability({ contextWindowTokens: 1_000_000, maxOutputTokens: 64_000 }),
    '1M context · 64K max output',
  );
});

test('formatModelCapability renders only the fields that are present', () => {
  assert.equal(formatModelCapability({ contextWindowTokens: 200_000 }), '200K context');
  assert.equal(formatModelCapability({ maxOutputTokens: 64_000 }), '64K max output');
});

test('formatModelCapability returns null for undefined capability (dynamic aliases)', () => {
  assert.equal(formatModelCapability(undefined), null);
});

test('formatModelCapability returns null for an empty capability object', () => {
  assert.equal(formatModelCapability({}), null);
});
