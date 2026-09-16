// Project Registry contract (FT-M10). A project IS its `projectId`: a minted
// UUID that never encodes a path, is the same on every RuntimeNode, and exists
// whether or not this control plane keeps a working copy. Paths are node-local
// knowledge and deliberately absent from the registry port, so a hosted
// adapter can implement it without ever storing a machine's folder.

const COMMIT_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const MAX_DISPLAY_NAME_LENGTH = 120;

/**
 * The last durable Workspace Snapshot of a project. Nothing writes it before
 * snapshot storage exists, so it reads as null: an unknown checkpoint is never
 * approximated from a live folder, a head commit or a mapping.
 */
export type ProjectCheckpointReference = {
  snapshotId: string;
  changesDigest: string;
  headCommit: string | null;
  sourceNodeId: string;
  createdAt: string;
};

export type RegisteredProject = {
  projectId: string;
  displayName: string;
  isStarred: boolean;
  isArchived: boolean;
  latestCheckpoint: ProjectCheckpointReference | null;
};

/**
 * One RuntimeNode's explicit mapping of a project, without the node-local
 * folder. `repositoryIdentity` is the baseline recorded at first mapping
 * (null = never recorded, [] = no Git history then).
 */
export type ProjectNodeAssociation = {
  projectId: string;
  nodeId: string;
  status: 'verified' | 'unavailable';
  reason: string | null;
  verifiedAt: string;
  repositoryIdentity: string[] | null;
};

export type ProjectListFilter = 'active' | 'archived' | 'all';

/** Identity and metadata of projects; implemented locally over SQLite now, by a hosted service later. */
export interface ProjectRegistry {
  listProjects(filter?: ProjectListFilter): Promise<RegisteredProject[]>;
  getProject(projectId: string): Promise<RegisteredProject | null>;
  /** Registers a project that has no working copy anywhere yet. */
  registerProject(input: { displayName: unknown }): Promise<RegisteredProject>;
  listNodeAssociations(projectId: string): Promise<ProjectNodeAssociation[]>;
}

export class ProjectRegistryInputError extends Error {
  constructor(readonly code: 'PROJECT_DISPLAY_NAME_INVALID', message: string) {
    super(message);
  }
}

export function normalizeRegistryDisplayName(value: unknown): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed || trimmed.length > MAX_DISPLAY_NAME_LENGTH || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new ProjectRegistryInputError(
      'PROJECT_DISPLAY_NAME_INVALID',
      `displayName must be 1-${MAX_DISPLAY_NAME_LENGTH} printable characters.`,
    );
  }
  return trimmed;
}

/**
 * Rebuilds a checkpoint reference from stored fields. All-or-nothing: one
 * missing or malformed field makes the whole reference unknown (null) rather
 * than a partially invented checkpoint.
 */
export function parseCheckpointReference(fields: {
  snapshotId: unknown;
  changesDigest: unknown;
  headCommit: unknown;
  sourceNodeId: unknown;
  createdAt: unknown;
}): ProjectCheckpointReference | null {
  const { snapshotId, changesDigest, headCommit, sourceNodeId, createdAt } = fields;
  if (typeof snapshotId !== 'string' || !snapshotId.trim()) return null;
  if (typeof changesDigest !== 'string' || !DIGEST_PATTERN.test(changesDigest)) return null;
  if (headCommit !== null && (typeof headCommit !== 'string' || !COMMIT_PATTERN.test(headCommit))) return null;
  if (typeof sourceNodeId !== 'string' || !sourceNodeId.trim()) return null;
  if (typeof createdAt !== 'number' || !Number.isSafeInteger(createdAt) || createdAt <= 0) return null;
  return { snapshotId, changesDigest, headCommit, sourceNodeId, createdAt: new Date(createdAt).toISOString() };
}

export type WorkspaceResolutionCode =
  | 'PROJECT_NOT_FOUND'
  | 'RUNTIME_NODE_NOT_FOUND'
  | 'RUNTIME_NODE_NOT_ENROLLED'
  | 'RUNTIME_NODE_REVOKED'
  | 'RUNTIME_NODE_OFFLINE'
  | 'WORKSPACE_NOT_ON_NODE'
  | 'WORKSPACE_UNAVAILABLE';

/**
 * Where a project's working copy is on ONE explicitly targeted node. A refusal
 * never carries a path: no other node's folder and no control-plane folder is
 * ever offered in place of the one that was asked for.
 */
export type WorkspaceResolution =
  | {
    ok: true;
    projectId: string;
    nodeId: string;
    isLocalNode: boolean;
    /** Node-local: only ever used by, or sent to, that node. */
    path: string;
    /** The identity baseline recorded for a remote mapping; null for the control plane's own copy. */
    recordedIdentity: string[] | null;
  }
  | { ok: false; projectId: string; nodeId: string; code: WorkspaceResolutionCode; reason: string | null };

export type WorkspaceResolutionFacts = {
  projectId: string;
  nodeId: string;
  project: { controlPlanePath: string | null } | null;
  node: { isLocal: boolean; credentialStatus: 'active' | 'revoked' | null } | null;
  mapping: { nodePath: string; status: 'verified' | 'unavailable'; reason: string | null; gitRootCommits: string[] | null } | null;
  linkUsable: boolean;
};

/** Pure resolution over facts read by an adapter. The targeted node is the only node consulted. */
export function resolveProjectWorkspace(facts: WorkspaceResolutionFacts): WorkspaceResolution {
  const { projectId, nodeId } = facts;
  const refuse = (code: WorkspaceResolutionCode, reason: string | null = null): WorkspaceResolution =>
    ({ ok: false, projectId, nodeId, code, reason });

  if (!facts.project) return refuse('PROJECT_NOT_FOUND');
  if (!facts.node) return refuse('RUNTIME_NODE_NOT_FOUND');

  if (facts.node.isLocal) {
    const controlPlanePath = facts.project.controlPlanePath?.trim() ?? '';
    return controlPlanePath
      ? { ok: true, projectId, nodeId, isLocalNode: true, path: controlPlanePath, recordedIdentity: null }
      : refuse('WORKSPACE_NOT_ON_NODE', 'no_control_plane_copy');
  }

  if (facts.node.credentialStatus === null) return refuse('RUNTIME_NODE_NOT_ENROLLED');
  if (facts.node.credentialStatus === 'revoked') return refuse('RUNTIME_NODE_REVOKED');
  if (!facts.mapping) return refuse('WORKSPACE_NOT_ON_NODE', 'not_mapped');
  if (facts.mapping.status !== 'verified') return refuse('WORKSPACE_UNAVAILABLE', facts.mapping.reason);
  if (!facts.linkUsable) return refuse('RUNTIME_NODE_OFFLINE');
  return {
    ok: true,
    projectId,
    nodeId,
    isLocalNode: false,
    path: facts.mapping.nodePath,
    recordedIdentity: facts.mapping.gitRootCommits,
  };
}
