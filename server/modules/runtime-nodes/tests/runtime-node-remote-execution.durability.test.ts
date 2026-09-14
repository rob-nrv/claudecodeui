// FT-M09-R1: the control plane's side of a remote run across link loss, over a
// fake link. Short reconnects resume the same run with each event exactly once;
// long disconnects and node restarts fail explicitly; nothing is ever
// re-dispatched or sent to another node.
import assert from 'node:assert/strict';
import test from 'node:test';

import type { RuntimeNodeLinkService } from '@/modules/runtime-nodes/runtime-node-link.service.js';
import { createRuntimeNodeRemoteExecutionService } from '@/modules/runtime-nodes/runtime-node-remote-execution.service.js';

type Resume = Array<{ executionId: string; accepted: boolean; lastSeq: number }>;

function createFakeLink() {
  const frameListeners: Array<(nodeId: string, frame: Record<string, unknown>) => void> = [];
  const closeListeners: Array<(nodeId: string, info: { staleForMs: number }) => void> = [];
  let resumeResolver: (nodeId: string, active: Array<{ executionId: string; lastSeq: number }>) => Resume = () => [];
  const usable = new Set(['pixel-node', 'nas-node']);
  const sent: Array<{ nodeId: string; frame: Record<string, unknown> }> = [];
  const link = {
    onNodeFrame: (listener: (nodeId: string, frame: Record<string, unknown>) => void) => frameListeners.push(listener),
    onLinkClosed: (listener: (nodeId: string, info: { staleForMs: number }) => void) => closeListeners.push(listener),
    setResumeResolver: (resolver: typeof resumeResolver) => {
      resumeResolver = resolver;
    },
    isUsable: (nodeId: string) => usable.has(nodeId),
    send: (nodeId: string, frame: Record<string, unknown>) => {
      if (!usable.has(nodeId)) return false;
      sent.push({ nodeId, frame });
      return true;
    },
    request: async () => {
      throw new Error('not used');
    },
  } as unknown as RuntimeNodeLinkService;
  return {
    link,
    sent,
    frame: (nodeId: string, frame: Record<string, unknown>) => frameListeners.forEach((listener) => listener(nodeId, frame)),
    // A clean, immediately-noticed close (revocation, explicit disconnect,
    // or the sweep of a link that was already known silent): no staleness
    // beyond what the caller measured.
    drop: (nodeId: string, staleForMs = 0) => {
      usable.delete(nodeId);
      closeListeners.forEach((listener) => listener(nodeId, { staleForMs }));
    },
    reconnect: (nodeId: string, active: Array<{ executionId: string; lastSeq: number }>) => {
      usable.add(nodeId);
      return resumeResolver(nodeId, active);
    },
    /**
     * The real link service's other shape of loss (HC-06 repair): the old
     * link was never cleanly closed — it was silently dead (a half-open
     * socket, e.g. an Android radio that vanished without a FIN) — and is
     * only discovered because a fresh connection from the same node just
     * replaced it. `staleForMs` is how long that old link had already been
     * silent, exactly as `runtime-node-link.service.ts` computes it from the
     * superseded link's last frame.
     */
    reconnectAfterSupersede: (nodeId: string, active: Array<{ executionId: string; lastSeq: number }>, staleForMs: number) => {
      usable.add(nodeId);
      closeListeners.forEach((listener) => listener(nodeId, { staleForMs }));
      return resumeResolver(nodeId, active);
    },
    setUsable: (nodeId: string, value: boolean) => (value ? usable.add(nodeId) : usable.delete(nodeId)),
  };
}

