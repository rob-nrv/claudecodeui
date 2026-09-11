import assert from 'node:assert/strict';
import test from 'node:test';

import type { NormalizedMessage } from './useSessionStore';
import { applyToolUseInputPatch, dedupeIncomingRealtimeMessages } from './sessionRealtimeMerge';

const toolUseMessage = (overrides: Partial<NormalizedMessage> = {}): NormalizedMessage => ({
  id: 'msg-1',
  sessionId: 'session-1',
  timestamp: '2026-01-01T00:00:00.000Z',
  provider: 'claude',
  kind: 'tool_use',
  toolName: 'AskUserQuestion',
  toolId: 'toolu_1',
  toolInput: { questions: [{ question: 'Pick one', options: [] }] },
  ...overrides,
});

test('HC-02 AskUserQuestion: a resolved answer patches the matching tool_use row instead of leaving it unanswered', () => {
  const messages = [toolUseMessage()];

  const patched = applyToolUseInputPatch(messages, 'toolu_1', {
    questions: [{ question: 'Pick one', options: [] }],
    answers: { 'Pick one': 'Option A' },
  });

  assert.notStrictEqual(patched, messages, 'a real match must produce a new array (store change detection relies on this)');
  assert.deepEqual((patched[0].toolInput as { answers?: Record<string, string> }).answers, { 'Pick one': 'Option A' });
  // The original array is untouched — callers that still hold a reference to
  // it (e.g. a concurrent render) never see a half-applied patch.
  assert.deepEqual((messages[0].toolInput as { answers?: Record<string, string> }).answers, undefined);
});

test('applyToolUseInputPatch is a no-op (same reference) when no row matches the toolId', () => {
  const messages = [toolUseMessage({ toolId: 'toolu_other' })];
  const patched = applyToolUseInputPatch(messages, 'toolu_1', { answers: { q: 'a' } });
  assert.strictEqual(patched, messages);
});

test('HC-02 Bash x2: a replayed tool_use with an id already in the store is dropped, not duplicated', () => {
  const existing = [toolUseMessage({ id: 'msg-1', toolId: 'toolu_expire' })];
  // A reconnect that resubscribes with a stale lastSeq replays the exact same
  // buffered event (same id) the store already appended.
  const replayed = [toolUseMessage({ id: 'msg-1', toolId: 'toolu_expire' })];

  const deduped = dedupeIncomingRealtimeMessages(existing, replayed);

  assert.equal(deduped.length, 0, 'a message id already present must never be appended again');
});

test('dedupeIncomingRealtimeMessages keeps genuinely new messages and drops internal duplicates within one batch', () => {
  const existing = [toolUseMessage({ id: 'msg-1' })];
  const incoming = [
    toolUseMessage({ id: 'msg-1' }), // already known
    toolUseMessage({ id: 'msg-2', toolId: 'toolu_2' }), // new
    toolUseMessage({ id: 'msg-2', toolId: 'toolu_2' }), // duplicate within the same batch
  ];

  const deduped = dedupeIncomingRealtimeMessages(existing, incoming);

  assert.deepEqual(deduped.map((m) => m.id), ['msg-2']);
});
