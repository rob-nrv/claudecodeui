// Remote Gateway integration (FT-M08): real HTTP listeners, the real request
// guard, auth middleware and websocket gateway. The local listener and the
// gateway share one application exactly like server/index.ts wires them.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import tls from 'node:tls';

import express, { type NextFunction, type Request, type Response } from 'express';
import { WebSocket } from 'ws';

const PUBLIC_ORIGIN = 'https://cloudcli.gateway.test';
const PASSWORD = 'correct horse battery';

type Harness = {
  directory: string;
  localUrl: string;
  gatewayUrl: string;
  gatewayPort: number;
  localToken: string;
  closeAll(): Promise<void>;
  createRemoteAccess: typeof import('@/modules/remote-access/remote-access.module.js').createRemoteAccess;
  authenticateToken: express.RequestHandler;
  buildApp(remote: ReturnType<typeof import('@/modules/remote-access/remote-access.module.js').createRemoteAccess>): express.Express;
};

let harness: Harness;

async function freePort(): Promise<number> {
  const probe = http.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function request(url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) {
  return fetch(url, {
    method: init.method ?? 'GET',
    headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
}

/** Resolves with the HTTP status of a refused upgrade, or 101 when the socket opened. */
function upgradeStatus(url: string, headers: Record<string, string>): Promise<{ status: number; socket: WebSocket | null }> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, { headers });
    socket.once('open', () => resolve({ status: 101, socket }));
    socket.once('unexpected-response', (_request, response) => {
      resolve({ status: response.statusCode ?? 0, socket: null });
      response.resume();
      socket.terminate();
    });
    socket.once('error', () => resolve({ status: 0, socket: null }));
  });
}

before(async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'remote-gateway-integration-'));
  // The auth middleware reads its JWT secret from the database at import time.
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');

  const database = await import('@/modules/database/index.js');
  await database.initializeDatabase();
  const bcrypt = createRequire(import.meta.url)('bcrypt') as { hash(value: string, rounds: number): Promise<string> };
  database.userDb.createUser('robin', await bcrypt.hash(PASSWORD, 4));

  const auth = await import('@/modules/auth/index.js');
  const { createRemoteAccess } = await import('@/modules/remote-access/remote-access.module.js');
  const { createWebSocketServer } = await import('@/modules/websocket/index.js');

  const buildApp = (remote: ReturnType<typeof createRemoteAccess>) => {
    const app = express();
    app.use(remote.requestGuard);
    app.use(express.json());
    app.use('/api/auth', auth.authRoutes);
    app.use('/api/remote-access', remote.router);
    app.get('/api/projects', auth.authenticateToken, (req: Request, res: Response) => {
      res.json({ user: (req as Request & { user?: { username?: string } }).user?.username });
    });
    app.post('/api/projects/create', auth.authenticateToken, (_req: Request, res: Response) => {
      res.json({ created: true });
    });
    app.use('/api/agent', (_req: Request, res: Response) => res.json({ agent: true }));
    app.use((error: { statusCode?: number; code?: string }, _req: Request, res: Response, _next: NextFunction) => {
      res.status(error.statusCode ?? 500).json({ success: false, error: { code: error.code } });
    });
    return app;
  };

  const gatewayPort = await freePort();
  const remote = createRemoteAccess({
    configResult: { ok: true, config: { mode: 'external-tls', bindHost: '127.0.0.1', port: gatewayPort, publicOrigin: PUBLIC_ORIGIN } },
    localListener: { host: '127.0.0.1', port: 0, loopbackOnly: true },
    authenticateToken: auth.authenticateToken,
  });
  const app = buildApp(remote);
  const localServer = http.createServer(app);
  localServer.listen(0, '127.0.0.1');
  await once(localServer, 'listening');
  const localPort = (localServer.address() as AddressInfo).port;

  const noop = () => null;
  const wss = createWebSocketServer(localServer, {
    verifyClient: {
      isPlatform: false,
      authenticateWebSocket: auth.authenticateWebSocket,
      allowedOrigins: new Set([`http://127.0.0.1:${localPort}`]),
      remote: remote.websocket,
    },
    chat: {
      runtime: {
        hasRuntime: () => true,
        run: async () => undefined,
        abort: async () => false,
        resolveToolApproval: () => ({ status: 'rejected', reason: 'not_found' }),
        getPendingApprovalsForSession: () => [],
        getRecentPermissionOutcomesForSession: () => [],
      },
    },
    shell: { resolveProviderSessionId: noop, resolveClaudeProfileConfigDir: noop, resolveSessionClaudeProfileId: noop } as never,
    getPluginPort: noop as never,
    onBrowserConnection: (ws, upgradeRequest) => remote.trackSocket(ws, upgradeRequest),
  });

  const status = await remote.startGateway({
    handleRequest: app,
    handleUpgrade: (upgradeRequest, socket, head) => {
      wss.handleUpgrade(upgradeRequest, socket, head, (ws) => wss.emit('connection', ws, upgradeRequest));
    },
  });
  assert.equal(status.state, 'listening');

  const login = await request(`http://127.0.0.1:${localPort}/api/auth/login`, { method: 'POST', body: { username: 'robin', password: PASSWORD } });
  const { token } = await login.json() as { token: string };

  harness = {
    directory,
    localUrl: `http://127.0.0.1:${localPort}`,
    gatewayUrl: `http://127.0.0.1:${gatewayPort}`,
    gatewayPort,
    localToken: token,
    createRemoteAccess,
    authenticateToken: auth.authenticateToken,
    buildApp,
    async closeAll() {
      for (const client of wss.clients) {
        client.terminate();
      }
      await remote.close();
      wss.close();
      await new Promise<void>((resolve) => localServer.close(() => resolve()));
      database.closeConnection();
    },
  };
});

