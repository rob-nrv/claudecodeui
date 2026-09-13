// Night audit (post FT-M09-R1): races between admission, cancellation, the run
// journal and a link that drops while a run is still being admitted. Recording
// runtime only; no provider is ever called.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { createNodeAgentExecutor, type NodeExecutorRuntime } from '@/modules/node-agent/node-agent-executor.service.js';

const PROJECT = '/srv/workspaces/app';
const tick = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function createHarness(options: { journalGate?: Promise<void>; workspaceGate?: Promise<void> } = {}) {
  const sent: Array<Record<string, unknown>> = [];
  const runs: string[] = [];
  const journal = {
    started: [] as string[],
    finished: [] as Array<[string, string]>,
    has: () => false,
    recordStarted: async (executionId: string) => {
      journal.started.push(executionId);
      await options.journalGate;
    },
    recordFinished: async (executionId: string, outcome: string) => {
      journal.finished.push([executionId, outcome]);
    },
  };
  const runtime: NodeExecutorRuntime = {
    run: (_provider, _command, runOptions) => {
      runs.push(String(runOptions.sessionId));
      return new Promise(() => undefined);
    },
    abort: async () => true,
    resolveToolApproval: () => ({ status: 'accepted' }),
  };
  const executor = createNodeAgentExecutor({
    runtime,
    history: { recordSession: () => undefined, recordProviderSessionId: () => undefined, fetchHistory: async () => ({ messages: [], total: 0, hasMore: false, offset: 0, limit: null }) },
    workspaceRoot: '/srv/workspaces',
    probe: async () => ({}),
    send: (frame) => {
      sent.push(frame as Record<string, unknown>);
      return true;
    },
    resolveWorkspace: async () => {
      await options.workspaceGate;
      return { ok: true, path: PROJECT };
    },
    journal: journal as never,
  });
  const start = (appSessionId: string) => {
    const executionId = randomUUID();
    void executor.handleFrame({ type: 'run.start', executionId, appSessionId, provider: 'claude', providerSessionId: null, command: 'go', cwd: PROJECT, options: {} });
    return executionId;
  };
  return { executor, sent, runs, journal, start, framesOf: (type: string) => sent.filter((frame) => frame.type === type) };
}

test('a cancel that arrives while the run journal is being written still stops the run before it starts', async () => {
  const gate = deferred();
  const harness = createHarness({ journalGate: gate.promise });
  const executionId = harness.start('session-1');
  await tick();
  await tick();
  assert.deepEqual(harness.journal.started, [executionId], 'the start is inside the journal write');

  await harness.executor.handleFrame({ type: 'run.cancel', executionId });
  gate.resolve();
  await tick();
  await tick();

  assert.deepEqual(harness.runs, [], 'no provider run began');
  assert.deepEqual(harness.framesOf('run.rejected').map((frame) => frame.code), ['CANCELLED']);
  assert.deepEqual(harness.framesOf('run.accepted'), []);
  assert.deepEqual(harness.journal.finished, [[executionId, 'aborted']], 'the journal does not keep a never-finished start');
  assert.equal(harness.executor.activeRunCount(), 0);
});

test('a run still being admitted is reported on reconnect, and is stopped if the control plane does not take it back', async () => {
  const gate = deferred();
  const harness = createHarness({ workspaceGate: gate.promise });
  const executionId = harness.start('session-1');
  await tick();

  harness.executor.onDisconnected();
  assert.deepEqual(harness.executor.activeExecutions(), [{ executionId, lastSeq: 0 }], 'an admitting run is part of what this node owns');

  harness.executor.onWelcome([{ executionId, accepted: false, lastSeq: 0 }]);
  gate.resolve();
  await tick();
  await tick();
  assert.deepEqual(harness.runs, [], 'a run the control plane gave up on never starts unobserved');
  assert.deepEqual(harness.framesOf('run.rejected').map((frame) => frame.code), ['CANCELLED']);
});

test('an admitting run the control plane does take back continues normally', async () => {
  const gate = deferred();
  const harness = createHarness({ workspaceGate: gate.promise });
  const executionId = harness.start('session-1');
  await tick();

  harness.executor.onDisconnected();
  harness.executor.onWelcome([{ executionId, accepted: true, lastSeq: 0 }]);
  gate.resolve();
  await tick();
  await tick();
  assert.deepEqual(harness.runs, ['session-1']);
  assert.deepEqual(harness.framesOf('run.accepted').map((frame) => frame.executionId), [executionId]);
});
