import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { runtimeNodesService } from '@/modules/runtime-nodes/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';
import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';

/** Real EventEmitter so the actual `chat.send` handler runs and can be awaited. */
class FakeConnection extends EventEmitter {
  readyState = 1; // WS_OPEN_STATE
  frames: Array<Record<string, unknown>> = [];

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }
}

type RecordedRun = { provider: string; command: string; options: Record<string, unknown> };

function createRecordingRuntime() {
  const calls: RecordedRun[] = [];
  return {
    calls,
    runtime: {
      hasRuntime: () => true,
      async run(
        provider: string,
        command: string,
        options: Record<string, unknown>,
        writer: { send: (frame: unknown) => void },
      ) {
        calls.push({ provider, command, options });
        writer.send({ kind: 'complete', provider, sessionId: 'native-session', exitCode: 0 });
      },
      async abort() {
        return true;
      },
      resolveToolApproval() {
        return { status: 'rejected' as const, reason: 'not_found' as const };
      },
      getPendingApprovalsForSession() {
        return [];
      },
      getRecentPermissionOutcomesForSession() {
        return [];
      },
    },
  };
}

async function sendChatMessage(connection: FakeConnection, payload: Record<string, unknown>): Promise<void> {
  const [listener] = connection.listeners('message') as Array<(data: string) => Promise<void>>;
  await listener(JSON.stringify(payload));
}

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'chat-runtime-node-binding-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

const FAKE_REQUEST = undefined as unknown as AuthenticatedWebSocketRequest;

test('a session bound to this machine\'s runtime node runs normally', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('session-local', 'claude', '/workspace/demo', 'Local run', null, runtimeNodesService.getLocalNodeId());

    const connection = new FakeConnection();
    const { runtime, calls } = createRecordingRuntime();
    handleChatConnection(connection as never, FAKE_REQUEST, { runtime });
    await sendChatMessage(connection, { type: 'chat.send', sessionId: 'session-local', content: 'hi' });

    assert.equal(calls.length, 1);
  });
});

test('a session created before runtime tracking keeps running locally exactly as before', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('session-legacy', 'claude', '/workspace/demo', 'Legacy run');

    const connection = new FakeConnection();
    const { runtime, calls } = createRecordingRuntime();
    handleChatConnection(connection as never, FAKE_REQUEST, { runtime });
    await sendChatMessage(connection, { type: 'chat.send', sessionId: 'session-legacy', content: 'hi' });

    assert.equal(calls.length, 1);
    assert.equal(sessionsDb.getSessionById('session-legacy')?.runtime_node_id, null, 'running never backfills a binding');
  });
});

test('a session bound to another runtime node never runs here, with no silent failover', async () => {
  await withIsolatedDatabase(async () => {
    getConnection().prepare("INSERT INTO runtime_nodes (node_id, label, is_local) VALUES ('nas-node', 'NAS', 0)").run();
    sessionsDb.createAppSession('session-remote', 'claude', '/workspace/demo', 'Remote run', null, 'nas-node');

    const connection = new FakeConnection();
    const { runtime, calls } = createRecordingRuntime();
    handleChatConnection(connection as never, FAKE_REQUEST, { runtime });
    await sendChatMessage(connection, { type: 'chat.send', sessionId: 'session-remote', content: 'hi' });

    assert.equal(calls.length, 0);
    assert.ok(connection.frames.some((frame) => JSON.stringify(frame).includes('RUNTIME_NODE_MISMATCH')));
    assert.equal(chatRunRegistry.getRun('session-remote')?.status === 'running', false);
    assert.equal(sessionsDb.getSessionById('session-remote')?.runtime_node_id, 'nas-node', 'the binding is never rewritten');
  });
});
