// FT-M08 local multi-node TECHNICAL gate. Two node agents run in this process
// with distinct server-minted identities, their own Ed25519 keys, isolated
// workspace roots and recording provider runtimes; they talk to a real control
// plane (HTTP enrollment, signed WebSocket links, chat websocket) over real
// loopback sockets. This proves the protocol and routing; it is NOT a
// validation on separate physical machines.
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createRequire } from 'node:module';

import express, { type NextFunction, type Request, type Response } from 'express';
import { WebSocket } from 'ws';

import type { ProviderRuntimeWriter, RuntimeNodeProbeOutcome } from '@/shared/types.js';
import { signRuntimeNodeLinkRequest, RUNTIME_NODE_LINK_PATH } from '@/shared/utils.js';

type Deferred = { promise: Promise<void>; resolve(): void };
const deferred = (): Deferred => {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

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

type RunMode = 'quick' | 'slow' | 'approval';
type RecordedRun = { command: string; options: Record<string, unknown>; writer: ProviderRuntimeWriter; release: Deferred };

const PROVEN_PROBE: Record<string, RuntimeNodeProbeOutcome> = {
  'claude-cli': { outcome: 'proven', detail: '2.1.220 (Claude Code)' },
  'git-cli': { outcome: 'proven', detail: 'git version 2.45.0' },
  'workspace-filesystem': { outcome: 'proven' },
  'background-execution': { outcome: 'not_probed', reason: 'no_probe_available' },
};

function createRecordingRuntime(label: string) {
  const runs: RecordedRun[] = [];
  const aborts: string[] = [];
  const approvals: Array<{ requestId: string; sessionId: string | null | undefined }> = [];
  let mode: RunMode = 'quick';
  let approvalGate: Deferred | null = null;
  return {
    runs,
    aborts,
    approvals,
    setMode(next: RunMode) {
      mode = next;
    },
    runtime: {
      async run(_provider: 'claude', command: string, options: Record<string, unknown>, writer: ProviderRuntimeWriter) {
        const release = deferred();
        runs.push({ command, options, writer, release });
        writer.send({ kind: 'session_created', newSessionId: `${label}-native-${runs.length}` });
        writer.send({ kind: 'text', content: `ran on ${label}: part-1` });
        if (mode === 'slow') {
          await release.promise;
          writer.send({ kind: 'text', content: `ran on ${label}: part-2` });
        }
        if (mode === 'approval') {
          approvalGate = deferred();
          writer.send({ kind: 'permission_request', requestId: 'approval-1', toolName: 'Bash', input: { command: 'ls' }, expiresAt: null });
          await approvalGate.promise;
          writer.send({ kind: 'permission_resolved', requestId: 'approval-1', allow: true });
        }
        if (!aborts.includes(String(options.sessionId))) {
          writer.send({ kind: 'complete', exitCode: 0 });
        }
      },
      async abort(_provider: 'claude', sessionId: string) {
        aborts.push(sessionId);
        runs.filter((run) => run.options.sessionId === sessionId).forEach((run) => run.release.resolve());
        return true;
      },
      resolveToolApproval(requestId: string, _decision: unknown, scope?: { sessionId?: string | null }) {
        approvals.push({ requestId, sessionId: scope?.sessionId });
        approvalGate?.resolve();
        return { status: 'accepted' as const };
      },
    },
  };
}

type ControlPlane = Awaited<ReturnType<typeof startControlPlane>>;
type NodeHandle = Awaited<ReturnType<typeof startNode>>;

let directory: string;
let cp: ControlPlane;
let nas: NodeHandle;
let laptop: NodeHandle;

async function startControlPlane(base: string) {
  process.env.DATABASE_PATH = path.join(base, 'control-plane.db');
  const database = await import('@/modules/database/index.js');
  await database.initializeDatabase();
  const bcrypt = createRequire(import.meta.url)('bcrypt') as { hash(value: string, rounds: number): Promise<string> };
  database.userDb.createUser('robin', await bcrypt.hash('pw-123456', 4));

  const auth = await import('@/modules/auth/index.js');
  const { createWebSocketServer, chatRunRegistry } = await import('@/modules/websocket/index.js');
  const { createRuntimeNodeLinkService } = await import('@/modules/runtime-nodes/runtime-node-link.service.js');
  const { createRuntimeNodeRemoteExecutionService } = await import('@/modules/runtime-nodes/runtime-node-remote-execution.service.js');
  const { createRuntimeNodesService } = await import('@/modules/runtime-nodes/runtime-nodes.service.js');
  const { createRuntimeNodesRouter } = await import('@/modules/runtime-nodes/runtime-nodes.routes.js');
  const { createRuntimeNodeLinkRouter } = await import('@/modules/runtime-nodes/runtime-node-link.routes.js');

  const link = createRuntimeNodeLinkService({
    getCredential: (nodeId) => database.runtimeNodeCredentialsDb.getByNodeId(nodeId),
    recordHello: (nodeId, facts, at) => {
      database.runtimeNodesDb.updateRemoteFacts(nodeId, facts);
      database.runtimeNodesDb.recordSeen(nodeId, at);
    },
    recordSeen: (nodeId, at) => database.runtimeNodesDb.recordSeen(nodeId, at),
  });
  const remoteExecution = createRuntimeNodeRemoteExecutionService({
    link,
    ackTimeoutMs: 2_000,
    reconnectGraceMs: 1_500,
    cancelTimeoutMs: 2_000,
    requestTimeoutMs: 4_000,
    onWorkspaceRejected: (nodeId, projectPath) => database.runtimeNodeWorkspacesDb.markUnavailable(nodeId, projectPath, 'rejected_by_node', Date.now()),
  });
  const nodes = createRuntimeNodesService({
    link,
    remoteExecution,
    probeCapabilities: async () => PROVEN_PROBE as never,
    readHostFacts: () => ({ hostname: 'control-plane', platform: 'linux', arch: 'x64' }),
  });
  const localRuntime = createRecordingRuntime('control-plane');

  const app = express();
  app.use(express.json());
  app.use('/api/auth', auth.authRoutes);
  app.use('/api/runtime-node-link', createRuntimeNodeLinkRouter(nodes));
  app.use('/api/runtime-nodes', auth.authenticateToken, createRuntimeNodesRouter(nodes));
  app.use((error: { statusCode?: number; code?: string }, _req: Request, res: Response, _next: NextFunction) => {
    res.status(error.statusCode ?? 500).json({ success: false, error: { code: error.code } });
  });
  const server = http.createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;

  const noop = () => null;
  const wss = createWebSocketServer(server, {
    verifyClient: {
      isPlatform: false,
      authenticateWebSocket: auth.authenticateWebSocket,
      allowedOrigins: new Set(),
      nodeLink: { path: link.path, verify: (upgradeRequest) => link.verifyUpgrade(upgradeRequest) },
    },
    handleNodeLinkConnection: (ws, upgradeRequest) => link.handleConnection(ws, upgradeRequest),
    chat: {
      runtime: {
        hasRuntime: () => true,
        run: (provider, command, options, writer) => localRuntime.runtime.run('claude', command, options, writer),
        abort: (_provider, sessionId) => localRuntime.runtime.abort('claude', sessionId),
        resolveToolApproval: () => ({ status: 'rejected', reason: 'not_found' }),
        getPendingApprovalsForSession: () => [],
        getRecentPermissionOutcomesForSession: () => [],
      },
      runtimeNodes: { resolveSessionExecution: nodes.resolveSessionExecution, remoteExecution },
    },
    shell: { resolveProviderSessionId: noop, resolveClaudeProfileConfigDir: noop, resolveSessionClaudeProfileId: noop } as never,
    getPluginPort: noop as never,
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'robin', password: 'pw-123456' }),
  });
  const { token } = await login.json() as { token: string };

  const projectPath = path.join(base, 'control-plane', 'app');
  await mkdir(projectPath, { recursive: true });
  database.projectsDb.createProjectPath(projectPath);
  const projectId = database.projectsDb.getProjectPath(projectPath)?.project_id as string;

  return { database, auth, link, remoteExecution, nodes, localRuntime, chatRunRegistry, server, wss, port, baseUrl, token, projectPath, projectId };
}

