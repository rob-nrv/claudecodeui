import { useTranslation } from 'react-i18next';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type {
  ChangeEvent,
  ClipboardEvent,
  FormEvent,
  KeyboardEvent,
  MouseEvent,
  ReactNode,
  RefObject,
  TouchEvent,
} from 'react';
import { Loader2, ArrowUpIcon, ZapIcon, PlusIcon, CircleStopIcon, CornerDownLeftIcon } from 'lucide-react';

import { useVoiceInput } from '../../hooks/useVoiceInput';
import { useVoiceAvailable } from '../../hooks/useVoiceAvailable';
import type { QueuedDraft } from '../../hooks/useChatComposerState';
import type { SessionActivity } from '../../../../hooks/useSessionProtection';
import type { PendingPermissionRequest, PermissionMode } from '../../types/types';
import { isOpenPermissionRequest } from '../../utils/permissionRequestState';
import { isConfirmingSteerTap, reduceSteerConfirmation } from '../../utils/steerConfirmation';
import type { ProviderModelOption } from '../../../../types/app';
import {
  PromptInput,
  PromptInputHeader,
  PromptInputBody,
  PromptInputTextarea,
} from '../../../../shared/view/ui';

import CommandMenu from './CommandMenu';
import ComposerAttachment from './ComposerAttachment';
import VoiceInputButton from './VoiceInputButton';
import PermissionRequestsBanner from './PermissionRequestsBanner';
import ContextRing from './TokenUsageSummary';
import QueuedMessageCard from './QueuedMessageCard';
import ComposerModelMenu from './ComposerModelMenu';
import ComposerPermissionMenu from './ComposerPermissionMenu';

interface MentionableFile {
  name: string;
  path: string;
}

interface SlashCommand {
  name: string;
  description?: string;
  namespace?: string;
  path?: string;
  type?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

interface ChatComposerProps {
  pendingPermissionRequests: PendingPermissionRequest[];
  handlePermissionDecision: (
    requestIds: string | string[],
    decision: { allow?: boolean; message?: string; rememberEntry?: string | null; updatedInput?: unknown },
  ) => void;
  handleGrantToolPermission: (suggestion: { entry: string; toolName: string }) => { success: boolean };
  handlePermissionDismiss: (requestId: string) => void;
  activity: SessionActivity | null;
  isLoading: boolean;
  onAbortSession: () => void;
  /** FT-M06: interrupts the active run and immediately sends the composer's current content as its next turn. */
  onSteerNow: () => Promise<boolean>;
  permissionMode: PermissionMode | string;
  availablePermissionModes: (PermissionMode | string)[];
  onSelectPermissionMode: (mode: PermissionMode | string) => void;
  providerLabel: string;
  effort: string;
  availableEffortOptions: NonNullable<ProviderModelOption['effort']>['values'];
  onSelectEffort: (effort: string) => void;
  model: string;
  availableModelOptions: ProviderModelOption[];
  onSelectModel: (model: string) => void;
  modelsLoading: boolean;
  tokenBudget: Record<string, unknown> | null;
  onShowTokenUsage: () => void;
  slashCommandsCount: number;
  onToggleCommandMenu: () => void;
  hasInput: boolean;
  onClearInput: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement> | MouseEvent<HTMLButtonElement> | TouchEvent<HTMLButtonElement>) => void;
  isDragActive: boolean;
  queuedDraft: QueuedDraft | null;
  onEditQueuedDraft: () => void;
  onDeleteQueuedDraft: () => void;
  attachedFiles: File[];
  onRemoveAttachment: (index: number) => void;
  uploadingFiles: Map<string, number>;
  fileErrors: Map<string, string>;
  showFileDropdown: boolean;
  filteredFiles: MentionableFile[];
  selectedFileIndex: number;
  onSelectFile: (file: MentionableFile) => void;
  filteredCommands: SlashCommand[];
  selectedCommandIndex: number;
  onCommandSelect: (command: SlashCommand, index: number, isHover: boolean) => void;
  onCloseCommandMenu: () => void;
  isCommandMenuOpen: boolean;
  frequentCommands: SlashCommand[];
  getRootProps: (...args: unknown[]) => Record<string, unknown>;
  getInputProps: (...args: unknown[]) => Record<string, unknown>;
  openAttachmentPicker: () => void;
  inputHighlightRef: RefObject<HTMLDivElement>;
  renderInputWithMentions: (text: string) => ReactNode;
  textareaRef: RefObject<HTMLTextAreaElement>;
  input: string;
  onVoiceTranscript?: (text: string, send?: boolean) => void;
  onInputChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onTextareaClick: (event: MouseEvent<HTMLTextAreaElement>) => void;
  onTextareaKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onTextareaPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onTextareaScrollSync: (target: HTMLTextAreaElement) => void;
  onTextareaInput: (event: FormEvent<HTMLTextAreaElement>) => void;
  isInputFocused?: boolean;
  onInputFocusChange?: (focused: boolean) => void;
  placeholder: string;
  isTextareaExpanded: boolean;
  sendByCtrlEnter?: boolean;
  /** Usage-limit notice shown right above the box (Claude desktop). */
  usageBanner?: ReactNode;
}

