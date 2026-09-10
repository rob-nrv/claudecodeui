import type { ProviderModelOption } from '../../../types/app';

const formatTokenCount = (tokens: number): string => (
  tokens >= 1_000_000 ? `${tokens / 1_000_000}M` : `${Math.round(tokens / 1000)}K`
);

/**
 * Renders static capability facts (e.g. "200K context · 64K max output").
 * Dynamic aliases (default/best/opusplan) carry no capability, so this
 * returns null rather than guessing a value from another model.
 */
export function formatModelCapability(capability: ProviderModelOption['capability']): string | null {
  if (!capability) {
    return null;
  }
  const parts: string[] = [];
  if (capability.contextWindowTokens) {
    parts.push(`${formatTokenCount(capability.contextWindowTokens)} context`);
  }
  if (capability.maxOutputTokens) {
    parts.push(`${formatTokenCount(capability.maxOutputTokens)} max output`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}
