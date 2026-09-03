import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SCROLL_INERTIA_MIN_VELOCITY,
  TouchScrollVelocityTracker,
  isVerticalScrollIntent,
  shouldReclaimGestureForScroll,
  shouldStartInertia,
} from './terminalTouchScroll';

// Coverage for the Pixel report that the Shell scrollback is unusable with a
// finger: a press that rests for the 600ms long-press delay before dragging
// turned the scroll into a text selection, and a flick whose last touchmove
// landed a frame late (routine while the terminal renders thousands of lines)
// silently produced no coast at all.

const baseGesture = {
  isSelecting: false,
  isTouchScrolling: false,
  isHandleDragging: false,
  isPinching: false,
  dx: 0,
  dy: 0,
  msSinceLongPressSelection: null as number | null,
};

test('a clearly vertical drag is scroll intent, a sideways one is not', () => {
  assert.equal(isVerticalScrollIntent(0, -40), true);
  assert.equal(isVerticalScrollIntent(0, 40), true);
  assert.equal(isVerticalScrollIntent(60, -20), false);
  assert.equal(isVerticalScrollIntent(0, -4), false);
});

test('a drag right after a mis-fired long-press takes the gesture back', () => {
  assert.equal(
    shouldReclaimGestureForScroll({
      ...baseGesture,
      isSelecting: true,
      dy: -60,
      msSinceLongPressSelection: 40,
    }),
    true,
  );
});

test('a deliberate long-press keeps its selection once the user has seen it', () => {
  assert.equal(
    shouldReclaimGestureForScroll({
      ...baseGesture,
      isSelecting: true,
      dy: -60,
      msSinceLongPressSelection: 900,
    }),
    false,
  );
});

test('a selection that did not come from a long-press is never taken back', () => {
  assert.equal(
    shouldReclaimGestureForScroll({
      ...baseGesture,
      isSelecting: true,
      dy: -60,
      msSinceLongPressSelection: null,
    }),
    false,
  );
});

test('handle drags and pinches keep their gesture', () => {
  const justReclaimed = { ...baseGesture, isSelecting: true, dy: -60, msSinceLongPressSelection: 40 };

  assert.equal(shouldReclaimGestureForScroll({ ...justReclaimed, isHandleDragging: true }), false);
  assert.equal(shouldReclaimGestureForScroll({ ...justReclaimed, isPinching: true }), false);
  // Already scrolling: nothing left to take back.
  assert.equal(shouldReclaimGestureForScroll({ ...justReclaimed, isTouchScrolling: true }), false);
});

test('a fast flick coasts', () => {
  const tracker = new TouchScrollVelocityTracker();
  for (let i = 0; i <= 6; i++) {
    tracker.add(600 - i * 24, 1000 + i * 16);
  }

  const velocity = tracker.releaseVelocity(1100);
  assert.ok(velocity > SCROLL_INERTIA_MIN_VELOCITY, `expected a coast, got ${velocity}`);
  assert.ok(
    shouldStartInertia({
      isTouchScrolling: true,
      isHandleDragging: false,
      isPinching: false,
      velocity,
    }),
  );
});

test('a slower drag released straight away still coasts', () => {
  const tracker = new TouchScrollVelocityTracker();
  for (let i = 0; i <= 8; i++) {
    tracker.add(600 - i * 3, 1000 + i * 16);
  }

  const velocity = tracker.releaseVelocity(1128 + 16);
  assert.ok(velocity > SCROLL_INERTIA_MIN_VELOCITY, `expected a coast, got ${velocity}`);
});

test('a flick whose last sample arrived a jank frame late still coasts', () => {
  const tracker = new TouchScrollVelocityTracker();
  for (let i = 0; i <= 6; i++) {
    tracker.add(600 - i * 24, 1000 + i * 16);
  }

  // 120ms between the final touchmove and the release: the old hard 90ms
  // cutoff dropped this gesture entirely.
  const velocity = tracker.releaseVelocity(1096 + 120);
  assert.ok(velocity > SCROLL_INERTIA_MIN_VELOCITY, `expected a coast, got ${velocity}`);
});

test('a finger parked before lifting produces no phantom coast', () => {
  const tracker = new TouchScrollVelocityTracker();
  for (let i = 0; i <= 6; i++) {
    tracker.add(600 - i * 24, 1000 + i * 16);
  }

  assert.equal(tracker.releaseVelocity(1096 + 600), 0);
});

test('a release gap fades the coast out instead of switching it off', () => {
  const build = () => {
    const tracker = new TouchScrollVelocityTracker();
    for (let i = 0; i <= 6; i++) {
      tracker.add(600 - i * 24, 1000 + i * 16);
    }
    return tracker;
  };

  const prompt = build().releaseVelocity(1096 + 16);
  const late = build().releaseVelocity(1096 + 120);

  assert.ok(late < prompt, 'a later release must coast less');
  assert.ok(late > 0);
});

test('a tap and a reset tracker never coast', () => {
  const tracker = new TouchScrollVelocityTracker();
  assert.equal(tracker.releaseVelocity(1000), 0);

  tracker.add(600, 1000);
  assert.equal(tracker.releaseVelocity(1010), 0, 'a single sample is not a drag');

  tracker.add(500, 1016);
  assert.ok(tracker.releaseVelocity(1032) > 0);

  // touchcancel path: the abandoned gesture must not leave a coast behind.
  tracker.reset();
  assert.equal(tracker.releaseVelocity(1032), 0);
});

test('inertia only starts for a gesture the scrollback owns', () => {
  const velocity = 1;

  assert.equal(
    shouldStartInertia({
      isTouchScrolling: false,
      isHandleDragging: false,
      isPinching: false,
      velocity,
    }),
    false,
    'extending a selection must not coast',
  );
  assert.equal(
    shouldStartInertia({
      isTouchScrolling: true,
      isHandleDragging: true,
      isPinching: false,
      velocity,
    }),
    false,
    'dragging a handle must not coast',
  );
  assert.equal(
    shouldStartInertia({
      isTouchScrolling: true,
      isHandleDragging: false,
      isPinching: true,
      velocity,
    }),
    false,
    'pinch-zoom must not coast',
  );
  assert.equal(
    shouldStartInertia({
      isTouchScrolling: true,
      isHandleDragging: false,
      isPinching: false,
      velocity: 0.001,
    }),
    false,
    'a nudge must not coast',
  );
});
