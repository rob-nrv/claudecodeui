#!/usr/bin/env node
// CloudCLI Hosted Relay entrypoint (FT-M11). Environment first, as in index.ts.
import './load-env.js';
import './relay-role.js';
import fs from 'fs';
import path from 'path';

import { createHostedRelay } from '@/modules/hosted-relay/index.js';
import { readCorrespondingSourceUrl } from '@/modules/hosted-relay/hosted-relay-csp.js';
import { findApplicationRoot, getModuleDirectory, IS_PLATFORM } from '@/shared/utils.js';

import { resolveBindHost } from '../shared/networkHosts.js';

const APP_ROOT = findApplicationRoot(getModuleDirectory(import.meta.url));
const RUNNING_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version || null;
  } catch {
    return null;
  }
})();

const relay = createHostedRelay({
  env: process.env,
  appRoot: APP_ROOT,
  runningVersion: RUNNING_VERSION,
  host: resolveBindHost(process.env.HOST),
  port: Number.parseInt(process.env.SERVER_PORT || '3001', 10),
  isPlatform: IS_PLATFORM,
});

try {
  const { port, gateway } = await relay.start();
  console.log(`[Relay] CloudCLI Hosted Relay ready on 127.0.0.1:${port} (loopback only). It never runs sessions itself.`);
  if (!readCorrespondingSourceUrl(process.env)) {
    console.warn('[Relay] CLOUDCLI_SOURCE_URL is unset or not https: /source offers no Corresponding Source (AGPL-3.0 §13). Set it before any public exposure.');
  }
  if (gateway.state === 'listening') {
    console.log(`[Relay] Remote gateway (${gateway.mode}): ${gateway.publicOrigin} on ${gateway.bindHost}:${gateway.port}`);
  } else {
    console.warn(`[Relay] Remote gateway ${gateway.state}${gateway.error ? `: ${gateway.error}` : ''}. Browsers and nodes cannot reach this relay remotely.`);
  }
} catch (error) {
  console.error('[Relay] Not started:', error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const shutdown = () => {
  void relay.close().finally(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
