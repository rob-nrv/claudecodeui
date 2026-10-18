import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowUpCircle, Bug, Check, ChevronDown, Settings, SlidersHorizontal } from 'lucide-react';
import type { TFunction } from 'i18next';

import { cn } from '../../../../lib/utils';
import { useAppUserIdentity } from '../../../../hooks/useAppUserIdentity';
import type { ReleaseInfo } from '../../../../shared/types';
import { QUICK_SETTINGS_TOGGLE_EVENT } from '../../../quick-settings-panel/view/QuickSettingsPanelView';
import ClaudeLiveUsageSummary from '../../../provider-usage/view/ClaudeLiveUsageSummary';
import { useClaudeProfiles, type ClaudeProfile } from '../../../settings/hooks/useClaudeProfiles';

const GITHUB_ISSUES_URL = 'https://github.com/siteboon/claudecodeui/issues/new';

type SidebarFooterProps = {
  updateAvailable: boolean;
  restartRequired: boolean;
  releaseInfo: ReleaseInfo | null;
  latestVersion: string | null;
  currentVersion: string;
  onShowVersionModal: () => void;
  onShowSettings: () => void;
  t: TFunction;
};

const CONNECTION_LABEL: Record<ClaudeProfile['connectionState'], string> = {
  connected: 'Signed in',
  expired: 'Sign-in expired',
  not_authenticated: 'Signed out',
  unknown: 'Not verified',
};

const formatTier = (tier: string | null | undefined): string | null => {
  if (!tier) return null;
  const clean = tier.replace(/^claude[_-]?/i, '').replace(/[_-]/g, ' ').trim();
  return clean ? clean.charAt(0).toUpperCase() + clean.slice(1) : null;
};

/*
 * Claude desktop footer: a 40px row under a hairline — monogram, account name
 * "· plan", chevron, and a settings button on the right. The row opens the
 * account menu, which is where CloudCLI's two Claude accounts are switched.
 *
 * Switching reuses the existing mechanism: it marks a profile as Default
 * (PATCH /api/claude-profiles/:id {isDefault}). New sessions start under the
 * Default profile; running and past sessions keep their own bound profile,
 * and "Continue in a new run…" on a session still hands it to the other one.
 */