async function enroll(label: string) {
  const created = await fetch(`${cp.baseUrl}/api/runtime-nodes/enrollments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cp.token}` },
    body: JSON.stringify({ label }),
  });
  assert.equal(created.status, 201);
  const { data } = await created.json() as { data: { code: string } };
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const redeemed = await fetch(`${cp.baseUrl}/api/runtime-node-link/enroll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // A client-chosen node id is simply not part of the contract.
    body: JSON.stringify({ code: data.code, publicKey: publicKeyPem, label, nodeId: 'i-choose-my-id', platform: 'linux', arch: 'arm64', runtimeVersion: '1.37.2' }),
  });
  assert.equal(redeemed.status, 201);
  const { data: enrolled } = await redeemed.json() as { data: { nodeId: string } };
  assert.notEqual(enrolled.nodeId, 'i-choose-my-id');
  return {
    version: 1 as const,
    serverOrigin: cp.baseUrl,
    nodeId: enrolled.nodeId,
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem,
    enrolledAt: new Date().toISOString(),
  };
}

async function startNode(label: string, base: string) {
  // eslint-disable-next-line boundaries/dependencies -- the technical gate drives the real node agent, whose only public API is its CLI.
  const { createNodeAgentExecutor } = await import('@/modules/node-agent/node-agent-executor.service.js');
  // eslint-disable-next-line boundaries/dependencies -- see above.
  const { createNodeAgentLinkClient } = await import('@/modules/node-agent/node-agent-link.client.js');

  const workspaceRoot = path.join(base, `${label}-workspaces`);
  const projectFolder = path.join(workspaceRoot, 'app');
  const outsideFolder = path.join(base, `${label}-outside`);
  await mkdir(projectFolder, { recursive: true });
  await mkdir(outsideFolder, { recursive: true });
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
    graceMs: 1_200,
    probe: async () => PROVEN_PROBE,
    send: (frame) => client.send(frame),
  });
  const connect = () => {
    client = createNodeAgentLinkClient({
      credential,
      linkUrl: `ws://127.0.0.1:${cp.port}${RUNTIME_NODE_LINK_PATH}`,
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
    label,
    credential,
    recording,
    executor,
    workspaceRoot,
    projectFolder,
    outsideFolder,
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

function openChat() {
  const frames: Array<Record<string, unknown>> = [];
  const socket = new WebSocket(`ws://127.0.0.1:${cp.port}/ws?token=${cp.token}`);
  socket.on('message', (raw) => frames.push(JSON.parse(raw.toString())));
  const ready = once(socket, 'open');
  return {
    socket,
    frames,
    ready,
    send: (payload: Record<string, unknown>) => socket.send(JSON.stringify(payload)),
    waitFor: (predicate: (frame: Record<string, unknown>) => boolean, description: string, timeoutMs?: number) =>
      waitFor(() => frames.find(predicate), description, timeoutMs),
  };
}

const nodeCanExecute = (nodeId: string) => cp.nodes.getNodeView(nodeId)?.canExecute === true;

function createRemoteSession(nodeId: string): string {
  const sessionId = randomUUID();
  // The service rules a new session goes through, then the same insert sessionsService performs.
  assert.equal(cp.nodes.resolveExecutionTarget(nodeId), nodeId);
  cp.nodes.assertNodeCanRun(nodeId, { provider: 'claude', claudeProfileId: null, projectPath: cp.projectPath });
  cp.database.sessionsDb.createAppSession(sessionId, 'claude', cp.projectPath, 'Remote run', null, nodeId);
  return sessionId;
}

before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'multi-node-gate-'));
  cp = await startControlPlane(directory);
  nas = await startNode('nas', directory);
  laptop = await startNode('laptop', directory);
  await waitFor(() => nodeCanExecute(nas.credential.nodeId) && nodeCanExecute(laptop.credential.nodeId), 'both nodes to prove Claude on their links');
});

