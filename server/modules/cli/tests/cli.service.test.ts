import assert from 'node:assert/strict';
import test from 'node:test';

import type { CliEnvironment, CliOutput } from '@/shared/types.js';

import { createCliService } from '../cli.service.js';

function createHarness() {
  const logMessages: string[] = [];
  const errorMessages: string[] = [];
  const environment: CliEnvironment = {};
  const output: CliOutput = {
    log: (message = '') => logMessages.push(message),
    error: (message = '') => errorMessages.push(message),
  };
  let serverStarts = 0;
  let sandboxArguments: string[] = [];
  let runtimeArguments: string[] = [];
  const service = createCliService({
    applicationRoot: '/application',
    defaultDatabasePath: '/home/user/.cloudcli/auth.db',
    homeDirectory: '/home/user',
    packageMetadata: {
      version: '1.2.3',
      homepage: 'https://cloudcli.example',
      bugsUrl: 'https://cloudcli.example/issues',
    },
    environment,
    fileSystem: {
      pathExists: () => false,
      getFileStats: () => ({ size: 0, modifiedAt: new Date(0) }),
    },
    output,
    sandboxService: {
      execute: async (argumentsList) => {
        sandboxArguments = argumentsList;
        return 7;
      },
    },
    runtimeService: {
      execute: async (argumentsList) => {
        runtimeArguments = argumentsList;
        return 5;
      },
    },
    getLatestPackageVersion: async () => '1.2.3',
    updateGlobalPackage: () => undefined,
    startServer: async () => {
      serverStarts += 1;
    },
    startBrowserUseMcp: async () => undefined,
  });

  return {
    service,
    environment,
    logMessages,
    errorMessages,
    getServerStarts: () => serverStarts,
    getSandboxArguments: () => sandboxArguments,
    getRuntimeArguments: () => runtimeArguments,
  };
}

test('applies CLI options to the injected environment before starting the server', async () => {
  const harness = createHarness();

  const exitCode = await harness.service.run([
    '--port',
    '8080',
    '--database-path=/data/app.db',
  ]);

  assert.equal(exitCode, 0);
  assert.equal(harness.environment.SERVER_PORT, '8080');
  assert.equal(harness.environment.DATABASE_PATH, '/data/app.db');
  assert.equal(harness.getServerStarts(), 1);
});

test('passes only sandbox arguments to the injected sandbox service', async () => {
  const harness = createHarness();

  const exitCode = await harness.service.run(['sandbox', 'ls']);

  assert.equal(exitCode, 7);
  assert.deepEqual(harness.getSandboxArguments(), ['ls']);
});

test('returns a failure code for an unknown command without exiting the process', async () => {
  const harness = createHarness();

  const exitCode = await harness.service.run(['unknown']);

  assert.equal(exitCode, 1);
  assert.match(harness.errorMessages[0], /Unknown command: unknown/);
});

test('passes only runtime subcommand arguments to the injected runtime service', async () => {
  const harness = createHarness();

  const exitCode = await harness.service.run(['runtime', 'stop', '--json', '--timeout', '5000']);

  assert.equal(exitCode, 5);
  assert.deepEqual(harness.getRuntimeArguments(), ['stop', '--json', '--timeout', '5000']);
  assert.equal(harness.getServerStarts(), 0);
});

test('a runtime subcommand is never mistaken for a top-level command', async () => {
  const harness = createHarness();

  // "status" is also a top-level command; capturing the rest of the argv at
  // "runtime" is what keeps `cloudcli runtime status` out of showStatus().
  await harness.service.run(['runtime', 'status']);

  assert.deepEqual(harness.getRuntimeArguments(), ['status']);
  assert.equal(harness.logMessages.join('\n').includes('CloudCLI UI - Status'), false);
});
