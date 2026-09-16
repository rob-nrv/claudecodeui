// FT-M10: Files open only this machine's own copy of a project, resolved by
// project id; a project without one (mapped on a remote node only) is refused
// explicitly and no folder is touched. Temporary databases only.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  projectsDb,
  runtimeNodeWorkspacesDb,
} from '@/modules/database/index.js';
import { createFileTreeService } from '@/modules/file-tree/file-tree.service.js';
import { createProjectWorkspaceLocator, resolveControlPlaneWorkspacePath } from '@/modules/project-registry/index.js';
import type { FileTreeFileSystem } from '@/shared/types.js';

async function withIsolatedDatabase(runTest: (directory: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'file-tree-registry-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await fs.writeFile(process.env.DATABASE_PATH, '');
  const originalLog = console.log;
  console.log = () => undefined;
  try {
    await initializeDatabase();
  } finally {
    console.log = originalLog;
  }
  try {
    await runTest(directory);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function recordingFileSystem(touched: string[]): FileTreeFileSystem {
  const refuse = async (): Promise<never> => { throw Object.assign(new Error('not found'), { code: 'ENOENT' }); };
  return {
    access: async (target: string) => { touched.push(target); },
    stat: refuse,
    lstat: refuse,
    openDirectory: (directoryPath: string) => ({
      async *[Symbol.asyncIterator]() {
        touched.push(directoryPath);
      },
    }),
    realpath: refuse,
    readTextFile: refuse,
    writeTextFile: refuse,
    makeDirectory: refuse,
    rename: refuse,
    removeDirectory: refuse,
    unlink: refuse,
    copyFile: refuse,
    createReadStream: () => Readable.from([]),
  } as unknown as FileTreeFileSystem;
}

test('Files open only this machine\'s own copy; a project without one is refused explicitly and no folder is touched', { concurrency: false }, async () => {
  await withIsolatedDatabase(async (directory) => {
    getConnection().prepare("INSERT INTO runtime_nodes (node_id, label, is_local) VALUES ('pixel-node', 'Pixel', 0)").run();
    getConnection().prepare("INSERT INTO runtime_node_credentials (node_id, public_key, status, enrolled_at) VALUES ('pixel-node', 'key', 'active', 1)").run();
    const app = projectsDb.createProjectPath(path.join(directory, 'control-plane', 'app')).project!;
    const pixelOnly = projectsDb.createProjectWithoutControlPlaneCopy('Pixel-only app');
    runtimeNodeWorkspacesDb.upsert({ nodeId: 'pixel-node', projectId: pixelOnly.project_id, nodePath: '/root/ws/pixel-only', status: 'verified', reason: null, verifiedAt: 1, gitRootCommits: null });
    const locator = createProjectWorkspaceLocator({ isUsable: () => true });

    assert.equal(resolveControlPlaneWorkspacePath(locator, app.project_id), app.project_path);
    assert.equal(resolveControlPlaneWorkspacePath(locator, 'ghost-project'), null, 'unknown projects keep the existing 404 path');
    assert.throws(() => resolveControlPlaneWorkspacePath(locator, pixelOnly.project_id), { code: 'WORKSPACE_NOT_ON_NODE', statusCode: 409 },
      'a folder on Pixel is not a copy here');

    const touched: string[] = [];
    const files = createFileTreeService({
      fileSystem: recordingFileSystem(touched),
      projects: { getProjectPathById: async (projectId) => resolveControlPlaneWorkspacePath(locator, projectId) },
      workspace: { rootPath: directory, validatePath: async (candidatePath) => ({ valid: true, resolvedPath: candidatePath }) },
      resolveMimeType: () => 'text/plain',
      fileSystemConcurrency: 2,
      logger: { error: () => undefined },
    });

    await files.listProjectFiles(app.project_id);
    assert.ok(touched.length > 0 && touched.every((entry) => entry.startsWith(app.project_path!)), 'Files read only the control-plane copy');

    touched.length = 0;
    await assert.rejects(() => files.listProjectFiles(pixelOnly.project_id), { code: 'WORKSPACE_NOT_ON_NODE' });
    await assert.rejects(() => files.listProjectFiles('ghost-project'), { code: 'PROJECT_NOT_FOUND' });
    assert.deepEqual(touched, [], 'no folder was touched for a refused project');
  });
});
