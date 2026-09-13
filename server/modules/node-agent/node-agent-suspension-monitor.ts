/**
 * Detects that this process was frozen (FT-M09): a timer that should tick every
 * `intervalMs` arriving much later means the OS suspended the process — device
 * sleep, Android's cached-app freezer, a laptop lid. It is the one piece of
 * background-execution evidence a process can produce about itself, and it
 * can only DISPROVE background execution; a quiet monitor proves nothing.
 */
export function createProcessSuspensionMonitor(options: {
  intervalMs?: number;
  thresholdMs?: number;
  now?: () => number;
} = {}) {
  const intervalMs = options.intervalMs ?? 5_000;
  const thresholdMs = options.thresholdMs ?? 30_000;
  const now = options.now ?? Date.now;
  const startedAt = now();
  let lastTickAt = startedAt;
  let last: { at: number; durationMs: number } | null = null;
  let timer: NodeJS.Timeout | null = null;

  const tick = () => {
    const at = now();
    const lateBy = at - lastTickAt - intervalMs;
    if (lateBy > thresholdMs) {
      last = { at, durationMs: lateBy };
    }
    lastTickAt = at;
  };

  return {
    startedAt,
    start(): void {
      if (timer) return;
      lastTickAt = now();
      timer = setInterval(tick, intervalMs);
      timer.unref?.();
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
    },
    /** Exposed for tests; the interval calls it in production. */
    tick,
    lastSuspension(): { at: number; durationMs: number } | null {
      return last ? { ...last } : null;
    },
  };
}
