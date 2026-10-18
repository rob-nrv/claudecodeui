import { useEffect, useRef } from 'react';
import { Edit3, MoreHorizontal, Plus, Star, Trash2 } from 'lucide-react';
import type { TFunction } from 'i18next';

import { ActionMenu, type ActionMenuItem } from '../../../../shared/view/ui';
import { cn } from '../../../../lib/utils';
import type { Project, ProjectSession, LLMProvider } from '../../../../types/app';
import type { SessionActivityMap } from '../../../../hooks/useSessionProtection';
import type { MCPServerStatus, SessionWithProvider } from '../../types/types';

import SidebarProjectSessions from './SidebarProjectSessions';

type SidebarProjectItemProps = {
  project: Project;
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  isExpanded: boolean;
  isDeleting: boolean;
  isStarred: boolean;
  editingProject: string | null;
  editingName: string;
  sessions: SessionWithProvider[];
  initialSessionsLoaded: boolean;
  isLoadingMoreSessions: boolean;
  currentTime: Date;
  editingSession: string | null;
  editingSessionName: string;
  tasksEnabled: boolean;
  mcpServerStatus: MCPServerStatus;
  onEditingNameChange: (name: string) => void;
  onToggleProject: (projectName: string) => void;
  onProjectSelect: (project: Project) => void;
  onToggleStarProject: (projectName: string) => void;
  onStartEditingProject: (project: Project) => void;
  onCancelEditingProject: () => void;
  onSaveProjectName: (projectName: string) => void;
  onDeleteProject: (project: Project) => void;
  onSessionSelect: (session: SessionWithProvider, projectName: string) => void;
  onDeleteSession: (
    projectName: string,
    sessionId: string,
    sessionTitle: string,
    provider: LLMProvider,
  ) => void;
  onLoadMoreSessions: (projectId: string) => void;
  activeSessions: SessionActivityMap;
  attentionSessionIds: ReadonlySet<string>;
  claudeProfileNameById: ReadonlyMap<string, string>;
  showRunningDetail?: boolean;
  onNewSession: (project: Project) => void;
  onEditingSessionNameChange: (value: string) => void;
  onStartEditingSession: (sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (projectName: string, sessionId: string, summary: string, provider: LLMProvider) => void;
  t: TFunction;
};

const getSessionCountDisplay = (project: Project, sessions: SessionWithProvider[]): string => {
  const total = Number(project.sessionMeta?.total ?? sessions.length);
  return String(total);
};

export default function SidebarProjectItem({
  project,
  selectedProject,
  selectedSession,
  isExpanded,
  isDeleting,
  isStarred,
  editingProject,
  editingName,
  sessions,
  initialSessionsLoaded,
  isLoadingMoreSessions,
  currentTime,
  editingSession,
  editingSessionName,
  tasksEnabled: _tasksEnabled,
  mcpServerStatus: _mcpServerStatus,
  onEditingNameChange,
  onToggleProject,
  onProjectSelect,
  onToggleStarProject,
  onStartEditingProject,
  onCancelEditingProject,
  onSaveProjectName,
  onDeleteProject,
  onSessionSelect,
  onDeleteSession,
  onLoadMoreSessions,
  activeSessions,
  attentionSessionIds,
  claudeProfileNameById,
  showRunningDetail = false,
  onNewSession,
  onEditingSessionNameChange,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  t,
}: SidebarProjectItemProps) {
  // Project identity is tracked by the DB-assigned `projectId` everywhere
  // after the projectName → projectId migration.
  const isSelected = selectedProject?.projectId === project.projectId;
  const isEditing = editingProject === project.projectId;
  const sessionCountDisplay = getSessionCountDisplay(project, sessions);
  const mobileRenameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isEditing || !mobileRenameInputRef.current) {
      return;
    }

    let animationFrame = 0;
    const revealInput = () => {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(() => {
        mobileRenameInputRef.current?.scrollIntoView({ block: 'center', inline: 'nearest' });
      });
    };

    revealInput();
    window.visualViewport?.addEventListener('resize', revealInput);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.visualViewport?.removeEventListener('resize', revealInput);
    };
  }, [isEditing]);

  const toggleProject = () => onToggleProject(project.projectId);
  const toggleStarProject = () => onToggleStarProject(project.projectId);

  const saveProjectName = () => {
    onSaveProjectName(project.projectId);
  };

  const selectAndToggleProject = () => {
    if (selectedProject?.projectId !== project.projectId) {
      onProjectSelect(project);
    }

    toggleProject();
  };

  const projectMenuItems: ActionMenuItem[] = [
    {
      key: 'new-session',
      label: t('sessions.newSession'),
      icon: Plus,
      onSelect: () => {
        onProjectSelect(project);
        onNewSession(project);
      },
    },
    {
      key: 'star',
      label: isStarred ? t('tooltips.removeFromFavorites') : t('tooltips.addToFavorites'),
      icon: Star,
      onSelect: toggleStarProject,
    },
    { key: 'rename', label: t('tooltips.renameProject'), icon: Edit3, onSelect: () => onStartEditingProject(project) },
    { key: 'delete', label: t('tooltips.deleteProject'), icon: Trash2, isDanger: true, showDividerBefore: true, onSelect: () => onDeleteProject(project) },
  ];

  // Claude desktop group header (live app, 2026-10-18): a 28px row, 12.5px
  // muted label at x=19, "+" (new session) centred at x=264.5, 10.5px after
  // the previous group (18px after the nav); session rows follow at a 30px pitch.
  return (
    <div className={cn('mt-[10.5px] first:mt-[18px]', isDeleting && 'pointer-events-none opacity-50')}>
      <div className="group/project flex h-[28px] items-center pl-[16px] pr-[11.5px]">
        {isEditing ? (
          <input
            ref={mobileRenameInputRef}
            type="text"
            value={editingName}
            onChange={(event) => onEditingNameChange(event.target.value)}
            className="h-[24px] min-w-0 flex-1 rounded-md border border-c-input-border bg-c-search px-2 text-[13px] text-c-text outline-none"
            placeholder={t('projects.projectNamePlaceholder')}
            autoFocus
            autoComplete="off"
            onBlur={onCancelEditingProject}
            onKeyDown={(event) => {
              if (event.key === 'Enter') saveProjectName();
              if (event.key === 'Escape') onCancelEditingProject();
            }}
          />
        ) : (
          <button
            type="button"
            onClick={selectAndToggleProject}
            title={project.fullPath}
            aria-expanded={isExpanded}
            className={cn(
              'flex min-w-0 flex-1 items-center gap-1 pl-[3px] text-left text-[12.5px] leading-5 text-c-text-3 hover:text-c-text-2',
              isSelected && 'text-c-text-2',
            )}
          >
            <span className="truncate">{project.displayName}</span>
            {isStarred && <Star className="h-2.5 w-2.5 flex-shrink-0 fill-current" />}
            {!isExpanded && <span className="flex-shrink-0 tabular-nums text-c-text-3/70">· {sessionCountDisplay}</span>}
          </button>
        )}
        {!isEditing && (
          <div className="flex flex-shrink-0 items-center gap-1">
            <ActionMenu
              label={t('tooltips.projectActions', 'Project actions')}
              ariaLabel={t('tooltips.projectActions', 'Project actions')}
              icon={MoreHorizontal}
              iconOnly
              portal
              variant="ghost"
              items={projectMenuItems}
              triggerClassName="h-5 w-5 p-0 text-c-text-3 opacity-0 transition-opacity hover:bg-transparent hover:text-c-text group-hover/project:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
            />
            <button
              type="button"
              onClick={() => {
                onProjectSelect(project);
                onNewSession(project);
              }}
              title={t('sessions.newSession')}
              aria-label={`${t('sessions.newSession')} — ${project.displayName}`}
              className="flex h-5 w-5 items-center justify-center rounded text-c-text-2 hover:text-c-text"
            >
              <Plus className="h-[13px] w-[13px]" strokeWidth={1.8} />
            </button>
          </div>
        )}
      </div>

      <SidebarProjectSessions
        project={project}
        isExpanded={isExpanded}
        sessions={sessions}
        selectedSession={selectedSession}
        initialSessionsLoaded={initialSessionsLoaded}
        hasMoreSessions={Boolean(project.sessionMeta?.hasMore)}
        isLoadingMoreSessions={isLoadingMoreSessions}
        activeSessions={activeSessions}
        attentionSessionIds={attentionSessionIds}
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
        onLoadMoreSessions={onLoadMoreSessions}
        onNewSession={onNewSession}
        t={t}
      />
    </div>
  );
}