after(async () => {
  nas?.client.stop();
  laptop?.client.stop();
  for (const client of cp?.wss.clients ?? []) {
    client.terminate();
  }
  cp?.wss.close();
  await new Promise<void>((resolve) => (cp ? cp.server.close(() => resolve()) : resolve()));
  cp?.database.closeConnection();
  await rm(directory, { recursive: true, force: true });
});

test('each node authenticates with its own server-minted identity; browsers, forged ids, stale or replayed headers get no link', { concurrency: false }, async () => {
  const listing = await fetch(`${cp.baseUrl}/api/runtime-nodes`, { headers: { Authorization: `Bearer ${cp.token}` } });
  const body = await listing.text();
  const { data } = JSON.parse(body) as { data: { nodes: Array<{ nodeId: string; isLocal: boolean; canExecute: boolean; evidence: string; enrollment: string; availability: { reason: string } }> } };
  const remote = data.nodes.filter((node) => !node.isLocal);
  assert.equal(remote.length, 2);
  assert.notEqual(nas.credential.nodeId, laptop.credential.nodeId);
  for (const node of remote) {
    assert.deepEqual([node.canExecute, node.evidence, node.enrollment, node.availability.reason], [true, 'node_probe', 'active', 'link_connected']);
  }
  assert.equal(body.includes(nas.workspaceRoot) || body.includes(laptop.workspaceRoot), false, 'no node path in the listing');

  const browserEnroll = await fetch(`${cp.baseUrl}/api/runtime-node-link/enroll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: JSON.stringify({ code: '0000-0000-0000', publicKey: nas.credential.publicKeyPem }),
  });
  assert.equal(browserEnroll.status, 403);

  const attempt = (headers: Record<string, string>) => new Promise<number>((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${cp.port}${RUNTIME_NODE_LINK_PATH}`, { headers });
    socket.once('open', () => {
      socket.close();
      resolve(101);
    });
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    socket.once('error', () => resolve(0));
  });
  const sign = (nodeId: string, privateKeyPem: string, timestamp = Date.now()) =>
    signRuntimeNodeLinkRequest({ nodeId, privateKeyPem, path: RUNTIME_NODE_LINK_PATH, timestamp });

  assert.equal(await attempt({ Authorization: sign(nas.credential.nodeId, nas.credential.privateKeyPem), Origin: 'https://evil.example' }), 401, 'a browser can never open a node link');
  assert.equal(await attempt({ Authorization: sign(nas.credential.nodeId, laptop.credential.privateKeyPem) }), 401, 'claiming another node id');
  assert.equal(await attempt({ Authorization: sign(randomUUID(), nas.credential.privateKeyPem) }), 401, 'unknown node id');
  assert.equal(await attempt({ Authorization: sign(nas.credential.nodeId, nas.credential.privateKeyPem, Date.now() - 10 * 60_000) }), 401, 'stale timestamp');
  assert.equal(await attempt({ Authorization: `Bearer ${cp.token}` }), 401, 'a user token is not a node credential');

  // A captured header works once at most. (The nonce below was already accepted when the laptop last connected? No: sign a fresh one and replay it.)
  const extra = await enroll('replay-probe');
  const header = sign(extra.nodeId, extra.privateKeyPem);
  assert.equal(await attempt({ Authorization: header }), 101);
  assert.equal(await attempt({ Authorization: header }), 401, 'replayed signed header');
  await fetch(`${cp.baseUrl}/api/runtime-nodes/${extra.nodeId}/revoke`, { method: 'POST', headers: { Authorization: `Bearer ${cp.token}` } });
});

