// FT-M10 strict targeting for Shell: a project terminal opens only in the copy
// of the RuntimeNode it targets — the open session's own node, else the node the
// client chose — and only when that node is this machine. Any remote or unusable
// target is refused before a process starts; nothing falls back to this
// machine's folder, another node's folder, the client path or the current
// directory. Temporary databases; the pty spawn is recorded, never real.
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
  runtimeNodeCredentialsDb,
  runtimeNodesDb,
  runtimeNodeWorkspacesDb,
  sessionsDb,
} from '@/modules/database/index.js';
import { createProjectWorkspaceLocator } from '@/modules/project-registry/index.js';
import { handleShellConnection } from '@/modules/websocket/services/shell-websocket.service.js';
import { createShellWorkspaceResolver } from '@/modules/websocket/services/shell-workspace.service.js';

const NOW = Date.UTC(2026, 8, 16, 12, 0, 0);

async function withIsolatedDatabase(runTest: (directory: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'shell-targeting-'));
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

const insertSession = (sessionId: string, projectId: string, projectPath: string, nodeId: string | null) =>
  getConnection().prepare(`
    INSERT INTO sessions (session_id, provider, provider_session_id, project_id, project_path, runtime_node_id)
    VALUES (?, 'claude', ?, ?, ?, ?)
  `).run(sessionId, `native-${sessionId}`, projectId, projectPath, nodeId);

