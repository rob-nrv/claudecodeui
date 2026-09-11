import assert from 'node:assert/strict';
import test from 'node:test';

import type { PendingPermissionRequest } from '../types/types';

import {
  addPermissionRequest,
  applyPermissionResponseAck,
  applyPermissionSnapshot,
  clearOpenPermissionRequests,
  expirePermissionRequest,
  flagPermissionRequestsNotSent,
  isAwaitingPermissionDecision,
  isOpenPermissionRequest,
  markPermissionRequestsSubmitting,
  removePermissionRequest,
} from './permissionRequestState';

const request = (requestId: string, overrides: Partial<PendingPermissionRequest> = {}): PendingPermissionRequest => ({
  requestId,
  toolName: 'Bash',
  input: { command: 'npm test' },
  sessionId: 'session-1',
  ...overrides,
});

const ids = (requests: PendingPermissionRequest[]) => requests.map((entry) => `${entry.requestId}:${entry.status}`);

test('a replayed request is deduplicated and a replayed resolution leaves no ghost approval', () => {
  let state = addPermissionRequest([], request('r1'));
  state = addPermissionRequest(state, request('r1'));
  assert.deepEqual(ids(state), ['r1:pending']);

  state = removePermissionRequest(state, 'r1');
  assert.deepEqual(state, []);
});

test('an expiry keeps an explicit, non-actionable notice instead of removing the request', () => {
  const state = expirePermissionRequest([request('r1', { status: 'pending' })], 'r1');
  assert.deepEqual(ids(state), ['r1:expired']);
  assert.equal(isAwaitingPermissionDecision(state[0]), false);
  assert.equal(isOpenPermissionRequest(state[0]), false);
});

test('answering marks only awaiting requests as submitting, so a second click cannot send again', () => {
  const state = markPermissionRequestsSubmitting(
    [request('r1', { status: 'pending', notice: 'not_sent' }), request('r2', { status: 'expired' })],
    ['r1', 'r2'],
  );
  assert.deepEqual(ids(state), ['r1:submitting', 'r2:expired']);
  assert.equal(state[0].notice, undefined);
  assert.equal(isAwaitingPermissionDecision(state[0]), false);
  assert.equal(isOpenPermissionRequest(state[0]), true);
});

test('an answer that could not be sent stays answerable and says so', () => {
  const state = flagPermissionRequestsNotSent([request('r1', { status: 'pending' })], ['r1']);
  assert.deepEqual(ids(state), ['r1:pending']);
  assert.equal(state[0].notice, 'not_sent');
});

test('the server ack settles the request: applied answers disappear, late ones say why', () => {
  const base = [
    request('accepted', { status: 'submitting' }),
    request('duplicate', { status: 'submitting' }),
    request('late', { status: 'submitting' }),
    request('unknown', { status: 'submitting' }),
  ];
  let state = applyPermissionResponseAck(base, { requestId: 'accepted', accepted: true, reason: null });
  state = applyPermissionResponseAck(state, { requestId: 'duplicate', accepted: false, reason: 'already_answered' });
  state = applyPermissionResponseAck(state, { requestId: 'late', accepted: false, reason: 'expired' });
  state = applyPermissionResponseAck(state, { requestId: 'unknown', accepted: false, reason: 'not_found' });
  assert.deepEqual(ids(state), ['late:expired', 'unknown:unavailable']);
});

test('a finished run clears answerable requests but keeps expired notices visible', () => {
  const state = clearOpenPermissionRequests([
    request('r1', { status: 'pending' }),
    request('r2', { status: 'submitting' }),
    request('r3', { status: 'expired' }),
    request('r4', { status: 'unavailable' }),
  ]);
  assert.deepEqual(ids(state), ['r3:expired', 'r4:unavailable']);
});

test('a reconnect snapshot restores pending requests, including answers that may have been lost', () => {
  const state = applyPermissionSnapshot(
    [request('r1', { status: 'submitting' })],
    'session-1',
    { pendingPermissions: [request('r1', { expiresAt: '2026-09-11T10:15:00.000Z' }), request('r2')], recentPermissionOutcomes: [] },
    new Set(),
  );
  assert.deepEqual(ids(state), ['r1:pending', 'r2:pending']);
  assert.equal(state[0].expiresAt, '2026-09-11T10:15:00.000Z');
});

test('a reconnect snapshot settles requests the server no longer holds from its recorded outcomes', () => {
  const state = applyPermissionSnapshot(
    [
      request('answered', { status: 'pending' }),
      request('cancelled', { status: 'submitting' }),
      request('expired', { status: 'pending' }),
      request('forgotten', { status: 'pending' }),
      request('already-expired', { status: 'expired' }),
    ],
    'session-1',
    {
      pendingPermissions: [],
      recentPermissionOutcomes: [
        { requestId: 'answered', outcome: 'answered' },
        { requestId: 'cancelled', outcome: 'cancelled' },
        { requestId: 'expired', outcome: 'expired' },
      ],
    },
    new Set(),
  );
  assert.deepEqual(ids(state), ['expired:expired', 'forgotten:unavailable', 'already-expired:expired']);
});

test('a reconnect snapshot surfaces expiries that happened while offline, unless dismissed', () => {
  const snapshot = {
    pendingPermissions: [],
    recentPermissionOutcomes: [
      { requestId: 'missed', sessionId: 'session-1', toolName: 'Edit', outcome: 'expired', input: { file_path: 'a.ts' } },
      { requestId: 'dismissed', sessionId: 'session-1', toolName: 'Bash', outcome: 'expired' },
      { requestId: 'answered-elsewhere', sessionId: 'session-1', toolName: 'Bash', outcome: 'answered' },
    ],
  };
  const state = applyPermissionSnapshot([], 'session-1', snapshot, new Set(['dismissed']));
  assert.deepEqual(ids(state), ['missed:expired']);
  assert.equal(state[0].toolName, 'Edit');
  assert.equal(state[0].sessionId, 'session-1');
});

test('a snapshot for one session never touches another session\'s requests', () => {
  const other = request('other', { sessionId: 'session-2', status: 'pending' });
  const state = applyPermissionSnapshot([other], 'session-1', { pendingPermissions: [], recentPermissionOutcomes: [] }, new Set());
  assert.deepEqual(state, [other]);
});