export default function ChatComposer({
  pendingPermissionRequests,
  handlePermissionDecision,
  handleGrantToolPermission,
  handlePermissionDismiss,
  isLoading,
  onAbortSession,
  onSteerNow,
  permissionMode,
  availablePermissionModes,
  onSelectPermissionMode,
  providerLabel,
  effort,
  availableEffortOptions,
  onSelectEffort,
  model,
  availableModelOptions,
  onSelectModel,
  modelsLoading,
  tokenBudget,
  onShowTokenUsage,
  onSubmit,
  isDragActive,
  queuedDraft,
  onEditQueuedDraft,
  onDeleteQueuedDraft,
  attachedFiles,
  onRemoveAttachment,
  uploadingFiles,
  fileErrors,
  showFileDropdown,
  filteredFiles,
  selectedFileIndex,
  onSelectFile,
  filteredCommands,
  selectedCommandIndex,
  onCommandSelect,
  onCloseCommandMenu,
  isCommandMenuOpen,
  frequentCommands,
  getRootProps,
  getInputProps,
  openAttachmentPicker,
  inputHighlightRef,
  renderInputWithMentions,
  textareaRef,
  input,
  onVoiceTranscript,
  onInputChange,
  onTextareaClick,
  onTextareaKeyDown,
  onTextareaPaste,
  onTextareaScrollSync,
  onTextareaInput,
  onInputFocusChange,
  placeholder,
  isTextareaExpanded,
  sendByCtrlEnter,
  usageBanner,
}: ChatComposerProps) {
  const { t } = useTranslation('chat');
  const fileDropdownRef = useRef<HTMLDivElement | null>(null);
  const selectedFileRef = useRef<HTMLDivElement | null>(null);
  const commandMenuPosition = useMemo(() => {
    if (!isCommandMenuOpen) {
      return { top: 0, left: 16, bottom: 90 };
    }
    const textareaRect = textareaRef.current?.getBoundingClientRect();
    return {
      top: textareaRect ? Math.max(16, textareaRect.top - 316) : 0,
      left: textareaRect ? textareaRect.left : 16,
      bottom: textareaRect ? window.innerHeight - textareaRect.top + 8 : 90,
    };
  }, [isCommandMenuOpen, textareaRef]);

  useEffect(() => {
    const dropdown = fileDropdownRef.current;
    const selectedFile = selectedFileRef.current;
    if (!showFileDropdown || !dropdown || !selectedFile) {
      return;
    }

    const itemTop = selectedFile.offsetTop;
    const itemBottom = itemTop + selectedFile.offsetHeight;
    const visibleTop = dropdown.scrollTop;
    const visibleBottom = visibleTop + dropdown.clientHeight;

    if (itemTop < visibleTop) {
      dropdown.scrollTop = itemTop;
    } else if (itemBottom > visibleBottom) {
      dropdown.scrollTop = itemBottom - dropdown.clientHeight;
    }
  }, [selectedFileIndex, showFileDropdown]);

  // Voice state is hosted here (not in the mic button) so the main Send button can stop
  // recording and send the transcript in one tap, the way the mic button drops it in the box.
  const voiceAvailable = useVoiceAvailable();
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const voiceErrorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleVoiceError = useCallback((msg: string) => {
    setVoiceError(msg);
    if (voiceErrorTimer.current) clearTimeout(voiceErrorTimer.current);
    voiceErrorTimer.current = setTimeout(() => setVoiceError(null), 4000);
  }, []);
  useEffect(() => () => {
    if (voiceErrorTimer.current) clearTimeout(voiceErrorTimer.current);
  }, []);
  const noopTranscript = useCallback(() => {}, []);
  const { state: voiceState, toggle: voiceToggle, stop: voiceStop } = useVoiceInput(
    onVoiceTranscript ?? noopTranscript,
    handleVoiceError,
  );
  const isRecording = voiceState === 'recording';
  const isTranscribing = voiceState === 'transcribing';

  // Detect if the AskUserQuestion interactive panel is active
  const hasQuestionPanel = pendingPermissionRequests.some(
    (r) => r.toolName === 'AskUserQuestion' && isOpenPermissionRequest(r)
  );

  const hasQueuedDraft = Boolean(queuedDraft);
  const canQueueDraft = isLoading && Boolean(input.trim() || attachedFiles.length > 0);

  // FT-M06: "Steer Now" — distinct from Queue's arrow-up button below, which
  // stays exactly as it was (still means "send after"). Steer interrupts
  // real in-flight work, so a single tap only arms it; the confirming
  // second tap (`isConfirmingSteerTap`) is what actually sends, which
  // doubles as the button's own double-tap guard.
  const [steerState, dispatchSteer] = useReducer(reduceSteerConfirmation, 'idle');
  const steerArmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearSteerArmTimer = useCallback(() => {
    if (steerArmTimerRef.current) {
      clearTimeout(steerArmTimerRef.current);
      steerArmTimerRef.current = null;
    }
  }, []);
  useEffect(() => clearSteerArmTimer, [clearSteerArmTimer]);
  useEffect(() => {
    // Leaving the "something to queue or steer" window — sent, cleared, or
    // the run itself ended — must not leave a stale armed/error state for
    // the next time this button appears.
    if (!canQueueDraft) {
      clearSteerArmTimer();
      dispatchSteer({ type: 'reset' });
    }
  }, [canQueueDraft, clearSteerArmTimer]);
  const handleSteerButtonClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      if (steerState === 'sending') {
        return;
      }
      const isConfirming = isConfirmingSteerTap(steerState);
      clearSteerArmTimer();
      dispatchSteer({ type: 'tap' });
      if (!isConfirming) {
        steerArmTimerRef.current = setTimeout(() => dispatchSteer({ type: 'armTimeout' }), 3000);
        return;
      }
      void onSteerNow().then(
        (delivered) => dispatchSteer({ type: 'sendSettled', ok: delivered }),
        () => dispatchSteer({ type: 'sendSettled', ok: false }),
      );
    },
    [steerState, clearSteerArmTimer, onSteerNow],
  );
  const steerTooltip = steerState === 'armed'
    ? t('input.steer.confirm', { defaultValue: 'Tap again to steer now' })
    : steerState === 'error'
      ? t('input.steer.error', { defaultValue: 'Could not steer — tap to try again' })
      : t('input.steer.action', { defaultValue: 'Steer now — interrupt the current run and send immediately' });
  const submitHint = canQueueDraft
    ? hasQueuedDraft
      ? t('input.hintText.updateQueued', { defaultValue: 'Enter to update queued message' })
      : t('input.hintText.queue', { defaultValue: 'Enter to queue your next message' })
    : sendByCtrlEnter
      ? t('input.hintText.ctrlEnter')
      : t('input.hintText.enter');
  const submitAriaLabel = canQueueDraft
    ? hasQueuedDraft
      ? t('input.queue.update', { defaultValue: 'Update queued message' })
      : t('input.queue.sendNext', { defaultValue: 'Queue next message' })
    : isLoading
      ? t('input.stop')
      : t('input.send');

  return (
    <div className="chat-composer-shell relative flex-shrink-0 pb-safe-area-inset-bottom pt-0">
      {/* The run line ("•• 2m 3s · Thinking") is rendered at the end of the
          conversation by ChatInterface, as in Claude desktop. */}
      {pendingPermissionRequests.length > 0 && (
        <div className="claude-box mb-3">
          <PermissionRequestsBanner
            pendingPermissionRequests={pendingPermissionRequests}
            handlePermissionDecision={handlePermissionDecision}
            handleGrantToolPermission={handleGrantToolPermission}
            handlePermissionDismiss={handlePermissionDismiss}
          />
        </div>
      )}

      {queuedDraft && (
        <QueuedMessageCard
          content={queuedDraft.content}
          attachmentCount={
            queuedDraft.uploadedAttachments?.length ?? queuedDraft.attachments.length
          }
          onEdit={onEditQueuedDraft}
          onDelete={onDeleteQueuedDraft}
        />
      )}

      {!hasQuestionPanel && <div className="claude-box relative">
        {showFileDropdown && filteredFiles.length > 0 && (
          <div
            ref={fileDropdownRef}
            className="absolute bottom-full left-0 right-0 z-50 mb-2 max-h-48 overflow-y-auto rounded-xl border border-border/50 bg-card/95 shadow-lg backdrop-blur-md"
          >
            {filteredFiles.map((file, index) => (
              <div
                key={file.path}
                ref={index === selectedFileIndex ? selectedFileRef : undefined}
                className={`cursor-pointer touch-manipulation border-b border-border/30 px-4 py-3 last:border-b-0 ${
                  index === selectedFileIndex
                    ? 'bg-primary/8 text-primary'
                    : 'text-foreground hover:bg-accent/50'
                }`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onSelectFile(file);
                }}
              >
                <div className="text-sm font-medium">{file.name}</div>
                <div className="font-mono text-xs text-muted-foreground">{file.path}</div>
              </div>
            ))}
          </div>
        )}

        <CommandMenu
          commands={filteredCommands}
          selectedIndex={selectedCommandIndex}
          onSelect={onCommandSelect}
          onClose={onCloseCommandMenu}
          position={commandMenuPosition}
          isOpen={isCommandMenuOpen}
          frequentCommands={frequentCommands}
        />

        {usageBanner}

        {/* Claude desktop composer: 559×44 box, 1px #373736 border, radius 12,
            "+" at left, stop/send and mic at right; mode and model below. */}
        <PromptInput
          onSubmit={onSubmit as (event: FormEvent<HTMLFormElement>) => void}
          status={isLoading ? 'streaming' : 'ready'}
          className={[
            'rounded-[12px] border-c-input-border bg-c-input shadow-none backdrop-blur-none focus-within:border-c-input-border focus-within:shadow-none focus-within:ring-0',
            isTextareaExpanded ? 'chat-input-expanded' : '',
          ].filter(Boolean).join(' ')}
          {...getRootProps()}
        >
          {isDragActive && (
            <div className="absolute inset-0 z-50 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary/50 bg-primary/15">
              <div className="rounded-xl border border-border/30 bg-card p-4 shadow-lg">
                <svg className="mx-auto mb-2 h-8 w-8 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
                  />
                </svg>
                <p className="text-sm font-medium">Drop files here</p>
              </div>
            </div>
          )}

          {attachedFiles.length > 0 && (
            <PromptInputHeader>
              <div className="rounded-xl bg-muted/40 p-2">
                <div className="flex flex-wrap gap-2">
                  {attachedFiles.map((file, index) => (
                    <ComposerAttachment
                      key={`${file.name}-${file.lastModified}-${index}`}
                      file={file}
                      onRemove={() => onRemoveAttachment(index)}
                      uploadProgress={uploadingFiles.get(file.name)}
                      error={fileErrors.get(file.name)}
                    />
                  ))}
                </div>
              </div>
            </PromptInputHeader>
          )}

          <input {...getInputProps()} />
          <span id="chat-composer-hint" className="sr-only">{submitHint}</span>

          <div className="flex items-end">
            <button
              type="button"
              onClick={openAttachmentPicker}
              aria-label={t('input.attachFiles')}
              title={t('input.attachFiles')}
              className="mb-[7px] ml-[8px] flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-c-text-2 hover:bg-c-active hover:text-c-text"
            >
              <PlusIcon className="h-[15px] w-[15px]" strokeWidth={1.8} />
            </button>

            <PromptInputBody className="min-w-0 flex-1">
              <div ref={inputHighlightRef} aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
                <div className="chat-input-placeholder block w-full whitespace-pre-wrap break-words py-[11px] pl-[5px] pr-2 text-[14px] leading-5 text-transparent">
                  {renderInputWithMentions(input)}
                </div>
              </div>

              <PromptInputTextarea
                ref={textareaRef}
                dir="auto"
                value={input}
                onChange={onInputChange}
                onClick={onTextareaClick}
                onKeyDown={onTextareaKeyDown}
                onPaste={onTextareaPaste}
                onScroll={(event) => onTextareaScrollSync(event.target as HTMLTextAreaElement)}
                onFocus={() => onInputFocusChange?.(true)}
                onBlur={() => onInputFocusChange?.(false)}
                onInput={onTextareaInput}
                placeholder={placeholder}
                aria-describedby="chat-composer-hint"
                rows={1}
                className="min-h-[42px] py-[11px] pl-[5px] pr-2 text-[14px] leading-5 text-c-text placeholder:text-c-text-3"
              />
            </PromptInputBody>

            <div data-slot="composer-actions" className="mb-[7px] mr-[10px] flex flex-shrink-0 items-center gap-[7px]">
              {canQueueDraft && (
                <button
                  type="button"
                  onClick={handleSteerButtonClick}
                  disabled={steerState === 'sending'}
                  aria-label={steerTooltip}
                  title={steerTooltip}
                  className={[
                    'flex h-7 w-7 items-center justify-center rounded-md transition-colors',
                    steerState === 'armed'
                      ? 'bg-amber-500/15 text-amber-400'
                      : steerState === 'error'
                        ? 'text-red-400'
                        : 'text-c-text-2 hover:bg-c-active hover:text-c-text',
                  ].join(' ')}
                >
                  {steerState === 'sending' ? <Loader2 className="h-4 w-4 animate-spin" /> : <ZapIcon className="h-4 w-4" strokeWidth={1.8} />}
                </button>
              )}

              <button
                type={isLoading || isRecording || canQueueDraft ? 'button' : 'submit'}
                onClick={
                  canQueueDraft
                    ? (e: MouseEvent<HTMLButtonElement>) => {
                        e.preventDefault();
                        onSubmit(e);
                      }
                    : isLoading
                      ? onAbortSession
                      : isRecording
                        ? (e: MouseEvent<HTMLButtonElement>) => {
                            e.preventDefault();
                            voiceStop({ send: true });
                          }
                        : undefined
                }
                disabled={
                  isLoading
                    ? false
                    : isRecording
                      ? false
                      : isTranscribing
                        ? true
                        : !input.trim() && attachedFiles.length === 0
                }
                aria-label={submitAriaLabel}
                title={submitAriaLabel}
                className={[
                  'flex h-7 w-7 items-center justify-center rounded-md transition-colors disabled:cursor-default',
                  isLoading && !canQueueDraft
                    ? 'text-c-text hover:bg-c-active'
                    : input.trim() || attachedFiles.length > 0 || isRecording
                      ? 'text-c-text-2 hover:bg-c-active hover:text-c-text'
                      : 'text-c-text-3',
                ].join(' ')}
              >
                {isTranscribing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : isLoading && !canQueueDraft ? (
                  <CircleStopIcon className="h-4 w-4" strokeWidth={1.8} />
                ) : canQueueDraft ? (
                  <ArrowUpIcon className="h-4 w-4" strokeWidth={2} />
                ) : (
                  <CornerDownLeftIcon className="h-4 w-4" strokeWidth={1.8} />
                )}
              </button>

              {onVoiceTranscript && voiceAvailable && (
                <VoiceInputButton state={voiceState} onToggle={voiceToggle} errorMsg={voiceError} />
              )}
            </div>
          </div>
      </PromptInput>

      {/* Mode left, model / effort / context ring right (Claude desktop row under the box). */}
      <div className="flex h-[44px] items-center gap-2 pl-[12px] pr-[11px] text-[14px] text-c-text-2">
        <ComposerPermissionMenu
          permissionMode={permissionMode}
          permissionModes={availablePermissionModes}
          onSelectPermissionMode={onSelectPermissionMode}
          providerLabel={providerLabel}
        />
        <div className="flex-1" />
        <ComposerModelMenu
          effort={effort}
          effortOptions={availableEffortOptions}
          onSelectEffort={onSelectEffort}
          model={model}
          modelOptions={availableModelOptions}
          onSelectModel={onSelectModel}
          modelsLoading={modelsLoading}
        />
        <ContextRing usage={tokenBudget} onClick={onShowTokenUsage} />
      </div>
      </div>}
    </div>
  );
}
