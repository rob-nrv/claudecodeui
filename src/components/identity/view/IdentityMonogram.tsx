import { cn } from '../../../lib/utils';

export type IdentityMonogramSize = 'xs' | 'sm' | 'md' | 'lg';

const SIZE_CLASSES: Record<IdentityMonogramSize, string> = {
  xs: 'h-4 w-4 rounded text-[9px]',
  sm: 'h-5 w-5 rounded-md text-[10px]',
  md: 'h-8 w-8 rounded-lg text-xs',
  lg: 'h-12 w-12 rounded-xl text-lg',
};

type IdentityMonogramProps = {
  /** Pre-derived initial — always from `shared/identity`, never inline logic. */
  monogram: string;
  size?: IdentityMonogramSize;
  /** Softer treatment for an identity the product could not resolve. */
  muted?: boolean;
  className?: string;
};

/**
 * The one avatar/initial primitive in the product.
 *
 * Deliberately neutral: identity is carried by the letter and the label
 * beside it, never by colour alone, so it stays legible in dark mode and for
 * colour-blind users. Marked `aria-hidden` because every call site already
 * renders the readable name next to it.
 */
export default function IdentityMonogram({
  monogram,
  size = 'sm',
  muted = false,
  className,
}: IdentityMonogramProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex flex-shrink-0 select-none items-center justify-center border font-semibold uppercase leading-none',
        muted
          ? 'border-border/50 bg-muted/40 text-muted-foreground'
          : 'border-border bg-muted text-foreground',
        SIZE_CLASSES[size],
        className,
      )}
    >
      {monogram}
    </span>
  );
}
