// FT-M11 Hosted Relay technical gate. The real relay composition (the same
// factory server/relay.ts starts) listens on loopback with an external-tls
// Remote Gateway; two real node agents enroll and link OUTBOUND through that
// gateway with their own keys; a paired browser session drives it with the
// HttpOnly cookie. Every child process started in this process is recorded:
// the relay must start none. Recording runtimes only, never a provider.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { WebSocket } from 'ws';

import type { ProviderRuntimeWriter, RuntimeNodeProbeOutcome } from '@/shared/types.js';

const PUBLIC_ORIGIN = 'https://relay.cloudcli.test';
const PASSWORD = 'relay-password-123';

// ---------------------------------------------------------------- process instrumentation
const spawned: string[] = [];
const CHILD_PROCESS_FUNCTIONS = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const;
const originals = new Map<string, unknown>();
const mutableChildProcess = childProcess as unknown as Record<string, (...args: unknown[]) => unknown>;
for (const name of CHILD_PROCESS_FUNCTIONS) {
  const original = mutableChildProcess[name];
  originals.set(name, original);
  mutableChildProcess[name] = (...args: unknown[]) => {
    spawned.push(`${name}:${String(args[0])}`);
    return original(...args);
  };
}
syncBuiltinESMExports();

// ---------------------------------------------------------------- helpers
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(read: () => T | Promise<T>, description: string, timeoutMs = 8_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) {
      return value as NonNullable<T>;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${description}`);
    }
    await sleep(25);
  }
}

async function freePort(): Promise<number> {
  const probe = http.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

type Deferred = { promise: Promise<void>; resolve(): void };
const deferred = (): Deferred => {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

const PROVEN_PROBE: Record<string, RuntimeNodeProbeOutcome> = {
  'claude-cli': { outcome: 'proven', detail: '2.1.220 (Claude Code)' },
  'git-cli': { outcome: 'proven', detail: 'git version 2.45.0' },
  'workspace-filesystem': { outcome: 'proven' },
};

function createRecordingRuntime(label: string) {
  const runs: Array<{ command: string; options: Record<string, unknown>; release: Deferred }> = [];
  return {
    runs,
    runtime: {
      async run(_provider: 'claude', command: string, options: Record<string, unknown>, writer: ProviderRuntimeWriter) {
        const release = deferred();
        runs.push({ command, options, release });
        writer.send({ kind: 'session_created', newSessionId: `${label}-native-${runs.length}` });
        writer.send({ kind: 'text', content: `ran on ${label}` });
        writer.send({ kind: 'complete', exitCode: 0 });
      },
      async abort() {
        return true;
      },
      resolveToolApproval() {
        return { status: 'accepted' as const };
      },
    },
  };
}

// ---------------------------------------------------------------- harness
let directory: string;
let appRoot: string;
let canaryFolder: string;
let relay: Awaited<ReturnType<typeof startRelay>>;
let nas: Awaited<ReturnType<typeof startNode>>;
let laptop: Awaited<ReturnType<typeof startNode>>;

async function startRelay() {
  const utils = await import('@/shared/utils.js');
  utils.setServerRole('hosted-relay');
  process.env.DATABASE_PATH = path.join(directory, 'relay.db');

  const database = await import('@/modules/database/index.js');
  await database.initializeDatabase();
  const bcrypt = createRequire(import.meta.url)('bcrypt') as { hash(value: string, rounds: number): Promise<string> };
  database.userDb.createUser('robin', await bcrypt.hash(PASSWORD, 4));

  const { createHostedRelay } = await import('@/modules/hosted-relay/index.js');
  const { runtimeNodesService } = await import('@/modules/runtime-nodes/index.js');
  const gatewayPort = await freePort();
  const instance = createHostedRelay({
    env: {
      CLOUDCLI_REMOTE_GATEWAY: 'external-tls',
      CLOUDCLI_REMOTE_ORIGIN: PUBLIC_ORIGIN,
      CLOUDCLI_REMOTE_PORT: String(gatewayPort),
    },
    appRoot,
    runningVersion: 'test',
    host: '127.0.0.1',
    port: 0,
    isPlatform: false,
  });
  const started = await instance.start();
  assert.equal(started.gateway.state, 'listening');

  const localUrl = `http://127.0.0.1:${started.port}`;
  const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
  const login = await fetch(`${localUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'robin', password: PASSWORD }),
  });
  const { token } = await login.json() as { token: string };

  // Pair a remote browser exactly as a phone would: a code from a signed-in session, then password + code at the gateway.
  const code = await fetch(`${localUrl}/api/remote-access/pairing-codes`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  const { data: pairing } = await code.json() as { data: { code: string } };
  const paired = await fetch(`${gatewayUrl}/api/remote-access/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: PUBLIC_ORIGIN },
    body: JSON.stringify({ username: 'robin', password: PASSWORD, pairingCode: pairing.code }),
  });
  assert.equal(paired.status, 200);
  const setCookie = paired.headers.get('set-cookie') ?? '';
  assert.match(setCookie, /^__Host-cloudcli_remote=[^;]+; Path=\/; Secure; HttpOnly; SameSite=Strict/);
  const cookie = setCookie.split(';')[0];

  return { instance, database, runtimeNodesService, localUrl, gatewayUrl, gatewayPort, token, cookie };
}

