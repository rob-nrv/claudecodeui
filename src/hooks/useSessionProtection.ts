import { useCallback, useState } from 'react';

import { nextAfterMarkIdle, nextAfterMarkProcessing, nextAfterSync } from './sessionActivityReducers';

export interface SessionActivity {
  /** Provider-supplied status line; null renders the default activity label. */
  statusText: string | null;
  canInterrupt: boolean;
  /**
   * When this request was first marked as processing (client clock). Drives
   * the elapsed-time display and the stale `chat_subscribed` idle-ack guard.
   */
  startedAt: number;
  /**
   * True only when the server-reported run has a real pending tool/permission
   * approval (from `providerRuntimeService.getPendingApprovalsForSession`).
   * Never inferred locally from silence — only `syncProcessingSessions` sets
   * this, since it is the only channel with visibility into sessions the
   * user isn't currently viewing.
   */
  waiting: boolean;
  /** The Claude account this run is bound to, or null (non-Claude / unbound). */
  claudeProfileId: string | null;
}

export type SessionActivityMap = ReadonlyMap<string, SessionActivity>;

export type SessionActivitySnapshot = {
  sessionId: string;
  statusText?: string | null;
  canInterrupt?: boolean;
  startedAt?: number;
  waiting?: boolean;
  claudeProfileId?: string | null;
};

export type MarkSessionProcessing = (
  sessionId?: string | null,
  activity?: { statusText?: string | null; canInterrupt?: boolean },
) => void;

export type MarkSessionIdle = (
  sessionId?: string | null,
  opts?: { ifStartedBefore?: number },
) => void;

export type SyncProcessingSessions = (
  sessions: readonly SessionActivitySnapshot[],
) => void;

/**
 * Single source of truth for which sessions are actively processing a
 * request. Everything the chat UI shows (activity indicator, abort
 * availability, status text) is derived from this map; terminal events
 * (`complete`, abort, an authoritative idle subscribe ack) delete the entry
 * atomically. Session ids are always concrete (allocated before the first
 * send), so entries are keyed by real session ids only.
 *
 * The actual state-transition logic lives in `sessionActivityReducers.ts` as
 * plain functions over `prev -> next`, so it can be unit-tested without a
 * DOM/React renderer; this hook is a thin `useState` wrapper around them.
 */
export function useSessionProtection() {
  const [processingSessions, setProcessingSessions] = useState<Map<string, SessionActivity>>(
    new Map(),
  );

  const markSessionProcessing = useCallback<MarkSessionProcessing>((sessionId, activity) => {
    if (!sessionId) {
      return;
    }

    setProcessingSessions((prev) => nextAfterMarkProcessing(prev, sessionId, activity) as Map<string, SessionActivity>);
  }, []);

  const markSessionIdle = useCallback<MarkSessionIdle>((sessionId, opts) => {
    if (!sessionId) {
      return;
    }

    setProcessingSessions((prev) => nextAfterMarkIdle(prev, sessionId, opts) as Map<string, SessionActivity>);
  }, []);

  const syncProcessingSessions = useCallback<SyncProcessingSessions>((sessions) => {
    const now = Date.now();
    setProcessingSessions((prev) => nextAfterSync(prev, sessions, now) as Map<string, SessionActivity>);
  }, []);

  return {
    processingSessions,
    markSessionProcessing,
    markSessionIdle,
    syncProcessingSessions,
  };
}
