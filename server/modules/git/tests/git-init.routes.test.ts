import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import express from 'express';

import { createGitRouter } from '@/modules/git/git.routes.js';

test('git init does not run when repository validation fails for an execution error', async () => {
  const commands: string[][] = [];
  const spawnProcess = ((_command: string, args: string[]) => {
    commands.push(args);
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(() => child.emit('error', Object.assign(new Error('permission denied'), {
      code: 'EACCES',
    })));
    return child;
  }) as Parameters<typeof createGitRouter>[0]['spawnProcess'];
  const unexpectedProvider = async (): Promise<never> => { throw new Error('unexpected provider call'); };
  const router = createGitRouter({
    fileSystem: { access: async () => undefined } as unknown as Parameters<typeof createGitRouter>[0]['fileSystem'],
    spawnProcess,
    resolveProjectPathById: () => '/workspace/repo',
    queryClaude: unexpectedProvider,
    queryCursor: unexpectedProvider,
  });
  const app = express();
  app.use(express.json());
  app.use('/api/git', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/git/init`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'project-1' }),
    });
    const body = await response.json() as { success: boolean; error: string };
    assert.equal(body.success, false);
    assert.match(body.error, /permission denied/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  assert.deepEqual(commands, [['rev-parse', '--is-inside-work-tree']]);
});

test('delete branch parses force and uses Git force deletion', async () => {
  const commands: string[][] = [];
  const spawnProcess = ((_command: string, args: string[]) => {
    commands.push(args);
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(() => {
      if (args.includes('--is-inside-work-tree')) child.stdout.write('true\n');
      if (args.includes('--show-toplevel')) child.stdout.write('/workspace/repo\n');
      if (args.includes('--show-current')) child.stdout.write('main\n');
      if (args.includes('-D')) child.stdout.write('Deleted branch feature/unmerged.\n');
      child.stdout.end();
      child.stderr.end();
      child.emit('close', 0);
    });
    return child;
  }) as Parameters<typeof createGitRouter>[0]['spawnProcess'];
  const unexpectedProvider = async (): Promise<never> => { throw new Error('unexpected provider call'); };
  const router = createGitRouter({
    fileSystem: { access: async () => undefined } as unknown as Parameters<typeof createGitRouter>[0]['fileSystem'],
    spawnProcess,
    resolveProjectPathById: () => '/workspace/repo',
    queryClaude: unexpectedProvider,
    queryCursor: unexpectedProvider,
  });
  const app = express();
  app.use(express.json());
  app.use('/api/git', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/git/delete-branch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'project-1', branch: 'feature/unmerged', force: true }),
    });
    const body = await response.json() as { success: boolean; output: string };
    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.match(body.output, /Deleted branch/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  assert.deepEqual(commands.at(-1), ['branch', '-D', '--', 'feature/unmerged']);
});

test('delete branch rejects a non-boolean force value before running Git', async () => {
  const spawnProcess = (() => {
    throw new Error('Git must not run for invalid input');
  }) as Parameters<typeof createGitRouter>[0]['spawnProcess'];
  const unexpectedProvider = async (): Promise<never> => { throw new Error('unexpected provider call'); };
  const router = createGitRouter({
    fileSystem: { access: async () => undefined } as unknown as Parameters<typeof createGitRouter>[0]['fileSystem'],
    spawnProcess,
    resolveProjectPathById: () => '/workspace/repo',
    queryClaude: unexpectedProvider,
    queryCursor: unexpectedProvider,
  });
  const app = express();
  app.use(express.json());
  app.use('/api/git', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/git/delete-branch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'project-1', branch: 'feature/unmerged', force: 'yes' }),
    });
    const body = await response.json() as { error: string };
    assert.equal(response.status, 400);
    assert.equal(body.error, 'force must be a boolean');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('generate-commit-message runs Claude text-only, never with a permission-bypass mode', async () => {
  // The diff is assembled by this route itself and handed to Claude as plain text,
  // so it never needs tool access — see claude-runtime.provider.js's `textOnly` option.
  const spawnProcess = ((_command: string, args: string[]) => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(() => {
      if (args.includes('--is-inside-work-tree')) child.stdout.write('true\n');
      else if (args.includes('--show-toplevel')) child.stdout.write('/workspace/repo\n');
      else if (args[0] === 'status') child.stdout.write(' M file.ts\n');
      else if (args[0] === 'diff') child.stdout.write('@@ -1 +1 @@\n-old\n+new\n');
      child.stdout.end();
      child.stderr.end();
      child.emit('close', 0);
    });
    return child;
  }) as Parameters<typeof createGitRouter>[0]['spawnProcess'];

  let capturedOptions: Record<string, unknown> | undefined;
  const queryClaude = (async (
    _command: string,
    options: Record<string, unknown>,
    writer: { send: (data: unknown) => void },
  ) => {
    capturedOptions = options;
    writer.send({ type: 'text', text: 'fix: example commit message' });
  }) as Parameters<typeof createGitRouter>[0]['queryClaude'];
  const unexpectedProvider = async (): Promise<never> => { throw new Error('unexpected provider call'); };

  const router = createGitRouter({
    fileSystem: { access: async () => undefined } as unknown as Parameters<typeof createGitRouter>[0]['fileSystem'],
    spawnProcess,
    resolveProjectPathById: () => '/workspace/repo',
    queryClaude,
    queryCursor: unexpectedProvider,
  });
  const app = express();
  app.use(express.json());
  app.use('/api/git', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  let body: { message: string };
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/git/generate-commit-message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'project-1', files: ['file.ts'] }),
    });
    body = await response.json() as { message: string };
    assert.equal(response.status, 200);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  assert.equal(body!.message, 'fix: example commit message');
  assert.equal(capturedOptions?.textOnly, true);
  assert.equal(capturedOptions?.permissionMode, undefined);
});
