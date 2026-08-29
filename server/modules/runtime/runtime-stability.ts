// A single successful health read is not proof of a durable process. A detached
// child that loses its session under proot's setsid emulation, or one that
// crashes in an unhandled rejection moments after listen(), answers /health
// once and then is gone — indistinguishable from a clean start until something
// checks again. Start and restart both need that second look before either
// calls the outcome STARTED, so it lives here once instead of twice.
import type { RuntimeStatus } from './runtime-status.js';

export type RuntimeStabilityDependencies = {
  status(): Promise<RuntimeStatus>;
  wait(milliseconds: number): Promise<void>;
};

export type RuntimeStabilityOptions = {
  /** How many additional observations must agree before the instance counts as stable. */
  checks?: number;
  intervalMs?: number;
};

export type RuntimeStabilityResult =
  | { stable: true; status: RuntimeStatus }
  | { stable: false; status: RuntimeStatus };

/** Small and fixed: this is a flicker check, not a supervisor. */
export const DEFAULT_STABILITY_CHECKS = 2;
export const DEFAULT_STABILITY_INTERVAL_MS = 500;

/**
 * Re-observes an instance that just reported ONLINE a few more times, requiring
 * every observation to still be ONLINE with the same instance id. Any
 * disappearance, state change, or identity drift during that window fails the
 * confirmation — the caller is expected to report that as a distinct outcome
 * rather than as success.
 */
export async function confirmStableOnline(
  initial: RuntimeStatus,
  dependencies: RuntimeStabilityDependencies,
  options: RuntimeStabilityOptions = {},
): Promise<RuntimeStabilityResult> {
  const checks = options.checks ?? DEFAULT_STABILITY_CHECKS;
  const intervalMs = options.intervalMs ?? DEFAULT_STABILITY_INTERVAL_MS;
  let latest = initial;

  for (let index = 0; index < checks; index += 1) {
    await dependencies.wait(intervalMs);
    latest = await dependencies.status();
    if (latest.state !== 'online' || latest.instanceId !== initial.instanceId) {
      return { stable: false, status: latest };
    }
  }

  return { stable: true, status: latest };
}
