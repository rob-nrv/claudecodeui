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
  const closeListeners: Array<(nodeId: string) => void> = [];
  let resumeResolver: (nodeId: string, active: Array<{ executionId: string; lastSeq: number }>) => Resume = () => [];
  const usable = new Set(['pixel-node', 'nas-node']);
  const sent: Array<{ nodeId: string; frame: Record<string, unknown> }> = [];
  const link = {
    onNodeFrame: (listener: (nodeId: string, frame: Record<string, unknown>) => void) => frameListeners.push(listener),
    onLinkClosed: (listener: (nodeId: string) => void) => closeListeners.push(listener),
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
    drop: (nodeId: string) => {
      usable.delete(nodeId);
      closeListeners.forEach((listener) => listener(nodeId));
    },
    reconnect: (nodeId: string, active: Array<{ executionId: string; lastSeq: number }>) => {
      usable.add(nodeId);
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
