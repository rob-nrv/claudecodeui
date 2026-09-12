import type { LLMProvider } from '../../../types/app';
import type { ClaudeProfileConnectionState } from '../../settings/hooks/useClaudeProfiles';

// Mirrors the FT-M05 handoff payloads served by `session-handoff.service.ts`.

export type HandoffTargetUnavailableReason =
  | 'same_as_source'
  | 'profile_expired'
  | 'profile_not_authenticated'
  | 'runtime_unavailable';

export type HandoffSourceBlockedReason = 'source_running' | 'source_not_started' | 'source_no_workspace';

export type HandoffTargetOption = {
  provider: LLMProvider;
  claudeProfileId: string | null;
  label: string;
  connectionState: ClaudeProfileConnectionState | null;
  available: boolean;
  unavailableReason: HandoffTargetUnavailableReason | null;
};

export type HandoffTargets = {
  sourceSessionId: string;
  source: {
    title: string;
    provider: LLMProvider;
    claudeProfileId: string | null;
    label: string;
  };
  blockedReason: HandoffSourceBlockedReason | null;
  targets: HandoffTargetOption[];
};

export type HandoffRequest = {
  provider: LLMProvider;
  claudeProfileId?: string | null;
  note?: string;
};

export type CreatedHandoff = {
  handoffId: string;
  sessionId: string;
  provider: LLMProvider;
  claudeProfileId: string | null;
  projectPath: string;
  sessionName: string;
  sourceSessionId: string;
  taskRootSessionId: string;
};

export type SessionLineage = {
  sessionId: string;
  taskRootSessionId: string;
  incoming: {
    handoffId: string;
    createdAt: string;
    sourceSessionId: string;
    sourceExists: boolean;
    sourceTitle: string | null;
    sourceProvider: LLMProvider;
    sourceClaudeProfileId: string | null;
    sourceModel: string | null;
    sourceEffort: string | null;
    targetProvider: LLMProvider;
    targetClaudeProfileId: string | null;
    targetStarted: boolean;
    handoffPackage: string;
  } | null;
  outgoing: Array<{
    handoffId: string;
    createdAt: string;
    targetSessionId: string;
    targetTitle: string | null;
    targetProvider: LLMProvider;
    targetClaudeProfileId: string | null;
    targetStarted: boolean;
  }>;
};