test('workspace truth: a node verifies mapped folders inside its own root, and nothing is assumed portable', { concurrency: false }, async () => {
  const map = (nodeId: string, folder: string) => fetch(`${cp.baseUrl}/api/runtime-nodes/${nodeId}/workspaces/${cp.projectId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cp.token}` },
    body: JSON.stringify({ path: folder }),
  });

  assert.throws(
    () => cp.nodes.assertNodeCanRun(nas.credential.nodeId, { provider: 'claude', claudeProfileId: null, projectPath: cp.projectPath }),
    { code: 'RUNTIME_NODE_WORKSPACE_UNAVAILABLE' },
    'the control plane path is not assumed to exist on the node',
  );

  const outside = await map(nas.credential.nodeId, nas.outsideFolder);
  assert.equal(outside.status, 422);
  const controlPlanePath = await map(nas.credential.nodeId, cp.projectPath);
  assert.equal(controlPlanePath.status, 422, 'the control plane folder is outside the node root');

  const mapped = await map(nas.credential.nodeId, nas.projectFolder);
  assert.equal(mapped.status, 200);
  assert.equal((await mapped.json() as { data: { workspace: { state: string } } }).data.workspace.state, 'mapped');

  const listing = await cp.nodes.listNodes({ projectId: cp.projectId });
  const states = Object.fromEntries(listing.nodes.map((node) => [node.isLocal ? 'local' : node.label, node.workspace?.state]));
  assert.deepEqual(states, { local: 'available', nas: 'mapped', laptop: 'unmapped', 'replay-probe': 'unmapped' });
  assert.equal(JSON.stringify(listing).includes(nas.projectFolder), false);

  assert.throws(() => cp.nodes.assertNodeCanRun(nas.credential.nodeId, { provider: 'codex', claudeProfileId: null, projectPath: cp.projectPath }), { code: 'RUNTIME_NODE_PROVIDER_UNSUPPORTED' });
  assert.throws(() => cp.nodes.assertNodeCanRun(nas.credential.nodeId, { provider: 'claude', claudeProfileId: 'work', projectPath: cp.projectPath }), { code: 'RUNTIME_NODE_PROFILE_UNAVAILABLE' });
  assert.throws(() => cp.nodes.resolveExecutionTarget(), { code: 'RUNTIME_NODE_REQUIRED' }, 'several nodes: nothing is implied');
});

