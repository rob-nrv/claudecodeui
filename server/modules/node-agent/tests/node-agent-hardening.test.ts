// FT-M09-R1 hardening of the node agent's highest-risk paths: admission races,
// slot release on every outcome, governor boundaries, journal durability under
// concurrent writes and damaged files, and evidence windows. Recording runtimes
// only; no provider is ever called.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createNodeAgentExecutor, type NodeExecutorRuntime } from '@/modules/node-agent/node-agent-executor.service.js';
import {
  createNodeResourceGovernor,
  evaluateResourceAdmission,
  type NodeResourceSignals,
  type ResourceGovernorPolicy,
} from '@/modules/node-agent/node-agent-resource-governor.js';
import { createNodeAgentRunJournal, readNodeAgentRunJournalSummary } from '@/modules/node-agent/node-agent-run-journal.js';
import { probeLocalRuntimeCapabilities } from '@/modules/runtime-nodes/index.js';

const PROJECT = '/srv/workspaces/app';
const MB = 1024 * 1024;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const UNKNOWN_SIGNALS: NodeResourceSignals = {
  storage: { state: 'unknown', reason: 'storage_unreadable' },
  battery: { state: 'unknown', reason: 'battery_unreadable' },
  thermal: { state: 'unknown', reason: 'no_portable_source' },
};

type RunControl = { sessionId: string; finish(): void; fail(error: Error): void };

function createHarness(options: { maxConcurrentRuns?: number; readSignals?: () => Promise<NodeResourceSignals> } = {}) {
  const sent: Array<Record<string, unknown>> = [];
  const runs: RunControl[] = [];
  const aborted: string[] = [];
  const runtime: NodeExecutorRuntime = {
    run(_provider, _command, runOptions) {
      return new Promise<void>((resolve, reject) => {
        runs.push({ sessionId: String(runOptions.sessionId), finish: resolve, fail: reject });
      });
    },
    async abort(_provider, sessionId) {
      aborted.push(sessionId);
      runs.find((run) => run.sessionId === sessionId)?.finish();
      return true;
    },
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
    resolveWorkspace: async () => ({ ok: true, path: PROJECT }),
    governor: createNodeResourceGovernor({
      policy: { maxConcurrentRuns: options.maxConcurrentRuns ?? 1, minFreeStorageBytes: 512 * MB, minBatteryPercent: 20 },
      readSignals: options.readSignals ?? (async () => UNKNOWN_SIGNALS),
    }),
  });
  const start = (appSessionId: string) => {
    const executionId = randomUUID();
    return {
      executionId,
      handled: executor.handleFrame({ type: 'run.start', executionId, appSessionId, provider: 'claude', providerSessionId: null, command: 'go', cwd: PROJECT, options: {} }),
    };
  };
  const framesOf = (type: string) => sent.filter((frame) => frame.type === type);
  return { executor, sent, runs, aborted, start, framesOf };
}

test('two starts racing for the last slot: exactly one is admitted, the other is refused explicitly', async () => {
  const harness = createHarness({ maxConcurrentRuns: 1 });
  // Both dispatched before either awaits; the first one's handler only settles when its run ends.
  harness.start('session-a');
  const second = harness.start('session-b');
  await second.handled;
  await tick();
  await tick();
  assert.equal(harness.framesOf('run.accepted').length, 1);
  assert.deepEqual(harness.framesOf('run.rejected').map((frame) => frame.code), ['RESOURCE_CONCURRENCY_LIMIT']);
  assert.equal(harness.runs.length, 1);
});

test('the concurrency slot is released after success, after a runtime failure and after an abort', async () => {
  const harness = createHarness({ maxConcurrentRuns: 1 });

  harness.start('session-a');
  await tick();
  harness.runs[0].finish();
  await tick();
  assert.equal(harness.executor.activeRunCount(), 0, 'released after success');

  harness.start('session-b');
  await tick();
  harness.runs[1].fail(new Error('provider crashed'));
  await tick();
  await tick();
  assert.equal(harness.executor.activeRunCount(), 0, 'released after failure');
  assert.equal(harness.framesOf('run.finished').at(-1)?.outcome, 'failed');

  const third = harness.start('session-c');
  await tick();
  await harness.executor.handleFrame({ type: 'run.cancel', executionId: third.executionId });
  await tick();
  assert.equal(harness.executor.activeRunCount(), 0, 'released after abort');
  assert.equal(harness.framesOf('run.finished').at(-1)?.outcome, 'aborted');

  harness.start('session-d');
  await tick();
  assert.equal(harness.runs.length, 4, 'a new run is admitted after each release');
  assert.equal(harness.framesOf('run.rejected').length, 0);
});

