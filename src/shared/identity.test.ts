import assert from 'node:assert/strict';
import test from 'node:test';

import {
  APP_USER_FALLBACK_DISPLAY_NAME,
  UNRESOLVED_MONOGRAM,
  deriveMonogram,
  resolveAppUserIdentity,
  resolveExecutionIdentity,
  shouldShowProfileIdentity,
} from './identity';

// ---------------------------------------------------------------------------
// Monogram derivation — one path shared by Settings, the sidebar and badges
// ---------------------------------------------------------------------------

test('deriveMonogram upper-cases the first letter of the first usable candidate', () => {
  assert.equal(deriveMonogram('cedric'), 'C');
  assert.equal(deriveMonogram('Work'), 'W');
  assert.equal(deriveMonogram('personal'), 'P');
});

test('deriveMonogram keeps accented characters whole', () => {
  assert.equal(deriveMonogram('Cédric'), 'C');
  assert.equal(deriveMonogram('élise'), 'É');
  assert.equal(deriveMonogram('小明'), '小');
});

test('deriveMonogram skips leading punctuation and whitespace', () => {
  assert.equal(deriveMonogram('  ·· work account'), 'W');
  assert.equal(deriveMonogram('@cedric'), 'C');
});

test('deriveMonogram falls through empty candidates in order', () => {
  assert.equal(deriveMonogram(null, '   ', undefined, 'Cédric'), 'C');
  assert.equal(deriveMonogram(42, 'Work'), 'W');
});

test('deriveMonogram reports an unresolved monogram when nothing is nameable', () => {
  assert.equal(deriveMonogram(), UNRESOLVED_MONOGRAM);
  assert.equal(deriveMonogram('', '   ', '---'), UNRESOLVED_MONOGRAM);
});

test('deriveMonogram refuses path-shaped values so no filesystem path leaks', () => {
  assert.equal(deriveMonogram('/home/example'), UNRESOLVED_MONOGRAM);
  assert.equal(deriveMonogram('C:\\Users\\example'), UNRESOLVED_MONOGRAM);
  assert.equal(deriveMonogram('/home/example', 'Cédric'), 'C');
});

// ---------------------------------------------------------------------------
// App user profile
// ---------------------------------------------------------------------------

test('resolveAppUserIdentity prefers the configured display name', () => {
  const identity = resolveAppUserIdentity({ username: 'cedric', displayName: 'Cédric' });

  assert.equal(identity.displayName, 'Cédric');
  assert.equal(identity.username, 'cedric');
  assert.equal(identity.monogram, 'C');
  assert.equal(identity.isFallback, false);
});

test('resolveAppUserIdentity falls back to the registered username', () => {
  const identity = resolveAppUserIdentity({ username: 'cedric', displayName: null });

  assert.equal(identity.displayName, 'cedric');
  assert.equal(identity.monogram, 'C');
  assert.equal(identity.isFallback, false);
});

test('resolveAppUserIdentity ignores a blank display name', () => {
  const identity = resolveAppUserIdentity({ username: 'cedric', displayName: '   ' });

  assert.equal(identity.displayName, 'cedric');
});

test('resolveAppUserIdentity degrades to a generic label with no user', () => {
  for (const source of [null, undefined, {}]) {
    const identity = resolveAppUserIdentity(source);

    assert.equal(identity.displayName, APP_USER_FALLBACK_DISPLAY_NAME);
    assert.equal(identity.username, null);
    assert.equal(identity.monogram, 'U');
    assert.equal(identity.isFallback, true);
  }
});

test('resolveAppUserIdentity never surfaces a path-shaped record', () => {
  const identity = resolveAppUserIdentity({ username: '/home/example', displayName: undefined });

  assert.equal(identity.displayName, APP_USER_FALLBACK_DISPLAY_NAME);
  assert.equal(identity.username, null);
  assert.equal(identity.isFallback, true);
});

// ---------------------------------------------------------------------------
// Execution (provider/profile) identity
// ---------------------------------------------------------------------------

const PROFILES = new Map([
  ['work-id', 'Work'],
  ['personal-id', 'Personal'],
]);

test('resolveExecutionIdentity labels the account a Claude session is bound to', () => {
  const identity = resolveExecutionIdentity({
    provider: 'claude',
    claudeProfileId: 'work-id',
    profileNamesById: PROFILES,
  });

  assert.equal(identity.providerLabel, 'Claude');
  assert.equal(identity.profileLabel, 'Work');
  assert.equal(identity.profileMonogram, 'W');
  assert.equal(identity.isProfileUnresolved, false);
  assert.equal(identity.fullLabel, 'Claude · Work');
});

test('Work and Personal stay distinguishable by text and monogram, not colour', () => {
  const work = resolveExecutionIdentity({
    provider: 'claude',
    claudeProfileId: 'work-id',
    profileNamesById: PROFILES,
  });
  const personal = resolveExecutionIdentity({
    provider: 'claude',
    claudeProfileId: 'personal-id',
    profileNamesById: PROFILES,
  });

  assert.notEqual(work.profileLabel, personal.profileLabel);
  assert.notEqual(work.profileMonogram, personal.profileMonogram);
  assert.notEqual(work.fullLabel, personal.fullLabel);
});

test('the bound session id wins over any other registered account', () => {
  // A stale frontend selection cannot change the answer: the only input that
  // decides the label is the session's persisted `claudeProfileId`.
  const identity = resolveExecutionIdentity({
    provider: 'claude',
    claudeProfileId: 'personal-id',
    profileNamesById: PROFILES,
  });

  assert.equal(identity.profileLabel, 'Personal');
});

test('a bound account that no longer resolves is reported, not hidden', () => {
  const identity = resolveExecutionIdentity({
    provider: 'claude',
    claudeProfileId: 'removed-id',
    profileNamesById: PROFILES,
    unresolvedLabel: 'Unknown account',
  });

  assert.equal(identity.profileLabel, 'Unknown account');
  assert.equal(identity.profileMonogram, UNRESOLVED_MONOGRAM);
  assert.equal(identity.isProfileUnresolved, true);
});

test('an unbound or non-Claude execution carries provider branding only', () => {
  const unbound = resolveExecutionIdentity({
    provider: 'claude',
    claudeProfileId: null,
    profileNamesById: PROFILES,
  });
  assert.equal(unbound.providerLabel, 'Claude');
  assert.equal(unbound.profileLabel, null);
  assert.equal(unbound.profileMonogram, null);
  assert.equal(unbound.fullLabel, 'Claude');

  const codex = resolveExecutionIdentity({
    provider: 'codex',
    claudeProfileId: 'work-id',
    profileNamesById: PROFILES,
  });
  assert.equal(codex.providerLabel, 'Codex');
  assert.equal(codex.profileLabel, null);
});

test('an unknown provider degrades to a neutral label instead of throwing', () => {
  const identity = resolveExecutionIdentity({
    provider: undefined,
    claudeProfileId: 'work-id',
    profileNamesById: PROFILES,
  });

  assert.equal(identity.providerLabel, 'Agent');
  assert.equal(identity.profileLabel, null);
});

test('profile identity stays hidden until more than one account is registered', () => {
  assert.equal(shouldShowProfileIdentity(0), false);
  assert.equal(shouldShowProfileIdentity(1), false);
  assert.equal(shouldShowProfileIdentity(2), true);
});
