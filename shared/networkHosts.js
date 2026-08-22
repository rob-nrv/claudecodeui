export function isWildcardHost(host) {
  return host === '0.0.0.0' || host === '::';
}

export function isLoopbackHost(host) {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

export function normalizeLoopbackHost(host) {
  if (!host) {
    return host;
  }
  return isLoopbackHost(host) ? 'localhost' : host;
}

// Use localhost for connectable loopback and wildcard addresses in browser-facing URLs.
export function getConnectableHost(host) {
  if (!host) {
    return 'localhost';
  }
  return isWildcardHost(host) || isLoopbackHost(host) ? 'localhost' : host;
}

// Safe-by-default bind host: loopback-only unless the operator explicitly
// configured something else (including deliberately opting into 0.0.0.0 to
// expose the app on the network). An unset or blank HOST — e.g. a missing or
// unreadable .env — must never fall back to a wildcard bind.
export function resolveBindHost(rawHost) {
  const trimmed = typeof rawHost === 'string' ? rawHost.trim() : rawHost;
  return trimmed ? trimmed : '127.0.0.1';
}

// Origins the local UI is actually served from: 127.0.0.1/localhost on the
// backend and Vite dev server ports. Used to build a strict CORS/WS allowlist.
export function buildLoopbackOrigins(ports) {
  const origins = new Set();
  for (const port of ports) {
    if (!port) {
      continue;
    }
    origins.add(`http://127.0.0.1:${port}`);
    origins.add(`http://localhost:${port}`);
  }
  return origins;
}
