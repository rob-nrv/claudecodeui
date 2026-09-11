import { authenticatedFetch } from '../../../utils/api';

import type { StoredQueuedMessage } from './chatStorage';

/**
 * REST client for the server-side single-slot "send after this run
 * finishes" queue (FT-M03 Queue 2.0 foundations). This is the authoritative
 * store: `chatStorage.ts`'s localStorage copy remains a same-tab optimistic
 * cache that these calls keep in sync with, so a queued message survives a
 * closed tab, cleared storage, or a different device — not just a reload of
 * the same browser.
 */

type QueuedMessageSnapshotPayload = {
  message: StoredQueuedMessage | null;
  claimToken: string | null;
};

const queuedMessageUrl = (sessionId: string, suffix = '') =>
  `/api/providers/sessions/${encodeURIComponent(sessionId)}/queued-message${suffix}`;

async function parseSuccessResponse<T>(response: Response, action: string): Promise<T> {
  if (!response.ok) {
    throw new Error(`Failed to ${action} (${response.status})`);
  }
  const body = (await response.json()) as { data: T };
  return body.data;
}

/** Reads the session's server-persisted queued message, if any. */
export async function fetchQueuedMessage(sessionId: string): Promise<QueuedMessageSnapshotPayload> {
  const response = await authenticatedFetch(queuedMessageUrl(sessionId));
  return parseSuccessResponse<QueuedMessageSnapshotPayload>(response, 'fetch queued message');
}

/** Persists (creates or replaces) the session's queued message. */
export async function saveQueuedMessageOnServer(
  sessionId: string,
  message: StoredQueuedMessage,
): Promise<void> {
  const response = await authenticatedFetch(queuedMessageUrl(sessionId), {
    method: 'PUT',
    body: JSON.stringify(message),
  });
  await parseSuccessResponse<unknown>(response, 'save queued message');
}

/** Clears the session's queued message unconditionally (explicit cancel/edit). */
export async function clearQueuedMessageOnServer(sessionId: string): Promise<void> {
  const response = await authenticatedFetch(queuedMessageUrl(sessionId), { method: 'DELETE' });
  await parseSuccessResponse<unknown>(response, 'clear queued message');
}

/**
 * Atomically claims the queued message for dispatch. Only the first caller
 * across tabs, devices, or the two client-side flush paths to present a
 * given `claimToken` gets `claimed: true` back — every other caller must not
 * send. Callers should re-`fetchQueuedMessage` for a fresh token rather than
 * reusing one from an earlier read.
 */
export async function claimQueuedMessageOnServer(
  sessionId: string,
  claimToken: string,
): Promise<{ claimed: boolean; message: StoredQueuedMessage | null }> {
  const response = await authenticatedFetch(queuedMessageUrl(sessionId, '/claim'), {
    method: 'POST',
    body: JSON.stringify({ claimToken }),
  });
  return parseSuccessResponse<{ claimed: boolean; message: StoredQueuedMessage | null }>(
    response,
    'claim queued message',
  );
}

/** Puts a claimed-but-undelivered message back (e.g. the send never went out). */
export async function restoreQueuedMessageOnServer(sessionId: string, claimToken: string): Promise<void> {
  const response = await authenticatedFetch(queuedMessageUrl(sessionId, '/restore'), {
    method: 'POST',
    body: JSON.stringify({ claimToken }),
  });
  await parseSuccessResponse<unknown>(response, 'restore queued message');
}

/**
 * Fetches the current queue row and atomically claims it in one round trip.
 * Every dispatch path (the composer's own flush, the background auto-send,
 * or the mid-upload session-switch send) must go through this before
 * calling `sendMessage`, and only act on a non-null result — this is the
 * single choke point that makes concurrent dispatch attempts (another tab,
 * another device, or one of this app's other flush paths) resolve to at
 * most one send.
 */
export async function fetchAndClaimQueuedMessage(
  sessionId: string,
): Promise<{ claimToken: string; message: StoredQueuedMessage } | null> {
  const { claimToken } = await fetchQueuedMessage(sessionId);
  if (!claimToken) {
    return null;
  }
  const claimResult = await claimQueuedMessageOnServer(sessionId, claimToken);
  if (!claimResult.claimed || !claimResult.message) {
    return null;
  }
  return { claimToken, message: claimResult.message };
}
