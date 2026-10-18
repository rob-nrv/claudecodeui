import React, { useCallback, useEffect, useState } from 'react';

import ChatInterface from '../../chat/view/ChatInterface';
import FileTree from '../../file-tree/view/FileTree';
import StandaloneShell from '../../standalone-shell/view/StandaloneShell';
import GitPanel from '../../git-panel/view/GitPanel';
import PluginTabContent from '../../plugins/view/PluginTabContent';
import { BrowserUsePanel } from '../../browser-use';
import type { MainContentProps } from '../types/types';
import { useTaskMaster } from '../../../contexts/TaskMasterContext';
import { usePaletteOpsRegister } from '../../../contexts/PaletteOpsContext';
import { useTasksSettings } from '../../../contexts/TasksSettingsContext';
import { useUiPreferences } from '../../../hooks/useUiPreferences';
import { useFileOpenResolver } from '../../../hooks/useFileOpenResolver';
import { authenticatedFetch } from '../../../utils/api';
import { useEditorSidebar } from '../../code-editor/hooks/useEditorSidebar';
import EditorSidebar from '../../code-editor/view/EditorSidebar';
import type { Project } from '../../../types/app';
import { TaskMasterPanel } from '../../task-master';
import { useSessionLineage } from '../../session-handoff/hooks/useSessionLineage';
import { readRuntimeTargetChoice } from '../../runtime-nodes/utils/runtimeNodes';
import { selectWorkspaceRuntimeTarget, setWorkspaceRuntimeTargetResolver } from '../../../utils/workspaceRuntimeTarget';

import MainContentHeader from './subcomponents/MainContentHeader';
import MainViewPaneHeader from './subcomponents/MainViewPaneHeader';
import { MAIN_VIEW_LABELS } from '../utils/viewLabels';
import MainContentStateView from './subcomponents/MainContentStateView';
import ErrorBoundary from './ErrorBoundary';

type TaskMasterContextValue = {
  currentProject?: Project | null;
  setCurrentProject?: ((project: Project) => void) | null;
};

type TasksSettingsContextValue = {
  tasksEnabled: boolean;
  isTaskMasterInstalled: boolean | null;
  isTaskMasterReady: boolean | null;
};

