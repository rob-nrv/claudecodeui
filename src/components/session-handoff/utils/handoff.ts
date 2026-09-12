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

/**
 * The handoff package to place in the composer, or null.
 *
 * Only for the target session itself, only while it has not produced its own
 * native session, and only once nothing is loading or displayed — the package
 * is the context of a first send, never something to re-inject later.
 */
export function resolveHandoffPrefill(input: {
  lineage: SessionLineage | null;
  sessionId: string | null | undefined;
  hasMessages: boolean;
  isBusy: boolean;
}): string | null {
  const incoming = input.lineage?.incoming;
  if (!incoming || !input.sessionId || input.lineage?.sessionId !== input.sessionId) {
    return null;
  }
  if (incoming.targetStarted || input.hasMessages || input.isBusy) {
    return null;
  }
  return incoming.handoffPackage || null;
}
