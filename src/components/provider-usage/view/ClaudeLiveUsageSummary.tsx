import { Gauge } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../../shared/view/ui';
import { api } from '../../../utils/api';
import {
  formatUsedPercentage,
  getBridgeAction,
  getResetHint,
  getUsageLevel,
  type ClaudeLiveUsage,
  type ClaudeLiveUsageWindow,
  type UsageLevel,
} from '../utils/liveUsage';

type ClaudeLiveUsageSummaryProps = {
  /** Claude profile id, or null for the historical (un-isolated `~/.claude`) account. */
  claudeProfileId: string | null;
};

const LEVEL_CLASS: Record<UsageLevel, string> = {
  normal: 'text-foreground',
  elevated: 'text-amber-700 dark:text-amber-400',
  high: 'text-red-700 dark:text-red-400',
};

const MINUTE_MS = 60_000;

async function readLiveUsageResponse(response: Response): Promise<ClaudeLiveUsage> {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.error?.message || `Live usage request failed (${response.status})`);
  }
  if (!body?.data?.liveUsage) {
    throw new Error('Malformed live usage response');
  }
  return body.data.liveUsage as ClaudeLiveUsage;
}

function UsageWindow({ label, window, now }: { label: string; window: ClaudeLiveUsageWindow; now: number }) {
  const { t } = useTranslation('settings');

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
    resetText = t('claudeProfiles.liveUsage.resetsInHours', {
      hours: hint.hours,
      minutes: hint.minutes,
      defaultValue: 'Resets in {{hours}} h {{minutes}} min',
    });
  } else if (hint?.kind === 'date') {
    resetText = t('claudeProfiles.liveUsage.resetsAt', {
      date: hint.date.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' }),
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
 * Compact, backend-authoritative Claude live usage for one account (FT-M07):
 * the 5-hour session window and the 7-day weekly window captured from Claude
 * Code's statusLine, plus the explicit control for the capture bridge. An
 * unavailable window shows why instead of a number; the raw `/usage` check
 * next to it stays available as the fallback.
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
  const capturedAge = usage.snapshot.capturedAt
    ? Math.max(0, Math.round((now - Date.parse(usage.snapshot.capturedAt)) / MINUTE_MS))
    : null;

  let snapshotText: string;
  if (usage.snapshot.status === 'available' && capturedAge !== null) {
    snapshotText = usage.snapshot.freshness === 'stale'
      ? t('claudeProfiles.liveUsage.staleCapture', { minutes: capturedAge, defaultValue: 'Stale · last update {{minutes}} min ago' })
      : t('claudeProfiles.liveUsage.freshCapture', { minutes: capturedAge, defaultValue: 'Updated {{minutes}} min ago' });
  } else if (usage.snapshot.reason === 'no_snapshot') {
    snapshotText = action === 'enable'
      ? t('claudeProfiles.liveUsage.noSnapshotDisabled', { defaultValue: 'Not captured yet.' })
      : t('claudeProfiles.liveUsage.noSnapshot', { defaultValue: 'Appears after a Claude response in an interactive Claude Code session for this account.' });
  } else if (usage.snapshot.reason === 'attribution_mismatch') {
    snapshotText = t('claudeProfiles.liveUsage.attributionMismatch', { defaultValue: 'The last capture belongs to another account and was ignored.' });
  } else {
    snapshotText = t('claudeProfiles.liveUsage.invalidSnapshot', { defaultValue: 'The last capture could not be trusted and was ignored.' });
  }

  let bridgeText: string;
  if (action === 'enable') {
    bridgeText = usage.bridge.hasUserStatusLine
      ? t('claudeProfiles.liveUsage.enableWrapsExisting', { defaultValue: 'Your existing status line is kept: CloudCLI runs it after reading the usage.' })
      : t('claudeProfiles.liveUsage.enableAddsStatusLine', { defaultValue: 'Adds a status line to Claude Code for this account, which hides its footer shortcut hints.' });
  } else if (action === 'disable') {
    bridgeText = usage.bridge.wrapsExistingStatusLine
      ? t('claudeProfiles.liveUsage.capturingWrapped', { defaultValue: 'Capturing from Claude Code. Your status line still runs.' })
      : t('claudeProfiles.liveUsage.capturing', { defaultValue: 'Capturing from Claude Code\'s status line.' });
  } else if (action === 'repair') {
    bridgeText = t('claudeProfiles.liveUsage.needsRepair', { defaultValue: 'The usage bridge needs to be repaired before it can run.' });
  } else {
    bridgeText = t('claudeProfiles.liveUsage.settingsUnreadable', { defaultValue: 'Claude settings for this account could not be read, so CloudCLI will not change them.' });
  }

  return (
    <div className="mt-3 rounded-md border border-border/50 bg-background/40 px-2.5 py-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 font-medium text-foreground">
          <Gauge className="h-3.5 w-3.5" aria-hidden="true" />
          {t('claudeProfiles.liveUsage.title', { defaultValue: 'Live usage' })}
        </span>
        <span className="truncate text-[11px] text-muted-foreground">{snapshotText}</span>
      </div>

      <dl className="mt-1.5 grid grid-cols-2 gap-2">
        <UsageWindow label={t('claudeProfiles.liveUsage.fiveHour', { defaultValue: 'Session 5 h' })} window={usage.fiveHour} now={now} />
        <UsageWindow label={t('claudeProfiles.liveUsage.sevenDay', { defaultValue: 'Weekly 7 d' })} window={usage.sevenDay} now={now} />
      </dl>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-border/40 pt-2">
        <span className="min-w-0 flex-1 text-[11px] text-muted-foreground">{bridgeText}</span>
        {action === 'enable' && (
          <Button size="sm" variant="outline" className="h-7 text-xs" disabled={pending} onClick={() => void run(() => api.claudeLiveUsage.enableBridge(claudeProfileId))}>
            {t('claudeProfiles.liveUsage.enable', { defaultValue: 'Enable live usage' })}
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
