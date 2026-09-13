import { getConnection } from '@/modules/database/connection.js';

type EnrollmentRow = {
  code_hash: string;
  label: string | null;
  created_by_user_id: number | null;
  created_at: number;
  expires_at: number;
  used_at: number | null;
  node_id: string | null;
};

type RedeemedNode = {
  nodeId: string;
  label: string;
  platform: string | null;
  arch: string | null;
  runtimeVersion: string | null;
  publicKey: string;
};

/** Outcome of redeeming one enrollment code; never says which part was wrong beyond this. */
export type EnrollmentRedemption =
  | { status: 'enrolled'; nodeId: string }
  | { status: 'invalid_code' }
  | { status: 'key_conflict' };

export const runtimeNodeEnrollmentsDb = {
  create(input: { codeHash: string; label: string | null; createdByUserId: number | null; createdAt: number; expiresAt: number }): void {
    getConnection()
      .prepare(
        `INSERT INTO runtime_node_enrollments (code_hash, label, created_by_user_id, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(input.codeHash, input.label, input.createdByUserId, input.createdAt, input.expiresAt);
  },

  /** Unexpired, unused codes — bounded by the service so codes cannot be hoarded. */
  countOutstanding(now: number): number {
    const row = getConnection()
      .prepare('SELECT COUNT(*) AS count FROM runtime_node_enrollments WHERE used_at IS NULL AND expires_at > ?')
      .get(now) as { count: number };
    return row.count;
  },

  /** Removes expired or used codes older than `before`, so the table stays small. */
  prune(before: number): void {
    getConnection()
      .prepare('DELETE FROM runtime_node_enrollments WHERE expires_at < ? OR (used_at IS NOT NULL AND used_at < ?)')
      .run(before, before);
  },

  /**
   * Redeems a code and creates the remote node plus its credential in ONE
   * transaction: either the code is burned and the node exists, or nothing
   * changed. The `used_at IS NULL AND expires_at > now` guard makes concurrent
   * redemptions of the same code race-free. A public key already enrolled for
   * another node is refused (one key, one identity).
   */
  redeem(codeHash: string, now: number, node: RedeemedNode): EnrollmentRedemption {
    const db = getConnection();
    return db.transaction((): EnrollmentRedemption => {
      const enrollment = db
        .prepare('SELECT * FROM runtime_node_enrollments WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?')
        .get(codeHash, now) as EnrollmentRow | undefined;
      if (!enrollment) {
        return { status: 'invalid_code' };
      }

      const keyInUse = db
        .prepare('SELECT node_id FROM runtime_node_credentials WHERE public_key = ?')
        .get(node.publicKey) as { node_id: string } | undefined;
      if (keyInUse) {
        return { status: 'key_conflict' };
      }

      db.prepare('UPDATE runtime_node_enrollments SET used_at = ?, node_id = ? WHERE code_hash = ?')
        .run(now, node.nodeId, codeHash);
      db.prepare(
        `INSERT INTO runtime_nodes (node_id, label, is_local, platform, arch, runtime_version)
         VALUES (?, ?, 0, ?, ?, ?)`
      ).run(node.nodeId, enrollment.label?.trim() || node.label, node.platform, node.arch, node.runtimeVersion);
      db.prepare(
        `INSERT INTO runtime_node_credentials (node_id, public_key, status, enrolled_at)
         VALUES (?, ?, 'active', ?)`
      ).run(node.nodeId, node.publicKey, now);

      return { status: 'enrolled', nodeId: node.nodeId };
    })();
  },
};
