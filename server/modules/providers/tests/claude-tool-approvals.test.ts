import assert from 'node:assert/strict';
import test from 'node:test';

import { claudeRuntime } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import {
  buildExpiredApprovalMessage,
  claudeToolApprovals,
  createToolApprovalRegistry,
  TOOL_APPROVAL_TIMEOUT_MS,
} from '@/modules/providers/list/claude/claude-tool-approvals.provider.js';

const bashInput = { command: 'npm test', description: 'Run tests' };

test('an answered approval settles exactly once and rejects every later answer', async () => {
  const registry = createToolApprovalRegistry();
  const { request, result } = registry.open({ sessionId: 'session-1', toolName: 'Bash', input: bashInput, timeoutMs: 60_000 });

  assert.equal(registry.listPending('session-1').length, 1);
  assert.ok(request.expiresAt, 'non-interactive approvals carry an expiry');

  assert.deepEqual(registry.resolve(request.requestId, { allow: true }, { sessionId: 'session-1' }), { status: 'accepted' });
  assert.deepEqual(await result, { outcome: 'answered', decision: { allow: true } });

  assert.deepEqual(registry.listPending('session-1'), []);
  assert.deepEqual(
    registry.resolve(request.requestId, { allow: false }, { sessionId: 'session-1' }),
    { status: 'rejected', reason: 'already_answered' },
  );
  const [outcome] = registry.listRecentOutcomes('session-1');
  assert.equal(outcome.outcome, 'answered');
  assert.equal('input' in outcome, false);
});

test('an unanswered approval expires, reports it, and rejects a late answer', async () => {
  const registry = createToolApprovalRegistry();
  const settledWithoutAnswer: string[] = [];
  const { request, result } = registry.open({
    sessionId: 'session-1',
    toolName: 'Edit',
    input: { file_path: 'a.ts' },
    timeoutMs: 15,
    onSettledWithoutAnswer: (outcome, settledRequest) => settledWithoutAnswer.push(`${outcome}:${settledRequest.requestId}`),
  });

  assert.deepEqual(await result, { outcome: 'expired' });
  assert.deepEqual(settledWithoutAnswer, [`expired:${request.requestId}`]);
  assert.deepEqual(registry.listPending('session-1'), []);
  assert.deepEqual(
    registry.resolve(request.requestId, { allow: true }, { sessionId: 'session-1' }),
    { status: 'rejected', reason: 'expired' },
  );
  const [outcome] = registry.listRecentOutcomes('session-1');
  assert.equal(outcome.outcome, 'expired');
  assert.deepEqual(outcome.input, { file_path: 'a.ts' }, 'expired requests keep their input so they can be re-surfaced');
});

test('an answer scoped to another session is rejected without settling or revealing the request', async () => {
  const registry = createToolApprovalRegistry();
  const { request, result } = registry.open({ sessionId: 'work-session', toolName: 'Bash', input: bashInput, timeoutMs: 60_000 });

  assert.deepEqual(
    registry.resolve(request.requestId, { allow: true }, { sessionId: 'personal-session' }),
    { status: 'rejected', reason: 'session_mismatch' },
  );
  assert.equal(registry.listPending('work-session').length, 1, 'the request is still pending');
  assert.deepEqual(registry.listPending('personal-session'), []);

  assert.deepEqual(registry.resolve(request.requestId, { allow: false }, { sessionId: 'work-session' }), { status: 'accepted' });
  assert.equal((await result).outcome, 'answered');
  assert.deepEqual(
    registry.resolve(request.requestId, { allow: true }, { sessionId: 'personal-session' }),
    { status: 'rejected', reason: 'session_mismatch' },
  );
  assert.deepEqual(registry.listRecentOutcomes('personal-session'), []);
});

test('an SDK abort cancels the approval, including one aborted before it opened', async () => {
  const registry = createToolApprovalRegistry();
  const controller = new AbortController();
  const settledWithoutAnswer: string[] = [];
  const { request, result } = registry.open({
    sessionId: 'session-1',
    toolName: 'Bash',
    input: bashInput,
    timeoutMs: 60_000,
    signal: controller.signal,
    onSettledWithoutAnswer: (outcome) => settledWithoutAnswer.push(outcome),
  });

  controller.abort();
  assert.deepEqual(await result, { outcome: 'cancelled' });
  assert.deepEqual(settledWithoutAnswer, ['cancelled']);
  assert.deepEqual(registry.resolve(request.requestId, { allow: true }), { status: 'rejected', reason: 'cancelled' });

  const alreadyAborted = registry.open({
    sessionId: 'session-1',
    toolName: 'Bash',
    input: bashInput,
    timeoutMs: 60_000,
    signal: controller.signal,
  });
  assert.deepEqual(await alreadyAborted.result, { outcome: 'cancelled' });
  assert.deepEqual(registry.listPending('session-1'), []);
});

