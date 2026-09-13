// Pure RuntimeNode evaluation shared by every node kind — the local machine
// today, remote nodes later: how a probe outcome becomes a capability, and how
// probe age plus proven capabilities become availability. No IO lives here, so
// the rules stay deterministic and cannot drift between node kinds.
import type {
  RuntimeNodeAvailability,
  RuntimeNodeCapability,
  RuntimeNodeCapabilityId,
  RuntimeNodeCapabilityStatus,
  RuntimeNodeProbeOutcome,
} from '@/shared/types.js';

/** Every capability a node reports, in display order. Consumed by the runtime-nodes service. */
export const RUNTIME_NODE_CAPABILITY_IDS: readonly RuntimeNodeCapabilityId[] = [
  'claude-cli',
  'git-cli',
  'workspace-filesystem',
  'background-execution',
];

/** Capabilities whose proof means the node can actually run a new execution. */
const EXECUTION_CAPABILITY_IDS: ReadonlySet<RuntimeNodeCapabilityId> = new Set(['claude-cli']);

/** How long a completed probe vouches for a node before it reads as unavailable. */
export const RUNTIME_NODE_FRESHNESS_MS = 5 * 60_000;

/** A probe timestamp further in the future than this is not trusted as fresh. */
const MAX_FUTURE_SKEW_MS = 60_000;

const MAX_DETAIL_LENGTH = 80;
const MAX_REASON_LENGTH = 64;

const CAPABILITY_STATUSES: ReadonlySet<string> = new Set<RuntimeNodeCapabilityStatus>([
  'available',
  'unavailable',
  'unsupported',
  'unknown',
]);

/**
 * Keeps a probe detail to one short, path-free line such as a CLI version.
 * Anything that looks like a path is dropped entirely rather than truncated.
 */
function sanitizeDetail(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const firstLine = value.split(/\r?\n/)[0]?.trim() ?? '';
  if (!firstLine || firstLine.includes('/') || firstLine.includes('\\')) {
    return null;
  }
  return firstLine.replace(/[^\w .()+:-]/g, '').trim().slice(0, MAX_DETAIL_LENGTH) || null;
}

function sanitizeReason(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, MAX_REASON_LENGTH);
  return normalized || null;
}

/**
 * Stamps one probe outcome as a capability. Consumed by the runtime-nodes
 * service right after a probe cycle completes.
 */
export function toRuntimeNodeCapability(
  id: RuntimeNodeCapabilityId,
  outcome: RuntimeNodeProbeOutcome,
  probedAt: number,
): RuntimeNodeCapability {
  switch (outcome.outcome) {
    case 'proven':
      return { id, status: 'available', detail: sanitizeDetail(outcome.detail), reason: null, probedAt };
    case 'failed':
      return { id, status: 'unavailable', detail: null, reason: sanitizeReason(outcome.reason) ?? 'probe_failed', probedAt };
    case 'not_supported':
      return { id, status: 'unsupported', detail: null, reason: sanitizeReason(outcome.reason) ?? 'not_supported', probedAt };
    default:
      return { id, status: 'unknown', detail: null, reason: sanitizeReason(outcome.reason) ?? 'not_probed', probedAt: null };
  }
}

const unrecordedCapability = (id: RuntimeNodeCapabilityId): RuntimeNodeCapability => ({
  id,
  status: 'unknown',
  detail: null,
  reason: 'not_recorded',
  probedAt: null,
});

/**
 * Restores capabilities persisted by an earlier probe. The stored JSON is
 * untrusted: unknown ids and malformed entries are ignored, a non-unknown
 * status without a probe time is not evidence, and every capability without a
 * valid entry reports `unknown` instead of disappearing or inheriting a status.
 *
 * Consumed by the runtime-nodes service when building node views.
 */
export function parseStoredRuntimeNodeCapabilities(capabilitiesJson: string | null): RuntimeNodeCapability[] {
  let parsed: unknown = null;
  if (capabilitiesJson) {
    try {
      parsed = JSON.parse(capabilitiesJson);
    } catch {
      parsed = null;
    }
  }
  const entries = Array.isArray(parsed) ? parsed : [];

  return RUNTIME_NODE_CAPABILITY_IDS.map((id) => {
    const entry = entries.find(
      (candidate): candidate is Record<string, unknown> =>
        Boolean(candidate) && typeof candidate === 'object' && (candidate as Record<string, unknown>).id === id,
    );
    if (!entry || typeof entry.status !== 'string' || !CAPABILITY_STATUSES.has(entry.status)) {
      return unrecordedCapability(id);
    }

    const status = entry.status as RuntimeNodeCapabilityStatus;
    if (status === 'unknown') {
      return { id, status, detail: null, reason: sanitizeReason(entry.reason) ?? 'not_probed', probedAt: null };
    }

    const probedAt = typeof entry.probedAt === 'number' && Number.isFinite(entry.probedAt) ? entry.probedAt : null;
    if (probedAt === null) {
      return unrecordedCapability(id);
    }

    return status === 'available'
      ? { id, status, detail: sanitizeDetail(entry.detail), reason: null, probedAt }
      : { id, status, detail: null, reason: sanitizeReason(entry.reason) ?? 'probe_failed', probedAt };
  });
}

/**
 * Derives availability from evidence age and proven execution capabilities.
 * Nothing about the control client (such as `appReady`) takes part: a node's
 * ability to execute and the UI's ability to be served are separate truths.
 *
 * Consumed by the runtime-nodes service for every node view it returns.
 */
export function resolveRuntimeNodeAvailability(input: {
  lastSeenAt: number | null;
  capabilities: RuntimeNodeCapability[];
  now: number;
  freshnessMs?: number;
}): RuntimeNodeAvailability {
  const freshnessMs = input.freshnessMs ?? RUNTIME_NODE_FRESHNESS_MS;
  if (input.lastSeenAt === null || !Number.isFinite(input.lastSeenAt)) {
    return { state: 'unknown', reason: 'never_probed', lastSeenAt: null, freshUntil: null };
  }

  const lastSeenAt = new Date(input.lastSeenAt).toISOString();
  const freshUntil = new Date(input.lastSeenAt + freshnessMs).toISOString();
  const age = input.now - input.lastSeenAt;
  if (age > freshnessMs || age < -MAX_FUTURE_SKEW_MS) {
    return { state: 'unavailable', reason: 'probe_stale', lastSeenAt, freshUntil };
  }

  const canExecute = input.capabilities.some(
    (capability) => EXECUTION_CAPABILITY_IDS.has(capability.id) && capability.status === 'available',
  );
  return canExecute
    ? { state: 'available', reason: 'fresh_probe', lastSeenAt, freshUntil }
    : { state: 'degraded', reason: 'no_execution_capability', lastSeenAt, freshUntil };
}
