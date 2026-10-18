import type { ReactNode, Ref } from 'react';
import { Check } from 'lucide-react';

import { cn } from '../../../../lib/utils';
import type { ComposerMenuAnchor } from '../../hooks/useComposerMenuAnchor';

/**
 * Shared shell for the composer popovers (model/effort and permissions) so both
 * menus share one surface, one heading style and one row style.
 */
export function ComposerMenuSurface({
  anchor,
  menuRef,
  ariaLabel,
  children,
}: {
  anchor: ComposerMenuAnchor;
  menuRef: Ref<HTMLDivElement>;
  ariaLabel: string;
  children: ReactNode;
}) {
  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={ariaLabel}
      className="fixed z-[100] min-w-48 overflow-y-auto overscroll-contain rounded-[10px] border border-c-card-border bg-c-surface p-1 text-c-text shadow-[0_8px_24px_rgba(0,0,0,0.35)]"
      style={{
        right: anchor.right,
        bottom: anchor.bottom,
        maxHeight: anchor.maxHeight,
        maxWidth: anchor.maxWidth,
      }}
    >
      {children}
    </div>
  );
}

export function ComposerMenuHeading({ children }: { children: ReactNode }) {
  return (
    <p className="px-2.5 pb-1 pt-1.5 text-[12px] text-c-text-3">{children}</p>
  );
}

export function ComposerMenuSeparator() {
  return <div className="my-1 h-px bg-c-card-border" aria-hidden />;
}

export function ComposerMenuItem({
  label,
  description,
  icon,
  isSelected,
  onSelect,
  role = 'menuitemradio',
  trailing,
  className,
}: {
  label: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  isSelected: boolean;
  onSelect: () => void;
  role?: 'menuitemradio' | 'menuitem';
  trailing?: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      role={role}
      aria-checked={role === 'menuitemradio' ? isSelected : undefined}
      onClick={onSelect}
      className={cn(
        'flex w-full items-start gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors',
        'hover:bg-accent focus-visible:bg-accent focus-visible:outline-none',
        isSelected ? 'text-foreground' : 'text-foreground/90',
        className,
      )}
    >
      {icon && <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">{icon}</span>}
      <span className="min-w-0 flex-1">
        <span className="block truncate leading-5">{label}</span>
        {description && (
          <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">{description}</span>
        )}
      </span>
      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
        {trailing ?? (isSelected ? <Check className="h-3.5 w-3.5 text-foreground" /> : null)}
      </span>
    </button>
  );
}
