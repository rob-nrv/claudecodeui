// FT-M09 executor behavior: Resource Governor admission, duplicate refusal
// across an agent restart (run journal), a cancel that races admission, and
// read-only workspace inspection frames. Recording runtime only — no provider.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createNodeAgentExecutor, type NodeExecutorRuntime } from '@/modules/node-agent/node-agent-executor.service.js';
import { createNodeResourceGovernor, type NodeResourceSignals } from '@/modules/node-agent/node-agent-resource-governor.js';
import { createNodeAgentRunJournal, type NodeAgentRunJournal } from '@/modules/node-agent/node-agent-run-journal.js';
import type { NodeWorkspaceResolution } from '@/modules/node-agent/node-agent-workspace.js';

const PROJECT = '/srv/workspaces/app';
const tick = () => new Promise((resolve) => setImmediate(resolve));

type Pending = { sessionId: string; resolve(): void };

function createHarness(options: {
  signals?: () => NodeResourceSignals;
  maxConcurrentRuns?: number;
  journal?: NodeAgentRunJournal;
  resolveWorkspace?: (root: string, requested: unknown) => Promise<NodeWorkspaceResolution>;
} = {}) {
  const sent: Array<Record<string, unknown>> = [];
  const pending: Pending[] = [];
  const runtime: NodeExecutorRuntime = {
    run(_provider, _command, runOptions) {
      return new Promise<void>((resolve) => pending.push({ sessionId: String(runOptions.sessionId), resolve }));
    },
    async abort() {
      return true;
    },
    resolveToolApproval: () => ({ status: 'accepted' }),
  };
  const signals = options.signals ?? (() => ({
    storage: { state: 'unknown', reason: 'storage_unreadable' },
    battery: { state: 'unknown', reason: 'battery_unreadable' },
    thermal: { state: 'unknown', reason: 'no_portable_source' },
  } as NodeResourceSignals));
  const executor = createNodeAgentExecutor({
    runtime,
    history: { recordSession: () => undefined, recordProviderSessionId: () => undefined, fetchHistory: async () => ({ messages: [], total: 0, hasMore: false, offset: 0, limit: null }) },
    workspaceRoot: '/srv/workspaces',
    probe: async () => ({ 'claude-cli': { outcome: 'proven', detail: '2.1.220' } }),
    send: (frame) => {
      sent.push(frame as Record<string, unknown>);
      return true;
    },
    resolveWorkspace: options.resolveWorkspace ?? (async (_root, requested) => (requested === PROJECT
      ? { ok: true, path: PROJECT }
      : { ok: false, reason: 'folder_not_found' })),
    governor: createNodeResourceGovernor({
      policy: { maxConcurrentRuns: options.maxConcurrentRuns ?? 1, minFreeStorageBytes: 512 * 1024 * 1024, minBatteryPercent: 20 },
      readSignals: async () => signals(),
    }),
    journal: options.journal ?? null,
    inspectWorkspace: async () => ({ folder: 'available', git: { state: 'not_repository' } }),
    readRootCommits: async () => ['a'.repeat(40)],
  });
  const start = (appSessionId: string, executionId = randomUUID()) => ({
    executionId,
    handled: executor.handleFrame({ type: 'run.start', executionId, appSessionId, provider: 'claude', providerSessionId: null, command: 'go', cwd: PROJECT, options: {} }),
  });
  return { executor, sent, pending, start, framesOf: (type: string) => sent.filter((frame) => frame.type === type) };
}

test('the governor refuses a run over the concurrency limit explicitly, and frees the slot when a run ends', async () => {
  const harness = createHarness({ maxConcurrentRuns: 1 });
  harness.start('session-1');
  await tick();
  assert.equal(harness.pending.length, 1);

  const second = harness.start('session-2');
  await second.handled;
  assert.deepEqual(harness.framesOf('run.rejected').map((frame) => [frame.executionId, frame.code]), [[second.executionId, 'RESOURCE_CONCURRENCY_LIMIT']]);
  assert.equal(harness.pending.length, 1, 'never queued, never run');

  harness.pending[0].resolve();
  await tick();
  assert.equal(harness.executor.activeRunCount(), 0);
  harness.start('session-2');
  await tick();
  assert.equal(harness.pending.length, 2);
});

