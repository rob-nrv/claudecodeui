import { useCallback, useEffect, useState } from 'react';

import { api } from '../../../utils/api';
import type { SessionLineage } from '../types/types';
import { readApiResult } from '../utils/handoff';

/**
 * Loads a session's handoff lineage from the backend.
 *
 * Lineage is never kept client-side between sessions: it is refetched whenever
 * the session changes, whenever `refreshKey` changes (e.g. a run starts or
 * ends), and on demand — so a reload or reconnect always shows persisted truth.
 */
export function useSessionLineage(sessionId: string | null | undefined, refreshKey?: unknown) {
  const [lineage, setLineage] = useState<SessionLineage | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (!sessionId) {
      setLineage(null);
      return undefined;
    }

    let cancelled = false;
    api.sessionLineage(sessionId)
      .then((response: Response) => readApiResult<SessionLineage>(response))
      .then((result) => {
        if (!cancelled) {
          setLineage(result);
        }
      })
      .catch(() => {
        // Keep what we already know about this session on a transient failure;
        // never show another session's lineage.
        if (!cancelled) {
          setLineage((previous) => (previous?.sessionId === sessionId ? previous : null));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId, refreshKey, reloadToken]);

  const refresh = useCallback(() => setReloadToken((token) => token + 1), []);

  return {
    lineage: lineage && lineage.sessionId === sessionId ? lineage : null,
    refresh,
  };
}