test('a run executes only on its selected node and streams back in order with its provenance', { concurrency: false }, async () => {
  const sessionId = createRemoteSession(nas.credential.nodeId);
  const chat = openChat();
  await chat.ready;
  chat.send({ type: 'chat.send', sessionId, content: 'hello nas', options: { model: 'opus', cwd: '/etc', claudeProfileId: 'work' } });
  await chat.waitFor((frame) => frame.kind === 'complete' && frame.sessionId === sessionId, 'remote completion');

  assert.equal(nas.recording.runs.length, 1);
  assert.equal(laptop.recording.runs.length, 0, 'the other node never received the run');
  assert.equal(cp.localRuntime.runs.length, 0, 'the control plane never ran it locally');
  const run = nas.recording.runs[0];
  assert.equal(run.command, 'hello nas');
  assert.equal(run.options.cwd, await realpath(nas.projectFolder), 'cwd comes from the verified mapping, never the client');
  assert.equal(run.options.claudeProfileId, undefined);

  const streamed = chat.frames.filter((frame) => frame.sessionId === sessionId && typeof frame.seq === 'number');
  assert.deepEqual(streamed.map((frame) => frame.kind), ['text', 'complete']);
  assert.equal(streamed[0].content, 'ran on nas: part-1');
  assert.ok((streamed[1].seq as number) > (streamed[0].seq as number));

  const row = cp.database.sessionsDb.getSessionById(sessionId);
  assert.equal(row?.runtime_node_id, nas.credential.nodeId, 'runtime binding unchanged');
  assert.equal(row?.provider_session_id, 'nas-native-1', 'native id captured from the node');
  assert.equal(cp.chatRunRegistry.isProcessing(sessionId), false);
  chat.socket.close();
});

