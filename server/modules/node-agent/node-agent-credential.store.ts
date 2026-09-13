import fs from 'node:fs/promises';
import path from 'node:path';

import { RUNTIME_NODE_LINK_PATH } from '@/shared/utils.js';

/** What a node keeps after enrolling. The private key never leaves this file or this machine. */
export type NodeAgentCredential = {
  version: 1;
  serverOrigin: string;
  nodeId: string;
  privateKeyPem: string;
  publicKeyPem: string;
  enrolledAt: string;
};

const CREDENTIAL_FILE_NAME = 'credential.json';
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** Agent state directory: explicit flag, then CLOUDCLI_NODE_AGENT_HOME, then ~/.cloudcli/node-agent. */
export function resolveNodeAgentHome(options: { stateDir?: string; env: Record<string, string | undefined>; homeDirectory: string }): string {
  return path.resolve(options.stateDir || options.env.CLOUDCLI_NODE_AGENT_HOME || path.join(options.homeDirectory, '.cloudcli', 'node-agent'));
}

/**
 * Validates the control plane address a node talks to. Remote addresses must
 * be https (the link then runs over wss with normal certificate validation);
 * plain http is accepted only for a control plane on this same machine.
 * Credentials, paths and queries are refused so nothing secret can ride in it.
 */
export function normalizeServerOrigin(raw: unknown): { ok: true; origin: string; linkUrl: string } | { ok: false; error: string } {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, error: 'A --server URL is required.' };
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, error: 'The --server URL is not valid.' };
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/')) {
    return { ok: false, error: 'The --server URL must be an origin only (no credentials, path or query).' };
  }
  if (url.protocol === 'http:' && !LOOPBACK_HOSTNAMES.has(url.hostname)) {
    return { ok: false, error: 'Remote control planes must use https. Plain http is only accepted for this machine.' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, error: 'The --server URL must use https.' };
  }
  const linkUrl = `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}${RUNTIME_NODE_LINK_PATH}`;
  return { ok: true, origin: url.origin, linkUrl };
}

function isCredential(value: unknown): value is NodeAgentCredential {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  return Boolean(
    record
    && record.version === 1
    && typeof record.serverOrigin === 'string'
    && typeof record.nodeId === 'string'
    && typeof record.privateKeyPem === 'string'
    && typeof record.publicKeyPem === 'string'
    && typeof record.enrolledAt === 'string',
  );
}

export async function readNodeAgentCredential(stateDir: string): Promise<NodeAgentCredential | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(stateDir, CREDENTIAL_FILE_NAME), 'utf8'));
    return isCredential(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Writes the credential owner-only (0600 in a 0700 directory on POSIX; on
 * Windows the user profile ACL applies) via a temporary file and an atomic
 * rename, so a crash never leaves a half-written key behind.
 */
export async function writeNodeAgentCredential(stateDir: string, credential: NodeAgentCredential): Promise<string> {
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const target = path.join(stateDir, CREDENTIAL_FILE_NAME);
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(credential, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporary, target);
  return target;
}
