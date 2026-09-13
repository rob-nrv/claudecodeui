import express, { type Request, type RequestHandler, type Response } from 'express';

import {
  buildClearedRemoteSessionCookie,
  buildRemoteSessionCookie,
  readRemoteSessionCookie,
} from '@/modules/remote-access/remote-access.middleware.js';
import type { RemoteAccessService } from '@/modules/remote-access/remote-access.service.js';
import { isRemoteTransport, readRemoteSessionId } from '@/modules/remote-access/remote-transport.js';
import { AppError, asyncHandler, createApiSuccessResponse, readRequestClientAddress } from '@/shared/utils.js';

type AuthenticatedRequest = Request & { user?: { id?: unknown } };

const SESSION_ID_PATTERN = /^[0-9a-f-]{36}$/;

function requireUserId(req: Request): number {
  const id = (req as AuthenticatedRequest).user?.id;
  if (typeof id !== 'number') {
    throw new AppError('Authenticated user is required', { code: 'AUTH_USER_REQUIRED', statusCode: 401 });
  }
  return id;
}

/**
 * Remote access transport adapter (FT-M08). Pairing and remote logout are the
 * only unauthenticated endpoints and only exist on the gateway; everything
 * else requires an authenticated session (local or remote).
 */
export function createRemoteAccessRouter(options: {
  service: RemoteAccessService;
  authenticateToken: RequestHandler;
  getStatus(): unknown;
}): express.Router {
  const router = express.Router();
  const { service } = options;

  router.post(
    '/pair',
    asyncHandler(async (req: Request, res: Response) => {
      if (!isRemoteTransport(req)) {
        throw new AppError('Pairing is only used through the remote gateway.', {
          code: 'REMOTE_TRANSPORT_REQUIRED',
          statusCode: 404,
        });
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const paired = await service.pairBrowser({
        username: body.username,
        password: body.password,
        pairingCode: body.pairingCode,
        clientKey: readRequestClientAddress(req),
        userAgent: req.headers['user-agent'],
      });
      const maxAgeSeconds = (Date.parse(paired.expiresAt) - Date.now()) / 1000;
      res.setHeader('Set-Cookie', buildRemoteSessionCookie(paired.token, maxAgeSeconds));
      // The token lives only in the HttpOnly cookie; the body never carries it.
      res.json(createApiSuccessResponse({ user: paired.user, session: { sessionId: paired.sessionId, expiresAt: paired.expiresAt } }));
    }),
  );

  router.post('/logout', (req: Request, res: Response) => {
    if (isRemoteTransport(req)) {
      const authentication = service.authenticate(readRemoteSessionCookie(req.headers.cookie));
      if (authentication) {
        service.revokeSession(authentication.sessionId);
      }
      res.setHeader('Set-Cookie', buildClearedRemoteSessionCookie());
    }
    res.json(createApiSuccessResponse({ signedOut: true }));
  });

  router.get('/status', options.authenticateToken, (req: Request, res: Response) => {
    const currentSessionId = readRemoteSessionId(req);
    res.json(createApiSuccessResponse({
      transport: isRemoteTransport(req) ? 'remote' : 'local',
      ...(options.getStatus() as Record<string, unknown>),
      sessions: service.listSessions(currentSessionId),
    }));
  });

  router.post('/pairing-codes', options.authenticateToken, (req: Request, res: Response) => {
    res.status(201).json(createApiSuccessResponse(service.createPairingCode(requireUserId(req))));
  });

  router.delete('/sessions/:sessionId', options.authenticateToken, (req: Request, res: Response) => {
    const sessionId = String(req.params.sessionId ?? '');
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      throw new AppError('sessionId is invalid.', { code: 'REMOTE_SESSION_ID_INVALID', statusCode: 400 });
    }
    res.json(createApiSuccessResponse({ revoked: service.revokeSession(sessionId) }));
  });

  router.post('/sessions/revoke-all', options.authenticateToken, (_req: Request, res: Response) => {
    res.json(createApiSuccessResponse({ revoked: service.revokeAllSessions() }));
  });

  return router;
}
