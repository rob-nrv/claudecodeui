import { cn } from '../../../lib/utils';
import { useAppUserIdentity } from '../../../hooks/useAppUserIdentity';

import IdentityMonogram from './IdentityMonogram';

type AppUserBadgeProps = {
  /** Secondary line under the name, e.g. the "Settings" action label. */
  caption?: string;
  className?: string;
};

/**
 * The signed-in user's name and initial, as shown outside Settings.
 *
 * Shares `useAppUserIdentity` with Settings → Profile, so the initial and the
 * name shown here are derived by exactly the same rules.
 */
export default function AppUserBadge({ caption, className }: AppUserBadgeProps) {
  const identity = useAppUserIdentity();

  return (
    <span className={cn('flex min-w-0 items-center gap-3', className)}>
      <IdentityMonogram monogram={identity.monogram} size="md" muted={identity.isFallback} />
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate text-sm font-medium text-foreground" title={identity.displayName}>
          {identity.displayName}
        </span>
        {caption && (
          <span className="block truncate text-[11px] leading-tight text-muted-foreground">{caption}</span>
        )}
      </span>
    </span>
  );
}
