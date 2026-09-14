// HC06-IDENTITY-EVIDENCE-REPAIR-R2: the identity test's `run()` step
// returns the FULL ProjectWorkspaceStateView from getWorkspaceState — which
// includes `sync: { secret: <count>, secretContent: <count>, ... }`
// (server/modules/project-workspaces/workspace-state.ts). `secret` there is
// a plain number (how many changed files were classified as secret-class
// BY NAME), never an actual secret value — but its key name alone trips
// lib/evidence.mjs's `findForbiddenField`, which is correct, conservative
// behavior and must never be weakened just to let this through (see
// STOP-condition-equivalent requirement in the mission brief).
//
// The fix belongs here instead: never hand the raw state object (or a raw
// runWithRestore result wrapping it) to the evidence writer at all. This
// module extracts only the handful of fields that can actually classify
// the identity test, and nothing else — no `sync`, no `changes`, no `git`,
// no `inspectedAt`, no filesystem paths, no node labels.
import { runWithRestore } from './with-restore.mjs';

/**
 * Builds the exact, minimal evidence needed to prove the identity test's
 * outcome from a `runWithRestore` result whose `value` (when present) is a
 * ProjectWorkspaceStateView-shaped object. Never includes `sync`, `changes`,
 * `git` or any other field that could carry a secret-shaped key or a
 * filesystem path — only `state`/`identity`/`reason`, the three fields the
 * classification in cmdTestIdentity actually reads.
 */
export function summarizeIdentityTestEvidence(result) {
  const value = result?.value ?? null;
  return {
    ok: result?.ok ?? false,
    restored: result?.restored ?? false,
    applyError: result?.applyError ?? null,
    runError: result?.runError ?? null,
    restoreError: result?.restoreError ?? null,
    observed: value
      ? { state: value.state ?? null, identity: value.identity ?? null, reason: value.reason ?? null }
      : null,
  };
}

/**
 * A `run()` step for `runWithRestore` that reads a workspace state (however
 * the caller obtains it — real REST call or a fake in tests) and throws on
 * a mismatch using ONLY the minimal fields, never `JSON.stringify`-ing the
 * full state object into the error message. That message becomes
 * `result.runError` — a second place the same secret-shaped `sync.secret`
 * field could otherwise have leaked into evidence as an un-scanned string,
 * bypassing `findForbiddenField` entirely (it only inspects object keys,
 * not string contents).
 */
export function expectIdentityMismatch(getState) {
  return async () => {
    const state = await getState();
    if (state.state !== 'identity_mismatch') {
      throw new Error(`Expected state "identity_mismatch", got state=${JSON.stringify(state.state)} identity=${JSON.stringify(state.identity)} reason=${JSON.stringify(state.reason)}`);
    }
    return state;
  };
}

/** Runs the apply/expect-mismatch/restore sequence and returns evidence-safe, pre-summarized output — never the raw state. */
export async function runIdentityMismatchTest({ apply, getState, restore }) {
  const result = await runWithRestore({ apply, run: expectIdentityMismatch(getState), restore });
  return summarizeIdentityTestEvidence(result);
}
