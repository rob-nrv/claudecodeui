import assert from 'node:assert/strict';
import test from 'node:test';

import { isTerminalScrolledBack } from './terminalLiveState';

const terminalAt = (viewportY: number, baseY: number) => ({
  buffer: { active: { viewportY, baseY } },
});

test('following live output is not scrolled back', () => {
  assert.equal(isTerminalScrolledBack(terminalAt(1500, 1500)), false);
});

test('a viewport parked above the live tail is scrolled back', () => {
  assert.equal(isTerminalScrolledBack(terminalAt(400, 1500)), true);
});

test('new output while parked keeps the reading position scrolled back', () => {
  // xterm leaves `viewportY` alone when lines are appended below the reader,
  // so only `baseY` grows — the state must follow the buffer, not the output.
  assert.equal(isTerminalScrolledBack(terminalAt(400, 1500)), true);
  assert.equal(isTerminalScrolledBack(terminalAt(400, 1700)), true);
});

test('returning to the bottom goes back to live', () => {
  assert.equal(isTerminalScrolledBack(terminalAt(1700, 1700)), false);
});

test('a missing terminal reports live rather than throwing', () => {
  assert.equal(isTerminalScrolledBack(null), false);
  assert.equal(isTerminalScrolledBack(undefined), false);
});
