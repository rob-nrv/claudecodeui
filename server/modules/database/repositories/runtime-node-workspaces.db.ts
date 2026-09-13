import { getConnection } from '@/modules/database/connection.js';

/**
 * One explicit project-to-folder mapping on a remote RuntimeNode (FT-M08).
 * `nodePath` is what the node itself resolved; it is sent back to that node
 * only, and never returned by a listing API.
 */
export type RuntimeNodeWorkspaceRecord = {
  nodeId: string;
  projectPath: string;
  nodePath: string;
  status: 'verified' | 'unavailable';
  reason: string | null;
  verifiedAt: number;
};

type RuntimeNodeWorkspaceRow = {
  node_id: string;
  project_path: string;
  node_path: string;
  status: string;
  reason: string | null;
  verified_at: number;
};

const toRecord = (row: RuntimeNodeWorkspaceRow): RuntimeNodeWorkspaceRecord => ({
  nodeId: row.node_id,
  projectPath: row.project_path,
  nodePath: row.node_path,
  status: row.status === 'verified' ? 'verified' : 'unavailable',
  reason: row.reason,
  verifiedAt: row.verified_at,
});

export const runtimeNodeWorkspacesDb = {
  get(nodeId: string, projectPath: string): RuntimeNodeWorkspaceRecord | null {
    const row = getConnection()
      .prepare('SELECT * FROM runtime_node_workspaces WHERE node_id = ? AND project_path = ?')
      .get(nodeId, projectPath) as RuntimeNodeWorkspaceRow | undefined;
    return row ? toRecord(row) : null;
  },

  listByProjectPath(projectPath: string): RuntimeNodeWorkspaceRecord[] {
    const rows = getConnection()
      .prepare('SELECT * FROM runtime_node_workspaces WHERE project_path = ?')
      .all(projectPath) as RuntimeNodeWorkspaceRow[];
    return rows.map(toRecord);
  },

  upsert(record: RuntimeNodeWorkspaceRecord): void {
    getConnection()
      .prepare(
        `INSERT INTO runtime_node_workspaces (node_id, project_path, node_path, status, reason, verified_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(node_id, project_path) DO UPDATE SET
           node_path = excluded.node_path,
           status = excluded.status,
           reason = excluded.reason,
           verified_at = excluded.verified_at`
      )
      .run(record.nodeId, record.projectPath, record.nodePath, record.status, record.reason, record.verifiedAt);
  },

  /** Marks a mapping unusable after the node refused it at execution time; the folder itself is kept for the user to see and fix. */
  markUnavailable(nodeId: string, projectPath: string, reason: string, at: number): void {
    getConnection()
      .prepare(
        `UPDATE runtime_node_workspaces SET status = 'unavailable', reason = ?, verified_at = ?
         WHERE node_id = ? AND project_path = ?`
      )
      .run(reason, at, nodeId, projectPath);
  },

  delete(nodeId: string, projectPath: string): boolean {
    const result = getConnection()
      .prepare('DELETE FROM runtime_node_workspaces WHERE node_id = ? AND project_path = ?')
      .run(nodeId, projectPath);
    return result.changes > 0;
  },
};
