import { useEffect, useRef } from 'react';

import { clearQueuedMessage, readQueuedMessage } from '../components/chat/utils/chatStorage';
import { fetchAndClaimQueuedMessage, restoreQueuedMessageOnServer } from '../components/chat/utils/queuedMessageApi';

import type { MarkSessionProcessing, SessionActivityMap } from './useSessionProtection';

interface UseQueuedMessageAutoSendArgs {
  processingSessions: SessionActivityMap;
  /**
   * The session currently open in the chat view. Its queued draft is owned by
   * the composer (which also handles file attachments and slash commands),
   * so this hook never touches it.
   */
  activeSessionId: string | null;
  ws: WebSocket | null;
  /** Returns whether the frame was actually sent (`false` if the socket wasn't open). */
  sendMessage: (message: unknown) => boolean;
  markSessionProcessing: MarkSessionProcessing;
}

/**
 * Dispatches queued messages for sessions the user is NOT currently viewing.
 *
 * The composer persists each queued draft (text + send options snapshotted at
 * queue time) both to localStorage (`queued_message_<sessionId>`, a same-tab
 * optimistic mirror) and to the server (the authoritative queue). When a
 * session's run leaves the processing map — its previous response completed
 * — this hook sends that session's queued message immediately instead of
 * waiting for the user to open the session again. Atomically claiming the
 * server row before sending is what keeps the composer's own flush (or
 * another tab/device) from double-sending.
 */
export function useQueuedMessageAutoSend({
  processingSessions,
  activeSessionId,
  ws,
  sendMessage,
  markSessionProcessing,
}: UseQueuedMessageAutoSendArgs) {
  const prevProcessingRef = useRef<ReadonlySet<string>>(new Set());

  useEffect(() => {
    const prev = prevProcessingRef.current;
    const current = new Set(processingSessions.keys());
    prevProcessingRef.current = current;

    for (const sessionId of prev) {
      if (current.has(sessionId) || sessionId === activeSessionId) {
        continue;
      }

      const queued = readQueuedMessage(sessionId);
      if (!queued) {
        continue;
      }

      // A closed socket would drop the send silently; keep the draft so the
      // composer (or a later completion) can retry once we're connected.
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        continue;
      }

      // The server row is the claim ticket shared with the composer's own
      // flush and the mid-upload session-switch send. Only a successful claim
      // may dispatch, so none of them can ever both send this session's draft.
      fetchAndClaimQueuedMessage(sessionId)
        .then((claimed) => {
          if (!claimed) {
            // Nothing queued, or another path/tab/device claimed it first.
            clearQueuedMessage(sessionId);
            return;
          }
          clearQueuedMessage(sessionId);
          const claimedMessage = claimed.message;
          const delivered = sendMessage({
            type: 'chat.send',
            sessionId,
            content: claimedMessage.content,
            options: { ...(claimedMessage.options ?? {}), attachments: claimedMessage.attachments ?? [] },
          });
          markSessionProcessing(sessionId, { statusText: null, canInterrupt: true });
          if (!delivered) {
            // The socket closed in the gap between the check above and this
            // send: put the claimed message back instead of losing it.
            restoreQueuedMessageOnServer(sessionId, claimed.claimToken).catch((error) => {
              console.error('Failed to restore an undelivered queued message:', error);
            });
          }
        })
        .catch((error) => {
          console.error('Failed to claim queued message for dispatch:', error);
        });
    }
  }, [processingSessions, activeSessionId, ws, sendMessage, markSessionProcessing]);
}
