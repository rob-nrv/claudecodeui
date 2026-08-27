import { readFile } from 'node:fs/promises';
import path from 'node:path';

import spawn from 'cross-spawn';

import {
  claudeHomeFor,
  runClaudeAuthStatusProbe,
  type ClaudeAuthProbeFn,
} from '@/modules/claude-profiles/index.js';
import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';
import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';
import { readObjectRecord, readOptionalString } from '@/shared/utils.js';

type ClaudeCredentialsStatus = {
  authenticated: boolean;
  email: string | null;
  method: string | null;
  error?: string;
};

export class ClaudeProviderAuth implements IProviderAuth {
  private readonly probeAuthStatus: ClaudeAuthProbeFn;

  /**
   * `dependencies.probeAuthStatus` is injectable so tests can exercise the
   * `claude auth status` mapping (loggedIn true/false, command failure,
   * malformed JSON) without depending on the real `claude` CLI being
   * installed. Production code never passes it — the default always shells
   * out for real.
   */
  constructor(dependencies: { probeAuthStatus?: ClaudeAuthProbeFn } = {}) {
    this.probeAuthStatus = dependencies.probeAuthStatus ?? runClaudeAuthStatusProbe;
  }

  /**
   * Checks whether the Claude Code CLI is available on this host.
   */
  private checkInstalled(): boolean {
    const cliPath = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH);
    try {
      spawn.sync(cliPath, ['--version'], { stdio: 'ignore', timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Returns Claude installation and credential status using Claude Code's auth priority.
   */
  async getStatus(): Promise<ProviderAuthStatus> {
    const installed = this.checkInstalled();

    if (!installed) {
      return {
        installed,
        provider: 'claude',
        authenticated: false,
        email: null,
        method: null,
        error: 'Claude Code CLI is not installed',
      };
    }

    const credentials = await this.checkCredentials();

    return {
      installed,
      provider: 'claude',
      authenticated: credentials.authenticated,
      // No literal 'Authenticated' fallback here: a null email means the
      // real identity is unknown, and the caller (AccountContent.tsx)
      // already renders a translated "authenticated user" fallback for
      // that case. Substituting a fake identity server-side was the bug.
      email: credentials.email,
      method: credentials.method,
      error: credentials.authenticated ? undefined : credentials.error || 'Not authenticated',
    };
  }

  /**
   * Reads Claude settings env values that the CLI can use even when the server process env is empty.
   */
  private async loadSettingsEnv(): Promise<Record<string, unknown>> {
    try {
      const settingsPath = path.join(claudeHomeFor(), 'settings.json');
      const content = await readFile(settingsPath, 'utf8');
      const settings = readObjectRecord(JSON.parse(content));
      return readObjectRecord(settings?.env) ?? {};
    } catch {
      return {};
    }
  }

  /**
   * Checks Claude credentials in the same priority order used by Claude Code.
   *
   * The env-var branches are unchanged: they are direct configuration, not
   * an identity claim, so they never had the false-identity bug. Only the
   * final branch — previously a hand-rolled read of `.credentials.json` that
   * could report a confident identity that did not exist (§3 of
   * `CLOUDCLI_EXTENSION_PLAN.md`) — is replaced, by `claude auth status`.
   */
  private async checkCredentials(): Promise<ClaudeCredentialsStatus> {
    const missingCredentialsError = 'Claude CLI is not authenticated. Run claude /login or configure ANTHROPIC_API_KEY.';

    if (process.env.ANTHROPIC_AUTH_TOKEN?.trim()) {
      return { authenticated: true, email: 'Auth Token', method: 'api_key' };
    }

    if (process.env.ANTHROPIC_API_KEY?.trim()) {
      return { authenticated: true, email: 'API Key Auth', method: 'api_key' };
    }

    const settingsEnv = await this.loadSettingsEnv();
    if (readOptionalString(settingsEnv.ANTHROPIC_API_KEY)) {
      return { authenticated: true, email: 'API Key Auth', method: 'api_key' };
    }

    if (readOptionalString(settingsEnv.ANTHROPIC_AUTH_TOKEN)) {
      return { authenticated: true, email: 'Configured via settings.json', method: 'api_key' };
    }

    if (process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) {
      return { authenticated: true, email: 'OAuth Token (long-lived)', method: 'environment' };
    }

    if (readOptionalString(settingsEnv.CLAUDE_CODE_OAUTH_TOKEN)) {
      return { authenticated: true, email: 'OAuth Token (long-lived)', method: 'environment' };
    }

    const probe = await this.probeAuthStatus();

    if (!probe) {
      return {
        authenticated: false,
        email: null,
        method: null,
        error: 'Unable to determine Claude authentication status. Run claude /login again.',
      };
    }

    if (!probe.loggedIn) {
      return {
        authenticated: false,
        email: null,
        method: null,
        error: missingCredentialsError,
      };
    }

    return {
      authenticated: true,
      email: probe.email,
      method: 'cli_probe',
    };
  }
}
