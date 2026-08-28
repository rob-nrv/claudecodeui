// Safe restart. The hazard this exists for is specific to this project: CloudCLI
// is routinely used to modify CloudCLI, so the process asking for the restart is
// often a descendant of the process being replaced.
//
// Two properties make that survivable, and both are asserted by tests rather
// than assumed:
//   - the replacement is launched detached, so it outlives whatever asked for it
//   - success means a *different* instance id answered, never merely "no error"
//
// Building is deliberately not part of restart. `npm run build:server` already
// stages into dist-server.next and promotes atomically, with `preserver`
// recovering an interrupted promotion; folding a build in here would make the
// one operation that must stay predictable both slow and failure-prone.
import type { RuntimeController } from './runtime-controller.service.js';
import type { RuntimeStatus } from './runtime-status.js';

export type RuntimeRestartOutcome =
  /** A running instance was replaced by a provably different one. */
  | 'restarted'
  /** Nothing was running, so this was just a start. */
  | 'started'
  /** The old instance could not be stopped; nothing was launched. */
  | 'stop-failed'
  /** The replacement could not be launched at all. */
  | 'launch-failed'
  /** Launched, but nothing became healthy before the deadline. */
  | 'start-timeout'
  /** Something answered, but it is the instance we thought we stopped. */
  | 'same-instance';

export type RuntimeRestartResult = {
  outcome: RuntimeRestartOutcome;
  previousInstanceId: string | null;
  newInstanceId: string | null;
  status: RuntimeStatus;
  /** Present when the launcher itself failed. */
  launchError: string | null;
};

export type RuntimeRestartDependencies = {
  controller: RuntimeController;
  /** Starts a replacement server detached from this process. Throws on failure. */
  launch(): Promise<void>;
  wait(milliseconds: number): Promise<void>;
  now(): Date;
};

export type RuntimeRestartOptions = {
  fallbackHealthUrl?: string;
  /** Deadline for the replacement to answer a health check. */
  timeoutMs?: number;
  pollIntervalMs?: number;
  stopTimeoutMs?: number;
};

/** Sized for a cold proot start: module load plus the database migration pass. */
export const DEFAULT_RESTART_TIMEOUT_MS = 90_000;
const DEFAULT_RESTART_POLL_INTERVAL_MS = 500;

export function createRuntimeRestartService(dependencies: RuntimeRestartDependencies) {
  const { controller, now } = dependencies;

  return {
    async restart(options: RuntimeRestartOptions = {}): Promise<RuntimeRestartResult> {
      const { fallbackHealthUrl } = options;
      const timeoutMs = options.timeoutMs ?? DEFAULT_RESTART_TIMEOUT_MS;
      const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_RESTART_POLL_INTERVAL_MS;

      const stopResult = await controller.stop({
        fallbackHealthUrl,
        timeoutMs: options.stopTimeoutMs,
      });

      // A runtime we could not stop is a port we cannot bind. Launching anyway
      // would produce a second server that fails at listen() and a marker that
      // describes neither of them.
      if (stopResult.outcome !== 'stopped' && stopResult.outcome !== 'already-stopped') {
        return {
          outcome: 'stop-failed',
          previousInstanceId: stopResult.signalled?.instanceId ?? null,
          newInstanceId: null,
          status: stopResult.status,
          launchError: null,
        };
      }

      const previousInstanceId = stopResult.signalled?.instanceId ?? null;

      try {
        await dependencies.launch();
      } catch (error) {
        return {
          outcome: 'launch-failed',
          previousInstanceId,
          newInstanceId: null,
          status: stopResult.status,
          launchError: error instanceof Error ? error.message : String(error),
        };
      }

      const since = now().toISOString();
      const deadline = now().getTime() + timeoutMs;
      let latest = stopResult.status;

      while (now().getTime() < deadline) {
        await dependencies.wait(pollIntervalMs);
        latest = await controller.status(
          { fallbackHealthUrl },
          { kind: 'start', since, deadlineMs: timeoutMs },
        );

        if (latest.state !== 'online') continue;

        // The identity check is the whole verification. Without it, an old
        // process that ignored SIGTERM and kept the port reads as a successful
        // restart, and the user runs the previous build believing otherwise.
        if (previousInstanceId && latest.instanceId === previousInstanceId) {
          return {
            outcome: 'same-instance',
            previousInstanceId,
            newInstanceId: latest.instanceId,
            status: latest,
            launchError: null,
          };
        }

        return {
          outcome: previousInstanceId ? 'restarted' : 'started',
          previousInstanceId,
          newInstanceId: latest.instanceId,
          status: latest,
          launchError: null,
        };
      }

      return {
        outcome: 'start-timeout',
        previousInstanceId,
        newInstanceId: null,
        status: { ...latest, state: 'error', reason: 'start-timeout' },
        launchError: null,
      };
    },
  };
}

export type RuntimeRestartService = ReturnType<typeof createRuntimeRestartService>;
