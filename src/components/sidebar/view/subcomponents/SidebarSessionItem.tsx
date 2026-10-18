import { useEffect, useRef, useState } from 'react';
import { ArrowRightLeft, Check, Copy, Edit2, Loader2, MoreHorizontal, Trash2, X } from 'lucide-react';
import type { TFunction } from 'i18next';

import { ActionMenu, Badge, Dialog, DialogContent, DialogTitle } from '../../../../shared/view/ui';
import { cn } from '../../../../lib/utils';
import type { Project, ProjectSession, LLMProvider } from '../../../../types/app';
import type { SessionActivity } from '../../../../hooks/useSessionProtection';
import { api } from '../../../../utils/api';
import { copyTextToClipboard } from '../../../../utils/clipboard';
import { PROVIDER_LABELS, resolveExecutionIdentity, shouldShowProfileIdentity } from '../../../../shared/identity';
import ExecutionIdentityBadge from '../../../identity/view/ExecutionIdentityBadge';
import type { SessionWithProvider } from '../../types/types';
import { createSessionViewModel, formatCompactAge, formatElapsedDuration } from '../../utils/utils';
import LLMProviderLogo from '../../../llm-provider-logo/LLMProviderLogo';
import { readQueuedMessage } from '../../../chat/utils/chatStorage';
import { usePaletteOps } from '../../../../contexts/PaletteOpsContext';
import type { CreatedHandoff } from '../../../session-handoff/types/types';
import SessionHandoffDialog from '../../../session-handoff/view/SessionHandoffDialog';

type SidebarSessionItemProps = {
  project: Project;
  session: SessionWithProvider;
  selectedSession: ProjectSession | null;
  isProcessing: boolean;
  /** Full activity record for this session when it's processing, else null. */
  activity: SessionActivity | null;
  needsAttention: boolean;
  /** Only true on the "Running now" tab — shows the profile/state/elapsed/queued line. */
  showRunningDetail?: boolean;
  claudeProfileNameById: ReadonlyMap<string, string>;
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
  t: TFunction;
};

