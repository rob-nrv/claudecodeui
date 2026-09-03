import assert from 'node:assert/strict';
import test from 'node:test';

import { type ContextMenuAction, resolveContextMenuAction } from './terminalSelectionRecovery';

// Coverage for the Pixel failure of C3-P1-L02c: suppressing the native
// long-press menu removed the selector entirely, because the 600ms timer that
// was meant to draw ours had already been cancelled along with the touch.
//
// A boolean "was it suppressed" could not have caught that — it is true in both
// the working and the broken case. These tests assert the *action*, so a
// regression that stops opening the selection fails here instead of on device.

/** A long-press: Chrome raises contextmenu at ~500ms, finger still down. */
const longPress = { pointerType: 'touch', hasActiveTouch: true, isSelecting: false };

/**
 * Walks the real cycle, threading `isSelecting` the way the manager does:
 * a `suppress-and-select` opens the selection, and Copy closes it again.
 */
function runCycle(cycles: number): ContextMenuAction[] {
  const actions: ContextMenuAction[] = [];
  let isSelecting = false;

  for (let index = 0; index < cycles; index += 1) {
    const action = resolveContextMenuAction({ ...longPress, isSelecting });
    actions.push(action);

    if (action === 'suppress-and-select') {
      isSelecting = true;
    }

    // Copy: clipboard written, then clearSelection() resets the state.
    isSelecting = false;
  }

  return actions;
}

test('the first long-press opens the selector instead of being swallowed', () => {
  // The regression this pins: L02c returned "suppress" here, which blocked the
  // native menu and drew nothing in its place.
  assert.equal(resolveContextMenuAction(longPress), 'suppress-and-select');
});

test('a long-press after Copy opens the selector again', () => {
  // Copy leaves isSelecting false, so the next press is a fresh selection.
  assert.deepEqual(runCycle(1), ['suppress-and-select']);
  assert.deepEqual(runCycle(3), [
    'suppress-and-select',
    'suppress-and-select',
    'suppress-and-select',
  ]);
});

test('a selection already on screen is never restarted under the finger', () => {
  // Select All, or a timer that fired on a device that does not cancel: the
  // menu must survive so Copy / Select All stay reachable.
  assert.equal(
    resolveContextMenuAction({ ...longPress, isSelecting: true }),
    'suppress',
  );
});

test('a real right-click is left entirely to the browser and xterm', () => {
  // Desktop keeps xterm right-click copy/paste; this is the case that forbids
  // suppressing contextmenu outright.
  for (const isSelecting of [false, true]) {
    assert.equal(
      resolveContextMenuAction({
        pointerType: 'mouse',
        hasActiveTouch: false,
        isSelecting,
      }),
      'ignore',
    );
  }
});

test('a browser reporting no pointerType still gets the touch path', () => {
  assert.equal(
    resolveContextMenuAction({
      pointerType: null,
      hasActiveTouch: true,
      isSelecting: false,
    }),
    'suppress-and-select',
  );
});

test('an idle terminal with no touch is left alone, so paste stays reachable', () => {
  // Nothing pending and no finger down: not our gesture, so the platform menu
  // — and the paste it offers — is not globally disabled.
  assert.equal(
    resolveContextMenuAction({
      pointerType: null,
      hasActiveTouch: false,
      isSelecting: false,
    }),
    'ignore',
  );
});

test('a cancelled touch cannot leave the policy stuck in select mode', () => {
  // touchcancel clears hasActiveTouch; a later stray contextmenu with no
  // selection up must not open one out of nowhere.
  assert.equal(
    resolveContextMenuAction({
      pointerType: null,
      hasActiveTouch: false,
      isSelecting: false,
    }),
    'ignore',
  );
});
