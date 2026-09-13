import { Gauge } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../../shared/view/ui';
import { api } from '../../../utils/api';
import {
  formatUsedPercentage,
  getBridgeAction,
  getCaptureAge,
  getResetHint,
  getUsageLevel,
  type CaptureAge,
  type ClaudeLiveUsage,
  type ClaudeLiveUsageWindow,
  type UsageLevel,
} from '../utils/liveUsage';

type ClaudeLiveUsageSummaryProps = {
  /** Claude profile id, or null for the historical (un-isolated `~/.claude`) account. */
  claudeProfileId: string | null;
};

type Translate = ReturnType<typeof useTranslation>['t'];

const LEVEL_CLASS: Record<UsageLevel, string> = {
  normal: 'text-foreground',
  elevated: 'text-amber-700 dark:text-amber-400',
  high: 'text-red-700 dark:text-red-400',
};

async function readLiveUsageResponse(response: Response): Promise<ClaudeLiveUsage> {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.error?.message || `Usage request failed (${response.status})`);
  }
  if (!body?.data?.liveUsage) {
    throw new Error('Malformed usage response');
  }
  return body.data.liveUsage as ClaudeLiveUsage;
}

function formatCaptureAge(t: Translate, age: CaptureAge): string {
  switch (age.kind) {
    case 'justNow':
      return t('claudeProfiles.liveUsage.ageJustNow', { defaultValue: 'just now' });
    case 'minutes':
      return t('claudeProfiles.liveUsage.ageMinutes', { count: age.minutes, defaultValue: '{{count}} min ago' });
    case 'hours':
      return t('claudeProfiles.liveUsage.ageHours', { count: age.hours, defaultValue: '{{count}} h ago' });
    default:
      return t('claudeProfiles.liveUsage.ageDays', { count: age.days, defaultValue: '{{count}} d ago' });
  }
}

function UsageWindow({ label, window, now }: { label: string; window: ClaudeLiveUsageWindow; now: number }) {
  const { t, i18n } = useTranslation('settings');

  if (window.state !== 'available') {
    return (
      <div className="min-w-0">
        <dt className="text-[11px] text-muted-foreground">{label}</dt>
        <dd className="text-muted-foreground">
          {window.reason === 'window_reset'
            ? t('claudeProfiles.liveUsage.windowReset', { defaultValue: 'Reset since last report' })
            : t('claudeProfiles.liveUsage.notReported', { defaultValue: 'Unavailable' })}
        </dd>
      </div>
    );
  }

  const level = getUsageLevel(window.usedPercentage);
  const hint = getResetHint(window.resetsAt, now);
  let resetText: string | null = null;
  if (hint?.kind === 'minutes') {
    resetText = t('claudeProfiles.liveUsage.resetsInMinutes', { minutes: hint.minutes, defaultValue: 'Resets in {{minutes}} min' });
  } else if (hint?.kind === 'hours') {
    resetText = hint.minutes === 0
      ? t('claudeProfiles.liveUsage.resetsInHoursOnly', { hours: hint.hours, defaultValue: 'Resets in {{hours}} h' })
      : t('claudeProfiles.liveUsage.resetsInHours', {
        hours: hint.hours,
        minutes: hint.minutes,
        defaultValue: 'Resets in {{hours}} h {{minutes}} min',
      });
  } else if (hint?.kind === 'date') {
    resetText = t('claudeProfiles.liveUsage.resetsAt', {
      // Formatted in the UI's language, not the browser's, so the line never mixes languages.
      date: hint.date.toLocaleString(i18n.language || undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' }),
      defaultValue: 'Resets {{date}}',
    });
  }

  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd>
        <span className={`font-semibold tabular-nums ${LEVEL_CLASS[level]}`}>{formatUsedPercentage(window.usedPercentage)}</span>{' '}
        <span className="text-muted-foreground">{t('claudeProfiles.liveUsage.used', { defaultValue: 'used' })}</span>
        {resetText && <div className="truncate text-[11px] text-muted-foreground">{resetText}</div>}
      </dd>
    </div>
  );
}

/**
 * Compact, backend-authoritative Claude usage limits for one account (FT-M07):
 * the 5-hour session window and the 7-day weekly window as last reported by
 * Claude Code's statusLine, plus the explicit control for the capture bridge.
 *
 * Only interactive Claude Code sessions report these values — CloudCLI's
 * SDK-driven chats do not (FT-M07-R1) — so the block always says when the last
 * report happened instead of presenting it as a live reading. An unavailable
 * window shows why instead of a number; the raw `/usage` check next to it stays
 * available as the fallback.
 */
