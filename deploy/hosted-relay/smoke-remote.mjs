#!/usr/bin/env node
// Black-box checks of a deployed Hosted Relay, run FROM A MACHINE OUTSIDE the VPS.
//   node smoke-remote.mjs https://relay.example.com [--edge=nginx|tailscale-serve|tailscale-funnel] [--probe-rate-limit] [--insecure-local]
// --edge says what sits in front of the relay and selects the matching, equally strict, checks:
//   nginx (default)     VPS runbook: port 80 must redirect to https; the origin must NOT be a *.ts.net name
//   tailscale-serve     tailnet-only: origin must be *.ts.net; port 80 must not answer; run from a tailnet device
//   tailscale-funnel    public via Tailscale: origin must be *.ts.net; only 443/8443/10000 may answer, so
//                       port 80 and every other listed port (default: the nas-hub Jarvis ports) must be closed
//                       from outside. --closed-ports=a,b,c overrides that list.
// A mismatch between --edge and the origin is a FAIL, never a silent skip.
// --probe-rate-limit sends wrong pairing codes until throttled, which blocks THIS address
// from pairing for ~15 minutes. Run it LAST, after smoke-browser.mjs.
// It proves the automatable part of the public gate (TLS, edge exposure, headers,
// unauthenticated surface, rate limiting). It does NOT replace the human browser
// pairing / node online-offline check in README.md section 6.
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

const [, , originArg, ...flags] = process.argv;
if (!originArg) {
  console.error('usage: node smoke-remote.mjs https://relay.example.com');
  process.exit(2);
}
const origin = new URL(originArg);
const probeRateLimit = flags.includes('--probe-rate-limit');
const flagValue = (name) => flags.find((flag) => flag.startsWith(`--${name}=`))?.split('=')[1];
const edge = flagValue('edge') ?? 'nginx';
if (!['nginx', 'tailscale-serve', 'tailscale-funnel'].includes(edge)) {
  console.error(`unknown --edge=${edge}`);
  process.exit(2);
}
const tailscaleEdge = edge.startsWith('tailscale');
const JARVIS_PORTS = [22, 7878, 8080, 8096, 8989, 9090, 9443, 9696];
const closedPortList = (flagValue('closed-ports') ? flagValue('closed-ports').split(',').map(Number) : JARVIS_PORTS);
const insecure = flags.includes('--insecure-local'); // loopback simulation only, never for a real check
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

function request(path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: origin.hostname, port: origin.port || 443, path, method, headers, rejectUnauthorized: !insecure,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data, socket: res.socket }));
    });
    req.on('error', reject);
    req.setTimeout(10_000, () => req.destroy(new Error('timeout')));
    if (body) req.write(body);
    req.end();
  });
}

const closedPort = (port) => new Promise((resolve) => {
  const socket = net.connect({ host: origin.hostname, port, timeout: 4000 });
  socket.on('connect', () => { socket.destroy(); resolve(false); });
  socket.on('timeout', () => { socket.destroy(); resolve(true); });
  socket.on('error', () => resolve(true));
});

// 0. The declared edge must match the origin it is applied to
check(`edge ${edge} matches the origin host`, tailscaleEdge === origin.hostname.endsWith('.ts.net'), origin.hostname.endsWith('.ts.net') ? 'origin is a .ts.net name' : 'origin is not a .ts.net name');

// 1. TLS
if (!insecure) {
  const protocol = await new Promise((resolve) => {
    const socket = tls.connect({ host: origin.hostname, port: origin.port || 443, servername: origin.hostname }, () => {
      const info = { protocol: socket.getProtocol(), authorized: socket.authorized, expires: socket.getPeerCertificate().valid_to };
      socket.end();
      resolve(info);
    });
    socket.on('error', (error) => resolve({ error: error.message }));
  });
  check('TLS certificate is valid for the host', protocol.authorized === true, protocol.error ?? `expires ${protocol.expires}`);
  check('TLS 1.2 or newer', ['TLSv1.2', 'TLSv1.3'].includes(protocol.protocol), protocol.protocol);
}

// 2. Backend is not exposed directly
// A closed port proves nothing if the host itself is unreachable, so the public port must answer first.
const publicPortOpen = !(await closedPort(Number(origin.port || 443)));
for (const port of [3001, 3443]) {
  check(`port ${port} is not reachable from the Internet`, publicPortOpen && (await closedPort(port)), publicPortOpen ? '' : 'public port did not answer, so this proves nothing');
}

if (edge === 'tailscale-funnel') {
  // Funnel can only forward 443, 8443 and 10000; everything else on the machine must stay unreachable from outside.
  for (const port of closedPortList) {
    check(`funnel: port ${port} of the host is not reachable from the Internet`, publicPortOpen && (await closedPort(port)), publicPortOpen ? '' : 'public port did not answer, so this proves nothing');
  }
} else if (edge === 'tailscale-serve') {
  console.log('SKIP  host port sweep: over a tailnet the machine other services are legitimately reachable; the sweep is only meaningful for --edge=tailscale-funnel');
}