after(async () => {
  await harness?.closeAll();
  if (harness) {
    await rm(harness.directory, { recursive: true, force: true });
  }
});

async function pairBrowser(): Promise<string> {
  const created = await request(`${harness.localUrl}/api/remote-access/pairing-codes`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${harness.localToken}` },
  });
  assert.equal(created.status, 201);
  const { data } = await created.json() as { data: { code: string } };
  const paired = await request(`${harness.gatewayUrl}/api/remote-access/pair`, {
    method: 'POST',
    headers: { Origin: PUBLIC_ORIGIN, 'User-Agent': 'Mozilla/5.0 (Android) Chrome/140' },
    body: { username: 'robin', password: PASSWORD, pairingCode: data.code },
  });
  assert.equal(paired.status, 200);
  const setCookie = paired.headers.get('set-cookie') ?? '';
  return setCookie.split(';')[0];
}

test('unauthenticated remote HTTP is refused, and local bearer tokens or URL tokens are never accepted remotely', { concurrency: false }, async () => {
  const anonymous = await request(`${harness.gatewayUrl}/api/projects`);
  assert.equal(anonymous.status, 401);
  assert.equal((await anonymous.json() as { code: string }).code, 'AUTH_REMOTE_SESSION_REQUIRED');
  assert.equal(anonymous.headers.get('strict-transport-security'), 'max-age=31536000');
  assert.equal(anonymous.headers.get('x-frame-options'), 'DENY');

  const bearer = await request(`${harness.gatewayUrl}/api/projects`, { headers: { Authorization: `Bearer ${harness.localToken}` } });
  assert.equal(bearer.status, 401, 'a token valid on this machine is not a remote credential');

  const urlToken = await request(`${harness.gatewayUrl}/api/projects?token=${harness.localToken}`);
  assert.equal(urlToken.status, 400);
  assert.equal(((await urlToken.json()) as { error: { code: string } }).error.code, 'REMOTE_CREDENTIALS_IN_URL');

  const local = await request(`${harness.localUrl}/api/projects`, { headers: { Authorization: `Bearer ${harness.localToken}` } });
  assert.equal(local.status, 200, 'the local listener behaves exactly as before');
  assert.equal(local.headers.get('strict-transport-security'), null);
});

test('password login, first-user setup, token refresh and machine APIs are disabled through the gateway', { concurrency: false }, async () => {
  for (const [method, route] of [['POST', '/api/auth/login'], ['POST', '/api/auth/register'], ['POST', '/api/auth/refresh'], ['GET', '/api/agent/run']]) {
    const response = await request(`${harness.gatewayUrl}${route}`, { method, headers: { Origin: PUBLIC_ORIGIN }, body: method === 'POST' ? {} : undefined });
    assert.equal(response.status, 403, route);
    assert.equal(((await response.json()) as { error: { code: string } }).error.code, 'REMOTE_ROUTE_DISABLED');
  }

  const remoteStatus = await (await request(`${harness.gatewayUrl}/api/auth/status`)).json() as { transport: string };
  const localStatus = await (await request(`${harness.localUrl}/api/auth/status`)).json() as { transport: string };
  assert.deepEqual([remoteStatus.transport, localStatus.transport], ['remote', 'local']);
});

test('pairing sets a host-only, Secure, HttpOnly, SameSite=Strict cookie and never returns the token', { concurrency: false }, async () => {
  const created = await request(`${harness.localUrl}/api/remote-access/pairing-codes`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${harness.localToken}` },
  });
  const { data } = await created.json() as { data: { code: string } };
  const body = { username: 'robin', password: PASSWORD, pairingCode: data.code };

  const noOrigin = await request(`${harness.gatewayUrl}/api/remote-access/pair`, { method: 'POST', body });
  assert.equal(noOrigin.status, 403, 'CSRF: an unsafe method must come from the public origin');
  const wrongOrigin = await request(`${harness.gatewayUrl}/api/remote-access/pair`, { method: 'POST', headers: { Origin: 'https://evil.example' }, body });
  assert.equal(wrongOrigin.status, 403);
  const local = await request(`${harness.localUrl}/api/remote-access/pair`, { method: 'POST', body });
  assert.equal(local.status, 404, 'pairing only exists on the gateway');

  const paired = await request(`${harness.gatewayUrl}/api/remote-access/pair`, { method: 'POST', headers: { Origin: PUBLIC_ORIGIN }, body });
  assert.equal(paired.status, 200);
  const setCookie = paired.headers.get('set-cookie') ?? '';
  assert.match(setCookie, /^__Host-cloudcli_remote=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=\d+$/);
  const token = setCookie.split(';')[0].split('=')[1];
  assert.equal((await paired.text()).includes(token), false, 'the token never appears in a response body');
  const cookie = setCookie.split(';')[0];

  const authorized = await request(`${harness.gatewayUrl}/api/projects`, { headers: { Cookie: cookie } });
  assert.equal(authorized.status, 200);
  assert.equal((await authorized.json() as { user: string }).user, 'robin');

  const csrf = await request(`${harness.gatewayUrl}/api/projects/create`, { method: 'POST', headers: { Cookie: cookie, Origin: 'https://evil.example' }, body: {} });
  assert.equal(csrf.status, 403);
  const csrfNoOrigin = await request(`${harness.gatewayUrl}/api/projects/create`, { method: 'POST', headers: { Cookie: cookie }, body: {} });
  assert.equal(csrfNoOrigin.status, 403);
  const sameOrigin = await request(`${harness.gatewayUrl}/api/projects/create`, { method: 'POST', headers: { Cookie: cookie, Origin: PUBLIC_ORIGIN }, body: {} });
  assert.equal(sameOrigin.status, 200);

  const tossed = await request(`${harness.gatewayUrl}/api/projects`, { headers: { Cookie: `${cookie}; __Host-cloudcli_remote=${'A'.repeat(43)}` } });
  assert.equal(tossed.status, 401, 'two session cookies are never guessed between');

  const cookieOnLocal = await request(`${harness.localUrl}/api/projects`, { headers: { Cookie: cookie } });
  assert.equal(cookieOnLocal.status, 401, 'a remote cookie is not a local credential either');
});

