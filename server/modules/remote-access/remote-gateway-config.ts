// Explicit, validated configuration of the optional Remote Gateway (FT-M08).
// The main listener (SERVER_PORT, loopback by default) is never changed by
// anything here; remote browsers and RuntimeNodes can only arrive through a
// second listener that this configuration describes, and every mode that can
// be enabled requires an https public origin.

const LOOPBACK_BIND_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

function isLoopbackHost(host: string): boolean {
  return LOOPBACK_BIND_HOSTS.has(host);
}

/** How the gateway receives TLS: it terminates it itself, or a local terminator in front of it does. */
export type RemoteGatewayConfig =
  | { mode: 'off' }
  | { mode: 'tls'; bindHost: string; port: number; publicOrigin: string; certPath: string; keyPath: string }
  | { mode: 'external-tls'; bindHost: string; port: number; publicOrigin: string };

export type RemoteGatewayConfigResult =
  | { ok: true; config: RemoteGatewayConfig }
  | { ok: false; error: string };

const DEFAULT_REMOTE_PORT = 3443;

type RemoteGatewayEnvironment = Record<string, string | undefined>;

function readTrimmed(env: RemoteGatewayEnvironment, key: string): string {
  return (env[key] ?? '').trim();
}

/**
 * The origin browsers will show in their address bar. It must be exactly an
 * https origin: no credentials, path, query or fragment, because it is compared
 * byte-for-byte with the `Origin` header of every unsafe request and upgrade.
 */
function parsePublicOrigin(raw: string): string | null {
  if (!raw) {
    return null;
  }
  try {
    const url = new URL(raw);
    const hasExtras = url.username || url.password || (url.pathname && url.pathname !== '/') || url.search || url.hash;
    if (url.protocol !== 'https:' || hasExtras) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function parsePort(raw: string, fallback: number): number | null {
  if (!raw) {
    return fallback;
  }
  const port = Number.parseInt(raw, 10);
  return String(port) === raw && port > 0 && port < 65536 ? port : null;
}

/**
 * Reads the gateway configuration from the environment. Consumed by the server
 * entrypoint once at startup. An invalid configuration is reported as an error
 * (and the gateway stays down) instead of being corrected into something that
 * listens anyway.
 *
 * Variables: CLOUDCLI_REMOTE_GATEWAY (off | tls | external-tls),
 * CLOUDCLI_REMOTE_ORIGIN, CLOUDCLI_REMOTE_PORT, CLOUDCLI_REMOTE_BIND,
 * CLOUDCLI_REMOTE_TLS_CERT, CLOUDCLI_REMOTE_TLS_KEY.
 */
export function readRemoteGatewayConfig(
  env: RemoteGatewayEnvironment,
  context: { isPlatform: boolean; serverPort: number },
): RemoteGatewayConfigResult {
  const mode = readTrimmed(env, 'CLOUDCLI_REMOTE_GATEWAY').toLowerCase();
  if (!mode || mode === 'off') {
    return { ok: true, config: { mode: 'off' } };
  }
  if (mode !== 'tls' && mode !== 'external-tls') {
    return { ok: false, error: 'CLOUDCLI_REMOTE_GATEWAY must be off, tls or external-tls.' };
  }
  if (context.isPlatform) {
    // Platform mode skips authentication entirely; exposing it would be unauthenticated remote access.
    return { ok: false, error: 'The remote gateway cannot run in platform mode.' };
  }

  const publicOrigin = parsePublicOrigin(readTrimmed(env, 'CLOUDCLI_REMOTE_ORIGIN'));
  if (!publicOrigin) {
    return { ok: false, error: 'CLOUDCLI_REMOTE_ORIGIN must be an https origin such as https://host.example:3443.' };
  }

  const port = parsePort(readTrimmed(env, 'CLOUDCLI_REMOTE_PORT'), DEFAULT_REMOTE_PORT);
  if (port === null) {
    return { ok: false, error: 'CLOUDCLI_REMOTE_PORT must be a TCP port number.' };
  }
  if (port === context.serverPort) {
    return { ok: false, error: 'CLOUDCLI_REMOTE_PORT must differ from SERVER_PORT.' };
  }

  const requestedBind = readTrimmed(env, 'CLOUDCLI_REMOTE_BIND');
  if (mode === 'external-tls') {
    // Plain HTTP on this listener is only acceptable when the TLS terminator is on this machine.
    const bindHost = requestedBind || '127.0.0.1';
    if (!isLoopbackHost(bindHost)) {
      return { ok: false, error: 'In external-tls mode the gateway only binds a loopback address; put the TLS terminator on this machine.' };
    }
    return { ok: true, config: { mode, bindHost, port, publicOrigin } };
  }

  const certPath = readTrimmed(env, 'CLOUDCLI_REMOTE_TLS_CERT');
  const keyPath = readTrimmed(env, 'CLOUDCLI_REMOTE_TLS_KEY');
  if (!certPath || !keyPath) {
    return { ok: false, error: 'tls mode requires CLOUDCLI_REMOTE_TLS_CERT and CLOUDCLI_REMOTE_TLS_KEY.' };
  }
  return { ok: true, config: { mode, bindHost: requestedBind || '0.0.0.0', port, publicOrigin, certPath, keyPath } };
}
