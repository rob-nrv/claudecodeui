import { getConnection } from '@/modules/database/connection.js';

/** A browser session created through the remote gateway (FT-M08). Never carries the cookie value. */
export type RemoteBrowserSessionRecord = {
  sessionId: string;
  userId: number;
  label: string | null;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  revokedAt: number | null;
};

type RemoteBrowserSessionRow = {
  session_id: string;
  token_hash: string;
  user_id: number;
  label: string | null;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  revoked_at: number | null;
};

const toSessionRecord = (row: RemoteBrowserSessionRow): RemoteBrowserSessionRecord => ({
  sessionId: row.session_id,
  userId: row.user_id,
  label: row.label,
  createdAt: row.created_at,
  lastSeenAt: row.last_seen_at,
  expiresAt: row.expires_at,
  revokedAt: typeof row.revoked_at === 'number' ? row.revoked_at : null,
});

export const remoteAccessDb = {
  createPairingCode(input: { codeHash: string; createdByUserId: number; createdAt: number; expiresAt: number }): void {
    getConnection()
      .prepare(
        `INSERT INTO remote_pairing_codes (code_hash, created_by_user_id, created_at, expires_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(input.codeHash, input.createdByUserId, input.createdAt, input.expiresAt);
  },

  countOutstandingPairingCodes(now: number): number {
    const row = getConnection()
      .prepare('SELECT COUNT(*) AS count FROM remote_pairing_codes WHERE used_at IS NULL AND expires_at > ?')
      .get(now) as { count: number };
    return row.count;
  },

  /**
   * Burns a pairing code if it is still valid. The conditional UPDATE is the
   * single source of truth for "valid and unused", so two concurrent attempts
   * can never both succeed.
   */
  burnPairingCode(codeHash: string, now: number): boolean {
    const result = getConnection()
      .prepare('UPDATE remote_pairing_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?')
      .run(now, codeHash, now);
    return result.changes > 0;
  },

  prunePairingCodes(before: number): void {
    getConnection()
      .prepare('DELETE FROM remote_pairing_codes WHERE expires_at < ? OR (used_at IS NOT NULL AND used_at < ?)')
      .run(before, before);
  },

  createBrowserSession(input: {
    sessionId: string;
    tokenHash: string;
    userId: number;
    label: string | null;
    createdAt: number;
    expiresAt: number;
  }): void {
    getConnection()
      .prepare(
        `INSERT INTO remote_browser_sessions (session_id, token_hash, user_id, label, created_at, last_seen_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(input.sessionId, input.tokenHash, input.userId, input.label, input.createdAt, input.createdAt, input.expiresAt);
  },

  getBrowserSessionByTokenHash(tokenHash: string): RemoteBrowserSessionRecord | null {
    const row = getConnection()
      .prepare('SELECT * FROM remote_browser_sessions WHERE token_hash = ?')
      .get(tokenHash) as RemoteBrowserSessionRow | undefined;
    return row ? toSessionRecord(row) : null;
  },

  getBrowserSessionById(sessionId: string): RemoteBrowserSessionRecord | null {
    const row = getConnection()
      .prepare('SELECT * FROM remote_browser_sessions WHERE session_id = ?')
      .get(sessionId) as RemoteBrowserSessionRow | undefined;
    return row ? toSessionRecord(row) : null;
  },

  touchBrowserSession(sessionId: string, lastSeenAt: number): void {
    getConnection()
      .prepare('UPDATE remote_browser_sessions SET last_seen_at = ? WHERE session_id = ? AND revoked_at IS NULL')
      .run(lastSeenAt, sessionId);
  },

  revokeBrowserSession(sessionId: string, revokedAt: number): boolean {
    const result = getConnection()
      .prepare('UPDATE remote_browser_sessions SET revoked_at = ? WHERE session_id = ? AND revoked_at IS NULL')
      .run(revokedAt, sessionId);
    return result.changes > 0;
  },

  /** Revokes every still-active remote session and returns their ids so open sockets can be closed. */
  revokeAllBrowserSessions(revokedAt: number): string[] {
    const db = getConnection();
    return db.transaction((): string[] => {
      const rows = db
        .prepare('SELECT session_id FROM remote_browser_sessions WHERE revoked_at IS NULL')
        .all() as Array<{ session_id: string }>;
      db.prepare('UPDATE remote_browser_sessions SET revoked_at = ? WHERE revoked_at IS NULL').run(revokedAt);
      return rows.map((row) => row.session_id);
    })();
  },

  listActiveBrowserSessions(now: number): RemoteBrowserSessionRecord[] {
    const rows = getConnection()
      .prepare(
        `SELECT * FROM remote_browser_sessions
         WHERE revoked_at IS NULL AND expires_at > ?
         ORDER BY last_seen_at DESC`
      )
      .all(now) as RemoteBrowserSessionRow[];
    return rows.map(toSessionRecord);
  },
};
