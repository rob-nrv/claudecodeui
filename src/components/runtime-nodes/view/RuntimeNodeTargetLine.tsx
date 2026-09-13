import { Server } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  describeRuntimeNodeStatus,
  resolveCreationTarget,
  type RuntimeNodeStatusDisplay,
  type RuntimeNodesListing,
} from '../utils/runtimeNodes';

type RuntimeNodeTargetLineProps = {
  listing: RuntimeNodesListing | null;
  loading: boolean;
  error: string | null;
  className?: string;
};

const EMPHASIS_CLASS: Record<RuntimeNodeStatusDisplay['emphasis'], string> = {
  positive: 'text-emerald-700 dark:text-emerald-400',
  warning: 'text-amber-700 dark:text-amber-400',
  muted: 'text-muted-foreground',
};

const STATUS_DEFAULTS: Record<RuntimeNodeStatusDisplay['key'], string> = {
  available: 'Available',
  claudeUnavailable: 'Claude CLI not found',
  notResponding: 'Status out of date',
  unknown: 'Status not checked yet',
  offline: 'Offline',
  checking: 'Checking…',
  conflict: 'Credential in use elsewhere',
  incompatible: 'Needs update',
  revoked: 'Revoked',
  neverConnected: 'Never connected',
};

/**
 * One compact line on the new-session surface naming the RuntimeNode the next
 * session will be bound to, with its backend-reported availability as text.
 * It is informational: with a single executable node there is nothing to
 * choose, and nothing here ever claims a node the backend did not report.
 */
export default function RuntimeNodeTargetLine({ listing, loading, error, className = '' }: RuntimeNodeTargetLineProps) {
  const { t } = useTranslation('chat');
  const baseClass = `flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground ${className}`;

  if (loading && !listing) {
    return null;
  }

  const target = resolveCreationTarget(listing);
  if (!target) {
    return (
      <p className={baseClass} role="status">
        <Server className="h-3 w-3 shrink-0" aria-hidden="true" />
        <span>
          {error || !listing
            ? t('runtimeNode.statusUnavailable', { defaultValue: 'Runtime node status unavailable' })
            : t('runtimeNode.noSingleTarget', { defaultValue: 'No single runtime node to run on' })}
        </span>
      </p>
    );
  }

  const status = describeRuntimeNodeStatus(target);
  return (
    <p className={baseClass} role="status">
      <Server className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span>{t('runtimeNode.runsOn', { defaultValue: 'Runs on' })}</span>
      <span className="max-w-40 truncate font-medium text-foreground" title={target.label}>
        {target.label}
      </span>
      <span aria-hidden="true">·</span>
      <span className={EMPHASIS_CLASS[status.emphasis]}>
        {t(`runtimeNode.status.${status.key}`, { defaultValue: STATUS_DEFAULTS[status.key] })}
      </span>
    </p>
  );
}