test('a governor that cannot read its signals admits the run: unknown never blocks', async () => {
  const harness = createHarness({
    maxConcurrentRuns: 2,
    readSignals: async () => {
      throw new Error('statfs exploded');
    },
  });
  harness.start('session-a');
  await tick();
  await tick();
  assert.equal(harness.runs.length, 1);
});

test('governor boundaries: the floors are strict, charging state unknown is not treated as charging', () => {
  const policy: ResourceGovernorPolicy = { maxConcurrentRuns: 2, minFreeStorageBytes: 512 * MB, minBatteryPercent: 20 };
  const signals = (storage: number | null, battery: { percent: number; charging: boolean | null } | null): NodeResourceSignals => ({
    storage: storage === null ? { state: 'unknown', reason: 'storage_unreadable' } : { state: 'known', freeBytes: storage },
    battery: battery === null ? { state: 'unknown', reason: 'no_battery_reported' } : { state: 'known', ...battery },
    thermal: { state: 'unknown', reason: 'no_portable_source' },
  });
  const refusal = (activeRuns: number, value: NodeResourceSignals) => evaluateResourceAdmission(policy, activeRuns, value).refusal;

  assert.equal(refusal(1, signals(null, null)), null, 'one slot left');
  assert.equal(refusal(2, signals(null, null)), 'RESOURCE_CONCURRENCY_LIMIT');
  assert.equal(refusal(0, signals(512 * MB, null)), null, 'exactly at the storage floor is allowed');
  assert.equal(refusal(0, signals(512 * MB - 1, null)), 'RESOURCE_STORAGE_LOW');
  assert.equal(refusal(0, signals(null, { percent: 20, charging: false })), null, 'exactly at the battery floor is allowed');
  assert.equal(refusal(0, signals(null, { percent: 19, charging: false })), 'RESOURCE_BATTERY_LOW');
  assert.equal(refusal(0, signals(null, { percent: 19, charging: null })), 'RESOURCE_BATTERY_LOW', 'unknown charging state is not assumed to be charging');
  assert.equal(refusal(0, signals(null, { percent: 1, charging: true })), null);
  assert.equal(refusal(0, signals(null, null)), null, 'a missing battery never blocks');
});

