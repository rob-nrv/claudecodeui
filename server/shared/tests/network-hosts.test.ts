import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveBindHost } from '../../../shared/networkHosts.js';

test('resolveBindHost falls back to loopback when HOST is unset', () => {
  assert.equal(resolveBindHost(undefined), '127.0.0.1');
});

test('resolveBindHost falls back to loopback when HOST is blank', () => {
  // Covers a malformed .env line (e.g. `HOST=`) or one lost to whitespace.
  assert.equal(resolveBindHost(''), '127.0.0.1');
  assert.equal(resolveBindHost('   '), '127.0.0.1');
});

test('resolveBindHost honors an explicit wildcard bind', () => {
  // Opting into 0.0.0.0 must stay possible — just never as an implicit default.
  assert.equal(resolveBindHost('0.0.0.0'), '0.0.0.0');
});

test('resolveBindHost honors an explicit custom host', () => {
  assert.equal(resolveBindHost('192.168.1.50'), '192.168.1.50');
});