/** A paired remote browser request through the gateway. */
function remote(pathname: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  return fetch(`${relay.gatewayUrl}${pathname}`, {
    method: init.method ?? 'GET',
    headers: {
      Origin: PUBLIC_ORIGIN,
      Cookie: relay.cookie,
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...init.headers,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

function local(pathname: string, init: { method?: string; body?: unknown } = {}) {
  return fetch(`${relay.localUrl}${pathname}`, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bearer ${relay.token}`, ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

async function enroll(label: string) {
  const created = await remote('/api/runtime-nodes/enrollments', { method: 'POST', body: { label } });
  assert.equal(created.status, 201);
  const { data } = await created.json() as { data: { code: string } };
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  // The node agent calls the gateway with no Origin and no cookie, like `cloudcli node enroll`.
  const redeemed = await fetch(`${relay.gatewayUrl}/api/runtime-node-link/enroll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: data.code, publicKey: publicKeyPem, label, platform: 'linux', arch: 'arm64', runtimeVersion: '1.37.2' }),
  });
  assert.equal(redeemed.status, 201);
  const { data: enrolled } = await redeemed.json() as { data: { nodeId: string } };
  return {
    version: 1 as const,
    serverOrigin: PUBLIC_ORIGIN,
    nodeId: enrolled.nodeId,
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem,
    enrolledAt: new Date().toISOString(),
  };
}

async function startNode(label: string) {
  // eslint-disable-next-line boundaries/dependencies -- the technical gate drives the real node agent, whose only public API is its CLI.
  const { createNodeAgentExecutor } = await import('@/modules/node-agent/node-agent-executor.service.js');
  // eslint-disable-next-line boundaries/dependencies -- see above.
  const { createNodeAgentLinkClient } = await import('@/modules/node-agent/node-agent-link.client.js');
  const { RUNTIME_NODE_LINK_PATH } = await import('@/shared/utils.js');

  const workspaceRoot = path.join(directory, `${label}-workspaces`);
  const projectFolder = path.join(workspaceRoot, 'app');
  await mkdir(projectFolder, { recursive: true });
  const credential = await enroll(label);
  const recording = createRecordingRuntime(label);
  const history = {
    recordSession: () => undefined,
    recordProviderSessionId: () => undefined,
    fetchHistory: async (input: { appSessionId: string }) => ({
      messages: [{ id: `${label}-history`, kind: 'text', content: `history stored on ${label}`, sessionId: input.appSessionId }],
      total: 1,
      hasMore: false,
      offset: 0,
      limit: null,
    }),
  };

  let client: ReturnType<typeof createNodeAgentLinkClient>;
  const executor = createNodeAgentExecutor({
    runtime: recording.runtime,
    history: history as never,
    workspaceRoot,
    graceMs: 1_000,
    // Git stays out of this process so the relay's zero-child-process assertion is exact.
    readRootCommits: async () => [],
    probe: async () => PROVEN_PROBE,
    send: (frame) => client.send(frame),
  });
  const connect = () => {
    client = createNodeAgentLinkClient({
      credential,
      linkUrl: `ws://127.0.0.1:${relay.gatewayPort}${RUNTIME_NODE_LINK_PATH}`,
      runtimeVersion: '1.37.2',
      platform: 'linux',
      arch: 'arm64',
      getActiveExecutions: () => executor.activeExecutions(),
      onWelcome: (frame) => executor.onWelcome(frame.resume),
      onFrame: (frame) => {
        void executor.handleFrame(frame);
      },
      onDisconnected: () => executor.onDisconnected(),
      log: () => undefined,
      initialBackoffMs: 50,
      maxBackoffMs: 200,
    });
    return client.start();
  };
  let done = connect();
  return {
    credential,
    recording,
    projectFolder,
    get client() {
      return client;
    },
    get done() {
      return done;
    },
    reconnect() {
      done = connect();
    },
  };
}

function openRemoteChat() {
  const frames: Array<Record<string, unknown>> = [];
  const socket = new WebSocket(`ws://127.0.0.1:${relay.gatewayPort}/ws`, { headers: { Origin: PUBLIC_ORIGIN, Cookie: relay.cookie } });
  socket.on('message', (raw) => frames.push(JSON.parse(raw.toString())));
  return {
    socket,
    frames,
    ready: once(socket, 'open'),
    send: (payload: Record<string, unknown>) => socket.send(JSON.stringify(payload)),
    waitFor: (predicate: (frame: Record<string, unknown>) => boolean, description: string, timeoutMs?: number) =>
      waitFor(() => frames.find(predicate), description, timeoutMs),
  };
}

/** Status of a refused upgrade, 101 when it opened, or the close code for a socket closed right after opening. */
function upgrade(url: string, headers: Record<string, string>): Promise<{ status: number; closeCode: number | null }> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, { headers });
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      socket.terminate();
      resolve({ status: response.statusCode ?? 0, closeCode: null });
    });
    socket.once('open', () => {
      const timer = setTimeout(() => {
        socket.close();
        resolve({ status: 101, closeCode: null });
      }, 300);
      socket.once('close', (code) => {
        clearTimeout(timer);
        resolve({ status: 101, closeCode: code });
      });
    });
    socket.once('error', () => resolve({ status: 0, closeCode: null }));
  });
}

