import type { IncomingMessage } from 'node:http';

import type { NextFunction, Request, RequestHandler, Response } from 'express';

import type { RemoteAccessService } from '@/modules/remote-access/remote-access.service.js';
import { isRemoteTransport, setRemoteSessionId } from '@/modules/remote-access/remote-transport.js';

/** Host-only, Secure, path-wide: a `__Host-` cookie cannot be set by a subdomain or over plain HTTP. */
export const REMOTE_SESSION_COOKIE_NAME = '__Host-cloudcli_remote';

/** API surfaces that never answer through the Remote Gateway (V1). */
const REMOTE_DISABLED_API_PREFIXES = [
  // Password-only login and first-user setup stay local; remote browsers pair instead.
  '/api/auth/login',
  '/api/auth/register',
  // Bearer tokens are not issued or refreshed remotely.
  '/api/auth/refresh',
  // Machine APIs authenticated by API keys or a local token.
  '/api/agent',
  '/api/browser-use-mcp',
];

/** Public, credential-free RuntimeNode enrollment: must look like a node client, never a browser. */
const NODE_LINK_PUBLIC_API_PREFIX = '/api/runtime-node-link/';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const URL_CREDENTIAL_PARAMETERS = ['token', 'access_token', 'auth', 'apiKey', 'api_key'];

function rejectRequest(res: Response, statusCode: number, code: string, message: string): void {
  res.status(statusCode).json({ success: false, error: { code, message } });
}

/**
 * Reads the remote session cookie. A header carrying the cookie more than once
 * (cookie tossing) yields null rather than a guess about which one is real.
 */
export function readRemoteSessionCookie(cookieHeader: string | string[] | undefined): string | null {
  const header = Array.isArray(cookieHeader) ? cookieHeader.join('; ') : cookieHeader;
  if (!header) {
    return null;
  }
  const values = header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${REMOTE_SESSION_COOKIE_NAME}=`))
    .map((part) => part.slice(REMOTE_SESSION_COOKIE_NAME.length + 1));
  return values.length === 1 ? values[0] : null;
}

/** Set-Cookie value for a newly paired browser; the token is never placed anywhere else. */
export function buildRemoteSessionCookie(token: string, maxAgeSeconds: number): string {
  return `${REMOTE_SESSION_COOKIE_NAME}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`;
}

export function buildClearedRemoteSessionCookie(): string {
  return `${REMOTE_SESSION_COOKIE_NAME}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;
}

function hasUrlCredential(originalUrl: string): boolean {
  const url = new URL(originalUrl, 'https://gateway.invalid');
  return URL_CREDENTIAL_PARAMETERS.some((name) => url.searchParams.has(name));
}

/**
 * Policy applied to every request that arrived through the Remote Gateway, and
 * to nothing else (local requests pass straight through):
 *
 * - security headers (HSTS, no framing, no sniffing, no referrer);
 * - credentials in the URL are refused outright;
 * - disabled surfaces answer 403;
 * - RuntimeNode enrollment must carry neither Origin nor cookies;
 * - every unsafe method must come from exactly the public origin (CSRF);
 * - a valid session cookie authenticates the request; authorization itself is
 *   still decided by `authenticateToken` on each protected route.
 */
export function createRemoteRequestGuard(options: {
  publicOrigin: string | null;
  service: RemoteAccessService;
}): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!isRemoteTransport(req)) {
      next();
      return;
    }

    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");

    if (!options.publicOrigin) {
      rejectRequest(res, 503, 'REMOTE_GATEWAY_MISCONFIGURED', 'The remote gateway is not configured.');
      return;
    }

    if (hasUrlCredential(req.originalUrl)) {
      rejectRequest(res, 400, 'REMOTE_CREDENTIALS_IN_URL', 'Credentials are never accepted in a URL.');
      return;
    }

    const requestPath = req.path;
    if (requestPath.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store');
    }

    if (REMOTE_DISABLED_API_PREFIXES.some((prefix) => requestPath === prefix || requestPath.startsWith(`${prefix}/`))) {
      rejectRequest(res, 403, 'REMOTE_ROUTE_DISABLED', 'This action is only available on the host machine.');
      return;
    }

    if (requestPath.startsWith(NODE_LINK_PUBLIC_API_PREFIX)) {
      if (req.headers.origin || req.headers.cookie) {
        rejectRequest(res, 403, 'RUNTIME_NODE_CLIENT_REQUIRED', 'Runtime nodes enroll from the node agent, not from a browser.');
        return;
      }
      next();
      return;
    }

    const origin = req.headers.origin;
    const originMismatch = origin !== undefined && origin !== options.publicOrigin;
    if (originMismatch || (!SAFE_METHODS.has(req.method) && origin !== options.publicOrigin)) {
      rejectRequest(res, 403, 'REMOTE_ORIGIN_REJECTED', 'Request origin is not allowed.');
      return;
    }

    const authentication = options.service.authenticate(readRemoteSessionCookie(req.headers.cookie));
    if (authentication) {
      (req as Request & { user?: unknown }).user = authentication.user;
      setRemoteSessionId(req, authentication.sessionId);
    }
    next();
  };
}

/**
 * Authenticates a browser WebSocket upgrade that arrived through the gateway:
 * the Origin header must be exactly the public origin, no credential may sit in
 * the URL, and the session cookie must be valid. Returns the user payload the
 * websocket gateway attaches to the request, or null to refuse the upgrade.
 */
export function authenticateRemoteUpgrade(
  request: IncomingMessage,
  options: { publicOrigin: string | null; service: RemoteAccessService },
): { userId: number; username: string } | null {
  if (!options.publicOrigin || request.headers.origin !== options.publicOrigin) {
    return null;
  }
  if (hasUrlCredential(request.url ?? '/')) {
    return null;
  }
  const authentication = options.service.authenticate(readRemoteSessionCookie(request.headers.cookie));
  if (!authentication) {
    return null;
  }
  setRemoteSessionId(request, authentication.sessionId);
  return { userId: authentication.user.id, username: authentication.user.username };
}
