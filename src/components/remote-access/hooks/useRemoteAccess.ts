import { useCallback, useEffect, useState } from 'react';

import { api } from '../../../utils/api';
import type { RemoteAccessStatus } from '../utils/remoteAccess';

type IssuedCode = { code: string; expiresAt: string };

async function readError(response: Response): Promise<string> {
  const body = await response.json().catch(() => null);
  return body?.error?.message ?? `Request failed (${response.status})`;
}

/**
 * Remote access status and actions for Settings (FT-M08). Loaded when the tab
 * opens and after each action; nothing polls.
 */
export function useRemoteAccess() {
  const [status, setStatus] = useState<RemoteAccessStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pairingCode, setPairingCode] = useState<IssuedCode | null>(null);
  const [enrollment, setEnrollment] = useState<IssuedCode | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await api.remoteAccess.status();
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      const body = await response.json();
      setStatus(body.data as RemoteAccessStatus);
      setError(null);
    } catch (caughtError) {
      setStatus(null);
      setError(caughtError instanceof Error ? caughtError.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(async (action: () => Promise<Response>): Promise<Record<string, unknown> | null> => {
    setError(null);
    try {
      const response = await action();
      if (!response.ok) {
        setError(await readError(response));
        return null;
      }
      const body = await response.json().catch(() => ({}));
      return (body?.data ?? {}) as Record<string, unknown>;
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Unknown error');
      return null;
    }
  }, []);

  const createPairingCode = useCallback(async () => {
    const data = await run(() => api.remoteAccess.createPairingCode());
    if (data && typeof data.code === 'string' && typeof data.expiresAt === 'string') {
      setPairingCode({ code: data.code, expiresAt: data.expiresAt });
    }
  }, [run]);

  const revokeSession = useCallback(async (sessionId: string) => {
    if (await run(() => api.remoteAccess.revokeSession(sessionId))) {
      await load();
    }
  }, [load, run]);

  const revokeAllSessions = useCallback(async () => {
    if (await run(() => api.remoteAccess.revokeAllSessions())) {
      await load();
    }
  }, [load, run]);

  const createEnrollment = useCallback(async (label: string) => {
    const data = await run(() => api.runtimeNodes.createEnrollment(label || null));
    if (data && typeof data.code === 'string' && typeof data.expiresAt === 'string') {
      setEnrollment({ code: data.code, expiresAt: data.expiresAt });
    }
  }, [run]);

  const revokeNode = useCallback(async (nodeId: string) => Boolean(await run(() => api.runtimeNodes.revoke(nodeId))), [run]);

  return {
    status,
    loading,
    error,
    pairingCode,
    enrollment,
    refresh: load,
    createPairingCode,
    revokeSession,
    revokeAllSessions,
    createEnrollment,
    revokeNode,
  };
}
