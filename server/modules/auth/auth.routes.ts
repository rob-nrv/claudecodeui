import express from 'express';
import type { RequestHandler } from 'express';

import type { createAuthService } from './auth.service.js';

type AuthenticatedRequest = express.Request & { user?: unknown };

/**
 * Creates the Auth transport adapter. Handlers only parse request data and
 * delegate authentication behavior to the injected application service.
 */
export function createAuthRouter(
  service: ReturnType<typeof createAuthService>,
  authenticateToken: RequestHandler,
  resolveTransport: (req: express.Request) => 'local' | 'remote' = () => 'local',
): express.Router {
  const router = express.Router();

  router.get('/status', (req, res, next) => {
    try {
      // `transport` tells the client which session mechanism applies: a bearer
      // token locally, or the HttpOnly remote session cookie (FT-M08).
      res.json({ ...service.getStatus(), transport: resolveTransport(req) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/register', async (req, res, next) => {
    try {
      const body = req.body as { username?: unknown; password?: unknown };
      res.json(await service.register(body.username, body.password));
    } catch (error) {
      next(error);
    }
  });

  router.post('/login', async (req, res, next) => {
    try {
      const body = req.body as { username?: unknown; password?: unknown };
      res.json(await service.login(body.username, body.password));
    } catch (error) {
      next(error);
    }
  });

  router.get('/user', authenticateToken, (req, res) => {
    res.json(service.getCurrentUser((req as AuthenticatedRequest).user));
  });

  router.patch('/user/profile', authenticateToken, (req, res, next) => {
    try {
      const body = req.body as { displayName?: unknown };
      res.json(service.updateProfile((req as AuthenticatedRequest).user, body.displayName ?? null));
    } catch (error) {
      next(error);
    }
  });

  router.post('/refresh', authenticateToken, (req, res) => {
    res.json(service.refreshSession((req as AuthenticatedRequest).user));
  });

  router.post('/logout', authenticateToken, (_req, res) => {
    res.json(service.logout());
  });

  return router;
}
