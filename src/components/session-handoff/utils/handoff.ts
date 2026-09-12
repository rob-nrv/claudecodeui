import type { ClaudeProfileConnectionState } from '../../settings/hooks/useClaudeProfiles';
import type {
  HandoffRequest,
  HandoffSourceBlockedReason,
  HandoffTargetOption,
  HandoffTargetUnavailableReason,
  SessionLineage,
} from '../types/types';

/** Error carrying the backend's stable `error.code`, so the UI can react to it. */
export class HandoffRequestError extends Error {
  readonly code: string | null;

  constructor(message: string, code: string | null) {
    super(message);
    this.name = 'HandoffRequestError';
    this.code = code;
  }
}

/** Unwraps `{ success, data }` or throws with the backend's code and message. */
export async function readApiResult<T>(response: Response): Promise<T> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  const payload = (body ?? {}) as { success?: boolean; data?: T; error?: { code?: string; message?: string } | string };
  if (!response.ok || payload.success === false) {
    const error = typeof payload.error === 'object' && payload.error ? payload.error : null;
    const message = error?.message
      || (typeof payload.error === 'string' ? payload.error : '')
      || `Request failed (${response.status})`;
    throw new HandoffRequestError(message, error?.code ?? null);
  }

  return payload.data as T;
}

export const handoffTargetKey = (option: Pick<HandoffTargetOption, 'provider' | 'claudeProfileId'>): string =>
  `${option.provider}:${option.claudeProfileId ?? ''}`;

/**
 * The request always names its target. A Claude target always carries the
 * `claudeProfileId` key — `null` included — so the backend never has to guess
 * which account was meant.
 */
export function buildHandoffRequest(option: HandoffTargetOption, note: string): HandoffRequest {
  const trimmedNote = note.trim();
  return {
    provider: option.provider,
    ...(option.provider === 'claude' ? { claudeProfileId: option.claudeProfileId } : {}),
    ...(trimmedNote ? { note: trimmedNote } : {}),
  };
}

export function describeUnavailableReason(reason: HandoffTargetUnavailableReason | null): string | null {
  switch (reason) {
    case 'same_as_source':
      return 'Current run — pick another account or provider';
    case 'profile_expired':
      return 'Sign-in expired — reconnect it in Settings';
    case 'profile_not_authenticated':
      return 'Signed out — sign in from Settings';
    case 'runtime_unavailable':
      return 'Not available on this server';
    default:
      return null;
  }
}

export function describeConnectionState(state: ClaudeProfileConnectionState | null): string | null {
  switch (state) {
    case 'connected':
      return 'Signed in';
    case 'unknown':
      return 'Not verified yet';
    default:
      return null;
  }
}

export function describeBlockedReason(reason: HandoffSourceBlockedReason | null): string | null {
  switch (reason) {
    case 'source_running':
      return 'This session is still running. Wait for it to finish, or stop it, before handing the task off.';
    case 'source_not_started':
      return 'This session has no conversation yet, so there is nothing to hand off.';
    case 'source_no_workspace':
      return 'This session has no workspace to continue in.';
    default:
      return null;
  }
}

/** Codes after which the target list itself may be stale and should be reloaded. */
export function shouldReloadTargetsAfterError(code: string | null): boolean {
  return code === 'HANDOFF_SOURCE_RUNNING'
    || code === 'HANDOFF_TARGET_PROFILE_UNAVAILABLE'
    || code === 'HANDOFF_TARGET_PROVIDER_UNAVAILABLE'
    || code === 'CLAUDE_PROFILE_NOT_FOUND';
}

export type HandoffPrefillEligibilityInput = {
  lineage: SessionLineage | null;
  sessionId: string | null | undefined;
  hasMessages: boolean;
  isBusy: boolean;
};

/**
 * Whether `sessionId` is currently an unsent handoff target: shared by
 * `resolveHandoffPrefill` (what to show) and `isHandoffDraftActive` (whether
 * the composer's content belongs to this session alone) so the two can never
 * disagree about which sessions are "live" handoff targets.
 */
