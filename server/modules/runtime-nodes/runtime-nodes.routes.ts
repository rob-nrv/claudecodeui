import express, { type Request, type Response } from 'express';

import { RUNTIME_NODE_CAPABILITY_IDS } from '@/modules/runtime-nodes/runtime-node-availability.js';
import { runtimeNodesService, type RuntimeNodesService } from '@/modules/runtime-nodes/runtime-nodes.service.js';
import type { RuntimeNodeCapabilityId } from '@/shared/types.js';
import { AppError, asyncHandler, createApiSuccessResponse, RUNTIME_NODE_LINK_PATH } from '@/shared/utils.js';

const NODE_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const PROJECT_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

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

const parseProjectId = (value: unknown, required: boolean): string | undefined => {
  if (value === undefined && !required) {
    return undefined;
  }
  if (typeof value === 'string' && PROJECT_ID_PATTERN.test(value)) {
    return value;
  }
  throw new AppError('projectId is invalid.', { code: 'INVALID_PROJECT_ID', statusCode: 400 });
};

const parseNodeId = (value: unknown): string => {
  if (typeof value === 'string' && NODE_ID_PATTERN.test(value)) {
    return value;
  }
  throw new AppError('nodeId is invalid.', { code: 'RUNTIME_NODE_ID_INVALID', statusCode: 400 });
};

const parseCapabilities = (value: unknown): RuntimeNodeCapabilityId[] => {
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  const known = new Set<string>(RUNTIME_NODE_CAPABILITY_IDS);
  if (values.length === 0 || values.length > RUNTIME_NODE_CAPABILITY_IDS.length || !values.every((entry) => typeof entry === 'string' && known.has(entry))) {
    throw new AppError('capability must name known runtime node capabilities.', { code: 'INVALID_QUERY_PARAMETER', statusCode: 400 });
  }
  return [...new Set(values as RuntimeNodeCapabilityId[])];
};

const readUserId = (req: Request): number | null => {
  const id = (req as Request & { user?: { id?: unknown } }).user?.id;
  return typeof id === 'number' ? id : null;
};

/**
 * Factory so tests can bind the router to a service built over a temporary
 * database; server/index.ts mounts the default instance behind authentication.
 * Node identity and capabilities come from the server's own probes (or probes
 * it requested from an authenticated node), never from a browser.
 */
export function createRuntimeNodesRouter(
  service: RuntimeNodesService = runtimeNodesService,
): express.Router {
  const router = express.Router();

  router.get(
    '/',
    asyncHandler(async (req: Request, res: Response) => {
      const listing = await service.listNodes({
        refresh: parseRefreshQuery(req.query.refresh),
        projectId: parseProjectId(req.query.projectId, false),
      });
      res.json(createApiSuccessResponse(listing));
    }),
  );

  router.get(
    '/verification',
    asyncHandler(async (req: Request, res: Response) => {
      const plan = await service.planVerification({
        capabilities: parseCapabilities(req.query.capability),
        nodeId: req.query.nodeId === undefined ? null : parseNodeId(req.query.nodeId),
      });
      res.json(createApiSuccessResponse(plan));
    }),
  );

  router.post('/enrollments', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { label?: unknown };
    const enrollment = service.createEnrollment(readUserId(req), body.label);
    res.status(201).json(createApiSuccessResponse({ ...enrollment, linkPath: RUNTIME_NODE_LINK_PATH }));
  });

  router.post('/:nodeId/revoke', (req: Request, res: Response) => {
    res.json(createApiSuccessResponse(service.revokeNode(parseNodeId(req.params.nodeId))));
  });

  router.put(
    '/:nodeId/workspaces/:projectId',
    asyncHandler(async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as { path?: unknown };
      const workspace = await service.mapWorkspace({
        nodeId: parseNodeId(req.params.nodeId),
        projectId: parseProjectId(req.params.projectId, true) as string,
        path: body.path,
      });
      res.json(createApiSuccessResponse({ workspace }));
    }),
  );

  // FT-M09: read-only state of the project's LOCAL working copy on that node, inspected by the node itself.
  router.get(
    '/:nodeId/workspaces/:projectId/state',
    asyncHandler(async (req: Request, res: Response) => {
      const workspace = await service.inspectProjectWorkspace(
        parseNodeId(req.params.nodeId),
        parseProjectId(req.params.projectId, true) as string,
      );
      res.json(createApiSuccessResponse({ workspace }));
    }),
  );

  router.delete('/:nodeId/workspaces/:projectId', (req: Request, res: Response) => {
    const removed = service.unmapWorkspace(parseNodeId(req.params.nodeId), parseProjectId(req.params.projectId, true) as string);
    res.json(createApiSuccessResponse({ removed }));
  });

  return router;
}

export default createRuntimeNodesRouter();
