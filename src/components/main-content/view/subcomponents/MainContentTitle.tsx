import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import LLMProviderLogo from '../../../llm-provider-logo/LLMProviderLogo';
import type { AppTab, Project, ProjectSession } from '../../../../types/app';
import { usePlugins } from '../../../../contexts/PluginsContext';
import { getSessionTitle } from '../../../../utils/pageTitle';
import { resolveExecutionIdentity, shouldShowProfileIdentity } from '../../../../shared/identity';
import ExecutionIdentityBadge from '../../../identity/view/ExecutionIdentityBadge';
import { useClaudeProfiles } from '../../../settings/hooks/useClaudeProfiles';

type MainContentTitleProps = {
  activeTab: AppTab;
  selectedProject: Project;
  selectedSession: ProjectSession | null;
  shouldShowTasksTab: boolean;
};

function getTabTitle(activeTab: AppTab, shouldShowTasksTab: boolean, t: (key: string) => string, pluginDisplayName?: string) {
  if (activeTab.startsWith('plugin:') && pluginDisplayName) {
    return pluginDisplayName;
  }

  if (activeTab === 'files') {
    return t('mainContent.projectFiles');
  }

  if (activeTab === 'git') {
    return t('tabs.git');
  }

  if (activeTab === 'tasks' && shouldShowTasksTab) {
    return 'TaskMaster';
  }

  if (activeTab === 'browser') {
    return t('tabs.browser');
  }

  return 'Project';
}

export default function MainContentTitle({
  activeTab,
  selectedProject,
  selectedSession,
  shouldShowTasksTab,
}: MainContentTitleProps) {
  const { t } = useTranslation();
  const { plugins } = usePlugins();
  const { profiles: claudeProfiles } = useClaudeProfiles();

  const pluginDisplayName = activeTab.startsWith('plugin:')
    ? plugins.find((p) => p.name === activeTab.replace('plugin:', ''))?.displayName
    : undefined;

  const showSessionIcon = activeTab === 'chat' && Boolean(selectedSession);
  const showChatNewSession = activeTab === 'chat' && !selectedSession;

  // Discreet "which account did this run under" indicator — only meaningful
  // for Claude sessions bound to an account (CLOUDCLI_EXTENSION_PLAN.md F5).
  // The label comes from the session's persisted `claudeProfileId`, never from
  // the current global selection, and a bound id that no longer resolves still
  // renders (as "Unknown account") rather than silently disappearing.
  const claudeProfileNameById = useMemo(
    () => new Map(claudeProfiles.map((profile) => [profile.id, profile.displayName])),
    [claudeProfiles],
  );
  const sessionProvider = selectedSession?.__provider ?? selectedSession?.provider;
  const executionIdentity = useMemo(() => resolveExecutionIdentity({
    provider: sessionProvider,
    claudeProfileId: selectedSession?.claudeProfileId ?? null,
    profileNamesById: claudeProfileNameById,
    unresolvedLabel: t('mainContent.claudeAccountUnavailable', { defaultValue: 'Unknown account' }),
  }), [sessionProvider, selectedSession?.claudeProfileId, claudeProfileNameById, t]);

  // With a single registered account there is no ambiguity to resolve, so the
  // header stays silent about accounts entirely.
  const showExecutionIdentity = shouldShowProfileIdentity(claudeProfiles.length);

  return (
    <div className="scrollbar-hide flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
      {showSessionIcon && (
        <div className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
          <LLMProviderLogo provider={selectedSession?.__provider} className="h-4 w-4" />
        </div>
      )}

      <div className="min-w-0 flex-1">
        {activeTab === 'chat' && selectedSession ? (
          <div className="min-w-0">
            <h2 title={getSessionTitle(selectedSession)} className="truncate text-sm font-semibold leading-tight text-foreground">
              {getSessionTitle(selectedSession)}
            </h2>
            <div className="flex min-w-0 items-center gap-1.5 text-[11px] leading-tight text-muted-foreground">
              <span className="min-w-0 truncate" title={selectedProject.displayName}>
                {selectedProject.displayName}
              </span>
              {showExecutionIdentity && executionIdentity.profileLabel && (
                <>
                  <span aria-hidden="true" className="flex-shrink-0">·</span>
                  <ExecutionIdentityBadge identity={executionIdentity} className="max-w-[45%] flex-shrink-0" />
                </>
              )}
            </div>
          </div>
        ) : showChatNewSession ? (
          <div className="min-w-0">
            <h2 className="text-base font-semibold leading-tight text-foreground">{t('mainContent.newSession')}</h2>
            <div className="truncate text-xs leading-tight text-muted-foreground">{selectedProject.displayName}</div>
          </div>
        ) : (
          <div className="min-w-0">
            <h2 className="text-sm font-semibold leading-tight text-foreground">
              {getTabTitle(activeTab, shouldShowTasksTab, t, pluginDisplayName)}
            </h2>
            <div className="truncate text-[11px] leading-tight text-muted-foreground">{selectedProject.displayName}</div>
          </div>
        )}
      </div>
    </div>
  );
}
