import type { TFunction } from 'i18next';

import type { SessionActivityMap } from '../../../../hooks/useSessionProtection';
import type { Project, ProjectSession, LLMProvider } from '../../../../types/app';
import type { SessionWithProvider } from '../../types/types';

import SidebarSessionItem from './SidebarSessionItem';

type SidebarProjectSessionsProps = {
  project: Project;
  isExpanded: boolean;
  sessions: SessionWithProvider[];
  selectedSession: ProjectSession | null;
  initialSessionsLoaded: boolean;
  hasMoreSessions: boolean;
  isLoadingMoreSessions: boolean;
  activeSessions: SessionActivityMap;
  attentionSessionIds: ReadonlySet<string>;
  claudeProfileNameById: ReadonlyMap<string, string>;
  showRunningDetail?: boolean;
  currentTime: Date;
  editingSession: string | null;
  editingSessionName: string;
  onEditingSessionNameChange: (value: string) => void;
  onStartEditingSession: (sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (projectName: string, sessionId: string, summary: string, provider: LLMProvider) => void;
  onProjectSelect: (project: Project) => void;
  onSessionSelect: (session: SessionWithProvider, projectName: string) => void;
  onDeleteSession: (
    projectName: string,
    sessionId: string,
    sessionTitle: string,
    provider: LLMProvider,
  ) => void;
  onLoadMoreSessions: (projectId: string) => void;
  onNewSession: (project: Project) => void;
  t: TFunction;
};

function SessionListSkeleton() {
  return (
    <>
      {Array.from({ length: 3 }).map((_, index) => (
        <div key={index} className="flex h-[26px] items-center gap-3 pl-[13px]">
          <div className="h-[6px] w-[6px] rounded-full bg-c-active" />
          <div className="h-2.5 animate-pulse rounded bg-c-active" style={{ width: `${45 + index * 15}%` }} />
        </div>
      ))}
    </>
  );
}

export default function SidebarProjectSessions({
  project,
  isExpanded,
  sessions,
  selectedSession,
  initialSessionsLoaded,
  hasMoreSessions,
  isLoadingMoreSessions,
  activeSessions,
  attentionSessionIds,
  claudeProfileNameById,
  showRunningDetail = false,
  currentTime,
  editingSession,
  editingSessionName,
  onEditingSessionNameChange,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  onProjectSelect,
  onSessionSelect,
  onDeleteSession,
  onLoadMoreSessions,
  onNewSession,
  t,
}: SidebarProjectSessionsProps) {
  if (!isExpanded) {
    return null;
  }

  const hasSessions = sessions.length > 0;

  // The group header's "+" starts a session (Claude desktop has no separate
  // "New session" button inside a group).
  return (
    <div>
      {!initialSessionsLoaded ? (
        <SessionListSkeleton />
      ) : !hasSessions ? (
        <button
          type="button"
          className="flex h-[26px] w-full items-center rounded-md pl-[32px] text-left text-[13.5px] text-c-text-3 hover:bg-c-hover"
          onClick={() => {
            onProjectSelect(project);
            onNewSession(project);
          }}
        >
          {t('sessions.newSession')}
        </button>
      ) : (
        <>
          {sessions.map((session) => (
            <SidebarSessionItem
              key={session.id}
              project={project}
              session={session}
              selectedSession={selectedSession}
              isProcessing={activeSessions.has(session.id)}
              activity={activeSessions.get(session.id) ?? null}
              needsAttention={attentionSessionIds.has(session.id)}
              claudeProfileNameById={claudeProfileNameById}
              showRunningDetail={showRunningDetail}
              currentTime={currentTime}
              editingSession={editingSession}
              editingSessionName={editingSessionName}
              onEditingSessionNameChange={onEditingSessionNameChange}
              onStartEditingSession={onStartEditingSession}
              onCancelEditingSession={onCancelEditingSession}
              onSaveEditingSession={onSaveEditingSession}
              onProjectSelect={onProjectSelect}
              onSessionSelect={onSessionSelect}
              onDeleteSession={onDeleteSession}
              t={t}
            />
          ))}

          {hasMoreSessions && (
            <button
              type="button"
              className="flex h-[26px] w-full items-center rounded-md pl-[32px] text-left text-[13.5px] text-c-text-3 hover:bg-c-hover hover:text-c-text-2 disabled:opacity-60"
              onClick={() => onLoadMoreSessions(project.projectId)}
              disabled={isLoadingMoreSessions}
            >
              {isLoadingMoreSessions ? t('sessions.loadingSessions') : t('sessions.showMore', 'Show more')}
            </button>
          )}
        </>
      )}
    </div>
  );
}
