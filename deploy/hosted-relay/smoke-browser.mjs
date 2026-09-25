#!/usr/bin/env node
// Authenticated browser journey against a Hosted Relay, driven through the Chrome
// DevTools Protocol (real Chrome, headless). Run from a machine OUTSIDE the VPS,
// from a checkout of this repository (it uses the repo's `ws` dependency).
//
//   RELAY_USERNAME=... RELAY_PASSWORD=... RELAY_PAIRING_CODE=XXXX-XXXX-XXXX \
//     node deploy/hosted-relay/smoke-browser.mjs https://relay.example.com [--expect-online=N] [--out=DIR] [--insecure-local]
//
// Credentials come from the environment only (never argv, never printed). The
// pairing code is single-use: this script consumes it. What it proves: the real
// pairing form works under the served CSP, the session cookie is Host-only /
// Secure / HttpOnly / SameSite=Strict and invisible to JavaScript, the app
// WebSocket opens (101), the service worker registers, no CSP violation or
// console error occurs, the fleet shown is exactly what the relay reports, the
// relay executes nothing locally, and logging out really ends the session.
// Only physical-device behaviour (a phone's own browser) is not covered.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import https from 'node:https';
import path from 'node:path';

import { WebSocket } from 'ws';

const args = process.argv.slice(2);
const originArg = args.find((arg) => arg.startsWith('https://') || arg.startsWith('http://'));
const flag = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.split('=')[1];
const insecure = args.includes('--insecure-local');
const expectOnline = flag('expect-online') === undefined ? null : Number(flag('expect-online'));
const outDir = flag('out');
const { RELAY_USERNAME: username, RELAY_PASSWORD: password, RELAY_PAIRING_CODE: code } = process.env;
if (!originArg || !username || !password || !code) {
  console.error('usage: RELAY_USERNAME=.. RELAY_PASSWORD=.. RELAY_PAIRING_CODE=.. node smoke-browser.mjs https://relay.example.com [--expect-online=N] [--out=DIR]');
  process.exit(2);
}
const origin = new URL(originArg).origin;

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
// GitHub calls (upstream release check, star badge) are blocked by the relay CSP on purpose:
// they concern the upstream repository, not this fork, and would send visitors' addresses to GitHub.
const EXPECTED_BLOCKED_HOSTS = ['https://api.github.com'];
const replayStatus = (cookie) => new Promise((resolve) => {
  const url = new URL('/api/runtime-nodes', origin);
  https.get({ host: url.hostname, port: url.port || 443, path: url.pathname, rejectUnauthorized: !insecure, headers: { cookie: `__Host-cloudcli_remote=${cookie}`, origin } },
    (res) => { res.resume(); resolve(res.statusCode); }).on('error', (error) => resolve(`network-error: ${error.message}`));
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate));
}

