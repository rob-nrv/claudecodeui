// Composition root for the runtime module: the only file that touches real IO.
// Kept to Node built-ins on purpose — `cloudcli runtime status` runs on the CLI
// cold-start path, where pulling in the database or provider graph is a
// measurable cost (see the same note in cli.service.ts's showStatus).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { type RuntimeController, createRuntimeController } from './runtime-controller.service.js';
import { createLocalServerMarkerStore } from './runtime-marker.store.js';
import { createRuntimeProbe } from './runtime-probe.js';
import { type RuntimeRestartService, createRuntimeRestartService } from './runtime-restart.service.js';
import { type RuntimeStartService, createRuntimeStartService } from './runtime-start.service.js';

/** Short by design: a local health check that needs a second has already told us something. */
const DEFAULT_HEALTH_TIMEOUT_MS = 1_000;
const DEFAULT_SERVER_PORT = 3001;

/** Where to look when no marker exists yet — loopback, never the display host. */
export function resolveFallbackHealthUrl(port: number = DEFAULT_SERVER_PORT): string {
  return `http://127.0.0.1:${port}/health`;
}

function fetchHealthOverHttp(healthUrl: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = http.get(healthUrl, { timeout: timeoutMs }, (response) => {
      if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(new Error(`health responded ${response.statusCode}`));
        return;
      }

      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });

    request.on('timeout', () => request.destroy(new Error('health check timed out')));
    request.on('error', reject);
  });
}

/**
 * Reports whether a pid exists, using signal 0 — a permission probe that never
 * delivers a signal. EPERM means the process is there but owned by someone else,
 * which still answers the question being asked.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPERM';
  }
}

export function createLocalRuntimeController(options: {
  homeDirectory?: string;
  healthTimeoutMs?: number;
} = {}): RuntimeController {
  const markerStore = createLocalServerMarkerStore(options.homeDirectory ?? os.homedir());
  const healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;

  return createRuntimeController({
    probe: createRuntimeProbe({
      readMarker: () => markerStore.read(),
      fetchHealth: (healthUrl) => fetchHealthOverHttp(healthUrl, healthTimeoutMs),
      isProcessAlive,
    }),
    sendSignal: (pid, signal) => {
      process.kill(pid, signal);
    },
    wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    now: () => new Date(),
  });
}

/** The built server entrypoint, laid out as <appRoot>/dist-server/server/index.js. */
export function resolveServerEntryPath(appRoot: string): string {
  return path.join(appRoot, 'dist-server', 'server', 'index.js');
}

/**
 * Launches the server in its own process group (`detached`), with no inherited
 * stdio. That is what lets a replacement survive the process that asked for it —
 * the self-hosting case, where the caller is a descendant of the server being
 * replaced and would otherwise take the new server down with it via SIGHUP.
 */
export function createDetachedServerLauncher(options: {
  appRoot: string;
  nodePath?: string;
  environment?: NodeJS.ProcessEnv;
}): () => Promise<void> {
  return async () => {
    const serverEntry = resolveServerEntryPath(options.appRoot);
    if (!fs.existsSync(serverEntry)) {
      throw new Error(`CloudCLI has not been built yet (${serverEntry} is missing). Run "npm run build" first.`);
    }

    const child = spawn(options.nodePath ?? process.execPath, [serverEntry], {
      cwd: options.appRoot,
      detached: true,
      stdio: 'ignore',
      env: options.environment ?? process.env,
    });

    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => {
        // Drop the parent's reference so this process can exit while the server runs.
        child.unref();
        resolve();
      });
      child.once('error', reject);
    });
  };
}

export function createLocalRuntimeRestartService(options: {
  controller: RuntimeController;
  appRoot: string;
  nodePath?: string;
  environment?: NodeJS.ProcessEnv;
}): RuntimeRestartService {
  return createRuntimeRestartService({
    controller: options.controller,
    launch: createDetachedServerLauncher(options),
    wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    now: () => new Date(),
  });
}

export function createLocalRuntimeStartService(options: {
  controller: RuntimeController;
  appRoot: string;
  nodePath?: string;
  environment?: NodeJS.ProcessEnv;
}): RuntimeStartService {
  return createRuntimeStartService({
    controller: options.controller,
    launch: createDetachedServerLauncher(options),
    wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    now: () => new Date(),
  });
}