async function withJournalFile(runTest: (file: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'journal-hardening-'));
  try {
    await runTest(path.join(directory, 'run-journal.json'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('journal writes are serialized: interleaved starts and finishes all land, and no temporary file is left behind', async () => {
  await withJournalFile(async (file) => {
    const journal = createNodeAgentRunJournal({ file });
    await journal.load();
    const ids = Array.from({ length: 40 }, () => randomUUID());
    const writes: Promise<void>[] = [];
    ids.forEach((id, index) => {
      writes.push(journal.recordStarted(id, `session-${index}`));
      if (index % 2 === 0) {
        writes.push(journal.recordFinished(id, index % 4 === 0 ? 'completed' : 'failed'));
      }
    });
    await Promise.all(writes);
    await journal.flush();

    const persisted = JSON.parse(await readFile(file, 'utf8')) as { entries: Array<{ executionId: string; outcome: string | null }> };
    assert.deepEqual(persisted.entries.map((entry) => entry.executionId), ids);
    assert.equal(persisted.entries.filter((entry) => entry.outcome === null).length, 20);
    assert.deepEqual((await readdir(path.dirname(file))).filter((name) => name.endsWith('.tmp')), []);
    assert.deepEqual(await readNodeAgentRunJournalSummary(file), { state: 'ok', unfinished: 20, interrupted: 0, lastCompletedAt: journal.lastCompletedAt() });
  });
});

test('a truncated journal is reported unreadable, never half-trusted, and the next write restores a valid file', async () => {
  await withJournalFile(async (file) => {
    const first = createNodeAgentRunJournal({ file });
    await first.load();
    await first.recordStarted(randomUUID(), 'session-a');
    await first.flush();
    const full = await readFile(file, 'utf8');
    await writeFile(file, full.slice(0, Math.floor(full.length / 2)));

    assert.deepEqual(await readNodeAgentRunJournalSummary(file), { state: 'unreadable' });
    const logs: string[] = [];
    const recovered = createNodeAgentRunJournal({ file, log: (message) => logs.push(message) });
    assert.deepEqual((await recovered.load()).interrupted, []);
    assert.ok(logs.some((message) => /unreadable/.test(message)));
    await recovered.recordStarted(randomUUID(), 'session-b');
    await recovered.flush();
    assert.equal((await readNodeAgentRunJournalSummary(file)).state, 'ok');
  });
});

test('damaged journal content never throws: arbitrary bytes and shapes read as unreadable or as the valid entries only', async () => {
  await withJournalFile(async (file) => {
    let seed = 0x5eed;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const validId = randomUUID();
    const shapes: string[] = [
      '',
      'null',
      '[]',
      '{"entries": 7}',
      '{"entries": [null, 1, "x", {"executionId": "../../etc", "appSessionId": "a", "startedAt": 1}]}',
      JSON.stringify({ entries: [{ executionId: validId, appSessionId: 'session-ok', startedAt: 5, finishedAt: null, outcome: 'nonsense' }, { executionId: 'nope' }], lastCompletedAt: 'yesterday' }),
    ];
    for (let index = 0; index < 60; index += 1) {
      shapes.push(Buffer.from(Array.from({ length: Math.floor(random() * 200) }, () => Math.floor(random() * 256))).toString('latin1'));
    }
    for (const content of shapes) {
      await writeFile(file, content, 'latin1');
      const summary = await readNodeAgentRunJournalSummary(file);
      assert.ok(summary.state === 'ok' || summary.state === 'unreadable', JSON.stringify(summary));
      const journal = createNodeAgentRunJournal({ file, log: () => undefined });
      await journal.load();
      for (const entry of journal.entries()) {
        assert.match(entry.executionId, /^[0-9a-f-]{36}$/);
      }
    }
    await writeFile(file, shapes[5]);
    const journal = createNodeAgentRunJournal({ file });
    const { interrupted } = await journal.load();
    assert.deepEqual(interrupted.map((entry) => entry.executionId), [validId], 'only the valid entry survives, and it is marked interrupted');
    assert.equal(journal.lastCompletedAt(), null, 'a malformed timestamp proves no completed run');
  });
});

test('evidence windows: an old suspension no longer disproves background execution, an old run no longer proves headless', async () => {
  const now = Date.UTC(2026, 8, 13, 20);
  const probe = (observations: { lastCompletedRunAt: number | null; suspension: { at: number; durationMs: number } | null }) => probeLocalRuntimeCapabilities({
    runCommand: async () => 'ok',
    resolveClaudeExecutable: () => 'claude-binary',
    checkWorkspaceRoot: async () => undefined,
    environment: {},
    fileExists: async () => false,
    now: () => now,
    observations: {
      startedAt: now - 48 * 3_600_000,
      lastCompletedRunAt: () => observations.lastCompletedRunAt,
      lastSuspension: () => observations.suspension,
    },
  });
  const day = 24 * 3_600_000;

  const recent = await probe({ lastCompletedRunAt: now - day, suspension: { at: now - day, durationMs: 40_000 } });
  assert.equal(recent['claude-headless'].outcome, 'proven', 'exactly at the window edge still counts');
  assert.equal(recent['background-execution'].outcome, 'failed');

  const stale = await probe({ lastCompletedRunAt: now - day - 1, suspension: { at: now - day - 1, durationMs: 40_000 } });
  assert.deepEqual([stale['claude-headless'].outcome, (stale['claude-headless'] as { reason: string }).reason], ['not_probed', 'completed_run_too_old']);
  assert.deepEqual(
    [stale['background-execution'].outcome, (stale['background-execution'] as { reason: string }).reason],
    ['not_probed', 'requires_device_verification'],
    'an expired suspension falls back to "needs a device check", never to proven',
  );

  const future = await probe({ lastCompletedRunAt: now + 60_000, suspension: null });
  assert.equal(future['claude-headless'].outcome, 'not_probed', 'a completion time in the future proves nothing');
});
