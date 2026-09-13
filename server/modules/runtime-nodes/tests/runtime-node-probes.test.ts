import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  detectAndroidHost,
  HEADLESS_EVIDENCE_WINDOW_MS,
  probeLocalRuntimeCapabilities,
  proveDirectoryWritable,
} from '@/modules/runtime-nodes/runtime-node-probes.js';

type RecordedCall = { file: string; args: string[]; timeoutMs: number };

const NOW = Date.UTC(2026, 8, 13, 12);
const LOGGED_IN = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'robin@example.com', orgName: 'Private org' });

const baseDependencies = {
  resolveClaudeExecutable: () => 'claude-binary',
  checkWorkspaceRoot: async () => {},
  environment: {},
  platform: 'linux',
  arch: 'arm64',
  nodeVersion: '22.12.0',
  fileExists: async () => false,
  now: () => NOW,
};

const commandRunner = (answers: Record<string, string | Error>, calls: RecordedCall[] = []) => async (file: string, args: string[], timeoutMs: number) => {
  calls.push({ file, args, timeoutMs });
  const key = `${file} ${args.join(' ')}`;
  const answer = answers[key];
  if (answer instanceof Error) {
    throw answer;
  }
  if (answer === undefined) {
    throw Object.assign(new Error(`unexpected ${key}`), { code: 'ENOENT' });
  }
  return answer;
};

test('the Claude and git CLIs are proven only by actually running them, each with a bounded timeout', async () => {
  const calls: RecordedCall[] = [];
  const checkedRoots: string[] = [];

  const outcomes = await probeLocalRuntimeCapabilities({
    ...baseDependencies,
    runCommand: commandRunner({
      'git --version': 'git version 2.45.0\n',
      'claude-binary --version': '2.1.220 (Claude Code)\n',
      'claude-binary auth status': LOGGED_IN,
    }, calls),
    checkWorkspaceRoot: async (directory) => {
      checkedRoots.push(directory);
    },
    workspacesRoot: 'workspace-root',
  });

  assert.deepEqual(outcomes['claude-cli'], { outcome: 'proven', detail: '2.1.220 (Claude Code)\n' });
  assert.deepEqual(outcomes['git-cli'], { outcome: 'proven', detail: 'git version 2.45.0\n' });
  assert.deepEqual(outcomes['workspace-filesystem'], { outcome: 'proven', detail: 'readable and writable (access check)' });
  assert.deepEqual(checkedRoots, ['workspace-root']);
  assert.deepEqual(
    calls.map(({ file, args }) => `${file} ${args.join(' ')}`).sort(),
    ['claude-binary --version', 'claude-binary auth status', 'git --version'],
    'no model call, no prompt: only version and local login state',
  );
  assert.ok(calls.every((call) => call.timeoutMs > 0 && call.timeoutMs <= 10_000));
});

test('claude-auth reads the login state without ever keeping the account identity', async () => {
  const probe = (authAnswer: string | Error, environment: Record<string, string> = {}) => probeLocalRuntimeCapabilities({
    ...baseDependencies,
    environment,
    runCommand: commandRunner({ 'git --version': 'git', 'claude-binary --version': '2.1.220', 'claude-binary auth status': authAnswer }),
  }).then((outcomes) => outcomes['claude-auth']);

  const signedIn = await probe(LOGGED_IN);
  assert.deepEqual(signedIn, { outcome: 'proven', detail: 'signed in (claude.ai)' });
  assert.equal(JSON.stringify(signedIn).includes('robin'), false);

  assert.deepEqual(await probe(JSON.stringify({ loggedIn: false })), { outcome: 'failed', reason: 'not_logged_in' });
  // Some CLI versions answer with a non-zero exit; the JSON on stdout is still the answer.
  assert.deepEqual(
    await probe(Object.assign(new Error('exit 1'), { code: 1, stdout: JSON.stringify({ loggedIn: false }) })),
    { outcome: 'failed', reason: 'not_logged_in' },
  );
  assert.deepEqual(
    await probe(JSON.stringify({ loggedIn: false }), { ANTHROPIC_API_KEY: 'sk-ant-test' }),
    { outcome: 'not_probed', reason: 'credentials_from_environment' },
    'an environment credential is not visible to auth status, so it stays unknown',
  );
  assert.deepEqual(await probe('Usage: claude [options]'), { outcome: 'not_probed', reason: 'auth_status_unreadable' });
  assert.deepEqual(
    await probe(Object.assign(new Error('timed out'), { killed: true })),
    { outcome: 'not_probed', reason: 'auth_status_timeout' },
  );
});

test('a missing CLI, a timeout and an inaccessible workspace fail with machine reasons only', async () => {
  const outcomes = await probeLocalRuntimeCapabilities({
    ...baseDependencies,
    runCommand: async (file) => {
      if (file === 'git') {
        throw Object.assign(new Error('spawn git ENOENT at /secret/install/path'), { code: 'ENOENT' });
      }
      throw Object.assign(new Error('Command timed out in /secret/home'), { killed: true, signal: 'SIGTERM' });
    },
    checkWorkspaceRoot: async () => {
      throw new Error('EACCES: permission denied, access /secret/workspaces');
    },
  });

  assert.deepEqual(outcomes['claude-cli'], { outcome: 'failed', reason: 'probe_timeout' });
  assert.deepEqual(outcomes['git-cli'], { outcome: 'failed', reason: 'executable_not_found' });
  assert.deepEqual(outcomes['workspace-filesystem'], { outcome: 'failed', reason: 'workspace_root_inaccessible' });
  assert.equal(JSON.stringify(outcomes).includes('/secret'), false);
});

