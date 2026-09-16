import * as fs from 'node:fs/promises';

import spawn from 'cross-spawn';

import { createProjectWorkspaceLocator, resolveControlPlaneWorkspacePath } from '@/modules/project-registry/index.js';

import { createGitRouter } from './git.routes.js';

type GitExternalDependencies = Pick<
  Parameters<typeof createGitRouter>[0],
  'queryClaude' | 'queryCursor'
>;

// FT-M10: the control plane's own copy of a project, resolved explicitly for this machine's node.
const controlPlaneWorkspaces = createProjectWorkspaceLocator();

/** Assembles the Git router with runners from the centralized provider runtime service. */
export function createGitModule(externalDependencies: GitExternalDependencies) {
  return createGitRouter({
    fileSystem: fs,
    spawnProcess: spawn,
    resolveProjectPathById: (projectId) => resolveControlPlaneWorkspacePath(controlPlaneWorkspaces, projectId),
    ...externalDependencies,
  });
}
