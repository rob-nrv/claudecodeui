import type { LLMProvider } from '../types/app';

/**
 * Single source of truth for every human-readable identity string the UI
 * renders: the app user (Settings → Profile, sidebar footer) and the Claude
 * account an execution is actually bound to (chat header, Running Sessions,
 * Settings → Claude Accounts).
 *
 * Framework-free on purpose — Home/Settings/session surfaces must never grow
 * their own monogram or label rules, and the rules here are unit-tested
 * directly rather than through component rendering.
 */

/** Shown when no configured user name is available. Never a personal value. */
export const APP_USER_FALLBACK_DISPLAY_NAME = 'User';

/** Monogram used when nothing nameable could be derived. */
export const UNRESOLVED_MONOGRAM = '?';

/** Product/provider branding. Not a profile label — see `resolveExecutionIdentity`. */
export const PROVIDER_LABELS: Record<LLMProvider, string> = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
  opencode: 'OpenCode',
};

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/**
 * Rejects values that look like a filesystem path so an accidentally
 * path-shaped record can never surface an OS home directory in the UI.
 */
const looksLikeFilesystemPath = (value: string): boolean =>
  value.includes('/') || value.includes('\\');

const readNameCandidate = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || looksLikeFilesystemPath(trimmed)) {
    return null;
  }
  return trimmed;
};

/**
 * First letter/digit of the first usable candidate, upper-cased.
 *
 * Iterates code points (not UTF-16 units) so accented and non-Latin names
 * yield a whole character: "Cédric" → "C", "Élise" → "É", "小明" → "小".
 */
export function deriveMonogram(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    const name = readNameCandidate(candidate);
    if (!name) {
      continue;
    }
    for (const character of name) {
      if (LETTER_OR_DIGIT.test(character)) {
        return character.toLocaleUpperCase();
      }
    }
  }
  return UNRESOLVED_MONOGRAM;
}

export type AppUserIdentity = {
  /** Always renderable. Falls back to a generic label, never to an OS username. */
  displayName: string;
  /** The account name the user registered with, when it is safe to show. */
  username: string | null;
  monogram: string;
  /** True when `displayName` is the generic fallback rather than configured data. */
  isFallback: boolean;
};

type AppUserSource = {
  username?: unknown;
  displayName?: unknown;
} | null | undefined;

/**
 * Derives the app user's identity from the authenticated user record.
 *
 * Configured `displayName` wins, then the registered `username`, then a
 * generic fallback. Nothing here reads the environment or the filesystem, so
 * a shared/forked install shows its own user — never a hardcoded person.
 */
export function resolveAppUserIdentity(user: AppUserSource): AppUserIdentity {
  const displayName = readNameCandidate(user?.displayName);
  const username = readNameCandidate(user?.username);
  const resolved = displayName ?? username;

  return {
    displayName: resolved ?? APP_USER_FALLBACK_DISPLAY_NAME,
    username,
    monogram: deriveMonogram(resolved, APP_USER_FALLBACK_DISPLAY_NAME),
    isFallback: resolved === null,
  };
}

export type ExecutionIdentity = {
  /** "Claude", "Codex", … — provider branding, always present. */
  providerLabel: string;
  /** Bound account name, or null when the execution carries no account. */
  profileLabel: string | null;
  /** Compact secondary cue so identity is never carried by colour alone. */
  profileMonogram: string | null;
  /** True when the execution is bound to an account that no longer resolves. */
  isProfileUnresolved: boolean;
  /** "Claude · Work" — for tooltips, `title` and accessible names. */
  fullLabel: string;
};

type ExecutionIdentityInput = {
  provider?: LLMProvider | string | null;
  /** Backend/session-authoritative binding. Never the current UI selection. */
  claudeProfileId?: string | null;
  /** Registered account names, keyed by profile id. */
  profileNamesById: ReadonlyMap<string, string>;
  /** i18n label for a bound account that no longer exists. */
  unresolvedLabel?: string;
};

const providerLabelFor = (provider: ExecutionIdentityInput['provider']): string => {
  if (typeof provider === 'string' && provider in PROVIDER_LABELS) {
    return PROVIDER_LABELS[provider as LLMProvider];
  }
  return 'Agent';
};

/**
 * Resolves what an execution should say about itself.
 *
 * `claudeProfileId` must come from the persisted session/activity record —
 * the binding is immutable and backend-authoritative, so a stale global
 * profile selection in the frontend can never override it here. A bound id
 * that no longer resolves reports `isProfileUnresolved` rather than silently
 * disappearing or falling back to the default account.
 */
export function resolveExecutionIdentity({
  provider,
  claudeProfileId,
  profileNamesById,
  unresolvedLabel = 'Unknown account',
}: ExecutionIdentityInput): ExecutionIdentity {
  const providerLabel = providerLabelFor(provider);

  if (provider !== 'claude' || !claudeProfileId) {
    return {
      providerLabel,
      profileLabel: null,
      profileMonogram: null,
      isProfileUnresolved: false,
      fullLabel: providerLabel,
    };
  }

  const registeredName = readNameCandidate(profileNamesById.get(claudeProfileId));
  const isProfileUnresolved = registeredName === null;
  const profileLabel = registeredName ?? unresolvedLabel;

  return {
    providerLabel,
    profileLabel,
    profileMonogram: isProfileUnresolved ? UNRESOLVED_MONOGRAM : deriveMonogram(profileLabel),
    isProfileUnresolved,
    fullLabel: `${providerLabel} · ${profileLabel}`,
  };
}

/**
 * Whether account identity is worth showing at all.
 *
 * With a single registered account there is no ambiguity to resolve, so the
 * product stays silent about profiles entirely rather than stamping every row
 * with the same badge.
 */
export function shouldShowProfileIdentity(registeredProfileCount: number): boolean {
  return registeredProfileCount > 1;
}
