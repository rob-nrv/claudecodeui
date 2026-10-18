import { useEffect, useState } from 'react';
import { Gauge, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { api } from '../../../../utils/api';
import type { ClaudeLiveUsage, ClaudeLiveUsageWindow } from '../../../provider-usage/utils/liveUsage';

type UsageLimitBannerProps = {
  /** Account of the open session (or the default one for a new session); null = historical ~/.claude. */
  claudeProfileId: string | null;
  onShowDetails?: () => void;
};

const APPROACHING_PERCENT = 75;
const REFRESH_MS = 5 * 60_000;

type Notice = { title: string; resetsAt: string };

function pickNotice(usage: ClaudeLiveUsage, t: (key: string, fallback: string) => string): Notice | null {
  if (usage.snapshot.status !== 'available') return null;
  const windows: Array<{ window: ClaudeLiveUsageWindow; kind: 'weekly' | 'session' }> = [
    { window: usage.sevenDay, kind: 'weekly' },
    { window: usage.fiveHour, kind: 'session' },
  ];
  for (const { window, kind } of windows) {
    if (window.state !== 'available' || window.usedPercentage < APPROACHING_PERCENT) continue;
    const reached = window.usedPercentage >= 100;
    const title = kind === 'weekly'
      ? (reached ? t('usageBanner.weeklyReached', 'Weekly usage limit reached') : t('usageBanner.weeklyApproaching', 'Approaching weekly usage limit'))
      : (reached ? t('usageBanner.sessionReached', 'Session usage limit reached') : t('usageBanner.sessionApproaching', 'Approaching session usage limit'));
    return { title, resetsAt: window.resetsAt };
  }
  return null;
}

/*
 * Claude desktop usage notice above the composer (live app, 2026-10-18):
 * a #212121 row, radius 10, 6 px above the box — "Approaching weekly usage
 * limit · Resets Wed, Oct 21, 12:00 AM", an action and a close button.
 * It only appears from a real report of this account's limits (Claude
 * Code's status line, FT-M07); without a report there is nothing to show.
 */
export default function UsageLimitBanner({ claudeProfileId, onShowDetails }: UsageLimitBannerProps) {
  const { t, i18n } = useTranslation('chat');
  const tr = (key: string, fallback: string) => t(key, { defaultValue: fallback });
  const [usage, setUsage] = useState<ClaudeLiveUsage | null>(null);
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await api.claudeLiveUsage.get(claudeProfileId);
        const body = response.ok ? await response.json() : null;
        if (!cancelled) setUsage((body?.data?.liveUsage as ClaudeLiveUsage | undefined) ?? null);
      } catch {
        if (!cancelled) setUsage(null);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [claudeProfileId]);

  const notice = usage ? pickNotice(usage, tr) : null;
  if (!notice) return null;
  const noticeKey = `${notice.title}:${notice.resetsAt}`;
  if (dismissedFor === noticeKey) return null;

  const resetLabel = new Date(notice.resetsAt).toLocaleString(i18n.language || undefined, {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });

  return (
    <div role="status" className="mb-[6px] flex h-[41px] items-center gap-2 rounded-[10px] bg-c-surface pl-[8px] pr-[8px] text-[14px]">
      <Gauge className="h-[15px] w-[15px] flex-shrink-0 text-c-text-2" strokeWidth={1.6} />
      <span className="flex-shrink-0 font-medium text-c-text">{notice.title}</span>
      <span className="min-w-0 truncate text-c-text-3">{tr('usageBanner.resets', 'Resets')} {resetLabel}</span>
      <div className="flex-1" />
      {onShowDetails && (
        <button type="button" onClick={onShowDetails} className="h-[26px] flex-shrink-0 rounded-[6px] bg-[#383838] px-[8px] text-[13px] font-medium text-c-text hover:brightness-110">
          {tr('usageBanner.details', 'Usage details')}
        </button>
      )}
      <button
        type="button"
        onClick={() => setDismissedFor(noticeKey)}
        aria-label={tr('usageBanner.dismiss', 'Dismiss')}
        className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-c-text-3 hover:text-c-text"
      >
        <X className="h-4 w-4" strokeWidth={1.8} />
      </button>
    </div>
  );
}
