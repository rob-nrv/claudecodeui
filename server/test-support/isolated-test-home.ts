// Test-state isolation for the server test suite (FT-M09-R1).
//
// Loaded with `--import` by `npm test`: Node's test runner runs it once in
// EVERY child process, before the test file (and every module it imports) is
// evaluated. Each test file therefore gets its own throwaway home directory,
// so nothing it does can reach the developer's real state:
//
// - `os.homedir()` (HOME / USERPROFILE) → ~/.cloudcli/claude-profiles, ~/.claude,
//   ~/.cloudcli/assets, ~/.cloudcli/node-agent, WORKSPACES_ROOT defaults
// - DATABASE_PATH → never the real ~/.cloudcli/auth.db, never the legacy
//   in-repo database/auth.db
// - CLAUDE_CONFIG_DIR / CLOUDCLI_NODE_AGENT_HOME inherited from the shell are dropped
//
// Tests that set their own paths still do so on top of this. Production code is
// untouched: nothing here is imported outside the test command.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudcli-test-home-'));
fs.mkdirSync(path.join(isolatedHome, '.cloudcli'), { recursive: true });

process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;
process.env.DATABASE_PATH = path.join(isolatedHome, '.cloudcli', 'auth.db');
process.env.CLOUDCLI_TEST_ISOLATED_HOME = isolatedHome;
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CLOUDCLI_NODE_AGENT_HOME;
delete process.env.WORKSPACES_ROOT;

process.once('exit', () => {
  try {
    fs.rmSync(isolatedHome, { recursive: true, force: true });
  } catch {
    // An open SQLite handle can keep a file locked on Windows; the OS temp folder is cleaned eventually.
  }
});