test('storage and battery floors refuse only on known signals, and release the reserved slot', async () => {
  let signals: NodeResourceSignals = {
    storage: { state: 'known', freeBytes: 10 * 1024 * 1024 },
    battery: { state: 'unknown', reason: 'battery_unreadable' },
    thermal: { state: 'unknown', reason: 'no_portable_source' },
  };
  const harness = createHarness({ signals: () => signals, maxConcurrentRuns: 2 });
  await harness.start('session-1').handled;
  assert.equal(harness.framesOf('run.rejected').at(-1)?.code, 'RESOURCE_STORAGE_LOW');
  assert.equal(harness.executor.activeRunCount(), 0);

  signals = { ...signals, storage: { state: 'known', freeBytes: 10 * 1024 ** 3 }, battery: { state: 'known', percent: 10, charging: false } };
  await harness.start('session-1').handled;
  assert.equal(harness.framesOf('run.rejected').at(-1)?.code, 'RESOURCE_BATTERY_LOW');

  signals = { ...signals, storage: { state: 'unknown', reason: 'storage_unreadable' }, battery: { state: 'unknown', reason: 'battery_unreadable' } };
  harness.start('session-1');
  await tick();
  assert.equal(harness.pending.length, 1, 'unknown signals never block');

  await harness.executor.handleFrame({ type: 'probe.request', requestId: 'p1' });
  const probe = harness.framesOf('probe.result')[0];
  assert.deepEqual((probe.resources as Record<string, unknown>).admission, 'accepting');
  assert.equal((probe.resources as Record<string, unknown>).activeRuns, 1);
});

test('an execution id accepted before the agent restarted is still refused after it', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'executor-journal-'));
  try {
    const file = path.join(directory, 'run-journal.json');
    const firstJournal = createNodeAgentRunJournal({ file });
    await firstJournal.load();
    const before = createHarness({ journal: firstJournal, maxConcurrentRuns: 2 });
    const { executionId } = before.start('session-1');
    await tick();
    await firstJournal.flush();
    assert.equal(before.pending.length, 1);

    // Restart: new process, new executor, empty in-memory id set.
    const secondJournal = createNodeAgentRunJournal({ file });
    const { interrupted } = await secondJournal.load();
    assert.deepEqual(interrupted.map((entry) => entry.executionId), [executionId]);
    const after = createHarness({ journal: secondJournal, maxConcurrentRuns: 2 });
    await after.start('session-1', executionId).handled;
    assert.deepEqual(after.framesOf('run.rejected').map((frame) => frame.code), ['DUPLICATE_EXECUTION']);
    assert.equal(after.pending.length, 0, 'the replayed dispatch never ran again');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a cancel that arrives while a start is still being admitted stops it before it runs', async () => {
  let releaseWorkspace!: () => void;
  const harness = createHarness({
    resolveWorkspace: () => new Promise((resolve) => {
      releaseWorkspace = () => resolve({ ok: true, path: PROJECT });
    }),
  });
  const { executionId, handled } = harness.start('session-1');
  await tick();
  await harness.executor.handleFrame({ type: 'run.cancel', executionId });
  releaseWorkspace();
  await handled;
  assert.deepEqual(harness.framesOf('run.rejected').map((frame) => frame.code), ['CANCELLED']);
  assert.equal(harness.pending.length, 0);
  assert.equal(harness.executor.activeRunCount(), 0);
});

test('workspace frames answer with identity and read-only state only for confined folders', async () => {
  const harness = createHarness();
  await harness.executor.handleFrame({ type: 'workspace.verify', requestId: 'v1', path: PROJECT });
  assert.deepEqual(harness.framesOf('workspace.result')[0], { type: 'workspace.result', requestId: 'v1', ok: true, reason: null, path: PROJECT, rootCommits: ['a'.repeat(40)] });

  await harness.executor.handleFrame({ type: 'workspace.inspect', requestId: 'i1', path: PROJECT });
  await harness.executor.handleFrame({ type: 'workspace.inspect', requestId: 'i2', path: '/etc' });
  assert.deepEqual(harness.framesOf('workspace.state').map((frame) => [frame.requestId, frame.ok, frame.reason]), [
    ['i1', true, null],
    ['i2', false, 'folder_not_found'],
  ]);
});
