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
export function useClaudeProfiles() {
  const [state, setState] = useState(INITIAL_CLAUDE_PROFILES_STATE);
  const controllerRef = useRef<ClaudeProfilesController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = createClaudeProfilesController(api.claudeProfiles, setState);
  }

  useEffect(() => {
    void controllerRef.current!.fetchProfiles();
  }, []);

  return { ...state, ...controllerRef.current };
}