export default function SidebarFooter({
  updateAvailable,
  restartRequired,
  releaseInfo,
  latestVersion,
  onShowVersionModal,
  onShowSettings,
  t,
}: SidebarFooterProps) {
  const identity = useAppUserIdentity();
  const { profiles, setDefaultProfile } = useClaudeProfiles();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const activeProfile = profiles.find((profile) => profile.isDefault) ?? profiles[0] ?? null;
  const accountName = activeProfile?.displayName ?? identity.displayName;
  const tier = formatTier(activeProfile?.verifiedIdentity?.tier);
  const monogram = (accountName.trim().charAt(0) || identity.monogram || '?').toUpperCase();

  useEffect(() => {
    if (!isMenuOpen) return undefined;
    const close = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setIsMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setIsMenuOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [isMenuOpen]);

  const switchTo = async (profile: ClaudeProfile) => {
    if (profile.isDefault || switchingId) return;
    setSwitchingId(profile.id);
    try {
      await setDefaultProfile(profile.id);
    } finally {
      setSwitchingId(null);
    }
  };

  return (
    <div ref={rootRef} className="relative flex-shrink-0" style={{ paddingBottom: 'env(safe-area-inset-bottom, 0)' }}>
      {restartRequired && (
        <div className="mx-[3px] mb-1 flex items-center gap-2 rounded-md px-[10px] py-1.5 text-[12px] text-amber-500">
          <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
          <span className="min-w-0 flex-1">{t('version.restartRequired')}</span>
        </div>
      )}
      {updateAvailable && (
        <button
          type="button"
          onClick={onShowVersionModal}
          className="mx-[3px] mb-1 flex w-[calc(100%-6px)] items-center gap-2 rounded-md px-[10px] py-1.5 text-left text-[13px] text-c-text-2 hover:bg-c-hover"
        >
          <ArrowUpCircle className="h-3.5 w-3.5 flex-shrink-0 text-c-toggle" />
          <span className="min-w-0 flex-1 truncate">{releaseInfo?.title || `v${latestVersion}`} · {t('version.updateAvailable')}</span>
        </button>
      )}

      {isMenuOpen && (
        <div
          role="menu"
          className="absolute bottom-[44px] left-[6px] right-[6px] z-50 rounded-[10px] border border-c-card-border bg-c-surface p-1 text-[14px] shadow-[0_8px_24px_rgba(0,0,0,0.35)]"
        >
          <div className="px-2.5 pb-1 pt-1.5 text-[12px] text-c-text-3">{identity.displayName}</div>
          {profiles.length > 0 && (
            <>
              <div className="px-2.5 pb-1 pt-1 text-[12px] text-c-text-3">{t('accounts.claude', 'Claude accounts')}</div>
              {profiles.map((profile) => (
                <button
                  key={profile.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={profile.isDefault}
                  onClick={() => void switchTo(profile)}
                  disabled={Boolean(switchingId)}
                  className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-c-text-2 hover:bg-c-active hover:text-c-text disabled:opacity-60"
                >
                  <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-c-active text-[11px] font-semibold text-c-text">
                    {(profile.displayName.charAt(0) || '?').toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-c-text">{profile.displayName}</span>
                    <span className="block truncate text-[12px] text-c-text-3">
                      {[formatTier(profile.verifiedIdentity?.tier), t(`accounts.state.${profile.connectionState}`, CONNECTION_LABEL[profile.connectionState])].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                  {profile.isDefault && <Check className="h-4 w-4 flex-shrink-0 text-c-text" />}
                </button>
              ))}
              {activeProfile && (
                <div className="px-1.5 pb-1">
                  <ClaudeLiveUsageSummary claudeProfileId={activeProfile.id} />
                </div>
              )}
              <p className="px-2.5 pb-1.5 pt-1 text-[11px] leading-4 text-c-text-3">
                {t('accounts.switchHint', 'New sessions start on the selected account. To move a running conversation, use “Continue in a new run…” on it.')}
              </p>
              <div className="my-1 h-px bg-c-card-border" />
            </>
          )}
          <button type="button" role="menuitem" onClick={() => { setIsMenuOpen(false); onShowSettings(); }} className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-c-text-2 hover:bg-c-active hover:text-c-text">
            <Settings className="h-4 w-4" strokeWidth={1.6} />
            {t('actions.settings')}
          </button>
          <button type="button" role="menuitem" onClick={() => { setIsMenuOpen(false); window.dispatchEvent(new Event(QUICK_SETTINGS_TOGGLE_EVENT)); }} className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-c-text-2 hover:bg-c-active hover:text-c-text">
            <SlidersHorizontal className="h-4 w-4" strokeWidth={1.6} />
            {t('actions.quickSettings', 'Quick settings')}
          </button>
          <a href={GITHUB_ISSUES_URL} target="_blank" rel="noopener noreferrer" role="menuitem" className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-c-text-2 hover:bg-c-active hover:text-c-text">
            <Bug className="h-4 w-4" strokeWidth={1.6} />
            {t('actions.reportIssue')}
          </a>
        </div>
      )}

      <div className="flex h-10 items-center border-t border-c-sidebar-border pl-[9px] pr-[6px]">
        <button
          type="button"
          onClick={() => setIsMenuOpen((open) => !open)}
          aria-haspopup="menu"
          aria-expanded={isMenuOpen}
          className="flex h-8 min-w-0 items-center gap-[7px] rounded-md pl-[2px] pr-2 text-left hover:bg-c-hover"
        >
          <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-c-sidebar-border text-[10px] font-semibold text-c-text">
            {monogram}
          </span>
          <span className="min-w-0 truncate text-[14px] leading-5 text-c-text-2">
            {accountName}
            {tier && <span className="text-c-text-3"> · {tier}</span>}
          </span>
          <ChevronDown className="ml-[10px] h-3 w-3 flex-shrink-0 text-c-text-3" strokeWidth={1.8} />
        </button>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onShowSettings}
          title={t('actions.settings')}
          aria-label={t('actions.settings')}
          className={cn('flex h-7 w-7 items-center justify-center rounded-md text-c-text-2 hover:bg-c-hover hover:text-c-text')}
        >
          <Settings className="h-[15px] w-[15px]" strokeWidth={1.6} />
        </button>
      </div>
    </div>
  );
}
