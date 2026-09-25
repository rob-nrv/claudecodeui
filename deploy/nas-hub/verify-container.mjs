#!/usr/bin/env node
// In-container verification of a running Hosted Relay (private test on nas-hub, no network).
// Run it INSIDE the relay's network namespace, as a second process:
//   docker exec -e VERIFY_PASSWORD=... <relay-container> node deploy/verify-container.mjs [--expect-loopback-only]
// It talks to the relay over its own loopback (app listener 3001, gateway 3443) exactly as the
// TLS terminator would: plain HTTP with an X-Forwarded-For value, Origin = the public origin.
// It creates a throwaway account in the relay's database, so use it only on a test volume.
// Secrets: the throwaway password comes from the environment and is never printed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WebSocket } from 'ws';

const APP = `http://127.0.0.1:${process.env.SERVER_PORT || 3001}`;
const GATEWAY = `http://127.0.0.1:${process.env.CLOUDCLI_REMOTE_PORT || 3443}`;
const ORIGIN = process.env.CLOUDCLI_REMOTE_ORIGIN;
const PASSWORD = process.env.VERIFY_PASSWORD;
const expectLoopbackOnly = process.argv.includes('--expect-loopback-only');
if (!ORIGIN || !PASSWORD) {
  console.error('CLOUDCLI_REMOTE_ORIGIN and VERIFY_PASSWORD must be set in the environment.');
  process.exit(2);
}
const sourceConfigured = Boolean(process.env.CLOUDCLI_SOURCE_URL);

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

async function call(base, pathname, { method = 'GET', headers = {}, body, forwardedFor, cookie, bearer } = {}) {
  const response = await fetch(base + pathname, {
    method,
    redirect: 'manual',
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(base === GATEWAY ? { origin: ORIGIN } : {}),
      ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}),
      ...(cookie ? { cookie } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: response.status, headers: response.headers, text, json };
}

function wsStatus(url, headers) {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, { headers });
    const done = (status) => { try { socket.terminate(); } catch { /* closed */ } resolve(status); };
    socket.once('open', () => done(101));
    socket.once('unexpected-response', (_req, res) => done(res.statusCode ?? 0));
    socket.once('error', () => done(0));
    setTimeout(() => done(-1), 8000);
  });
}

// ---- 1. what this container is (isolation facts)
if (process.platform === 'linux') {
  const status = fs.readFileSync('/proc/self/status', 'utf8');
  const uid = status.match(/^Uid:\s+(\d+)/m)?.[1];
  check('runs as an unprivileged user (uid 10001)', uid === '10001', `uid ${uid}`);
  const capEff = status.match(/^CapEff:\s+([0-9a-f]+)/m)?.[1];
  check('no Linux capabilities', /^0+$/.test(capEff ?? 'x'), `CapEff ${capEff}`);
  let writable = true;
  try { fs.writeFileSync('/app/.write-test', 'x'); fs.rmSync('/app/.write-test'); } catch { writable = false; }
  check('application filesystem is read-only', writable === false);
  let dataWritable = true;
  try { fs.accessSync('/data', fs.constants.W_OK); } catch { dataWritable = false; }
  check('/data (the only state) is writable', dataWritable);
  check('no docker.sock inside the container', !fs.existsSync('/var/run/docker.sock') && !fs.existsSync('/run/docker.sock'));
  const suspicious = Object.keys(process.env).filter((name) => /(ANTHROPIC|CLAUDE|OPENAI|GITHUB|GH_|SSH|AWS|TS_AUTHKEY|PASSWORD|SECRET)/i.test(name) && name !== 'VERIFY_PASSWORD');
  check('no provider or infrastructure credential in the environment', suspicious.length === 0, suspicious.join(','));
  const homeEntries = fs.existsSync(os.homedir()) ? fs.readdirSync(os.homedir()).filter((name) => !/^relay\.db/.test(name) && name !== 'backups') : [];
  check('no provider or repository state under HOME', homeEntries.length === 0, homeEntries.join(','));
  const interfaces = Object.keys(os.networkInterfaces());
  if (expectLoopbackOnly) check('private test: the container has no network interface but loopback', interfaces.length === 1 && interfaces[0] === 'lo', interfaces.join(','));
  else console.log(`INFO  interfaces: ${interfaces.join(',')}`);
} else {
  console.log(`INFO  container isolation checks skipped on ${process.platform}`);
}

