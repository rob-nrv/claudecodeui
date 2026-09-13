import assert from 'node:assert/strict';
import test from 'node:test';

import { probeLocalRuntimeCapabilities } from '@/modules/runtime-nodes/runtime-node-probes.js';

type RecordedCall = { file: string; args: string[]; timeoutMs: number };

test('the Claude and git CLIs are proven only by actually running them, each with a bounded timeout', async () => {
  const calls: RecordedCall[] = [];
  const checkedRoots: string[] = [];

  const outcomes = await probeLocalRuntimeCapabilities({
    runCommand: async (file, args, timeoutMs) => {
      calls.push({ file, args, timeoutMs });
      return file === 'git' ? 'git version 2.45.0\n' : '2.1.220 (Claude Code)\n';
    },
    resolveClaudeExecutable: () => 'claude-binary',
    checkWorkspaceRoot: async (directory) => {
      checkedRoots.push(directory);
    },
    workspacesRoot: 'workspace-root',
  });

  assert.deepEqual(outcomes['claude-cli'], { outcome: 'proven', detail: '2.1.220 (Claude Code)\n' });
  assert.deepEqual(outcomes['git-cli'], { outcome: 'proven', detail: 'git version 2.45.0\n' });
  assert.deepEqual(outcomes['workspace-filesystem'], { outcome: 'proven' });
  assert.deepEqual(checkedRoots, ['workspace-root']);
  assert.deepEqual(
    calls.map(({ file, args }) => ({ file, args })).sort((a, b) => a.file.localeCompare(b.file)),
    [
      { file: 'claude-binary', args: ['--version'] },
      { file: 'git', args: ['--version'] },
    ],
  );
  assert.ok(calls.every((call) => call.timeoutMs > 0 && call.timeoutMs <= 10_000));
});

test('a missing CLI, a timeout and an inaccessible workspace fail with machine reasons only', async () => {
  const outcomes = await probeLocalRuntimeCapabilities({
    runCommand: async (file) => {
      if (file === 'git') {
        throw Object.assign(new Error('spawn git ENOENT at /secret/install/path'), { code: 'ENOENT' });
      }
      throw Object.assign(new Error('Command timed out in /secret/home'), { killed: true, signal: 'SIGTERM' });
    },
    resolveClaudeExecutable: () => 'claude-binary',
    checkWorkspaceRoot: async () => {
      throw new Error('EACCES: permission denied, access /secret/workspaces');
    },
  });

  assert.deepEqual(outcomes['claude-cli'], { outcome: 'failed', reason: 'probe_timeout' });
  assert.deepEqual(outcomes['git-cli'], { outcome: 'failed', reason: 'executable_not_found' });
  assert.deepEqual(outcomes['workspace-filesystem'], { outcome: 'failed', reason: 'workspace_root_inaccessible' });
  assert.equal(JSON.stringify(outcomes).includes('/secret'), false);
});

test('an unresolvable Claude executable is a failure, not an exception', async () => {
  const outcomes = await probeLocalRuntimeCapabilities({
    runCommand: async () => 'ok',
    resolveClaudeExecutable: () => {
      throw new Error('where.exe exploded');
    },
    checkWorkspaceRoot: async () => {},
  });

  assert.deepEqual(outcomes['claude-cli'], { outcome: 'failed', reason: 'executable_not_resolved' });
});

test('a JavaScript Claude entry point is launched through Node, like the SDK does', async () => {
  const calls: RecordedCall[] = [];
  await probeLocalRuntimeCapabilities({
    runCommand: async (file, args, timeoutMs) => {
      calls.push({ file, args, timeoutMs });
      return 'ok';
    },
    resolveClaudeExecutable: () => 'claude-code/cli.mjs',
    nodeExecutablePath: 'node-binary',
    checkWorkspaceRoot: async () => {},
  });

  assert.ok(calls.some((call) => call.file === 'node-binary' && call.args[0] === 'claude-code/cli.mjs' && call.args[1] === '--version'));
});

test('background execution is never inferred: it stays not probed on every machine', async () => {
  const outcomes = await probeLocalRuntimeCapabilities({
    runCommand: async () => 'ok',
    resolveClaudeExecutable: () => 'claude-binary',
    checkWorkspaceRoot: async () => {},
  });

  assert.deepEqual(outcomes['background-execution'], { outcome: 'not_probed', reason: 'no_probe_available' });
});
