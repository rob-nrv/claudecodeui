// FT-M10 strict targeting for Files: every request resolves exactly the
// RuntimeNode it targets (X-CloudCLI-Runtime-Node/-Project). The local node
// yields this machine's copy; a remote target is refused on its own grounds and
// no folder — this machine's or another node's — is touched. Real router and
// middleware over HTTP; temporary databases; a recording filesystem.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import express from 'express';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  projectsDb,
  runtimeNodeWorkspacesDb,
} from '@/modules/database/index.js';
import { createFileTreeRouter } from '@/modules/file-tree/file-tree.routes.js';
import { createFileTreeService } from '@/modules/file-tree/file-tree.service.js';
import {
  resolveRequestWorkspacePath,
  runtimeTargetMiddleware,
  setRuntimeLinkPresence,
} from '@/modules/project-registry/index.js';
import type { FileTreeFileSystem } from '@/shared/types.js';

const NOW = Date.UTC(2026, 8, 16, 12, 0, 0);

async function withIsolatedDatabase(runTest: (directory: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'file-tree-targeting-'));
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
    setRuntimeLinkPresence({ isUsable: () => false });
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
}

/**
 * pc-node (this machine), Pixel (online, mapped), NAS (offline, mapped),
 * Tablet (online, not mapped), an old revoked phone (mapped) and a node that
 * never enrolled. `app` has a copy here plus remote folders; `pixelOnly` has
 * a folder on Pixel only.
 */
function seedFleet(directory: string) {
  const db = getConnection();
  db.prepare("INSERT INTO runtime_nodes (node_id, label, is_local) VALUES ('pc-node', 'Windows PC', 1)").run();
  for (const [nodeId, status] of [['pixel-node', 'active'], ['nas-node', 'active'], ['tablet-node', 'active'], ['old-node', 'revoked']]) {
    db.prepare('INSERT INTO runtime_nodes (node_id, label, is_local) VALUES (?, ?, 0)').run(nodeId, nodeId);
    db.prepare('INSERT INTO runtime_node_credentials (node_id, public_key, status, enrolled_at) VALUES (?, ?, ?, ?)').run(nodeId, `key-${nodeId}`, status, NOW);
  }
  db.prepare("INSERT INTO runtime_nodes (node_id, label, is_local) VALUES ('stray-node', 'Never enrolled', 0)").run();
  setRuntimeLinkPresence({ isUsable: (nodeId) => ['pixel-node', 'tablet-node', 'old-node', 'stray-node'].includes(nodeId) });

  const localCopy = path.join(directory, 'pc', 'app');
  // A real folder standing in for Pixel's copy: it must never be read from here.
  const pixelCopy = path.join(directory, 'pixel', 'app');
  const app = projectsDb.createProjectPath(localCopy).project!;
  const pixelOnly = projectsDb.createProjectWithoutControlPlaneCopy('Pixel-only app');
  const map = (nodeId: string, projectId: string, nodePath: string) =>
    runtimeNodeWorkspacesDb.upsert({ nodeId, projectId, nodePath, status: 'verified', reason: null, verifiedAt: NOW, gitRootCommits: null });
  map('pixel-node', app.project_id, pixelCopy);
  map('nas-node', app.project_id, '/volume1/code/app');
  map('old-node', app.project_id, '/sdcard/app');
  map('pixel-node', pixelOnly.project_id, path.join(directory, 'pixel', 'pixel-only'));
  return { appId: app.project_id, localCopy, pixelCopy, pixelOnlyId: pixelOnly.project_id };
}