// ---- 2. health and static surface
const health = await call(APP, '/health');
check('service healthy: role hosted-relay, ready, client built', health.status === 200 && health.json?.role === 'hosted-relay' && health.json?.ready === true && health.json?.appReady === true, JSON.stringify(health.json));
const remoteHealth = await call(GATEWAY, '/health', { forwardedFor: '198.51.100.1' });
check('remote /health discloses liveness only', remoteHealth.text.trim() === '{"status":"ok"}');
const page = await call(GATEWAY, '/', { forwardedFor: '198.51.100.1' });
const csp = page.headers.get('content-security-policy') ?? '';
check('client page served with CSP (self, hashed inline script, no unsafe-eval, framing denied)', page.status === 200 && csp.includes("default-src 'self'") && /sha256-/.test(csp) && !csp.includes('unsafe-eval') && csp.includes("frame-ancestors 'none'") && csp.includes(ORIGIN.replace('https:', 'wss:')));
check('HSTS and no-sniff on remote responses', Boolean(page.headers.get('strict-transport-security')) && page.headers.get('x-content-type-options') === 'nosniff');
const source = await call(GATEWAY, '/source', { forwardedFor: '198.51.100.1' });
check(sourceConfigured ? '/source redirects to the configured https URL' : '/source is an explicit 404 while CLOUDCLI_SOURCE_URL is unset',
  sourceConfigured ? source.status === 302 && String(source.headers.get('location')).startsWith('https://') : source.status === 404);

// ---- 3. authentication boundary through the gateway
for (const p of ['/api/projects', '/api/runtime-nodes', '/api/files', '/api/git/status']) {
  const response = await call(GATEWAY, p, { forwardedFor: '198.51.100.1' });
  check(`unauthenticated ${p} refused`, [401, 403].includes(response.status), String(response.status));
}
for (const p of ['/api/auth/login', '/api/auth/register']) {
  const response = await call(GATEWAY, p, { method: 'POST', body: {}, forwardedFor: '198.51.100.1' });
  check(`${p} refused on the public origin`, response.status === 403, String(response.status));
}
check('WebSocket upgrade without a session is refused', [401, 403].includes(await wsStatus(`${GATEWAY.replace('http', 'ws')}/ws`, { origin: ORIGIN, 'x-forwarded-for': '198.51.100.1' })));
check('node link without a signed header is refused', [400, 401, 403, 404].includes(await wsStatus(`${GATEWAY.replace('http', 'ws')}/runtime-node-link`, { 'x-forwarded-for': '198.51.100.1' })));

