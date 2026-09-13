import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CLAUDE_LIVE_USAGE_SNAPSHOT_FILE_NAME,
  CLAUDE_STATUSLINE_BRIDGE_SCRIPT,
  buildStatusLineBridgeCommand,
  inspectStatusLineBridge,
  parseStatusLineBridgeCommand,
  planStatusLineBridgeInstall,
  planStatusLineBridgeRemoval,
} from '@/modules/claude-profiles/claude-statusline-bridge.js';

const buildPosixCommand = (wrappedCommand: string | null): string =>
  buildStatusLineBridgeCommand({
    platform: 'linux',
    nodeExecutablePath: '/usr/local/bin/node',
    scriptPath: '/home/me/.cloudcli/bin/claude-statusline-bridge.mjs',
    wrappedCommand,
  });

type StatusLineValue = { type: string; command: string; [key: string]: unknown };

const statusLineOf = (settings: Record<string, unknown>): StatusLineValue => settings.statusLine as StatusLineValue;

// ----------------- command construction -----------------

test('the bridge command round-trips any wrapped command, shell metacharacters included', () => {
  const tricky = 'input=$(cat); echo "$input" | jq -r \'.rate_limits.five_hour.used_percentage // empty\' && printf "%s\\n" `date`';
  const command = buildPosixCommand(tricky);

  assert.match(
    command,
    /^"\/usr\/local\/bin\/node" "\/home\/me\/\.cloudcli\/bin\/claude-statusline-bridge\.mjs" --cloudcli-statusline-bridge=1 --wrap=[A-Za-z0-9_-]+$/,
  );
  assert.deepEqual(parseStatusLineBridgeCommand(command), { version: 1, wrappedCommand: tricky, wrapReadable: true });
  assert.deepEqual(parseStatusLineBridgeCommand(buildPosixCommand(null)), { version: 1, wrappedCommand: null, wrapReadable: true });
});

test('on Windows the bridge runs node from PATH with a forward-slash script path (Git Bash and PowerShell safe)', () => {
  const command = buildStatusLineBridgeCommand({
    platform: 'win32',
    nodeExecutablePath: 'C:\\Program Files\\nodejs\\node.exe',
    scriptPath: 'C:\\Users\\Jane Doe\\.cloudcli\\bin\\claude-statusline-bridge.mjs',
    wrappedCommand: null,
  });
  assert.equal(command, 'node "C:/Users/Jane Doe/.cloudcli/bin/claude-statusline-bridge.mjs" --cloudcli-statusline-bridge=1');
});

test('paths that cannot be quoted safely are refused instead of producing an injectable command', () => {
  for (const scriptPath of ['/home/$(whoami)/bridge.mjs', '/home/me"; rm -rf ~; "/bridge.mjs', '/home/`id`/bridge.mjs']) {
    assert.throws(
      () => buildStatusLineBridgeCommand({ platform: 'linux', nodeExecutablePath: '/usr/bin/node', scriptPath, wrappedCommand: null }),
      { code: 'LIVE_USAGE_COMMAND_UNSAFE' },
    );
  }
});

test('a user command is never mistaken for the bridge', () => {
  assert.equal(parseStatusLineBridgeCommand('~/.claude/statusline.sh'), null);
  assert.equal(parseStatusLineBridgeCommand('node claude-statusline-bridge.mjs'), null);
});

// ----------------- settings composition -----------------

test('installing without a statusLine adds only the bridge and keeps every other setting untouched', () => {
  const settings = { model: 'opus', env: { SOME_TOKEN: 'secret-value' }, permissions: { allow: ['Bash(git:*)'] } };
  const next = planStatusLineBridgeInstall(settings, buildPosixCommand);
  const { statusLine, ...rest } = next;

  assert.deepEqual(rest, settings);
  assert.equal((statusLine as StatusLineValue).type, 'command');
  assert.equal(parseStatusLineBridgeCommand((statusLine as StatusLineValue).command)?.wrappedCommand, null);
  assert.equal('statusLine' in settings, false, 'the input settings object is not mutated');
  assert.deepEqual(inspectStatusLineBridge(next), { installedVersion: 1, wrapsExistingStatusLine: false, hasUserStatusLine: false });
});

