import type { SessionActivity, SessionActivitySnapshot } from './useSessionProtection';

/**
 * Framework-free reducers behind `useSessionProtection`. Pulled out of the
 * hook (same pattern as `claudeProfilesController.ts`) so the reconciliation
 * logic — the part responsible for not showing a phantom "Computing…" once
 * the backend no longer has a matching run — can be unit-tested directly,
 * with no DOM/React renderer needed in this repo's client test runner.
 */

/** How long a just-started, not-yet-server-confirmed entry survives a sync that doesn't mention it. */
export const LOCAL_ACTIVITY_GRACE_MS = 10_000;

export const sessionActivityMapsMatch = (
  left: ReadonlyMap<string, SessionActivity>,
  right: ReadonlyMap<string, SessionActivity>,
): boolean => {
  if (left.size !== right.size) {
    return false;
  }

  for (const [sessionId, leftActivity] of left) {
    const rightActivity = right.get(sessionId);
    if (
      !rightActivity
      || leftActivity.statusText !== rightActivity.statusText
      || leftActivity.canInterrupt !== rightActivity.canInterrupt
      || leftActivity.startedAt !== rightActivity.startedAt
      || leftActivity.waiting !== rightActivity.waiting
      || leftActivity.claudeProfileId !== rightActivity.claudeProfileId
    ) {
      return false;
    }
  }

  return true;
};

export function nextAfterMarkProcessing(
  prev: ReadonlyMap<string, SessionActivity>,
  sessionId: string,
  activity?: { statusText?: string | null; canInterrupt?: boolean },
): ReadonlyMap<string, SessionActivity> {
  const existing = prev.get(sessionId);
  const next: SessionActivity = {
    statusText: activity?.statusText !== undefined ? activity.statusText : existing?.statusText ?? null,
    canInterrupt: activity?.canInterrupt ?? existing?.canInterrupt ?? true,
    startedAt: existing?.startedAt ?? Date.now(),
    waiting: existing?.waiting ?? false,
    claudeProfileId: existing?.claudeProfileId ?? null,
  };

  if (existing && existing.statusText === next.statusText && existing.canInterrupt === next.canInterrupt) {
    return prev;
  }

  const updated = new Map(prev);
  updated.set(sessionId, next);
  return updated;
}

export function nextAfterMarkIdle(
  prev: ReadonlyMap<string, SessionActivity>,
  sessionId: string,
  opts?: { ifStartedBefore?: number },
): ReadonlyMap<string, SessionActivity> {
  const existing = prev.get(sessionId);
  if (!existing) {
    return prev;
  }

  // Guard against stale `chat_subscribed` idle acks: if a new request
  // started after the subscribe was sent, the idle ack describes the older
  // request and must not clear the newer one.
  if (opts?.ifStartedBefore !== undefined && existing.startedAt >= opts.ifStartedBefore) {
    return prev;
  }

  const updated = new Map(prev);
  updated.delete(sessionId);
  return updated;
}

export function nextAfterSync(
  prev: ReadonlyMap<string, SessionActivity>,
  sessions: readonly SessionActivitySnapshot[],
  now: number,
): ReadonlyMap<string, SessionActivity> {
  const incoming = new Map<string, SessionActivitySnapshot>();
  for (const session of sessions) {
    if (!session.sessionId) {
      continue;
    }
    incoming.set(session.sessionId, session);
  }

  const updated = new Map<string, SessionActivity>();

  for (const [sessionId, snapshot] of incoming) {
    const existing = prev.get(sessionId);
    const snapshotStartedAt =
      typeof snapshot.startedAt === 'number' && Number.isFinite(snapshot.startedAt) && snapshot.startedAt > 0
        ? snapshot.startedAt
        : undefined;

    updated.set(sessionId, {
      statusText: snapshot.statusText !== undefined ? snapshot.statusText : existing?.statusText ?? null,
      canInterrupt: snapshot.canInterrupt ?? existing?.canInterrupt ?? true,
      startedAt: snapshotStartedAt ?? existing?.startedAt ?? now,
      waiting: snapshot.waiting ?? existing?.waiting ?? false,
      claudeProfileId:
        snapshot.claudeProfileId !== undefined ? snapshot.claudeProfileId : existing?.claudeProfileId ?? null,
    });
  }

  // A session the server doesn't mention is only kept around briefly, and
  // only if it was never server-confirmed yet (a just-sent optimistic
  // start racing the next poll) — this is what stops a run whose backend
  // record is gone (crashed process, server restart) from staying
  // "Running" forever once this grace window elapses.
  for (const [sessionId, activity] of prev) {
    if (!incoming.has(sessionId) && now - activity.startedAt < LOCAL_ACTIVITY_GRACE_MS) {
      updated.set(sessionId, activity);
    }
  }

  return sessionActivityMapsMatch(prev, updated) ? prev : updated;
}
