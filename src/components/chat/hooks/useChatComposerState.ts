import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ChangeEvent,
  ClipboardEvent,
  Dispatch,
  FormEvent,
  KeyboardEvent,
  MouseEvent,
  MutableRefObject,
  SetStateAction,
  TouchEvent,
} from 'react';
import { useDropzone } from 'react-dropzone';

import { authenticatedFetch } from '../../../utils/api';
import type { MarkSessionProcessing, SessionActivityMap } from '../../../hooks/useSessionProtection';
import { grantClaudeToolPermission } from '../utils/chatPermissions';
import {
  clearQueuedMessage,
  readQueuedMessage,
  safeLocalStorage,
  writeQueuedMessage,
  type QueuedSendOptions,
  type StoredQueuedMessage,
} from '../utils/chatStorage';
import {
  clearQueuedMessageOnServer,
  fetchAndClaimQueuedMessage,
  fetchQueuedMessage,
  restoreQueuedMessageOnServer,
  saveQueuedMessageOnServer,
} from '../utils/queuedMessageApi';
import {
  flagPermissionRequestsNotSent,
  isAwaitingPermissionDecision,
  markPermissionRequestsSubmitting,
  removePermissionRequest,
} from '../utils/permissionRequestState';
import type {
  ChatAttachment,
  ChatMessage,
  PendingPermissionRequest,
  PermissionMode,
  SessionEstablishedContext,
} from '../types/types';
import type { Project, ProjectSession, LLMProvider, ProviderModelOption } from '../../../types/app';
import { escapeRegExp } from '../utils/chatFormatting';

import { useFileMentions } from './useFileMentions';
import { type SlashCommand, useSlashCommands } from './useSlashCommands';

interface UseChatComposerStateArgs {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  provider: LLMProvider;
  /**
   * The Claude account a brand-new session should be created under. Only
   * read when `provider === 'claude'` and there is no session yet — once a
   * session exists, its binding lives on the session row, never here
   * (CLOUDCLI_EXTENSION_PLAN.md F4/F5).
   */
  claudeProfileId?: string | null;
  /**
   * The RuntimeNode a brand-new session should be bound to (FT-M07), or null
   * when none can be implied — the backend then applies its own single-node
   * rule and refuses when a choice is required. Never read for an existing
   * session, whose binding lives on the session row.
   */
  runtimeNodeId?: string | null;
  permissionMode: PermissionMode | string;
  cyclePermissionMode: () => void;
  resolvePermissionModeForProvider: (provider: LLMProvider, requestedMode: PermissionMode | string) => PermissionMode;
  /**
   * Model every send and command carries: the open session's model when there
   * is one, otherwise the user's per-provider selection.
   */
  currentProviderModel: string;
  currentProviderEffort: string;
  isLoading: boolean;
  processingSessions?: SessionActivityMap;
  canAbortSession: boolean;
  tokenBudget: Record<string, unknown> | null;
  /** Returns whether the frame was actually sent (`false` if the socket wasn't open). */
  sendMessage: (message: unknown) => boolean;
  sendByCtrlEnter?: boolean;
  onSessionProcessing?: MarkSessionProcessing;
  /**
   * Invoked with the freshly allocated session id when the user sends the
   * first message of a brand-new conversation. The backend allocates the id
   * via POST /api/providers/sessions BEFORE the websocket send, so the id is
   * stable for the conversation's whole lifetime — the consumer navigates to
   * /session/:id and records it as the current session.
   */
  onSessionEstablished?: (sessionId: string, context: SessionEstablishedContext) => void;
  onInputFocusChange?: (focused: boolean) => void;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  scrollToBottom: () => void;
  addMessage: (msg: ChatMessage) => void;
  setIsUserScrolledUp: (isScrolledUp: boolean) => void;
  /** Current approvals; answers are only sent for requests still awaiting a decision. */
  pendingPermissionRequests: PendingPermissionRequest[];
  setPendingPermissionRequests: Dispatch<SetStateAction<PendingPermissionRequest[]>>;
  /** Expired approvals dismissed in this tab (owned by useChatProviderState). */
  dismissedPermissionRequestIdsRef: MutableRefObject<Set<string>>;
  /**
   * True while the active session's composer content is owned by something
   * other than the project-wide draft (FT-M05: an unsent handoff package,
   * scoped to its target session only). While true, `input` is never written
   * to `draft_input_<projectId>` — that key is shared by every session in the
   * project, so persisting it there would let the very next session opened
   * in this project (a reload landing on a different session included) load
   * a draft that was never its own.
   */
  suppressSharedProjectDraft?: boolean;
  /**
   * Sessions this tab has just told the server to steer (FT-M06):
   * `handleSteerNow` adds the target session right before sending
   * `chat.steer`, and `useChatRealtimeHandlers` consumes (removes) it when
   * the interrupted turn's own `complete` arrives, so that specific stale
   * terminal event never clears the "processing" indicator a moment before
   * the steered turn's own activity appears. Shared with (created by)
   * `ChatInterface`, the same pattern as `dismissedPermissionRequestIdsRef`.
   */
  steeringSessionIdsRef?: MutableRefObject<Set<string>>;
}

interface MentionableFile {
  name: string;
  path: string;
}

interface CommandExecutionResult {
  type: 'builtin' | 'custom';
  action?: string;
  data?: any;
  content?: string;
  hasBashCommands?: boolean;
  hasFileIncludes?: boolean;
}

export type ModelCommandData = {
  current?: {
    provider?: string;
    providerLabel?: string;
    model?: string;
  };
  available?: Partial<Record<LLMProvider, string[]>>;
  availableModels?: string[];
  availableOptions?: ProviderModelOption[];
  defaultModel?: string;
};

export type CostCommandData = {
  tokenUsage?: {
    used?: number;
    total?: number;
  };
  tokenBreakdown?: {
    input?: number;
    output?: number;
  };
  provider?: string;
  model?: string;
};

export type StatusCommandData = {
  version?: string;
  packageName?: string;
  uptime?: string;
  model?: string;
  provider?: string;
  nodeVersion?: string;
  platform?: string;
  pid?: number;
  memoryUsage?: {
    rssMb?: number;
    heapUsedMb?: number;
    heapTotalMb?: number;
  };
};

