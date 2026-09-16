import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';

import { getProjectSessionsPage, getRegistryProjectsWithSessions } from '@/modules/projects/index.js';
import {
  createLocalProjectRegistry,
  createProjectRegistryRouter,
  createProjectWorkspaceLocator,
} from '@/modules/project-registry/index.js';
import { asyncHandler } from '@/shared/utils.js';

export type AllowedRoute = { method: 'GET' | 'POST' | 'PUT' | 'DELETE'; path: RegExp };

const SEGMENT = '[A-Za-z0-9._-]{1,128}';
const route = (method: AllowedRoute['method'], pattern: string): AllowedRoute => ({
  method,
  path: new RegExp(`^${pattern.replace(/:id/g, SEGMENT)}/?$`),
});

/**
 * Provider routes a Hosted Relay answers: session rows, their remote history
 * and the server-side queue. Everything else in that router reads provider
 * CLIs, transcripts, skills or MCP configuration on the host and is refused.
 */
export const HOSTED_RELAY_PROVIDER_ROUTES: AllowedRoute[] = [
  route('POST', '/sessions'),
  route('GET', '/sessions/running'),
  route('GET', '/sessions/recent'),
  route('GET', '/sessions/archived'),
  route('GET', '/sessions/:id'),
  route('PUT', '/sessions/:id'),
  route('POST', '/sessions/:id/restore'),
  route('GET', '/sessions/:id/messages'),
  route('GET', '/sessions/:id/lineage'),
  route('GET', '/sessions/:id/queued-message'),
  route('PUT', '/sessions/:id/queued-message'),
  route('DELETE', '/sessions/:id/queued-message'),
  route('POST', '/sessions/:id/queued-message/claim'),
  route('POST', '/sessions/:id/queued-message/restore'),
  route('POST', '/:id/sessions/:id/active-model'),
  route('POST', '/:id/sessions/:id/active-effort'),
];

/** User routes a Hosted Relay answers; Git identity lives on RuntimeNodes, not on the relay host. */
export const HOSTED_RELAY_USER_ROUTES: AllowedRoute[] = [
  route('GET', '/onboarding-status'),
  route('POST', '/complete-onboarding'),
];

export function sendHostedRelayUnsupported(res: Response): void {
  res.status(501).json({
    success: false,
    error: {
      code: 'HOSTED_RELAY_UNSUPPORTED',
      message: 'Not available on the hosted relay: it never reads files, runs Git, shells, tasks or providers itself. Use a runtime node.',
    },
  });
}

/** Lets only the listed method/path pairs reach the router mounted after it. */
export function createRouteAllowlist(allowed: AllowedRoute[]): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    if (allowed.some((entry) => entry.method === method && entry.path.test(req.path))) {
      next();
      return;
    }
    sendHostedRelayUnsupported(res);
  };
}

/** Terminal handler for every other API path on a Hosted Relay. */
export function hostedRelayUnsupported(_req: Request, res: Response): void {
  sendHostedRelayUnsupported(res);
}

/**
 * Projects as a Hosted Relay knows them (FT-M11): the registry by id, with
 * each project's session rows. No folder is read, synchronized, created,
 * cloned or deleted here.
 */
export function createHostedRelayProjectsRouter(): express.Router {
  const router = express.Router();

  router.use('/registry', createProjectRegistryRouter({
    registry: createLocalProjectRegistry(),
    locator: createProjectWorkspaceLocator(),
  }));

  router.get('/', (req: Request, res: Response) => {
    const readNumber = (value: unknown) => {
      const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN;
      return Number.isNaN(parsed) ? undefined : parsed;
    };
    res.json(getRegistryProjectsWithSessions({
      sessionsLimit: readNumber(req.query.sessionsLimit),
      sessionsOffset: readNumber(req.query.sessionsOffset),
    }));
  });

  router.get(
    '/:projectId/sessions',
    asyncHandler(async (req: Request, res: Response) => {
      const readCount = (value: unknown, fallback: number) => {
        const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN;
        return Number.isNaN(parsed) || parsed < 0 ? fallback : parsed;
      };
      res.json(await getProjectSessionsPage(String(req.params.projectId ?? ''), {
        limit: readCount(req.query.limit, 20),
        offset: readCount(req.query.offset, 0),
      }));
    }),
  );

  router.use(hostedRelayUnsupported);
  return router;
}
