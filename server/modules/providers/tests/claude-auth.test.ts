import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runClaudeAuthStatusProbe } from '@/modules/claude-profiles/index.js';
import { ClaudeProviderAuth } from '@/modules/providers/list/claude/claude-auth.provider.js';

// checkCredentials() is private, but unlike getStatus() it never shells out to the
// `claude` CLI — it only reads env vars and ~/.claude files. Calling it directly
// (TypeScript's `private` has no runtime effect) tests the priority order without
// depending on `claude` being installed in the test environment.
type CheckCredentialsResult = {
  authenticated: boolean;
  email: string | null;
  method: string | null;
  error?: string;
};

const checkCredentials = (auth: ClaudeProviderAuth): Promise<CheckCredentialsResult> =>
  (auth as unknown as { checkCredentials: () => Promise<CheckCredentialsResult> }).checkCredentials();

const ENV_KEYS = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const;

const withEnv = async (
  overrides: Partial<Record<(typeof ENV_KEYS)[number], string>>,
  fn: () => Promise<void>,
) => {
  const original: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
  for (const key of ENV_KEYS) {
    original[key] = process.env[key];
    const value = overrides[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    await fn();
  } finally {
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original[key];
      }
    }
  }
};

const withTempHome = async (fn: (homeDir: string) => Promise<void>) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'claude-auth-test-'));
  const originalHome = process.env.HOME;
  process.env.HOME = homeDir;
  try {
    await fn(homeDir);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await rm(homeDir, { recursive: true, force: true });
  }
};

const writeCredentialsFile = async (homeDir: string, body: unknown) => {
  const claudeDir = path.join(homeDir, '.claude');
  await mkdir(claudeDir, { recursive: true });
  await writeFile(path.join(claudeDir, '.credentials.json'), JSON.stringify(body));
};

const writeSettingsFile = async (homeDir: string, env: Record<string, string>) => {
  const claudeDir = path.join(homeDir, '.claude');
  await mkdir(claudeDir, { recursive: true });
  await writeFile(path.join(claudeDir, 'settings.json'), JSON.stringify({ env }));
};

test('checkCredentials: CLAUDE_CODE_OAUTH_TOKEN set is authenticated via environment, even with a stale credentials file', async () => {
  await withTempHome(async (homeDir) => {
    await writeCredentialsFile(homeDir, {
      claudeAiOauth: { accessToken: 'stale-token', expiresAt: 1_000_000_000_000 }, // long expired
    });

    await withEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'test-oauth-token' }, async () => {
      const status = await checkCredentials(new ClaudeProviderAuth());
      assert.equal(status.authenticated, true);
      assert.equal(status.method, 'environment');
    });
  });
});

test('checkCredentials: CLAUDE_CODE_OAUTH_TOKEN configured via settings.json env block is authenticated via environment', async () => {
  await withTempHome(async (homeDir) => {
    await writeSettingsFile(homeDir, { CLAUDE_CODE_OAUTH_TOKEN: 'test-oauth-token-from-settings' });
    await writeCredentialsFile(homeDir, {
      claudeAiOauth: { accessToken: 'stale-token', expiresAt: 1_000_000_000_000 }, // long expired
    });

    await withEnv({}, async () => {
      const status = await checkCredentials(new ClaudeProviderAuth());
      assert.equal(status.authenticated, true);
      assert.equal(status.method, 'environment');
    });
  });
});

// The old `.credentials.json` hand-parsing this replaced is gone entirely
// (CLOUDCLI_EXTENSION_PLAN.md §3): with no env vars set, checkCredentials()
// now falls through to `claude auth status`, injected here via the
// constructor so these tests never depend on the real CLI being installed.

