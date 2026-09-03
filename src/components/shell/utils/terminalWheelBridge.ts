// Touch -> wheel bridge for terminals that have no scrollback viewport.
//
// When a full-screen TUI (Claude Code, and anything else that turns mouse
// tracking on) owns the terminal, xterm has nothing to scroll: the alternate
// buffer has no scrollback at all, and the normal buffer keeps `baseY` at 0
// while the app repaints in place. `.xterm-viewport` then has
// `scrollHeight === clientHeight`, so the finger drags a viewport that cannot
// move and the screen stays frozen — the Pixel symptom this module fixes.
//
// The way out is the one the app itself expects: a wheel event. xterm's own
// wheel listener on `terminal.element` already routes one correctly in every
// mode — it emits a mouse report while mouse tracking is on, cursor keys in an
// alt buffer without it, and a plain viewport scroll otherwise — so CloudCLI
// only has to turn finger travel into whole wheel steps and let xterm encode
// them. Nothing here writes to the PTY or builds an escape sequence itself.
//
// Kept free of DOM access so the routing and the step accounting can be
// unit-tested without a browser; the dispatch lives in
// `mobileTerminalSelection.ts`.

import { isVerticalScrollIntent } from './terminalTouchScroll';

/**
 * `viewport` keeps the L02 behaviour: xterm scrolls `.xterm-viewport` under the
 * finger and CloudCLI adds the coast. `wheel` hands the gesture to the
 * application instead.
 */
export type TouchScrollRoute = 'viewport' | 'wheel';

/**
 * Most wheel steps a single touchmove (or inertia frame) may emit.
 *
 * A step is one mouse report on the PTY, so an uncapped fling could push
 * several hundred per second at the application. The cap bounds that; the
 * surplus is dropped rather than queued, which also stops a fast flick from
 * coasting far past where the finger pointed.
 */
export const MAX_WHEEL_STEPS_PER_TICK = 6;

export type BufferType = 'normal' | 'alternate';

/**
 * True when the terminal still has scrollback the viewport can move through.
 *
 * Read from xterm's own `baseY` (`ybase`, the first line of the live viewport)
 * rather than from `scrollHeight === clientHeight`: the DOM measurement is a
 * consequence of this value, and it also reads as "no scrollback" for a moment
 * during a resize or before the first render.
 */
export function hasUsableScrollback(bufferType: BufferType, baseY: number): boolean {
  return bufferType === 'normal' && baseY > 0;
}

export type WheelRouteInput = {
  /** xterm's `coreMouseService.areMouseEventsActive`. */
  mouseEventsActive: boolean;
  bufferType: BufferType;
  baseY: number;
  isSelecting: boolean;
  isHandleDragging: boolean;
  isPinching: boolean;
  /** Travel since the touch started, used to classify the gesture. */
  dx: number;
  dy: number;
};

/**
 * Which mechanism owns the current one-finger drag.
 *
 * The bridge only takes a gesture that nothing else claims, that the user
 * clearly meant as a vertical scroll, and that the viewport genuinely cannot
 * serve — so a terminal with real scrollback keeps behaving exactly as it did
 * before, mouse tracking or not.
 */
export function resolveTouchScrollRoute({
  mouseEventsActive,
  bufferType,
  baseY,
  isSelecting,
  isHandleDragging,
  isPinching,
  dx,
  dy,
}: WheelRouteInput): TouchScrollRoute {
  if (isSelecting || isHandleDragging || isPinching) {
    return 'viewport';
  }

  if (!mouseEventsActive) {
    return 'viewport';
  }

  if (hasUsableScrollback(bufferType, baseY)) {
    return 'viewport';
  }

  if (!isVerticalScrollIntent(dx, dy)) {
    return 'viewport';
  }

  return 'wheel';
}

/**
 * Turns finger travel into whole wheel steps, one terminal row at a time.
 *
 * A wheel event shorter than a row is not free: xterm keeps its own partial
 * accumulator and would report nothing, so dispatching per pixel would only
 * burn events. Accumulating here against the real cell height means one step
 * leaves exactly one row of travel behind, and the sub-row remainder carries
 * into the next touchmove instead of being lost — which is what makes a slow
 * drag advance smoothly rather than in jumps.
 */
export class WheelStepAccumulator {
  private residualPx = 0;

  reset(): void {
    this.residualPx = 0;
  }

  /**
   * @param fingerDeltaY Travel of this move in CSS px, positive downwards.
   * @param cellHeight Height of one terminal row in CSS px.
   * @returns Signed step count, positive for wheel-down. A finger moving down
   * returns negative steps, which is wheel-up: the content follows the finger
   * back into earlier output.
   */
  takeSteps(fingerDeltaY: number, cellHeight: number): number {
    if (!(cellHeight > 0) || !Number.isFinite(fingerDeltaY)) {
      return 0;
    }

    this.residualPx += -fingerDeltaY;

    const steps = Math.trunc(this.residualPx / cellHeight);
    if (steps === 0) {
      return 0;
    }

    // Only the sub-row remainder survives: any step past the cap is dropped
    // rather than held back, so the accumulator can never build a backlog that
    // keeps firing after the finger has stopped.
    this.residualPx -= steps * cellHeight;

    return Math.max(-MAX_WHEEL_STEPS_PER_TICK, Math.min(MAX_WHEEL_STEPS_PER_TICK, steps));
  }
}
