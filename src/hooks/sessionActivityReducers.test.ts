import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LOCAL_ACTIVITY_GRACE_MS,
  nextAfterMarkIdle,
  nextAfterMarkProcessing,
  nextAfterSync,
} from './sessionActivityReducers';
import type { SessionActivity } from './useSessionProtection';

const activity = (overrides: Partial<SessionActivity> = {}): SessionActivity => ({
  statusText: null,
  canInterrupt: true,
  startedAt: Date.now(),
  waiting: false,
  claudeProfileId: null,
  ...overrides,
});

test('markSessionProcessing: a fresh session appears Running', () => {
  const prev = new Map<string, SessionActivity>();
  const next = nextAfterMarkProcessing(prev, 'session-1', { canInterrupt: true });

  assert.equal(next.has('session-1'), true);
  assert.equal(next.get('session-1')?.canInterrupt, true);
});

test('markSessionProcessing preserves waiting/claudeProfileId already known for the session', () => {
  const prev = new Map([['session-1', activity({ waiting: true, claudeProfileId: 'profile-work' })]]);
  const next = nextAfterMarkProcessing(prev, 'session-1', { statusText: 'Thinking' });

  assert.equal(next.get('session-1')?.waiting, true);
  assert.equal(next.get('session-1')?.claudeProfileId, 'profile-work');
});

test('markSessionIdle (completion) removes the session — no lingering Running state', () => {
  const prev = new Map([['session-1', activity()]]);
  const next = nextAfterMarkIdle(prev, 'session-1');

  assert.equal(next.has('session-1'), false);
});

test('markSessionIdle ignores a stale idle ack for a request that already restarted', () => {
  const startedAt = 1_000;
  const prev = new Map([['session-1', activity({ startedAt })]]);

  // The subscribe that produced this idle ack was sent before the newer
  // request started, so it must not clear the newer run.
  const next = nextAfterMarkIdle(prev, 'session-1', { ifStartedBefore: startedAt });

  assert.equal(next.has('session-1'), true);
});

test('Stop: markSessionIdle after an abort leaves no Running entry behind', () => {
  const prev = new Map([['session-1', activity({ canInterrupt: true })]]);
  const next = nextAfterMarkIdle(prev, 'session-1');

  assert.equal(next.size, 0);
});

test('syncProcessingSessions: server snapshot confirms a real run as Running', () => {
  const prev = new Map<string, SessionActivity>();
  const next = nextAfterSync(prev, [{ sessionId: 'session-1', startedAt: 5_000 }], 6_000);

  assert.equal(next.get('session-1')?.startedAt, 5_000);
});

test('ghost "Computing…" bug: a stale local entry with no backend match is dropped after the grace window', () => {
  // Reproduces the reported bug: the client believed a session was still
  // Running (started long ago), but the server snapshot (backend truth, e.g.
  // after the provider process died or the server restarted) no longer lists
  // any run for it.
  const now = 1_000_000;
  const staleStartedAt = now - LOCAL_ACTIVITY_GRACE_MS - 1;
  const prev = new Map([['ghost-session', activity({ startedAt: staleStartedAt })]]);

  const next = nextAfterSync(prev, [], now);

  assert.equal(next.has('ghost-session'), false);
});

test('a just-started optimistic entry survives one sync that has not confirmed it yet (grace window)', () => {
  const now = 1_000_000;
  const justStarted = now - 1_000; // well within LOCAL_ACTIVITY_GRACE_MS
  const prev = new Map([['session-1', activity({ startedAt: justStarted })]]);

  const next = nextAfterSync(prev, [], now);

  assert.equal(next.has('session-1'), true);
});

test('restart/reconnect: an empty server snapshot clears every previously-Running session past the grace window', () => {
  const now = 1_000_000;
  const longAgo = now - LOCAL_ACTIVITY_GRACE_MS - 5_000;
  const prev = new Map([
    ['session-1', activity({ startedAt: longAgo })],
    ['session-2', activity({ startedAt: longAgo })],
  ]);

  const next = nextAfterSync(prev, [], now);

  assert.equal(next.size, 0);
});

test('syncProcessingSessions: queue-adjacent fields (waiting, claudeProfileId) propagate from the server snapshot', () => {
  const prev = new Map<string, SessionActivity>();
  const next = nextAfterSync(
    prev,
    [{ sessionId: 'session-1', startedAt: 1_000, waiting: true, claudeProfileId: 'profile-personal' }],
    2_000,
  );

  assert.equal(next.get('session-1')?.waiting, true);
  assert.equal(next.get('session-1')?.claudeProfileId, 'profile-personal');
});

test('syncProcessingSessions: a session with no known profile keeps claudeProfileId null (non-Claude provider)', () => {
  const prev = new Map<string, SessionActivity>();
  const next = nextAfterSync(prev, [{ sessionId: 'session-1', startedAt: 1_000 }], 2_000);

  assert.equal(next.get('session-1')?.claudeProfileId, null);
});

test('network disconnect: an unrelated sync with no snapshots for a session does not mark it failed, only eventually removes it', () => {
  // "Not knowing" must never look like "Failed": the reducer either keeps the
  // entry (within grace) or removes it entirely — there is no failed state
  // it can invent from an empty snapshot.
  const now = 1_000_000;
  const prev = new Map([['session-1', activity({ startedAt: now - 1_000 })]]);

  const next = nextAfterSync(prev, [], now);

  const kept = next.get('session-1');
  assert.ok(kept === undefined || kept.statusText === null);
});