test('checkCredentials: claude auth status loggedIn:true maps to authenticated with the real email, never a placeholder', async () => {
  await withTempHome(async () => {
    await withEnv({}, async () => {
      const auth = new ClaudeProviderAuth({
        probeAuthStatus: async () => ({
          loggedIn: true,
          authMethod: 'claude.ai',
          apiProvider: 'firstParty',
          email: 'someone@example.com',
          orgId: 'org_1',
          orgName: 'Acme',
          subscriptionType: 'pro',
        }),
      });
      const status = await checkCredentials(auth);
      assert.equal(status.authenticated, true);
      assert.equal(status.method, 'cli_probe');
      assert.equal(status.email, 'someone@example.com');
    });
  });
});

test('checkCredentials: claude auth status loggedIn:false reports not authenticated', async () => {
  await withTempHome(async () => {
    await withEnv({}, async () => {
      const auth = new ClaudeProviderAuth({
        probeAuthStatus: async () => ({
          loggedIn: false,
          authMethod: 'none',
          apiProvider: 'firstParty',
          email: null,
          orgId: null,
          orgName: null,
          subscriptionType: null,
        }),
      });
      const status = await checkCredentials(auth);
      assert.equal(status.authenticated, false);
      assert.equal(status.email, null);
    });
  });
});

test('checkCredentials: a claude auth status command failure (null probe) reports not authenticated, never a fake identity', async () => {
  await withTempHome(async () => {
    await withEnv({}, async () => {
      const auth = new ClaudeProviderAuth({ probeAuthStatus: async () => null });
      const status = await checkCredentials(auth);
      assert.equal(status.authenticated, false);
      assert.equal(status.email, null);
      assert.ok(status.error);
    });
  });
});

test('getStatus: authenticated with no email never substitutes a literal "Authenticated" identity', async () => {
  await withTempHome(async () => {
    await withEnv({}, async () => {
      // loggedIn:true with no email is a real (if unusual) probe outcome —
      // the bug this REPLACE fixes (CLOUDCLI_EXTENSION_PLAN.md §3) was
      // exactly this case rendering a confident but fake identity.
      const auth = new ClaudeProviderAuth({
        probeAuthStatus: async () => ({
          loggedIn: true,
          authMethod: 'claude.ai',
          apiProvider: 'firstParty',
          email: null,
          orgId: null,
          orgName: null,
          subscriptionType: null,
        }),
      });
      const status = await auth.getStatus();
      assert.equal(status.authenticated, true);
      assert.equal(status.email, null);
      assert.notEqual(status.email, 'Authenticated');
    });
  });
});

// Exercises the real, non-injected `runClaudeAuthStatusProbe` end to end
// (real subprocess spawn) against a tiny stand-in "claude" executable, so the
// spawn/env/JSON-parsing plumbing itself is covered, not just the mapping.

const FAKE_CLI_SCRIPT = `#!/bin/sh
if [ -n "$FAKE_CLAUDE_LOG_PATH" ]; then
  printf '%s' "$CLAUDE_CONFIG_DIR" > "$FAKE_CLAUDE_LOG_PATH"
fi
printf '%s' "$FAKE_CLAUDE_STDOUT"
exit "\${FAKE_CLAUDE_EXIT_CODE:-0}"
`;

const withFakeClaudeCli = async (fn: (cliPath: string, logPath: string) => Promise<void>) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fake-claude-cli-'));
  const cliPath = path.join(dir, 'claude');
  const logPath = path.join(dir, 'config-dir.log');
  await writeFile(cliPath, FAKE_CLI_SCRIPT, 'utf8');
  await chmod(cliPath, 0o755);

  const previousCliPath = process.env.CLAUDE_CLI_PATH;
  process.env.CLAUDE_CLI_PATH = cliPath;
  try {
    await fn(cliPath, logPath);
  } finally {
    if (previousCliPath === undefined) {
      delete process.env.CLAUDE_CLI_PATH;
    } else {
      process.env.CLAUDE_CLI_PATH = previousCliPath;
    }
    await rm(dir, { recursive: true, force: true });
  }
};

