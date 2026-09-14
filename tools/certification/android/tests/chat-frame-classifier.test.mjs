import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyRunOutcome,
  completionExitCode,
  containsSdkToolDenialWording,
  isCompletion,
  isConcurrencyGovernorRefusal,
  isLinkLostFailure,
  isOfflineRefusal,
  isRestartedFailure,
  isStorageGovernorRefusal,
  isTextEvent,
  offlineRefusalAlternatives,
} from '../lib/chat-frame-classifier.mjs';

test('isOfflineRefusal matches only the exact protocol_error/RUNTIME_NODE_OFFLINE shape', () => {
  const frame = { kind: 'protocol_error', code: 'RUNTIME_NODE_OFFLINE', error: '"Pixel HC-06" is offline. The message was not sent, and it was not moved to another node.', sessionId: 's1', alternatives: [{ nodeId: 'laptop' }] };
  assert.equal(isOfflineRefusal(frame), true);
  assert.deepEqual(offlineRefusalAlternatives(frame), [{ nodeId: 'laptop' }]);
  assert.equal(isOfflineRefusal({ kind: 'protocol_error', code: 'SESSION_ID_REQUIRED' }), false);
  assert.equal(isOfflineRefusal({ kind: 'error', code: 'RUNTIME_NODE_OFFLINE' }), false, 'wrong kind entirely');
});

test('isLinkLostFailure matches the exact HC-06 disconnect message, verbatim from failDisconnected', () => {
  const frame = { kind: 'error', content: 'Lost the connection to Pixel HC-06. The run was stopped there and was not moved to another node.', sessionId: 's1' };
  assert.equal(isLinkLostFailure(frame), true);
  assert.equal(isLinkLostFailure({ kind: 'error', content: 'Lost the connection to Pixel HC-06 for a bit.' }), false, 'must not fuzzy-match a similar-but-different message');
});

test('isConcurrencyGovernorRefusal and isStorageGovernorRefusal match REJECTION_MESSAGES verbatim', () => {
  assert.equal(isConcurrencyGovernorRefusal({ kind: 'error', content: 'The runtime node is already running as many sessions as it allows. The message was not sent, and it was not moved to another node.' }), true);
  assert.equal(isStorageGovernorRefusal({ kind: 'error', content: 'The runtime node is low on free storage and refused new runs. The message was not sent, and it was not moved to another node.' }), true);
  assert.equal(isConcurrencyGovernorRefusal({ kind: 'error', content: 'The runtime node is low on free storage and refused new runs. The message was not sent, and it was not moved to another node.' }), false, 'the two governor refusals must not cross-match');
});

test('isRestartedFailure matches the "restarted and no longer has this run" wording', () => {
  assert.equal(isRestartedFailure({ kind: 'error', content: 'Pixel HC-06 restarted and no longer has this run. It was not moved to another node.' }), true);
});

test('containsSdkToolDenialWording flags the native SDK denial text wherever it appears, case-insensitively', () => {
  assert.equal(containsSdkToolDenialWording({ kind: 'tool_result', content: "The user doesn't want to proceed with this tool use." }), true);
  assert.equal(containsSdkToolDenialWording({ kind: 'tool_result', content: "THE USER DOESN'T WANT TO PROCEED WITH THIS TOOL USE." }), true);
  assert.equal(containsSdkToolDenialWording({ kind: 'error', content: 'Permission request cancelled' }), false, 'the CloudCLI-authored cancellation message is distinct and must not be flagged');
});

test('isCompletion / completionExitCode / isTextEvent read the obvious fields', () => {
  assert.equal(isCompletion({ kind: 'complete', exitCode: 0 }), true);
  assert.equal(completionExitCode({ kind: 'complete', exitCode: 1 }), 1);
  assert.equal(completionExitCode({ kind: 'text' }), null);
  assert.equal(isTextEvent({ kind: 'text', content: 'hi' }), true);
  assert.equal(isTextEvent({ kind: 'text' }), false, 'a text frame with no content is not a text event');
});

test('classifyRunOutcome returns the first terminal-ish frame for the session, ignoring other sessions and non-terminal frames', () => {
  const frames = [
    { kind: 'text', content: 'part 1', sessionId: 's1' },
    { kind: 'complete', exitCode: 0, sessionId: 'other-session' },
    { kind: 'text', content: 'part 2', sessionId: 's1' },
    { kind: 'complete', exitCode: 0, sessionId: 's1' },
  ];
  const outcome = classifyRunOutcome(frames, 's1');
  assert.deepEqual(outcome, { outcome: 'completed', frame: frames[3], exitCode: 0 });
});

test('classifyRunOutcome returns null while nothing terminal has happened yet — never guesses early', () => {
  const frames = [{ kind: 'text', content: 'part 1', sessionId: 's1' }];
  assert.equal(classifyRunOutcome(frames, 's1'), null);
});

test('classifyRunOutcome recognizes a protocol_error offline refusal even though it carries sessionId: null in some paths', () => {
  const frames = [{ kind: 'protocol_error', code: 'RUNTIME_NODE_OFFLINE', error: 'offline', sessionId: 's1' }];
  assert.deepEqual(classifyRunOutcome(frames, 's1'), { outcome: 'offline_refusal', frame: frames[0] });
});