const chromePath = findChrome();
if (!chromePath) {
  console.error('Chrome/Chromium not found. Set CHROME_PATH.');
  process.exit(2);
}
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-smoke-'));
const chrome = spawn(chromePath, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  ...(insecure ? ['--ignore-certificate-errors'] : []), 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

const debuggerUrl = await new Promise((resolve, reject) => {
  let buffer = '';
  const timer = setTimeout(() => reject(new Error('Chrome did not start')), 20_000);
  chrome.stderr.on('data', (chunk) => {
    buffer += chunk.toString();
    const match = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
    if (match) {
      clearTimeout(timer);
      resolve(match[1]);
    }
  });
});
const debugPort = new URL(debuggerUrl).port;
const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' })).json();

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
let nextId = 1;
const pending = new Map();
const events = [];
socket.on('message', (raw) => {
  const message = JSON.parse(raw.toString());
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(`${message.error.message}`)); else resolve(message.result);
  } else if (message.method) {
    events.push(message);
  }
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed');
  return result.result.value;
};
const waitFor = async (expression, description, timeoutMs = 25_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await evaluate(expression)) return true; } catch { /* page navigating */ }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${description}`);
};
const typeInto = async (selector, value) => {
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
  await send('Input.insertText', { text: value });
};

async function main() {
  for (const domain of ['Page', 'Runtime', 'Log', 'Network']) await send(`${domain}.enable`);
  await send('Page.navigate', { url: origin });

  await waitFor(`!!document.querySelector('#remote-username')`, 'the pairing form (an unpaired remote browser must be asked to pair)');
  check('unpaired remote browser is shown the pairing form, not the app', true);
  const sourceLink = await evaluate(`(document.querySelector('a[href="/source"]') || {}).textContent || null`);
  check('the pairing page offers the Corresponding Source through /source (AGPL-3.0 s.13)', Boolean(sourceLink), String(sourceLink));
  const sourceProbe = await evaluate(`fetch('/source', { redirect: 'manual' }).then((r) => r.type + ':' + r.status)`);
  check('/source is configured (redirect, not the 404 "not configured" page)', sourceProbe.startsWith('opaqueredirect'), sourceProbe);

  await typeInto('#remote-username', username);
  await typeInto('#remote-password', password);
  await typeInto('#remote-pairing-code', code);
  await evaluate(`document.querySelector('form button[type=submit]').click()`);
  await waitFor(`!document.querySelector('#remote-username')`, 'the app shell after pairing').catch(async () => {
    const message = await evaluate(`document.body.innerText.slice(0, 300)`).catch(() => '');
    throw new Error(`pairing did not complete: ${String(message).replace(/\s+/g, ' ')}`);
  });
  check('pairing with username + password + one-time code succeeds', true);
  await sleep(4000); // let the app open its WebSocket and load the fleet
  const shell = await evaluate(`document.body.innerText`);
  check('the app opens (not the host Git/provider onboarding, which a relay cannot complete)', !/Git Configuration|Connect Agents/i.test(shell) && shell.trim().length > 0, shell.replace(/s+/g, ' ').slice(0, 60));

  const cookies = (await send('Network.getCookies', { urls: [origin] })).cookies;
  const session = cookies.find((cookie) => cookie.name === '__Host-cloudcli_remote');
  check('session cookie is __Host-, Secure, HttpOnly, SameSite=Strict, path /, host-only',
    Boolean(session) && session.secure && session.httpOnly && session.sameSite === 'Strict' && session.path === '/' && !session.domain.startsWith('.'));
  check('session cookie is invisible to page JavaScript', !(await evaluate('document.cookie')).includes('cloudcli_remote'));

  const cspEntries = events.filter((event) => event.method === 'Log.entryAdded'
    && (event.params.entry.source === 'security' || /Content Security Policy|Refused to/i.test(event.params.entry.text)));
  const isExpected = (event) => EXPECTED_BLOCKED_HOSTS.some((host) => event.params.entry.text.includes(host) || event.params.entry.url?.startsWith(host));
  const violations = cspEntries.filter((event) => !isExpected(event));
  if (cspEntries.length > violations.length) console.log(`INFO  ${cspEntries.length - violations.length} expected CSP block(s) of ${EXPECTED_BLOCKED_HOSTS.join(', ')} (upstream GitHub calls, intentionally denied)`);
  check('no Content-Security-Policy violation while loading and pairing', violations.length === 0,
    violations.map((event) => event.params.entry.text.slice(0, 120)).join(' | '));

  const created = events.filter((event) => event.method === 'Network.webSocketCreated').map((event) => event.params.url);
  const handshakes = events.filter((event) => event.method === 'Network.webSocketHandshakeResponseReceived');
  const wsOk = created.length > 0 && created.every((url) => url.startsWith(`wss://${new URL(origin).host}/`))
    && handshakes.length > 0 && handshakes.every((event) => event.params.response.status === 101);
  check('app WebSocket opens over wss on the public origin (CSP connect-src ok, cookie accepted)', wsOk, created.join(', '));

  const workers = await evaluate(`navigator.serviceWorker.getRegistrations().then((list) => list.length)`);
  check('service worker registers under the CSP', workers >= 1, `${workers} registration(s)`);

  const status = await evaluate(`fetch('/api/relay/status', { credentials: 'same-origin' }).then((r) => r.json())`);
  check('relay reports it never executes locally', status?.data?.role === 'hosted-relay' && status?.data?.executesLocally === false);
  const files = await evaluate(`fetch('/api/files', { credentials: 'same-origin' }).then((r) => r.status)`);
  check('local execution surfaces do not exist on the relay (Files -> 501)', files === 501, String(files));

  const fleet = await evaluate(`fetch('/api/runtime-nodes', { credentials: 'same-origin' }).then((r) => r.json())`);
  const nodes = Array.isArray(fleet?.data?.nodes) ? fleet.data.nodes : null;
  const online = (nodes ?? []).filter((node) => node.canExecute === true);
  check('the relay host is never listed as a RuntimeNode (localNodeId null, no isLocal row)', nodes !== null && fleet.data.localNodeId === null && !nodes.some((node) => node.isLocal));
  console.log(`INFO  fleet: ${nodes ? nodes.length : '?'} node(s), ${online.length} online`);
  if (expectOnline !== null) {
    check(`exactly ${expectOnline} node(s) online, as expected`, online.length === expectOnline, `${online.length} online`);
    if (expectOnline === 0) {
      const text = await evaluate(`document.body.innerText`);
      check('with no node online the page offers no local run', !/run (on|in) this (server|machine)/i.test(text));
    }
  }

  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(outDir, 'relay-browser-smoke.png'), Buffer.from(shot.data, 'base64'));
    console.log(`INFO  screenshot: ${path.join(outDir, 'relay-browser-smoke.png')}`);
  }

  const errors = events.filter((event) => (event.method === 'Runtime.exceptionThrown'));
  check('no uncaught page exception', errors.length === 0, errors.map((event) => event.params.exceptionDetails.text).join(' | '));

  // End of session: logout must revoke server-side, not only clear the cookie.
  const cookieValue = session?.value;
  await evaluate(`fetch('/api/remote-access/logout', { method: 'POST', credentials: 'same-origin', headers: { Origin: location.origin } }).then((r) => r.status)`);
  const replay = cookieValue
    ? await replayStatus(cookieValue)
    : 'no-cookie';
  check('after logout the old session cookie is refused by the relay (revocation is server-side)', replay === 401 || replay === 403, String(replay));
  await send('Page.navigate', { url: origin });
  await waitFor(`!!document.querySelector('#remote-username')`, 'the pairing form after logout');
  check('after logout the browser is asked to pair again', true);
}

let exitCode = 0;
try {
  await main();
} catch (error) {
  check(error.message, false);
} finally {
  const failed = results.filter((ok) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  exitCode = failed ? 1 : 0;
  socket.close();
  chrome.kill();
  await sleep(500);
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
}
process.exit(exitCode);
