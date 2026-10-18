import { useTranslation } from 'react-i18next';
import { memo, useCallback, useMemo } from 'react';
import type { Dispatch, ReactNode, RefObject, SetStateAction } from 'react';

import type { ChatMessage } from '../../types/types';
import type {
  Project,
  ProjectSession,
  LLMProvider,
  ProviderModelActions,
  ProviderModelsDefinition,
} from '../../../../types/app';
import { getIntrinsicMessageKey } from '../../utils/messageKeys';
import { groupConsecutiveTools, isToolGroupItem } from '../../utils/toolGrouping';
import type { ClaudeProfile } from '../../../settings/hooks/useClaudeProfiles.types';
import type { RuntimeNodePickerModel } from '../../../runtime-nodes/view/RuntimeNodePicker';

import MessageComponent from './MessageComponent';
import ProviderSelectionEmptyState from './ProviderSelectionEmptyState';
import ToolGroupContainer from './ToolGroupContainer';
import LoadAllMessagesOverlay from './LoadAllMessagesOverlay';
import ChatExportMenu from './ChatExportMenu';

interface ChatMessagesPaneProps {
  scrollContainerRef: RefObject<HTMLDivElement>;
  onWheel: () => void;
  onTouchMove: () => void;
  isLoadingSessionMessages: boolean;
  /** True while the viewed session has an active provider run in flight. */
  isProcessing?: boolean;
  /** True while ChatComposer's floating activity/stop tab is rendered above the input. */
  hasActivityIndicator?: boolean;
  chatMessages: ChatMessage[];
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  provider: LLMProvider;
  setProvider: (provider: LLMProvider) => void;
  /** Claude accounts available for a brand-new session; empty for single/no-profile installs. */
  claudeProfiles: ClaudeProfile[];
  selectedClaudeProfileId: string | null;
  onSelectClaudeProfile: (profileId: string) => void;
  /** Runtime targeting for the new-session surface (FT-M07/FT-M08). */
  runtimeNodes: RuntimeNodePickerModel;
  textareaRef: RefObject<HTMLTextAreaElement>;
  claudeModel: string;
  setClaudeModel: (model: string) => void;
  cursorModel: string;
  setCursorModel: (model: string) => void;
  codexModel: string;
  setCodexModel: (model: string) => void;
  opencodeModel: string;
  setOpenCodeModel: (model: string) => void;
  providerModelCatalog: Partial<Record<LLMProvider, ProviderModelsDefinition>>;
  providerModelActions: ProviderModelActions;
  providerModelsLoading: boolean;
  tasksEnabled: boolean;
  isTaskMasterInstalled: boolean | null;
  onShowAllTasks?: (() => void) | null;
  setInput: Dispatch<SetStateAction<string>>;
  isLoadingMoreMessages: boolean;
  hasMoreMessages: boolean;
  totalMessages: number;
  sessionMessagesCount: number;
  visibleMessageCount: number;
  visibleMessages: ChatMessage[];
  loadEarlierMessages: () => void;
  loadAllMessages: () => void;
  allMessagesLoaded: boolean;
  isLoadingAllMessages: boolean;
  loadAllJustFinished: boolean;
  showLoadAllOverlay: boolean;
  createDiff: any;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  onGrantToolPermission: (suggestion: { entry: string; toolName: string }) => { success: boolean };
  showRawParameters?: boolean;
  showThinking?: boolean;
  selectedProject: Project;
  /** Claude desktop right panel (Environment / Context / Outputs), sticky beside the column. */
  sidePanel?: ReactNode;
  /** Live run line ("•• 36m 3s · 1.4k tokens · Thinking") rendered after the last message. */
  footer?: ReactNode;
}

