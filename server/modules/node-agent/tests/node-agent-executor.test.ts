import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { createNodeAgentExecutor, type NodeExecutorRuntime } from '@/modules/node-agent/node-agent-executor.service.js';
import type { ProviderRuntimeWriter } from '@/shared/types.js';

const ROOT = '/srv/workspaces';
const PROJECT = '/srv/workspaces/app';

type Deferred = { promise: Promise<void>; resolve(): void; reject(error: Error): void };
const deferred = (): Deferred => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const tick = () => new Promise((resolve) => setImmediate(resolve));

function createHarness(options: { graceMs?: number } = {}) {
  const sent: Array<Record<string, unknown>> = [];
  const runs: Array<{ command: string; options: Record<string, unknown>; writer: ProviderRuntimeWriter; done: Deferred }> = [];
  const aborted: string[] = [];
  const approvals: Array<{ requestId: string; sessionId: string | null | undefined }> = [];
  const runtime: NodeExecutorRuntime = {
    run(_provider, command, runOptions, writer) {
      const done = deferred();
      runs.push({ command, options: runOptions, writer, done });
      return done.promise;
    },
    async abort(_provider, sessionId) {
      aborted.push(sessionId);
      runs.find((run) => run.options.sessionId === sessionId)?.done.resolve();
      return true;
    },
    resolveToolApproval(requestId, _decision, scope) {
      approvals.push({ requestId, sessionId: scope?.sessionId });
      return { status: 'accepted' };
    },
  };
  const history = {
    sessions: [] as string[],
    recordSession: (appSessionId: string) => history.sessions.push(appSessionId),
    recordProviderSessionId: () => undefined,
    fetchHistory: async () => ({ messages: [{ id: 'm1' }], total: 1, hasMore: false, offset: 0, limit: null }),
  };
  let connected = true;
  const executor = createNodeAgentExecutor({
    runtime,
    history: history as never,
    workspaceRoot: ROOT,
    graceMs: options.graceMs ?? 40,
    probe: async () => ({ 'claude-cli': { outcome: 'proven', detail: '2.1.220' } }),
    send: (frame) => {
      if (connected) {
        sent.push(frame as Record<string, unknown>);
      }
      return connected;
    },
    // Real confinement is covered by the workspace tests; here only the executor's use of the answer matters.
    resolveWorkspace: async (_root, requested) => (requested === PROJECT
      ? { ok: true, path: PROJECT }
      : { ok: false, reason: 'outside_workspace_root' }),
  });
  const start = (overrides: Record<string, unknown> = {}) => {
    const frame = {
      type: 'run.start',
      executionId: randomUUID(),
      appSessionId: 'session-1',
      provider: 'claude',
      providerSessionId: null,
      command: 'hello',
      cwd: PROJECT,
      options: { model: 'opus', attachments: [{ path: 'C:/secret.png' }], claudeProfileId: 'work', cwd: '/etc' },
      ...overrides,
    };
    return { frame, handled: executor.handleFrame(frame) };
  };
  return {
    executor,
    sent,
    runs,
    aborted,
    approvals,
    history,
    start,
    setConnected: (value: boolean) => {
      connected = value;
    },
    framesOf: (type: string) => sent.filter((frame) => frame.type === type),
  };
}

test('an accepted run gets only whitelisted options, the node-resolved folder, and a monotonic seq to its end', async () => {
  const harness = createHarness();
  const { frame } = harness.start();
  await tick();

  assert.deepEqual(harness.framesOf('run.accepted'), [{ type: 'run.accepted', executionId: frame.executionId }]);
  assert.equal(harness.runs.length, 1);
  const run = harness.runs[0];
  assert.equal(run.options.cwd, PROJECT);
  assert.equal(run.options.sessionId, 'session-1');
  assert.equal(run.options.model, 'opus');
  assert.equal('attachments' in run.options && run.options.attachments !== undefined, false, 'attachments never reach the runtime');
  assert.equal(run.options.claudeProfileId, undefined, 'no control plane account crosses machines');

  run.writer.send({ kind: 'session_created', newSessionId: 'native-1' });
  run.writer.send({ kind: 'text', content: 'hi' });
  run.writer.send({ kind: 'complete', exitCode: 0 });
  run.done.resolve();
  await tick();

  const sequenced = harness.sent.filter((sentFrame) => typeof sentFrame.seq === 'number');
  assert.deepEqual(sequenced.map((sentFrame) => [sentFrame.type, sentFrame.seq]), [
    ['run.provider_session', 1],
    ['run.event', 2],
    ['run.event', 3],
    ['run.finished', 4],
  ]);
  assert.equal(harness.framesOf('run.finished')[0].outcome, 'completed');
});

