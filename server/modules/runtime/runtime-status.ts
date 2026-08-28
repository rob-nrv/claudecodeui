// Evidence-based runtime state. Deliberately a pure function: every runtime
// controller (Electron today, an Android wrapper next, a Linux/NAS supervisor
// later) collects the same three pieces of evidence in a platform-specific way,
// then resolves them here so all of them agree on what "online" means.
//
// The two failure modes this exists to prevent:
//   - false ONLINE  — a stale marker, or a different server on the same port
//   - false STOPPED — a slow startup that has not answered /health yet
import type { LocalServerMarker, RuntimeHealth } from './runtime-marker.js';

export type RuntimeState = 'stopped' | 'starting' | 'online' | 'stopping' | 'error';

export type RuntimeStatusReason =
  /** No marker and nothing answering: the runtime is genuinely down. */
  | 'no-runtime'
  /** A CloudCLI answers but we hold no marker for it, so we must not claim to own it. */
  | 'foreign-instance'
  /** Marker identity and /health identity agree: this is our runtime. */
  | 'verified'
  /** A CloudCLI answers but predates instance identity, so ownership is unprovable. */
  | 'unverified-identity'
  /** Another CloudCLI instance holds the port our marker points at. */
  | 'instance-mismatch'
  /** Marker present, process provably gone: the marker outlived its server. */
  | 'stale-marker'
  /** Marker present, health silent, and we could not check process liveness. */
  | 'stale-marker-unverified'
  /** Marker is young enough that silence still reads as a startup in progress. */
  | 'awaiting-health'
  /** Process is alive but never became healthy within the startup grace window. */
  | 'health-timeout'
  /** A start was requested and is still within its deadline. */
  | 'start-pending'
  /** A start was requested and its deadline passed without the runtime coming up. */
  | 'start-timeout'
  /** A stop was requested and is still within its deadline. */
  | 'stop-pending'
  /** A stop was requested and the runtime is still answering past its deadline. */
  | 'stop-timeout';

/** What a controller managed to observe. `processAlive: null` means "could not check". */
export type RuntimeEvidence = {
  marker: LocalServerMarker | null;
  health: RuntimeHealth | null;
  processAlive: boolean | null;
};

/** An in-flight start/stop the controller issued but has not yet seen settle. */
export type RuntimeIntent = {
  kind: 'start' | 'stop';
  since: string;
  deadlineMs: number;
};

export type RuntimeStatus = {
  state: RuntimeState;
  reason: RuntimeStatusReason;
  /** True only when marker identity and /health identity provably match. */
  ownedByMarker: boolean;
  instanceId: string | null;
  url: string | null;
  pid: number | null;
};

/**
 * How long a marker may stay silent before silence stops meaning "still starting".
 * Sized for a cold proot/Termux boot on a phone, where module loading and the
 * database migration pass dominate; a desktop start is far inside it.
 */
export const DEFAULT_STARTUP_GRACE_MS = 45_000;

function isWithin(sinceIso: string, windowMs: number, now: Date): boolean {
  const since = Date.parse(sinceIso);
  if (Number.isNaN(since)) return false;
  return now.getTime() - since < windowMs;
}

function resolveObservedStatus(
  evidence: RuntimeEvidence,
  now: Date,
  startupGraceMs: number,
): RuntimeStatus {
  const { marker, health } = evidence;
  const base = {
    instanceId: marker?.instanceId || null,
    url: marker?.url ?? null,
    pid: marker?.pid ?? null,
  };

  if (!marker) {
    return health
      // Something is serving CloudCLI without a marker we can act on: honest to
      // report it up, dishonest to offer Stop for it.
      ? { state: 'online', reason: 'foreign-instance', ownedByMarker: false, instanceId: health.instanceId, url: null, pid: null }
      : { state: 'stopped', reason: 'no-runtime', ownedByMarker: false, ...base };
  }

  if (health) {
    if (!marker.instanceId || !health.instanceId) {
      return { state: 'online', reason: 'unverified-identity', ownedByMarker: false, ...base };
    }
    return marker.instanceId === health.instanceId
      ? { state: 'online', reason: 'verified', ownedByMarker: true, ...base }
      : { state: 'error', reason: 'instance-mismatch', ownedByMarker: false, ...base, instanceId: health.instanceId };
  }

  // A provably dead process settles the question regardless of how young the marker is.
  if (evidence.processAlive === false) {
    return { state: 'stopped', reason: 'stale-marker', ownedByMarker: false, ...base };
  }
  if (isWithin(marker.startedAt, startupGraceMs, now)) {
    return { state: 'starting', reason: 'awaiting-health', ownedByMarker: false, ...base };
  }
  if (evidence.processAlive === true) {
    return { state: 'error', reason: 'health-timeout', ownedByMarker: false, ...base };
  }
  // Liveness is uncheckable from this platform and the marker is old. Reporting
  // "stopped" keeps the common case (yesterday's marker, phone rebooted) correct;
  // the reason code preserves that it was never actually verified.
  return { state: 'stopped', reason: 'stale-marker-unverified', ownedByMarker: false, ...base };
}

/**
 * Resolves the state a runtime screen should show. An in-flight intent is layered
 * over the observed state so a slow start reads as STARTING rather than STOPPED,
 * without ever letting the intent alone claim the runtime is ONLINE.
 */
export function resolveRuntimeStatus(input: {
  evidence: RuntimeEvidence;
  intent?: RuntimeIntent | null;
  now?: Date;
  startupGraceMs?: number;
}): RuntimeStatus {
  const now = input.now ?? new Date();
  const observed = resolveObservedStatus(
    input.evidence,
    now,
    input.startupGraceMs ?? DEFAULT_STARTUP_GRACE_MS,
  );
  const intent = input.intent;
  if (!intent) return observed;

  if (intent.kind === 'start') {
    if (observed.state === 'online') return observed;
    // A different CloudCLI on our port is the actual reason the start cannot
    // succeed, so surface it now instead of spinning until the deadline.
    if (observed.reason === 'instance-mismatch') return observed;
    return isWithin(intent.since, intent.deadlineMs, now)
      ? { ...observed, state: 'starting', reason: 'start-pending' }
      : { ...observed, state: 'error', reason: 'start-timeout' };
  }

  if (observed.state === 'stopped') return observed;
  return isWithin(intent.since, intent.deadlineMs, now)
    ? { ...observed, state: 'stopping', reason: 'stop-pending' }
    : { ...observed, state: 'error', reason: 'stop-timeout' };
}
