import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Project, ProjectSession } from '../../../../types/app';
import { getSessionTitle } from '../../../../utils/pageTitle';
import { resolveExecutionIdentity, shouldShowProfileIdentity } from '../../../../shared/identity';
import ExecutionIdentityBadge from '../../../identity/view/ExecutionIdentityBadge';
import { useClaudeProfiles } from '../../../settings/hooks/useClaudeProfiles';
import type { SessionLineage } from '../../../session-handoff/types/types';
import SessionLineageLink from '../../../session-handoff/view/SessionLineageLink';

type MainContentTitleProps = {
  selectedProject: Project;
  selectedSession: ProjectSession | null;
  /** Backend handoff lineage of `selectedSession` (FT-M05), or null. */
  sessionLineage: SessionLineage | null;
  onNavigateToSession: (sessionId: string) => void;
};

/*
 * Claude desktop conversation title: "Title ⌄" at x=24 of the main column,
 * 13.5px medium. The chevron opens the conversation menu: project, the
 * account the session runs under and its handoff lineage.
 */
export default function MainContentTitle({
  selectedProject,
  selectedSession,
  sessionLineage,
  onNavigateToSession,
}: MainContentTitleProps) {
  const { t } = useTranslation();
  const { profiles: claudeProfiles } = useClaudeProfiles();
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Discreet "which account did this run under" indicator — only meaningful
  // for Claude sessions bound to an account (CLOUDCLI_EXTENSION_PLAN.md F5).
  // The label comes from the session's persisted `claudeProfileId`, never from
  // the current global selection, and a bound id that no longer resolves still
  // renders (as "Unknown account") rather than silently disappearing.
  const claudeProfileNameById = useMemo(
    () => new Map(claudeProfiles.map((profile) => [profile.id, profile.displayName])),
    [claudeProfiles],
  );
  const sessionProvider = selectedSession?.__provider ?? selectedSession?.provider;
  const executionIdentity = useMemo(() => resolveExecutionIdentity({
    provider: sessionProvider,
    claudeProfileId: selectedSession?.claudeProfileId ?? null,
    profileNamesById: claudeProfileNameById,
    unresolvedLabel: t('mainContent.claudeAccountUnavailable', { defaultValue: 'Unknown account' }),
  }), [sessionProvider, selectedSession?.claudeProfileId, claudeProfileNameById, t]);
  const showExecutionIdentity = shouldShowProfileIdentity(claudeProfiles.length);
  const hasLineage = Boolean(sessionLineage?.incoming || (sessionLineage?.outgoing.length ?? 0) > 0);

  const title = selectedSession ? getSessionTitle(selectedSession) : t('mainContent.newSession');

  useEffect(() => {
    if (!isOpen) return undefined;
    const close = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setIsOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setIsOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [isOpen]);

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        title={title}
        className="flex h-7 min-w-0 max-w-full items-center gap-[9px] rounded-md px-[6px] hover:bg-c-hover"
      >
        <span className="truncate text-[13.5px] font-medium leading-5 text-c-text">{title}</span>
        <svg width="11" height="6" viewBox="0 0 11 6" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0 text-c-text-2" aria-hidden="true">
          <path d="M0.6 0.6L5.5 5.4L10.4 0.6" />
        </svg>
      </button>

      {isOpen && (
        <div
          role="menu"
          className="absolute left-0 top-[32px] z-50 w-[280px] rounded-[10px] border border-c-card-border bg-c-surface p-1 shadow-[0_8px_24px_rgba(0,0,0,0.35)]"
        >
          <div className="px-2.5 pb-1.5 pt-1.5">
            <div className="truncate text-[13px] text-c-text" title={selectedProject.fullPath}>{selectedProject.displayName}</div>
            {(showExecutionIdentity && executionIdentity.profileLabel) || hasLineage ? (
              <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12px] text-c-text-3">
                {showExecutionIdentity && executionIdentity.profileLabel && (
                  <ExecutionIdentityBadge identity={executionIdentity} className="max-w-[60%] flex-shrink-0" />
                )}
                {hasLineage && (
                  <SessionLineageLink
                    lineage={sessionLineage}
                    onNavigateToSession={(id) => { setIsOpen(false); onNavigateToSession(id); }}
                    className="min-w-0 truncate text-left underline-offset-2 hover:underline"
                  />
                )}
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