test('an execution id runs at most once, even when a cancel arrived before its start', async () => {
  const harness = createHarness();
  const { frame } = harness.start();
  await tick();
  await harness.executor.handleFrame(frame);
  assert.deepEqual(harness.framesOf('run.rejected'), [{ type: 'run.rejected', executionId: frame.executionId, code: 'DUPLICATE_EXECUTION' }]);
  assert.equal(harness.runs.length, 1);

  const lateId = randomUUID();
  await harness.executor.handleFrame({ type: 'run.cancel', executionId: lateId });
  await harness.start({ executionId: lateId, appSessionId: 'session-2' }).handled;
  assert.equal(harness.runs.length, 1, 'a start that lost its race with a cancel never runs');
});

test('runs outside the workspace root, for other providers, malformed, or on a busy session are refused', async () => {
  const harness = createHarness();
  await harness.start({ cwd: '/etc' }).handled;
  await harness.start({ provider: 'codex' }).handled;
  await harness.start({ appSessionId: '../../x' }).handled;
  assert.deepEqual(harness.framesOf('run.rejected').map((frame) => frame.code), ['WORKSPACE_UNAVAILABLE', 'PROVIDER_UNSUPPORTED', 'INVALID_REQUEST']);

  harness.start();
  await tick();
  await harness.start().handled;
  assert.equal(harness.framesOf('run.rejected').at(-1)?.code, 'SESSION_BUSY');
  assert.equal(harness.runs.length, 1);
});

test('a lost link aborts runs after the grace unless the control plane takes them back', async () => {
  const harness = createHarness({ graceMs: 30 });
  harness.start();
  await tick();
  harness.setConnected(false);
  harness.executor.onDisconnected();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(harness.aborted, ['session-1'], 'no run continues unobserved');
});

test('a resumed run replays exactly the frames the control plane missed', async () => {
  const harness = createHarness({ graceMs: 1_000 });
  const { frame } = harness.start();
  await tick();
  const run = harness.runs[0];
  run.writer.send({ kind: 'text', content: 'one' });
  harness.setConnected(false);
  harness.executor.onDisconnected();
  run.writer.send({ kind: 'text', content: 'two' });
  run.writer.send({ kind: 'text', content: 'three' });

  assert.deepEqual(harness.executor.activeExecutions(), [{ executionId: frame.executionId, lastSeq: 3 }]);
  harness.setConnected(true);
  const before = harness.sent.length;
  harness.executor.onWelcome([{ executionId: frame.executionId, accepted: true, lastSeq: 1 }]);
  const replayed = harness.sent.slice(before);
  assert.deepEqual(replayed.map((sentFrame) => sentFrame.seq), [2, 3]);
  assert.deepEqual(harness.aborted, []);

  harness.executor.onWelcome([{ executionId: frame.executionId, accepted: false, lastSeq: 0 }]);
  await tick();
  assert.deepEqual(harness.aborted, ['session-1'], 'a run the control plane no longer tracks is stopped');
});

test('cancel, approvals, probes, workspace checks and history answer only for what they name', async () => {
  const harness = createHarness();
  const { frame } = harness.start();
  await tick();

  await harness.executor.handleFrame({
    type: 'approval.resolve',
    requestId: 'r1',
    executionId: frame.executionId,
    approvalId: 'approval-1',
    decision: { allow: true },
  });
  await harness.executor.handleFrame({ type: 'approval.resolve', requestId: 'r2', executionId: randomUUID(), approvalId: 'approval-1', decision: { allow: true } });
  assert.deepEqual(harness.approvals, [{ requestId: 'approval-1', sessionId: 'session-1' }]);
  assert.deepEqual(harness.framesOf('approval.result').map((result) => (result.resolution as { status: string }).status), ['accepted', 'rejected']);

  await harness.executor.handleFrame({ type: 'probe.request', requestId: 'p1' });
  assert.equal((harness.framesOf('probe.result')[0].outcomes as Record<string, unknown>)['claude-cli'] !== undefined, true);

  await harness.executor.handleFrame({ type: 'workspace.verify', requestId: 'w1', path: PROJECT });
  await harness.executor.handleFrame({ type: 'workspace.verify', requestId: 'w2', path: '/etc' });
  assert.deepEqual(harness.framesOf('workspace.result').map((result) => [result.ok, result.path, result.reason]), [
    [true, PROJECT, null],
    [false, null, 'outside_workspace_root'],
  ]);

  await harness.executor.handleFrame({ type: 'history.fetch', requestId: 'h1', appSessionId: 'session-1', providerSessionId: 'native-1', cwd: PROJECT, limit: 10, offset: 0 });
  await harness.executor.handleFrame({ type: 'history.fetch', requestId: 'h2', appSessionId: 'session-1', providerSessionId: 'native-1', cwd: '/etc', limit: 10, offset: 0 });
  assert.deepEqual(harness.framesOf('history.result').map((result) => result.ok), [true, false]);

  await harness.executor.handleFrame({ type: 'run.cancel', executionId: frame.executionId });
  assert.deepEqual(harness.framesOf('run.cancel_result').map((result) => result.aborted), [true]);
  await tick();
  assert.equal(harness.framesOf('run.finished')[0].outcome, 'aborted');
});
