import { useCallback, useEffect, useState } from 'react';

import { api } from '../../../utils/api';
import type { RuntimeNodesListing } from '../utils/runtimeNodes';

type RuntimeNodesState = {
  listing: RuntimeNodesListing | null;
  loading: boolean;
  error: string | null;
};

const isListing = (value: unknown): value is RuntimeNodesListing =>
  Boolean(value)
  && typeof (value as RuntimeNodesListing).localNodeId === 'string'
  && Array.isArray((value as RuntimeNodesListing).nodes);

/**
 * Loads `GET /api/runtime-nodes` once per mount (FT-M07). There is no polling:
 * availability is decided by the backend from bounded probes, and a view is
 * refreshed only when the surface remounts or the caller asks for it.
 */
export function useRuntimeNodes() {
  const [state, setState] = useState<RuntimeNodesState>({ listing: null, loading: true, error: null });

  const load = useCallback(async (refresh: boolean) => {
    setState((current) => ({ ...current, loading: true }));
    try {
      const response = await api.runtimeNodes.list({ refresh });
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
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  const refresh = useCallback(() => load(true), [load]);

  return { ...state, refresh };
}
