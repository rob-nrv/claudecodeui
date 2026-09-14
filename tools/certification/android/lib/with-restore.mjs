// A generic "temporarily change something, always restore it" guard —
// used for the storage-governor flag swap, the throwaway identity-mismatch
// workspace mapping, and any other test that must never leave the device
// in a different state than it found it, even when the test itself throws.
//
// This is deliberately NOT try/finally sprinkled ad hoc through the runner
// scripts: centralizing it here means every "must restore" test in the
// harness gets the exact same guarantee, and that guarantee is unit-tested
// once instead of trusted by inspection in N different call sites.

/**
 * Runs `apply()`, then `run()`, then always `restore()` — regardless of
 * whether `apply` or `run` threw. If `restore` itself throws, that is
 * reported (never silently swallowed) but does not replace whatever error
 * `apply`/`run` already raised; both are surfaced.
 *
 * Returns a result that always states plainly whether the restore actually
 * ran and succeeded — callers must check `restored` before ever trusting
 * that the device is back in its original state.
 */
export async function runWithRestore({ apply, run, restore }) {
  let applyError = null;
  let runError = null;
  let restoreError = null;
  let value;

  try {
    await apply();
    try {
      value = await run();
    } catch (error) {
      runError = error instanceof Error ? error.message : String(error);
    }
  } catch (error) {
    applyError = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      await restore();
    } catch (error) {
      restoreError = error instanceof Error ? error.message : String(error);
    }
  }

  const restored = restoreError === null;
  const ok = applyError === null && runError === null && restored;
  return { ok, value, applyError, runError, restoreError, restored };
}