test('an offline bound node fails explicitly and nothing fails over, even to a capable node', { concurrency: false }, async () => {
  const mapLaptop = await fetch(`${cp.baseUrl}/api/runtime-nodes/${laptop.credential.nodeId}/workspaces/${cp.projectId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cp.token}` },
    body: JSON.stringify({ path: laptop.projectFolder }),
  });
  assert.equal(mapLaptop.status, 200, 'the laptop could run this project too');

  const sessionId = createRemoteSession(nas.credential.nodeId);
  nas.client.stop();
  await waitFor(() => !nodeCanExecute(nas.credential.nodeId), 'nas to go offline');

  const chat = openChat();
  await chat.ready;
  const laptopRunsBefore = laptop.recording.runs.length;
  const nasRunsBefore = nas.recording.runs.length;
  chat.send({ type: 'chat.send', sessionId, content: 'while offline' });
  const refused = await chat.waitFor((frame) => frame.kind === 'protocol_error', 'offline refusal');
  assert.equal(refused.code, 'RUNTIME_NODE_OFFLINE');
  const alternatives = (refused.alternatives as Array<{ nodeId: string }>).map((entry) => entry.nodeId);
  assert.ok(alternatives.includes(laptop.credential.nodeId), 'a capable node is suggested');
  await sleep(200);
  assert.equal(laptop.recording.runs.length, laptopRunsBefore, '...but never substituted');
  assert.equal(nas.recording.runs.length, nasRunsBefore);
  assert.equal(cp.localRuntime.runs.length, 0);
  assert.equal(cp.database.sessionsDb.getSessionById(sessionId)?.runtime_node_id, nas.credential.nodeId);
  assert.throws(() => cp.nodes.resolveExecutionTarget(nas.credential.nodeId), { code: 'RUNTIME_NODE_UNAVAILABLE' });

  nas.reconnect();
  await waitFor(() => nodeCanExecute(nas.credential.nodeId), 'nas to reconnect');
  chat.send({ type: 'chat.send', sessionId, content: 'after reconnect' });
  await chat.waitFor((frame) => frame.kind === 'complete' && frame.sessionId === sessionId, 'completion after reconnect');
  assert.equal(nas.recording.runs.length, nasRunsBefore + 1);
  chat.socket.close();
});

test('a dropped link resumes the same run without duplicating execution or events', { concurrency: false }, async () => {
  const sessionId = createRemoteSession(nas.credential.nodeId);
  nas.recording.setMode('slow');
  const chat = openChat();
  await chat.ready;
  const runsBefore = nas.recording.runs.length;
  chat.send({ type: 'chat.send', sessionId, content: 'long task' });
  await chat.waitFor((frame) => frame.sessionId === sessionId && frame.content === 'ran on nas: part-1', 'first part');

  cp.link.disconnect(nas.credential.nodeId, 1012, 'network blip');
  await sleep(50);
  nas.recording.runs.at(-1)?.release.resolve();
  await waitFor(() => nodeCanExecute(nas.credential.nodeId), 'nas link to come back');
  await chat.waitFor((frame) => frame.kind === 'complete' && frame.sessionId === sessionId, 'completion after resume');

  const texts = chat.frames.filter((frame) => frame.sessionId === sessionId && frame.kind === 'text').map((frame) => frame.content);
  assert.deepEqual(texts, ['ran on nas: part-1', 'ran on nas: part-2'], 'every event exactly once');
  assert.equal(chat.frames.filter((frame) => frame.sessionId === sessionId && frame.kind === 'complete').length, 1);
  assert.equal(nas.recording.runs.length, runsBefore + 1, 'the run was never re-dispatched');
  assert.equal(chat.frames.some((frame) => frame.kind === 'error'), false);
  nas.recording.setMode('quick');
  chat.socket.close();
});

