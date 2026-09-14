// A thin, typed wrapper over CloudCLI's EXISTING authenticated REST
// surface (POST /api/auth/login, GET/PUT/DELETE /api/runtime-nodes/...,
// POST /api/providers/sessions) — the same routes the browser itself calls.
// No new endpoint, no auth bypass, no direct database access: every call
// here is something a signed-in operator could do by hand in the UI.
//
// `fetchImpl` is injectable so request construction and response handling
// can be unit-tested against a fake server with no network and no real
// control plane running (see tests/control-plane-client.test.mjs).

export class ControlPlaneError extends Error {
  constructor(message, { status, code, body } = {}) {
    super(message);
    this.name = 'ControlPlaneError';
    this.status = status ?? null;
    this.code = code ?? null;
    this.body = body ?? null;
  }
}

async function request(fetchImpl, url, { method = 'GET', token = null, body = undefined } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetchImpl(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON body (unexpected); parsed stays null, raw text is on the error below.
  }
  if (!response.ok) {
    throw new ControlPlaneError(
      parsed?.error?.message ?? parsed?.message ?? `${method} ${url} failed with HTTP ${response.status}`,
      { status: response.status, code: parsed?.error?.code ?? null, body: parsed ?? text },
    );
  }
  return parsed;
}

/**
 * The one interactive step: exchanges the operator's own credentials for a
 * bearer token, exactly as the browser's login form does. Never logged,
 * never written to any evidence file — callers must keep the returned
 * token in memory only.
 */
export async function login(baseUrl, username, password, fetchImpl = fetch) {
  const result = await request(fetchImpl, `${baseUrl}/api/auth/login`, {
    method: 'POST',
    body: { username, password },
  });
  const token = result?.data?.token ?? result?.token;
  if (!token) {
    throw new ControlPlaneError('Login succeeded but no token was returned.', { body: result });
  }
  return token;
}

export async function listNodes(baseUrl, token, { refresh = false, projectId = null } = {}, fetchImpl = fetch) {
  const query = new URLSearchParams();
  if (refresh) query.set('refresh', 'true');
  if (projectId) query.set('projectId', projectId);
  const suffix = query.toString() ? `?${query.toString()}` : '';
  const result = await request(fetchImpl, `${baseUrl}/api/runtime-nodes${suffix}`, { token });
  return result?.data ?? result;
}

export async function mapWorkspace(baseUrl, token, nodeId, projectId, folderPath, fetchImpl = fetch) {
  const result = await request(fetchImpl, `${baseUrl}/api/runtime-nodes/${encodeURIComponent(nodeId)}/workspaces/${encodeURIComponent(projectId)}`, {
    method: 'PUT',
    token,
    body: { path: folderPath },
  });
  return result?.data?.workspace ?? result;
}

export async function unmapWorkspace(baseUrl, token, nodeId, projectId, fetchImpl = fetch) {
  const result = await request(fetchImpl, `${baseUrl}/api/runtime-nodes/${encodeURIComponent(nodeId)}/workspaces/${encodeURIComponent(projectId)}`, {
    method: 'DELETE',
    token,
  });
  return result?.data ?? result;
}

export async function getWorkspaceState(baseUrl, token, nodeId, projectId, fetchImpl = fetch) {
  const result = await request(fetchImpl, `${baseUrl}/api/runtime-nodes/${encodeURIComponent(nodeId)}/workspaces/${encodeURIComponent(projectId)}/state`, { token });
  return result?.data?.workspace ?? result;
}

/**
 * Allocates a session id bound to `runtimeNodeId` — the same
 * POST /api/providers/sessions the frontend calls before its first
 * `chat.send`. This only allocates the id; dispatching the run still goes
 * over the chat WebSocket (see lib/chat-frame-classifier.mjs for reading
 * the result of that).
 */
export async function createSession(baseUrl, token, { provider = 'claude', projectPath, claudeProfileId = undefined, runtimeNodeId }, fetchImpl = fetch) {
  const result = await request(fetchImpl, `${baseUrl}/api/providers/sessions`, {
    method: 'POST',
    token,
    body: {
      provider,
      projectPath,
      ...(claudeProfileId !== undefined ? { claudeProfileId } : {}),
      ...(runtimeNodeId !== undefined ? { runtimeNodeId } : {}),
    },
  });
  return result?.data ?? result;
}

export async function revokeNode(baseUrl, token, nodeId, fetchImpl = fetch) {
  const result = await request(fetchImpl, `${baseUrl}/api/runtime-nodes/${encodeURIComponent(nodeId)}/revoke`, { method: 'POST', token });
  return result?.data ?? result;
}

/** Finds one node's listing entry by label (evidence should identify nodes by label, e.g. "Pixel HC-06", never by logging the raw id needlessly). */
export function findNodeByLabel(listing, label) {
  return (listing?.nodes ?? []).find((node) => node.label === label) ?? null;
}
