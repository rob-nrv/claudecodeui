import { queuedMessagesDb, sessionsDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

/**
 * Shape the composer already builds client-side for a queued send (mirrors
 * `StoredQueuedMessage` in `src/components/chat/utils/chatStorage.ts`). This
 * service never inspects `options`/`attachments` beyond their JSON shape —
 * they are opaque composer state, replayed verbatim through the normal
 * `chat.send` path once the client claims the row.
 */
export type StoredQueuedMessagePayload = {
  content: string;
  options?: Record<string, unknown>;
  attachments?: unknown[];
};

export type QueuedMessageSnapshot = {
  message: StoredQueuedMessagePayload;
  /** Opaque CAS token — the exact stored JSON string. Pass back verbatim to claim/restore. */
  claimToken: string;
};

const MAX_QUEUED_CONTENT_LENGTH = 100_000;

function requireSession(sessionId: string): void {
  if (!sessionsDb.getSessionById(sessionId)) {
    throw new AppError(`Session "${sessionId}" was not found.`, {
      code: 'SESSION_NOT_FOUND',
      statusCode: 404,
    });
  }
}

function requireClaimToken(claimToken: unknown): string {
  if (typeof claimToken !== 'string' || !claimToken) {
    throw new AppError('claimToken is required.', {
      code: 'QUEUED_MESSAGE_CLAIM_TOKEN_REQUIRED',
      statusCode: 400,
    });
  }
  return claimToken;
}

/** Corrupt/legacy rows read back as absent rather than failing the caller. */
function parseStoredMessage(content: string): StoredQueuedMessagePayload | null {
  try {
    const parsed = JSON.parse(content) as StoredQueuedMessagePayload;
    if (parsed && typeof parsed.content === 'string') {
      return parsed;
    }
  } catch {
    // fall through
  }
  return null;
}

function validatePayload(payload: unknown): StoredQueuedMessagePayload {
  const body = payload as Partial<StoredQueuedMessagePayload> | null;
  if (!body || typeof body.content !== 'string') {
    throw new AppError('content is required.', {
      code: 'QUEUED_MESSAGE_CONTENT_REQUIRED',
      statusCode: 400,
    });
  }
  if (body.content.length > MAX_QUEUED_CONTENT_LENGTH) {
    throw new AppError('content is too long.', {
      code: 'QUEUED_MESSAGE_CONTENT_TOO_LONG',
      statusCode: 413,
    });
  }
  if (
    body.options !== undefined
    && (typeof body.options !== 'object' || body.options === null || Array.isArray(body.options))
  ) {
    throw new AppError('options must be an object.', {
      code: 'QUEUED_MESSAGE_OPTIONS_INVALID',
      statusCode: 400,
    });
  }
  if (body.attachments !== undefined && !Array.isArray(body.attachments)) {
    throw new AppError('attachments must be an array.', {
      code: 'QUEUED_MESSAGE_ATTACHMENTS_INVALID',
      statusCode: 400,
    });
  }

  return { content: body.content, options: body.options, attachments: body.attachments };
}

export const queuedMessagesService = {
  get(sessionId: string): QueuedMessageSnapshot | null {
    requireSession(sessionId);
    const row = queuedMessagesDb.get(sessionId);
    if (!row) {
      return null;
    }
    const message = parseStoredMessage(row.content);
    return message ? { message, claimToken: row.content } : null;
  },

  save(sessionId: string, payload: unknown): void {
    requireSession(sessionId);
    const message = validatePayload(payload);
    queuedMessagesDb.save(sessionId, JSON.stringify(message));
  },

  clear(sessionId: string): void {
    requireSession(sessionId);
    queuedMessagesDb.clear(sessionId);
  },

  /**
   * Atomically hands the queued message to the caller: only the first
   * concurrent claim (across tabs, devices, or the two client-side flush
   * paths) for a given claim token succeeds. Callers must not dispatch the
   * message unless this returns non-null.
   */
  claim(sessionId: string, claimToken: unknown): QueuedMessageSnapshot | null {
    requireSession(sessionId);
    const token = requireClaimToken(claimToken);
    if (!queuedMessagesDb.claim(sessionId, token)) {
      return null;
    }
    const message = parseStoredMessage(token);
    return message ? { message, claimToken: token } : null;
  },

  /** Puts a claimed-but-undelivered message back, unless it was replaced by a newer one. */
  restore(sessionId: string, claimToken: unknown): void {
    requireSession(sessionId);
    const token = requireClaimToken(claimToken);
    queuedMessagesDb.restore(sessionId, token);
  },
};