function ChatMessagesPane({
  scrollContainerRef,
  onWheel,
  onTouchMove,
  isLoadingSessionMessages,
  isProcessing = false,
  hasActivityIndicator = false,
  chatMessages,
  selectedSession,
  currentSessionId,
  provider,
  setProvider,
  claudeProfiles,
  selectedClaudeProfileId,
  onSelectClaudeProfile,
  runtimeNodes,
  textareaRef,
  claudeModel,
  setClaudeModel,
  cursorModel,
  setCursorModel,
  codexModel,
  setCodexModel,
  opencodeModel,
  setOpenCodeModel,
  providerModelCatalog,
  providerModelActions,
  providerModelsLoading,
  tasksEnabled,
  isTaskMasterInstalled,
  onShowAllTasks,
  setInput,
  isLoadingMoreMessages,
  hasMoreMessages,
  totalMessages,
  sessionMessagesCount,
  visibleMessageCount,
  visibleMessages,
  loadEarlierMessages,
  loadAllMessages,
  allMessagesLoaded,
  isLoadingAllMessages,
  loadAllJustFinished,
  showLoadAllOverlay,
  createDiff,
  onFileOpen,
  onShowSettings,
  onGrantToolPermission,
  showRawParameters,
  showThinking,
  selectedProject,
  sidePanel,
  footer,
}: ChatMessagesPaneProps) {
  const { t } = useTranslation('chat');
  const groupedVisibleMessages = useMemo(
    () => groupConsecutiveTools(visibleMessages, Boolean(showThinking)),
    [visibleMessages, showThinking],
  );

  // Stable, deterministic keys for the messages rendered this pass.
  //
  // `normalizedToChatMessages` rebuilds fresh ChatMessage objects on every store
  // update, so caching keys by object identity (or via a cross-render allocation
  // Set) minted a brand-new key for the *same* logical message on each prepend —
  // remounting the whole list, which disconnects the scroll-restore anchor and
  // reflows heights, jumping the viewport to the bottom. Deriving keys purely
  // from this render's ordered messages (intrinsic key, disambiguated by
  // occurrence index on collision) yields the same key for the same message
  // order, so React preserves existing DOM nodes and component state on prepend.
  const messageKeyMap = useMemo(() => {
    const keys = new WeakMap<ChatMessage, string>();
    const occurrences = new Map<string, number>();
    const assign = (message: ChatMessage) => {
      const intrinsicKey = getIntrinsicMessageKey(message) ?? 'message-generated';
      const seen = occurrences.get(intrinsicKey) ?? 0;
      occurrences.set(intrinsicKey, seen + 1);
      keys.set(message, seen === 0 ? intrinsicKey : `${intrinsicKey}__${seen}`);
    };
    for (const item of groupedVisibleMessages) {
      if (isToolGroupItem(item)) {
        item.messages.forEach(assign);
      } else {
        assign(item);
      }
    }
    return keys;
  }, [groupedVisibleMessages]);

  const getMessageKey = useCallback(
    (message: ChatMessage) =>
      messageKeyMap.get(message) ?? getIntrinsicMessageKey(message) ?? 'message-generated',
    [messageKeyMap],
  );

  return (
    <div
      ref={scrollContainerRef}
      onWheel={onWheel}
      onTouchMove={onTouchMove}
      className="chat-messages-pane claude-scroll-fade relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
    >
      {/* Claude desktop layout (measured at 1207 and 2560 px wide): the column is
          centred on the whole conversation area and only moves left when it would
          run under the 289px side panel — see .claude-col in index.css. */}
      <div className={`claude-pane-content relative min-h-full ${sidePanel ? 'has-side-panel' : ''}`}>
      <div className={`claude-col pt-[13px] ${hasActivityIndicator ? 'pb-10' : 'pb-6'}`}>
      {(isLoadingSessionMessages || isProcessing) && chatMessages.length === 0 ? (
        <div className="mt-8 text-center text-gray-500 dark:text-gray-400">
          <div className="flex items-center justify-center space-x-2">
            <div className="h-4 w-4 animate-spin rounded-full border-b-2 border-gray-400" />
            <p>{t('session.loading.sessionMessages')}</p>
          </div>
        </div>
      ) : chatMessages.length === 0 ? (
        <ProviderSelectionEmptyState
          selectedSession={selectedSession}
          currentSessionId={currentSessionId}
          provider={provider}
          setProvider={setProvider}
          claudeProfiles={claudeProfiles}
          selectedClaudeProfileId={selectedClaudeProfileId}
          onSelectClaudeProfile={onSelectClaudeProfile}
          runtimeNodes={runtimeNodes}
          textareaRef={textareaRef}
          claudeModel={claudeModel}
          setClaudeModel={setClaudeModel}
          cursorModel={cursorModel}
          setCursorModel={setCursorModel}
          codexModel={codexModel}
          setCodexModel={setCodexModel}
          opencodeModel={opencodeModel}
          setOpenCodeModel={setOpenCodeModel}
          providerModelCatalog={providerModelCatalog}
          providerModelActions={providerModelActions}
          providerModelsLoading={providerModelsLoading}
          tasksEnabled={tasksEnabled}
          isTaskMasterInstalled={isTaskMasterInstalled}
          onShowAllTasks={onShowAllTasks}
          setInput={setInput}
        />
      ) : (
        <>
          {/* Loading indicator for older messages (hide when load-all is active) */}
          {isLoadingMoreMessages && !isLoadingAllMessages && !allMessagesLoaded && (
            <div className="py-3 text-center text-c-text-3">
              <div className="flex items-center justify-center space-x-2">
                <div className="h-3.5 w-3.5 animate-spin rounded-full border-b-2 border-c-text-3" />
                <p className="text-[13px]">{t('session.loading.olderMessages')}</p>
              </div>
            </div>
          )}

          {/* Older messages load silently when scrolled to the top (Claude desktop
              shows no "showing N of M" banner); the count stays available to
              assistive technology. */}
          {hasMoreMessages && !isLoadingMoreMessages && !allMessagesLoaded && totalMessages > 0 && (
            <p className="sr-only">
              {t('session.messages.showingOf', { shown: sessionMessagesCount, total: totalMessages })} {t('session.messages.scrollToLoad')}
            </p>
          )}

          <LoadAllMessagesOverlay
            showLoadAllOverlay={showLoadAllOverlay}
            isLoadingAllMessages={isLoadingAllMessages}
            loadAllJustFinished={loadAllJustFinished}
            totalMessages={totalMessages}
            onLoadAllMessages={loadAllMessages}
          />

          {/* Legacy message count indicator (for non-paginated view) */}
          {!hasMoreMessages && chatMessages.length > visibleMessageCount && (
            <div className="border-b border-gray-200 py-2 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
              {t('session.messages.showingLast', { count: visibleMessageCount, total: chatMessages.length })} |
              <button className="ml-1 text-blue-600 underline hover:text-blue-700" onClick={loadEarlierMessages}>
                {t('session.messages.loadEarlier')}
              </button>
              {' | '}
              <button
                className="text-blue-600 underline hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
                onClick={loadAllMessages}
              >
                {t('session.messages.loadAll')}
              </button>
            </div>
          )}

          {(() => {
            let prevMessage: ChatMessage | null = null;

            return groupedVisibleMessages.map((item) => {
              if (isToolGroupItem(item)) {
                const groupPrevMessage = prevMessage;
                prevMessage = item.messages[item.messages.length - 1] || prevMessage;

                return (
                  <ToolGroupContainer
                    key={`tool-group-${getMessageKey(item.messages[0])}`}
                    group={item}
                    prevMessage={groupPrevMessage}
                    createDiff={createDiff}
                    getMessageKey={getMessageKey}
                    onFileOpen={onFileOpen}
                    onShowSettings={onShowSettings}
                    onGrantToolPermission={onGrantToolPermission}
                    showRawParameters={showRawParameters}
                    showThinking={showThinking}
                    selectedProject={selectedProject}
                    provider={provider}
                  />
                );
              }

              const messagePrevMessage = prevMessage;
              prevMessage = item;

              return (
                <MessageComponent
                  key={getMessageKey(item)}
                  message={item}
                  prevMessage={messagePrevMessage}
                  createDiff={createDiff}
                  onFileOpen={onFileOpen}
                  onShowSettings={onShowSettings}
                  onGrantToolPermission={onGrantToolPermission}
                  showRawParameters={showRawParameters}
                  showThinking={showThinking}
                  selectedProject={selectedProject}
                  provider={provider}
                />
              );
            });
          })()}
          {footer}
        </>
      )}
      </div>
      {sidePanel && (
        <aside className="claude-side-aside absolute inset-y-0 right-0 w-[279px]">
          <div className="sticky top-[17px] pb-6 pr-px">
            {sidePanel}
            {chatMessages.length > 0 && (
              <div className="mt-2 flex justify-end">
                <ChatExportMenu messages={chatMessages} sessionTitle={selectedSession?.title} />
              </div>
            )}
          </div>
        </aside>
      )}
      </div>
    </div>
  );
}

export default memo(ChatMessagesPane);
