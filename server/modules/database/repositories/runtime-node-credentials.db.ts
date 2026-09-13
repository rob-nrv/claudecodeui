import { getConnection } from '@/modules/database/connection.js';

/**
 * Credential of one remote RuntimeNode (FT-M08). `publicKey` is the SPKI PEM
 * of the Ed25519 key the node generated and proved at enrollment; the private
 * half never reaches the control plane.
 */
export type RuntimeNodeCredentialRecord = {
  nodeId: string;
  publicKey: string;
  status: 'active' | 'revoked';
  enrolledAt: number;
  revokedAt: number | null;
};

type RuntimeNodeCredentialRow = {
  node_id: string;
  public_key: string;
  status: string;
  enrolled_at: number;
  revoked_at: number | null;
};

const toRecord = (row: RuntimeNodeCredentialRow): RuntimeNodeCredentialRecord => ({
  nodeId: row.node_id,
  publicKey: row.public_key,
  // Anything but an explicit `active` is treated as revoked: fail closed.
  status: row.status === 'active' ? 'active' : 'revoked',
  enrolledAt: row.enrolled_at,
  revokedAt: typeof row.revoked_at === 'number' ? row.revoked_at : null,
});

export const runtimeNodeCredentialsDb = {
  getByNodeId(nodeId: string): RuntimeNodeCredentialRecord | null {
    const row = getConnection()
      .prepare('SELECT * FROM runtime_node_credentials WHERE node_id = ?')
      .get(nodeId) as RuntimeNodeCredentialRow | undefined;
    return row ? toRecord(row) : null;
  },

  listAll(): RuntimeNodeCredentialRecord[] {
    const rows = getConnection()
      .prepare('SELECT * FROM runtime_node_credentials')
      .all() as RuntimeNodeCredentialRow[];
    return rows.map(toRecord);
  },

  /** Terminal: a revoked credential is never reactivated. Returns whether an active credential was revoked. */
  revoke(nodeId: string, revokedAt: number): boolean {
    const result = getConnection()
      .prepare(
        `UPDATE runtime_node_credentials
         SET status = 'revoked', revoked_at = ?
         WHERE node_id = ? AND status = 'active'`
      )
      .run(revokedAt, nodeId);
    return result.changes > 0;
  },
};
