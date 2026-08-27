import type { ClaudeProfile } from './useClaudeProfiles.types';

/**
 * Framework-free state machine backing `useClaudeProfiles`. Pulled out of the
 * hook so it can be unit-tested directly (no DOM/React renderer needed in
 * this repo's client test runner) — this is exactly where the "Save gives no
 * feedback" bug lived: the old hook set `loading: true` on *every*
 * `fetchProfiles()` call, including the background refresh a successful
 * create/rename/remove/verify triggers, so the whole section (its own
 * `loading && return null` gate) blinked away and back on every mutation.
 *
 * `loading` here is true only until the very first fetch settles.
 * `refreshing` covers every fetch after that, and the UI must never hide
 * content because of it.
 */
export type ClaudeProfilesState = {
  profiles: ClaudeProfile[];
  loading: boolean;
  refreshing: boolean;
  creating: boolean;
  pendingProfileId: string | null;
  error: string | null;
  /** Set right after a successful createProfile, for a one-shot success message. */
  justCreated: { id: string; displayName: string } | null;
};

export const INITIAL_CLAUDE_PROFILES_STATE: ClaudeProfilesState = {
  profiles: [],
  loading: true,
  refreshing: false,
  creating: false,
  pendingProfileId: null,
  error: null,
  justCreated: null,
};

type ApiResponseLike = {
  ok: boolean;
  json(): Promise<{
    success: boolean;
    data?: unknown;
    error?: { code?: string; message?: string };
  }>;
};

export type ClaudeProfilesApi = {
  list(): Promise<ApiResponseLike>;
  create(displayName: string): Promise<ApiResponseLike>;
  rename(id: string, displayName: string): Promise<ApiResponseLike>;
  setDefault(id: string): Promise<ApiResponseLike>;
  remove(id: string): Promise<ApiResponseLike>;
  verify(id: string): Promise<ApiResponseLike>;
};

type StateUpdater = (updater: (previous: ClaudeProfilesState) => ClaudeProfilesState) => void;

const FALLBACK_ERRORS = {
  list: 'Failed to load Claude accounts',
  create: 'Failed to create Claude account',
  rename: 'Failed to rename Claude account',
  setDefault: 'Failed to set default Claude account',
  remove: 'Failed to remove Claude account',
  verify: 'Failed to verify Claude account',
} as const;

const getApiErrorMessage = (
  payload: { error?: { message?: string } } | undefined,
  fallback: string,
): string => payload?.error?.message || fallback;

const toErrorMessage = (error: unknown): string => (
  error instanceof Error ? error.message : 'Unexpected error'
);

export type ClaudeProfilesController = {
  fetchProfiles(): Promise<void>;
  createProfile(displayName: string): Promise<boolean>;
  renameProfile(id: string, displayName: string): Promise<boolean>;
  setDefaultProfile(id: string): Promise<boolean>;
  removeProfile(id: string): Promise<boolean>;
  verifyProfile(id: string): Promise<boolean>;
  dismissJustCreated(): void;
};

export function createClaudeProfilesController(
  api: ClaudeProfilesApi,
  setState: StateUpdater,
): ClaudeProfilesController {
  let hasLoadedOnce = false;

  const fetchProfiles = async (): Promise<void> => {
    setState((previous) => ({
      ...previous,
      loading: hasLoadedOnce ? previous.loading : true,
      refreshing: hasLoadedOnce,
      error: null,
    }));

    try {
      const response = await api.list();
      const payload = await response.json() as {
        success: boolean;
        data?: { profiles: ClaudeProfile[] };
        error?: { message?: string };
      };

      if (!response.ok || !payload.success) {
        setState((previous) => ({ ...previous, error: getApiErrorMessage(payload, FALLBACK_ERRORS.list) }));
        return;
      }

      setState((previous) => ({ ...previous, profiles: payload.data?.profiles ?? [] }));
    } catch (caughtError) {
      console.error('Error fetching Claude profiles:', caughtError);
      setState((previous) => ({ ...previous, error: toErrorMessage(caughtError) }));
    } finally {
      hasLoadedOnce = true;
      setState((previous) => ({ ...previous, loading: false, refreshing: false }));
    }
  };

  /**
   * Every mutation follows the same contract: resolve `true` only once the
   * profile list has actually been refreshed from the server, resolve
   * `false` (and leave `error` set) on any failure, and never mark success
   * on a non-2xx / `success: false` response.
   */
  const runMutation = async (
    action: () => Promise<ApiResponseLike>,
    fallbackError: string,
    onSuccess?: (payload: { data?: { profile: ClaudeProfile } }) => void,
  ): Promise<boolean> => {
    try {
      const response = await action();
      const payload = await response.json() as { success: boolean; data?: { profile: ClaudeProfile }; error?: { message?: string } };

      if (!response.ok || !payload.success) {
        setState((previous) => ({ ...previous, error: getApiErrorMessage(payload, fallbackError) }));
        return false;
      }

      await fetchProfiles();
      onSuccess?.(payload);
      return true;
    } catch (caughtError) {
      console.error(fallbackError, caughtError);
      setState((previous) => ({ ...previous, error: toErrorMessage(caughtError) }));
      return false;
    }
  };

  const createProfile = async (displayName: string): Promise<boolean> => {
    const trimmed = displayName.trim();
    if (!trimmed) {
      return false;
    }

    setState((previous) => ({ ...previous, creating: true, error: null, justCreated: null }));
    try {
      return await runMutation(
        () => api.create(trimmed),
        FALLBACK_ERRORS.create,
        (payload) => {
          const created = payload.data?.profile;
          if (created) {
            setState((previous) => ({ ...previous, justCreated: { id: created.id, displayName: created.displayName } }));
          }
        },
      );
    } finally {
      setState((previous) => ({ ...previous, creating: false }));
    }
  };

  const renameProfile = (id: string, displayName: string): Promise<boolean> => {
    const trimmed = displayName.trim();
    if (!trimmed) {
      return Promise.resolve(false);
    }
    return runMutation(() => api.rename(id, trimmed), FALLBACK_ERRORS.rename);
  };

  const setDefaultProfile = (id: string): Promise<boolean> =>
    runMutation(() => api.setDefault(id), FALLBACK_ERRORS.setDefault);

  const removeProfile = (id: string): Promise<boolean> =>
    runMutation(() => api.remove(id), FALLBACK_ERRORS.remove);

  const verifyProfile = async (id: string): Promise<boolean> => {
    setState((previous) => ({ ...previous, pendingProfileId: id }));
    try {
      return await runMutation(() => api.verify(id), FALLBACK_ERRORS.verify);
    } finally {
      setState((previous) => ({ ...previous, pendingProfileId: null }));
    }
  };

  const dismissJustCreated = (): void => {
    setState((previous) => ({ ...previous, justCreated: null }));
  };

  return {
    fetchProfiles,
    createProfile,
    renameProfile,
    setDefaultProfile,
    removeProfile,
    verifyProfile,
    dismissJustCreated,
  };
}