// ---- 4. throwaway account, pairing, authenticated view (local bootstrap, remote session)
const username = 'verify';
const register = await call(APP, '/api/auth/register', { method: 'POST', body: { username, password: PASSWORD } });
check('bootstrap account created over the local listener', register.status === 200 || register.status === 201, String(register.status));
const login = await call(APP, '/api/auth/login', { method: 'POST', body: { username, password: PASSWORD } });
const token = login.json?.token;
const code = (await call(APP, '/api/remote-access/pairing-codes', { method: 'POST', bearer: token })).json?.data?.code;
check('pairing code issued locally', Boolean(code));
const paired = await call(GATEWAY, '/api/remote-access/pair', { method: 'POST', body: { username, password: PASSWORD, pairingCode: code }, forwardedFor: '203.0.113.10' });
const setCookie = paired.headers.get('set-cookie') ?? '';
check('pairing succeeds; cookie is __Host-, Secure, HttpOnly, SameSite=Strict, Path=/, no Domain',
  paired.status === 200 && /^__Host-cloudcli_remote=/.test(setCookie) && /Secure/.test(setCookie) && /HttpOnly/.test(setCookie) && /SameSite=Strict/.test(setCookie) && /Path=\//.test(setCookie) && !/Domain=/i.test(setCookie), String(paired.status));
check('the session token is not in the pairing response body', !/token/i.test(paired.text.replace(/"success"/g, '')) || !paired.json?.token);
const cookie = setCookie.split(';')[0];

const relayStatus = await call(GATEWAY, '/api/relay/status', { cookie, forwardedFor: '203.0.113.10' });
check('relay reports it never executes locally', relayStatus.json?.data?.role === 'hosted-relay' && relayStatus.json?.data?.executesLocally === false);
const fleet = await call(GATEWAY, '/api/runtime-nodes', { cookie, forwardedFor: '203.0.113.10' });
check('the relay host is not a RuntimeNode (localNodeId null, empty fleet)', fleet.json?.data?.localNodeId === null && Array.isArray(fleet.json?.data?.nodes) && fleet.json.data.nodes.length === 0, JSON.stringify(fleet.json?.data));
for (const [method, p] of [['GET', '/api/files'], ['GET', '/api/git/status'], ['GET', '/api/user/git-config'], ['POST', '/api/projects/create']]) {
  const response = await call(GATEWAY, p, { method, cookie, body: method === 'POST' ? {} : undefined, forwardedFor: '203.0.113.10' });
  check(`local execution surface ${method} ${p} answers 501`, response.status === 501, String(response.status));
}
const onboarding = await call(GATEWAY, '/api/user/onboarding-status', { cookie, forwardedFor: '203.0.113.10' });
check('a fresh account is not trapped in host onboarding', onboarding.json?.hasCompletedOnboarding === true);
check('authenticated WebSocket (cookie + exact origin) opens', (await wsStatus(`${GATEWAY.replace('http', 'ws')}/ws`, { origin: ORIGIN, cookie, 'x-forwarded-for': '203.0.113.10' })) === 101);
check('WebSocket from another origin is refused', (await wsStatus(`${GATEWAY.replace('http', 'ws')}/ws`, { origin: 'https://evil.example', cookie, 'x-forwarded-for': '203.0.113.10' })) !== 101);

// ---- 5. client-address keying (the edge chain, from the relay's side)
const attempt = (forwardedFor) => call(GATEWAY, '/api/remote-access/pair', { method: 'POST', body: { username, password: 'wrong-password-x', pairingCode: '0000-0000-0000' }, forwardedFor });
const attackerStatuses = [];
for (const spoof of ['198.51.100.7', '1.1.1.1, 198.51.100.7', '9.9.9.9, 198.51.100.7', '10.0.0.1, 198.51.100.7', '8.8.8.8, 198.51.100.7', '7.7.7.7, 198.51.100.7', '6.6.6.6, 198.51.100.7']) {
  attackerStatuses.push((await attempt(spoof)).status);
}
check('rotating leading X-Forwarded-For values cannot escape the per-client limit (429 from the 6th try)', attackerStatuses.slice(0, 5).every((s) => s !== 429) && attackerStatuses.slice(5).every((s) => s === 429), attackerStatuses.join(','));
const other = await attempt('198.51.100.99');
check('another client address is still judged, not throttled', other.status !== 429, String(other.status));

// ---- 6. logout really revokes; nothing was executed
await call(GATEWAY, '/api/remote-access/logout', { method: 'POST', cookie, forwardedFor: '203.0.113.10' });
const replay = await call(GATEWAY, '/api/runtime-nodes', { cookie, forwardedFor: '203.0.113.10' });
check('the paired session is refused after logout', replay.status === 401 || replay.status === 403, String(replay.status));

if (process.platform === 'linux') {
  const processes = fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name)).map((pid) => {
    try { return { pid: Number(pid), cmd: fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).slice(0, 2).map((part) => path.basename(part)).join(' ') }; } catch { return null; }
  }).filter(Boolean);
  const unexpected = processes.filter(({ cmd }) => !/^(tini|docker-init|node)( |$)/.test(cmd));
  check('the container runs only node (and its init): no shell, provider or git process', unexpected.length === 0, processes.map((p) => `${p.pid}:${p.cmd}`).join(' | '));
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