export default function ClaudeLiveUsageSummary({ claudeProfileId }: ClaudeLiveUsageSummaryProps) {
  const { t } = useTranslation('settings');
  const [usage, setUsage] = useState<ClaudeLiveUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const run = useCallback(async (request: () => Promise<Response>) => {
    setPending(true);
    try {
      setUsage(await readLiveUsageResponse(await request()));
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unknown error');
    } finally {
      setNow(Date.now());
      setPending(false);
    }
  }, []);

  useEffect(() => {
    void run(() => api.claudeLiveUsage.get(claudeProfileId));
  }, [claudeProfileId, run]);

  if (!usage) {
    return error ? (
      <div className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</div>
    ) : null;
  }

  const action = getBridgeAction(usage.bridge.state);
  const captureAge = usage.snapshot.status === 'available' ? getCaptureAge(usage.snapshot.capturedAt, now) : null;
  const isStale = usage.snapshot.status === 'available' && usage.snapshot.freshness === 'stale';

  let reportText: string;
  if (captureAge) {
    const age = formatCaptureAge(t, captureAge);
    reportText = isStale
      ? t('claudeProfiles.liveUsage.staleReport', { age, defaultValue: 'Stale · last reported {{age}}' })
      : t('claudeProfiles.liveUsage.freshReport', { age, defaultValue: 'Reported by Claude Code {{age}}' });
  } else if (usage.snapshot.reason === 'attribution_mismatch') {
    reportText = t('claudeProfiles.liveUsage.attributionMismatch', { defaultValue: 'The last report belongs to another account and was ignored.' });
  } else if (usage.snapshot.reason === 'snapshot_invalid' || usage.snapshot.reason === 'snapshot_from_future') {
    reportText = t('claudeProfiles.liveUsage.invalidSnapshot', { defaultValue: 'The last report could not be trusted and was ignored.' });
  } else {
    reportText = t('claudeProfiles.liveUsage.noReportYet', { defaultValue: 'No report yet' });
  }

  let bridgeText: string;
  if (action === 'enable') {
    bridgeText = usage.bridge.hasUserStatusLine
      ? t('claudeProfiles.liveUsage.enableWrapsExisting', { defaultValue: 'Reads usage from interactive Claude Code sessions for this account. Your existing status line keeps running.' })
      : t('claudeProfiles.liveUsage.enableAddsStatusLine', { defaultValue: 'Reads usage from interactive Claude Code sessions for this account. Adds a status line there, which hides its footer shortcut hints.' });
  } else if (action === 'disable') {
    bridgeText = usage.bridge.wrapsExistingStatusLine
      ? t('claudeProfiles.liveUsage.capturingWrapped', { defaultValue: 'Updates only while this account uses Claude Code interactively; CloudCLI chats don\'t report usage. Your status line still runs.' })
      : t('claudeProfiles.liveUsage.capturing', { defaultValue: 'Updates only while this account uses Claude Code interactively; CloudCLI chats don\'t report usage.' });
  } else if (action === 'repair') {
    bridgeText = t('claudeProfiles.liveUsage.needsRepair', { defaultValue: 'The usage bridge needs to be repaired before it can run.' });
  } else {
    bridgeText = t('claudeProfiles.liveUsage.settingsUnreadable', { defaultValue: 'Claude settings for this account could not be read, so CloudCLI will not change them.' });
  }

  return (
    <div className="mt-3 rounded-md border border-border/50 bg-background/40 px-2.5 py-2 text-xs">
      <div className="flex items-center gap-1.5 font-medium text-foreground">
        <Gauge className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {t('claudeProfiles.liveUsage.title', { defaultValue: 'Usage limits' })}
      </div>
      <p className={`mt-0.5 text-[11px] ${isStale ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground'}`}>
        {reportText}
      </p>

      <dl className="mt-1.5 grid grid-cols-2 gap-2">
        <UsageWindow label={t('claudeProfiles.liveUsage.fiveHour', { defaultValue: 'Session 5 h' })} window={usage.fiveHour} now={now} />
        <UsageWindow label={t('claudeProfiles.liveUsage.sevenDay', { defaultValue: 'Weekly 7 d' })} window={usage.sevenDay} now={now} />
      </dl>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-border/40 pt-2">
        <span className="min-w-0 flex-1 text-[11px] text-muted-foreground">{bridgeText}</span>
        {action === 'enable' && (
          <Button size="sm" variant="outline" className="h-7 text-xs" disabled={pending} onClick={() => void run(() => api.claudeLiveUsage.enableBridge(claudeProfileId))}>
            {t('claudeProfiles.liveUsage.enable', { defaultValue: 'Enable' })}
          </Button>
        )}
        {action === 'repair' && (
          <Button size="sm" variant="outline" className="h-7 text-xs" disabled={pending} onClick={() => void run(() => api.claudeLiveUsage.enableBridge(claudeProfileId))}>
            {t('claudeProfiles.liveUsage.repair', { defaultValue: 'Repair' })}
          </Button>
        )}
        {action === 'disable' && (
          <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={pending} onClick={() => void run(() => api.claudeLiveUsage.disableBridge(claudeProfileId))}>
            {t('claudeProfiles.liveUsage.disable', { defaultValue: 'Disable' })}
          </Button>
        )}
      </div>

      {error && <div className="mt-1.5 text-[11px] text-red-600 dark:text-red-400">{error}</div>}
    </div>
  );
}