test('remote websocket upgrades need the session cookie from exactly the public origin', { concurrency: false }, async () => {
  const cookie = await pairBrowser();
  const gatewayWs = `ws://127.0.0.1:${harness.gatewayPort}/ws`;

  assert.equal((await upgradeStatus(gatewayWs, { Origin: PUBLIC_ORIGIN })).status, 401, 'no cookie');
  assert.equal((await upgradeStatus(gatewayWs, { Origin: 'https://evil.example', Cookie: cookie })).status, 401, 'cross-origin');
  assert.equal((await upgradeStatus(gatewayWs, { Cookie: cookie })).status, 401, 'no Origin');
  assert.equal((await upgradeStatus(`${gatewayWs}?token=${harness.localToken}`, { Origin: PUBLIC_ORIGIN, Cookie: cookie })).status, 401, 'URL token');
  assert.equal((await upgradeStatus(gatewayWs, { Origin: PUBLIC_ORIGIN, Authorization: `Bearer ${harness.localToken}` })).status, 401, 'bearer');

  const opened = await upgradeStatus(gatewayWs, { Origin: PUBLIC_ORIGIN, Cookie: cookie });
  assert.equal(opened.status, 101);
  opened.socket?.close();

  const localWs = harness.localUrl.replace('http', 'ws');
  const local = await upgradeStatus(`${localWs}/ws?token=${harness.localToken}`, {});
  assert.equal(local.status, 101, 'local websocket authentication is unchanged');
  local.socket?.close();
  assert.equal((await upgradeStatus(`${localWs}/ws`, { Cookie: cookie })).status, 401);
});

