type ContextRingProps = {
  usage: Record<string, unknown> | null;
  onClick?: () => void;
};

const readUsageNumber = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const RADIUS = 5.25;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * Claude desktop context indicator: a 13px ring whose blue arc is the share of
 * the context window the session has used. Opens the token usage details.
 */
export default function ContextRing({ usage, onClick }: ContextRingProps) {
  const breakdown =
    usage?.breakdown && typeof usage.breakdown === 'object'
      ? usage.breakdown as Record<string, unknown>
      : null;
  const inputTokens = readUsageNumber(usage?.inputTokens ?? breakdown?.input);
  const outputTokens = readUsageNumber(usage?.outputTokens ?? breakdown?.output);
  const usedTokens = readUsageNumber(usage?.used) || inputTokens + outputTokens;
  const totalTokens = readUsageNumber(usage?.total);
  const ratio = totalTokens > 0 ? Math.min(1, usedTokens / totalTokens) : 0;
  const label = totalTokens > 0
    ? `${Math.round(ratio * 100)}% of context used (${usedTokens.toLocaleString()} / ${totalTokens.toLocaleString()} tokens)`
    : `${usedTokens.toLocaleString()} tokens used`;

  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-c-hover"
    >
      <svg width="15" height="15" viewBox="0 0 15 15" aria-hidden="true">
        <circle cx="7.5" cy="7.5" r={RADIUS} fill="none" stroke="currentColor" strokeWidth="2" className="text-c-text-3/60" />
        <circle
          cx="7.5"
          cy="7.5"
          r={RADIUS}
          fill="none"
          stroke="#3987e5"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={`${ratio * CIRCUMFERENCE} ${CIRCUMFERENCE}`}
          transform="rotate(-90 7.5 7.5)"
          opacity={ratio > 0 ? 1 : 0}
        />
      </svg>
    </button>
  );
}
