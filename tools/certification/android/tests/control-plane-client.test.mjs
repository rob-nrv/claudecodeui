import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ControlPlaneError,
  createSession,
  findNodeByLabel,
  getWorkspaceState,
  listNodes,
  login,
  mapWorkspace,
  revokeNode,
  unmapWorkspace,
} from '../lib/control-plane-client.mjs';

/** A fake fetch that records every call and answers from a canned map keyed by "METHOD path". */
function fakeFetch(canned) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    const path = new URL(url).pathname + new URL(url).search;
    calls.push({ method, path, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    const key = `${method} ${path}`;
    const exact = canned[key];
    const withoutQuery = canned[`${method} ${new URL(url).pathname}`];
    const entry = exact ?? withoutQuery;
    if (!entry) {
      throw new Error(`fakeFetch: no canned response for ${key}`);
    }
    return {
      ok: entry.status >= 200 && entry.status < 300,
      status: entry.status,
      text: async () => JSON.stringify(entry.body),
    };
  };
  impl.calls = calls;
  return impl;
}

test('login sends username/password and returns the token, using the real /api/auth/login shape ({success,user,token} — no data wrapper)', async () => {
  const fetchImpl = fakeFetch({
    'POST /api/auth/login': { status: 200, body: { success: true, user: { id: 1, username: 'robin' }, token: 'jwt-abc' } },
  });
  const token = await login('https://cp.example', 'robin', 'pw', fetchImpl);
  assert.equal(token, 'jwt-abc');
  assert.deepEqual(fetchImpl.calls[0].body, { username: 'robin', password: 'pw' });
  assert.equal(fetchImpl.calls[0].headers.Authorization, undefined, 'login itself carries no bearer token');
});

test('login throws a ControlPlaneError with the real AppError envelope on invalid credentials', async () => {
  const fetchImpl = fakeFetch({
    'POST /api/auth/login': { status: 401, body: { success: false, error: { code: 'AUTH_INVALID_CREDENTIALS', message: 'Invalid username or password' } } },
  });
  await assert.rejects(
    () => login('https://cp.example', 'robin', 'wrong', fetchImpl),
    (error) => {
      assert.ok(error instanceof ControlPlaneError);
      assert.equal(error.code, 'AUTH_INVALID_CREDENTIALS');
      assert.equal(error.status, 401);
      return true;
    },
  );
});

test('login throws even on a 200 with no token, rather than returning undefined silently', async () => {
  const fetchImpl = fakeFetch({ 'POST /api/auth/login': { status: 200, body: { success: true } } });
  await assert.rejects(() => login('https://cp.example', 'a', 'b', fetchImpl), /no token was returned/);
});

test('listNodes sends the bearer token and unwraps the {success,data} envelope', async () => {
  const listing = { nodes: [{ nodeId: 'pixel-hc06', label: 'Pixel HC-06', canExecute: true }] };
  const fetchImpl = fakeFetch({ 'GET /api/runtime-nodes': { status: 200, body: { success: true, data: listing } } });
  const result = await listNodes('https://cp.example', 'jwt-abc', {}, fetchImpl);
  assert.deepEqual(result, listing);
  assert.equal(fetchImpl.calls[0].headers.Authorization, 'Bearer jwt-abc');
});

test('listNodes with refresh/projectId builds the exact query string', async () => {
  const fetchImpl = fakeFetch({ 'GET /api/runtime-nodes?refresh=true&projectId=proj-1': { status: 200, body: { success: true, data: { nodes: [] } } } });
  await listNodes('https://cp.example', 't', { refresh: true, projectId: 'proj-1' }, fetchImpl);
  assert.equal(fetchImpl.calls[0].path, '/api/runtime-nodes?refresh=true&projectId=proj-1');
});

test('findNodeByLabel finds the exact labeled node and never matches by substring', () => {
  const listing = { nodes: [{ nodeId: 'a', label: 'Pixel HC-06' }, { nodeId: 'b', label: 'Pixel HC-05' }] };
  assert.deepEqual(findNodeByLabel(listing, 'Pixel HC-06'), { nodeId: 'a', label: 'Pixel HC-06' });
  assert.equal(findNodeByLabel(listing, 'Pixel HC-0'), null);
  assert.equal(findNodeByLabel({ nodes: [] }, 'Pixel HC-06'), null);
});

