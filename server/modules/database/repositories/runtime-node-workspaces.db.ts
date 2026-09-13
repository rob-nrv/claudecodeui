import { getConnection } from '@/modules/database/connection.js';

/**
 * One explicit project-to-folder mapping on a remote RuntimeNode (FT-M08),
 * keyed by project id since FT-M09. `nodePath` is what the node itself
 * resolved — node-local, sent back to that node only, and never returned by a
 * listing API. `gitRootCommits` is the repository identity the node reported
 * when the folder was mapped: null when never recorded (FT-M08 rows), empty
 * when the folder had no Git history then.
 */
export type RuntimeNodeWorkspaceRecord = {
  nodeId: string;
  projectId: string;
  nodePath: string;
  status: 'verified' | 'unavailable';
  reason: string | null;
  verifiedAt: number;
  gitRootCommits: string[] | null;
};

type RuntimeNodeWorkspaceRow = {
  node_id: string;
  project_id: string;
  node_path: string;
  status: string;
  reason: string | null;
  verified_at: number;
  git_root_commits: string | null;
};

const COMMIT_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

const toRecord = (row: RuntimeNodeWorkspaceRow): RuntimeNodeWorkspaceRecord => ({
  nodeId: row.node_id,
  projectId: row.project_id,
  nodePath: row.node_path,
  status: row.status === 'verified' ? 'verified' : 'unavailable',
  reason: row.reason,
  verifiedAt: row.verified_at,
  gitRootCommits: row.git_root_commits === null
    ? null
    : row.git_root_commits.split(',').filter((commit) => COMMIT_PATTERN.test(commit)),
});

export const runtimeNodeWorkspacesDb = {
  get(nodeId: string, projectId: string): RuntimeNodeWorkspaceRecord | null {
    const row = getConnection()
      .prepare('SELECT * FROM runtime_node_workspaces WHERE node_id = ? AND project_id = ?')
      .get(nodeId, projectId) as RuntimeNodeWorkspaceRow | undefined;
    return row ? toRecord(row) : null;
  },

  /** Every node's mapping of one project: the same project, a different local folder per node. */
  listByProject(projectId: string): RuntimeNodeWorkspaceRecord[] {
    const rows = getConnection()
      .prepare('SELECT * FROM runtime_node_workspaces WHERE project_id = ? ORDER BY node_id')
      .all(projectId) as RuntimeNodeWorkspaceRow[];
    return rows.map(toRecord);
  },

  upsert(record: RuntimeNodeWorkspaceRecord): void {
    const rootCommits = record.gitRootCommits === null
      ? null
      : record.gitRootCommits.filter((commit) => COMMIT_PATTERN.test(commit)).slice(0, 3).join(',');
    getConnection()
      .prepare(
        `INSERT INTO runtime_node_workspaces (node_id, project_id, node_path, status, reason, verified_at, git_root_commits)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(node_id, project_id) DO UPDATE SET
           node_path = excluded.node_path,
           status = excluded.status,
           reason = excluded.reason,
           verified_at = excluded.verified_at,
           git_root_commits = excluded.git_root_commits`
      )
      .run(record.nodeId, record.projectId, record.nodePath, record.status, record.reason, record.verifiedAt, rootCommits);
  },

  /** Marks a mapping unusable after the node refused it at execution time; the folder itself is kept for the user to see and fix. */
  markUnavailable(nodeId: string, projectId: string, reason: string, at: number): void {
    getConnection()
      .prepare(
        `UPDATE runtime_node_workspaces SET status = 'unavailable', reason = ?, verified_at = ?
         WHERE node_id = ? AND project_id = ?`
      )
      .run(reason, at, nodeId, projectId);
  },

  delete(nodeId: string, projectId: string): boolean {
    const result = getConnection()
      .prepare('DELETE FROM runtime_node_workspaces WHERE node_id = ? AND project_id = ?')
      .run(nodeId, projectId);
    return result.changes > 0;
  },
};
