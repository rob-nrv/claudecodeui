import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_WHEEL_STEPS_PER_TICK,
  WheelStepAccumulator,
  hasUsableScrollback,
  resolveTouchScrollRoute,
} from './terminalWheelBridge';

// Coverage for the Pixel report that Claude Code running in the Shell does not
// move under the finger: mouse tracking is on, the touchmoves arrive, and the
// viewport has nothing to scroll, so the gesture has to become a wheel event
// instead. These cases pin the routing — which must keep every other gesture
// exactly where L02 left it — and the step accounting.

const CELL = 20;

const tuiDrag = {
  mouseEventsActive: true,
  bufferType: 'normal' as const,
  baseY: 0,
  isSelecting: false,
  isHandleDragging: false,
  isPinching: false,
  dx: 0,
  dy: -60,
};

test('a terminal with real scrollback is never bridged', () => {
  assert.equal(hasUsableScrollback('normal', 400), true);
  assert.equal(hasUsableScrollback('normal', 0), false);
  // The alternate buffer has no scrollback whatever xterm reports for baseY.
  assert.equal(hasUsableScrollback('alternate', 0), false);
});

test('mouse tracking off keeps the normal viewport route', () => {
  assert.equal(
    resolveTouchScrollRoute({ ...tuiDrag, mouseEventsActive: false }),
    'viewport',
  );
});

test('mouse tracking on over a TUI buffer routes to the wheel', () => {
  assert.equal(resolveTouchScrollRoute(tuiDrag), 'wheel');
  assert.equal(
    resolveTouchScrollRoute({ ...tuiDrag, bufferType: 'alternate' }),
    'wheel',
  );
  // Dragging the other way is still the same route.
  assert.equal(resolveTouchScrollRoute({ ...tuiDrag, dy: 60 }), 'wheel');
});

test('the alternate buffer is never treated as scrollable, whatever baseY says', () => {
  // The alt buffer has no scrollback by construction, but `baseY` is read from
  // a live terminal: a resize transient, or a future xterm reporting a nonzero
  // ybase here, must not silently send a TUI drag back to a dead viewport.
  assert.equal(hasUsableScrollback('alternate', 400), false);
  assert.equal(
    resolveTouchScrollRoute({ ...tuiDrag, bufferType: 'alternate', baseY: 400 }),
    'wheel',
  );
});

test('mouse tracking on with usable scrollback keeps the L02 behaviour', () => {
  assert.equal(
    resolveTouchScrollRoute({ ...tuiDrag, bufferType: 'normal', baseY: 1200 }),
    'viewport',
  );
});

test('a live selection is never taken over by the bridge', () => {
  assert.equal(resolveTouchScrollRoute({ ...tuiDrag, isSelecting: true }), 'viewport');
});

test('handle drags and pinches are never taken over by the bridge', () => {
  assert.equal(resolveTouchScrollRoute({ ...tuiDrag, isHandleDragging: true }), 'viewport');
  assert.equal(resolveTouchScrollRoute({ ...tuiDrag, isPinching: true }), 'viewport');
});

test('a sideways or undecided drag does not reach the wheel', () => {
  assert.equal(resolveTouchScrollRoute({ ...tuiDrag, dx: -120, dy: -30 }), 'viewport');
  // Below the vertical-intent threshold: the gesture has not committed yet.
  assert.equal(resolveTouchScrollRoute({ ...tuiDrag, dy: -4 }), 'viewport');
});

test('a finger moving down scrolls back, a finger moving up scrolls forward', () => {
  const accumulator = new WheelStepAccumulator();

  // Positive steps are wheel-down (forward); the finger travelled up.
  assert.equal(accumulator.takeSteps(-CELL, CELL), 1);

  accumulator.reset();
  // Dragging the finger down goes back into earlier output.
  assert.equal(accumulator.takeSteps(CELL, CELL), -1);
});

test('travel shorter than a row emits nothing but is not lost', () => {
  const accumulator = new WheelStepAccumulator();

  assert.equal(accumulator.takeSteps(-8, CELL), 0);
  assert.equal(accumulator.takeSteps(-8, CELL), 0);
  // 24px of travel has now crossed one 20px row.
  assert.equal(accumulator.takeSteps(-8, CELL), 1);
  // ...and the 4px remainder carried over rather than being dropped.
  assert.equal(accumulator.takeSteps(-16, CELL), 1);
});

test('a fling cannot flood the pty and leaves no backlog behind', () => {
  const accumulator = new WheelStepAccumulator();

  const steps = accumulator.takeSteps(-CELL * 40, CELL);
  assert.equal(steps, MAX_WHEEL_STEPS_PER_TICK);

  // The surplus is dropped, not queued: a single further row of travel is
  // worth exactly one step, so nothing keeps firing after the finger stops.
  assert.equal(accumulator.takeSteps(-CELL, CELL), 1);
  assert.equal(accumulator.takeSteps(0, CELL), 0);
});

test('reversing direction mid-drag cancels out instead of emitting a phantom step', () => {
  const accumulator = new WheelStepAccumulator();

  // A finger that wanders down then back up — routine while reading — must end
  // where it started rather than leaving a signed residual that fires later.
  assert.equal(accumulator.takeSteps(CELL / 2, CELL), 0);
  assert.equal(accumulator.takeSteps(-CELL / 2, CELL), 0);

  // Same across a step boundary: one row back, then one row forward.
  assert.equal(accumulator.takeSteps(CELL * 1.5, CELL), -1);
  assert.equal(accumulator.takeSteps(-CELL * 1.5, CELL), 1);
  assert.equal(accumulator.takeSteps(0, CELL), 0);
});

test('an unmeasured cell height emits nothing instead of dividing by zero', () => {
  const accumulator = new WheelStepAccumulator();

  assert.equal(accumulator.takeSteps(-100, 0), 0);
  assert.equal(accumulator.takeSteps(-100, Number.NaN), 0);
  // The unusable travel was refused outright, so it cannot resurface later.
  assert.equal(accumulator.takeSteps(-1, CELL), 0);
});

test('reset drops the residual so a cancelled or rerouted gesture leaves nothing', () => {
  const accumulator = new WheelStepAccumulator();

  // Half a row of travel is pending — a touchcancel, or the buffer going back
  // to a normal scrollback, must not let it leak into the next gesture.
  assert.equal(accumulator.takeSteps(-CELL / 2, CELL), 0);
  accumulator.reset();

  assert.equal(accumulator.takeSteps(-CELL / 2, CELL), 0);
  assert.equal(accumulator.takeSteps(-CELL / 2, CELL), 1);
});
