import { safeLocalStorage } from '../../chat/utils/chatStorage';

/**
 * Session-scoped, unsent handoff-package draft (FT-M05-R1).
 *
 * Deliberately separate from `draft_input_<projectId>` (the project-wide
 * composer draft): a handoff package belongs to exactly the target session it
 * was created for, never to the project it happens to share with its source.
 * Keying by session id, the same way `queued_message_<sessionId>` already
 * does for queued sends, is what makes that ownership survive a reload —
 * reading `handoffDraftKey(A)` can never return something written for `B`.
 */
export const handoffDraftKey = (sessionId: string): string => `handoff_draft_${sessionId}`;

/** The session's own pending handoff draft, or null if it has none. */
export function readHandoffDraft(sessionId: string): string | null {
  const value = safeLocalStorage.getItem(handoffDraftKey(sessionId));
  return value && value.trim() ? value : null;
}

/** Overwrites the session's pending handoff draft; an empty value clears it. */
export function writeHandoffDraft(sessionId: string, content: string): void {
  if (content.trim()) {
    safeLocalStorage.setItem(handoffDraftKey(sessionId), content);
  } else {
    safeLocalStorage.removeItem(handoffDraftKey(sessionId));
  }
}

/** Drops the session's pending handoff draft — it is no longer restorable as pending. */
export function clearHandoffDraft(sessionId: string): void {
  safeLocalStorage.removeItem(handoffDraftKey(sessionId));
}
