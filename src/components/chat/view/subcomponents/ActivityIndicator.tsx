import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Shimmer } from '../../../../shared/view/ui';
import type { SessionActivity } from '../../../../hooks/useSessionProtection';

type ActivityIndicatorProps = {
  activity: SessionActivity | null;
  onAbort?: () => void;
  isInputFocused?: boolean;
};

const ACTION_KEYS = [
  'claudeStatus.actions.thinking',
  'claudeStatus.actions.processing',
  'claudeStatus.actions.analyzing',
  'claudeStatus.actions.working',
  'claudeStatus.actions.computing',
  'claudeStatus.actions.reasoning',
];
const DEFAULT_ACTION_WORDS = ['Thinking', 'Processing', 'Analyzing', 'Working', 'Computing', 'Reasoning'];
const EXIT_ANIMATION_MS = 220;

/**
 * Minimal response-in-progress indicator, in the spirit of the inline status
 * lines in Claude Code / Codex / OpenCode: a shimmering activity label, the
 * elapsed time, and an interrupt affordance. Rendered only while the viewed
 * session has an entry in the processing map; it disappears the instant that
 * entry is removed.
 */
export default function ActivityIndicator({ activity, onAbort, isInputFocused = false }: ActivityIndicatorProps) {
  const { t } = useTranslation('chat');
  const [renderedActivity, setRenderedActivity] = useState<SessionActivity | null>(activity);
  const [isExiting, setIsExiting] = useState(false);
  const startedAt = renderedActivity?.startedAt ?? null;
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    if (activity) {
      setRenderedActivity(activity);
      setIsExiting(false);
      return;
    }

    if (!renderedActivity) return;

    setIsExiting(true);
    const timer = setTimeout(() => {
      setRenderedActivity(null);
      setIsExiting(false);
    }, EXIT_ANIMATION_MS);

    return () => clearTimeout(timer);
  }, [activity, renderedActivity]);

  useEffect(() => {
    if (startedAt === null) return;
    const update = () => setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [startedAt]);

  if (!renderedActivity) return null;

  const actionWords = ACTION_KEYS.map((key, i) => t(key, { defaultValue: DEFAULT_ACTION_WORDS[i] }));
  const label = (renderedActivity.statusText || actionWords[Math.floor(elapsedSeconds / 4) % actionWords.length])
    .replace(/\.+$/, '');

  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  const elapsedLabel = minutes < 1
    ? t('claudeStatus.elapsed.seconds', { count: seconds, defaultValue: '{{count}}s' })
    : t('claudeStatus.elapsed.minutesSeconds', { minutes, seconds, defaultValue: '{{minutes}}m {{seconds}}s' });
  // Claude desktop run line, at the end of the conversation: three accent dots,
  // elapsed time and the current status ("•• 36m 3s · Thinking"). Stopping
  // lives in the composer's stop button (and Esc), as in Claude desktop.
  return (
    <div
      role="status"
      aria-live="polite"
      className={`mt-[35px] flex h-5 items-center gap-[9px] pl-[3px] text-[14px] leading-5 text-c-text-3 ${
        isExiting ? 'chat-activity-exit' : 'chat-activity-enter'
      }`}
      data-input-focused={isInputFocused || undefined}
      data-can-interrupt={(renderedActivity.canInterrupt && Boolean(onAbort)) || undefined}
    >
      <span className="claude-run-dots flex items-center gap-[2px]" aria-hidden>
        <span />
        <span />
        <span />
      </span>
      <span className="tabular-nums">{elapsedLabel}</span>
      <span aria-hidden>·</span>
      <Shimmer>{label}</Shimmer>
    </div>
  );
}
