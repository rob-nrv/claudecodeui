import assert from 'node:assert/strict';
import test from 'node:test';

import { createModalCloseHandler } from './modalCloseHandler';

// Regression coverage for the Pixel bug report: after a successful Work
// login (`claude /login` completes, then drops into an interactive session
// that never exits), closing the modal with the X button left the Work card
// showing "Not connected" forever. Root cause: the X button's onClick called
// only `onClose`, never the completion callback that triggers
// `verifyProfile`/`checkProviderAuthStatus` — so a login attempt that never
// naturally "exits" (the normal case for `claude /login`) had no path to
// ever refresh the UI, no matter how the modal was closed.

test('closing calls onComplete before onClose, so a caller can still re-check status', () => {
  const calls: string[] = [];
  const onComplete = (exitCode: number) => calls.push(`complete:${exitCode}`);
  const onClose = () => calls.push('closed');

  const handleClose = createModalCloseHandler(onComplete, onClose);
  handleClose();

  assert.deepEqual(calls, ['complete:-1', 'closed']);
});

test('never fabricates a successful (0) exit code for a manual close', () => {
  let receivedExitCode: number | undefined;
  const handleClose = createModalCloseHandler((exitCode) => { receivedExitCode = exitCode; }, () => {});

  handleClose();

  assert.notEqual(receivedExitCode, 0);
  assert.equal(receivedExitCode, -1);
});

test('still closes even when onComplete is not provided', () => {
  let closed = false;
  const handleClose = createModalCloseHandler(undefined, () => { closed = true; });

  assert.doesNotThrow(() => handleClose());
  assert.equal(closed, true);
});

test('each close re-triggers completion (e.g. re-opening and re-closing a profile login)', () => {
  const completions: number[] = [];
  const handleClose = createModalCloseHandler((exitCode) => completions.push(exitCode), () => {});

  handleClose();
  handleClose();

  assert.deepEqual(completions, [-1, -1]);
});
