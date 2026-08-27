import spawn from 'cross-spawn';

import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';
import type { ClaudeAuthStatusProbeResult } from '@/shared/types.js';
import { readObjectRecord, readOptionalString } from '@/shared/utils.js';

const AUTH_STATUS_PROBE_TIMEOUT_MS = 10_000;

export type ClaudeAuthProbeFn = (configDirectory?: string) => Promise<ClaudeAuthStatusProbeResult | null>;

/**
 * Runs `claude auth status` non-interactively and parses its JSON stdout
 * (verified format: `MULTI_ACCOUNT_SPEC.md` §4.3). Returns `null` on any
 * failure to get a trustworthy answer — non-zero exit, spawn error, timeout,
 * or unparsable/malformed output — and callers must treat that as "identity
 * unknown", never as "authenticated". This is the replacement for the old
 * hand-rolled `.credentials.json` parsing in `claude-auth.provider.ts` that
 * could report a confident identity that did not exist
 * (`CLOUDCLI_EXTENSION_PLAN.md` §3).
 *
 * Lives in the `claude-profiles` module (rather than the `providers` module,
 * where the sole caller of the legacy/no-profile case lives) so both that
 * caller and `claude-profiles.service.ts`'s per-profile `verifyProfile` can
 * depend on it in one direction, without a `providers` ↔ `claude-profiles`
 * import cycle.
 *
 * When `configDirectory` is omitted, the CLI's own default resolution is
 * used (today's single-account `~/.claude`); when provided, it is passed as
 * `CLAUDE_CONFIG_DIR` in the child's environment only — never
 * `process.env` itself, so no other in-flight probe or run is affected.
 */
export const runClaudeAuthStatusProbe: ClaudeAuthProbeFn = (configDirectory) => {
  const cliPath = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH);
  const env = configDirectory
    ? { ...process.env, CLAUDE_CONFIG_DIR: configDirectory }
    : { ...process.env };

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: ClaudeAuthStatusProbeResult | null) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };

    // No shell involved (array args, shell: false), so configDirectory can
    // never be interpreted as shell syntax.
    const child = spawn(cliPath, ['auth', 'status'], { env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, AUTH_STATUS_PROBE_TIMEOUT_MS);
    timer.unref?.();

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on('error', () => {
      clearTimeout(timer);
      finish(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        finish(null);
        return;
      }

      try {
        const parsed = readObjectRecord(JSON.parse(stdout));
        if (!parsed || typeof parsed.loggedIn !== 'boolean') {
          finish(null);
          return;
        }

        finish({
          loggedIn: parsed.loggedIn,
          authMethod: readOptionalString(parsed.authMethod) ?? null,
          apiProvider: readOptionalString(parsed.apiProvider) ?? null,
          email: readOptionalString(parsed.email) ?? null,
          orgId: readOptionalString(parsed.orgId) ?? null,
          orgName: readOptionalString(parsed.orgName) ?? null,
          subscriptionType: readOptionalString(parsed.subscriptionType) ?? null,
        });
      } catch {
        finish(null);
      }
    });
  });
};