test('runClaudeAuthStatusProbe: valid JSON, loggedIn true parses every field', async () => {
  await withFakeClaudeCli(async (_cliPath, logPath) => {
    process.env.FAKE_CLAUDE_STDOUT = JSON.stringify({
      loggedIn: true,
      authMethod: 'claude.ai',
      apiProvider: 'firstParty',
      email: 'robin@example.com',
      orgId: 'org_42',
      orgName: 'Acme',
      subscriptionType: 'pro',
    });
    process.env.FAKE_CLAUDE_LOG_PATH = logPath;
    try {
      const result = await runClaudeAuthStatusProbe('/tmp/some-profile-dir');
      assert.deepEqual(result, {
        loggedIn: true,
        authMethod: 'claude.ai',
        apiProvider: 'firstParty',
        email: 'robin@example.com',
        orgId: 'org_42',
        orgName: 'Acme',
        subscriptionType: 'pro',
      });
      assert.equal(await readFile(logPath, 'utf8'), '/tmp/some-profile-dir');
    } finally {
      delete process.env.FAKE_CLAUDE_STDOUT;
      delete process.env.FAKE_CLAUDE_LOG_PATH;
    }
  });
});

test('runClaudeAuthStatusProbe: valid JSON, loggedIn false', async () => {
  await withFakeClaudeCli(async () => {
    process.env.FAKE_CLAUDE_STDOUT = JSON.stringify({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' });
    try {
      const result = await runClaudeAuthStatusProbe();
      assert.equal(result?.loggedIn, false);
    } finally {
      delete process.env.FAKE_CLAUDE_STDOUT;
    }
  });
});

test('runClaudeAuthStatusProbe: non-zero exit (command failure) resolves null, never a fabricated result', async () => {
  await withFakeClaudeCli(async () => {
    process.env.FAKE_CLAUDE_STDOUT = 'error: not logged in';
    process.env.FAKE_CLAUDE_EXIT_CODE = '1';
    try {
      const result = await runClaudeAuthStatusProbe();
      assert.equal(result, null);
    } finally {
      delete process.env.FAKE_CLAUDE_STDOUT;
      delete process.env.FAKE_CLAUDE_EXIT_CODE;
    }
  });
});

test('runClaudeAuthStatusProbe: malformed/invalid JSON resolves null', async () => {
  await withFakeClaudeCli(async () => {
    process.env.FAKE_CLAUDE_STDOUT = '{ not valid json';
    try {
      const result = await runClaudeAuthStatusProbe();
      assert.equal(result, null);
    } finally {
      delete process.env.FAKE_CLAUDE_STDOUT;
    }
  });
});

test('runClaudeAuthStatusProbe: JSON missing the required loggedIn field resolves null', async () => {
  await withFakeClaudeCli(async () => {
    process.env.FAKE_CLAUDE_STDOUT = JSON.stringify({ authMethod: 'none' });
    try {
      const result = await runClaudeAuthStatusProbe();
      assert.equal(result, null);
    } finally {
      delete process.env.FAKE_CLAUDE_STDOUT;
    }
  });
});

test('runClaudeAuthStatusProbe: omitting configDirectory runs without CLAUDE_CONFIG_DIR set (legacy default)', async () => {
  await withFakeClaudeCli(async (_cliPath, logPath) => {
    process.env.FAKE_CLAUDE_STDOUT = JSON.stringify({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' });
    process.env.FAKE_CLAUDE_LOG_PATH = logPath;
    try {
      await runClaudeAuthStatusProbe();
      assert.equal(await readFile(logPath, 'utf8'), '');
    } finally {
      delete process.env.FAKE_CLAUDE_STDOUT;
      delete process.env.FAKE_CLAUDE_LOG_PATH;
    }
  });
});

test('checkCredentials: ANTHROPIC_API_KEY takes precedence over CLAUDE_CODE_OAUTH_TOKEN', async () => {
  await withTempHome(async () => {
    await withEnv(
      { ANTHROPIC_API_KEY: 'test-api-key', CLAUDE_CODE_OAUTH_TOKEN: 'test-oauth-token' },
      async () => {
        const status = await checkCredentials(new ClaudeProviderAuth());
        assert.equal(status.authenticated, true);
        assert.equal(status.method, 'api_key');
      },
    );
  });
});
