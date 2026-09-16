// FT-M10: a project Shell opens only in this machine's own copy of the
// project; sessions bound to a remote RuntimeNode and projects without a copy
// here are refused before any process starts. Temporary databases only.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { WebSocket } from 'ws';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  projectsDb,
  sessionsDb,
} from '@/modules/database/index.js';
import { createProjectWorkspaceLocator } from '@/modules/project-registry/index.js';
import { handleShellConnection } from '@/modules/websocket/services/shell-websocket.service.js';
import { createShellWorkspaceResolver } from '@/modules/websocket/services/shell-workspace.service.js';

async function withIsolatedDatabase(runTest: (directory: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'shell-registry-'));
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

function createFakeSocket() {
  const socket = new EventEmitter() as EventEmitter & { readyState: number; frames: string[]; send: (data: string) => void };
  socket.readyState = WebSocket.OPEN;
  socket.frames = [];
  socket.send = (data: string) => socket.frames.push(data);
  return socket;
}

function createFakePty() {
  return {
    onData: () => ({ dispose: () => undefined }),
    onExit: () => ({ dispose: () => undefined }),
    write() {},
    resize() {},
    kill() {},
  };
}

const insertBoundSession = (sessionId: string, projectId: string, projectPath: string, nodeId: string) =>
  getConnection().prepare(`
    INSERT INTO sessions (session_id, provider, provider_session_id, project_id, project_path, runtime_node_id)
    VALUES (?, 'claude', ?, ?, ?, ?)
  `).run(sessionId, `native-${sessionId}`, projectId, projectPath, nodeId);

test('Shell opens a project terminal only in this machine\'s copy, refuses remote sessions and projects without a copy, and keeps session-less shells unchanged', { concurrency: false }, async () => {
  await withIsolatedDatabase(async (directory) => {
    const controlPlanePath = path.join(directory, 'control-plane', 'app');
    await fs.mkdir(controlPlanePath, { recursive: true });
    const app = projectsDb.createProjectPath(controlPlanePath).project!;
    const pixelOnly = projectsDb.createProjectWithoutControlPlaneCopy('Pixel-only app');
    insertBoundSession('shell-remote-session', app.project_id, controlPlanePath, 'pixel-node');
    insertBoundSession('shell-local-session', app.project_id, controlPlanePath, 'pc-node');

    const locator = createProjectWorkspaceLocator();
    const resolveWorkspace = createShellWorkspaceResolver({
      getSession: (sessionId) => sessionsDb.getSessionById(sessionId),
      isRemoteBinding: (runtimeNodeId) => runtimeNodeId === 'pixel-node',
      resolveOnControlPlane: (projectId) => locator.resolveOnControlPlane(projectId),
    });

    const open = (message: Record<string, unknown>) => {
      const calls: Array<{ cwd?: string }> = [];
      const socket = createFakeSocket();
      handleShellConnection(socket as never, {
        resolveProviderSessionId: () => null,
        resolveWorkspace,
        spawnPty: ((_shell: string, _args: unknown, options: { cwd?: string }) => {
          calls.push(options);
          return createFakePty() as never;
        }) as never,
      });
      socket.emit('message', JSON.stringify({
        type: 'init', hasSession: false, provider: 'plain-shell', isPlainShell: true, initialCommand: `echo ${Math.random()}`, ...message,
      }));
      const errors = socket.frames.map((frame) => JSON.parse(frame) as { type: string; code?: string }).filter((frame) => frame.type === 'error');
      return { cwds: calls.map((call) => call.cwd), errors: errors.map((error) => error.code) };
    };

    const clientElsewhere = path.join(directory, 'somewhere-else');
    await fs.mkdir(clientElsewhere, { recursive: true });

    assert.deepEqual(open({ projectId: app.project_id, projectPath: clientElsewhere, sessionId: null }),
      { cwds: [path.resolve(controlPlanePath)], errors: [] }, 'the registry copy wins over the client path');
    assert.deepEqual(open({ projectId: pixelOnly.project_id, projectPath: clientElsewhere, sessionId: null }),
      { cwds: [], errors: ['WORKSPACE_NOT_ON_NODE'] }, 'no copy here: no terminal in the client folder or the current directory');
    assert.deepEqual(open({ projectId: app.project_id, projectPath: controlPlanePath, sessionId: 'shell-remote-session' }),
      { cwds: [], errors: ['RUNTIME_NODE_REMOTE_SESSION'] }, 'a remote session never gets a local terminal');
    assert.deepEqual(open({ projectId: pixelOnly.project_id, projectPath: clientElsewhere, sessionId: 'shell-local-session' }),
      { cwds: [path.resolve(controlPlanePath)], errors: [] }, 'a session\'s own project wins over the client claim');
    assert.deepEqual(open({ projectId: 'default', projectPath: clientElsewhere, sessionId: null }),
      { cwds: [path.resolve(clientElsewhere)], errors: [] }, 'shells naming no registered project (login, usage) are unchanged');
  });
});