const nodeView = async (nodeId: string) => {
  const response = await remote('/api/runtime-nodes');
  const { data } = await response.json() as { data: { localNodeId: string | null; nodes: Array<{ nodeId: string; canExecute: boolean; availability: { reason: string } }> } };
  return data.nodes.find((node) => node.nodeId === nodeId) ?? null;
};
const canExecute = async (nodeId: string) => (await nodeView(nodeId))?.canExecute === true;

before(async () => {
  // The instrumentation must see calls made through ESM named imports, or "no process started" would prove nothing.
  const { execFileSync } = await import('node:child_process');
  execFileSync(process.execPath, ['-e', '']);
  assert.equal(spawned.length, 1, 'child process instrumentation is live');
  spawned.length = 0;

  directory = await mkdtemp(path.join(os.tmpdir(), 'hosted-relay-gate-'));
  appRoot = path.join(directory, 'app-root');
  await mkdir(path.join(appRoot, 'dist', 'assets'), { recursive: true });
  await writeFile(path.join(appRoot, 'dist', 'index.html'), '<!doctype html><title>CloudCLI</title><div id="root"></div>');
  await writeFile(path.join(appRoot, 'dist', 'assets', 'app-abc123.js'), 'console.log("cockpit")');
  canaryFolder = path.join(directory, 'relay-host-canary');
  await mkdir(canaryFolder);
  await writeFile(path.join(canaryFolder, 'canary.txt'), 'untouched');
  relay = await startRelay();
});

after(async () => {
  nas?.client.stop();
  laptop?.client.stop();
  await relay?.instance.close();
  relay?.database.closeConnection();
  for (const name of CHILD_PROCESS_FUNCTIONS) {
    mutableChildProcess[name] = originals.get(name) as (...args: unknown[]) => unknown;
  }
  syncBuiltinESMExports();
  const utils = await import('@/shared/utils.js');
  utils.setServerRole('control-plane');
  await rm(directory, { recursive: true, force: true });
});

