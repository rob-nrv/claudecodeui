import { getConnection } from '@/modules/database/connection.js';

export type QueuedMessageRow = {
  session_id: string;
  content: string;
  updated_at: string;
};

/**
 * Server-side single-slot queue used to persist "send after this run
 * finishes" messages (FT-M03 Queue 2.0 foundations). `content` is an opaque
 * JSON string the caller owns the shape of; this repository never parses it,
 * so a `get()` result's `content` also doubles as the CAS token for `claim`
 * and `restore`.
 */
export const queuedMessagesDb = {
  get(sessionId: string): QueuedMessageRow | null {
    const db = getConnection();
    const row = db
      .prepare('SELECT session_id, content, updated_at FROM queued_messages WHERE session_id = ?')
      .get(sessionId) as QueuedMessageRow | undefined;
    return row ?? null;
  },

  /** Unconditional upsert — the composer owns this row while queuing/editing. */
  save(sessionId: string, content: string): void {
    const db = getConnection();
    db.prepare(`
      INSERT INTO queued_messages (session_id, content, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(session_id) DO UPDATE SET content = excluded.content, updated_at = CURRENT_TIMESTAMP
    `).run(sessionId, content);
  },

  /** Unconditional delete — used for explicit cancel. */
  clear(sessionId: string): void {
    const db = getConnection();
    db.prepare('DELETE FROM queued_messages WHERE session_id = ?').run(sessionId);
  },

  /**
   * Atomically claims the row for dispatch: deletes it only if `content`
   * still matches the value the caller last read. Two dispatch attempts (two
   * flush paths, two tabs, two devices) can race this call for the same
   * session; the DELETE only matches one row, so only one caller ever gets
   * `true` back, even without an explicit transaction — SQLite's per-
   * statement atomicity is what makes the check-and-delete safe here.
   */
  claim(sessionId: string, content: string): boolean {
    const db = getConnection();
    const result = db
      .prepare('DELETE FROM queued_messages WHERE session_id = ? AND content = ?')
      .run(sessionId, content);
    return result.changes > 0;
  },

  /**
   * Restores a claim that could not be delivered (e.g. the run was still
   * busy, or the socket dropped before the send went out) — but only if
   * nothing wrote a newer queued message into this session in the meantime.
   * A no-op INSERT (via ON CONFLICT DO NOTHING) never clobbers that newer row.
   */
  restore(sessionId: string, content: string): void {
    const db = getConnection();
    db.prepare(`
      INSERT INTO queued_messages (session_id, content, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(session_id) DO NOTHING
    `).run(sessionId, content);
  },
};
