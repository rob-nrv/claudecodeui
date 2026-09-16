// Project Registry (FT-M10): global project identity (`projectId`) and metadata
// behind a port a hosted adapter can implement later, plus the node-local
// locator that resolves a project's working copy on ONE explicitly targeted
// RuntimeNode and refuses instead of substituting another copy.

// The port, its types and the pure resolver: used by the local adapter, the in-memory fake and the runtime-nodes module.
export {
  normalizeRegistryDisplayName,
  parseCheckpointReference,
  ProjectRegistryInputError,
  resolveProjectWorkspace,
} from '@/modules/project-registry/project-registry.contract.js';
export type {
  ProjectCheckpointReference,
  ProjectListFilter,
  ProjectNodeAssociation,
  ProjectRegistry,
  RegisteredProject,
  WorkspaceResolution,
  WorkspaceResolutionCode,
  WorkspaceResolutionFacts,
} from '@/modules/project-registry/project-registry.contract.js';
// createLocalProjectRegistry / locator helpers: used by the projects routes and by the Files, Git, Shell,
// TaskMaster and Worktrees modules (explicit control-plane workspace resolution).
export {
  createLocalProjectRegistry,
  createProjectWorkspaceLocator,
  resolveControlPlaneWorkspacePath,
  toWorkspaceResolutionError,
} from '@/modules/project-registry/local-project-registry.js';
export type { ProjectWorkspaceLocator, RuntimeNodeLinkPresence } from '@/modules/project-registry/local-project-registry.js';
// createProjectRegistryRouter: mounted by the projects routes at /api/projects/registry.
export { createProjectRegistryRouter } from '@/modules/project-registry/project-registry.routes.js';
// createInMemoryProjectRegistry: used by contract tests and database-free consumers' tests.
export { createInMemoryProjectRegistry } from '@/modules/project-registry/in-memory-project-registry.js';