test('interactive approvals (timeoutMs 0) never expire', async () => {
  const registry = createToolApprovalRegistry();
  const { request, result } = registry.open({ sessionId: 'session-1', toolName: 'AskUserQuestion', input: { questions: [] }, timeoutMs: 0 });

  assert.equal(request.expiresAt, null);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(registry.listPending('session-1').length, 1);

  const answers = { 'Pick one?': 'A' };
  registry.resolve(request.requestId, { allow: true, updatedInput: { answers } }, { sessionId: 'session-1' });
  assert.deepEqual(await result, { outcome: 'answered', decision: { allow: true, updatedInput: { answers } } });
});

test('HC-02: an AskUserQuestion approval carries the SDK tool_use id through to the pending request', async () => {
  const registry = createToolApprovalRegistry();
  const { request } = registry.open({
    sessionId: 'session-1',
    toolName: 'AskUserQuestion',
    input: { questions: [] },
    toolId: 'toolu_017LjwFgSawE4s45D3ZSRYb5',
    timeoutMs: 0,
  });

  assert.equal(request.toolId, 'toolu_017LjwFgSawE4s45D3ZSRYb5');
  assert.equal(registry.listPending('session-1')[0]?.toolId, 'toolu_017LjwFgSawE4s45D3ZSRYb5');

  // The CLI's own transcript never carries the answer on the tool_use's
  // input (verified against a real transcript: it stays exactly what the
  // model sent), so this id is the only way the app can later patch the
  // right row with the real answer instead of leaving it to read as
  // "Skipped". A caller that never supplies one (every non-interactive tool
  // today) must not see a stray field appear.
  const { request: withoutToolId } = registry.open({
    sessionId: 'session-1',
    toolName: 'Bash',
    input: bashInput,
    timeoutMs: 60_000,
  });
  assert.equal('toolId' in withoutToolId, false);
});

test('unknown request ids are rejected as not_found', () => {
  const registry = createToolApprovalRegistry();
  assert.deepEqual(registry.resolve('missing', { allow: true }), { status: 'rejected', reason: 'not_found' });
});

test('settled outcomes are forgotten after the retention window', () => {
  let nowMs = Date.parse('2026-09-11T10:00:00.000Z');
  const registry = createToolApprovalRegistry({ now: () => nowMs });
  const { request } = registry.open({ sessionId: 'session-1', toolName: 'Bash', input: bashInput, timeoutMs: 60_000 });
  registry.resolve(request.requestId, { allow: true });

  nowMs += 29 * 60 * 1000;
  assert.equal(registry.listRecentOutcomes('session-1').length, 1);

  nowMs += 2 * 60 * 1000;
  assert.deepEqual(registry.listRecentOutcomes('session-1'), []);
  assert.deepEqual(registry.resolve(request.requestId, { allow: true }), { status: 'rejected', reason: 'not_found' });
});

test('the expired tool result says it expired, is not a denial, and must not be retried blindly', () => {
  const message = buildExpiredApprovalMessage(15 * 60 * 1000);
  assert.match(message, /^Permission request expired: nobody answered within 15 minutes/);
  assert.match(message, /did not deny/);
  assert.match(message, /Do not retry/);
  assert.match(buildExpiredApprovalMessage(20_000), /within 20 seconds/);
});

test('the approval window defaults to 15 minutes', () => {
  if (process.env.CLAUDE_TOOL_APPROVAL_TIMEOUT_MS) {
    return;
  }
  assert.equal(TOOL_APPROVAL_TIMEOUT_MS, 15 * 60 * 1000);
});

test('the Claude runtime permission gateway reads and settles the shared registry', async () => {
  const { request, result } = claudeToolApprovals.open({
    sessionId: 'gateway-session',
    toolName: 'Read',
    input: { file_path: '/etc/hosts' },
    timeoutMs: 60_000,
  });

  assert.deepEqual(
    claudeRuntime.permissions.listPending('gateway-session').map((pending: { requestId: string }) => pending.requestId),
    [request.requestId],
  );
  assert.deepEqual(
    claudeRuntime.permissions.resolve(request.requestId, { allow: true }, { sessionId: 'gateway-session' }),
    { status: 'accepted' },
  );
  assert.equal((await result).outcome, 'answered');
  assert.equal(claudeRuntime.permissions.listRecentOutcomes('gateway-session')[0]?.outcome, 'answered');
});
