import type { PendingPermissionRequest } from '../types/types';

/**
 * Pure state transitions for the tool approvals shown in the composer.
 *
 * The server owns whether a request is still pending (`chat_subscribed`
 * snapshot, `permission_*` events, `permission_response_ack`). These helpers
 * only fold that truth into the visible list, and keep the client-only states
 * — `submitting`, and settled notices the user has not dismissed yet.
 */

type PermissionOutcomeRecord = {
  requestId: string;
  sessionId?: string | null;
  toolName?: string;
  outcome: 'answered' | 'expired' | 'cancelled';
  settledAt?: string;
  input?: unknown;
};

type PermissionResponseAck = {
  requestId?: unknown;
  accepted?: unknown;
  reason?: unknown;
};

/** The user can still answer this request. */
export const isAwaitingPermissionDecision = (request: PendingPermissionRequest): boolean =>
  !request.status || request.status === 'pending';

/** The request still blocks the run: awaiting an answer, or one is being sent. */
export const isOpenPermissionRequest = (request: PendingPermissionRequest): boolean =>
  isAwaitingPermissionDecision(request) || request.status === 'submitting';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object';

export function addPermissionRequest(
  requests: PendingPermissionRequest[],
  incoming: PendingPermissionRequest,
): PendingPermissionRequest[] {
  // Replays re-deliver requests; the local entry (possibly already settled) wins.
  if (requests.some((request) => request.requestId === incoming.requestId)) {
    return requests;
  }
  return [...requests, { ...incoming, status: 'pending' }];
}

/** The server settled the request with an answer (or the run was cancelled). */
export function removePermissionRequest(
  requests: PendingPermissionRequest[],
  requestId: string,
): PendingPermissionRequest[] {
  const next = requests.filter((request) => request.requestId !== requestId);
  return next.length === requests.length ? requests : next;
}

export function expirePermissionRequest(
  requests: PendingPermissionRequest[],
  requestId: string,
): PendingPermissionRequest[] {
  return requests.map((request) => (
    request.requestId === requestId && isOpenPermissionRequest(request)
      ? { ...request, status: 'expired', notice: undefined }
      : request
  ));
}

export function markPermissionRequestsSubmitting(
  requests: PendingPermissionRequest[],
  requestIds: readonly string[],
): PendingPermissionRequest[] {
  if (requestIds.length === 0) {
    return requests;
  }
  return requests.map((request) => (
    requestIds.includes(request.requestId) && isAwaitingPermissionDecision(request)
      ? { ...request, status: 'submitting', notice: undefined }
      : request
  ));
}

/** The answer never left this client (socket closed); it stays answerable. */
export function flagPermissionRequestsNotSent(
  requests: PendingPermissionRequest[],
  requestIds: readonly string[],
): PendingPermissionRequest[] {
  if (requestIds.length === 0) {
    return requests;
  }
  return requests.map((request) => (
    requestIds.includes(request.requestId) && isOpenPermissionRequest(request)
      ? { ...request, status: 'pending', notice: 'not_sent' }
      : request
  ));
}

/** Folds the server's verdict on one of this client's answers into the list. */
export function applyPermissionResponseAck(
  requests: PendingPermissionRequest[],
  ack: PermissionResponseAck,
): PendingPermissionRequest[] {
  if (typeof ack.requestId !== 'string') {
    return requests;
  }
  if (ack.accepted === true || ack.reason === 'already_answered' || ack.reason === 'cancelled') {
    return removePermissionRequest(requests, ack.requestId);
  }
  if (ack.reason === 'expired') {
    return expirePermissionRequest(requests, ack.requestId);
  }
  const requestId = ack.requestId;
  return requests.map((request) => (
    request.requestId === requestId ? { ...request, status: 'unavailable', notice: undefined } : request
  ));
}

/** A run ended: nothing can be answered any more, but settled notices stay. */
export function clearOpenPermissionRequests(requests: PendingPermissionRequest[]): PendingPermissionRequest[] {
  const next = requests.filter((request) => !isOpenPermissionRequest(request));
  return next.length === requests.length ? requests : next;
}

/**
 * Reconciles one session's requests with its `chat_subscribed` snapshot.
 *
 * - Server-pending requests are answerable again, even if this client thought
 *   an answer was on its way (it may have died with the old socket; answering
 *   twice is rejected server-side as `already_answered`).
 * - Local open requests the server no longer holds are settled from the
 *   server's recent outcomes: answered/cancelled disappear, expired become an
 *   expired notice, and unknown ones become "no longer available".
 * - Expiries this client never saw (it was offline) are surfaced unless the
 *   user already dismissed them.
 */
export function applyPermissionSnapshot(
  requests: PendingPermissionRequest[],
  sessionId: string,
  snapshot: { pendingPermissions: unknown; recentPermissionOutcomes?: unknown },
  dismissedRequestIds: ReadonlySet<string>,
): PendingPermissionRequest[] {
  const serverPending = (Array.isArray(snapshot.pendingPermissions) ? snapshot.pendingPermissions : [])
    .filter((entry): entry is PendingPermissionRequest => isRecord(entry) && typeof entry.requestId === 'string');
  const outcomes = new Map<string, PermissionOutcomeRecord>();
  for (const entry of Array.isArray(snapshot.recentPermissionOutcomes) ? snapshot.recentPermissionOutcomes : []) {
    if (isRecord(entry) && typeof entry.requestId === 'string') {
      outcomes.set(entry.requestId, entry as PermissionOutcomeRecord);
    }
  }
  const serverPendingById = new Map(serverPending.map((entry) => [entry.requestId, entry]));

  const next: PendingPermissionRequest[] = [];
  for (const request of requests) {
    if (request.sessionId !== sessionId) {
      next.push(request);
      continue;
    }
    const pending = serverPendingById.get(request.requestId);
    if (pending) {
      next.push({ ...request, ...pending, sessionId, status: 'pending', notice: request.notice });
      continue;
    }
    if (!isOpenPermissionRequest(request)) {
      next.push(request);
      continue;
    }
    const outcome = outcomes.get(request.requestId)?.outcome;
    if (outcome === 'expired') {
      next.push({ ...request, status: 'expired', notice: undefined });
    } else if (!outcome) {
      next.push({ ...request, status: 'unavailable', notice: undefined });
    }
  }

  const known = new Set(next.map((request) => request.requestId));
  for (const pending of serverPending) {
    if (!known.has(pending.requestId)) {
      next.push({ ...pending, sessionId, status: 'pending' });
      known.add(pending.requestId);
    }
  }
  for (const outcome of outcomes.values()) {
    if (outcome.outcome === 'expired' && !known.has(outcome.requestId) && !dismissedRequestIds.has(outcome.requestId)) {
      next.push({
        requestId: outcome.requestId,
        toolName: outcome.toolName || 'UnknownTool',
        input: outcome.input,
        sessionId,
        status: 'expired',
      });
    }
  }
  return next;
}
