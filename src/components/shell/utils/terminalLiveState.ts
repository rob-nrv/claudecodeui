// Whether the terminal is showing live output or a scrolled-back position.
//
// Derived from the xterm buffer on every call rather than mirrored into a
// React boolean: `viewportY` (the first visible line, xterm's `ydisp`) and
// `baseY` (the first line of the live viewport, xterm's `ybase`) are the same
// values xterm itself uses to decide whether new output should follow the
// bottom, so a value read from them can never disagree with what is on screen.

export type ScrollableTerminalBuffer = {
  readonly viewportY: number;
  readonly baseY: number;
};

export type ScrollableTerminal = {
  readonly buffer: {
    readonly active: ScrollableTerminalBuffer;
  };
};

export function isTerminalScrolledBack(terminal: ScrollableTerminal | null | undefined): boolean {
  const buffer = terminal?.buffer?.active;
  if (!buffer) {
    return false;
  }

  return buffer.viewportY < buffer.baseY;
}
