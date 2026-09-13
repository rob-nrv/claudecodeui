import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../../../utils/api';
import type { RuntimeNodesListing } from '../utils/runtimeNodes';

type RuntimeNodesState = {
  listing: RuntimeNodesListing | null;
  loading: boolean;
  error: string | null;
};

export type MapWorkspaceResult = { ok: true } | { ok: false; error: string };

/** Window focus re-reads the listing at most this often; there is no timer-based polling. */
const FOCUS_REFRESH_MIN_INTERVAL_MS = 15_000;

const isListing = (value: unknown): value is RuntimeNodesListing =>
  Boolean(value)
  && typeof (value as RuntimeNodesListing).localNodeId === 'string'
  && Array.isArray((value as RuntimeNodesListing).nodes);

/**
 * Loads `GET /api/runtime-nodes` (FT-M07), optionally about one project so each
 * node says whether that project's folder is usable there (FT-M08). There is
 * no polling: the listing is re-read on mount, when the project changes, on an
 * explicit refresh and — bounded — when the window regains focus.
 */
export function useRuntimeNodes(projectId: string | null = null) {
  const [state, setState] = useState<RuntimeNodesState>({ listing: null, loading: true, error: null });
  const lastLoadAtRef = useRef(0);

  const load = useCallback(async (refresh: boolean) => {
    lastLoadAtRef.current = Date.now();
    setState((current) => ({ ...current, loading: true }));
    try {
      const response = await api.runtimeNodes.list({ refresh, projectId });
      if (!response.ok) {
        throw new Error(`Runtime nodes request failed (${response.status})`);
      }
      const body = await response.json();
      if (!isListing(body?.data)) {
        throw new Error('Malformed runtime nodes response');
      }
      setState({ listing: body.data, loading: false, error: null });
    } catch (error) {
      // Never keep showing an older listing as if it were current.
      setState({ listing: null, loading: false, error: error instanceof Error ? error.message : 'Unknown error' });
    }
  }, [projectId]);

  useEffect(() => {
    void load(false);
  }, [load]);

  useEffect(() => {
    const handleFocus = () => {
      if (Date.now() - lastLoadAtRef.current >= FOCUS_REFRESH_MIN_INTERVAL_MS) {
        void load(false);
      }
    };
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [load]);

  const refresh = useCallback(() => load(true), [load]);

  /** Asks a remote node to verify a folder for the current project, then re-reads the listing. */
  const mapWorkspace = useCallback(async (nodeId: string, folderPath: string): Promise<MapWorkspaceResult> => {
    if (!projectId) {
      return { ok: false, error: 'No project is selected.' };
    }
    try {
      const response = await api.runtimeNodes.mapWorkspace(nodeId, projectId, folderPath);
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        const reason = body?.error?.details?.reason;
        const message = body?.error?.message ?? `Request failed (${response.status})`;
        return { ok: false, error: reason ? `${message} (${String(reason).replace(/_/g, ' ')})` : message };
      }
      await load(false);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }, [load, projectId]);

  return { ...state, refresh, mapWorkspace };
}
