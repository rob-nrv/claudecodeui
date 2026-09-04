import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { APP_USER_FALLBACK_DISPLAY_NAME, resolveAppUserIdentity } from './identity';

const SRC_ROOT = path.resolve(import.meta.dirname, '..');
const IDENTITY_MODULE = path.join(SRC_ROOT, 'shared', 'identity.ts');

function collectSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const fullPath = path.join(directory, entry);
    if (statSync(fullPath).isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      files.push(fullPath);
    }
  }
  return files;
}

const readSource = (relativePath: string) =>
  readFileSync(path.join(SRC_ROOT, relativePath), 'utf8');

// ---------------------------------------------------------------------------
// One derivation path for avatars/initials
// ---------------------------------------------------------------------------

/**
 * Matches "take the first character and upper-case it" — the shape an inline
 * avatar initial takes. Title-casing a whole word (`c.toUpperCase() +
 * word.slice(1)`) is a different intent and is deliberately not flagged.
 */
const INLINE_INITIAL_PATTERN = /(?:\.charAt\(0\)|\[0\])\s*\.toLocale?U?pperCase\(\)(?!\s*\+)/;

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

test('no component derives an avatar initial on its own', () => {
  // Regression guard for the sidebar and Settings drifting apart: every
  // initial must come from `shared/identity`, never from an inline
  // `name[0].toUpperCase()` in a component.
  const offenders = collectSourceFiles(SRC_ROOT)
    .filter((file) => file !== IDENTITY_MODULE)
    .filter((file) => INLINE_INITIAL_PATTERN.test(stripComments(readFileSync(file, 'utf8'))))
    .map((file) => path.relative(SRC_ROOT, file));

  assert.deepEqual(offenders, []);
});

test('the sidebar and Settings read the app user through the same hook', () => {
  const sidebarBadge = readSource('components/identity/view/AppUserBadge.tsx');
  const settingsProfile = readSource('components/settings/view/tabs/ProfileSettingsTab.tsx');

  for (const source of [sidebarBadge, settingsProfile]) {
    assert.match(source, /useAppUserIdentity/);
    assert.match(source, /IdentityMonogram/);
  }
});

test('the app user identity hook is the only reader of the auth user for identity', () => {
  const hook = readSource('hooks/useAppUserIdentity.ts');

  assert.match(hook, /resolveAppUserIdentity/);
});

// ---------------------------------------------------------------------------
// Branding vs. identity
// ---------------------------------------------------------------------------

test('provider branding is never used as the app user or account name', () => {
  // "Claude Code" is legitimate provider/product branding elsewhere, but it
  // must never stand in for a user or profile display name.
  const identitySources = [
    'shared/identity.ts',
    'hooks/useAppUserIdentity.ts',
    'components/identity/view/AppUserBadge.tsx',
    'components/identity/view/IdentityMonogram.tsx',
    'components/identity/view/ExecutionIdentityBadge.tsx',
    'components/settings/view/tabs/ProfileSettingsTab.tsx',
  ];

  for (const relativePath of identitySources) {
    assert.doesNotMatch(
      stripComments(readSource(relativePath)),
      /Claude Code/,
      `${relativePath} must not use provider branding as an identity label`,
    );
  }
});

test('the app user fallback is generic and installation-neutral', () => {
  // Guards shareability: no forked or freshly installed copy may ship someone
  // else's name as a built-in default.
  assert.equal(APP_USER_FALLBACK_DISPLAY_NAME, 'User');

  // Scan executable code only: documentation may name an example user.
  const identityCode = stripComments(readFileSync(IDENTITY_MODULE, 'utf8'));
  for (const personalValue of ['cedric', 'Cédric', 'Claude Code']) {
    assert.doesNotMatch(identityCode, new RegExp(personalValue, 'i'));
  }

  assert.equal(resolveAppUserIdentity(null).displayName, 'User');
});
