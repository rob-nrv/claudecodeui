/**
 * Framework-free presentation rules for Claude usage limits (FT-M07).
 *
 * The backend (`GET /api/claude-profiles/:id/live-usage`) is the only source of
 * truth: it has already decided whether each window is available, reset or
 * unreported, and whether the snapshot is fresh or stale. These helpers only
 * turn that decision into display data. They never produce a percentage for a
 * window the backend reported as unavailable.
 *
 * Contract (FT-M07-R1): the values come only from Claude Code's statusLine,
 * which runs in interactive Claude Code sessions. SDK/headless runs — every
 * CloudCLI chat — do not report them, so a snapshot is a last report with an
 * age, never a continuously live reading.
 */

export type ClaudeLiveUsageWindow =
  | { state: 'available'; usedPercentage: number; resetsAt: string }
  | { state: 'unavailable'; reason: 'not_reported' | 'window_reset' };

export type ClaudeStatusLineBridgeState =
  | 'not_installed'
  | 'installed'
  | 'outdated'
  | 'broken'
  | 'settings_unreadable';

export type ClaudeLiveUsage = {
  source: 'claude_statusline';
  bridge: {
    state: ClaudeStatusLineBridgeState;
    wrapsExistingStatusLine: boolean;
    hasUserStatusLine: boolean;
  };
  snapshot: {
    status: 'available' | 'unavailable';
    reason: 'no_snapshot' | 'snapshot_invalid' | 'attribution_mismatch' | 'snapshot_from_future' | null;
    capturedAt: string | null;
    freshness: 'fresh' | 'stale' | null;
  };
  fiveHour: ClaudeLiveUsageWindow;
  sevenDay: ClaudeLiveUsageWindow;
};

export type UsageLevel = 'normal' | 'elevated' | 'high';

export type ResetHint =
  | { kind: 'minutes'; minutes: number }
  | { kind: 'hours'; hours: number; minutes: number }
  | { kind: 'date'; date: Date };

export type CaptureAge =
  | { kind: 'justNow' }
  | { kind: 'minutes'; minutes: number }
  | { kind: 'hours'; hours: number }
  | { kind: 'days'; days: number };

/** What the account row offers for the capture bridge. */
export type BridgeAction = 'enable' | 'disable' | 'repair' | 'none';

const ELEVATED_USAGE_PERCENT = 75;
const HIGH_USAGE_PERCENT = 90;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Rounds for display without turning a small real value into "0%": an observed
 * 0.4% reads "<1%", while an observed exact 0 stays "0%".
 */
export function formatUsedPercentage(usedPercentage: number): string {
  if (usedPercentage > 0 && usedPercentage < 1) {
    return '<1%';
  }
  return `${Math.round(usedPercentage)}%`;
}

/** Level used for emphasis only; the percentage text is always shown alongside it. */
export function getUsageLevel(usedPercentage: number): UsageLevel {
  if (usedPercentage >= HIGH_USAGE_PERCENT) {
    return 'high';
  }
  if (usedPercentage >= ELEVATED_USAGE_PERCENT) {
    return 'elevated';
  }
  return 'normal';
}

/**
 * Relative reset hint for near resets and an absolute date for later ones.
 * Returns null once the reset time has passed: the backend then reports the
 * window as reset, and a "resets in -3 min" hint would be meaningless.
 */
export function getResetHint(resetsAt: string, now: number): ResetHint | null {
  const resetTime = Date.parse(resetsAt);
  if (Number.isNaN(resetTime) || resetTime <= now) {
    return null;
  }
  const remaining = resetTime - now;
  if (remaining < HOUR_MS) {
    return { kind: 'minutes', minutes: Math.max(1, Math.ceil(remaining / MINUTE_MS)) };
  }
  if (remaining < DAY_MS) {
    const totalMinutes = Math.round(remaining / MINUTE_MS);
    return { kind: 'hours', hours: Math.floor(totalMinutes / 60), minutes: totalMinutes % 60 };
  }
  return { kind: 'date', date: new Date(resetTime) };
}

/**
 * How long ago Claude Code last reported usage, coarse enough to read at a
 * glance ("3 d ago" rather than "4320 min ago"). Null when the capture time is
 * missing or unreadable; a capture time slightly ahead of this device's clock
 * reads as "just now" rather than as a negative age.
 */
export function getCaptureAge(capturedAt: string | null, now: number): CaptureAge | null {
  if (!capturedAt) {
    return null;
  }
  const captured = Date.parse(capturedAt);
  if (Number.isNaN(captured)) {
    return null;
  }
  const elapsed = Math.max(0, now - captured);
  if (elapsed < MINUTE_MS) {
    return { kind: 'justNow' };
  }
  if (elapsed < HOUR_MS) {
    return { kind: 'minutes', minutes: Math.floor(elapsed / MINUTE_MS) };
  }
  if (elapsed < DAY_MS) {
    return { kind: 'hours', hours: Math.floor(elapsed / HOUR_MS) };
  }
  return { kind: 'days', days: Math.floor(elapsed / DAY_MS) };
}

/** Maps the backend bridge state to the single action the row should offer. */
export function getBridgeAction(bridgeState: ClaudeStatusLineBridgeState): BridgeAction {
  switch (bridgeState) {
    case 'not_installed':
      return 'enable';
    case 'installed':
      return 'disable';
    case 'outdated':
    case 'broken':
      return 'repair';
    default:
      return 'none';
  }
}
