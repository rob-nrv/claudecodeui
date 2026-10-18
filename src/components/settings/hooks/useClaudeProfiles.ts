import { useEffect, useRef, useState } from 'react';

import { api } from '../../../utils/api';

import {
  createClaudeProfilesController,
  INITIAL_CLAUDE_PROFILES_STATE,
  type ClaudeProfilesController,
} from './claudeProfilesController';

export type {
  ClaudeProfile,
  ClaudeProfileConnectionState,
  ClaudeProfileVerifiedIdentity,
} from './useClaudeProfiles.types';

/**
 * Backs the Settings → Agents → Claude → Account → Claude Accounts section
 * (`ClaudeAccountsSection.tsx`). Thin React wrapper: all the actual state
 * transitions (including the "don't hide the section during a background
 * refresh" fix) live in the framework-free `claudeProfilesController.ts`,
 * which is unit-tested directly.
 */
/**
 * Several surfaces hold their own instance (Settings, the chat composer's
 * account picker, the sidebar account menu). A successful mutation in one of
 * them broadcasts this event so the others re-read the backend list instead of
 * keeping a stale Default.
 */
export const CLAUDE_PROFILES_CHANGED_EVENT = 'cloudcli:claude-profiles-changed';

const notifyProfilesChanged = (succeeded: boolean): boolean => {
  if (succeeded && typeof window !== 'undefined') {
    window.dispatchEvent(new Event(CLAUDE_PROFILES_CHANGED_EVENT));
  }
  return succeeded;
};

export function useClaudeProfiles() {
  const [state, setState] = useState(INITIAL_CLAUDE_PROFILES_STATE);
  const controllerRef = useRef<ClaudeProfilesController | null>(null);
  if (!controllerRef.current) {
    const controller = createClaudeProfilesController(api.claudeProfiles, setState);
    controllerRef.current = {
      ...controller,
      createProfile: async (displayName) => notifyProfilesChanged(await controller.createProfile(displayName)),
      renameProfile: async (id, displayName) => notifyProfilesChanged(await controller.renameProfile(id, displayName)),
      setDefaultProfile: async (id) => notifyProfilesChanged(await controller.setDefaultProfile(id)),
      removeProfile: async (id) => notifyProfilesChanged(await controller.removeProfile(id)),
      verifyProfile: async (id) => notifyProfilesChanged(await controller.verifyProfile(id)),
    };
  }

  useEffect(() => {
    const controller = controllerRef.current!;
    void controller.fetchProfiles();
    const refetch = () => void controller.fetchProfiles();
    window.addEventListener(CLAUDE_PROFILES_CHANGED_EVENT, refetch);
    return () => window.removeEventListener(CLAUDE_PROFILES_CHANGED_EVENT, refetch);
  }, []);

  return { ...state, ...controllerRef.current };
}