test('installing over a user statusLine wraps it and keeps its fields; removal restores it exactly', () => {
  const original = { type: 'command', command: '~/.claude/statusline.sh', padding: 2, refreshInterval: 5, hideVimModeIndicator: true };
  const settings = { theme: 'dark', statusLine: original, cleanupPeriodDays: 30 };

  assert.deepEqual(inspectStatusLineBridge(settings), { installedVersion: null, wrapsExistingStatusLine: false, hasUserStatusLine: true });

  const installed = planStatusLineBridgeInstall(settings, buildPosixCommand);
  const installedStatusLine = statusLineOf(installed);
  assert.equal(installedStatusLine.padding, 2);
  assert.equal(installedStatusLine.refreshInterval, 5);
  assert.equal(installedStatusLine.hideVimModeIndicator, true);
  assert.equal(parseStatusLineBridgeCommand(installedStatusLine.command)?.wrappedCommand, original.command);
  assert.deepEqual(inspectStatusLineBridge(installed), { installedVersion: 1, wrapsExistingStatusLine: true, hasUserStatusLine: false });

  assert.deepEqual(planStatusLineBridgeRemoval(installed), settings);
});

test('re-installing over the bridge never wraps the bridge inside itself', () => {
  const settings = { statusLine: { type: 'command', command: 'my-status-script' } };
  const once = planStatusLineBridgeInstall(settings, buildPosixCommand);
  const twice = planStatusLineBridgeInstall(once, buildPosixCommand);

  assert.deepEqual(twice, once);
  assert.deepEqual(planStatusLineBridgeRemoval(twice), settings);
});

test('removal deletes only a bridge that wrapped nothing, and never touches a user statusLine', () => {
  const settings = { model: 'opus' };
  assert.deepEqual(planStatusLineBridgeRemoval(planStatusLineBridgeInstall(settings, buildPosixCommand)), settings);
  assert.equal(planStatusLineBridgeRemoval({ statusLine: { type: 'command', command: 'mine' } }), null);
  assert.equal(planStatusLineBridgeRemoval({}), null);
});

test('an unrecognized statusLine or an unreadable wrapped command is refused, never overwritten', () => {
  assert.throws(() => planStatusLineBridgeInstall({ statusLine: 'oops' }, buildPosixCommand), { code: 'LIVE_USAGE_STATUSLINE_UNRECOGNIZED' });
  assert.throws(
    () => planStatusLineBridgeInstall({ statusLine: { type: 'text', value: 'x' } }, buildPosixCommand),
    { code: 'LIVE_USAGE_STATUSLINE_UNRECOGNIZED' },
  );

  const corrupted = {
    statusLine: {
      type: 'command',
      command: '"/usr/bin/node" "/x/claude-statusline-bridge.mjs" --cloudcli-statusline-bridge=1 --wrap=!!!not-base64!!!',
    },
  };
  assert.throws(() => planStatusLineBridgeRemoval(corrupted), { code: 'LIVE_USAGE_BRIDGE_WRAP_UNREADABLE' });
  assert.throws(() => planStatusLineBridgeInstall(corrupted, buildPosixCommand), { code: 'LIVE_USAGE_BRIDGE_WRAP_UNREADABLE' });
});

// ----------------- the real bridge script -----------------

async function withBridgeScript(runTest: (context: { directory: string; scriptPath: string }) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'statusline-bridge-'));
  const scriptPath = path.join(directory, 'claude-statusline-bridge.mjs');
  await writeFile(scriptPath, CLAUDE_STATUSLINE_BRIDGE_SCRIPT);
  try {
    await runTest({ directory, scriptPath });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function runBridge(
  scriptPath: string,
  input: string,
  options: { configDirectory: string; wrappedCommand?: string },
): Promise<{ stdout: string; code: number | null }> {
  const args = [scriptPath, '--cloudcli-statusline-bridge=1'];
  if (options.wrappedCommand !== undefined) {
    // Uses the production encoder so the test exercises the real command format.
    args.push(buildPosixCommand(options.wrappedCommand).split(' ').pop() as string);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      env: { ...process.env, CLAUDE_CONFIG_DIR: options.configDirectory },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, code }));
    child.stdin.end(input);
  });
}

