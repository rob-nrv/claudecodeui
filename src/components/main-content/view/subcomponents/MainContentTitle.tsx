import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import LLMProviderLogo from '../../../llm-provider-logo/LLMProviderLogo';
import type { AppTab, Project, ProjectSession } from '../../../../types/app';
import { usePlugins } from '../../../../contexts/PluginsContext';
import { getSessionTitle } from '../../../../utils/pageTitle';
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
  // A bound id that no longer resolves (profile removed) still renders,
  // deliberately, rather than silently disappearing.
  const sessionProvider = selectedSession?.__provider ?? selectedSession?.provider;
  const boundClaudeProfileId = selectedSession?.claudeProfileId ?? null;
  const claudeAccountLabel = useMemo(() => {
    if (sessionProvider !== 'claude' || !boundClaudeProfileId) {
      return null;
    }
    const profile = claudeProfiles.find((candidate) => candidate.id === boundClaudeProfileId);
    return profile?.displayName
      ?? t('mainContent.claudeAccountUnavailable', { defaultValue: 'Unknown account' });
  }, [sessionProvider, boundClaudeProfileId, claudeProfiles, t]);
  const projectSubtitle = claudeAccountLabel
    ? `${selectedProject.displayName} · ${claudeAccountLabel}`
    : selectedProject.displayName;

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
            <div className="truncate text-[11px] leading-tight text-muted-foreground">{projectSubtitle}</div>
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
