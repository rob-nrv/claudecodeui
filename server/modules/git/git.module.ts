import * as fs from 'node:fs/promises';

import spawn from 'cross-spawn';

import { resolveRequestWorkspacePath } from '@/modules/project-registry/index.js';

import { createGitRouter } from './git.routes.js';

type GitExternalDependencies = Pick<
  Parameters<typeof createGitRouter>[0],
  'queryClaude' | 'queryCursor'
>;

/** Assembles the Git router with runners from the centralized provider runtime service. */
export function createGitModule(externalDependencies: GitExternalDependencies) {
  return createGitRouter({
    fileSystem: fs,
    spawnProcess: spawn,
    // FT-M10: the request's explicit runtime target decides the copy; a remote target is refused.
    resolveProjectPathById: (projectId) => resolveRequestWorkspacePath(projectId),
    ...externalDependencies,
  });
}
