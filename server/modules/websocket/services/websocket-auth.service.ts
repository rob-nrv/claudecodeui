import type { VerifyClientCallbackSync } from 'ws';

import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';

type WebSocketAuthDependencies = {
  isPlatform: boolean;
  authenticateWebSocket: (token: string | null) => {
    id?: string | number;
    userId?: string | number;
    username?: string;
    [key: string]: unknown;
  } | null;
  allowedOrigins: Set<string>;
  /**
   * Browser upgrades that arrived through the Remote Gateway (FT-M08). They
   * authenticate only with the remote session cookie from exactly the public
   * origin; a URL token is never accepted on that transport.
   */
  remote?: {
    isRemote(request: AuthenticatedWebSocketRequest): boolean;
    authenticate(request: AuthenticatedWebSocketRequest): { userId: number; username: string } | null;
  };
  /**
   * The RuntimeNode link (FT-M08). It never uses browser credentials: the
   * node proves possession of its enrolled key in a signed header instead.
   */
  nodeLink?: {
    path: string;
    verify(request: AuthenticatedWebSocketRequest): boolean;
  };
};

/**
 * Authenticates websocket upgrade requests before the `connection` handler runs.
 */
export function verifyWebSocketClient(
  info: Parameters<VerifyClientCallbackSync<AuthenticatedWebSocketRequest>>[0],
  dependencies: WebSocketAuthDependencies
): boolean {
  const request = info.req as AuthenticatedWebSocketRequest;
  const upgradeUrl = new URL(request.url ?? '/', 'http://localhost');

  // Node links are checked first and exclusively: a browser credential can
  // never open one, and a node credential can never open a browser path.
  if (dependencies.nodeLink && upgradeUrl.pathname === dependencies.nodeLink.path) {
    const verified = dependencies.nodeLink.verify(request);
    if (!verified) {
      console.log('[WARN] Runtime node link upgrade rejected');
    }
    return verified;
  }

  if (dependencies.remote?.isRemote(request)) {
    const remoteUser = dependencies.remote.authenticate(request);
    if (!remoteUser) {
      console.log('[WARN] Remote WebSocket upgrade rejected');
      return false;
    }
    request.user = remoteUser;
    return true;
  }

  // `cors()` only covers Express HTTP routes; the ws upgrade handshake needs
  // its own check against the same allowlist (no wildcard, "null" never matches).
  const origin = request.headers.origin;
  if (origin && !dependencies.allowedOrigins.has(origin)) {
    console.log('[WARN] WebSocket connection rejected for origin:', origin);
    return false;
  }

  const loggedUrl = new URL(upgradeUrl);
  if (loggedUrl.searchParams.has('token')) {
    loggedUrl.searchParams.set('token', 'REDACTED');
  }

  console.log('WebSocket connection attempt to:', `${loggedUrl.pathname}${loggedUrl.search}`);

  // Platform mode: use the first DB user and skip token checks.
  if (dependencies.isPlatform) {
    const user = dependencies.authenticateWebSocket(null);
    if (!user) {
      console.log('[WARN] Platform mode: No user found in database');
      return false;
    }

    request.user = user;
    console.log('[OK] Platform mode WebSocket authenticated for user:', user.username);
    return true;
  }

  // OSS mode: read JWT from query string first, then Authorization header.
  const token =
    upgradeUrl.searchParams.get('token') ??
    request.headers.authorization?.split(' ')[1] ??
    null;

  const user = dependencies.authenticateWebSocket(token);
  if (!user) {
    console.log('[WARN] WebSocket authentication failed');
    return false;
  }

  request.user = user;
  console.log('[OK] WebSocket authenticated for user:', user.username);
  return true;
}
