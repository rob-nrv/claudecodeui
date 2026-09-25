// Edge chain proof: client -> reverse proxy (same behaviour as deploy/hosted-relay
// nginx: X-Forwarded-For is REPLACED by the address the proxy saw) -> external-tls
// Remote Gateway -> the real pairing route and its failure limiter. Clients use
// distinct loopback source addresses (127.0.0.2, 127.0.0.3), so the proxy sees
// distinct peers exactly like it would see distinct Internet clients.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import express from 'express';

import { readRequestClientAddress } from '@/shared/utils.js';

const PUBLIC_ORIGIN = 'https://relay.edge.test';

let directory: string;
let proxyPort: number;
const closers: Array<() => Promise<void>> = [];

async function freePort(): Promise<number> {
  const probe = http.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** Same header policy as nginx-relay-proxy.inc: never forward what the client sent. */
async function startProxy(gatewayPort: number): Promise<number> {
  const proxy = http.createServer((clientRequest, clientResponse) => {
    const headers = { ...clientRequest.headers, 'x-forwarded-for': clientRequest.socket.remoteAddress ?? '' };
    const upstream = http.request({ host: '127.0.0.1', port: gatewayPort, path: clientRequest.url, method: clientRequest.method, headers }, (response) => {
      clientResponse.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(clientResponse);
    });
    upstream.on('error', () => {
      clientResponse.statusCode = 502;
      clientResponse.end();
    });
    clientRequest.pipe(upstream);
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  closers.push(() => new Promise<void>((resolve) => {
    proxy.closeAllConnections();
    proxy.close(() => resolve());
  }));
  return (proxy.address() as AddressInfo).port;
}

function pair(port: number, source: string, forwardedFor?: string): Promise<number> {
  const body = JSON.stringify({ username: 'nobody', password: 'wrong-password', pairingCode: '0000-0000-0000' });
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1', port, path: '/api/remote-access/pair', method: 'POST', localAddress: source,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        origin: PUBLIC_ORIGIN,
        ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}),
      },
    }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode ?? 0));
    });
    request.on('error', reject);
    request.end(body);
  });
}

before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'remote-edge-chain-'));
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  const database = await import('@/modules/database/index.js');
  await database.initializeDatabase();
  const auth = await import('@/modules/auth/index.js');
  const { createRemoteAccess } = await import('@/modules/remote-access/remote-access.module.js');

  const gatewayPort = await freePort();
  const remote = createRemoteAccess({
    configResult: { ok: true, config: { mode: 'external-tls', bindHost: '127.0.0.1', port: gatewayPort, publicOrigin: PUBLIC_ORIGIN } },
    localListener: { host: '127.0.0.1', port: 0, loopbackOnly: true },
    authenticateToken: auth.authenticateToken,
  });
  const app = express();
  app.use(remote.requestGuard);
  app.use(express.json());
  app.use('/api/remote-access', remote.router);
  app.use((error: { statusCode?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.statusCode ?? 500).json({ success: false });
  });
  await remote.startGateway({ handleRequest: app, handleUpgrade: (_request, socket) => socket.destroy() });
  closers.push(() => remote.close());
  proxyPort = await startProxy(gatewayPort);
});

after(async () => {
  for (const close of closers.reverse()) await close();
  await rm(directory, { recursive: true, force: true }).catch(() => undefined);
});

test('a forged X-Forwarded-For neither hides the attacker nor lets it burn another client budget', async () => {
  const attacker = '127.0.0.2';
  const victim = '127.0.0.3';
  const statuses: number[] = [];
  // Rotating spoofed origins, including the victim's address, must not escape the attacker's own bucket.
  const spoofs = [victim, '198.51.100.9', '1.1.1.1, 127.0.0.3', '10.0.0.1', '203.0.113.5', victim, '8.8.8.8'];
  for (const spoof of spoofs) statuses.push(await pair(proxyPort, attacker, spoof));

  assert.ok(statuses.slice(0, 5).every((status) => status !== 429), `first 5 failures are judged, not throttled: ${statuses}`);
  assert.deepEqual(statuses.slice(5), [429, 429], 'the 6th and 7th attempt are throttled despite new spoofed addresses');

  const victimStatus = await pair(proxyPort, victim);
  assert.notEqual(victimStatus, 429, 'the spoofed victim address did not consume the victim budget');
});

test('an unmarked (local listener) request never takes its client address from headers', () => {
  const request = { socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '203.0.113.77' } };
  assert.equal(readRequestClientAddress(request), '127.0.0.1');
});

const hasOpenSsl = spawnSync('openssl', ['version'], { encoding: 'utf8' }).status === 0;

test('in tls mode (no trusted terminator) X-Forwarded-For is ignored entirely', { skip: hasOpenSsl ? false : 'openssl unavailable' }, async () => {
  const certPath = path.join(directory, 'c.pem');
  const keyPath = path.join(directory, 'k.pem');
  const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-subj', '/CN=localhost', '-days', '1'], {
    encoding: 'utf8',
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
  });
  assert.equal(generated.status, 0, generated.stderr);
  const cert = await readFile(certPath);
  const { startRemoteGateway } = await import('@/modules/remote-access/remote-gateway.service.js');
  const port = await freePort();

  let seen = '';
  const gateway = await startRemoteGateway(
    { mode: 'tls', bindHost: '127.0.0.1', port, publicOrigin: `https://localhost:${port}`, certPath, keyPath },
    {
      handleRequest: (request, response) => {
        seen = readRequestClientAddress(request);
        response.end('ok');
      },
      handleUpgrade: () => undefined,
    },
    () => undefined,
  );
  try {
    await new Promise<void>((resolve, reject) => {
      https.get({ host: '127.0.0.1', port, path: '/', servername: 'localhost', ca: cert, headers: { 'x-forwarded-for': '203.0.113.99' } }, (response) => {
        response.resume();
        response.on('end', resolve);
      }).on('error', reject);
    });
  } finally {
    await gateway?.close();
  }
  assert.equal(seen, '127.0.0.1');
});