test('startup: the relay is healthy, holds no RuntimeNode and serves the production client', { concurrency: false }, async () => {
  const health = await fetch(`${relay.localUrl}/health`);
  assert.deepEqual(await health.json(), { status: 'ok', role: 'hosted-relay', version: 'test', ready: true, appReady: true });
  const remoteHealth = await fetch(`${relay.gatewayUrl}/health`);
  assert.deepEqual(await remoteHealth.json(), { status: 'ok' }, 'the internet learns liveness only');

  assert.equal(relay.database.runtimeNodesDb.count(), 0);
  const listing = await remote('/api/runtime-nodes');
  assert.deepEqual((await listing.json() as { data: unknown }).data, { localNodeId: null, nodes: [] });
  assert.equal(relay.database.runtimeNodesDb.count(), 0, 'listing never registers a local node');
  const projects = await remote('/api/projects');
  assert.deepEqual(await projects.json(), []);
  const status = await remote('/api/relay/status');
  assert.deepEqual((await status.json() as { data: unknown }).data, { role: 'hosted-relay', executesLocally: false });

  const spa = await fetch(`${relay.gatewayUrl}/projects/some-deep/link`);
  assert.equal(spa.status, 200);
  assert.match(await spa.text(), /<div id="root">/);
  assert.equal(spa.headers.get('x-frame-options'), 'DENY');
  assert.match(spa.headers.get('strict-transport-security') ?? '', /max-age=/);
  const asset = await fetch(`${relay.gatewayUrl}/assets/app-abc123.js`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('cache-control') ?? '', /immutable/);
  assert.equal((await fetch(`${relay.gatewayUrl}/assets/missing.js`)).status, 404);
});

test('a fresh account is never trapped in host onboarding: Git identity and provider login cannot exist on a relay', { concurrency: false }, async () => {
  const userId = (relay.database.userDb.getFirstUser() as { id: number }).id;
  relay.database.getConnection().prepare('UPDATE users SET has_completed_onboarding = 0 WHERE id = ?').run(userId);
  assert.equal(relay.database.userDb.hasCompletedOnboarding(userId), false, 'precondition: the stored flag is not set');

  for (const response of [await remote('/api/user/onboarding-status'), await local('/api/user/onboarding-status')]) {
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { hasCompletedOnboarding: boolean }).hasCompletedOnboarding, true);
  }
  assert.equal((await remote('/api/user/git-config')).status, 501, 'the step it would gate on is unavailable');
});

