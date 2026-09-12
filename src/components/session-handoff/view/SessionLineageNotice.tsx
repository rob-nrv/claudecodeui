import { ArrowRightLeft } from 'lucide-react';

type SessionLineageNoticeProps = {
  /** "Claude · Personal" — the account/provider this new run is bound to. */
  targetLabel: string;
  /** "Claude · Work" — the account/provider of the run it continues. */
  sourceLabel: string;
  sourceTitle: string;
  canOpenSource: boolean;
  isContextInComposer: boolean;
  onOpenSource: () => void;
  onUseContext: () => void;
};

/**
 * Shown above the composer of a handoff target until its first send, so the
 * user knows this is a fresh run, which account it runs on, and that the
 * previous run was left as it was.
 */
export default function SessionLineageNotice({
  targetLabel,
  sourceLabel,
  sourceTitle,
  canOpenSource,
  isContextInComposer,
  onOpenSource,
  onUseContext,
}: SessionLineageNoticeProps) {
  return (
    <div className="mx-auto w-full max-w-[54.25rem] px-3 pb-2 sm:px-4">
      <div role="status" className="flex items-start gap-2 rounded-lg border border-border/70 bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        <ArrowRightLeft className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p>
            <span className="font-medium text-foreground">New run on {targetLabel}.</span>
            {' '}It continues “{sourceTitle}” from {sourceLabel}, which stays unchanged.
            {' '}{isContextInComposer
              ? 'The handoff context is in the composer — review it, then send to start.'
              : 'Send a message to start, or put the handoff context back in the composer.'}
          </p>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
            {canOpenSource && (
              <button type="button" onClick={onOpenSource} className="font-medium text-foreground underline underline-offset-2">
                Open previous run
              </button>
            )}
            {!isContextInComposer && (
              <button type="button" onClick={onUseContext} className="font-medium text-foreground underline underline-offset-2">
                Put context in composer
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