const statusLinePayload = (rateLimits?: unknown): string =>
  JSON.stringify({
    session_id: 'session-abc',
    model: { display_name: 'Opus' },
    ...(rateLimits === undefined ? {} : { rate_limits: rateLimits }),
  });

async function readSnapshotFile(configDirectory: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path.join(configDirectory, CLAUDE_LIVE_USAGE_SNAPSHOT_FILE_NAME), 'utf8'));
  } catch {
    return null;
  }
}

test('REAL bridge: records both windows into the config directory that produced them, and Work/Personal never mix', async () => {
  await withBridgeScript(async ({ directory, scriptPath }) => {
    const work = path.join(directory, 'work');
    const personal = path.join(directory, 'personal');
    await mkdir(work);
    await mkdir(personal);
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;

    const workRun = await runBridge(
      scriptPath,
      statusLinePayload({
        five_hour: { used_percentage: 23.5, resets_at: resetsAt },
        seven_day: { used_percentage: 41.2, resets_at: resetsAt + 86_400 },
      }),
      { configDirectory: work },
    );
    await runBridge(scriptPath, statusLinePayload({ five_hour: { used_percentage: 80, resets_at: resetsAt } }), { configDirectory: personal });

    assert.equal(workRun.code, 0);
    assert.equal(workRun.stdout.trim(), '5h 24% | 7d 41%');

    const workSnapshot = await readSnapshotFile(work);
    const personalSnapshot = await readSnapshotFile(personal);
    assert.equal(workSnapshot?.configDirectory, path.resolve(work));
    assert.deepEqual(workSnapshot?.rateLimits, {
      five_hour: { used_percentage: 23.5, resets_at: resetsAt },
      seven_day: { used_percentage: 41.2, resets_at: resetsAt + 86_400 },
    });
    assert.equal(personalSnapshot?.configDirectory, path.resolve(personal));
    assert.deepEqual(personalSnapshot?.rateLimits, { five_hour: { used_percentage: 80, resets_at: resetsAt } });
    // Only the two windows are kept: no session id, model or any other payload field.
    assert.deepEqual(Object.keys(workSnapshot ?? {}).sort(), ['capturedAt', 'configDirectory', 'rateLimits', 'schemaVersion', 'source']);
  });
});

test('REAL bridge: an update without rate_limits, with invalid windows or invalid JSON invents nothing', async () => {
  await withBridgeScript(async ({ directory, scriptPath }) => {
    const empty = path.join(directory, 'empty');
    const known = path.join(directory, 'known');
    await mkdir(empty);
    await mkdir(known);

    for (const input of [statusLinePayload(), statusLinePayload({ five_hour: { used_percentage: 'high' } }), 'not json']) {
      const run = await runBridge(scriptPath, input, { configDirectory: empty });
      assert.equal(run.code, 0);
      assert.equal(run.stdout, '');
    }
    assert.equal(await readSnapshotFile(empty), null, 'no snapshot is fabricated from missing data');

    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    await runBridge(scriptPath, statusLinePayload({ five_hour: { used_percentage: 12, resets_at: resetsAt } }), { configDirectory: known });
    const recorded = await readSnapshotFile(known);
    await runBridge(scriptPath, statusLinePayload(), { configDirectory: known });
    await runBridge(scriptPath, 'not json', { configDirectory: known });
    assert.deepEqual(await readSnapshotFile(known), recorded, 'an update that observed nothing leaves the last observation alone');
  });
});

test('REAL bridge: a wrapped user command receives the same stdin, and its output and exit code pass through', async () => {
  await withBridgeScript(async ({ directory, scriptPath }) => {
    const work = path.join(directory, 'work');
    await mkdir(work);
    const payload = statusLinePayload({ seven_day: { used_percentage: 5, resets_at: Math.floor(Date.now() / 1000) + 86_400 } });

    const echoed = await runBridge(scriptPath, payload, {
      configDirectory: work,
      wrappedCommand: 'node -e "process.stdin.pipe(process.stdout)"',
    });
    assert.equal(echoed.code, 0);
    assert.equal(echoed.stdout, payload);
    assert.notEqual(await readSnapshotFile(work), null, 'capture still happens when a user command is wrapped');

    const failing = await runBridge(scriptPath, payload, { configDirectory: work, wrappedCommand: 'exit 3' });
    assert.equal(failing.code, 3);
  });
});