test('Shell: the targeted local node opens only its own copy; remote, unusable or vanished targets are refused and no terminal starts elsewhere', { concurrency: false }, async () => {
  await withIsolatedDatabase(async (directory) => {
    const db = getConnection();
    db.prepare("INSERT INTO runtime_nodes (node_id, label, is_local) VALUES ('pc-node', 'Windows PC', 1)").run();
    for (const [nodeId, status] of [['pixel-node', 'active'], ['nas-node', 'active'], ['tablet-node', 'active'], ['old-node', 'revoked'], ['gone-node', 'active']]) {
      db.prepare('INSERT INTO runtime_nodes (node_id, label, is_local) VALUES (?, ?, 0)').run(nodeId, nodeId);
      db.prepare('INSERT INTO runtime_node_credentials (node_id, public_key, status, enrolled_at) VALUES (?, ?, ?, ?)').run(nodeId, `key-${nodeId}`, status, NOW);
    }
    db.prepare("INSERT INTO runtime_nodes (node_id, label, is_local) VALUES ('stray-node', 'Never enrolled', 0)").run();

    // Every folder really exists, so only targeting decides where a terminal may open.
    const localCopy = path.join(directory, 'pc', 'app');
    const pixelCopy = path.join(directory, 'pixel', 'app');
    const clientElsewhere = path.join(directory, 'client-claimed');
    for (const folder of [localCopy, pixelCopy, clientElsewhere]) {
      await fs.mkdir(folder, { recursive: true });
    }
    const app = projectsDb.createProjectPath(localCopy).project!;
    const pixelOnly = projectsDb.createProjectWithoutControlPlaneCopy('Pixel-only app');
    for (const [nodeId, projectId, nodePath] of [
      ['pixel-node', app.project_id, pixelCopy],
      ['nas-node', app.project_id, '/volume1/code/app'],
      ['old-node', app.project_id, '/sdcard/app'],
      ['gone-node', app.project_id, '/gone/app'],
      ['pixel-node', pixelOnly.project_id, path.join(directory, 'pixel', 'pixel-only')],
    ]) {
      runtimeNodeWorkspacesDb.upsert({ nodeId, projectId, nodePath, status: 'verified', reason: null, verifiedAt: NOW, gitRootCommits: null });
    }

    insertSession('session-local-bound', app.project_id, localCopy, 'pc-node');
    insertSession('session-legacy', app.project_id, localCopy, null);
    insertSession('session-on-pixel', app.project_id, localCopy, 'pixel-node');
    insertSession('session-on-gone', app.project_id, localCopy, 'gone-node');
    // The node a session was bound to has since disappeared (its credential and mapping cascade away).
    db.prepare("DELETE FROM runtime_nodes WHERE node_id = 'gone-node'").run();
    assert.equal(runtimeNodesDb.getById('gone-node'), null);

    const online = new Set(['pixel-node', 'tablet-node', 'old-node', 'stray-node']);
    const resolveWorkspace = createShellWorkspaceResolver({
      getSession: (sessionId) => sessionsDb.getSessionById(sessionId),
      isRemoteBinding: (runtimeNodeId) => {
        if (!runtimeNodeId) return false;
        const node = runtimeNodesDb.getById(runtimeNodeId);
        return Boolean(node && !node.isLocal && runtimeNodeCredentialsDb.getByNodeId(runtimeNodeId));
      },
      locator: createProjectWorkspaceLocator({ isUsable: (nodeId) => online.has(nodeId) }),
    });

    const open = (message: Record<string, unknown>) => {
      const cwds: string[] = [];
      const socket = createFakeSocket();
      handleShellConnection(socket as never, {
        resolveProviderSessionId: () => null,
        resolveWorkspace,
        spawnPty: ((_shell: string, _args: unknown, options: { cwd?: string }) => {
          cwds.push(String(options.cwd));
          return createFakePty() as never;
        }) as never,
      });
      socket.emit('message', JSON.stringify({
        type: 'init', hasSession: false, provider: 'plain-shell', isPlainShell: true, initialCommand: `echo ${Math.random()}`,
        projectPath: clientElsewhere, sessionId: null, ...message,
      }));
      const errors = socket.frames.map((frame) => JSON.parse(frame) as { type: string; code?: string; message?: string }).filter((frame) => frame.type === 'error');
      for (const error of errors) {
        for (const folder of [localCopy, pixelCopy, clientElsewhere, '/volume1', '/sdcard', '/gone']) {
          assert.equal(String(error.message).includes(folder), false, 'no path in a refusal');
        }
      }
      return { cwds, errors: errors.map((error) => error.code) };
    };
    const local = { cwds: [path.resolve(localCopy)], errors: [] };
    const refused = (code: string) => ({ cwds: [], errors: [code] });

    // A + E: a registered project opens its registry copy on the local target, whatever path the client sent.
    assert.deepEqual(open({ projectId: app.project_id }), local, 'no target: this machine');
    assert.deepEqual(open({ projectId: app.project_id, runtimeNodeId: 'pc-node' }), local, 'explicit local target');
    assert.deepEqual(open({ projectId: app.project_id, sessionId: 'session-local-bound' }), local, 'session bound to the local node');
    assert.deepEqual(open({ projectId: app.project_id, sessionId: 'session-legacy', runtimeNodeId: 'pixel-node' }), local,
      'a session that ran here stays here; the client\'s node choice cannot move it');

    // B/C: a remote target never opens a local terminal.
    assert.deepEqual(open({ projectId: app.project_id, runtimeNodeId: 'pixel-node' }), refused('WORKSPACE_REMOTE_OPERATION_UNSUPPORTED'));
    assert.deepEqual(open({ projectId: app.project_id, sessionId: 'session-on-pixel', runtimeNodeId: 'pc-node' }), refused('RUNTIME_NODE_REMOTE_SESSION'),
      'a session\'s own remote node wins over a client claim of the local node');
    assert.deepEqual(open({ projectId: pixelOnly.project_id, sessionId: 'session-on-gone' }), refused('RUNTIME_NODE_NOT_FOUND'),
      'a session whose node vanished is not reopened on this machine');

    // D: unusable targets are refused on their own grounds.
    assert.deepEqual(open({ projectId: app.project_id, runtimeNodeId: 'nas-node' }), refused('RUNTIME_NODE_OFFLINE'));
    assert.deepEqual(open({ projectId: app.project_id, runtimeNodeId: 'tablet-node' }), refused('WORKSPACE_NOT_ON_NODE'));
    assert.deepEqual(open({ projectId: app.project_id, runtimeNodeId: 'old-node' }), refused('RUNTIME_NODE_REVOKED'));
    assert.deepEqual(open({ projectId: app.project_id, runtimeNodeId: 'stray-node' }), refused('RUNTIME_NODE_NOT_ENROLLED'));
    assert.deepEqual(open({ projectId: app.project_id, runtimeNodeId: 'ghost-node' }), refused('RUNTIME_NODE_NOT_FOUND'));
    assert.deepEqual(open({ projectId: pixelOnly.project_id }), refused('WORKSPACE_NOT_ON_NODE'), 'no copy here, no target');
    assert.deepEqual(open({ projectId: pixelOnly.project_id, runtimeNodeId: 'pixel-node' }), refused('WORKSPACE_REMOTE_OPERATION_UNSUPPORTED'));

    // No registered project (login, usage modals): the historical client folder, clearly separate from project shells.
    assert.deepEqual(open({ projectId: 'default' }), { cwds: [path.resolve(clientElsewhere)], errors: [] });
    assert.deepEqual(open({ projectId: 'default', runtimeNodeId: 'pixel-node' }), { cwds: [path.resolve(clientElsewhere)], errors: [] });
  });
});
