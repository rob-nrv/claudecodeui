import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';

import { runClaudeAuthStatusProbe } from '@/modules/claude-profiles/claude-auth-status-probe.js';
import { claudeHomeFor } from '@/modules/claude-profiles/claude-home.resolver.js';
import { claudeProfilesDb, type ClaudeProfileRecord } from '@/modules/database/index.js';
import type { ClaudeAuthStatusProbeResult, ClaudeProfile } from '@/shared/types.js';
import { AppError, readOptionalString } from '@/shared/utils.js';

const MAX_DISPLAY_NAME_LENGTH = 60;

type ClaudeProfilesServiceDependencies = {
  probeAuthStatus?: (configDirectory?: string) => Promise<ClaudeAuthStatusProbeResult | null>;
};

/**
 * Strips `configDirectory` (and everything else server-only) before a
 * profile ever reaches a route handler. `MULTI_ACCOUNT_SPEC.md` §3.4/§5.2:
 * the frontend never sees a config path or credential material.
 */
const toPublicProfile = (record: ClaudeProfileRecord): ClaudeProfile => ({
  id: record.id,
  displayName: record.displayName,
  connectionState: record.connectionState,
  verifiedIdentity: record.verifiedIdentity,
  isDefault: record.isDefault,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
});

const normalizeDisplayName = (value: unknown): string => {
  const trimmed = readOptionalString(value);
  if (!trimmed) {
    throw new AppError('displayName is required.', {
      code: 'CLAUDE_PROFILE_NAME_REQUIRED',
      statusCode: 400,
    });
  }
  if (trimmed.length > MAX_DISPLAY_NAME_LENGTH) {
    throw new AppError(`displayName must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer.`, {
      code: 'CLAUDE_PROFILE_NAME_TOO_LONG',
      statusCode: 400,
    });
  }
  return trimmed;
};

const requireProfileRecord = (id: string): ClaudeProfileRecord => {
  const record = claudeProfilesDb.getById(id);
  if (!record) {
    throw new AppError('Claude profile not found.', {
      code: 'CLAUDE_PROFILE_NOT_FOUND',
      statusCode: 404,
    });
  }
  return record;
};

/**
 * `dependencies.probeAuthStatus` is injectable (mirrors `ClaudeProviderAuth`)
 * so tests can exercise `verifyProfile`'s state mapping without depending on
 * a real `claude` CLI. `claude-profiles.routes.ts` uses the default export
 * below, which always probes for real.
 */
export function createClaudeProfilesService(dependencies: ClaudeProfilesServiceDependencies = {}) {
  const probeAuthStatus = dependencies.probeAuthStatus ?? runClaudeAuthStatusProbe;

  return {
    listProfiles(): ClaudeProfile[] {
      return claudeProfilesDb.list().map(toPublicProfile);
    },

    /**
     * Every profile — including the first — gets its own fresh, isolated
     * config directory under `~/.cloudcli/claude-profiles/<id>`; it never
     * reuses `~/.claude`. That directory starts unauthenticated, so a newly
     * created profile always needs its own `claude /login` before `verify`
     * reports it connected. The *existing* single-account install is
     * untouched by this: it is never represented by a `claude_profiles` row
     * at all, so every un-profiled call site keeps resolving `~/.claude`
     * exactly as it does today (`claude-home.resolver.ts`).
     */
    async createProfile(input: { displayName: unknown }): Promise<ClaudeProfile> {
      const displayName = normalizeDisplayName(input.displayName);
      const id = randomUUID();
      const configDirectory = claudeHomeFor(id);
      const isDefault = claudeProfilesDb.count() === 0;

      await mkdir(configDirectory, { recursive: true });

      const record = claudeProfilesDb.create({ id, displayName, configDirectory, isDefault });
      return toPublicProfile(record);
    },

    renameProfile(id: string, displayName: unknown): ClaudeProfile {
      requireProfileRecord(id);
      const record = claudeProfilesDb.updateDisplayName(id, normalizeDisplayName(displayName));
      if (!record) {
        throw new AppError('Claude profile not found.', { code: 'CLAUDE_PROFILE_NOT_FOUND', statusCode: 404 });
      }
      return toPublicProfile(record);
    },

    setDefaultProfile(id: string): ClaudeProfile {
      requireProfileRecord(id);
      const record = claudeProfilesDb.setDefault(id);
      if (!record) {
        throw new AppError('Claude profile not found.', { code: 'CLAUDE_PROFILE_NOT_FOUND', statusCode: 404 });
      }
      return toPublicProfile(record);
    },

    /**
     * Removes only the CloudCLI-side registration. This is deliberately
     * conservative (`CLOUDCLI_EXTENSION_PLAN.md` LOT-1 §10): deleting a
     * profile's isolated config directory — and with it, real Claude
     * credentials — is not something a UI removal should ever do silently.
     * That directory is left on disk; a future lot can add an explicit,
     * separately-confirmed "delete Claude data" action if needed.
     */
    removeProfile(id: string): ClaudeProfile {
      const record = claudeProfilesDb.delete(id);
      if (!record) {
        throw new AppError('Claude profile not found.', { code: 'CLAUDE_PROFILE_NOT_FOUND', statusCode: 404 });
      }
      return toPublicProfile(record);
    },

    /**
     * Verifies a profile's identity by running `claude auth status` against
     * its own `CLAUDE_CONFIG_DIR` (`MULTI_ACCOUNT_SPEC.md` §5). A probe
     * failure or malformed response maps to `connectionState: 'unknown'` and
     * clears any previously cached identity — it must never leave a stale
     * "connected" state standing on an inconclusive read.
     */
    async verifyProfile(id: string): Promise<ClaudeProfile> {
      const record = requireProfileRecord(id);
      const probe = await probeAuthStatus(record.configDirectory);

      if (!probe) {
        const updated = claudeProfilesDb.updateConnectionState(id, {
          connectionState: 'unknown',
          verifiedIdentity: null,
        });
        return toPublicProfile(updated ?? record);
      }

      if (!probe.loggedIn) {
        const updated = claudeProfilesDb.updateConnectionState(id, {
          connectionState: 'not_authenticated',
          verifiedIdentity: null,
        });
        return toPublicProfile(updated ?? record);
      }

      // loggedIn:true with no email is possible (e.g. a still-settling probe);
      // connectionState reflects the CLI's own answer while verifiedIdentity
      // stays null, which the UI renders as "Connected / Identity not
      // verified" rather than inventing an identity (MULTI_ACCOUNT_SPEC §6.2).
      const updated = claudeProfilesDb.updateConnectionState(id, {
        connectionState: 'connected',
        verifiedIdentity: probe.email
          ? {
            value: probe.email,
            method: 'cli_probe',
            tier: probe.subscriptionType,
            verifiedAt: Date.now(),
          }
          : null,
      });
      return toPublicProfile(updated ?? record);
    },
  };
}

export const claudeProfilesService = createClaudeProfilesService();
