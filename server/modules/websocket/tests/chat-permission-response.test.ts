import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';
import type { AuthenticatedWebSocketRequest, ProviderPermissionResolution } from '@/shared/types.js';

/** Websocket stand-in whose `message` listener can be awaited directly. */
class FakeConnection extends EventEmitter {
  readyState = 1; // WS_OPEN_STATE
  frames: Array<Record<string, unknown>> = [];

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }
}

function createApprovalRuntime(resolution: ProviderPermissionResolution) {
  const calls: unknown[][] = [];
  return {
    calls,
    runtime: {
      hasRuntime: () => true,
      async run() {},
      async abort() {
        return true;
      },
      resolveToolApproval(requestId: string, decision: unknown, scope: unknown) {
        calls.push(['resolve', requestId, decision, scope]);
        return resolution;
      },
      getPendingApprovalsForSession(sessionId: string) {
        calls.push(['pending', sessionId]);
        return [{ requestId: 'request-live', sessionId, toolName: 'Bash', input: { command: 'npm test' }, receivedAt: 'r', expiresAt: 'e' }];
      },
      getRecentPermissionOutcomesForSession(sessionId: string) {
        calls.push(['outcomes', sessionId]);
        return [{ requestId: 'request-old', sessionId, toolName: 'Edit', outcome: 'expired', settledAt: 's', input: {} }];
      },
    },
  };
}

function connect(runtime: ReturnType<typeof createApprovalRuntime>['runtime']) {
  const connection = new FakeConnection();
  handleChatConnection(connection as never, {} as AuthenticatedWebSocketRequest, { runtime });
  const [listener] = connection.listeners('message') as Array<(data: string) => Promise<void>>;
  return { connection, send: (payload: Record<string, unknown>) => listener(JSON.stringify(payload)) };
}

test.afterEach(() => {
  connectedClients.clear();
});

test('a permission response is scoped to its session and acknowledged to the answering socket', async () => {
  const { calls, runtime } = createApprovalRuntime({ status: 'accepted' });
  const { connection, send } = connect(runtime);

  await send({
    type: 'chat.permission-response',
    requestId: 'request-1',
    sessionId: 'session-1',
    allow: true,
    updatedInput: { answers: { 'Pick one?': 'A' } },
  });

  assert.deepEqual(calls, [[
    'resolve',
    'request-1',
    { allow: true, updatedInput: { answers: { 'Pick one?': 'A' } }, message: undefined, rememberEntry: undefined },
    { sessionId: 'session-1' },
  ]]);
  assert.equal(connection.frames.length, 1);
  assert.deepEqual(
    { ...connection.frames[0], timestamp: undefined },
    { kind: 'permission_response_ack', requestId: 'request-1', sessionId: 'session-1', accepted: true, reason: null, timestamp: undefined },
  );
});

test('a late or duplicate permission response is acknowledged as rejected with its reason', async () => {
  const { runtime } = createApprovalRuntime({ status: 'rejected', reason: 'expired' });
  const { connection, send } = connect(runtime);

  await send({ type: 'chat.permission-response', requestId: 'request-1', sessionId: 'session-1', allow: true });

  assert.equal(connection.frames[0].kind, 'permission_response_ack');
  assert.equal(connection.frames[0].accepted, false);
  assert.equal(connection.frames[0].reason, 'expired');
});

test('a permission response without a request id is ignored', async () => {
  const { calls, runtime } = createApprovalRuntime({ status: 'accepted' });
  const { connection, send } = connect(runtime);

  await send({ type: 'chat.permission-response', sessionId: 'session-1', allow: true });

  assert.deepEqual(calls, []);
  assert.deepEqual(connection.frames, []);
});

test('chat.subscribe reports pending approvals and recently settled outcomes for that session', async () => {
  const { calls, runtime } = createApprovalRuntime({ status: 'accepted' });
  const { connection, send } = connect(runtime);

  await send({ type: 'chat.subscribe', sessions: [{ sessionId: 'session-1', lastSeq: 0 }] });

  assert.deepEqual(calls, [['pending', 'session-1'], ['outcomes', 'session-1']]);
  const [ack] = connection.frames;
  assert.equal(ack.kind, 'chat_subscribed');
  assert.deepEqual((ack.pendingPermissions as Array<{ requestId: string }>).map((p) => p.requestId), ['request-live']);
  assert.deepEqual(
    (ack.recentPermissionOutcomes as Array<{ requestId: string; outcome: string }>).map((o) => [o.requestId, o.outcome]),
    [['request-old', 'expired']],
  );
});
