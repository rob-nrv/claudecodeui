import assert from 'node:assert/strict';
import test from 'node:test';

import {
  acceptedExecutionIds,
  endedConnected,
  lastInterruptedOnRestart,
  noDuplicateAcceptance,
  outcomesByExecution,
  parseAgentLog,
  reconnectOutcome,
} from '../lib/log-parser.mjs';

const EXECUTION_ID = 'a1b2c3d4-0000-0000-0000-000000000001';

// The exact real-hardware excerpt from the pre-fix HC-06 failure.
const FAIL_LOG = [
  `[node] Run ${EXECUTION_ID} accepted for session session-1`,
  '[node] Link error: connect ECONNABORTED 192.168.1.36:3443',
  '[node] Link error: connect ENETUNREACH 192.168.1.36:3443 - Local (0.0.0.0:0)',
  '[node] Link error: connect ENETUNREACH 192.168.1.36:3443',
  '[node] Link error: connect ENETUNREACH 192.168.1.36:3443',
  `[node] Aborting run ${EXECUTION_ID}: control plane did not reconnect`,
  'Aborting SDK session: session-1',
  'SDK query error: Claude Code exited with code 1',
  `[node] Run ${EXECUTION_ID} finished (aborted)`,
  '[node] Connected to control plane as node pixel-hc06.',
].join('\n');

// The post-fix (a31c3765) real-hardware pass excerpt.
const PASS_LOG = [
  `[node] Run ${EXECUTION_ID} accepted for session session-1`,
  '[node] Link error: connect ENETUNREACH 192.168.1.36:3443',
  '[node] Link error: connect ENETUNREACH 192.168.1.36:3443',
  '[node] Connected to control plane as node pixel-hc06.',
  `[node] Run ${EXECUTION_ID} finished (completed)`,
].join('\n');

test('parses accepted, finished, aborting, link error and connected lines', () => {
  const events = parseAgentLog(FAIL_LOG);
  assert.deepEqual(events.map((event) => event.type), [
    'accepted', 'link_error', 'link_error', 'link_error', 'link_error', 'aborting', 'finished', 'connected',
  ]);
  assert.equal(events[0].executionId, EXECUTION_ID);
  assert.equal(events[0].sessionId, 'session-1');
  assert.equal(events[5].reason, 'control plane did not reconnect');
  assert.equal(events[6].outcome, 'aborted');
});

test('unrecognized lines (SDK stderr, blank lines) are skipped without error', () => {
  const events = parseAgentLog(FAIL_LOG);
  // 10 raw lines in FAIL_LOG; 2 of them ("Aborting SDK session", "SDK query error") are not node-agent lines.
  assert.equal(events.length, 8);
});

test('reconnectOutcome flags the exact a31c3765 regression: aborted before the reconnect landed', () => {
  const events = parseAgentLog(FAIL_LOG);
  const result = reconnectOutcome(events);
  assert.equal(result.outcome, 'aborted_before_reconnect');
  assert.ok(result.abortedAt);
  assert.ok(result.connectedAt, 'the node did eventually reconnect, just too late');
});

test('reconnectOutcome reads the fixed behavior as a clean reconnect with no local abort', () => {
  const events = parseAgentLog(PASS_LOG);
  const result = reconnectOutcome(events);
  assert.equal(result.outcome, 'reconnected_without_local_abort');
});

test('reconnectOutcome with no connect and no abort in the window reads as inconclusive, not as a pass', () => {
  const events = parseAgentLog('[node] Link error: connect ENETUNREACH 192.168.1.36:3443');
  assert.deepEqual(reconnectOutcome(events), { outcome: 'no_reconnect_observed' });
});

test('endedConnected is true only when the last connect is after the last link error', () => {
  assert.equal(endedConnected(parseAgentLog(PASS_LOG)), true);
  const stillFlapping = `${PASS_LOG}\n[node] Link error: connect ENETUNREACH 192.168.1.36:3443`;
  assert.equal(endedConnected(parseAgentLog(stillFlapping)), false);
});

test('acceptedExecutionIds de-duplicates, but noDuplicateAcceptance reports the raw duplicate', () => {
  const doubled = `${FAIL_LOG}\n[node] Run ${EXECUTION_ID} accepted for session session-1`;
  const events = parseAgentLog(doubled);
  assert.deepEqual(acceptedExecutionIds(events), [EXECUTION_ID]);
  const check = noDuplicateAcceptance(events);
  assert.equal(check.ok, false);
  assert.deepEqual(check.duplicated, [EXECUTION_ID]);

  const clean = noDuplicateAcceptance(parseAgentLog(FAIL_LOG));
  assert.equal(clean.ok, true);
  assert.deepEqual(clean.duplicated, []);
});

test('outcomesByExecution takes the last finished event per execution id', () => {
  const events = parseAgentLog(FAIL_LOG);
  const outcomes = outcomesByExecution(events);
  assert.equal(outcomes.get(EXECUTION_ID), 'aborted');
});

test('lastInterruptedOnRestart reads the exact restart-journal line, or null when the agent never reported one', () => {
  assert.equal(lastInterruptedOnRestart(parseAgentLog(PASS_LOG)), null);
  const withRestart = `${PASS_LOG}\n1 run(s) were interrupted when this agent last stopped. They were not resumed or re-run; retry them from CloudCLI.`;
  assert.equal(lastInterruptedOnRestart(parseAgentLog(withRestart)), 1);
});

test('governor refusal lines are captured with their code', () => {
  const log = `[node] Run ${EXECUTION_ID} refused by the resource governor: RESOURCE_CONCURRENCY_LIMIT`;
  const events = parseAgentLog(log);
  assert.deepEqual(events, [{ type: 'governor_refused', executionId: EXECUTION_ID, code: 'RESOURCE_CONCURRENCY_LIMIT', lineNumber: 1 }]);
});
