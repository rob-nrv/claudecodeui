import { getConnection } from '@/modules/database/connection.js';

/**
 * Server-only RuntimeNode row (FT-M07). `capabilitiesJson` is the raw last
 * probe result: callers parse it defensively and re-derive availability from
 * `lastSeenAt` instead of trusting a persisted snapshot as current state.
 */
export type RuntimeNodeRecord = {
  nodeId: string;
  label: string;
  isLocal: boolean;
  platform: string | null;
  arch: string | null;
  runtimeVersion: string | null;
  /** Epoch milliseconds of the last completed probe, or null when never probed. */
  lastSeenAt: number | null;
  capabilitiesJson: string | null;
  createdAt: string;
  updatedAt: string;
};

type RuntimeNodeRow = {
  node_id: string;
  label: string;
  is_local: number;
  platform: string | null;
  arch: string | null;
  runtime_version: string | null;
  last_seen_at: number | null;
  capabilities_json: string | null;
  created_at: string;
  updated_at: string;
};

type LocalNodeFacts = {
  label: string;
  platform: string | null;
  arch: string | null;
  runtimeVersion: string | null;
};

const toRecord = (row: RuntimeNodeRow): RuntimeNodeRecord => ({
  nodeId: row.node_id,
  label: row.label,
  isLocal: Boolean(row.is_local),
  platform: row.platform,
  arch: row.arch,
  runtimeVersion: row.runtime_version,
  lastSeenAt: typeof row.last_seen_at === 'number' ? row.last_seen_at : null,
  capabilitiesJson: row.capabilities_json,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const runtimeNodesDb = {
  /** Every known node, local node first. */
  list(): RuntimeNodeRecord[] {
    const rows = getConnection()
      .prepare('SELECT * FROM runtime_nodes ORDER BY is_local DESC, created_at ASC, node_id ASC')
      .all() as RuntimeNodeRow[];
    return rows.map(toRecord);
  },

  count(): number {
    const row = getConnection()
      .prepare('SELECT COUNT(*) AS count FROM runtime_nodes')
      .get() as { count: number };
    return row.count;
  },

  getById(nodeId: string): RuntimeNodeRecord | null {
    const row = getConnection()
      .prepare('SELECT * FROM runtime_nodes WHERE node_id = ?')
      .get(nodeId) as RuntimeNodeRow | undefined;
    return row ? toRecord(row) : null;
  },

  getLocal(): RuntimeNodeRecord | null {
    const row = getConnection()
      .prepare('SELECT * FROM runtime_nodes WHERE is_local = 1')
      .get() as RuntimeNodeRow | undefined;
    return row ? toRecord(row) : null;
  },

  /**
   * Registers this machine as the local node, or refreshes its descriptive
   * facts. `candidateNodeId` is only used when no local row exists yet: an
   * existing local node keeps its id forever, which is what makes the identity
   * stable across restarts and upgrades. Probe results are never touched here.
   */
  upsertLocal(candidateNodeId: string, facts: LocalNodeFacts): RuntimeNodeRecord {
    const db = getConnection();
    const nodeId = db.transaction((): string => {
      const existing = db
        .prepare('SELECT node_id FROM runtime_nodes WHERE is_local = 1')
        .get() as { node_id: string } | undefined;

      if (existing) {
        db.prepare(
          `UPDATE runtime_nodes
           SET label = ?, platform = ?, arch = ?, runtime_version = ?, updated_at = CURRENT_TIMESTAMP
           WHERE node_id = ?`
        ).run(facts.label, facts.platform, facts.arch, facts.runtimeVersion, existing.node_id);
        return existing.node_id;
      }

      db.prepare(
        `INSERT INTO runtime_nodes (node_id, label, is_local, platform, arch, runtime_version)
         VALUES (?, ?, 1, ?, ?, ?)`
      ).run(candidateNodeId, facts.label, facts.platform, facts.arch, facts.runtimeVersion);
      return candidateNodeId;
    })();

    return runtimeNodesDb.getById(nodeId) as RuntimeNodeRecord;
  },

  /** Records one completed probe of a node: when it answered and what it proved. */
  recordProbe(nodeId: string, probe: { lastSeenAt: number; capabilitiesJson: string }): void {
    getConnection()
      .prepare(
        `UPDATE runtime_nodes
         SET last_seen_at = ?, capabilities_json = ?, updated_at = CURRENT_TIMESTAMP
         WHERE node_id = ?`
      )
      .run(probe.lastSeenAt, probe.capabilitiesJson, nodeId);
  },
};
