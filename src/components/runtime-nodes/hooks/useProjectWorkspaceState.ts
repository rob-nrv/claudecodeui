import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../../../utils/api';
import type { ProjectWorkspaceState } from '../utils/runtimeNodes';

type WorkspaceStateResult = {
  workspace: ProjectWorkspaceState | null;
  loading: boolean;
  error: string | null;
};

const isWorkspaceState = (value: unknown): value is ProjectWorkspaceState =>
  Boolean(value) && typeof (value as ProjectWorkspaceState).state === 'string';

/**
 * Reads the state of one project's working copy on one node (FT-M09). Loaded
 * when the target changes and on explicit refresh only — never polled, since
 * the node runs Git to answer.
 */
export function useProjectWorkspaceState(nodeId: string | null, projectId: string | null, enabled: boolean) {
  const [result, setResult] = useState<WorkspaceStateResult>({ workspace: null, loading: false, error: null });
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    if (!enabled || !nodeId || !projectId) {
      setResult({ workspace: null, loading: false, error: null });
      return;
    }
    const request = ++requestRef.current;
    setResult({ workspace: null, loading: true, error: null });
    try {
      const response = await api.runtimeNodes.workspaceState(nodeId, projectId);
      const body = await response.json().catch(() => null);
      if (request !== requestRef.current) return;
      if (!response.ok || !isWorkspaceState(body?.data?.workspace)) {
        setResult({ workspace: null, loading: false, error: body?.error?.message ?? `Request failed (${response.status})` });
        return;
      }
      setResult({ workspace: body.data.workspace, loading: false, error: null });
    } catch (error) {
      if (request !== requestRef.current) return;
      setResult({ workspace: null, loading: false, error: error instanceof Error ? error.message : 'Unknown error' });
    }
  }, [enabled, nodeId, projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  return { ...result, refresh: load };
}