export type HelpCommandData = {
  content?: string;
  format?: string;
  commands?: Array<{
    name: string;
    description?: string;
    namespace?: string;
  }>;
};

export type CommandModalKind = 'help' | 'models' | 'cost' | 'status';

export type CommandModalPayload = {
  kind: CommandModalKind;
  data: HelpCommandData | ModelCommandData | CostCommandData | StatusCommandData;
};

const createFakeSubmitEvent = () => {
  return { preventDefault: () => undefined } as unknown as FormEvent<HTMLFormElement>;
};

const MAX_ATTACHMENT_COUNT = 10;
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;

const isImageAttachment = (attachment: ChatAttachment) => {
  if (attachment.mimeType?.startsWith('image/')) return true;
  return /\.(gif|jpe?g|png|svg|webp)$/i.test(attachment.path || attachment.name || '');
};

const uploadAttachmentFiles = async (files: File[]): Promise<unknown[]> => {
  if (files.length === 0) {
    return [];
  }

  const formData = new FormData();
  files.forEach((file) => {
    formData.append('files', file);
  });

  const response = await authenticatedFetch('/api/assets/files', {
    method: 'POST',
    headers: {},
    body: formData,
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error || 'Failed to upload files');
  }

  const result = await response.json();
  if (!Array.isArray(result.attachments) || result.attachments.length !== files.length) {
    throw new Error('File upload returned an incomplete result');
  }
  return result.attachments;
};

export type QueuedDraft = {
  content: string;
  /** Browser files retained while this composer stays mounted, for editing. */
  attachments: File[];
  /** JSON-safe descriptors uploaded when the message is queued. */
  uploadedAttachments?: unknown[];
  /**
   * Send options snapshotted at queue time. Persisted with the draft so the
   * app-level auto-send can dispatch the message with the right model and
   * permission settings while another session is being viewed.
   */
  options?: QueuedSendOptions;
};

const restoreQueuedDraft = (sessionKey: string): QueuedDraft | null => {
  const saved = readQueuedMessage(sessionKey);
  return saved
    ? {
        content: saved.content,
        attachments: [],
        uploadedAttachments: saved.attachments ?? saved.images,
        options: saved.options,
      }
    : null;
};

const getNotificationSessionSummary = (
  selectedSession: ProjectSession | null,
  fallbackInput: string,
): string | null => {
  const sessionSummary = selectedSession?.summary || selectedSession?.name || selectedSession?.title;
  if (typeof sessionSummary === 'string' && sessionSummary.trim()) {
    const normalized = sessionSummary.replace(/\s+/g, ' ').trim();
    return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
  }

  const normalizedFallback = fallbackInput.replace(/\s+/g, ' ').trim();
  if (!normalizedFallback) {
    return null;
  }

  return normalizedFallback.length > 80 ? `${normalizedFallback.slice(0, 77)}...` : normalizedFallback;
};