function isEligibleHandoffTarget(input: HandoffPrefillEligibilityInput): boolean {
  const incoming = input.lineage?.incoming;
  if (!incoming || !input.sessionId || input.lineage?.sessionId !== input.sessionId) {
    return false;
  }
  return !incoming.targetStarted && !input.hasMessages && !input.isBusy;
}

/**
 * The handoff package to place in the composer, or null.
 *
 * Only for the target session itself, only while it has not produced its own
 * native session, and only once nothing is loading or displayed — the package
 * is the context of a first send, never something to re-inject later.
 */
export function resolveHandoffPrefill(input: HandoffPrefillEligibilityInput): string | null {
  if (!isEligibleHandoffTarget(input)) {
    return null;
  }
  return input.lineage!.incoming!.handoffPackage || null;
}

/**
 * Whether the active session's composer content is, right now, an unsent
 * handoff draft — i.e. must never be persisted to the project-wide draft, and
 * must never be visible from any other session.
 */
export function isHandoffDraftActive(input: HandoffPrefillEligibilityInput): boolean {
  return isEligibleHandoffTarget(input);
}

export type HandoffDraftFrame = {
  sessionId: string | null;
  /** From `isHandoffDraftActive` for this exact `sessionId`. */
  isActive: boolean;
  /** The composer's current content. */
  input: string;
};

export type HandoffDraftPlan = {
  /** Previous tracked session whose current content must be saved under its own key, or null. */
  stashSessionId: string | null;
  stashContent: string;
  /** Previous tracked session whose draft is consumed (sent) and must not be offered again, or null. */
  consumeSessionId: string | null;
  /** Whether the shared composer input must be reset to '' as part of this plan. */
  resetInput: boolean;
  /** The session that owns the composer's current (or about-to-load) content, or null if none does. */
  trackedSessionId: string | null;
  /** Set when the current session should have this value loaded into the composer. */
  loadInput: string | null;
};

const NO_OP_PLAN = (trackedSessionId: string | null): HandoffDraftPlan => ({
  stashSessionId: null,
  stashContent: '',
  consumeSessionId: null,
  resetInput: false,
  trackedSessionId,
  loadInput: null,
});

/**
 * Decides what FT-M05-R1 ownership bookkeeping is due this render.
 *
 * `trackedSessionId` names whichever session most recently owned the shared
 * composer input for an unsent handoff draft (null if none does). This is a
 * pure decision function — the caller performs the actual `setInput`/storage
 * side effects it names — so the ownership rules (never let a target's
 * package answer for another session, whether that's a live switch or a
 * cold reload landing on a different session) are provable without mounting
 * the chat UI.
 *
 * Two release cases are distinguished only by whether `current.sessionId`
 * still equals the previously tracked session:
 * - same session, no longer eligible (its first message was sent): the draft
 *   is consumed, not preserved — a later visit must not resurrect it.
 * - different session (or none): the tracked session's content is stashed
 *   under its own key first, so returning to it later can restore it, then
 *   the shared input is cleared so it cannot answer for the new session.
 *
 * A session claims ownership only when it is itself an eligible target, no
 * other session already holds it, and the composer is empty — a real,
 * unrelated draft already in the box is never overwritten.
 */
export function planHandoffDraftOwnership(
  previous: { trackedSessionId: string | null },
  current: HandoffDraftFrame,
  storedDraftForCurrentSession: string | null,
  canonicalPackageForCurrentSession: string | null,
): HandoffDraftPlan {
  const plan = NO_OP_PLAN(previous.trackedSessionId);
  const { trackedSessionId } = previous;

  if (trackedSessionId && (trackedSessionId !== current.sessionId || !current.isActive)) {
    if (trackedSessionId === current.sessionId) {
      plan.consumeSessionId = trackedSessionId;
    } else {
      plan.stashSessionId = trackedSessionId;
      plan.stashContent = current.input;
      plan.resetInput = true;
    }
    plan.trackedSessionId = null;
  }

  const inputAfterRelease = plan.resetInput ? '' : current.input;
  if (
    current.isActive
    && current.sessionId
    && plan.trackedSessionId !== current.sessionId
    && !inputAfterRelease.trim()
  ) {
    plan.trackedSessionId = current.sessionId;
    plan.loadInput = storedDraftForCurrentSession ?? canonicalPackageForCurrentSession ?? '';
  }

  return plan;
}
