import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

/**
 * FT-M06 Gate A regression: proves the actual notification semantics at the
 * provider layer (not just the websocket routing chat-steer.test.ts covers).
 *
 * Drives the real `queryClaudeSDK`/`abortClaudeSDKSession` exported by
 * claude-runtime.provider.js against a controllable fake of the Claude Agent
 * SDK's `query()` async iterable, and records every call the provider makes
 * into the real notification module's exports (mocked here so no push actually
 * fires). This is the only place that can catch a false "Done"/duplicate
 * notification bug, since that decision is made deep inside the provider's
 * own async generator loop, not in the websocket layer.
 */

type SDKMessage = Record<string, unknown>;

function makeControllableQuery() {
  const queued: SDKMessage[] = [];
  const pendingResolvers: Array<(result: IteratorResult<SDKMessage>) => void> = [];
  let finished = false;

  const iterable = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<SDKMessage>> {
          if (queued.length > 0) {
            return { value: queued.shift() as SDKMessage, done: false };
          }
          if (finished) {
            return { value: undefined, done: true };
          }
          return new Promise<IteratorResult<SDKMessage>>((resolve) => {
            pendingResolvers.push(resolve);
          });
        },
      };
    },
    push(message: SDKMessage): void {
      const resolver = pendingResolvers.shift();
      if (resolver) {
        resolver({ value: message, done: false });
      } else {
        queued.push(message);
      }
    },
    finish(): void {
      finished = true;
      while (pendingResolvers.length > 0) {
        pendingResolvers.shift()?.({ value: undefined, done: true });
      }
    },
    async interrupt(): Promise<void> {
      // Mirrors the real SDK: interrupt() ends the generator's stream, it
      // does not throw and does not emit a further message.
      iterable.finish();
    },
  };

  return iterable;
}

function makeContext() {
  return {
    resolveProviderSessionId: (_sessionId: string) => null,
    resolveResumeModel: async (_sessionId: string, model: unknown) => model ?? null,
    getProviderModels: async () => ({}),
    normalizeMessage: (_message: unknown, _sessionId: string) => [],
    isProviderInstalled: async () => true,
  };
}

function makeWs() {
  return {
    userId: 'user-1',
    send: () => {},
  };
}

test('claude provider: notifyRunStopped semantics under real completion, abort, and Steer', async () => {
  const notifyRunStoppedCalls: Array<Record<string, unknown>> = [];
  const notifyRunFailedCalls: Array<Record<string, unknown>> = [];

  const notificationsMock = mock.module('@/modules/notifications/index.js', {
    namedExports: {
      createNotificationEvent: (event: unknown) => event,
      notifyBackgroundWorkCompleted: () => {},
      notifyRunFailed: (args: Record<string, unknown>) => { notifyRunFailedCalls.push(args); },
      notifyRunStopped: (args: Record<string, unknown>) => { notifyRunStoppedCalls.push(args); },
      notifyUserIfEnabled: () => {},
    },
  });

  const queryImpl = mock.fn((..._args: unknown[]): unknown => undefined);
  const sdkMock = mock.module('@anthropic-ai/claude-agent-sdk', {
    namedExports: { query: (...args: unknown[]) => queryImpl(...args) },
  });

  try {
    const provider = await import('@/modules/providers/list/claude/claude-runtime.provider.js');
    const { claudeRuntime } = provider;

    // --- Case 1: real completion -> exactly one notifyRunStopped('completed') ---
    const completingQuery = makeControllableQuery();
    queryImpl.mock.mockImplementationOnce(() => completingQuery);

    const run1 = claudeRuntime.run('do the thing', { sessionId: 'session-done', textOnly: true }, makeWs(), makeContext());
    completingQuery.push({ type: 'system', subtype: 'init', session_id: 'native-done' });
    await new Promise((resolve) => setImmediate(resolve));
    completingQuery.push({ type: 'result', session_id: 'native-done' });
    completingQuery.finish();
    await run1;

    assert.equal(notifyRunStoppedCalls.length, 1, 'a real completion must notify exactly once');
    assert.equal(notifyRunStoppedCalls[0]?.stopReason, 'completed');
    assert.equal(notifyRunFailedCalls.length, 0);

    // --- Case 2: Steer's interrupt on the old turn -> zero notifications, no false "Done" ---
    notifyRunStoppedCalls.length = 0;
    notifyRunFailedCalls.length = 0;

    const oldTurnQuery = makeControllableQuery();
    queryImpl.mock.mockImplementationOnce(() => oldTurnQuery);

    const oldTurnRun = claudeRuntime.run('first instruction', { sessionId: 'session-steer', textOnly: true }, makeWs(), makeContext());
    oldTurnQuery.push({ type: 'system', subtype: 'init', session_id: 'native-steer' });
    await new Promise((resolve) => setImmediate(resolve));

    // Steer: abort the in-flight (old) turn, then dispatch the new one — the
    // same two calls handleChatSteer makes (chat-websocket.service.ts).
    const aborted = await claudeRuntime.abort('session-steer');
    assert.equal(aborted, true);
    await oldTurnRun;

    assert.equal(
      notifyRunStoppedCalls.length,
      0,
      `the interrupted old turn must not notify on its own (would read as a false "Done"/stray "aborted" push); got: ${JSON.stringify(notifyRunStoppedCalls)}`,
    );
    assert.equal(notifyRunFailedCalls.length, 0);

    const newTurnQuery = makeControllableQuery();
    queryImpl.mock.mockImplementationOnce(() => newTurnQuery);
    const newTurnRun = claudeRuntime.run('steered instruction', { sessionId: 'session-steer', textOnly: true }, makeWs(), makeContext());
    newTurnQuery.push({ type: 'system', subtype: 'init', session_id: 'native-steer-2' });
    await new Promise((resolve) => setImmediate(resolve));
    newTurnQuery.push({ type: 'result', session_id: 'native-steer-2' });
    newTurnQuery.finish();
    await newTurnRun;

    // Exactly one notification for the whole steer sequence (the new turn's
    // own completion) — never two, i.e. no duplicate across old/new turn.
    assert.equal(notifyRunStoppedCalls.length, 1, 'steer must not produce a duplicate notification across the old and new turn');
    assert.equal(notifyRunStoppedCalls[0]?.stopReason, 'completed');
  } finally {
    notificationsMock.restore();
    sdkMock.restore();
  }
});
