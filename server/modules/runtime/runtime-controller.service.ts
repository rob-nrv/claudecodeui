// The platform-neutral half of a runtime controller: it turns collected evidence
// into a state, and performs a stop that can prove it targeted the right process.
//
// Launching is deliberately absent. Starting a runtime is the one genuinely
// platform-specific act (a Termux intent, a detached spawn, a systemd unit), so
// it stays in each adapter while everything that decides *whether* to act, and
// whether an act worked, lives here where it can be tested.
import type { RuntimeProbe, RuntimeProbeOptions } from './runtime-probe.js';
import { type RuntimeIntent, type RuntimeStatus, resolveRuntimeStatus } from './runtime-status.js';

export type RuntimeStopOutcome =
  /** Nothing was running; stop is a no-op. */
  | 'already-stopped'
  /** We signalled our own instance and observed it go away. */
  | 'stopped'
  /** A runtime answers, but we cannot prove it is ours, so we refuse to signal it. */
  | 'refused-not-owned'
  /** The signal could not be delivered at all. */
  | 'signal-failed'
  /** Signalled, but the runtime was still there when the deadline passed. */
  | 'timeout';

export type RuntimeStopResult = {
  outcome: RuntimeStopOutcome;
  status: RuntimeStatus;
  /** The instance we signalled, when we signalled one. */
  signalled: { instanceId: string; pid: number } | null;
};

export type RuntimeControllerDependencies = {
  probe: RuntimeProbe;
  /** Delivers a signal to a pid. Must throw when delivery fails. */
  sendSignal(pid: number, signal: NodeJS.Signals): void;
  wait(milliseconds: number): Promise<void>;
  now(): Date;
};

export type RuntimeStopOptions = RuntimeProbeOptions & {
  timeoutMs?: number;
  pollIntervalMs?: number;
};

/** Long enough for plugin and browser-session teardown, short enough to stay a UI action. */
export const DEFAULT_STOP_TIMEOUT_MS = 15_000;
const DEFAULT_STOP_POLL_INTERVAL_MS = 250;

export function createRuntimeController(dependencies: RuntimeControllerDependencies) {
  const { probe, now } = dependencies;

  async function status(
    options: RuntimeProbeOptions = {},
    intent: RuntimeIntent | null = null,
  ): Promise<RuntimeStatus> {
    return resolveRuntimeStatus({ evidence: await probe.collect(options), intent, now: now() });
  }

  return {
    status,

    /**
     * Stops the runtime this controller can prove it owns.
     *
     * The ownership gate is the whole point: `ownedByMarker` is only true when a
     * live /health identity matched the marker identity moments ago, so the pid
     * we signal cannot be a recycled pid from a stale marker, and cannot belong
     * to a different CloudCLI instance that happens to hold the port. Anything
     * we cannot prove, we refuse to signal — never a broad match on process name
     * or port, and never an escalation to SIGKILL.
     */
    async stop(options: RuntimeStopOptions = {}): Promise<RuntimeStopResult> {
      const timeoutMs = options.timeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
      const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_STOP_POLL_INTERVAL_MS;
      const initial = await status(options);

      if (initial.state === 'stopped') {
        return { outcome: 'already-stopped', status: initial, signalled: null };
      }
      if (!initial.ownedByMarker || !initial.pid || !initial.instanceId) {
        return { outcome: 'refused-not-owned', status: initial, signalled: null };
      }

      const signalled = { instanceId: initial.instanceId, pid: initial.pid };
      try {
        dependencies.sendSignal(initial.pid, 'SIGTERM');
      } catch {
        return { outcome: 'signal-failed', status: initial, signalled };
      }

      const intent: RuntimeIntent = { kind: 'stop', since: now().toISOString(), deadlineMs: timeoutMs };
      const deadline = now().getTime() + timeoutMs;
      let latest = initial;

      while (now().getTime() < deadline) {
        await dependencies.wait(pollIntervalMs);
        latest = await status(options, intent);
        if (latest.state === 'stopped') {
          return { outcome: 'stopped', status: latest, signalled };
        }
      }

      return {
        outcome: 'timeout',
        status: { ...latest, state: 'error', reason: 'stop-timeout' },
        signalled,
      };
    },
  };
}

export type RuntimeController = ReturnType<typeof createRuntimeController>;
