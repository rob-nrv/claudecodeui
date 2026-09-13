import express, { type Request, type Response } from 'express';

import { runtimeNodesService } from '@/modules/runtime-nodes/runtime-nodes.service.js';
import type { RuntimeNodeView } from '@/shared/types.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

type RuntimeNodesRouterService = {
  listNodes(options: { refresh?: boolean }): Promise<{ localNodeId: string; nodes: RuntimeNodeView[] }>;
};

const parseRefreshQuery = (value: unknown): boolean => {
  if (value === undefined) {
    return false;
  }
  if (value === '1' || value === 'true') {
    return true;
  }
  if (value === '0' || value === 'false') {
    return false;
  }
  throw new AppError('refresh must be true or false.', {
    code: 'INVALID_QUERY_PARAMETER',
    statusCode: 400,
  });
};

/**
 * Factory so tests can bind the router to a service built over a temporary
 * database; server/index.ts mounts the default instance behind authentication.
 * Read-only on purpose: node identity and capabilities come from the server's
 * own probes, never from a client.
 */
export function createRuntimeNodesRouter(
  service: RuntimeNodesRouterService = runtimeNodesService,
): express.Router {
  const router = express.Router();

  router.get(
    '/',
    asyncHandler(async (req: Request, res: Response) => {
      const listing = await service.listNodes({ refresh: parseRefreshQuery(req.query.refresh) });
      res.json(createApiSuccessResponse(listing));
    }),
  );

  return router;
}

export default createRuntimeNodesRouter();
