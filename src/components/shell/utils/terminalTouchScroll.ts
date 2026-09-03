// Touch scrollback primitives for the mobile terminal.
//
// xterm moves `.xterm-viewport` 1:1 with the finger and never coasts, and its
// long-press/selection layer lives in the same element, so CloudCLI has to
// decide which gesture owns a touch and how fast the viewport keeps moving
// after the release. Those decisions are kept here, free of any DOM access, so
// they can be unit-tested without a browser environment; the DOM plumbing
// stays in `mobileTerminalSelection.ts`.

/**
 * Vertical travel (CSS px) from the touch origin after which a one-finger drag
 * counts as a deliberate scrollback gesture. Deliberately larger than the 8px
 * press slop used to cancel a long-press: taking a gesture *back* from an
 * already-started selection must need clearly more evidence than merely
 * refusing to start one.
 */
export const SCROLL_INTENT_PX = 16;

/**
 * How long after the long-press fires the same, still-pressed finger may take
 * the gesture back as a scroll. A user who long-pressed on purpose sees the
 * word highlight, then starts extending it — that reaction costs well over
 * this budget. A user whose scroll was captured is already moving when the
 * timer fires, so the drag lands inside the window.
 */
export const SCROLL_RECLAIM_WINDOW_MS = 250;

/** Newest slice of the drag used to estimate the release velocity. */
export const SCROLL_VELOCITY_WINDOW_MS = 120;

/**
 * Gap between the last movement and the release beyond which the finger is
 * considered parked, so nothing coasts. Generous on purpose: touchmove
 * delivery on a busy terminal can stall for a frame or two, and the release
 * gap already dampens the velocity continuously (see `releaseVelocity`), so
 * this is only a backstop against coasting after a real pause.
 */
export const SCROLL_INERTIA_MAX_IDLE_MS = 250;

export const SCROLL_INERTIA_FRICTION = 0.95; // velocity multiplier per ~16ms frame
export const SCROLL_INERTIA_MIN_VELOCITY = 0.02; // px/ms below which coasting stops
export const SCROLL_INERTIA_MAX_VELOCITY = 5; // px/ms cap to avoid runaway flings

export function isVerticalScrollIntent(dx: number, dy: number): boolean {
  return Math.abs(dy) >= SCROLL_INTENT_PX && Math.abs(dy) > Math.abs(dx);
}

export type ReclaimGestureInput = {
  isSelecting: boolean;
  isTouchScrolling: boolean;
  isHandleDragging: boolean;
  isPinching: boolean;
  dx: number;
  dy: number;
  /** null when the current selection did not come from a long-press. */
  msSinceLongPressSelection: number | null;
};

/**
 * True when a long-press that fired while the finger was merely resting should
 * hand the gesture back to the scrollback.
 */
export function shouldReclaimGestureForScroll({
  isSelecting,
  isTouchScrolling,
  isHandleDragging,
  isPinching,
  dx,
  dy,
  msSinceLongPressSelection,
}: ReclaimGestureInput): boolean {
  if (!isSelecting || isTouchScrolling || isHandleDragging || isPinching) {
    return false;
  }

  if (msSinceLongPressSelection === null || msSinceLongPressSelection > SCROLL_RECLAIM_WINDOW_MS) {
    return false;
  }

  return isVerticalScrollIntent(dx, dy);
}

export type StartInertiaInput = {
  isTouchScrolling: boolean;
  isHandleDragging: boolean;
  isPinching: boolean;
  velocity: number;
};

export function shouldStartInertia({
  isTouchScrolling,
  isHandleDragging,
  isPinching,
  velocity,
}: StartInertiaInput): boolean {
  if (!isTouchScrolling || isHandleDragging || isPinching) {
    return false;
  }

  return Math.abs(velocity) >= SCROLL_INERTIA_MIN_VELOCITY;
}

type ScrollSample = {
  y: number;
  time: number;
};

/**
 * Release-velocity estimator over the newest slice of a drag.
 *
 * The previous implementation blended samples with a fixed weight and vetoed
 * inertia whenever the last sample was older than a hard cutoff. Both are
 * sample-count based, so an irregular touchmove stream — exactly what a
 * scrolling terminal produces while it renders — either lost a real flick or
 * kept a stale velocity. Here the velocity is measured over wall-clock time
 * and the gap before the release is part of the denominator, so a delayed
 * release fades the coast out continuously instead of switching it off.
 */
export class TouchScrollVelocityTracker {
  private samples: ScrollSample[] = [];

  reset(): void {
    this.samples.length = 0;
  }

  add(y: number, time: number): void {
    this.samples.push({ y, time });

    const cutoff = time - SCROLL_VELOCITY_WINDOW_MS;
    while (this.samples.length > 2 && this.samples[0].time < cutoff) {
      this.samples.shift();
    }
  }

  /**
   * px/ms, positive when the finger moved up — the direction in which xterm
   * increases `scrollTop`. Returns 0 when the gesture must not coast.
   */
  releaseVelocity(releaseTime: number): number {
    if (this.samples.length < 2) {
      return 0;
    }

    const oldest = this.samples[0];
    const newest = this.samples[this.samples.length - 1];

    if (releaseTime - newest.time > SCROLL_INERTIA_MAX_IDLE_MS) {
      return 0;
    }

    const elapsed = Math.max(releaseTime, newest.time) - oldest.time;
    if (elapsed <= 0) {
      return 0;
    }

    return (oldest.y - newest.y) / elapsed;
  }
}
