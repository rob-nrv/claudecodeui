import assert from 'node:assert/strict';
import test from 'node:test';

import { planResume } from '../lib/resume-state.mjs';

const BASE = { requiredCommit: 'a31c3765', headCommit: 'a31c3765' };

test('a source at or after the required commit, with everything already done, proceeds and skips every destructive step', () => {
  const plan = planResume({ ...BASE, isRequiredCommitAncestor: true, enrolled: true, claudeLoggedIn: true, workspaceMapped: true, agentRunning: true });
  assert.equal(plan.canProceed, true);
  assert.deepEqual(plan.blockers, []);
  assert.deepEqual(plan.skip, { enrollment: true, claudeLogin: true, workspaceMapping: true });
  assert.equal(plan.resumeAgent, true);
});

test('a source proven older than the required commit stops with SOURCE_TOO_OLD and never proposes skipping setup', () => {
  const plan = planResume({ requiredCommit: 'a31c3765', headCommit: 'dd3f8782', isRequiredCommitAncestor: false, enrolled: true, claudeLoggedIn: true, workspaceMapped: true, agentRunning: true });
  assert.equal(plan.canProceed, false);
  assert.deepEqual(plan.blockers.map((blocker) => blocker.code), ['SOURCE_TOO_OLD']);
  assert.deepEqual(plan.skip, {});
});

test('an unresolved ancestor check (not a git checkout, or unknown commit) stops just as conservatively as "too old", with its own code', () => {
  const plan = planResume({ ...BASE, isRequiredCommitAncestor: 'unknown', enrolled: true, claudeLoggedIn: true, workspaceMapped: true, agentRunning: true });
  assert.equal(plan.canProceed, false);
  assert.deepEqual(plan.blockers.map((blocker) => blocker.code), ['SOURCE_VERSION_UNKNOWN']);
});

test('an unobserved fact (undefined) is treated as "needs doing", never silently skipped', () => {
  const plan = planResume({ ...BASE, isRequiredCommitAncestor: true, enrolled: true /* claudeLoggedIn, workspaceMapped, agentRunning unspecified */ });
  assert.equal(plan.canProceed, true);
  assert.deepEqual(plan.skip, { enrollment: true, claudeLogin: false, workspaceMapping: false });
  assert.equal(plan.resumeAgent, false);
});

test('a falsy-but-not-exactly-true value (e.g. a stringly "yes") is never treated as done — only a literal true counts', () => {
  const plan = planResume({ ...BASE, isRequiredCommitAncestor: true, enrolled: 'yes', claudeLoggedIn: 1, workspaceMapped: true });
  assert.deepEqual(plan.skip, { enrollment: false, claudeLogin: false, workspaceMapping: true });
});

test('requires both commit ids to be provided', () => {
  assert.throws(() => planResume({ requiredCommit: 'a31c3765', isRequiredCommitAncestor: true }), /requires both/);
  assert.throws(() => planResume({ headCommit: 'a31c3765', isRequiredCommitAncestor: true }), /requires both/);
});