type CopyState = 'loading' | 'idle' | 'copying' | 'copied' | 'error';
export default function SidebarSessionItem({
  project,
  session,
  selectedSession,
  isProcessing,
  activity,
  needsAttention,
  showRunningDetail = false,
  claudeProfileNameById,
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
  t,
}: SidebarSessionItemProps) {
  const sessionView = createSessionViewModel(session, currentTime, t);
  const isSelected = selectedSession?.id === session.id;
  const isEditing = editingSession === session.id;
  const compactSessionAge = formatCompactAge(sessionView.sessionTime, currentTime);
  const editingContainerRef = useRef<HTMLDivElement>(null);
  const [isMobileOptionsOpen, setIsMobileOptionsOpen] = useState(false);
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const [providerSessionId, setProviderSessionId] = useState<string | null>(null);
  const providerIdRequestRef = useRef(0);
  const [isHandoffOpen, setIsHandoffOpen] = useState(false);
  const handoffFromMobileRef = useRef(false);
  const paletteOps = usePaletteOps();

  // A handoff target is a brand-new session: open it the same way a row tap
  // would (mobile also collapses the sidebar through project selection), then
  // resync the sidebar so the new row appears with its backend binding.
  const openHandoffTarget = (result: CreatedHandoff) => {
    const targetSession: SessionWithProvider = {
      id: result.sessionId,
      __provider: result.provider,
      __projectId: project.projectId,
      summary: result.sessionName,
      claudeProfileId: result.claudeProfileId,
    };
    if (handoffFromMobileRef.current) {
      onProjectSelect(project);
    }
    onSessionSelect(targetSession, project.projectId);
    void paletteOps.refreshProjects();
  };
  const showAttentionIndicator = needsAttention && !isSelected;
  const providerLabel = PROVIDER_LABELS[session.__provider];

  // Which account this row actually runs under. Both the live run and the
  // stored session read their binding from backend-owned data (`activity`
  // while running, the persisted session row otherwise) — never from the
  // current global profile selection. Shown only once more than one account
  // exists, because with a single account there is nothing to disambiguate.
  const showProfileIdentity = shouldShowProfileIdentity(claudeProfileNameById.size);
  const executionIdentity = resolveExecutionIdentity({
    provider: session.__provider,
    claudeProfileId: (isProcessing && activity ? activity.claudeProfileId : session.claudeProfileId) ?? null,
    profileNamesById: claudeProfileNameById,
    unresolvedLabel: t('running.unknownAccount', 'Unknown account'),
  });
  const identityBadge = showProfileIdentity && executionIdentity.profileLabel
    ? <ExecutionIdentityBadge identity={executionIdentity} />
    : null;

  // Compact "Running · 2m 14s" / "Waiting · 1 queued" line for the Running
  // Sessions tab, rendered after the account badge. Every fragment is a real,
  // provable signal: "Waiting" only appears when the server reports a genuine
  // pending approval (never inferred from silence), and elapsed time is
  // derived, not authoritative — it stops advancing the instant `activity`
  // disappears.
  const runningStatusLabel = (() => {
    if (!showRunningDetail || !isProcessing || !activity) {
      return null;
    }

    const stateLabel = activity.waiting
      ? t('running.stateWaiting', 'Waiting')
      : t('running.stateRunning', 'Running');
    const elapsedLabel = formatElapsedDuration(activity.startedAt, currentTime);
    const hasQueuedMessage = Boolean(readQueuedMessage(session.id));

    const parts = [stateLabel, elapsedLabel].filter(Boolean);
    if (hasQueuedMessage) {
      parts.push(t('running.queuedCount', '1 queued'));
    }
    return parts.join(' · ');
  })();

  // One shared metadata line per row: account badge, then either the live run
  // state or the resting message count — never both, and never more than one
  // identity. The count keeps its original standalone rendering when no badge
  // applies, so single-account installs see exactly what they see today.
  const messageCountBadge = sessionView.messageCount > 0
    ? <Badge variant="secondary" className="px-1 py-0 text-xs">{sessionView.messageCount}</Badge>
    : null;
  const trailingMeta = runningStatusLabel
    ? <p className="min-w-0 truncate text-[11px] text-muted-foreground">{runningStatusLabel}</p>
    : messageCountBadge;
  const sessionMetaLine = identityBadge
    ? (
      <div className="flex min-w-0 items-center gap-1.5">
        {identityBadge}
        {trailingMeta && (
          <span aria-hidden="true" className="flex-shrink-0 text-[11px] text-muted-foreground">·</span>
        )}
        {trailingMeta}
      </div>
    )
    : runningStatusLabel
      ? <p className="min-w-0 truncate text-[11px] text-muted-foreground">{runningStatusLabel}</p>
      : null;

  // While editing, dismiss only when the user clicks outside the inline rename panel
  // (matches Escape / cancel-button behaviour). The mobile rename lives inside the
  // bottom sheet, which owns its own dismissal, so the listener stays off there.
  useEffect(() => {
    if (!isEditing || isMobileOptionsOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      const container = editingContainerRef.current;
      if (container && !container.contains(event.target as Node)) {
        onCancelEditingSession();
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [isEditing, isMobileOptionsOpen, onCancelEditingSession]);

  // Sessions are owned by a project identified by `projectId` (DB primary key)
  // after the projectName → projectId migration.
  const selectMobileSession = () => {
    onProjectSelect(project);
    onSessionSelect(session, project.projectId);
  };

  const saveEditedSession = () => {
    onSaveEditingSession(project.projectId, session.id, editingSessionName, session.__provider);
  };

  const requestDeleteSession = () => {
    onDeleteSession(project.projectId, session.id, sessionView.sessionName, session.__provider);
  };

  const loadProviderSessionId = async () => {
    const requestId = ++providerIdRequestRef.current;
    setCopyState('loading');
    try {
      const response = await api.providerSessionId(session.id);
      const payload = await response.json();
      const loadedSessionId = payload?.data?.sessionId;
      if (!response.ok || typeof loadedSessionId !== 'string' || !loadedSessionId) {
        throw new Error('Provider session ID is unavailable');
      }

      if (requestId !== providerIdRequestRef.current) return;
      setProviderSessionId(loadedSessionId);
      setCopyState('idle');
    } catch {
      if (requestId !== providerIdRequestRef.current) return;
      setProviderSessionId(null);
      setCopyState('error');
    }
  };

  const resetCopyState = () => {
    providerIdRequestRef.current += 1;
    setCopyState('idle');
    setProviderSessionId(null);
  };

  const setOptionsOpen = (open: boolean) => {
    if (open) {
      setProviderSessionId(null);
      void loadProviderSessionId();
    } else {
      resetCopyState();
    }
  };

  const setMobileOptionsOpen = (open: boolean) => {
    setIsMobileOptionsOpen(open);
    setOptionsOpen(open);
    if (!open && isEditing) {
      onCancelEditingSession();
    }
  };

  const startMobileRename = () => {
    onStartEditingSession(session.id, sessionView.sessionName);
  };

  const saveMobileRename = () => {
    saveEditedSession();
    setMobileOptionsOpen(false);
  };

  const copyProviderSessionId = async () => {
    if (!providerSessionId) {
      setCopyState('error');
      return;
    }

    setCopyState('copying');
    const didCopy = await copyTextToClipboard(providerSessionId);
    setCopyState(didCopy ? 'copied' : 'error');
  };

  const handleCopyAction = () => {
    if (copyState === 'error' && !providerSessionId) {
      void loadProviderSessionId();
    } else {
      void copyProviderSessionId();
    }
  };

  const isCopyPending = copyState === 'loading' || copyState === 'copying';
  const CopyStateIcon = copyState === 'copied' ? Check : Copy;
  const copyLabel = copyState === 'loading'
    ? `Loading ${providerLabel} session ID…`
    : copyState === 'copied'
      ? `${providerLabel} session ID copied`
      : copyState === 'error'
        ? providerSessionId
          ? `Couldn't copy ${providerLabel} session ID`
          : `${providerLabel} session ID unavailable`
        : `Copy ${providerLabel} session ID`;

  // The mark at the end of the row carries the session state (Claude desktop
  // shows a grey dot on the open session): running pulses in the accent,
  // waiting-for-you is amber; idle rows show none (Claude has no "recent" mark).
  const bulletLabel = isProcessing
    ? t('tooltips.processingSessionIndicator', 'Processing session')
    : showAttentionIndicator
      ? t('tooltips.attentionRequiredIndicator', { defaultValue: 'Session needs attention' })
      : undefined;
  const bullet = (
    <span
      role={bulletLabel ? 'status' : undefined}
      aria-label={bulletLabel}
      title={bulletLabel}
      className={cn(
        'block h-[6px] w-[6px] flex-shrink-0 rounded-full',
        isProcessing
          ? 'animate-pulse bg-c-accent'
          : showAttentionIndicator
            ? 'bg-amber-500'
            : isSelected
              ? 'bg-[#888680]'
              : 'hidden',
      )}
    />
  );

  return (
    <div className="group relative">
      <div className="md:hidden">
        <div
          className={cn(
            'mx-[6px] mb-[2px] flex h-10 items-center rounded-[8px] transition-colors active:bg-c-active',
            isSelected && 'bg-c-active',
          )}
          onClick={selectMobileSession}
        >
          <span className="flex w-[30px] flex-shrink-0 justify-center">{bullet}</span>
          <div className="min-w-0 flex-1">
            <div
              className={cn('truncate text-[15px] leading-5', isSelected ? 'text-c-text' : 'text-c-text-2')}
              title={sessionView.sessionName}
            >
              {sessionView.sessionName}
            </div>
            {sessionMetaLine && (
              <div className="flex min-w-0 items-center text-[11px] text-c-text-3">{sessionMetaLine}</div>
            )}
          </div>
          {!isProcessing && compactSessionAge && (
            <span className="ml-2 flex-shrink-0 text-[12px] text-c-text-3">{compactSessionAge}</span>
          )}

            <button
              type="button"
              aria-label={`Session options for ${sessionView.sessionName}`}
              aria-haspopup="dialog"
              aria-expanded={isMobileOptionsOpen}
              className="ml-1 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg text-c-text-3 transition-colors active:bg-c-hover"
              onClick={(event) => {
                event.stopPropagation();
                setMobileOptionsOpen(true);
              }}
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
        </div>

        <Dialog open={isMobileOptionsOpen} onOpenChange={setMobileOptionsOpen}>
          <DialogContent
            aria-describedby="mobile-session-options-description"
            wrapperClassName="md:hidden"
            animationClassName="animate-bottom-sheet-content-show motion-reduce:animate-none"
            className="bottom-0 left-0 top-auto max-w-none translate-x-0 translate-y-0 rounded-b-none rounded-t-2xl border-x-0 border-b-0 px-4 pb-safe-area-inset-bottom pt-3"
          >
            <DialogTitle>Session options</DialogTitle>
            <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-muted-foreground/30" aria-hidden="true" />

            <div className="mb-4 flex items-center gap-3 px-1">
              <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-muted">
                <LLMProviderLogo provider={session.__provider} className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground" title={sessionView.sessionName}>
                  {sessionView.sessionName}
                </p>
                <p id="mobile-session-options-description" className="text-xs text-muted-foreground">
                  {identityBadge ? executionIdentity.fullLabel : `${providerLabel} session`}
                </p>
              </div>
            </div>

            {isEditing ? (
              <div className="mb-3 space-y-2">
                <label htmlFor={`mobile-session-rename-${session.id}`} className="block px-1 text-xs font-medium text-muted-foreground">
                  Session name
                </label>
                <input
                  id={`mobile-session-rename-${session.id}`}
                  type="text"
                  value={editingSessionName}
                  onChange={(event) => onEditingSessionNameChange(event.target.value)}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === 'Enter') {
                      saveMobileRename();
                    }
                  }}
                  className="w-full rounded-xl border-2 border-primary/40 bg-background px-3 py-3 text-foreground shadow-sm focus:border-primary focus:outline-none"
                  autoFocus
                  autoComplete="off"
                  // 16px keeps iOS Safari from zooming the viewport on focus.
                  style={{ fontSize: '16px' }}
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={saveMobileRename}
                    className="flex min-h-12 flex-1 items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-sm font-medium text-primary-foreground transition-transform active:scale-95"
                  >
                    <Check className="h-5 w-5 flex-shrink-0" />
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={onCancelEditingSession}
                    className="flex min-h-12 flex-1 items-center justify-center gap-2 rounded-xl border border-border bg-muted/35 px-4 py-3 text-sm font-medium text-foreground transition-colors active:bg-muted"
                  >
                    <X className="h-5 w-5 flex-shrink-0" />
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={startMobileRename}
                  className="flex min-h-12 w-full items-center gap-3 rounded-xl border border-border bg-muted/35 px-4 py-3 text-left text-foreground transition-colors active:bg-muted"
                >
                  <Edit2 className="h-5 w-5 flex-shrink-0" />
                  <span className="text-sm font-medium">Rename session</span>
                </button>

                <button
                  type="button"
                  onClick={handleCopyAction}
                  disabled={isCopyPending}
                  className={cn(
                    'flex min-h-12 w-full items-center gap-3 rounded-xl border px-4 py-3 text-left transition-colors',
                    copyState === 'copied'
                      ? 'border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300'
                      : copyState === 'error'
                        ? 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300'
                        : 'border-border bg-muted/35 text-foreground active:bg-muted',
                  )}
                >
                  {isCopyPending ? (
                    <Loader2 className="h-5 w-5 flex-shrink-0 animate-spin" />
                  ) : (
                    <CopyStateIcon className="h-5 w-5 flex-shrink-0" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{copyLabel}</span>
                    {copyState === 'error' && (
                      <span className="mt-0.5 block text-xs">Tap to try again.</span>
                    )}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setMobileOptionsOpen(false);
                    handoffFromMobileRef.current = true;
                    setIsHandoffOpen(true);
                  }}
                  className="flex min-h-12 w-full items-center gap-3 rounded-xl border border-border bg-muted/35 px-4 py-3 text-left text-foreground transition-colors active:bg-muted"
                >
                  <ArrowRightLeft className="h-5 w-5 flex-shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">Continue in a new run…</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">Another account or provider; this session stays unchanged.</span>
                  </span>
                </button>

                {!isProcessing && (
                  <button
                    type="button"
                    onClick={() => {
                      setMobileOptionsOpen(false);
                      requestDeleteSession();
                    }}
                    className="flex min-h-12 w-full items-center gap-3 rounded-xl px-4 py-3 text-left text-red-600 transition-colors active:bg-red-500/10 dark:text-red-400"
                  >
                    <Trash2 className="h-5 w-5 flex-shrink-0" />
                    <span className="text-sm font-medium">Archive or delete session</span>
                  </button>
                )}
              </div>
            )}

            {!isEditing && (
              <button
                type="button"
                onClick={() => setMobileOptionsOpen(false)}
                className="mb-3 mt-2 min-h-11 w-full rounded-xl text-sm font-medium text-muted-foreground transition-colors active:bg-muted"
              >
                Cancel
              </button>
            )}
          </DialogContent>
        </Dialog>
      </div>

      {/* Claude desktop session row (live app, 2026-10-18): 28px tall at a 30px
          pitch, fill x=8…276 radius 8, title at x=18, state mark at the right. */}
      <div className="mb-[2px] ml-[8px] mr-[10px] hidden md:block">
        <a
          href={`/session/${session.id}`}
          title={showRunningDetail || identityBadge ? undefined : sessionView.sessionName}
          className={cn(
            'flex h-[28px] w-full items-center rounded-[8px] pl-[10px] pr-[9px] text-left transition-colors group-hover:pr-8',
            isSelected ? 'bg-c-selected' : 'hover:bg-c-hover',
          )}
          // Left-click keeps in-app navigation; Ctrl/Cmd/middle-click and the
          // native right-click menu use the href to open a new tab/window.
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            onSessionSelect(session, project.projectId);
          }}
        >
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-[13.25px] leading-5',
              isSelected ? 'text-c-text' : 'text-c-text-2',
            )}
          >
            {sessionView.sessionName}
          </span>
          {(showRunningDetail || identityBadge) && (
            <span className="ml-2 flex max-w-[45%] flex-shrink-0 items-center overflow-hidden text-[11px] text-c-text-3 group-hover:opacity-0">
              {sessionMetaLine}
            </span>
          )}
          <span className="ml-2 flex w-[6px] flex-shrink-0 justify-center group-hover:opacity-0">{bullet}</span>
        </a>

        <div
          ref={editingContainerRef}
          className={cn(
            'absolute right-[16px] top-1/2 flex -translate-y-1/2 transform items-center gap-1 transition-opacity duration-150',
            isEditing ? 'left-[8px] opacity-100' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100',
          )}
        >
            {isEditing ? (
              <>
                <input
                  type="text"
                  value={editingSessionName}
                  onChange={(event) => onEditingSessionNameChange(event.target.value)}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === 'Enter') {
                      saveEditedSession();
                    } else if (event.key === 'Escape') {
                      onCancelEditingSession();
                    }
                  }}
                  onClick={(event) => event.stopPropagation()}
                  className="h-[24px] min-w-0 flex-1 rounded-md border border-c-input-border bg-c-search px-2 text-[13px] text-c-text outline-none"
                  autoFocus
                />
                <button
                  className="flex h-6 w-6 items-center justify-center rounded text-c-text-2 hover:bg-c-active hover:text-c-text"
                  onClick={(event) => {
                    event.stopPropagation();
                    saveEditedSession();
                  }}
                  title={t('tooltips.save')}
                >
                  <Check className="h-3.5 w-3.5" />
                </button>
                <button
                  className="flex h-6 w-6 items-center justify-center rounded text-c-text-3 hover:bg-c-active hover:text-c-text"
                  onClick={(event) => {
                    event.stopPropagation();
                    onCancelEditingSession();
                  }}
                  title={t('tooltips.cancel')}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </>
            ) : (
              <ActionMenu
                label="Session options"
                ariaLabel={`Session options for ${sessionView.sessionName}`}
                icon={MoreHorizontal}
                iconOnly
                portal
                variant="ghost"
                size="icon"
                onOpenChange={setOptionsOpen}
                triggerClassName="h-5 w-5 rounded p-0 text-c-text-3 hover:bg-transparent hover:text-c-text"
                menuClassName="w-[260px] rounded-[10px] border-c-card-border bg-c-surface p-1 shadow-[0_8px_24px_rgba(0,0,0,0.35)]"
                header={(
                  <div className="mb-1 border-b border-c-card-border px-2.5 py-2">
                    <p className="truncate text-[13px] font-medium text-c-text" title={sessionView.sessionName}>
                      {sessionView.sessionName}
                    </p>
                    <p className="mt-0.5 text-[12px] text-c-text-3">
                      {identityBadge ? executionIdentity.fullLabel : `${providerLabel} session`}
                    </p>
                  </div>
                )}
                items={[
                  {
                    key: 'rename',
                    label: 'Rename session',
                    icon: Edit2,
                    onSelect: () => onStartEditingSession(session.id, sessionView.sessionName),
                  },
                  {
                    key: 'copy',
                    label: copyLabel,
                    description: copyState === 'error' ? 'Click to try again.' : undefined,
                    icon: CopyStateIcon,
                    loading: isCopyPending,
                    closeOnSelect: false,
                    onSelect: handleCopyAction,
                  },
                  {
                    key: 'handoff',
                    label: 'Continue in a new run…',
                    description: 'Another account or provider; this session stays unchanged.',
                    icon: ArrowRightLeft,
                    onSelect: () => {
                      handoffFromMobileRef.current = false;
                      setIsHandoffOpen(true);
                    },
                  },
                  ...(!isProcessing ? [{
                    key: 'delete',
                    label: 'Archive or delete session',
                    icon: Trash2,
                    isDanger: true,
                    showDividerBefore: true,
                    onSelect: requestDeleteSession,
                  }] : []),
                ]}
              />
            )}
          </div>
      </div>

      {isHandoffOpen && (
        <SessionHandoffDialog
          open={isHandoffOpen}
          onOpenChange={setIsHandoffOpen}
          sessionId={session.id}
          sessionTitle={sessionView.sessionName}
          onCreated={openHandoffTarget}
        />
      )}
    </div>
  );
}
