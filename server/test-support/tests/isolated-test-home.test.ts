// Guard for test-state isolation (FT-M09-R1). Test processes run against a
// SENTINEL home — a temporary folder standing in for a developer's real home,
// with a `.cloudcli/auth.db`, a `claude-profiles` folder and a `.claude`
// folder — and must leave it byte-for-byte unchanged.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TSX_CLI = path.join(repositoryRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const ISOLATION_IMPORT = './server/test-support/isolated-test-home.ts';

/** Suites that wrote into the real home before isolation existed, plus the FT-M09 database suites. */
const FORMERLY_POLLUTING_SUITES = [
  'server/modules/claude-profiles/tests/claude-profiles.service.test.ts',
  'server/modules/claude-profiles/tests/claude-profiles.routes.test.ts',
  'server/modules/runtime-nodes/tests/runtime-nodes.portable-workspace.test.ts',
  'server/modules/database/tests/runtime-node-workspaces.migration.test.ts',
];

async function createSentinelHome(): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-sentinel-home-'));
  await fs.mkdir(path.join(home, '.cloudcli', 'claude-profiles'), { recursive: true });
  await fs.mkdir(path.join(home, '.claude'), { recursive: true });
  await fs.writeFile(path.join(home, '.cloudcli', 'auth.db'), '');
  await fs.writeFile(path.join(home, '.claude', 'settings.json'), '{"sentinel":true}\n');
  const past = new Date(Date.now() - 3_600_000);
  await fs.utimes(path.join(home, '.cloudcli', 'auth.db'), past, past);
  await fs.utimes(path.join(home, '.claude', 'settings.json'), past, past);
  return home;
}

async function snapshot(root: string): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};
  const visit = async (directory: string) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      const relative = path.relative(root, full).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        entries[`${relative}/`] = 'dir';
        await visit(full);
      } else {
        const stats = await fs.stat(full);
        entries[relative] = `${stats.size}:${stats.mtimeMs}:${createHash('sha256').update(await fs.readFile(full)).digest('hex')}`;
      }
    }
  };
  await visit(root);
  return entries;
}

function runTestProcess(files: string[], options: { home: string; isolate: boolean }): Promise<{ code: number | null; output: string }> {
  const environment: Record<string, string | undefined> = { ...process.env, HOME: options.home, USERPROFILE: options.home };
  delete environment.DATABASE_PATH;
  delete environment.CLOUDCLI_TEST_ISOLATED_HOME;
  delete environment.CLOUDCLI_NODE_AGENT_HOME;
  delete environment.CLAUDE_CONFIG_DIR;
  delete environment.NODE_TEST_CONTEXT;
  const args = [TSX_CLI, '--tsconfig', 'server/tsconfig.json'];
  if (options.isolate) {
    args.push('--import', ISOLATION_IMPORT);
  }
  args.push('--test', '--experimental-test-module-mocks', ...files);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: repositoryRoot, env: environment, windowsHide: true });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('exit', (code) => resolve({ code, output }));
  });
}

test('npm test loads the isolation import into every server test process', async () => {
  const packageJson = JSON.parse(await fs.readFile(path.join(repositoryRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  assert.ok(packageJson.scripts.test.includes(`--import ${ISOLATION_IMPORT}`), 'the test script must keep the isolation import');
  if (process.env.CLOUDCLI_TEST_ISOLATED_HOME) {
    assert.equal(os.homedir(), process.env.CLOUDCLI_TEST_ISOLATED_HOME);
    assert.ok(process.env.DATABASE_PATH?.startsWith(process.env.CLOUDCLI_TEST_ISOLATED_HOME));
  }
});

test('the sentinel detects a home write without isolation, and isolation contains the same write', { timeout: 120_000 }, async () => {
  const probeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-isolation-probe-'));
  const probeTest = path.join(probeDirectory, 'writes-home.test.mjs');
  await fs.writeFile(probeTest, [
    "import fs from 'node:fs';",
    "import os from 'node:os';",
    "import path from 'node:path';",
    "import test from 'node:test';",
    "test('writes where a careless test would', () => {",
    "  fs.mkdirSync(path.join(os.homedir(), '.cloudcli', 'claude-profiles', 'probe'), { recursive: true });",
    "  fs.appendFileSync(process.env.DATABASE_PATH ?? path.join(os.homedir(), '.cloudcli', 'auth.db'), 'x');",
    '});',
    '',
  ].join('\n'));
  const unprotected = await createSentinelHome();
  const protectedHome = await createSentinelHome();
  try {
    const before = await snapshot(unprotected);
    assert.equal((await runTestProcess([probeTest], { home: unprotected, isolate: false })).code, 0);
    assert.notDeepEqual(await snapshot(unprotected), before, 'the detector sees a real home write');

    const protectedBefore = await snapshot(protectedHome);
    assert.equal((await runTestProcess([probeTest], { home: protectedHome, isolate: true })).code, 0);
    assert.deepEqual(await snapshot(protectedHome), protectedBefore);
  } finally {
    await Promise.all([unprotected, protectedHome, probeDirectory].map((directory) => fs.rm(directory, { recursive: true, force: true })));
  }
});

test('suites that used to write profiles into the real home leave a sentinel home untouched', { timeout: 300_000 }, async () => {
  const home = await createSentinelHome();
  try {
    const before = await snapshot(home);
    const result = await runTestProcess(FORMERLY_POLLUTING_SUITES, { home, isolate: true });
    assert.equal(result.code, 0, result.output.slice(-2_000));
    assert.deepEqual(await snapshot(home), before);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