test('revoking a remote browser closes its open sockets at once and refuses its cookie', { concurrency: false }, async () => {
  const cookie = await pairBrowser();
  const opened = await upgradeStatus(`ws://127.0.0.1:${harness.gatewayPort}/ws`, { Origin: PUBLIC_ORIGIN, Cookie: cookie });
  assert.equal(opened.status, 101);
  const closed = once(opened.socket as WebSocket, 'close');

  const status = await (await request(`${harness.gatewayUrl}/api/remote-access/status`, { headers: { Cookie: cookie } })).json() as {
    data: { transport: string; sessions: Array<{ sessionId: string; current: boolean }> };
  };
  assert.equal(status.data.transport, 'remote');
  const current = status.data.sessions.find((session) => session.current);
  assert.ok(current);

  const revoked = await request(`${harness.localUrl}/api/remote-access/sessions/${current.sessionId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${harness.localToken}` },
  });
  assert.equal(revoked.status, 200);
  const [code] = await closed as [number];
  assert.equal(code, 4401);
  assert.equal((await request(`${harness.gatewayUrl}/api/projects`, { headers: { Cookie: cookie } })).status, 401);
});

const hasOpenSsl = spawnSync('openssl', ['version'], { encoding: 'utf8' }).status === 0;

test('the gateway can terminate TLS itself (TLS 1.2+), and plaintext to its port gets no application response', { concurrency: false, skip: hasOpenSsl ? false : 'openssl is not available to generate a test certificate' }, async () => {
  const certPath = path.join(harness.directory, 'cert.pem');
  const keyPath = path.join(harness.directory, 'key.pem');
  const generated = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', keyPath, '-out', certPath, '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ], { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1', MSYS2_ARG_CONV_EXCL: '*' } });
  assert.equal(generated.status, 0, generated.stderr);
  const certificate = await readFile(certPath);

  const port = await freePort();
  const remote = harness.createRemoteAccess({
    configResult: { ok: true, config: { mode: 'tls', bindHost: '127.0.0.1', port, publicOrigin: `https://localhost:${port}`, certPath, keyPath } },
    localListener: { host: '127.0.0.1', port: 0, loopbackOnly: true },
    authenticateToken: harness.authenticateToken,
  });
  const app = harness.buildApp(remote);
  const status = await remote.startGateway({ handleRequest: app, handleUpgrade: (_request, socket) => socket.destroy() });
  assert.equal(status.state, 'listening');

  try {
    const secure = await new Promise<{ statusCode: number; hsts: string | undefined }>((resolve, reject) => {
      https.get({ host: '127.0.0.1', port, path: '/api/projects', servername: 'localhost', ca: certificate }, (response) => {
        response.resume();
        resolve({ statusCode: response.statusCode ?? 0, hsts: response.headers['strict-transport-security'] as string | undefined });
      }).on('error', reject);
    });
    assert.deepEqual(secure, { statusCode: 401, hsts: 'max-age=31536000' });

    const plaintext = await new Promise<number | 'failed'>((resolve) => {
      http.get({ host: '127.0.0.1', port, path: '/api/projects' }, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      }).on('error', () => resolve('failed'));
    });
    assert.notEqual(plaintext, 401, 'plain HTTP never reaches the application');
    assert.notEqual(plaintext, 200);

    const downgraded = await new Promise<'connected' | 'refused'>((resolve) => {
      const socket = tls.connect({ host: '127.0.0.1', port, servername: 'localhost', ca: certificate, maxVersion: 'TLSv1.1', minVersion: 'TLSv1' }, () => {
        socket.destroy();
        resolve('connected');
      });
      socket.on('error', () => resolve('refused'));
    });
    assert.equal(downgraded, 'refused');
  } finally {
    await remote.close();
  }
});
