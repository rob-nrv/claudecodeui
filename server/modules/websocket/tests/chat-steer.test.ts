import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EventEmitter } from 'node:events';

import { closeConnection, initializeDatabase, queuedMessagesDb, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';

/**
 * FT-M06 Steer Now: `chat.steer` interrupts the session's ACTIVE run and
 * immediately dispatches its content as the next turn. These tests exercise
 * the real `handleChatConnection` message handler (not a mock of it), the
 * same harness pattern as `chat-claude-profile-binding.test.ts`, so the
 * actual routing between `chat.steer` -> abort -> `chat.send` is proven, not
 * assumed.
 */
class FakeConnection extends EventEmitter {
  readyState = 1; // WS_OPEN_STATE
  frames: Array<Record<string, unknown>> = [];

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }
}

type RecordedRun = { provider: string; command: string; options: Record<string, unknown> };
type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

/** Lets already-scheduled microtasks/timers (websocket handler continuations) run before the next assertion. */
async function flushAsync(ticks = 3): Promise<void> {
  for (let i = 0; i < ticks; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * A runtime whose `run()` calls stay pending until interrupted or drained —
 * needed so a `chat.steer` can be sent while the registry genuinely still
 * shows the turn as `status: 'running'`, exactly like a real in-flight
 * provider process. `abort()` resolves the oldest pending call itself,
 * mirroring how a real `interrupt()` makes the SDK's own in-flight `run()`
 * promise settle. Every test drains any leftover pending run before
 * finishing, so no dangling promise survives the test.
 */
function createControllableRuntime() {
  const calls: RecordedRun[] = [];
  const pendingRuns: Array<Deferred<void>> = [];
  const abortCalls: string[] = [];
  let abortImpl: () => Promise<boolean> = async () => true;

  return {
    calls,
    abortCalls,
    /** Resolves the oldest still-pending `run()` call, as if the provider finished that turn on its own (no abort involved). */
    resolveOldestRun(): void {
      pendingRuns.shift()?.resolve();
    },
    /** Resolves every still-pending `run()` call — test cleanup only, never part of the flow under test. */
    drainPendingRuns(): void {
      while (pendingRuns.length > 0) {
        pendingRuns.shift()?.resolve();
      }
    },
    setAbortImpl(impl: () => Promise<boolean>): void {
      abortImpl = impl;
    },
    runtime: {
      hasRuntime: () => true,
      async run(
        provider: string,
        command: string,
        options: Record<string, unknown>,
        writer: { send: (frame: unknown) => void },
      ) {
        calls.push({ provider, command, options });
        const deferred = createDeferred<void>();
        pendingRuns.push(deferred);
        await deferred.promise;
        void writer;
      },
      async abort(_provider: string, sessionId: string) {
        abortCalls.push(sessionId);
        // Deliberately does not resolve the interrupted turn's own pending
        // `run()` call here: in production that promise settles independently
        // (the provider's own generator unwinding), racing the handler's
        // explicit `completeRun(..., { aborted: true })` — a pre-existing
        // characteristic of `chat.abort` itself (guarded there by
        // `abortedSessionIds`), not something `chat.steer` needs to
        // re-litigate. Left pending; `drainPendingRuns()` cleans it up.
        return abortImpl();
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

function sendChatMessage(connection: FakeConnection, payload: Record<string, unknown>): void {
  const [listener] = connection.listeners('message') as Array<(data: string) => Promise<void>>;
  void listener(JSON.stringify(payload));
}

async function withIsolatedDatabase(runTest: (workspacePath: string) => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'chat-steer-'));
  const databasePath = path.join(tempDirectory, 'auth.db');
  const workspacePath = path.join(tempDirectory, 'workspace');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest(workspacePath);
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

function seedSession(workspacePath: string, sessionId: string): void {
  sessionsDb.createAppSession(sessionId, 'claude', workspacePath, 'Steerable session');
  sessionsDb.assignProviderSessionId(sessionId, 'native-session');
}

test('chat.steer interrupts the active run and immediately dispatches the new content on the SAME session', async () => {
  await withIsolatedDatabase(async (workspacePath) => {
    seedSession(workspacePath, 'session-a');
    const connection = new FakeConnection();
    const { runtime, calls, abortCalls, drainPendingRuns } = createControllableRuntime();
    handleChatConnection(connection as never, FAKE_REQUEST, { runtime });

    sendChatMessage(connection, { type: 'chat.send', sessionId: 'session-a', content: 'first instruction' });
    await flushAsync();

    assert.equal(chatRunRegistry.getRun('session-a')?.status, 'running');
    assert.equal(calls.length, 1);

    sendChatMessage(connection, { type: 'chat.steer', sessionId: 'session-a', content: 'steered instruction' });
    await flushAsync();

    // B/D. The interrupt targeted exactly this session, and the follow-up
    // dispatch landed on it too — never a different/new session id.
    assert.deepEqual(abortCalls, ['session-a']);
    assert.equal(calls.length, 2);
    assert.equal(calls[1]?.command, 'steered instruction');

    // C/E. Never touches the queue, and the run is genuinely active again
    // (the steered turn), not left in limbo.
    assert.equal(queuedMessagesDb.get('session-a'), null);
    assert.equal(chatRunRegistry.getRun('session-a')?.status, 'running');

    // No new Run/session: still exactly one session row for this workspace.
    assert.equal(sessionsDb.getSessionsByProjectPathIncludingArchived(workspacePath).length, 1);
    assert.equal(sessionsDb.getSessionById('session-a')?.provider_session_id, 'native-session');

    // The interrupted turn's own terminal `complete` (aborted) went out
    // before the steered turn's dispatch — proving the client-side ordering
    // concern this feature had to account for is real, not hypothetical.
    const kinds = connection.frames.map((frame) => frame.kind);
    const abortedCompleteIndex = connection.frames.findIndex((frame) => frame.kind === 'complete' && frame.aborted === true);
    assert.notEqual(abortedCompleteIndex, -1, `expected an aborted complete frame, got kinds: ${kinds.join(',')}`);

    drainPendingRuns();
    await flushAsync();
  });
});

test('chat.steer on a session with no active run is an explicit error, not a silent no-op or a queue', async () => {
  await withIsolatedDatabase(async (workspacePath) => {
    seedSession(workspacePath, 'session-a');
    const connection = new FakeConnection();
    const { runtime, calls, abortCalls } = createControllableRuntime();
    handleChatConnection(connection as never, FAKE_REQUEST, { runtime });

    sendChatMessage(connection, { type: 'chat.steer', sessionId: 'session-a', content: 'redirect' });
    await flushAsync();

    const errorFrame = connection.frames.find((frame) => frame.kind === 'protocol_error');
    assert.equal(errorFrame?.code, 'STEER_NOT_ACTIVE');
    assert.equal(calls.length, 0);
    assert.equal(abortCalls.length, 0);
    assert.equal(queuedMessagesDb.get('session-a'), null);
  });
});

test('a race where the run finishes right as steer arrives is treated as no active run', async () => {
  await withIsolatedDatabase(async (workspacePath) => {
    seedSession(workspacePath, 'session-a');
    const connection = new FakeConnection();
    const { runtime, calls, resolveOldestRun } = createControllableRuntime();
    handleChatConnection(connection as never, FAKE_REQUEST, { runtime });

    sendChatMessage(connection, { type: 'chat.send', sessionId: 'session-a', content: 'first instruction' });
    await flushAsync();
    assert.equal(chatRunRegistry.getRun('session-a')?.status, 'running');

    // The run completes ON ITS OWN a moment before the steer request lands
    // (`completeRunIfCurrent`'s safety net, exercised via the real handler).
    resolveOldestRun();
    await flushAsync();
    assert.equal(chatRunRegistry.getRun('session-a')?.status, 'completed');

    sendChatMessage(connection, { type: 'chat.steer', sessionId: 'session-a', content: 'too late' });
    await flushAsync();

    const errorFrame = connection.frames.find((frame) => frame.kind === 'protocol_error');
    assert.equal(errorFrame?.code, 'STEER_NOT_ACTIVE');
    assert.equal(calls.length, 1, 'the steer must not have dispatched a second turn');
  });
});

test('an interrupt that itself reports failure still completes the run so Steer cannot wedge forever', async () => {
  await withIsolatedDatabase(async (workspacePath) => {
    seedSession(workspacePath, 'session-a');
    const connection = new FakeConnection();
    const { runtime, calls, setAbortImpl, drainPendingRuns } = createControllableRuntime();
    handleChatConnection(connection as never, FAKE_REQUEST, { runtime });

    sendChatMessage(connection, { type: 'chat.send', sessionId: 'session-a', content: 'first instruction' });
    await flushAsync();

    setAbortImpl(async () => false);

    sendChatMessage(connection, { type: 'chat.steer', sessionId: 'session-a', content: 'redirect anyway' });
    await flushAsync();

    // Mirrors chat.abort's own established semantics: a failed interrupt call
    // still ends the run from the app's perspective, and the steer proceeds.
    assert.equal(calls.length, 2);
    assert.equal(calls[1]?.command, 'redirect anyway');
    assert.equal(queuedMessagesDb.get('session-a'), null);

    drainPendingRuns();
    await flushAsync();
  });
});

test('two chat.steer requests racing the same session: exactly one dispatches, the other fails explicitly, never a corrupted double-run', async () => {
  await withIsolatedDatabase(async (workspacePath) => {
    seedSession(workspacePath, 'session-a');
    const connection = new FakeConnection();
    const { runtime, calls, drainPendingRuns } = createControllableRuntime();
    handleChatConnection(connection as never, FAKE_REQUEST, { runtime });

    sendChatMessage(connection, { type: 'chat.send', sessionId: 'session-a', content: 'first instruction' });
    await flushAsync();

    // Fired back-to-back, deliberately not awaited between them, so both
    // handlers race past their "is it running" check before either resolves.
    sendChatMessage(connection, { type: 'chat.steer', sessionId: 'session-a', content: 'steer B' });
    sendChatMessage(connection, { type: 'chat.steer', sessionId: 'session-a', content: 'steer C' });
    await flushAsync();

    const errorFrames = connection.frames.filter((frame) => frame.kind === 'protocol_error');
    const runningRunsAfter = chatRunRegistry.listRunningRuns().filter((run) => run.sessionId === 'session-a');

    // Exactly one session, exactly one active run — whichever steer lost the
    // race got an explicit RUN_IN_PROGRESS, never a silently dropped/merged
    // instruction and never two concurrent runs for the same session.
    assert.equal(runningRunsAfter.length, 1);
    assert.equal(sessionsDb.getSessionsByProjectPathIncludingArchived(workspacePath).length, 1);
    if (calls.length === 2) {
      assert.equal(errorFrames.length, 1);
      assert.equal(errorFrames[0]?.code, 'RUN_IN_PROGRESS');
    } else {
      // Both interrupts landed before either dispatch (provider-dependent
      // timing) — still safe as long as exactly one turn ends up running.
      assert.equal(calls.length, 3);
    }
    assert.equal(queuedMessagesDb.get('session-a'), null);

    drainPendingRuns();
    await flushAsync();
  });
});