test('a link that stays down fails the run explicitly, and the node stops it instead of running unobserved', { concurrency: false }, async () => {
  const sessionId = createRemoteSession(nas.credential.nodeId);
  nas.recording.setMode('slow');
  const chat = openChat();
  await chat.ready;
  chat.send({ type: 'chat.send', sessionId, content: 'doomed task' });
  await chat.waitFor((frame) => frame.sessionId === sessionId && frame.content === 'ran on nas: part-1', 'first part');

  nas.client.stop();
  const failure = await chat.waitFor((frame) => frame.kind === 'error' && frame.sessionId === sessionId, 'explicit disconnect failure', 6_000);
  assert.match(String(failure.content), /not moved to another node/);
  const complete = await chat.waitFor((frame) => frame.kind === 'complete' && frame.sessionId === sessionId, 'terminal complete');
  assert.equal(complete.exitCode, 1);
  await waitFor(() => nas.recording.aborts.includes(sessionId), 'the node to abort the unobserved run', 6_000);
  assert.equal(laptop.recording.runs.some((run) => run.options.sessionId === sessionId), false);

  nas.recording.setMode('quick');
  nas.reconnect();
  await waitFor(() => nodeCanExecute(nas.credential.nodeId), 'nas to reconnect');
  chat.socket.close();
});

test('a replayed dispatch never runs twice, and one node cannot write into another node\'s run', { concurrency: false }, async () => {
  const sessionId = createRemoteSession(nas.credential.nodeId);
  nas.recording.setMode('slow');
  const chat = openChat();
  await chat.ready;
  chat.send({ type: 'chat.send', sessionId, content: 'target of forgery' });
  await chat.waitFor((frame) => frame.sessionId === sessionId && frame.content === 'ran on nas: part-1', 'first part');
  const [{ executionId, lastSeq }] = nas.executor.activeExecutions();

  // The laptop (authenticated as itself) tries to inject into the NAS run.
  laptop.client.send({ type: 'run.event', executionId, seq: lastSeq + 50, message: { kind: 'text', content: 'forged by laptop' } });
  laptop.client.send({ type: 'run.finished', executionId, seq: lastSeq + 51, outcome: 'completed' });
  // The NAS itself tries to impersonate gateway events and to prove capabilities nobody asked for.
  nas.client.send({ type: 'run.event', executionId, seq: lastSeq + 1, message: { kind: 'session_upserted', sessionId: 'x' } });
  nas.client.send({ type: 'probe.result', requestId: 'unsolicited', outcomes: { 'root-shell': { outcome: 'proven' } } } as never);
  await sleep(150);
  assert.equal(chat.frames.some((frame) => frame.content === 'forged by laptop'), false);
  // The server's own session_upserted broadcasts are legitimate; the node's forged one (sessionId "x") must not appear.
  assert.equal(chat.frames.some((frame) => frame.kind === 'session_upserted' && frame.sessionId === 'x'), false);
  assert.equal(cp.chatRunRegistry.isProcessing(sessionId), true, 'a forged finish did not end the run');
  assert.equal(JSON.stringify(cp.nodes.getNodeView(nas.credential.nodeId)?.capabilities).includes('root-shell'), false);

  nas.recording.runs.at(-1)?.release.resolve();
  await chat.waitFor((frame) => frame.kind === 'complete' && frame.sessionId === sessionId, 'real completion');

  const runsBefore = nas.recording.runs.length;
  const replayed = { type: 'run.start', executionId, appSessionId: sessionId, provider: 'claude', providerSessionId: null, command: 'again', cwd: await realpath(nas.projectFolder), options: {} } as const;
  assert.equal(cp.link.send(nas.credential.nodeId, replayed), true);
  await sleep(150);
  assert.equal(nas.recording.runs.length, runsBefore, 'a replayed execution id is refused by the node');
  nas.recording.setMode('quick');
  chat.socket.close();
});

