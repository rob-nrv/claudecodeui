import os from 'node:os';
import path from 'node:path';

/**
 * Single seam for every filesystem path that depends on which Claude account
 * is in play (`CLOUDCLI_EXTENSION_PLAN.md` §4.1/§4.2). Every call site that
 * used to hard-code `~/.claude` should resolve through here instead.
 *
 * Calling with no `profileId` always returns the legacy, un-isolated path —
 * this is what every LOT-1 call site outside the `claude-profiles` module
 * does, so single/no-profile installs are byte-identical to today regardless
 * of how many rows exist in `claude_profiles`. Only a profile-specific
 * caller (Settings verification, and eventually the runtime spawn once a
 * session is bound to a profile) ever passes a real id.
 */

const PROFILE_ID_PATTERN = /^[a-zA-Z0-9-]{1,64}$/;

const assertValidProfileId = (profileId: string): void => {
  if (!PROFILE_ID_PATTERN.test(profileId)) {
    throw new Error(`Invalid Claude profile id: ${profileId}`);
  }
};

/** The historical, un-isolated Claude home (`~/.claude`). */
export function legacyClaudeHome(baseHomeDir: string = os.homedir()): string {
  return path.join(baseHomeDir, '.claude');
}

/** Root directory under which every isolated profile's config dir lives. */
export function claudeProfilesRoot(baseHomeDir: string = os.homedir()): string {
  return path.join(baseHomeDir, '.cloudcli', 'claude-profiles');
}

/**
 * Resolves the directory to use as `CLAUDE_CONFIG_DIR` (and, for the legacy
 * case, as the literal `~/.claude` used by every un-profiled read today).
 *
 * `baseHomeDir` lets call sites that already inject their home directory for
 * testability (e.g. `provider-token-usage.service.ts`, `cli.service.ts`,
 * `taskmaster.service.ts`) keep doing so through this same resolver instead
 * of bypassing it with a raw `os.homedir()`.
 */
export function claudeHomeFor(
  profileId?: string | null,
  baseHomeDir: string = os.homedir(),
): string {
  if (!profileId) {
    return legacyClaudeHome(baseHomeDir);
  }

  assertValidProfileId(profileId);
  return path.join(claudeProfilesRoot(baseHomeDir), profileId);
}

/**
 * `.claude.json` lives beside `~/.claude` in a default install (at
 * `$HOME/.claude.json`), but `CLAUDE_CONFIG_DIR` relocates it *inside*
 * itself instead — confirmed empirically in `MULTI_ACCOUNT_SPEC.md` §4.1
 * (A3). The two cases therefore resolve differently, which is why this is a
 * separate helper rather than `path.join(claudeHomeFor(...), '.claude.json')`
 * unconditionally.
 */
export function claudeConfigJsonPathFor(
  profileId?: string | null,
  baseHomeDir: string = os.homedir(),
): string {
  if (!profileId) {
    return path.join(baseHomeDir, '.claude.json');
  }

  return path.join(claudeHomeFor(profileId, baseHomeDir), '.claude.json');
}
