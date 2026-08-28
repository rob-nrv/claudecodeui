// Start from stopped. `runtime-restart.service.ts` already contains a launch
// and verify sequence, but it always stops first — correct for restart, wrong
// for start, where an already-online runtime must be left alone rather than
// replaced. This service adds that idempotence gate in front of the same
// launch + poll-for-verified-identity shape, without touching restart's
// tested stop-then-replace path.
import type { RuntimeController } from './runtime-controller.service.js';
import type { RuntimeStatus } from './runtime-status.js';

export type RuntimeStartOutcome =
  /** Nothing was running or startable in place; a new instance came online. */
  | 'started'
  /** Already online and its identity checks out; no launch was attempted. */
  | 'already-running'
  /** A start already looked to be in flight (fresh marker, no health yet). */
  | 'already-starting'
  /** A different, unowned instance holds the port; launching would collide. */
  | 'blocked-foreign-instance'
  /** The replacement could not be launched at all. */
  | 'launch-failed'
  /** Launched, but nothing became healthy before the deadline. */
  | 'start-timeout';

export type RuntimeStartResult = {
  outcome: RuntimeStartOutcome;
  newInstanceId: string | null;
  status: RuntimeStatus;
  /** Present when the launcher itself failed. */
  launchError: string | null;
};

export type RuntimeStartDependencies = {
  controller: RuntimeController;
  /** Starts the server detached from this process. Throws on failure. */
  launch(): Promise<void>;
  wait(milliseconds: number): Promise<void>;
  now(): Date;
};

export type RuntimeStartOptions = {
  fallbackHealthUrl?: string;
  /** Deadline for the new instance to answer a health check. */
  timeoutMs?: number;
  pollIntervalMs?: number;
};

/** Same sizing as restart: a cold proot/Termux boot, module load plus migrations. */
export const DEFAULT_START_TIMEOUT_MS = 90_000;
const DEFAULT_START_POLL_INTERVAL_MS = 500;

export function createRuntimeStartService(dependencies: RuntimeStartDependencies) {
  const { controller, now } = dependencies;

  return {
    async start(options: RuntimeStartOptions = {}): Promise<RuntimeStartResult> {
      const { fallbackHealthUrl } = options;
      const timeoutMs = options.timeoutMs ?? DEFAULT_START_TIMEOUT_MS;
      const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_START_POLL_INTERVAL_MS;

      const initial = await controller.status({ fallbackHealthUrl });

      if (initial.state === 'online') {
        return { outcome: 'already-running', newInstanceId: initial.instanceId, status: initial, launchError: null };
      }
      if (initial.state === 'starting') {
        return { outcome: 'already-starting', newInstanceId: null, status: initial, launchError: null };
      }
      // The port answers, but not with an identity we can reconcile against our
      // marker: someone else's process. Refuse rather than launch a second
      // server that can only fail to bind, or worse, sit ambiguous with it.
      if (initial.reason === 'instance-mismatch') {
        return { outcome: 'blocked-foreign-instance', newInstanceId: null, status: initial, launchError: null };
      }

      try {
        await dependencies.launch();
      } catch (error) {
        return {
          outcome: 'launch-failed',
          newInstanceId: null,
          status: initial,
          launchError: error instanceof Error ? error.message : String(error),
        };
      }

      const since = now().toISOString();
      const deadline = now().getTime() + timeoutMs;
      let latest = initial;

      while (now().getTime() < deadline) {
        await dependencies.wait(pollIntervalMs);
        latest = await controller.status(
          { fallbackHealthUrl },
          { kind: 'start', since, deadlineMs: timeoutMs },
        );
        if (latest.state === 'online') {
          return { outcome: 'started', newInstanceId: latest.instanceId, status: latest, launchError: null };
        }
      }

      return {
        outcome: 'start-timeout',
        newInstanceId: null,
        status: { ...latest, state: 'error', reason: 'start-timeout' },
        launchError: null,
      };
    },
  };
}

export type RuntimeStartService = ReturnType<typeof createRuntimeStartService>;