test('approvals and abort reach the node that owns the run; a refreshed client sees the pending remote approval', { concurrency: false }, async () => {
  const sessionId = createRemoteSession(nas.credential.nodeId);
  nas.recording.setMode('approval');
  const chat = openChat();
  await chat.ready;
  chat.send({ type: 'chat.send', sessionId, content: 'needs approval' });
  await chat.waitFor((frame) => frame.kind === 'permission_request' && frame.sessionId === sessionId, 'approval request');

  const refreshed = openChat();
  await refreshed.ready;
  refreshed.send({ type: 'chat.subscribe', sessions: [{ sessionId, lastSeq: 0 }] });
  const subscribed = await refreshed.waitFor((frame) => frame.kind === 'chat_subscribed', 'subscription');
  assert.equal(subscribed.isProcessing, true);
  assert.deepEqual((subscribed.pendingPermissions as Array<{ requestId: string }>).map((entry) => entry.requestId), ['approval-1']);

  refreshed.send({ type: 'chat.permission-response', requestId: 'approval-1', sessionId: randomUUID(), allow: true });
  const mismatch = await refreshed.waitFor((frame) => frame.kind === 'permission_response_ack', 'mismatch ack');
  assert.deepEqual([mismatch.accepted, mismatch.reason], [false, 'session_mismatch']);

  refreshed.send({ type: 'chat.permission-response', requestId: 'approval-1', sessionId, allow: true });
  await refreshed.waitFor((frame) => frame.kind === 'permission_response_ack' && frame.accepted === true, 'accepted ack');
  // chat.subscribe moved the live stream to the refreshed socket, exactly like a page reload.
  await refreshed.waitFor((frame) => frame.kind === 'complete' && frame.sessionId === sessionId, 'completion after approval');
  assert.deepEqual(nas.recording.approvals, [{ requestId: 'approval-1', sessionId }]);
  assert.deepEqual(laptop.recording.approvals, []);

  nas.recording.setMode('slow');
  const abortSession = createRemoteSession(nas.credential.nodeId);
  chat.send({ type: 'chat.send', sessionId: abortSession, content: 'to be stopped' });
  await chat.waitFor((frame) => frame.sessionId === abortSession && frame.content === 'ran on nas: part-1', 'slow run started');
  chat.send({ type: 'chat.abort', sessionId: abortSession });
  const aborted = await chat.waitFor((frame) => frame.kind === 'complete' && frame.sessionId === abortSession, 'aborted completion');
  assert.equal(aborted.aborted, true);
  assert.ok(nas.recording.aborts.includes(abortSession));
  assert.equal(laptop.recording.aborts.includes(abortSession), false);
  nas.recording.setMode('quick');
  chat.socket.close();
  refreshed.socket.close();
});

test('remote history is read from the owning node; revocation is terminal, immediate and survives reconnect attempts', { concurrency: false }, async () => {
  const sessionId = createRemoteSession(nas.credential.nodeId);
  cp.database.sessionsDb.assignProviderSessionId(sessionId, 'nas-native-history');
  const row = cp.database.sessionsDb.getSessionById(sessionId);
  const history = await cp.nodes.fetchRemoteHistory(row as never, { limit: null, offset: 0 });
  assert.deepEqual(history.messages.map((message) => (message as { content?: string }).content), ['history stored on nas']);

  const revoked = await fetch(`${cp.baseUrl}/api/runtime-nodes/${laptop.credential.nodeId}/revoke`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cp.token}` },
  });
  assert.equal(revoked.status, 200);
  assert.deepEqual(await laptop.done, { reason: 'revoked' }, 'the agent stops for good');
  const view = cp.nodes.getNodeView(laptop.credential.nodeId);
  assert.deepEqual([view?.enrollment, view?.availability.reason, view?.canExecute], ['revoked', 'revoked', false]);
  assert.throws(() => cp.nodes.resolveExecutionTarget(laptop.credential.nodeId), { code: 'RUNTIME_NODE_REVOKED' });

  laptop.reconnect();
  const stop = await Promise.race([laptop.done, sleep(4_000).then(() => ({ reason: 'still retrying' }))]);
  assert.deepEqual(stop, { reason: 'authentication_failed' }, 'a revoked credential never links again');
});