test('mapWorkspace PUTs the path and returns the workspace record', async () => {
  const fetchImpl = fakeFetch({
    'PUT /api/runtime-nodes/pixel-hc06/workspaces/proj-1': { status: 200, body: { success: true, data: { workspace: { state: 'mapped' } } } },
  });
  const workspace = await mapWorkspace('https://cp.example', 't', 'pixel-hc06', 'proj-1', '/root/cloudcli-workspaces-hc06/claudecodeui', fetchImpl);
  assert.deepEqual(workspace, { state: 'mapped' });
  assert.deepEqual(fetchImpl.calls[0].body, { path: '/root/cloudcli-workspaces-hc06/claudecodeui' });
  assert.equal(fetchImpl.calls[0].method, 'PUT');
});

test('mapWorkspace accepts a git-verified folder unconditionally (mapping never checks repository identity — that only shows up later, from getWorkspaceState)', async () => {
  const fetchImpl = fakeFetch({
    'PUT /api/runtime-nodes/pixel-hc06/workspaces/proj-1': { status: 200, body: { success: true, data: { workspace: { state: 'mapped', reason: null } } } },
    'GET /api/runtime-nodes/pixel-hc06/workspaces/proj-1/state': {
      status: 200,
      body: { success: true, data: { workspace: { state: 'identity_mismatch', reason: 'different_repository_history' } } },
    },
  });
  const mapped = await mapWorkspace('https://cp.example', 't', 'pixel-hc06', 'proj-1', '/root/cloudcli-workspaces-hc06/mismatch-scratch', fetchImpl);
  assert.equal(mapped.state, 'mapped', 'the PUT itself succeeds — a different node.js RuntimeNode is normal, it never rejects on repository identity');
  const state = await getWorkspaceState('https://cp.example', 't', 'pixel-hc06', 'proj-1', fetchImpl);
  assert.deepEqual(state, { state: 'identity_mismatch', reason: 'different_repository_history' }, 'the mismatch surfaces from the SEPARATE state-inspection route');
});

test('unmapWorkspace DELETEs and getWorkspaceState GETs the /state path', async () => {
  const fetchImpl = fakeFetch({
    'DELETE /api/runtime-nodes/pixel-hc06/workspaces/proj-1': { status: 200, body: { success: true, data: { removed: true } } },
    'GET /api/runtime-nodes/pixel-hc06/workspaces/proj-1/state': { status: 200, body: { success: true, data: { workspace: { state: 'clean' } } } },
  });
  assert.deepEqual(await unmapWorkspace('https://cp.example', 't', 'pixel-hc06', 'proj-1', fetchImpl), { removed: true });
  assert.deepEqual(await getWorkspaceState('https://cp.example', 't', 'pixel-hc06', 'proj-1', fetchImpl), { state: 'clean' });
});

test('createSession posts the runtimeNodeId and returns the allocated session', async () => {
  const fetchImpl = fakeFetch({
    'POST /api/providers/sessions': { status: 201, body: { success: true, data: { sessionId: 'session-xyz' } } },
  });
  const result = await createSession('https://cp.example', 't', { projectPath: '/proj', runtimeNodeId: 'pixel-hc06' }, fetchImpl);
  assert.deepEqual(result, { sessionId: 'session-xyz' });
  assert.deepEqual(fetchImpl.calls[0].body, { provider: 'claude', projectPath: '/proj', runtimeNodeId: 'pixel-hc06' });
});

test('createSession omits runtimeNodeId entirely when not given, rather than sending it as null/undefined', async () => {
  const fetchImpl = fakeFetch({ 'POST /api/providers/sessions': { status: 201, body: { success: true, data: { sessionId: 's' } } } });
  await createSession('https://cp.example', 't', { projectPath: '/proj' }, fetchImpl);
  assert.deepEqual(fetchImpl.calls[0].body, { provider: 'claude', projectPath: '/proj' });
});

test('revokeNode posts to the revoke route', async () => {
  const fetchImpl = fakeFetch({ 'POST /api/runtime-nodes/pixel-hc06/revoke': { status: 200, body: { success: true, data: { revoked: true } } } });
  assert.deepEqual(await revokeNode('https://cp.example', 't', 'pixel-hc06', fetchImpl), { revoked: true });
});

test('a non-JSON error body still produces a ControlPlaneError rather than throwing a JSON.parse error', async () => {
  const fetchImpl = async () => ({ ok: false, status: 502, text: async () => '<html>Bad Gateway</html>' });
  await assert.rejects(
    () => listNodes('https://cp.example', 't', {}, fetchImpl),
    (error) => {
      assert.ok(error instanceof ControlPlaneError);
      assert.equal(error.status, 502);
      return true;
    },
  );
});
