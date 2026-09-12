import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowRightLeft, Check, Loader2 } from 'lucide-react';

import { Dialog, DialogContent, DialogTitle } from '../../../shared/view/ui';
import { cn } from '../../../lib/utils';
import { api } from '../../../utils/api';
import LLMProviderLogo from '../../llm-provider-logo/LLMProviderLogo';
import type { CreatedHandoff, HandoffTargets } from '../types/types';
import {
  HandoffRequestError,
  buildHandoffRequest,
  describeBlockedReason,
  describeConnectionState,
  describeUnavailableReason,
  handoffTargetKey,
  readApiResult,
  shouldReloadTargetsAfterError,
} from '../utils/handoff';

const MAX_NOTE_LENGTH = 2000;

type SessionHandoffDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  sessionTitle: string;
  onCreated: (result: CreatedHandoff) => void;
};

/**
 * "Continue in a new run": picks an explicit provider/account for a NEW
 * session that continues this session's task. Nothing is preselected, every
 * option's availability comes from the backend, and the source session is
 * never modified.
 */
export default function SessionHandoffDialog({
  open,
  onOpenChange,
  sessionId,
  sessionTitle,
  onCreated,
}: SessionHandoffDialogProps) {
  const [targets, setTargets] = useState<HandoffTargets | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const loadTargets = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const result = await readApiResult<HandoffTargets>(await api.sessionHandoffTargets(sessionId));
      setTargets(result);
      // A previously picked option that is no longer available is dropped
      // rather than silently kept.
      setSelectedKey((current) => {
        const stillAvailable = result.targets.some(
          (option) => handoffTargetKey(option) === current && option.available,
        );
        return stillAvailable && !result.blockedReason ? current : null;
      });
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Could not load the available accounts.');
    } finally {
      setIsLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    if (!open) {
      return;
    }
    setTargets(null);
    setSelectedKey(null);
    setNote('');
    setCreateError(null);
    void loadTargets();
  }, [open, loadTargets]);

  const selectedOption = useMemo(
    () => targets?.targets.find((option) => handoffTargetKey(option) === selectedKey) ?? null,
    [targets, selectedKey],
  );
  const blockedMessage = describeBlockedReason(targets?.blockedReason ?? null);
  const canCreate = Boolean(selectedOption?.available) && !blockedMessage && !isCreating && !isLoading;

  const handleCreate = async () => {
    if (!selectedOption || !canCreate) {
      return;
    }
    setIsCreating(true);
    setCreateError(null);
    try {
      const response = await api.createSessionHandoff(sessionId, buildHandoffRequest(selectedOption, note));
      const result = await readApiResult<CreatedHandoff>(response);
      onOpenChange(false);
      onCreated(result);
    } catch (error) {
      const code = error instanceof HandoffRequestError ? error.code : null;
      setCreateError(error instanceof Error ? error.message : 'The new run could not be created.');
      if (shouldReloadTargetsAfterError(code)) {
        void loadTargets();
      }
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!isCreating) onOpenChange(next); }}>
      <DialogContent
        aria-describedby="session-handoff-description"
        className="flex max-h-[85dvh] w-[calc(100vw-1.5rem)] max-w-md flex-col gap-3 p-4"
      >
        <DialogTitle>Continue in a new run</DialogTitle>
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-muted">
            <ArrowRightLeft className="h-5 w-5 text-foreground" />
          </div>
          <div className="min-w-0">
            <p className="text-base font-semibold text-foreground">Continue in a new run</p>
            <p id="session-handoff-description" className="mt-1 text-sm text-muted-foreground">
              Creates a new session that picks up <span className="font-medium text-foreground">“{sessionTitle}”</span>.
              {' '}This session is not changed{targets ? <> and stays on <span className="font-medium text-foreground">{targets.source.label}</span></> : null}.
            </p>
          </div>
        </div>

        {isLoading && !targets && (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground" role="status">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading accounts and providers…
          </div>
        )}

        {loadError && (
          <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">
            <p>{loadError}</p>
            <button type="button" onClick={() => void loadTargets()} className="mt-2 text-sm font-medium underline">
              Try again
            </button>
          </div>
        )}

        {blockedMessage && (
          <div role="status" className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span>{blockedMessage}</span>
          </div>
        )}

        {targets && (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">Run the new session with</p>
            <div role="radiogroup" aria-label="Run the new session with" className="space-y-1.5">
              {targets.targets.map((option) => {
                const key = handoffTargetKey(option);
                const isSelected = key === selectedKey;
                const isDisabled = !option.available || Boolean(blockedMessage) || isCreating;
                const statusText = describeUnavailableReason(option.unavailableReason)
                  ?? describeConnectionState(option.connectionState)
                  ?? `Starts a new ${option.label} session`;

                return (
                  <button
                    key={key}
                    type="button"
                    role="radio"
                    aria-checked={isSelected}
                    disabled={isDisabled}
                    onClick={() => setSelectedKey(key)}
                    className={cn(
                      'flex min-h-12 w-full items-center gap-3 rounded-xl border px-3 py-2 text-left transition-colors',
                      isSelected ? 'border-primary bg-primary/10' : 'border-border bg-muted/30',
                      isDisabled ? 'cursor-not-allowed opacity-60' : 'active:bg-muted',
                    )}
                  >
                    <LLMProviderLogo provider={option.provider} className="h-5 w-5 flex-shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-foreground">{option.label}</span>
                      <span className="block truncate text-xs text-muted-foreground">{statusText}</span>
                    </span>
                    {isSelected && <Check className="h-4 w-4 flex-shrink-0 text-primary" aria-hidden="true" />}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {targets && !blockedMessage && (
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Notes for the new run (optional)</span>
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={MAX_NOTE_LENGTH}
              rows={2}
              disabled={isCreating}
              placeholder="What remains, constraints, what to check first…"
              className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-foreground focus:border-primary focus:outline-none"
              // 16px keeps iOS Safari from zooming the viewport on focus.
              style={{ fontSize: '16px' }}
            />
          </label>
        )}

        {selectedOption && targets && (
          <p className="text-xs text-muted-foreground">
            New run: <span className="font-medium text-foreground">{selectedOption.label}</span>
            {' · '}previous run stays on <span className="font-medium text-foreground">{targets.source.label}</span>.
            {' '}The handoff context is placed in the new session&apos;s composer for you to review before sending.
          </p>
        )}

        {createError && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">{createError}</p>
        )}

        <div className="flex gap-2 pt-1">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            disabled={isCreating}
            className="flex min-h-11 flex-1 items-center justify-center rounded-xl border border-border px-4 text-sm font-medium text-foreground active:bg-muted disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={!canCreate}
            className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground active:scale-95 disabled:opacity-50"
          >
            {isCreating && <Loader2 className="h-4 w-4 animate-spin" />}
            {isCreating ? 'Creating…' : 'Create new run'}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