function recordingFileSystem(touched: string[]): FileTreeFileSystem {
  const record = async (target: string) => { touched.push(target); };
  const refuse = async (target: string): Promise<never> => {
    touched.push(target);
    throw Object.assign(new Error('not found'), { code: 'ENOENT' });
  };
  return {
    access: record,
    stat: refuse,
    lstat: refuse,
    openDirectory: (directoryPath: string) => ({
      async *[Symbol.asyncIterator]() {
        touched.push(directoryPath);
      },
    }),
    realpath: async (target: string) => { touched.push(target); return target; },
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

async function withFilesServer(directory: string, touched: string[], run: (request: (url: string, target?: Record<string, string>) => Promise<{ status: number; body: Record<string, unknown>; text: string }>) => Promise<void>) {
  const services = createFileTreeService({
    fileSystem: recordingFileSystem(touched),
    projects: { getProjectPathById: async (projectId) => resolveRequestWorkspacePath(projectId) },
    workspace: { rootPath: directory, validatePath: async (candidatePath) => ({ valid: true, resolvedPath: candidatePath }) },
    resolveMimeType: () => 'text/plain',
    fileSystemConcurrency: 2,
    logger: { error: () => undefined },
  });
  const app = express();
  app.use(express.json());
  app.use('/api/file-tree', runtimeTargetMiddleware, createFileTreeRouter(
    services,
    (_req, _res, next) => next(),
    { maximumFileSizeBytes: 1024, maximumFileCount: 1 } as never,
    { error: () => undefined },
  ));
  app.use((error: { statusCode?: number; code?: string; message: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.statusCode ?? 500).json({ code: error.code, error: error.message });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run(async (url, target = {}) => {
      const response = await fetch(`${base}${url}`, { headers: target });
      const text = await response.text();
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(text) as Record<string, unknown>; } catch { /* non-JSON body */ }
      return { status: response.status, body, text };
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const target = (projectId: string, nodeId: string) => ({ 'X-CloudCLI-Runtime-Project': projectId, 'X-CloudCLI-Runtime-Node': nodeId });
const errorCode = (body: Record<string, unknown>) => (typeof body.code === 'string' ? body.code : (body.error as { code?: string } | undefined)?.code ?? body.error);

test('Files: the targeted local node reads only its own copy; a remote or unusable target is refused and nothing is read anywhere', { concurrency: false }, async () => {
  await withIsolatedDatabase(async (directory) => {
    const { appId, localCopy, pixelCopy, pixelOnlyId } = seedFleet(directory);
    const touched: string[] = [];
    await withFilesServer(directory, touched, async (request) => {
      const onlyLocal = () => {
        assert.ok(touched.length > 0, 'the local copy was read');
        assert.ok(touched.every((entry) => entry.startsWith(localCopy)), `only the local copy: ${touched.join(', ')}`);
        touched.length = 0;
      };

      // A/B: local target (explicit or implied) resolves exactly this machine's copy.
      assert.equal((await request(`/api/file-tree/projects/${appId}/files`, target(appId, 'pc-node'))).status, 200);
      onlyLocal();
      assert.equal((await request(`/api/file-tree/projects/${appId}/files`)).status, 200, 'no target: this machine');
      onlyLocal();

      // B/C/D: remote targets are refused on their own grounds, never answered from this machine.
      const refusals: Array<[string, string, number, string]> = [
        [appId, 'pixel-node', 409, 'WORKSPACE_REMOTE_OPERATION_UNSUPPORTED'],
        [appId, 'nas-node', 409, 'RUNTIME_NODE_OFFLINE'],
        [appId, 'tablet-node', 409, 'WORKSPACE_NOT_ON_NODE'],
        [appId, 'old-node', 409, 'RUNTIME_NODE_REVOKED'],
        [appId, 'stray-node', 409, 'RUNTIME_NODE_NOT_ENROLLED'],
        [appId, 'ghost-node', 404, 'RUNTIME_NODE_NOT_FOUND'],
        [pixelOnlyId, 'pc-node', 409, 'WORKSPACE_NOT_ON_NODE'],
        [pixelOnlyId, 'pixel-node', 409, 'WORKSPACE_REMOTE_OPERATION_UNSUPPORTED'],
      ];
      for (const [projectId, nodeId, status, code] of refusals) {
        for (const url of [`/api/file-tree/projects/${projectId}/files`, `/api/file-tree/projects/${projectId}/file?filePath=README.md`]) {
          const response = await request(url, target(projectId, nodeId));
          assert.deepEqual([response.status, errorCode(response.body)], [status, code], `${projectId}@${nodeId} ${url}`);
          assert.equal(response.text.includes(localCopy.replace(/\\/g, '\\\\')) || response.text.includes(pixelCopy.replace(/\\/g, '\\\\')) || response.text.includes('/volume1') || response.text.includes('/sdcard'), false, 'no path in the refusal');
        }
      }
      assert.deepEqual(touched, [], 'no folder was touched for any refused target');

      // A target names one project: it never applies to another one.
      assert.equal((await request(`/api/file-tree/projects/${appId}/files`, target(pixelOnlyId, 'pixel-node'))).status, 200);
      onlyLocal();

      // A malformed or half-sent target is refused, not ignored.
      const invalidTargets: Array<Record<string, string>> = [{ 'X-CloudCLI-Runtime-Node': 'pixel-node' }, { 'X-CloudCLI-Runtime-Project': appId }, target(appId, 'bad node!')];
      for (const headers of invalidTargets) {
        const response = await request(`/api/file-tree/projects/${appId}/files`, headers);
        assert.deepEqual([response.status, errorCode(response.body)], [400, 'RUNTIME_TARGET_INVALID']);
      }
      assert.deepEqual(touched, []);

      // E: a client-chosen path cannot redirect the local copy to another folder.
      const escaped = await request(`/api/file-tree/projects/${appId}/file?filePath=${encodeURIComponent(path.join(pixelCopy, 'secret.txt'))}`, target(appId, 'pc-node'));
      assert.notEqual(escaped.status, 200);
      assert.equal((touched as string[]).some((entry) => entry.startsWith(pixelCopy)), false, 'Pixel\'s folder is never read from this machine');
    });
  });
});
