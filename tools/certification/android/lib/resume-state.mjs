// Pure "should this run resume the existing HC-06 environment, or is it
// unsafe/impossible to continue" decision. Every input is a plain fact the
// caller already collected (a git ancestor check, a doctor report field, a
// process check) — this file only decides what to do with those facts.

/**
 * `isRequiredCommitAncestor` should come from the device actually running
 * `git merge-base --is-ancestor <requiredCommit> HEAD` (exit code 0 = true,
 * 1 = false) — never guessed from string comparison, since commit ids
 * don't sort. Pass `'unknown'` (not `false`) when that check itself could
 * not be run (e.g. not a git checkout, or the required commit is unknown
 * to this clone) — this stops just as `false` does, but is reported with
 * its own blocker code so the operator knows it's an unresolved question,
 * not a proven-too-old source.
 */
export function planResume({
  requiredCommit,
  headCommit,
  isRequiredCommitAncestor,
  enrolled,
  claudeLoggedIn,
  workspaceMapped,
  agentRunning,
}) {
  if (!requiredCommit || !headCommit) {
    throw new Error('planResume requires both requiredCommit and headCommit');
  }

  if (isRequiredCommitAncestor === false) {
    return {
      canProceed: false,
      blockers: [{
        code: 'SOURCE_TOO_OLD',
        message: `Pixel source (HEAD ${headCommit}) does not include the required reconnect-fix floor ${requiredCommit}. Update the source on the device before continuing — do not re-enroll or re-run tests against an older build.`,
      }],
      skip: {},
    };
  }
  if (isRequiredCommitAncestor !== true) {
    return {
      canProceed: false,
      blockers: [{
        code: 'SOURCE_VERSION_UNKNOWN',
        message: `Could not verify that Pixel source HEAD (${headCommit}) includes ${requiredCommit} (isRequiredCommitAncestor was ${JSON.stringify(isRequiredCommitAncestor)}). Stopping rather than assuming it's new enough.`,
      }],
      skip: {},
    };
  }

  return {
    canProceed: true,
    blockers: [],
    // Each `skip.*` is true only when the fact was explicitly observed as
    // already-done; anything not explicitly true is treated as needing the
    // step, so a missing/unclear fact never silently skips real setup.
    skip: {
      enrollment: enrolled === true,
      claudeLogin: claudeLoggedIn === true,
      workspaceMapping: workspaceMapped === true,
    },
    resumeAgent: agentRunning === true,
  };
}
