// Owns what a long-press on the terminal does on a touch device.
//
// Three facts decide this, all verified against the installed xterm and the
// Pixel behaviour:
//
//  1. Chrome on Android raises `contextmenu` for a long-press at roughly
//     500ms, then cancels the touch sequence it has just consumed.
//  2. CloudCLI's own long-press timer is 600ms, and `touchcancel` clears it —
//     so on a real device the platform wins the race by ~100ms and our
//     selection never starts. This stayed hidden while the native menu was
//     still showing something in its place.
//  3. xterm answers the same `contextmenu` with `rightClickHandler`, which
//     parks its hidden helper textarea under the pointer at `z-index: 1000`
//     and focuses it. With `rightClickSelectsWord` false off macOS it selects
//     nothing, so the textarea is empty — and the native menu for a focused
//     empty editable is Paste, which is what buried Copy / Select All once the
//     clipboard was no longer empty.
//
// Suppressing that menu without replacing it left nothing at all on screen.
// So `contextmenu` is not treated as something to swallow: it is the
// platform's authoritative "a long-press happened" signal, and it is what
// starts CloudCLI's selection. The 600ms timer stays as a fallback for
// browsers that never raise it.
//
// Pure on purpose — the DOM plumbing lives in `mobileTerminalSelection.ts`.

export type ContextMenuAction =
  /** Leave the event alone: the browser and xterm handle it as usual. */
  | 'ignore'
  /** Swallow it, but do not touch the selection that is already on screen. */
  | 'suppress'
  /** Swallow it and open CloudCLI's own selection at the press point. */
  | 'suppress-and-select';

export type ContextMenuInput = {
  /** `PointerEvent.pointerType`, or null when the browser gives none. */
  pointerType: string | null;
  /** A finger is currently down on the terminal surface. */
  hasActiveTouch: boolean;
  /** CloudCLI's own selection UI is already on screen. */
  isSelecting: boolean;
};

/**
 * What the terminal should do with a context menu.
 *
 * A real mouse right-click is always ignored, so desktop keeps xterm's
 * right-click copy/paste exactly as it was. A touch long-press is taken over
 * instead of merely blocked: blocking alone is what removed the selector
 * entirely, because the timer that was supposed to replace it had already been
 * cancelled with the touch.
 *
 * `hasActiveTouch` is the fallback for browsers that report no `pointerType`.
 * When a selection is already up — raised by the timer on a device that does
 * not cancel, or by an earlier press — the event is swallowed but the
 * selection is left alone rather than restarted under the finger.
 */
export function resolveContextMenuAction({
  pointerType,
  hasActiveTouch,
  isSelecting,
}: ContextMenuInput): ContextMenuAction {
  if (pointerType === 'mouse') {
    return 'ignore';
  }

  const isTouchGesture = pointerType === 'touch' || hasActiveTouch;
  if (!isTouchGesture) {
    return isSelecting ? 'suppress' : 'ignore';
  }

  return isSelecting ? 'suppress' : 'suppress-and-select';
}
