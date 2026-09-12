import assert from 'node:assert/strict';
import test from 'node:test';

import { isConfirmingSteerTap, reduceSteerConfirmation } from './steerConfirmation';

test('first tap arms; it never sends by itself', () => {
  const armed = reduceSteerConfirmation('idle', { type: 'tap' });
  assert.equal(armed, 'armed');
  assert.equal(isConfirmingSteerTap('idle'), false);
});

test('a second tap while armed is the confirmation that transitions to sending', () => {
  const sending = reduceSteerConfirmation('armed', { type: 'tap' });
  assert.equal(sending, 'sending');
  assert.equal(isConfirmingSteerTap('armed'), true);
});

test('a tap while sending is ignored — this is the double-tap guard', () => {
  assert.equal(reduceSteerConfirmation('sending', { type: 'tap' }), 'sending');
});

test('an unconfirmed arm times out back to idle', () => {
  assert.equal(reduceSteerConfirmation('armed', { type: 'armTimeout' }), 'idle');
});

test('a stale arm-timeout firing after the user already confirmed does not interrupt the send', () => {
  assert.equal(reduceSteerConfirmation('sending', { type: 'armTimeout' }), 'sending');
});

test('a stale arm-timeout firing after idle/error is a no-op', () => {
  assert.equal(reduceSteerConfirmation('idle', { type: 'armTimeout' }), 'idle');
  assert.equal(reduceSteerConfirmation('error', { type: 'armTimeout' }), 'error');
});

test('a successful send settles back to idle; a failed one surfaces as an explicit error', () => {
  assert.equal(reduceSteerConfirmation('sending', { type: 'sendSettled', ok: true }), 'idle');
  assert.equal(reduceSteerConfirmation('sending', { type: 'sendSettled', ok: false }), 'error');
});

test('tapping again after an error re-arms rather than getting stuck', () => {
  assert.equal(reduceSteerConfirmation('error', { type: 'tap' }), 'armed');
});

test('reset always returns to idle regardless of state', () => {
  for (const state of ['idle', 'armed', 'sending', 'error'] as const) {
    assert.equal(reduceSteerConfirmation(state, { type: 'reset' }), 'idle');
  }
});