export function useChatComposerState({
  selectedProject,
  selectedSession,
  currentSessionId,
  provider,
  claudeProfileId,
  runtimeNodeId,
  permissionMode,
  cyclePermissionMode,
  resolvePermissionModeForProvider,
  currentProviderModel,
  currentProviderEffort,
  isLoading,
  processingSessions,
  canAbortSession,
  tokenBudget,
  sendMessage,
  sendByCtrlEnter,
  onSessionProcessing,
  onSessionEstablished,
  onInputFocusChange,
  onFileOpen,
  onShowSettings,
  scrollToBottom,
  addMessage,
  setIsUserScrolledUp,
  pendingPermissionRequests,
  setPendingPermissionRequests,
  dismissedPermissionRequestIdsRef,
  suppressSharedProjectDraft = false,
  steeringSessionIdsRef,
}: UseChatComposerStateArgs) {
  const [input, setInput] = useState(() => {
    if (typeof window !== 'undefined' && selectedProject) {
      // Draft inputs are keyed by the DB projectId so per-project drafts
      // survive display-name changes.
      return safeLocalStorage.getItem(`draft_input_${selectedProject.projectId}`) || '';
    }
    return '';
  });
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  const [uploadingFiles, setUploadingFiles] = useState<Map<string, number>>(new Map());
  const [fileErrors, setFileErrors] = useState<Map<string, string>>(new Map());
  const [isTextareaExpanded, setIsTextareaExpanded] = useState(false);
  const [commandModalPayload, setCommandModalPayload] = useState<CommandModalPayload | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputHighlightRef = useRef<HTMLDivElement>(null);
  const textareaLineHeightRef = useRef<number | null>(null);
  const lastAutosizedInputRef = useRef<string | null>(null);
  const handleSubmitRef = useRef<
    ((
      event: FormEvent<HTMLFormElement> | MouseEvent | TouchEvent | KeyboardEvent<HTMLTextAreaElement>,
      queuedSubmission?: QueuedDraft,
    ) => Promise<boolean | void>) | null
  >(null);
  const inputValueRef = useRef(input);
  const selectedProjectId = selectedProject?.projectId;
  // Prefer the stable backend-allocated id (selectedSession.id) but fall back
  // to currentSessionId for a just-established session that hasn't been
  // handed back to the parent's `selectedSession` prop yet.
  const sessionKey = selectedSession?.id || currentSessionId || null;
  const sessionKeyRef = useRef(sessionKey);
  const processingSessionsRef = useRef<SessionActivityMap | undefined>(processingSessions);
  sessionKeyRef.current = sessionKey;
  processingSessionsRef.current = processingSessions;

  const [queuedDraft, setQueuedDraft] = useState<QueuedDraft | null>(() => {
    if (typeof window === 'undefined' || !sessionKey) {
      return null;
    }
    return restoreQueuedDraft(sessionKey);
  });
  // Which session the in-memory `queuedDraft` belongs to. On a session switch
  // there is one commit where `sessionKey` already points at the new session
  // while `queuedDraft` still holds the old session's draft; the persistence
  // effect must not write across that gap.
  const queuedDraftSessionRef = useRef<string | null>(sessionKey);

  const handleBuiltInCommand = useCallback(
    (result: CommandExecutionResult) => {
      const { action, data } = result;
      switch (action) {
        case 'help':
          setCommandModalPayload({
            kind: 'help',
            data: (data || {}) as HelpCommandData,
          });
          break;

        case 'models':
          setCommandModalPayload({
            kind: 'models',
            data: (data || {}) as ModelCommandData,
          });
          break;

        case 'cost': {
          setCommandModalPayload({
            kind: 'cost',
            data: (data || {}) as CostCommandData,
          });
          break;
        }

        case 'status': {
          setCommandModalPayload({
            kind: 'status',
            data: (data || {}) as StatusCommandData,
          });
          break;
        }

        case 'memory':
          if (data.error) {
            addMessage({
              type: 'assistant',
              content: `Warning: ${data.message}`,
              timestamp: Date.now(),
            });
          } else {
            addMessage({
              type: 'assistant',
              content: `${data.message}\n\nPath: \`${data.path}\``,
              timestamp: Date.now(),
            });
            if (data.exists && onFileOpen) {
              onFileOpen(data.path);
            }
          }
          break;

        case 'config':
          onShowSettings?.();
          break;

        default:
          console.warn('Unknown built-in command action:', action);
      }
    },
    [onFileOpen, onShowSettings, addMessage],
  );

  const closeCommandModal = useCallback(() => {
    setCommandModalPayload(null);
  }, []);

  const handleCustomCommand = useCallback(async (result: CommandExecutionResult) => {
    const { content, hasBashCommands } = result;

    if (hasBashCommands) {
      const confirmed = window.confirm(
        'This command contains bash commands that will be executed. Do you want to proceed?',
      );
      if (!confirmed) {
        addMessage({
          type: 'assistant',
          content: 'Command execution cancelled',
          timestamp: Date.now(),
        });
        return;
      }
    }

    const commandContent = content || '';
    setInput(commandContent);
    inputValueRef.current = commandContent;

    // Defer submit to next tick so the command text is reflected in UI before dispatching.
    setTimeout(() => {
      if (handleSubmitRef.current) {
        handleSubmitRef.current(createFakeSubmitEvent());
      }
    }, 0);
  }, [addMessage]);

  const executeCommand = useCallback(
    async (command: SlashCommand, rawInput?: string, options?: { preserveInput?: boolean }) => {
      if (!command || !selectedProject) {
        return;
      }

      try {
        const effectiveInput = rawInput ?? input;
        const commandMatch = effectiveInput.match(new RegExp(`${escapeRegExp(command.name)}\\s*(.*)`));
        const args =
          commandMatch && commandMatch[1] ? commandMatch[1].trim().split(/\s+/) : [];

        // The `/api/commands/execute` context sends `projectId` now instead of
        // a folder-derived project name; the path is still included verbatim.
        const context = {
          projectPath: selectedProject.fullPath || selectedProject.path,
          projectId: selectedProject.projectId,
          sessionId: currentSessionId || selectedSession?.id || null,
          provider,
          model: currentProviderModel,
          tokenUsage: tokenBudget,
        };

        const response = await authenticatedFetch('/api/commands/execute', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            commandName: command.name,
            commandPath: command.path,
            args,
            context,
          }),
        });

        if (!response.ok) {
          let errorMessage = `Failed to execute command (${response.status})`;
          try {
            const errorData = await response.json();
            errorMessage = errorData?.message || errorData?.error || errorMessage;
          } catch {
            // Ignore JSON parse failures and use fallback message.
          }
          throw new Error(errorMessage);
        }

        const result = (await response.json()) as CommandExecutionResult;
        if (result.type === 'builtin') {
          handleBuiltInCommand(result);
          if (!options?.preserveInput) {
            setInput('');
            inputValueRef.current = '';
          }
        } else if (result.type === 'custom') {
          await handleCustomCommand(result);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error('Error executing command:', error);
        addMessage({
          type: 'assistant',
          content: `Error executing command: ${message}`,
          timestamp: Date.now(),
        });
      }
    },
    [
      currentProviderModel,
      currentSessionId,
      handleBuiltInCommand,
      handleCustomCommand,
      input,
      provider,
      selectedProject,
      selectedSession?.id,
      addMessage,
      tokenBudget,
    ],
  );

  const showCostModal = useCallback(() => {
    executeCommand(
      {
        name: '/cost',
        description: 'Display token usage information',
        namespace: 'builtin',
        metadata: { type: 'builtin' },
      } as SlashCommand,
      '/cost',
      { preserveInput: true },
    );
  }, [executeCommand]);

  const {
    slashCommands,
    slashCommandsCount,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    handleCommandInputChange,
    handleCommandMenuKeyDown,
  } = useSlashCommands({
    selectedProject,
    provider,
    input,
    setInput,
    textareaRef,
    onExecuteCommand: executeCommand,
  });

  const {
    showFileDropdown,
    filteredFiles,
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    setCursorPosition,
    handleFileMentionsKeyDown,
  } = useFileMentions({
    selectedProject,
    input,
    setInput,
    textareaRef,
  });

  const syncInputOverlayScroll = useCallback((target: HTMLTextAreaElement) => {
    if (!inputHighlightRef.current || !target) {
      return;
    }
    inputHighlightRef.current.scrollTop = target.scrollTop;
    inputHighlightRef.current.scrollLeft = target.scrollLeft;
  }, []);

  const resizeTextarea = useCallback((target: HTMLTextAreaElement) => {
    target.style.height = 'auto';
    const nextHeight = Math.max(22, target.scrollHeight);
    target.style.height = `${nextHeight}px`;

    let lineHeight = textareaLineHeightRef.current;
    if (!lineHeight) {
      lineHeight = parseInt(window.getComputedStyle(target).lineHeight);
      textareaLineHeightRef.current = Number.isFinite(lineHeight) ? lineHeight : 24;
    }

    const expanded = nextHeight > (textareaLineHeightRef.current || 24) * 2;
    setIsTextareaExpanded((previous) => previous === expanded ? previous : expanded);
    lastAutosizedInputRef.current = target.value;
  }, []);

  const handleAttachmentFiles = useCallback((files: File[]) => {
    const validFiles = files.filter((file) => {
      try {
        if (!file || typeof file !== 'object') {
          console.warn('Invalid file object:', file);
          return false;
        }

        if (file.size > MAX_ATTACHMENT_SIZE) {
          const fileName = file.name || 'Unknown file';
          setFileErrors((previous) => {
            const next = new Map(previous);
            next.set(fileName, 'File too large (max 10MB)');
            return next;
          });
          return false;
        }

        return true;
      } catch (error) {
        console.error('Error validating file:', error, file);
        return false;
      }
    });

    if (validFiles.length > 0) {
      setAttachedFiles((previous) => [...previous, ...validFiles].slice(0, MAX_ATTACHMENT_COUNT));
    }
  }, []);

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const items = Array.from(event.clipboardData.items);

      items.forEach((item) => {
        if (!item.type.startsWith('image/')) {
          return;
        }
        const file = item.getAsFile();
        if (file) {
          handleAttachmentFiles([file]);
        }
      });

      if (items.length === 0 && event.clipboardData.files.length > 0) {
        const files = Array.from(event.clipboardData.files);
        const imageFiles = files.filter((file) => file.type.startsWith('image/'));
        if (imageFiles.length > 0) {
          handleAttachmentFiles(imageFiles);
        }
      }
    },
    [handleAttachmentFiles],
  );

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    maxSize: MAX_ATTACHMENT_SIZE,
    maxFiles: MAX_ATTACHMENT_COUNT,
    onDrop: handleAttachmentFiles,
    noClick: true,
    noKeyboard: true,
  });

  // Snapshot of everything `chat.send` needs beyond the text itself. Built at
  // send time for immediate sends and at queue time for queued ones, so a
  // queued message keeps the provider settings it was composed under even if
  // it is later dispatched outside this composer (app-level auto-send).
  const buildSendOptions = useCallback((currentInput: string): QueuedSendOptions => {
    const getToolsSettings = () => {
      try {
        const settingsKey =
          provider === 'cursor'
            ? 'cursor-tools-settings'
            : provider === 'codex'
              ? 'codex-settings'
              : provider === 'opencode'
                  ? 'opencode-settings'
                : 'claude-settings';
        const savedSettings = safeLocalStorage.getItem(settingsKey);
        if (savedSettings) {
          return JSON.parse(savedSettings);
        }
      } catch (error) {
        console.error('Error loading tools settings:', error);
      }

      return {
        allowedTools: [],
        disallowedTools: [],
        skipPermissions: false,
      };
    };

    const toolsSettings = getToolsSettings();

    return {
      model: currentProviderModel,
      effort: currentProviderEffort,
      permissionMode: resolvePermissionModeForProvider(provider, permissionMode),
      toolsSettings,
      skipPermissions: toolsSettings?.skipPermissions || false,
      sessionSummary: getNotificationSessionSummary(selectedSession, currentInput),
    };
  }, [
    currentProviderEffort,
    currentProviderModel,
    permissionMode,
    provider,
    resolvePermissionModeForProvider,
    selectedSession,
  ]);

  const handleSubmit = useCallback(
    async (
      event: FormEvent<HTMLFormElement> | MouseEvent | TouchEvent | KeyboardEvent<HTMLTextAreaElement>,
      queuedSubmission?: QueuedDraft,
    ) => {
      event.preventDefault();
      const currentInput = queuedSubmission?.content ?? inputValueRef.current;
      const currentAttachments = queuedSubmission?.attachments ?? attachedFiles;
      const previouslyUploadedAttachments = queuedSubmission?.uploadedAttachments ?? [];
      if (
        (
          !currentInput.trim()
          && currentAttachments.length === 0
          && previouslyUploadedAttachments.length === 0
        )
        || !selectedProject
      ) {
        return;
      }

      // A turn is already in flight: stash this message instead of sending it.
      // Upload attached files now so the queued record contains durable image
      // descriptors that can be sent even if another session is open later.
      if (isLoading) {
        // A run can restart in the tiny gap between scheduling and flushing a
        // queued submission. Put the same durable draft back without uploading
        // its files again.
        if (queuedSubmission) {
          queuedDraftSessionRef.current = sessionKey;
          setQueuedDraft(queuedSubmission);
          return;
        }

        const queuedOptions = buildSendOptions(currentInput);
        const queuedSessionKey = sessionKey;
        let uploadedAttachments: unknown[] = [];
        try {
          uploadedAttachments = await uploadAttachmentFiles(currentAttachments);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          console.error('Queued file upload failed:', error);
          addMessage({
            type: 'error',
            content: `Failed to upload files: ${message}`,
            timestamp: new Date(),
          });
          return;
        }

        const durableDraft: QueuedDraft = {
          content: currentInput,
          attachments: currentAttachments,
          uploadedAttachments,
          options: queuedOptions,
        };
        let queuedMessageSaved: Promise<void> | null = null;
        if (queuedSessionKey) {
          // Write the claim ticket synchronously after upload; this closes the
          // gap before React's persistence effect runs.
          const storedMessage: StoredQueuedMessage = {
            content: durableDraft.content,
            options: durableDraft.options,
            attachments: durableDraft.uploadedAttachments,
          };
          writeQueuedMessage(queuedSessionKey, storedMessage);
          // Best-effort: the server row is the authoritative queue (survives
          // a closed tab or cleared storage); localStorage above is only the
          // same-tab optimistic mirror. Kept so the branch below can wait for
          // it before trying to claim what it just wrote.
          queuedMessageSaved = saveQueuedMessageOnServer(queuedSessionKey, storedMessage).catch((error) => {
            console.error('Failed to persist queued message on the server:', error);
          });
        }

        // The upload is asynchronous. If the user changed sessions while it
        // was running, persist/send against the session where Queue was
        // pressed rather than putting the draft into the newly opened chat.
        if (queuedSessionKey && sessionKeyRef.current !== queuedSessionKey) {
          if (
            processingSessionsRef.current
            && !processingSessionsRef.current.has(queuedSessionKey)
          ) {
            // Same authoritative claim protocol as the other flush paths:
            // wait for our own save to land, then only a successful claim may
            // dispatch. This is what prevents a double-send against the
            // app-level auto-send — which also watches this now-backgrounded
            // session — or another tab/device.
            await queuedMessageSaved;
            const claimed = await fetchAndClaimQueuedMessage(queuedSessionKey).catch((error) => {
              console.error('Failed to claim queued message for dispatch:', error);
              return null;
            });
            if (claimed) {
              clearQueuedMessage(queuedSessionKey);
              const claimedMessage = claimed.message;
              const delivered = sendMessage({
                type: 'chat.send',
                sessionId: queuedSessionKey,
                content: claimedMessage.content,
                options: {
                  ...(claimedMessage.options ?? {}),
                  attachments: claimedMessage.attachments ?? [],
                },
              });
              onSessionProcessing?.(queuedSessionKey, { statusText: null, canInterrupt: true });
              if (!delivered) {
                // The socket wasn't open when we tried to send: put the
                // claimed message back instead of losing it silently.
                restoreQueuedMessageOnServer(queuedSessionKey, claimed.claimToken).catch((error) => {
                  console.error('Failed to restore an undelivered queued message:', error);
                });
              }
            }
            // If `claimed` is null, either nothing was queued or another
            // path/tab/device already claimed it first — don't send a
            // duplicate.
          }
          return;
        }

        queuedDraftSessionRef.current = queuedSessionKey;
        setQueuedDraft(durableDraft);
        setInput('');
        inputValueRef.current = '';
        setAttachedFiles([]);
        setUploadingFiles(new Map());
        setFileErrors(new Map());
        resetCommandMenuState();
        setIsTextareaExpanded(false);
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto';
        }
        // selectedProject is guaranteed by the guard at the top of handleSubmit.
        safeLocalStorage.removeItem(`draft_input_${selectedProject.projectId}`);
        return;
      }

      // Intercept slash commands only when "/" is the first input character.
      // Also accept exact "help" as a convenience alias for users who expect CLI-style help.
      const commandInput = currentInput.trimEnd();
      const isHelpAlias = commandInput.trim().toLowerCase() === 'help';
      if (commandInput.startsWith('/') || isHelpAlias) {
        const firstSpace = commandInput.indexOf(' ');
        const commandName = isHelpAlias
          ? '/help'
          : firstSpace > 0 ? commandInput.slice(0, firstSpace) : commandInput;
        const matchedCommand =
          slashCommands.find((cmd: SlashCommand) => cmd.name === commandName) ||
          (commandName === '/help'
            ? ({
                name: '/help',
                description: 'Show help documentation for Claude Code',
                namespace: 'builtin',
                metadata: { type: 'builtin' },
              } as SlashCommand)
            : undefined);
        if (matchedCommand && matchedCommand.type !== 'skill') {
          executeCommand(matchedCommand, isHelpAlias ? '/help' : commandInput);
          setInput('');
          inputValueRef.current = '';
          setAttachedFiles([]);
          setUploadingFiles(new Map());
          setFileErrors(new Map());
          resetCommandMenuState();
          setIsTextareaExpanded(false);
          if (textareaRef.current) {
            textareaRef.current.style.height = 'auto';
          }
          return;
        }
      }

      const messageContent = currentInput;

      let uploadedAttachments = previouslyUploadedAttachments;
      if (uploadedAttachments.length === 0 && currentAttachments.length > 0) {
        try {
          uploadedAttachments = await uploadAttachmentFiles(currentAttachments);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          console.error('File upload failed:', error);
          addMessage({
            type: 'error',
            content: `Failed to upload files: ${message}`,
            timestamp: new Date(),
          });
          return;
        }
      }

      const resolvedProjectPath = selectedProject.fullPath || selectedProject.path || '';
      const sessionSummary = getNotificationSessionSummary(selectedSession, currentInput);

      // The conversation always has a stable backend-allocated session id
      // BEFORE the first websocket send: brand-new chats allocate one here
      // via the session gateway. There is no client-visible session-id
      // handoff later — this id stays valid for the conversation's lifetime.
      let targetSessionId = selectedSession?.id || currentSessionId || null;
      if (!targetSessionId) {
        let createdSessionName = sessionSummary;
        let boundClaudeProfileId: string | null = null;
        try {
          const response = await authenticatedFetch('/api/providers/sessions', {
            method: 'POST',
            body: JSON.stringify({
              provider,
              projectPath: resolvedProjectPath,
              initialMessage: messageContent,
              // Ignored server-side for non-Claude providers; the backend
              // resolves and validates it once, at creation, and that
              // binding is permanent (CLOUDCLI_EXTENSION_PLAN.md F4/F5).
              claudeProfileId: provider === 'claude' ? claudeProfileId ?? undefined : undefined,
              // The runtime node this new Run is bound to when backend truth
              // implies exactly one; omitted otherwise so the server applies
              // its own rule instead of a client guess (FT-M07).
              runtimeNodeId: runtimeNodeId ?? undefined,
            }),
          });
          if (!response.ok) {
            throw new Error(`Failed to create session (${response.status})`);
          }
          const body = await response.json();
          targetSessionId = body?.data?.sessionId || null;
          boundClaudeProfileId = typeof body?.data?.claudeProfileId === 'string' ? body.data.claudeProfileId : null;
          // A blank server name would leave the session unlabeled, so the local
          // summary stays the fallback unless a real name comes back.
          const returnedSessionName = typeof body?.data?.sessionName === 'string'
            ? body.data.sessionName.trim()
            : '';
          if (returnedSessionName) {
            createdSessionName = returnedSessionName;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          console.error('Session creation failed:', error);
          addMessage({
            type: 'error',
            content: `Failed to start a new session: ${message}`,
            timestamp: new Date(),
          });
          return;
        }

        if (!targetSessionId) {
          addMessage({
            type: 'error',
            content: 'Failed to start a new session: no session id returned.',
            timestamp: new Date(),
          });
          return;
        }

        onSessionEstablished?.(targetSessionId, {
          provider,
          project: selectedProject,
          summary: createdSessionName,
          claudeProfileId: boundClaudeProfileId,
        });
      }

      const attachmentRecords = uploadedAttachments as ChatAttachment[];
      const userMessage: ChatMessage = {
        type: 'user',
        content: currentInput,
        images: attachmentRecords.filter(isImageAttachment),
        files: attachmentRecords.filter((attachment) => !isImageAttachment(attachment)),
        timestamp: new Date(),
      };

      addMessage(userMessage);
      // Mark this request as processing in the per-session activity map (the
      // single source of truth the indicator derives from). The id is always
      // concrete at this point — no pending placeholder exists anymore.
      onSessionProcessing?.(targetSessionId, {
        statusText: null,
        canInterrupt: true,
      });

      setIsUserScrolledUp(false);
      setTimeout(() => scrollToBottom(), 100);

      // One message shape for every provider. The backend resolves the
      // provider, project path, and provider-native resume id from the
      // session row; `options` only carries composer-level preferences.
      const delivered = sendMessage({
        type: 'chat.send',
        sessionId: targetSessionId,
        content: messageContent,
        options: {
          ...(queuedSubmission?.options ?? buildSendOptions(messageContent)),
          attachments: uploadedAttachments,
        },
      });

      setInput('');
      inputValueRef.current = '';
      resetCommandMenuState();
      setAttachedFiles([]);
      setUploadingFiles(new Map());
      setFileErrors(new Map());
      setIsTextareaExpanded(false);

      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }

      safeLocalStorage.removeItem(`draft_input_${selectedProject.projectId}`);
      // Lets a queued-message dispatch (the only caller that passes
      // `queuedSubmission`) know whether it needs to restore its server claim.
      return delivered;
    },
    [
      selectedSession,
      attachedFiles,
      buildSendOptions,
      currentSessionId,
      claudeProfileId,
      runtimeNodeId,
      executeCommand,
      isLoading,
      onSessionProcessing,
      onSessionEstablished,
      provider,
      resetCommandMenuState,
      scrollToBottom,
      selectedProject,
      sendMessage,
      sessionKey,
      addMessage,
      setIsUserScrolledUp,
      slashCommands,
    ],
  );

  useEffect(() => {
    handleSubmitRef.current = handleSubmit;
  }, [handleSubmit]);

  // Once the in-flight turn ends, replay the queued draft through the normal
  // submit path. The draft itself is passed directly so submission never
  // depends on React committing restored attachment state first.
  const wasLoadingRef = useRef(isLoading);
  const flushSessionKeyRef = useRef(sessionKey);
  useEffect(() => {
    const wasLoading = wasLoadingRef.current;
    wasLoadingRef.current = isLoading;

    // A session switch changes which session `isLoading` describes, so this
    // transition says nothing about the queued draft's own session. Never
    // flush across it — the swap effect below replaces `queuedDraft` with the
    // new session's saved draft right after this.
    if (flushSessionKeyRef.current !== sessionKey) {
      flushSessionKeyRef.current = sessionKey;
      return;
    }

    if (isLoading || !queuedDraft) {
      return;
    }

    // Turn just ended in this session: flush immediately. Otherwise this is a
    // saved draft restored into an apparently idle session — hold it briefly
    // so the `chat_subscribed` ack can flip `isLoading` if a run is actually
    // still live (the cleanup below cancels the send in that case).
    const delay = wasLoading ? 0 : 750;
    const timer = setTimeout(() => {
      if (!sessionKey) {
        setQueuedDraft(null);
        return;
      }
      // The server row is the claim ticket shared with the app-level
      // auto-send (which handles sessions that finish while not viewed), the
      // mid-upload session-switch send below, and any other open tab/device.
      // Only a successful claim may dispatch — this is what makes
      // double-send impossible across all of them, not just within this
      // composer.
      fetchAndClaimQueuedMessage(sessionKey)
        .then((claimed) => {
          if (!claimed) {
            // Nothing queued, or another path/tab/device claimed it first —
            // don't send a duplicate.
            setQueuedDraft(null);
            return;
          }
          clearQueuedMessage(sessionKey);
          const claimedMessage = claimed.message;
          const dispatchDraft: QueuedDraft = {
            content: claimedMessage.content,
            attachments: [],
            uploadedAttachments: claimedMessage.attachments,
            options: claimedMessage.options,
          };
          setQueuedDraft(null);
          setInput(dispatchDraft.content);
          inputValueRef.current = dispatchDraft.content;
          setAttachedFiles([]);
          Promise.resolve(handleSubmitRef.current?.(createFakeSubmitEvent(), dispatchDraft)).then((delivered) => {
            if (delivered === false) {
              // The socket wasn't open when we tried to send: put the claimed
              // message back instead of losing it silently.
              restoreQueuedMessageOnServer(sessionKey, claimed.claimToken).catch((error) => {
                console.error('Failed to restore an undelivered queued message:', error);
              });
            }
          });
        })
        .catch((error) => {
          console.error('Failed to claim queued message for dispatch:', error);
        });
    }, delay);
    return () => clearTimeout(timer);
  }, [isLoading, queuedDraft, sessionKey, setInput]);

  const editQueuedDraft = useCallback(() => {
    if (!queuedDraft) {
      return;
    }
    setQueuedDraft(null);
    setInput(queuedDraft.content);
    inputValueRef.current = queuedDraft.content;
    setAttachedFiles(queuedDraft.attachments);
    textareaRef.current?.focus();
  }, [queuedDraft]);

  const deleteQueuedDraft = useCallback(() => {
    setQueuedDraft(null);
  }, []);

  // A voice transcript either fills the input (to edit before sending) or, when the
  // user tapped "stop and send", is submitted straight away. Mirror the value into
  // inputValueRef synchronously so handleSubmit reads the new text, not the stale state.
  const handleVoiceTranscript = useCallback((text: string, send?: boolean) => {
    const base = inputValueRef.current.trim();
    const next = base ? `${base} ${text}` : text;
    setInput(next);
    inputValueRef.current = next;
    if (send) handleSubmitRef.current?.(createFakeSubmitEvent());
  }, [setInput]);

  useEffect(() => {
    inputValueRef.current = input;
  }, [input]);

  useEffect(() => {
    if (!selectedProjectId) {
      return;
    }
    const savedInput = safeLocalStorage.getItem(`draft_input_${selectedProjectId}`) || '';
    setInput((previous) => {
      const next = previous === savedInput ? previous : savedInput;
      inputValueRef.current = next;
      return next;
    });
  }, [selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId || suppressSharedProjectDraft) {
      return;
    }
    if (input !== '') {
      safeLocalStorage.setItem(`draft_input_${selectedProjectId}`, input);
    } else {
      safeLocalStorage.removeItem(`draft_input_${selectedProjectId}`);
    }
  }, [input, selectedProjectId, suppressSharedProjectDraft]);

  // Persist the queued draft under its session's key. Must be defined BEFORE
  // the swap effect below: on a session switch there is one commit where
  // `sessionKey` already points at the new session while `queuedDraft` (and
  // the owner ref) still describe the old one — the ref mismatch makes this
  // effect skip that commit instead of writing/clearing across sessions.
  useEffect(() => {
    if (!sessionKey || queuedDraftSessionRef.current !== sessionKey) {
      return;
    }
    if (
      queuedDraft
      && (queuedDraft.content.trim() || (queuedDraft.uploadedAttachments?.length ?? 0) > 0)
    ) {
      const storedMessage: StoredQueuedMessage = {
        content: queuedDraft.content,
        options: queuedDraft.options,
        attachments: queuedDraft.uploadedAttachments,
      };
      writeQueuedMessage(sessionKey, storedMessage);
      saveQueuedMessageOnServer(sessionKey, storedMessage).catch((error) => {
        console.error('Failed to persist queued message on the server:', error);
      });
    } else {
      clearQueuedMessage(sessionKey);
      clearQueuedMessageOnServer(sessionKey).catch((error) => {
        console.error('Failed to clear queued message on the server:', error);
      });
    }
  }, [queuedDraft, sessionKey]);

  // Switching sessions swaps in that session's queued draft. Browser File
  // objects are local to the mounted composer, while their already-uploaded
  // descriptors restore from storage and remain sendable.
  useEffect(() => {
    queuedDraftSessionRef.current = sessionKey;
    if (!sessionKey) {
      setQueuedDraft(null);
      return;
    }
    setQueuedDraft(restoreQueuedDraft(sessionKey));
  }, [sessionKey]);

  // Reconciles the local (localStorage) mirror against the server, which is
  // the authoritative queue. Runs after the synchronous local restore above,
  // so a queue claimed while this tab was closed (or queued from another
  // device, or lost to cleared storage) doesn't leave a stale or missing
  // card once the server responds.
  useEffect(() => {
    if (!sessionKey) {
      return;
    }
    const reconcileSessionKey = sessionKey;
    let cancelled = false;
    fetchQueuedMessage(reconcileSessionKey)
      .then(({ message }) => {
        if (cancelled || queuedDraftSessionRef.current !== reconcileSessionKey) {
          return;
        }
        if (message) {
          writeQueuedMessage(reconcileSessionKey, message);
          setQueuedDraft({
            content: message.content,
            attachments: [],
            uploadedAttachments: message.attachments,
            options: message.options,
          });
        } else if (readQueuedMessage(reconcileSessionKey)) {
          clearQueuedMessage(reconcileSessionKey);
          setQueuedDraft(null);
        }
      })
      .catch((error) => {
        console.error('Failed to reconcile queued message with the server:', error);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionKey]);

  useEffect(() => {
    if (!textareaRef.current) {
      return;
    }
    if (lastAutosizedInputRef.current === input) {
      return;
    }
    // Re-run for restored drafts and programmatic input changes. User typing is
    // already resized in onInput, so this avoids doing the same forced layout twice.
    resizeTextarea(textareaRef.current);
  }, [input, resizeTextarea]);

  useEffect(() => {
    if (!textareaRef.current || input.trim()) {
      return;
    }
    textareaRef.current.style.height = 'auto';
    setIsTextareaExpanded(false);
  }, [input]);

  const handleInputChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = event.target.value;
      const cursorPos = event.target.selectionStart;

      setInput(newValue);
      inputValueRef.current = newValue;
      setCursorPosition(cursorPos);

      if (!newValue.trim()) {
        event.target.style.height = 'auto';
        setIsTextareaExpanded(false);
        resetCommandMenuState();
        return;
      }

      handleCommandInputChange(newValue, cursorPos);
    },
    [handleCommandInputChange, resetCommandMenuState, setCursorPosition],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (handleCommandMenuKeyDown(event)) {
        return;
      }

      if (handleFileMentionsKeyDown(event)) {
        return;
      }

      if (event.key === 'Tab' && !showFileDropdown && !showCommandMenu) {
        event.preventDefault();
        cyclePermissionMode();
        return;
      }

      if (event.key === 'Enter') {
        if (event.nativeEvent.isComposing) {
          return;
        }

        if ((event.ctrlKey || event.metaKey) && !event.shiftKey) {
          event.preventDefault();
          handleSubmit(event);
        } else if (!event.shiftKey && !event.ctrlKey && !event.metaKey && !sendByCtrlEnter) {
          event.preventDefault();
          handleSubmit(event);
        }
      }
    },
    [
      cyclePermissionMode,
      handleCommandMenuKeyDown,
      handleFileMentionsKeyDown,
      handleSubmit,
      sendByCtrlEnter,
      showCommandMenu,
      showFileDropdown,
    ],
  );

  const handleTextareaClick = useCallback(
    (event: MouseEvent<HTMLTextAreaElement>) => {
      setCursorPosition(event.currentTarget.selectionStart);
    },
    [setCursorPosition],
  );

  const handleTextareaInput = useCallback(
    (event: FormEvent<HTMLTextAreaElement>) => {
      const target = event.currentTarget;
      resizeTextarea(target);
      setCursorPosition(target.selectionStart);
      syncInputOverlayScroll(target);
    },
    [resizeTextarea, setCursorPosition, syncInputOverlayScroll],
  );

  const handleClearInput = useCallback(() => {
    setInput('');
    inputValueRef.current = '';
    resetCommandMenuState();
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.focus();
    }
    setIsTextareaExpanded(false);
  }, [resetCommandMenuState]);

  const handleAbortSession = useCallback(() => {
    if (!canAbortSession) {
      return;
    }

    const targetSessionId = selectedSession?.id || currentSessionId || null;
    if (!targetSessionId) {
      console.warn('Abort requested but no session ID is available.');
      return;
    }

    // The backend resolves the provider from the session row, so no provider
    // field is needed here.
    sendMessage({
      type: 'chat.abort',
      sessionId: targetSessionId,
    });
  }, [canAbortSession, currentSessionId, selectedSession?.id, sendMessage]);

  /**
   * FT-M06: interrupts the ACTIVE run and immediately dispatches the
   * composer's current content as the session's next turn — never through
   * `queued_messages`, never a new session. Only meaningful while a run is
   * genuinely in progress on an already-existing session; a brand-new,
   * not-yet-created session has no active run to steer, so this is a no-op
   * for it rather than falling back to creating one (that would silently
   * turn Steer into a plain send).
   *
   * Returns whether the frame was actually sent, so the composer's
   * arm/confirm button can tell a real dispatch from "nothing to send" or
   * "socket closed" without waiting on the server's asynchronous verdict
   * (`STEER_NOT_ACTIVE` arrives, if at all, as a normal `protocol_error` —
   * the same generic path every other send error already surfaces through).
   */
  const handleSteerNow = useCallback(async (): Promise<boolean> => {
    const targetSessionId = selectedSession?.id || currentSessionId || null;
    if (!targetSessionId || !isLoading) {
      return false;
    }

    const currentInput = inputValueRef.current;
    const currentAttachments = attachedFiles;
    if (!currentInput.trim() && currentAttachments.length === 0) {
      return false;
    }

    let uploadedAttachments: unknown[] = [];
    if (currentAttachments.length > 0) {
      try {
        uploadedAttachments = await uploadAttachmentFiles(currentAttachments);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error('Steer file upload failed:', error);
        addMessage({
          type: 'error',
          content: `Failed to upload files: ${message}`,
          timestamp: new Date(),
        });
        return false;
      }
    }

    const attachmentRecords = uploadedAttachments as ChatAttachment[];
    addMessage({
      type: 'user',
      content: currentInput,
      images: attachmentRecords.filter(isImageAttachment),
      files: attachmentRecords.filter((attachment) => !isImageAttachment(attachment)),
      timestamp: new Date(),
    });

    // Recorded before sending: the interrupted turn's own terminal `complete`
    // can arrive before the steered turn produces its first event, and must
    // not be read as "this session is idle now" — see
    // `useChatRealtimeHandlers`'s `complete` case.
    steeringSessionIdsRef?.current.add(targetSessionId);

    const delivered = sendMessage({
      type: 'chat.steer',
      sessionId: targetSessionId,
      content: currentInput,
      options: {
        ...buildSendOptions(currentInput),
        attachments: uploadedAttachments,
      },
    });

    if (!delivered) {
      // Never sent: the stale-complete guard above would otherwise wait
      // forever for a `chat.steer` response that never went out.
      steeringSessionIdsRef?.current.delete(targetSessionId);
      return false;
    }

    onSessionProcessing?.(targetSessionId, { statusText: null, canInterrupt: true });
    setInput('');
    inputValueRef.current = '';
    resetCommandMenuState();
    setAttachedFiles([]);
    setUploadingFiles(new Map());
    setFileErrors(new Map());
    setIsTextareaExpanded(false);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
    if (selectedProject) {
      safeLocalStorage.removeItem(`draft_input_${selectedProject.projectId}`);
    }

    return true;
  }, [
    addMessage,
    attachedFiles,
    buildSendOptions,
    currentSessionId,
    isLoading,
    onSessionProcessing,
    resetCommandMenuState,
    selectedProject,
    selectedSession?.id,
    sendMessage,
    steeringSessionIdsRef,
  ]);

  const handleGrantToolPermission = useCallback(
    (suggestion: { entry: string; toolName: string }) => {
      if (!suggestion || provider !== 'claude') {
        return { success: false };
      }
      return grantClaudeToolPermission(suggestion.entry);
    },
    [provider],
  );

  // Mirrors the latest approvals, and is advanced synchronously when an answer
  // goes out, so a double tap inside one render cannot send it twice.
  const permissionRequestsRef = useRef(pendingPermissionRequests);
  permissionRequestsRef.current = pendingPermissionRequests;

  const handlePermissionDecision = useCallback(
    (
      requestIds: string | string[],
      decision: { allow?: boolean; message?: string; rememberEntry?: string | null; updatedInput?: unknown },
    ) => {
      const ids = Array.isArray(requestIds) ? requestIds : [requestIds];
      const targets = permissionRequestsRef.current.filter(
        (request) => ids.includes(request.requestId) && isAwaitingPermissionDecision(request),
      );
      if (targets.length === 0) {
        return;
      }

      const sentIds: string[] = [];
      const unsentIds: string[] = [];
      targets.forEach((request) => {
        const sent = sendMessage({
          type: 'chat.permission-response',
          requestId: request.requestId,
          // Lets the backend reject an answer aimed at another session's request.
          sessionId: request.sessionId ?? selectedSession?.id ?? currentSessionId ?? null,
          allow: Boolean(decision?.allow),
          updatedInput: decision?.updatedInput,
          message: decision?.message,
          rememberEntry: decision?.rememberEntry,
        });
        (sent ? sentIds : unsentIds).push(request.requestId);
      });

      // A request only leaves the list once the server confirms it (ack or
      // `permission_resolved`); an answer that never left stays answerable.
      permissionRequestsRef.current = markPermissionRequestsSubmitting(permissionRequestsRef.current, sentIds);
      setPendingPermissionRequests((previous) =>
        flagPermissionRequestsNotSent(markPermissionRequestsSubmitting(previous, sentIds), unsentIds),
      );
    },
    [currentSessionId, selectedSession?.id, sendMessage, setPendingPermissionRequests],
  );

  const handlePermissionDismiss = useCallback(
    (requestId: string) => {
      dismissedPermissionRequestIdsRef.current.add(requestId);
      setPendingPermissionRequests((previous) => removePermissionRequest(previous, requestId));
    },
    [dismissedPermissionRequestIdsRef, setPendingPermissionRequests],
  );

  const [isInputFocused, setIsInputFocused] = useState(false);

  const handleInputFocusChange = useCallback(
    (focused: boolean) => {
      setIsInputFocused(focused);
      onInputFocusChange?.(focused);
    },
    [onInputFocusChange],
  );

  return {
    input,
    setInput,
    textareaRef,
    inputHighlightRef,
    isTextareaExpanded,
    slashCommandsCount,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    showFileDropdown,
    filteredFiles: filteredFiles as MentionableFile[],
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    attachedFiles,
    setAttachedFiles,
    uploadingFiles,
    fileErrors,
    getRootProps,
    getInputProps,
    isDragActive,
    openAttachmentPicker: open,
    handleSubmit,
    queuedDraft,
    editQueuedDraft,
    deleteQueuedDraft,
    handleVoiceTranscript,
    handleInputChange,
    handleKeyDown,
    handlePaste,
    handleTextareaClick,
    handleTextareaInput,
    syncInputOverlayScroll,
    handleClearInput,
    handleAbortSession,
    handleSteerNow,
    handlePermissionDecision,
    handlePermissionDismiss,
    handleGrantToolPermission,
    handleInputFocusChange,
    isInputFocused,
    commandModalPayload,
    closeCommandModal,
    showCostModal,
  };
}
