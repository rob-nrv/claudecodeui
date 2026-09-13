// Portable project workspace contract (FT-M09): how a project's LOCAL working
// copy on one RuntimeNode is inspected, classified for future sync, and
// compared, without any network filesystem and without uploading anything.
// Project identity is global (project id); workspace paths are node-local.

// inspectWorkspaceFolder: used by the node agent (its mapped folders) and the runtime-nodes module (the control plane's own copy).
export { inspectWorkspaceFolder, readWorkspaceRootCommits } from '@/modules/project-workspaces/workspace-inspector.js';
export type { GitRunner } from '@/modules/project-workspaces/workspace-inspector.js';
// Observation parsing and classification: used by the runtime-nodes module for node answers and the state route.
export {
  classifyWorkspaceState,
  isCommitHash,
  parseGitStatusPorcelainV2,
  parseWorkspaceObservation,
  resolveWorkspaceIdentity,
  summarizeWorkspaceChanges,
} from '@/modules/project-workspaces/workspace-state.js';
export type {
  WorkspaceIdentityMatch,
  WorkspaceObservation,
  WorkspaceStateClass,
} from '@/modules/project-workspaces/workspace-state.js';
// Sync classification and the snapshot contract: the security boundary a future Workspace Sync must apply.
export {
  classifyWorkspacePath,
  DEFAULT_WORKSPACE_SYNC_POLICY,
  detectSecretContentMarkers,
  normalizeWorkspaceRelativePath,
  normalizeWorkspaceSyncPolicy,
} from '@/modules/project-workspaces/workspace-sync-policy.js';
export type { WorkspaceSyncClass, WorkspaceSyncPolicy } from '@/modules/project-workspaces/workspace-sync-policy.js';
export {
  assessWorkspaceRestore,
  computeWorkspaceChangesDigest,
  validateWorkspaceSnapshotManifest,
  WORKSPACE_SNAPSHOT_SCHEMA,
} from '@/modules/project-workspaces/workspace-snapshot.contract.js';
export type {
  WorkspaceRestoreAssessment,
  WorkspaceRestoreBlocker,
  WorkspaceSnapshotChange,
  WorkspaceSnapshotManifestV1,
} from '@/modules/project-workspaces/workspace-snapshot.contract.js';
