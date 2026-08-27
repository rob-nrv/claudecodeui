/**
 * Pulled out of `ProviderLoginModal.tsx` so it can be unit-tested without
 * pulling in that file's transitive `StandaloneShell` → `Shell` → xterm CSS
 * import chain (this repo's plain `node:test` runner has no CSS loader).
 *
 * Many logins (`claude /login` included) drop into an interactive session
 * afterward and never exit, so process-exit detection (`onComplete`, driven
 * by matching "Process exited with code N" in the terminal output) never
 * fires. Closing the modal — the X button, normal on mobile — is the only
 * signal some login attempts ever produce. Treating a manual close as a
 * completion too (exit code -1, meaning "unknown/closed manually", never a
 * fabricated 0) is what lets callers (profile verification, provider
 * auth-status re-check) actually run instead of leaving a stale card behind
 * a modal the user has already dismissed. Safe for every caller: both
 * existing consumers re-probe real state idempotently regardless of exit code.
 */
export function createModalCloseHandler(
  onComplete: ((exitCode: number) => void) | undefined,
  onClose: () => void,
): () => void {
  return () => {
    onComplete?.(-1);
    onClose();
  };
}
