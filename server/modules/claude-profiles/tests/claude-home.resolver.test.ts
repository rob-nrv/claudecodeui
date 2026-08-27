import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  claudeConfigJsonPathFor,
  claudeHomeFor,
  claudeProfilesRoot,
} from '@/modules/claude-profiles/claude-home.resolver.js';

test('claudeHomeFor: no profile id resolves to the legacy ~/.claude, regardless of how many profiles exist', () => {
  assert.equal(claudeHomeFor(), path.join(os.homedir(), '.claude'));
  assert.equal(claudeHomeFor(null), path.join(os.homedir(), '.claude'));
  assert.equal(claudeHomeFor(undefined), path.join(os.homedir(), '.claude'));
});

test('claudeHomeFor: a named profile id resolves to its isolated directory under ~/.cloudcli/claude-profiles', () => {
  const profileId = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';
  assert.equal(
    claudeHomeFor(profileId),
    path.join(os.homedir(), '.cloudcli', 'claude-profiles', profileId),
  );
  assert.equal(claudeHomeFor(profileId), path.join(claudeProfilesRoot(), profileId));
});

test('claudeHomeFor: rejects a profile id that could escape the profiles root', () => {
  assert.throws(() => claudeHomeFor('../../etc'));
  assert.throws(() => claudeHomeFor('foo/bar'));
  assert.throws(() => claudeHomeFor('..'));
});

test('claudeHomeFor: honours an injected base home directory (DI seam used by cli/taskmaster/token-usage services)', () => {
  assert.equal(claudeHomeFor(undefined, '/tmp/fake-home'), path.join('/tmp/fake-home', '.claude'));
  assert.equal(
    claudeHomeFor('profile-1', '/tmp/fake-home'),
    path.join('/tmp/fake-home', '.cloudcli', 'claude-profiles', 'profile-1'),
  );
});

test('claudeConfigJsonPathFor: legacy case resolves beside ~/.claude, not inside it', () => {
  assert.equal(claudeConfigJsonPathFor(), path.join(os.homedir(), '.claude.json'));
});

test('claudeConfigJsonPathFor: profile case resolves inside the isolated config dir', () => {
  const profileId = 'profile-xyz';
  assert.equal(
    claudeConfigJsonPathFor(profileId),
    path.join(os.homedir(), '.cloudcli', 'claude-profiles', profileId, '.claude.json'),
  );
});