test('no local execution: workspace, shell, upload, plugin and provider surfaces answer 501 and touch nothing on the host', { concurrency: false }, async () => {
  // Even a project row pointing at a real folder on the relay host (a copied database) is never used.
  relay.database.projectsDb.createProjectPath(canaryFolder);
  const canaryProjectId = relay.database.projectsDb.getProjectPath(canaryFolder)?.project_id as string;

  const refused: Array<[string, string, unknown?]> = [
    ['GET', `/api/file-tree/projects/${canaryProjectId}/files`],
    ['GET', `/api/file-tree/projects/${canaryProjectId}/file?filePath=canary.txt`],
    ['PUT', `/api/file-tree/projects/${canaryProjectId}/file`, { filePath: 'canary.txt', content: 'overwritten' }],
    ['DELETE', `/api/file-tree/projects/${canaryProjectId}/files`, { path: 'canary.txt', type: 'file' }],
    ['GET', '/api/file-tree/browse-filesystem?path=/'],
    ['POST', '/api/file-tree/create-folder', { path: path.join(canaryFolder, 'new-folder') }],
    ['GET', `/api/git/status?projectId=${canaryProjectId}`],
    ['POST', '/api/git/commit', { projectId: canaryProjectId, message: 'x', files: ['canary.txt'] }],
    ['GET', `/api/taskmaster/tasks/${canaryProjectId}`],
    ['POST', `/api/taskmaster/init/${canaryProjectId}`],
    ['GET', `/api/worktrees?projectId=${canaryProjectId}`],
    ['POST', '/api/worktrees', { projectId: canaryProjectId, branch: 'x' }],
    ['POST', '/api/assets/images', {}],
    ['GET', '/api/commands/list'],
    ['GET', '/api/settings/credentials'],
    ['GET', '/api/plugins'],
    ['POST', '/api/system/update'],
    ['GET', '/api/claude-profiles'],
    ['POST', '/api/browser-use/sessions', {}],
    ['POST', '/api/voice/transcribe', {}],
    ['GET', '/api/providers/claude/auth/status'],
    ['GET', '/api/providers/claude/models'],
    ['GET', '/api/providers/claude/mcp/servers'],
    ['GET', '/api/providers/search/sessions?q=secret'],
    ['GET', `/api/providers/sessions/${randomUUID()}/token-usage`],
    ['DELETE', `/api/providers/sessions/${randomUUID()}?force=true`],
    ['POST', `/api/providers/sessions/${randomUUID()}/handoff`, { provider: 'claude' }],
    ['GET', '/api/user/git-config'],
    ['POST', '/api/projects/create-project', { path: path.join(canaryFolder, 'created') }],
    ['GET', `/api/projects/clone-progress?path=${encodeURIComponent(canaryFolder)}&githubUrl=https://example.invalid/x.git`],
    ['DELETE', `/api/projects/${canaryProjectId}?force=true`],
    ['GET', `/api/projects/${canaryProjectId}/taskmaster`],
  ];
  for (const [method, pathname, body] of refused) {
    for (const response of [await remote(pathname, { method, body }), await local(pathname, { method, body })]) {
      assert.equal(response.status, 501, `${method} ${pathname}`);
      assert.equal((await response.json() as { error: { code: string } }).error.code, 'HOSTED_RELAY_UNSUPPORTED');
    }
  }
  const anonymous = await fetch(`${relay.localUrl}/api/agent`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(anonymous.status, 401, 'an anonymous caller learns nothing about the surface');
  const anonymousRemote = await fetch(`${relay.gatewayUrl}/api/file-tree/browse-filesystem`, { headers: { Origin: PUBLIC_ORIGIN } });
  assert.equal(anonymousRemote.status, 401);
  assert.equal((await local('/api/agent', { method: 'POST', body: {} })).status, 501);

  for (const pathname of ['/shell', '/plugin-ws/some-plugin', '/desktop-notifications']) {
    const socket = await upgrade(`ws://127.0.0.1:${relay.gatewayPort}${pathname}`, { Origin: PUBLIC_ORIGIN, Cookie: relay.cookie });
    assert.deepEqual(socket, { status: 101, closeCode: 4404 }, pathname);
  }

  // A session can never be created by a relay-host folder, and nothing implies a target.
  const byPath = await remote('/api/providers/sessions', { method: 'POST', body: { provider: 'claude', projectPath: canaryFolder, initialMessage: 'hi' } });
  assert.equal((await byPath.json() as { error: { code: string } }).error.code, 'HOSTED_RELAY_PROJECT_PATH_UNSUPPORTED');
  const noTarget = await remote('/api/providers/sessions', { method: 'POST', body: { provider: 'claude', projectId: canaryProjectId, initialMessage: 'hi' } });
  assert.equal(noTarget.status, 400);
  assert.equal((await noTarget.json() as { error: { code: string } }).error.code, 'RUNTIME_NODE_REQUIRED');

  // A session row without a node binding (a copied database) never runs on the relay.
  const unboundId = randomUUID();
  relay.database.sessionsDb.createAppSession(unboundId, 'claude', null, 'Unbound', null, null, canaryProjectId);
  const chat = openRemoteChat();
  await chat.ready;
  chat.send({ type: 'chat.send', sessionId: unboundId, content: 'run here please' });
  const refusal = await chat.waitFor((frame) => frame.kind === 'protocol_error', 'unbound refusal');
  assert.equal(refusal.code, 'HOSTED_RELAY_NO_LOCAL_NODE');
  chat.socket.close();

  assert.deepEqual(await readdir(canaryFolder), ['canary.txt']);
  assert.equal(await readFile(path.join(canaryFolder, 'canary.txt'), 'utf8'), 'untouched');
  assert.equal(relay.database.runtimeNodesDb.count(), 0);
  assert.deepEqual(spawned, [], 'the relay started no process');
});

test('security boundary: origin, cookie, URL credentials, bearer tokens, websocket auth and body size', { concurrency: false }, async () => {
  const withoutCookie = await fetch(`${relay.gatewayUrl}/api/runtime-nodes`, { headers: { Origin: PUBLIC_ORIGIN } });
  assert.equal(withoutCookie.status, 401);
  const forgedCookie = await fetch(`${relay.gatewayUrl}/api/runtime-nodes`, { headers: { Origin: PUBLIC_ORIGIN, Cookie: `__Host-cloudcli_remote=${'x'.repeat(43)}` } });
  assert.equal(forgedCookie.status, 401);
  const bearer = await fetch(`${relay.gatewayUrl}/api/runtime-nodes`, { headers: { Origin: PUBLIC_ORIGIN, Authorization: `Bearer ${relay.token}` } });
  assert.equal(bearer.status, 401, 'a local bearer token is not a remote credential');
  const foreignOrigin = await remote('/api/runtime-nodes/enrollments', { method: 'POST', body: { label: 'x' }, headers: { Origin: 'https://evil.example' } });
  assert.equal(foreignOrigin.status, 403);
  const noOriginWrite = await fetch(`${relay.gatewayUrl}/api/runtime-nodes/enrollments`, {
    method: 'POST',
    headers: { Cookie: relay.cookie, 'Content-Type': 'application/json' },
    body: '{"label":"x"}',
  });
  assert.equal(noOriginWrite.status, 403, 'unsafe methods need exactly the public origin');
  const urlToken = await remote(`/api/runtime-nodes?token=${relay.token}`);
  assert.equal(urlToken.status, 400);
  for (const pathname of ['/api/auth/login', '/api/auth/register']) {
    const response = await remote(pathname, { method: 'POST', body: { username: 'robin', password: PASSWORD } });
    assert.equal(response.status, 403, `${pathname} stays on the relay host`);
  }
  const browserEnroll = await remote('/api/runtime-node-link/enroll', { method: 'POST', body: { code: '0000-0000-0000' } });
  assert.equal(browserEnroll.status, 403, 'a browser can never enroll a node');

  const tooLarge = await remote('/api/projects/registry', { method: 'POST', body: { displayName: 'x'.repeat(1_100_000) } });
  assert.equal(tooLarge.status, 413);

  const wsUrl = `ws://127.0.0.1:${relay.gatewayPort}/ws`;
  assert.equal((await upgrade(wsUrl, { Origin: PUBLIC_ORIGIN })).status, 401, 'no cookie');
  assert.equal((await upgrade(wsUrl, { Origin: 'https://evil.example', Cookie: relay.cookie })).status, 401, 'foreign origin');
  assert.equal((await upgrade(`${wsUrl}?token=${relay.token}`, { Origin: PUBLIC_ORIGIN })).status, 401, 'URL token');
  assert.equal((await upgrade(wsUrl, { Origin: PUBLIC_ORIGIN, Cookie: relay.cookie })).status, 101);
});

test('presence and routing: outbound nodes go online/offline truthfully and a run reaches only its own node', { concurrency: false }, async () => {
  nas = await startNode('nas');
  laptop = await startNode('laptop');
  await waitFor(async () => (await canExecute(nas.credential.nodeId)) && (await canExecute(laptop.credential.nodeId)), 'both nodes to prove themselves over their links');
  assert.equal(relay.database.runtimeNodesDb.getLocal(), null);

  const registered = await remote('/api/projects/registry', { method: 'POST', body: { displayName: 'Relay app' } });
  assert.equal(registered.status, 201);
  const { data: { project } } = await registered.json() as { data: { project: { projectId: string; controlPlaneCopy: string } } };
  assert.equal(project.controlPlaneCopy, 'absent');
  for (const node of [nas, laptop]) {
    const mapped = await remote(`/api/runtime-nodes/${node.credential.nodeId}/workspaces/${project.projectId}`, { method: 'PUT', body: { path: node.projectFolder } });
    assert.equal(mapped.status, 200);
  }

  const created = await remote('/api/providers/sessions', {
    method: 'POST',
    body: { provider: 'claude', projectId: project.projectId, initialMessage: 'hello nas', runtimeNodeId: nas.credential.nodeId },
  });
  assert.equal(created.status, 201);
  const { data: session } = await created.json() as { data: { sessionId: string; projectPath: string | null; runtimeNodeId: string } };
  assert.equal(session.projectPath, null, 'the relay recorded no folder');
  assert.equal(session.runtimeNodeId, nas.credential.nodeId);

  const chat = openRemoteChat();
  await chat.ready;
  chat.send({ type: 'chat.send', sessionId: session.sessionId, content: 'hello nas', options: { cwd: canaryFolder } });
  await chat.waitFor((frame) => frame.kind === 'complete' && frame.sessionId === session.sessionId, 'remote completion');
  assert.equal(nas.recording.runs.length, 1);
  assert.equal(laptop.recording.runs.length, 0, 'the other node never received the run');
  assert.notEqual(nas.recording.runs[0].options.cwd, canaryFolder, 'cwd comes from the node mapping, never the client');
  assert.ok(chat.frames.some((frame) => frame.kind === 'text' && frame.content === 'ran on nas'));

  const details = await remote(`/api/providers/sessions/${session.sessionId}`);
  const { data: detail } = await details.json() as { data: { runtimeNodeId: string; project: { projectId: string; path: string; displayName: string } | null } };
  assert.deepEqual([detail.runtimeNodeId, detail.project?.projectId, detail.project?.path, detail.project?.displayName], [nas.credential.nodeId, project.projectId, '', 'Relay app']);

  const history = await remote(`/api/providers/sessions/${session.sessionId}/messages`);
  const historyBody = await history.json() as { data: { messages: Array<{ content: string }> } };
  assert.deepEqual(historyBody.data.messages.map((message) => message.content), ['history stored on nas']);

  const listed = await remote('/api/projects');
  const projects = await listed.json() as Array<{ projectId: string; path: string; sessions: Array<{ id: string; runtimeNodeId: string }> }>;
  const relayProject = projects.find((entry) => entry.projectId === project.projectId);
  assert.equal(relayProject?.path, '');
  assert.deepEqual(relayProject?.sessions.map((entry) => [entry.id, entry.runtimeNodeId]), [[session.sessionId, nas.credential.nodeId]]);

  // Offline is observed from the link, and nothing fails over, even though the laptop could run this project.
  nas.client.stop();
  await waitFor(async () => (await nodeView(nas.credential.nodeId))?.availability.reason === 'link_offline', 'nas offline');
  chat.send({ type: 'chat.send', sessionId: session.sessionId, content: 'while offline' });
  const offline = await chat.waitFor((frame) => frame.kind === 'protocol_error' && frame.code === 'RUNTIME_NODE_OFFLINE', 'offline refusal');
  assert.match(String(offline.error), /not moved to another node/);
  await sleep(150);
  assert.equal(laptop.recording.runs.length, 0);
  assert.equal(nas.recording.runs.length, 1);
  assert.equal(relay.database.sessionsDb.getSessionById(session.sessionId)?.runtime_node_id, nas.credential.nodeId);

  nas.reconnect();
  await waitFor(() => canExecute(nas.credential.nodeId), 'nas back online');
  chat.send({ type: 'chat.send', sessionId: session.sessionId, content: 'after reconnect' });
  await waitFor(() => nas.recording.runs.length === 2, 'second run on nas');
  assert.equal(laptop.recording.runs.length, 0);
  chat.socket.close();
  assert.deepEqual(spawned, [], 'the relay started no process while routing');
});

test('all nodes offline: the cockpit stays readable and every execution is refused explicitly', { concurrency: false }, async () => {
  nas.client.stop();
  laptop.client.stop();
  await waitFor(async () => !(await canExecute(nas.credential.nodeId)) && !(await canExecute(laptop.credential.nodeId)), 'every node offline');

  const listing = await remote('/api/runtime-nodes');
  assert.equal(listing.status, 200);
  const { data } = await listing.json() as { data: { nodes: Array<{ canExecute: boolean; availability: { state: string; reason: string } }> } };
  assert.equal(data.nodes.length, 2);
  assert.ok(data.nodes.every((node) => !node.canExecute && node.availability.state === 'unavailable' && node.availability.reason === 'link_offline'));

  const projects = await remote('/api/projects');
  assert.equal(projects.status, 200);
  const [relayProject] = (await projects.json() as Array<{ projectId: string; displayName: string; sessions: Array<{ id: string }> }>)
    .filter((entry) => entry.displayName === 'Relay app');
  assert.equal(relayProject.sessions.length, 1);
  assert.equal((await fetch(`${relay.localUrl}/health`)).status, 200);

  const create = await remote('/api/providers/sessions', {
    method: 'POST',
    body: { provider: 'claude', projectId: relayProject.projectId, initialMessage: 'anyone?', runtimeNodeId: nas.credential.nodeId },
  });
  assert.equal(create.status, 409);
  assert.equal((await create.json() as { error: { code: string } }).error.code, 'RUNTIME_NODE_UNAVAILABLE');

  const history = await remote(`/api/providers/sessions/${relayProject.sessions[0].id}/messages`);
  assert.equal(history.status, 409);
  assert.equal((await history.json() as { error: { code: string } }).error.code, 'RUNTIME_NODE_OFFLINE');

  const chat = openRemoteChat();
  await chat.ready;
  chat.send({ type: 'chat.send', sessionId: relayProject.sessions[0].id, content: 'anyone?' });
  const refusal = await chat.waitFor((frame) => frame.kind === 'protocol_error', 'offline refusal');
  assert.equal(refusal.code, 'RUNTIME_NODE_OFFLINE');
  chat.socket.close();
  assert.equal(nas.recording.runs.length + laptop.recording.runs.length, 2, 'no run anywhere');
  assert.deepEqual(spawned, []);
});

test('revocation is terminal: a revoked node is refused as a target and can never link again', { concurrency: false }, async () => {
  const revoked = await remote(`/api/runtime-nodes/${laptop.credential.nodeId}/revoke`, { method: 'POST' });
  assert.equal(revoked.status, 200);
  const view = await nodeView(laptop.credential.nodeId);
  assert.deepEqual([view?.canExecute, view?.availability.reason], [false, 'revoked']);

  laptop.reconnect();
  const stop = await Promise.race([laptop.done, sleep(4_000).then(() => ({ reason: 'still retrying' }))]);
  assert.deepEqual(stop, { reason: 'authentication_failed' });

  const projects = await remote('/api/projects');
  const [relayProject] = (await projects.json() as Array<{ projectId: string; displayName: string }>).filter((entry) => entry.displayName === 'Relay app');
  const create = await remote('/api/providers/sessions', {
    method: 'POST',
    body: { provider: 'claude', projectId: relayProject.projectId, initialMessage: 'x', runtimeNodeId: laptop.credential.nodeId },
  });
  assert.equal((await create.json() as { error: { code: string } }).error.code, 'RUNTIME_NODE_REVOKED');
});

test('startup refusals: a control plane database, platform mode or a public app listener never become a relay', { concurrency: false }, async () => {
  const { createHostedRelay } = await import('@/modules/hosted-relay/index.js');
  const base = { env: {}, appRoot, runningVersion: 'test', port: 0 };

  await assert.rejects(createHostedRelay({ ...base, host: '127.0.0.1', isPlatform: true }).start(), /platform mode/);
  await assert.rejects(createHostedRelay({ ...base, host: '0.0.0.0', isPlatform: false }).start(), /loopback/);

  relay.database.runtimeNodesDb.upsertLocal(randomUUID(), { label: 'a control plane', platform: 'win32', arch: 'x64', runtimeVersion: null });
  await assert.rejects(createHostedRelay({ ...base, host: '127.0.0.1', isPlatform: false }).start(), /control plane/);
});