function MainContent({
  selectedProject,
  selectedSession,
  sessionNotFoundId,
  activeTab,
  setActiveTab,
  ws,
  sendMessage,
  isMobile,
  onMenuClick,
  isLoading,
  onInputFocusChange,
  onSessionProcessing,
  onSessionIdle,
  processingSessions,
  onNavigateToSession,
  onSessionEstablished,
  onShowSettings,
  externalMessageUpdate,
  newSessionTrigger,
  onProjectSelect,
  onProjectsRefresh,
}: MainContentProps) {
  const { preferences } = useUiPreferences();
  const { showRawParameters, showThinking, sendByCtrlEnter } = preferences;

  const { currentProject, setCurrentProject } = useTaskMaster() as TaskMasterContextValue;
  const { tasksEnabled, isTaskMasterInstalled } = useTasksSettings() as TasksSettingsContextValue;
  const [browserUseEnabled, setBrowserUseEnabled] = useState(false);
  const [isViewExpanded, setIsViewExpanded] = useState(false);

  const shouldShowTasksTab = Boolean(tasksEnabled && isTaskMasterInstalled);
  const shouldShowBrowserTab = browserUseEnabled;

  // FT-M05 handoff lineage for the open session, shared by the header and the
  // chat. Refetched when the session's run starts or stops, so a target's
  // "started" state and new outgoing handoffs come from the backend.
  const selectedSessionId = selectedSession?.id ?? null;
  const isSelectedSessionProcessing = selectedSessionId ? processingSessions.has(selectedSessionId) : false;
  const { lineage: sessionLineage } = useSessionLineage(selectedSessionId, isSelectedSessionProcessing);
  const navigateToSession = useCallback(
    (targetSessionId: string) => onNavigateToSession(targetSessionId),
    [onNavigateToSession],
  );

  const {
    editingFile,
    editorWidth,
    editorExpanded,
    hasManualWidth,
    resizeHandleRef,
    handleFileOpen,
    handleCloseEditor,
    handleToggleEditorExpand,
    handleResizeStart,
  } = useEditorSidebar({
    selectedProject,
    isMobile,
  });

  // Resolves bare/partial file references (e.g. links inside chat messages) to
  // real project files before opening them in the in-app editor.
  const resolvedFileOpen = useFileOpenResolver(selectedProject, handleFileOpen);

  useEffect(() => {
    // Identify projects by DB `projectId`; the TaskMaster context uses the
    // same identifier to key its internal maps.
    const selectedProjectId = selectedProject?.projectId;
    const currentProjectId = currentProject?.projectId;

    if (selectedProject && selectedProjectId !== currentProjectId) {
      setCurrentProject?.(selectedProject);
    }
  }, [selectedProject, currentProject?.projectId, setCurrentProject]);

  useEffect(() => {
    if (!shouldShowTasksTab && activeTab === 'tasks') {
      setActiveTab('chat');
    }
  }, [shouldShowTasksTab, activeTab, setActiveTab]);

  const loadBrowserUseSettings = useCallback(async () => {
    try {
      const response = await authenticatedFetch('/api/browser-use/settings');
      const data = await response.json();
      setBrowserUseEnabled(Boolean(response.ok && data?.success !== false && data?.data?.settings?.enabled));
    } catch {
      setBrowserUseEnabled(false);
    }
  }, []);

  useEffect(() => {
    void loadBrowserUseSettings();
    window.addEventListener('browserUseSettingsChanged', loadBrowserUseSettings);
    return () => window.removeEventListener('browserUseSettingsChanged', loadBrowserUseSettings);
  }, [loadBrowserUseSettings]);

  useEffect(() => {
    if (!shouldShowBrowserTab && activeTab === 'browser') {
      setActiveTab('chat');
    }
  }, [shouldShowBrowserTab, activeTab, setActiveTab]);

  usePaletteOpsRegister({
    openFile: (filePath: string) => {
      setActiveTab('files');
      handleFileOpen(filePath);
    },
    // Opens the editor side panel in place, keeping the current tab (e.g. chat).
    openFileInEditor: (filePath: string) => {
      resolvedFileOpen(filePath);
    },
  });

  // FT-M10: workspace panels (Files, Git, Tasks, Worktrees) work against this
  // project's runtime target — the selected session's node, else the node chosen
  // for the project — so the server never assumes this machine. Read at request
  // time: registered during render, before any child effect can fetch.
  setWorkspaceRuntimeTargetResolver(() => selectWorkspaceRuntimeTarget(
    selectedProject?.projectId,
    selectedSession,
    readRuntimeTargetChoice(selectedProject?.projectId ?? null),
  ));

  if (isLoading) {
    return <MainContentStateView mode="loading" isMobile={isMobile} onMenuClick={onMenuClick} />;
  }

  // FT-M06: takes precedence over the generic "choose a project" empty state
  // so a stale/deleted-session deep-link (notification or otherwise) says so
  // explicitly, rather than silently landing on an unrelated project.
  if (!selectedProject && sessionNotFoundId) {
    return <MainContentStateView mode="sessionNotFound" isMobile={isMobile} onMenuClick={onMenuClick} />;
  }

  if (!selectedProject) {
    return <MainContentStateView mode="empty" isMobile={isMobile} onMenuClick={onMenuClick} />;
  }

  // Claude desktop: Terminal, Changes, Browser, Files, Tasks and plugins open in
  // a pane to the right of the conversation (reference B, 2026-07-31); the
  // conversation stays visible on the left. On a phone the view takes the
  // whole screen and its header closes it.
  const isViewOpen = activeTab !== 'chat';
  const viewLabel = MAIN_VIEW_LABELS[activeTab as keyof typeof MAIN_VIEW_LABELS] ?? activeTab.replace('plugin:', '');

  return (
    <div className="flex h-full">
      <div
        className={[
          'flex min-w-0 flex-col',
          !isViewOpen ? 'flex-1' : isMobile || isViewExpanded ? 'hidden' : 'w-[clamp(380px,38%,560px)] flex-shrink-0',
        ].join(' ')}
      >
        <MainContentHeader
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          selectedProject={selectedProject}
          selectedSession={selectedSession}
          shouldShowTasksTab={shouldShowTasksTab}
          shouldShowBrowserTab={shouldShowBrowserTab}
          isMobile={isMobile}
          onMenuClick={onMenuClick}
          sessionLineage={sessionLineage}
          onNavigateToSession={navigateToSession}
        />
        <div className={'min-h-0 flex-1 overflow-hidden ' + (editorExpanded ? 'hidden' : '')}>
          <ErrorBoundary showDetails>
            <ChatInterface
              isActive={!isViewOpen || !isMobile}
              selectedProject={selectedProject}
              selectedSession={selectedSession}
              ws={ws}
              sendMessage={sendMessage}
              onFileOpen={handleFileOpen}
              onInputFocusChange={onInputFocusChange}
              onSessionProcessing={onSessionProcessing}
              onSessionIdle={onSessionIdle}
              processingSessions={processingSessions}
              onNavigateToSession={onNavigateToSession}
              onSessionEstablished={onSessionEstablished}
              onShowSettings={onShowSettings}
              showRawParameters={showRawParameters}
              showThinking={showThinking}
              sendByCtrlEnter={sendByCtrlEnter}
              externalMessageUpdate={externalMessageUpdate}
              newSessionTrigger={newSessionTrigger}
              onShowAllTasks={tasksEnabled ? () => setActiveTab('tasks') : null}
              sessionLineage={sessionLineage}
            />
          </ErrorBoundary>
        </div>
      </div>

      {isViewOpen && (
        <section
          aria-label={viewLabel}
          className={'flex min-w-0 flex-1 flex-col bg-c-bg ' + (isMobile ? '' : 'border-l border-c-sidebar-border')}
        >
          <MainViewPaneHeader
            label={viewLabel}
            projectName={selectedProject.displayName}
            isExpanded={isViewExpanded}
            canExpand={!isMobile}
            onToggleExpand={() => setIsViewExpanded((value) => !value)}
            onClose={() => {
              setIsViewExpanded(false);
              setActiveTab('chat');
            }}
          />
          <div className="min-h-0 flex-1 overflow-hidden">
            {activeTab === 'files' && (
              <FileTree selectedProject={selectedProject} onFileOpen={handleFileOpen} />
            )}

            {activeTab === 'shell' && (
              <div className="h-full w-full overflow-hidden">
                <StandaloneShell
                  project={selectedProject}
                  session={selectedSession}
                  showHeader={false}
                  isActive={activeTab === 'shell'}
                  claudeProfileId={selectedSession?.claudeProfileId ?? null}
                />
              </div>
            )}

            {activeTab === 'git' && (
              <GitPanel
                selectedProject={selectedProject}
                isMobile={isMobile}
                onFileOpen={handleFileOpen}
                onProjectSelect={onProjectSelect}
                onProjectsRefresh={onProjectsRefresh}
              />
            )}

            {shouldShowTasksTab && <TaskMasterPanel isVisible={activeTab === 'tasks'} />}

            {shouldShowBrowserTab && activeTab === 'browser' && (
              <BrowserUsePanel isVisible={activeTab === 'browser'} onShowSettings={onShowSettings} />
            )}

            {activeTab.startsWith('plugin:') && (
              <PluginTabContent
                pluginName={activeTab.replace('plugin:', '')}
                selectedProject={selectedProject}
                selectedSession={selectedSession}
              />
            )}
          </div>
        </section>
      )}

      <EditorSidebar
        editingFile={editingFile}
        isMobile={isMobile}
        editorExpanded={editorExpanded}
        editorWidth={editorWidth}
        hasManualWidth={hasManualWidth}
        resizeHandleRef={resizeHandleRef}
        onResizeStart={handleResizeStart}
        onCloseEditor={handleCloseEditor}
        onToggleEditorExpand={handleToggleEditorExpand}
        projectPath={selectedProject.path}
        fillSpace={activeTab === 'files'}
      />
    </div>
  );
}

export default React.memo(MainContent);
