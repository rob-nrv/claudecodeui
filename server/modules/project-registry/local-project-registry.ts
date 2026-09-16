import path from 'node:path';

import {
  projectsDb,
  runtimeNodeCredentialsDb,
  runtimeNodesDb,
  runtimeNodeWorkspacesDb,
  type ProjectRegistryRow,
} from '@/modules/database/index.js';
import {
  normalizeRegistryDisplayName,
  parseCheckpointReference,
  resolveProjectWorkspace,
  type ProjectNodeAssociation,
  type ProjectRegistry,
  type RegisteredProject,
  type WorkspaceResolution,
} from '@/modules/project-registry/project-registry.contract.js';
import { AppError } from '@/shared/utils.js';

function toRegisteredProject(row: ProjectRegistryRow): RegisteredProject {
  const customName = row.custom_project_name?.trim() ?? '';
  const controlPlanePath = row.project_path ?? '';
  return {
    projectId: row.project_id,
    displayName: customName || path.basename(controlPlanePath) || controlPlanePath || row.project_id,
    isStarred: Boolean(row.isStarred),
    isArchived: Boolean(row.isArchived),
    latestCheckpoint: parseCheckpointReference({
      snapshotId: row.latest_checkpoint_snapshot_id,
      changesDigest: row.latest_checkpoint_changes_digest,
      headCommit: row.latest_checkpoint_head_commit,
      sourceNodeId: row.latest_checkpoint_node_id,
      createdAt: row.latest_checkpoint_at,
    }),
  };
}

/** The local-first adapter: this control plane's SQLite database is the registry. */
export function createLocalProjectRegistry(): ProjectRegistry {
  return {
    async listProjects(filter = 'active') {
      return projectsDb.listRegistryRows(filter).map(toRegisteredProject);
    },

    async getProject(projectId) {
      const row = projectsDb.getRegistryRow(projectId);
      return row ? toRegisteredProject(row) : null;
    },

    async registerProject(input) {
      const row = projectsDb.createProjectWithoutControlPlaneCopy(normalizeRegistryDisplayName(input.displayName));
      return toRegisteredProject(row);
    },

    async listNodeAssociations(projectId): Promise<ProjectNodeAssociation[]> {
      return runtimeNodeWorkspacesDb.listByProject(projectId).map((mapping) => ({
        projectId: mapping.projectId,
        nodeId: mapping.nodeId,
        status: mapping.status,
        reason: mapping.reason,
        verifiedAt: new Date(mapping.verifiedAt).toISOString(),
        repositoryIdentity: mapping.gitRootCommits,
      }));
    },
  };
}

export type RuntimeNodeLinkPresence = {
  isUsable(nodeId: string): boolean;
};

/** Surfaces with no remote link (Files, Git, Shell, TaskMaster, Worktrees) never see a remote node as reachable. */
const NO_REMOTE_LINKS: RuntimeNodeLinkPresence = { isUsable: () => false };

/**
 * Node-local knowledge of where a project's working copy is: the control
 * plane's own `project_path` for the local node, a verified mapping for a
 * remote one. Kept outside the registry port because paths never leave this
 * machine or the node that owns them.
 */
export function createProjectWorkspaceLocator(presence: RuntimeNodeLinkPresence = NO_REMOTE_LINKS) {
  const resolve = (target: { projectId: string; nodeId: string }): WorkspaceResolution => {
    const project = projectsDb.getProjectById(target.projectId);
    const node = runtimeNodesDb.getById(target.nodeId);
    const credential = node && !node.isLocal ? runtimeNodeCredentialsDb.getByNodeId(target.nodeId) : null;
    const mapping = project && node && !node.isLocal ? runtimeNodeWorkspacesDb.get(target.nodeId, target.projectId) : null;
    return resolveProjectWorkspace({
      projectId: target.projectId,
      nodeId: target.nodeId,
      project: project ? { controlPlanePath: project.project_path } : null,
      node: node ? { isLocal: node.isLocal, credentialStatus: credential?.status ?? null } : null,
      mapping,
      linkUsable: Boolean(node && !node.isLocal && presence.isUsable(target.nodeId)),
    });
  };

  return {
    resolve,

    /**
     * The workspace of THIS machine, explicitly targeted as the local node.
     * The local node is always this process, registered or not yet (tests,
     * CLI tools), so it is never looked up among other nodes.
     */
    resolveOnControlPlane(projectId: string): WorkspaceResolution {
      const localNodeId = runtimeNodesDb.getLocal()?.nodeId ?? 'local';
      const project = projectsDb.getProjectById(projectId);
      return resolveProjectWorkspace({
        projectId,
        nodeId: localNodeId,
        project: project ? { controlPlanePath: project.project_path } : null,
        node: { isLocal: true, credentialStatus: null },
        mapping: null,
        linkUsable: false,
      });
    },
  };
}

export type ProjectWorkspaceLocator = ReturnType<typeof createProjectWorkspaceLocator>;

const RESOLUTION_MESSAGES: Record<Exclude<WorkspaceResolution, { ok: true }>['code'], string> = {
  PROJECT_NOT_FOUND: 'Project not found.',
  RUNTIME_NODE_NOT_FOUND: 'Runtime node not found.',
  RUNTIME_NODE_NOT_ENROLLED: 'This runtime node is not enrolled.',
  RUNTIME_NODE_REVOKED: 'This runtime node was revoked.',
  RUNTIME_NODE_OFFLINE: 'This runtime node is offline; no other copy of the project is used instead.',
  WORKSPACE_NOT_ON_NODE: 'This project has no working copy on the chosen runtime node.',
  WORKSPACE_UNAVAILABLE: 'This project\'s folder on the chosen runtime node is unavailable.',
};

/** Turns a refusal into the explicit API error; consumed by routes and services that operate on a workspace. */
export function toWorkspaceResolutionError(resolution: Exclude<WorkspaceResolution, { ok: true }>): AppError {
  return new AppError(RESOLUTION_MESSAGES[resolution.code], {
    code: resolution.code,
    statusCode: resolution.code === 'PROJECT_NOT_FOUND' || resolution.code === 'RUNTIME_NODE_NOT_FOUND' ? 404 : 409,
    details: { projectId: resolution.projectId, nodeId: resolution.nodeId, reason: resolution.reason },
  });
}