test('an unresolvable Claude executable is a failure, not an exception, and auth is then not probed', async () => {
  const outcomes = await probeLocalRuntimeCapabilities({
    ...baseDependencies,
    runCommand: async () => 'ok',
    resolveClaudeExecutable: () => {
      throw new Error('where.exe exploded');
    },
  });

  assert.deepEqual(outcomes['claude-cli'], { outcome: 'failed', reason: 'executable_not_resolved' });
  assert.deepEqual(outcomes['claude-auth'], { outcome: 'not_probed', reason: 'claude_executable_not_resolved' });
});

test('a JavaScript Claude entry point is launched through Node, like the SDK does', async () => {
  const calls: RecordedCall[] = [];
  await probeLocalRuntimeCapabilities({
    ...baseDependencies,
    runCommand: async (file, args, timeoutMs) => {
      calls.push({ file, args, timeoutMs });
      return 'ok';
    },
    resolveClaudeExecutable: () => 'claude-code/cli.mjs',
    nodeExecutablePath: 'node-binary',
  });

  assert.ok(calls.some((call) => call.file === 'node-binary' && call.args[0] === 'claude-code/cli.mjs' && call.args[1] === '--version'));
  assert.ok(calls.some((call) => call.file === 'node-binary' && call.args.join(' ') === 'claude-code/cli.mjs auth status'));
});

test('node-runtime states the process facts; an Android host is detected from evidence, and adds no capability', async () => {
  const run = commandRunner({ 'git --version': 'git', 'claude-binary --version': '2.1.220', 'claude-binary auth status': LOGGED_IN });
  const plain = await probeLocalRuntimeCapabilities({ ...baseDependencies, runCommand: run });
  assert.deepEqual(plain['node-runtime'], { outcome: 'proven', detail: 'Node 22.12.0 linux arm64' });

  const proot = await probeLocalRuntimeCapabilities({
    ...baseDependencies,
    runCommand: run,
    environment: { ANDROID_ROOT: '/system', ANDROID_DATA: '/data' },
  });
  assert.deepEqual(proot['node-runtime'], { outcome: 'proven', detail: 'Node 22.12.0 linux arm64 (Android host)' });
  assert.deepEqual(proot['background-execution'], plain['background-execution'], 'being on Android proves nothing about background execution');
  assert.deepEqual(proot['claude-headless'], plain['claude-headless']);

  assert.equal(await detectAndroidHost({ platform: 'android', environment: {}, fileExists: async () => false }), true);
  assert.equal(await detectAndroidHost({ platform: 'linux', environment: {}, fileExists: async (file) => file === '/system/build.prop' }), true);
  assert.equal(await detectAndroidHost({ platform: 'linux', environment: { ANDROID_ROOT: '/system' }, fileExists: async () => false }), false);
  assert.equal(await detectAndroidHost({ platform: 'win32', environment: { ANDROID_ROOT: 'x', ANDROID_DATA: 'y' }, fileExists: async () => true }), false);
});

test('headless execution is proven only by an observed completed run, and background execution is never inferred', async () => {
  const run = commandRunner({ 'git --version': 'git', 'claude-binary --version': '2.1.220', 'claude-binary auth status': LOGGED_IN });

  const controlPlane = await probeLocalRuntimeCapabilities({ ...baseDependencies, runCommand: run });
  assert.deepEqual(controlPlane['claude-headless'], { outcome: 'not_probed', reason: 'no_run_observer' });
  assert.deepEqual(controlPlane['background-execution'], { outcome: 'not_probed', reason: 'requires_device_verification' });

  const observe = (lastCompletedRunAt: number | null, lastSuspension: { at: number; durationMs: number } | null) => probeLocalRuntimeCapabilities({
    ...baseDependencies,
    runCommand: run,
    observations: { startedAt: NOW - 3 * 3_600_000, lastCompletedRunAt: () => lastCompletedRunAt, lastSuspension: () => lastSuspension },
  });

  const fresh = await observe(NOW - 2 * 3_600_000, null);
  assert.deepEqual(fresh['claude-headless'], { outcome: 'proven', detail: 'run completed 2h ago' });
  assert.deepEqual(fresh['background-execution'], { outcome: 'not_probed', reason: 'requires_device_verification', detail: 'no suspension observed in 3h' });

  assert.deepEqual((await observe(null, null))['claude-headless'], { outcome: 'not_probed', reason: 'awaiting_completed_run' });
  assert.equal((await observe(NOW - HEADLESS_EVIDENCE_WINDOW_MS - 1, null))['claude-headless'].outcome, 'not_probed');

  const suspended = await observe(NOW - 60_000, { at: NOW - 30 * 60_000, durationMs: 45_000 });
  assert.deepEqual(suspended['background-execution'], {
    outcome: 'failed',
    reason: 'process_suspension_observed',
    detail: 'suspended 45s about 30m ago',
  });
});

test('node agents prove the workspace root writable with a real, removed probe file', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'write-probe-'));
  try {
    await proveDirectoryWritable(directory);
    assert.deepEqual(await readdir(directory), [], 'the probe file never stays behind');

    const run = commandRunner({ 'git --version': 'git', 'claude-binary --version': '2.1.220', 'claude-binary auth status': LOGGED_IN });
    const proven = await probeLocalRuntimeCapabilities({ ...baseDependencies, runCommand: run, workspacesRoot: directory, proveWorkspaceWrite: proveDirectoryWritable });
    assert.deepEqual(proven['workspace-filesystem'], { outcome: 'proven', detail: 'readable and write verified' });

    const refused = await probeLocalRuntimeCapabilities({
      ...baseDependencies,
      runCommand: run,
      workspacesRoot: directory,
      proveWorkspaceWrite: async () => {
        throw Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' });
      },
    });
    assert.deepEqual(refused['workspace-filesystem'], { outcome: 'failed', reason: 'workspace_root_not_writable' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
