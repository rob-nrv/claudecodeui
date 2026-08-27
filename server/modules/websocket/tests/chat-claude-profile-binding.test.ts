import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EventEmitter } from 'node:events';

import { claudeProfilesDb, closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';

/**
 * Minimal stand-in for a websocket connection with a real EventEmitter, so
 * `handleChatConnection`'s `ws.on('message', ...)` handler can be invoked
 * directly and awaited (unlike `chat-run-registry.test.ts`, these tests need
 * to go through the actual `chat.send` handler to exercise profile
 * resolution, not just the run registry underneath it).
 */
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
      resolveToolApproval() {},
      getPendingApprovalsForSession() {
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
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'chat-claude-profile-binding-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
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

test('chat.send resolves CLAUDE_CONFIG_DIR from the session\'s bound profile, not the client', async () => {
  await withIsolatedDatabase(async () => {
    claudeProfilesDb.create({
      id: 'profile-work',
      displayName: 'Work',
      configDirectory: '/tmp/claude-profiles/profile-work',
      isDefault: true,
    });
    sessionsDb.createAppSession('session-work', 'claude', '/workspace/demo', 'Work session', 'profile-work');

    const connection = new FakeConnection();
    const { runtime, calls } = createRecordingRuntime();
    handleChatConnection(connection as never, FAKE_REQUEST, { runtime });

    // A client trying to smuggle a different profile through chat.send options
    // must be ignored — the binding only ever comes from the session row.
    await sendChatMessage(connection, {
      type: 'chat.send',
      sessionId: 'session-work',
      content: 'hi',
      options: { claudeProfileId: 'attacker-supplied-profile' },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.options.claudeProfileId, 'profile-work');
  });
});

test('two sessions bound to different profiles resolve distinct, session-scoped profile ids', async () => {
  await withIsolatedDatabase(async () => {
    claudeProfilesDb.create({
      id: 'profile-work',
      displayName: 'Work',
      configDirectory: '/tmp/claude-profiles/profile-work',
      isDefault: true,
    });
    claudeProfilesDb.create({
      id: 'profile-personal',
      displayName: 'Personal',
      configDirectory: '/tmp/claude-profiles/profile-personal',
      isDefault: false,
    });
    sessionsDb.createAppSession('session-work', 'claude', '/workspace/demo', 'Work session', 'profile-work');
    sessionsDb.createAppSession('session-personal', 'claude', '/workspace/demo', 'Personal session', 'profile-personal');

    const connectionA = new FakeConnection();
    const recordingA = createRecordingRuntime();
    handleChatConnection(connectionA as never, FAKE_REQUEST, { runtime: recordingA.runtime });
    await sendChatMessage(connectionA, { type: 'chat.send', sessionId: 'session-work', content: 'hi' });

    const connectionB = new FakeConnection();
    const recordingB = createRecordingRuntime();
    handleChatConnection(connectionB as never, FAKE_REQUEST, { runtime: recordingB.runtime });
    await sendChatMessage(connectionB, { type: 'chat.send', sessionId: 'session-personal', content: 'hi' });

    assert.equal(recordingA.calls[0]?.options.claudeProfileId, 'profile-work');
    assert.equal(recordingB.calls[0]?.options.claudeProfileId, 'profile-personal');
  });
});

test('resume keeps resolving the session\'s original profile even after the default changes', async () => {
  await withIsolatedDatabase(async () => {
    claudeProfilesDb.create({
      id: 'profile-work',
      displayName: 'Work',
      configDirectory: '/tmp/claude-profiles/profile-work',
      isDefault: true,
    });
    claudeProfilesDb.create({
      id: 'profile-personal',
      displayName: 'Personal',
      configDirectory: '/tmp/claude-profiles/profile-personal',
      isDefault: false,
    });
    sessionsDb.createAppSession('session-work', 'claude', '/workspace/demo', 'Work session', 'profile-work');

    const connection = new FakeConnection();
    const { runtime, calls } = createRecordingRuntime();
    handleChatConnection(connection as never, FAKE_REQUEST, { runtime });

    await sendChatMessage(connection, { type: 'chat.send', sessionId: 'session-work', content: 'first turn' });

    // Someone changes which profile is "default" globally in Settings...
    claudeProfilesDb.setDefault('profile-personal');

    // ...a later turn on the SAME session (the resume path) must still bind
    // to Work, never to whatever is currently marked default.
    await sendChatMessage(connection, { type: 'chat.send', sessionId: 'session-work', content: 'second turn' });

    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.options.claudeProfileId, 'profile-work');
    assert.equal(calls[1]?.options.claudeProfileId, 'profile-work');
  });
});

test('a legacy session with no bound profile spawns exactly as before (no claudeProfileId)', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('session-legacy', 'claude', '/workspace/demo', 'Legacy session');

    const connection = new FakeConnection();
    const { runtime, calls } = createRecordingRuntime();
    handleChatConnection(connection as never, FAKE_REQUEST, { runtime });

    await sendChatMessage(connection, { type: 'chat.send', sessionId: 'session-legacy', content: 'hi' });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.options.claudeProfileId, undefined);
  });
});

test('a session bound to a since-deleted profile halts instead of falling back silently', async () => {
  await withIsolatedDatabase(async () => {
    claudeProfilesDb.create({
      id: 'profile-removed',
      displayName: 'Removed',
      configDirectory: '/tmp/claude-profiles/profile-removed',
      isDefault: true,
    });
    sessionsDb.createAppSession('session-orphaned', 'claude', '/workspace/demo', 'Orphaned session', 'profile-removed');
    claudeProfilesDb.delete('profile-removed');

    const connection = new FakeConnection();
    const { runtime, calls } = createRecordingRuntime();
    handleChatConnection(connection as never, FAKE_REQUEST, { runtime });

    await sendChatMessage(connection, { type: 'chat.send', sessionId: 'session-orphaned', content: 'hi' });

    assert.equal(calls.length, 0, 'the runtime must never be invoked for an orphaned profile binding');
    const errorFrames = connection.frames.filter((frame) => frame.kind === 'protocol_error');
    assert.equal(errorFrames.length, 1);
    assert.equal(errorFrames[0]?.code, 'CLAUDE_PROFILE_UNAVAILABLE');
  });
});