// 3. Public surface
const health = await request('/health');
check('/health answers only { status: "ok" } remotely', health.status === 200 && health.body.trim() === '{"status":"ok"}', health.body.slice(0, 80));
const page = await request('/');
check('web client is served', page.status === 200 && page.body.includes('<div id="root">'));
const csp = String(page.headers['content-security-policy'] ?? '');
check('CSP on the client page: default-src self, no unsafe-eval, framing denied',
  csp.includes("default-src 'self'") && !csp.includes('unsafe-eval') && csp.includes("frame-ancestors 'none'"));
check('HSTS present', Boolean(page.headers['strict-transport-security']));
check('nosniff, X-Frame-Options DENY, no-referrer',
  page.headers['x-content-type-options'] === 'nosniff' && page.headers['x-frame-options'] === 'DENY' && page.headers['referrer-policy'] === 'no-referrer');
check('server does not advertise itself', !page.headers['x-powered-by']);

for (const path of ['/api/projects', '/api/runtime-nodes', '/api/providers/claude/sessions', '/api/files', '/api/git/status']) {
  const response = await request(path);
  check(`unauthenticated ${path} is refused`, [401, 403].includes(response.status), String(response.status));
}
for (const path of ['/api/auth/login', '/api/auth/register']) {
  const response = await request(path, { method: 'POST', headers: { 'content-type': 'application/json', origin: origin.origin }, body: '{}' });
  check(`${path} is refused on the public origin`, response.status === 403, String(response.status));
}
const foreign = await request('/api/remote-access/pair', {
  method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}',
});
check('cross-origin unsafe request is refused', foreign.status === 403, String(foreign.status));
const tokenInUrl = await request('/api/projects?token=abc');
check('credentials in the URL are refused', tokenInUrl.status === 400, String(tokenInUrl.status));
const big = await request('/api/remote-access/pair', {
  method: 'POST', headers: { 'content-type': 'application/json', origin: origin.origin }, body: JSON.stringify({ x: 'a'.repeat(1_100_000) }),
});
check('oversized body is refused', [413, 400].includes(big.status), String(big.status));
const source = await request('/source');
check('AGPL source offer /source redirects (https) — set CLOUDCLI_SOURCE_URL', source.status === 302 && String(source.headers.location).startsWith('https://'), String(source.status));

// 4. Port 80
if (!insecure) {
  if (edge === 'nginx') {
    const redirect = await new Promise((resolve) => {
      import('node:http').then(({ default: http }) => {
        http.get({ host: origin.hostname, port: 80, path: '/', timeout: 8000 }, (res) => { res.resume(); resolve({ status: res.statusCode, location: res.headers.location }); })
          .on('error', (error) => resolve({ error: error.message }));
      });
    });
    check('port 80 only redirects to https', redirect.status === 301 && String(redirect.location).startsWith('https://'), redirect.error ?? String(redirect.status));
  } else {
    // Tailscale terminates TLS on 443 only; plain HTTP must not be served at all.
    check('port 80 serves nothing (Tailscale edge has no HTTP listener)', publicPortOpen && (await closedPort(80)), publicPortOpen ? '' : 'public port did not answer, so this proves nothing');
  }
}

// 5. Rate limiting on the guessable secret (opt-in: it blocks this address for ~15 min)
if (probeRateLimit) {
  let limited = null;
  for (let i = 0; i < 12 && !limited; i += 1) {
    const response = await request('/api/remote-access/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: origin.origin },
      body: JSON.stringify({ username: 'smoke', password: 'smoke-not-a-password', pairingCode: '0000-0000-0000' }),
    });
    if (response.status === 429) limited = response;
  }
  // The relay answers with a JSON error body; the nginx edge answers with its own HTML page.
  const layer = limited ? (limited.body.trim().startsWith('{') ? 'relay limiter (keyed on the real client address)' : 'nginx edge limiter') : 'none';
  check('repeated wrong pairing codes end in 429', Boolean(limited), layer);
  if (tailscaleEdge) {
    check('the throttle came from the relay limiter (there is no nginx edge here)', Boolean(limited) && layer.startsWith('relay limiter'), layer);
  }
  if (edge === 'tailscale-funnel') {
    console.log('WARN  per-client keying through Funnel is NOT proven by this single-vantage probe. Funnel may present one address for all visitors.');
    console.log('      Run the two-network test: 5 wrong pairings from network A must throttle A only, then ONE attempt from network B must not be throttled.');
  }
} else {
  console.log('SKIP  rate-limit probe (run with --probe-rate-limit, last)');
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
