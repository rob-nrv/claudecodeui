import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createNodeAgentRunJournal, readNodeAgentRunJournalSummary } from '@/modules/node-agent/node-agent-run-journal.js';
import { createProcessSuspensionMonitor } from '@/modules/node-agent/node-agent-suspension-monitor.js';

async function withStateDir(runTest: (file: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'node-run-journal-'));
  try {
    await runTest(path.join(directory, 'state', 'run-journal.json'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('accepted ids survive a restart; a run that never finished is marked interrupted, never resumed', async () => {
  await withStateDir(async (file) => {
    let clock = 1_000;
    const first = createNodeAgentRunJournal({ file, now: () => clock });
    await first.load();
    const done = randomUUID();
    const inFlight = randomUUID();
    await first.recordStarted(done, 'session-a');
    clock = 2_000;
    await first.recordFinished(done, 'completed');
    await first.recordStarted(inFlight, 'session-b');
    await first.flush();
    // The agent dies here: no finish is ever written for `inFlight`.

    assert.deepEqual(await readNodeAgentRunJournalSummary(file), { unfinished: 1, interrupted: 0, lastCompletedAt: 2_000 }, 'status reads without changing anything');
    assert.deepEqual(await readNodeAgentRunJournalSummary(file), { unfinished: 1, interrupted: 0, lastCompletedAt: 2_000 });

    clock = 5_000;
    const restarted = createNodeAgentRunJournal({ file, now: () => clock });
    const { interrupted } = await restarted.load();
    assert.deepEqual(interrupted.map((entry) => [entry.executionId, entry.outcome, entry.finishedAt]), [[inFlight, 'interrupted', 5_000]]);
    assert.equal(restarted.has(done), true);
    assert.equal(restarted.has(inFlight), true);
    assert.equal(restarted.lastCompletedAt(), 2_000, 'headless evidence comes only from a completed run');
    assert.deepEqual(await readNodeAgentRunJournalSummary(file), { unfinished: 0, interrupted: 1, lastCompletedAt: 2_000 });

    const content = await readFile(file, 'utf8');
    assert.equal(/prompt|command|cwd|token/i.test(content), false, 'only ids, times and outcomes are persisted');
    if (process.platform !== 'win32') {
      assert.equal((await stat(file)).mode & 0o777, 0o600);
      assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700);
    }
  });
});

test('the journal is bounded, tolerates a corrupt file and never throws into a run', async () => {
  await withStateDir(async (file) => {
    const journal = createNodeAgentRunJournal({ file, maxEntries: 3 });
    await journal.load();
    const ids = Array.from({ length: 5 }, () => randomUUID());
    for (const id of ids) {
      await journal.recordStarted(id, 'session');
    }
    assert.deepEqual(journal.entries().map((entry) => entry.executionId), ids.slice(2));

    await writeFile(file, '{ not json');
    const logs: string[] = [];
    const recovered = createNodeAgentRunJournal({ file, log: (message) => logs.push(message) });
    assert.deepEqual((await recovered.load()).interrupted, []);
    assert.ok(logs.some((message) => /unreadable/.test(message)));

    const unwritable = createNodeAgentRunJournal({ file: path.join(file, 'cannot', 'be', 'a', 'child', 'of', 'a', 'file'), log: (message) => logs.push(message) });
    await unwritable.recordStarted(randomUUID(), 'session');
    assert.ok(logs.some((message) => /could not be written/.test(message)));
  });
});

test('a process suspension is recorded only when the process demonstrably did not run', () => {
  let clock = 0;
  const monitor = createProcessSuspensionMonitor({ intervalMs: 5_000, thresholdMs: 30_000, now: () => clock });
  clock = 5_000;
  monitor.tick();
  clock = 12_000;
  monitor.tick();
  assert.equal(monitor.lastSuspension(), null, 'ordinary timer jitter is not a suspension');
  clock = 12_000 + 5_000 + 45_000;
  monitor.tick();
  assert.deepEqual(monitor.lastSuspension(), { at: 62_000, durationMs: 45_000 });
  assert.equal(monitor.startedAt, 0);
});
