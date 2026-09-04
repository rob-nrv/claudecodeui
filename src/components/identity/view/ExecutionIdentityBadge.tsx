import { cn } from '../../../lib/utils';
import type { ExecutionIdentity } from '../../../shared/identity';

import IdentityMonogram from './IdentityMonogram';

type ExecutionIdentityBadgeProps = {
  identity: ExecutionIdentity;
  /**
   * `inline` sits inside an existing metadata line (chat header subtitle,
   * Running Sessions detail); `pill` stands alone in a list row.
   */
  variant?: 'inline' | 'pill';
  className?: string;
};

/**
 * Compact "which account is actually running this" badge.
 *
 * Renders nothing when the execution carries no account binding, so the
 * product stays silent rather than showing an empty or guessed identity. The
 * readable account name is always present next to the monogram; the full
 * "Claude · Work" string is exposed through `title` and the accessible label
 * so provider and account are both recoverable on a narrow viewport.
 */
export default function ExecutionIdentityBadge({
  identity,
  variant = 'inline',
  className,
}: ExecutionIdentityBadgeProps) {
  if (!identity.profileLabel || !identity.profileMonogram) {
    return null;
  }

  return (
    <span
      title={identity.fullLabel}
      aria-label={identity.fullLabel}
      className={cn(
        'inline-flex min-w-0 max-w-full items-center gap-1 align-middle',
        variant === 'pill' && 'rounded-md border border-border/60 bg-muted/40 px-1.5 py-0.5',
        identity.isProfileUnresolved ? 'text-muted-foreground/80' : 'text-muted-foreground',
        className,
      )}
    >
      <IdentityMonogram
        monogram={identity.profileMonogram}
        size="xs"
        muted={identity.isProfileUnresolved}
      />
      <span className="truncate text-[11px] leading-none">{identity.profileLabel}</span>
    </span>
  );
}
