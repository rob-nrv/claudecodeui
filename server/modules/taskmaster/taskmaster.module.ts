import fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import os from 'node:os';

import spawn from 'cross-spawn';

import { createProjectWorkspaceLocator, resolveControlPlaneWorkspacePath } from '@/modules/project-registry/index.js';

import { createTaskmasterRouter } from './taskmaster.routes.js';
import { createTaskmasterService } from './taskmaster.service.js';

// FT-M10: the control plane's own copy of a project, resolved explicitly for this machine's node.
const controlPlaneWorkspaces = createProjectWorkspaceLocator();

const taskmasterService = createTaskmasterService({
  readTextFile: (filePath) => fsPromises.readFile(filePath, 'utf8'),
  getHomeDirectory: os.homedir,
});

/** Used by the server entrypoint to mount authenticated TaskMaster endpoints. */
export const taskmasterRoutes = createTaskmasterRouter({
  fileSystem: fs,
  fileSystemPromises: fsPromises,
  spawnProcess: spawn,
  resolveProjectPathById: (projectId) => resolveControlPlaneWorkspacePath(controlPlaneWorkspaces, projectId),
  taskmasterService,
});