function createWriter() {
  const messages: Array<Record<string, unknown>> = [];
  return { messages, writer: { send: (message: unknown) => messages.push(message as Record<string, unknown>), setSessionId: () => undefined } as never };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function startRun(fake: ReturnType<typeof createFakeLink>, service: ReturnType<typeof createRuntimeNodeRemoteExecutionService>, nodeId = 'pixel-node') {
  const output = createWriter();
  const result = service.run({
    nodeId,
    nodeLabel: nodeId === 'pixel-node' ? 'Pixel' : 'NAS',
    appSessionId: 'session-1',
    projectId: 'project-1',
    providerSessionId: null,
    command: 'long task',
    cwd: '/root/ws/app',
    options: {},
    writer: output.writer,
    userId: null,
  });
  const dispatched = fake.sent.filter((entry) => entry.frame.type === 'run.start');
  const executionId = dispatched.at(-1)?.frame.executionId as string | undefined;
  return { result, output, executionId };
}

test('a short link loss resumes the same run: no re-dispatch, every event exactly once, late duplicates dropped', async () => {
  const fake = createFakeLink();
  const service = createRuntimeNodeRemoteExecutionService({ link: fake.link, reconnectGraceMs: 500, ackTimeoutMs: 1_000 });
  const { result, output, executionId } = startRun(fake, service);
  assert.ok(executionId);

  fake.frame('pixel-node', { type: 'run.accepted', executionId });
  fake.frame('pixel-node', { type: 'run.event', executionId, seq: 1, message: { kind: 'text', content: 'one' } });
  fake.frame('pixel-node', { type: 'run.event', executionId, seq: 2, message: { kind: 'text', content: 'two' } });

  fake.drop('pixel-node');
  await sleep(50);
  assert.deepEqual(fake.reconnect('pixel-node', [{ executionId, lastSeq: 3 }]), [{ executionId, accepted: true, lastSeq: 2 }]);
  // The node replays from what the control plane last saw; an already-seen seq is dropped.
  fake.frame('pixel-node', { type: 'run.event', executionId, seq: 2, message: { kind: 'text', content: 'two' } });
  fake.frame('pixel-node', { type: 'run.event', executionId, seq: 3, message: { kind: 'text', content: 'three' } });
  fake.frame('pixel-node', { type: 'run.finished', executionId, seq: 4, outcome: 'completed' });

  assert.deepEqual(await result, { outcome: 'completed', code: null });
  assert.deepEqual(output.messages.map((message) => message.content), ['one', 'two', 'three']);
  assert.equal(fake.sent.filter((entry) => entry.frame.type === 'run.start').length, 1, 'never re-dispatched');
  assert.equal(service.hasActiveRun('session-1'), false);
});

test('a link loss longer than the grace fails the run explicitly, and a late node answer changes nothing', async () => {
  const fake = createFakeLink();
  const service = createRuntimeNodeRemoteExecutionService({ link: fake.link, reconnectGraceMs: 40, ackTimeoutMs: 1_000 });
  const { result, output, executionId } = startRun(fake, service);
  fake.frame('pixel-node', { type: 'run.accepted', executionId });

  fake.drop('pixel-node');
  assert.deepEqual(await result, { outcome: 'failed', code: 'RUNTIME_NODE_DISCONNECTED' });
  assert.match(String(output.messages.at(-1)?.content), /not moved to another node/);

  assert.deepEqual(fake.reconnect('pixel-node', [{ executionId: executionId as string, lastSeq: 5 }]), [{ executionId, accepted: false, lastSeq: 0 }], 'the node is told to stop it');
  fake.frame('pixel-node', { type: 'run.finished', executionId, seq: 6, outcome: 'completed' });
  assert.equal(output.messages.filter((message) => message.kind === 'complete').length, 0);
  assert.equal(fake.sent.some((entry) => entry.nodeId === 'nas-node'), false, 'no failover');
});

test('a node that comes back without the run (restarted) fails it at once instead of waiting out the grace', async () => {
  const fake = createFakeLink();
  const service = createRuntimeNodeRemoteExecutionService({ link: fake.link, reconnectGraceMs: 60_000, ackTimeoutMs: 1_000 });
  const { result, output, executionId } = startRun(fake, service);
  fake.frame('pixel-node', { type: 'run.accepted', executionId });

  fake.drop('pixel-node');
  fake.reconnect('pixel-node', []);
  assert.deepEqual(await result, { outcome: 'failed', code: 'RUNTIME_NODE_RESTARTED' });
  assert.match(String(output.messages.at(-1)?.content), /restarted and no longer has this run/);
  assert.equal(fake.sent.filter((entry) => entry.frame.type === 'run.start').length, 1);
});

test('an offline node and a governor refusal both end the run explicitly, with nothing sent anywhere else', async () => {
  const fake = createFakeLink();
  const service = createRuntimeNodeRemoteExecutionService({ link: fake.link, reconnectGraceMs: 60_000, ackTimeoutMs: 1_000 });

  fake.setUsable('pixel-node', false);
  const offline = startRun(fake, service);
  assert.deepEqual(await offline.result, { outcome: 'rejected', code: 'RUNTIME_NODE_OFFLINE' });
  assert.equal(fake.sent.length, 0);

  fake.setUsable('pixel-node', true);
  const refused = startRun(fake, service);
  fake.frame('pixel-node', { type: 'run.rejected', executionId: refused.executionId, code: 'RESOURCE_CONCURRENCY_LIMIT' });
  assert.deepEqual(await refused.result, { outcome: 'rejected', code: 'RESOURCE_CONCURRENCY_LIMIT' });
  assert.match(String(refused.output.messages.at(-1)?.content), /not moved to another node/);
  assert.deepEqual(fake.sent.map((entry) => [entry.nodeId, entry.frame.type]), [['pixel-node', 'run.start']]);
});

test('frames from another node, or with an unknown execution id, never touch a run', async () => {
  const fake = createFakeLink();
  const service = createRuntimeNodeRemoteExecutionService({ link: fake.link, reconnectGraceMs: 60_000, ackTimeoutMs: 1_000 });
  const { result, output, executionId } = startRun(fake, service);
  fake.frame('pixel-node', { type: 'run.accepted', executionId });

  fake.frame('nas-node', { type: 'run.event', executionId, seq: 1, message: { kind: 'text', content: 'forged' } });
  fake.frame('nas-node', { type: 'run.finished', executionId, seq: 2, outcome: 'completed' });
  fake.frame('pixel-node', { type: 'run.finished', executionId: '00000000-0000-0000-0000-000000000000', seq: 1, outcome: 'completed' });
  assert.equal(service.hasActiveRun('session-1'), true);
  assert.deepEqual(output.messages, []);

  fake.frame('pixel-node', { type: 'run.finished', executionId, seq: 1, outcome: 'completed' });
  assert.deepEqual(await result, { outcome: 'completed', code: null });
});

test('a new link that supersedes a half-open one, from a node that no longer has the run, fails it at once (no phantom running)', async () => {
  const fake = createFakeLink();
  const service = createRuntimeNodeRemoteExecutionService({ link: fake.link, reconnectGraceMs: 60_000, ackTimeoutMs: 60_000 });
  const running = startRun(fake, service);
  fake.frame('pixel-node', { type: 'run.accepted', executionId: running.executionId });

  // No close event: the old socket was half-open and the new connection replaced it.
  fake.reconnect('pixel-node', []);
  const outcome = await Promise.race([running.result, sleep(200).then(() => 'still running')]);
  assert.deepEqual(outcome, { outcome: 'failed', code: 'RUNTIME_NODE_RESTARTED' });
  assert.equal(service.hasActiveRun('session-1'), false);
});

test('a dispatch lost on a superseded link fails explicitly instead of waiting for an acknowledgement forever', async () => {
  const fake = createFakeLink();
  const service = createRuntimeNodeRemoteExecutionService({ link: fake.link, reconnectGraceMs: 60_000, ackTimeoutMs: 60_000 });
  const dispatching = startRun(fake, service);

  fake.reconnect('pixel-node', []);
  const outcome = await Promise.race([dispatching.result, sleep(200).then(() => 'still dispatching')]);
  assert.deepEqual(outcome, { outcome: 'failed', code: 'RUNTIME_NODE_RESTARTED' });
  assert.equal(fake.sent.filter((entry) => entry.frame.type === 'run.start').length, 1, 'never re-dispatched');
});

test('a reconnecting node that reports the run keeps it, whatever state the control plane thought it was in', async () => {
  const fake = createFakeLink();
  const service = createRuntimeNodeRemoteExecutionService({ link: fake.link, reconnectGraceMs: 60_000, ackTimeoutMs: 60_000 });
  const run = startRun(fake, service);
  assert.deepEqual(fake.reconnect('pixel-node', [{ executionId: run.executionId as string, lastSeq: 0 }]), [{ executionId: run.executionId, accepted: true, lastSeq: 0 }]);
  fake.frame('pixel-node', { type: 'run.accepted', executionId: run.executionId });
  fake.frame('pixel-node', { type: 'run.finished', executionId: run.executionId, seq: 1, outcome: 'completed' });
  assert.deepEqual(await run.result, { outcome: 'completed', code: null });
});

// HC-06 repair: a real mobile network blip (e.g. airplane mode) does not
// make the node's socket send a clean close — the radio just vanishes. The
// control plane never sees `onLinkClosed` until the node's own fresh
// reconnect attempt supersedes the half-open link, so without a staleness
// check at that exact moment, a resume was accepted no matter how long the
// node had actually been gone (see the "no close event" test above, which
// already covers a node that no longer reports the run at all). These tests
// cover the run still being reported as active on that late reconnect.
test('a supersede-style reconnect (no close event) within the grace budget resumes the same run', async () => {
  const fake = createFakeLink();
  const service = createRuntimeNodeRemoteExecutionService({ link: fake.link, reconnectGraceMs: 500, reconnectStalenessMarginMs: 0, ackTimeoutMs: 1_000 });
  const { result, output, executionId } = startRun(fake, service);
  fake.frame('pixel-node', { type: 'run.accepted', executionId });
  fake.frame('pixel-node', { type: 'run.event', executionId, seq: 1, message: { kind: 'text', content: 'before the blip' } });

  // The old link is still registered (no drop()); the node's own radio
  // recovered and a fresh connection reports the run as still active.
  assert.deepEqual(
    fake.reconnectAfterSupersede('pixel-node', [{ executionId: executionId as string, lastSeq: 1 }], 200),
    [{ executionId, accepted: true, lastSeq: 1 }],
    'well within the grace budget: resumed, not refused',
  );
  fake.frame('pixel-node', { type: 'run.event', executionId, seq: 2, message: { kind: 'text', content: 'after resume' } });
  fake.frame('pixel-node', { type: 'run.finished', executionId, seq: 3, outcome: 'completed' });

  assert.deepEqual(await result, { outcome: 'completed', code: null });
  assert.deepEqual(output.messages.map((message) => message.content), ['before the blip', 'after resume']);
});

test('a supersede-style reconnect whose real gap exceeds the grace budget fails explicitly instead of silently resuming', async () => {
  const fake = createFakeLink();
  const service = createRuntimeNodeRemoteExecutionService({ link: fake.link, reconnectGraceMs: 500, reconnectStalenessMarginMs: 0, ackTimeoutMs: 1_000 });
  const { result, output, executionId } = startRun(fake, service);
  fake.frame('pixel-node', { type: 'run.accepted', executionId });

  // The node still claims the run is active, but the real gap since its
  // last frame is well past the grace budget: trusting it would silently
  // resume a run the control plane should have already given up on.
  assert.deepEqual(
    fake.reconnectAfterSupersede('pixel-node', [{ executionId: executionId as string, lastSeq: 1 }], 5_000),
    [{ executionId, accepted: false, lastSeq: 0 }],
    'too stale to trust: refused immediately, no timer to wait out',
  );
  assert.deepEqual(await result, { outcome: 'failed', code: 'RUNTIME_NODE_DISCONNECTED' });
  assert.match(String(output.messages.at(-1)?.content), /not moved to another node/);

  // Whatever the node produced while it thought it was still running (which
  // may include the native SDK's own tool-denial wording for an interrupted
  // tool_use — see claude-tool-approvals.provider.ts) must never surface as
  // if it were part of this already-failed run.
  const before = output.messages.length;
  fake.frame('pixel-node', { type: 'run.event', executionId, seq: 2, message: { kind: 'tool_result', isError: true, content: "The user doesn't want to proceed with this tool use." } });
  fake.frame('pixel-node', { type: 'run.finished', executionId, seq: 3, outcome: 'aborted' });
  assert.equal(output.messages.length, before, 'nothing from the disowned run reaches the browser');
});

test('the heartbeat-staleness margin is exact: a reconnect just inside it resumes, just outside it fails', async () => {
  const fake = createFakeLink();
  const service = createRuntimeNodeRemoteExecutionService({ link: fake.link, reconnectGraceMs: 1_000, reconnectStalenessMarginMs: 200, ackTimeoutMs: 2_000 });

  const inBudget = startRun(fake, service);
  fake.frame('pixel-node', { type: 'run.accepted', executionId: inBudget.executionId });
  assert.deepEqual(
    fake.reconnectAfterSupersede('pixel-node', [{ executionId: inBudget.executionId as string, lastSeq: 0 }], 1_199),
    [{ executionId: inBudget.executionId, accepted: true, lastSeq: 0 }],
    '1_000 + 200 margin, minus one: still trusted',
  );
  fake.frame('pixel-node', { type: 'run.finished', executionId: inBudget.executionId, seq: 1, outcome: 'completed' });
  assert.deepEqual(await inBudget.result, { outcome: 'completed', code: null });

  fake.setUsable('pixel-node', true);
  const overBudget = startRun(fake, service);
  fake.frame('pixel-node', { type: 'run.accepted', executionId: overBudget.executionId });
  assert.deepEqual(
    fake.reconnectAfterSupersede('pixel-node', [{ executionId: overBudget.executionId as string, lastSeq: 0 }], 1_201),
    [{ executionId: overBudget.executionId, accepted: false, lastSeq: 0 }],
    'one past the same budget: refused',
  );
  assert.deepEqual(await overBudget.result, { outcome: 'failed', code: 'RUNTIME_NODE_DISCONNECTED' });
});

test('a superseded link that is not stale still lets a run the node no longer reports fail as restarted, not disconnected', async () => {
  const fake = createFakeLink();
  const service = createRuntimeNodeRemoteExecutionService({ link: fake.link, reconnectGraceMs: 500, reconnectStalenessMarginMs: 0, ackTimeoutMs: 1_000 });
  const { result, executionId } = startRun(fake, service);
  fake.frame('pixel-node', { type: 'run.accepted', executionId });

  // Fast, healthy reconnect (well within budget) — but the node's hello
  // simply does not list this run any more (e.g. it restarted).
  assert.deepEqual(fake.reconnectAfterSupersede('pixel-node', [], 10), [], 'nothing to resume');
  assert.deepEqual(await result, { outcome: 'failed', code: 'RUNTIME_NODE_RESTARTED' });
});
