// The "ask a human to do a physical thing, then find out what happened"
// state machine. No real terminal I/O or real timers here — `readLine`,
// `now` and `sleep` are all injectable so the state transitions themselves
// are testable in milliseconds, without a person or a device.

/** The fixed banner shape from the mission brief, reusable for every physical-action prompt. */
export function formatHumanActionBanner({ title, instructions }) {
  const bar = '='.repeat(50);
  const body = Array.isArray(instructions) ? instructions : [instructions];
  return [bar, 'HUMAN ACTION REQUIRED', title, ...body, bar].join('\n');
}

/**
 * Blocks (via the injected `readLine`) until the operator confirms they
 * performed the action, and returns exactly when that happened — this is
 * the "did the action start" edge, separate from "what was the observable
 * result", which `waitForObservableOutcome` below determines.
 */
export async function promptAndConfirm({ banner, readLine, now = Date.now, write = (text) => process.stdout.write(text) }) {
  write(`${banner}\n`);
  await readLine();
  return { confirmedAt: now() };
}

/**
 * Polls `detect()` until it reports the action's outcome or `timeoutMs`
 * elapses. `detect` returns `null` while still undecided, or a plain
 * result object once it has one — this file never guesses at what
 * "detected" means for a given test; that's the caller's job.
 */
export async function waitForObservableOutcome({ detect, timeoutMs, pollIntervalMs = 1000, now = Date.now, sleep, onTick }) {
  const start = now();
  for (;;) {
    const elapsedMs = now() - start;
    if (elapsedMs >= timeoutMs) {
      return { outcome: 'timed_out', elapsedMs, detail: null };
    }
    const detected = await detect();
    if (detected !== null && detected !== undefined) {
      return { outcome: 'detected', elapsedMs: now() - start, detail: detected };
    }
    onTick?.(elapsedMs);
    await sleep(pollIntervalMs);
  }
}

/**
 * Combines the two steps into the full checkpoint: confirm, then wait for
 * the observable result, capped at `timeoutMs` from confirmation. If
 * `detect` throws, the checkpoint fails closed (`outcome: 'error'`) rather
 * than being mistaken for a timeout or a real detection.
 */
export async function runHumanCheckpoint({ banner, readLine, detect, timeoutMs, pollIntervalMs = 1000, now = Date.now, sleep, onTick, write }) {
  const confirmation = await promptAndConfirm({ banner, readLine, now, ...(write ? { write } : {}) });
  try {
    const result = await waitForObservableOutcome({ detect, timeoutMs, pollIntervalMs, now, sleep, onTick });
    return { ...result, confirmedAt: confirmation.confirmedAt };
  } catch (error) {
    return { outcome: 'error', elapsedMs: now() - confirmation.confirmedAt, detail: null, error: error instanceof Error ? error.message : String(error), confirmedAt: confirmation.confirmedAt };
  }
}
