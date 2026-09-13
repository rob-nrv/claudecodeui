import express, { type Request, type Response } from 'express';

import { runtimeNodesService, type RuntimeNodesService } from '@/modules/runtime-nodes/runtime-nodes.service.js';
import {
  AppError,
  createApiSuccessResponse,
  readRequestClientAddress,
  RUNTIME_NODE_LINK_PATH,
  RUNTIME_NODE_LINK_PROTOCOL_VERSION,
} from '@/shared/utils.js';

/**
 * Public RuntimeNode enrollment (FT-M08). The only unauthenticated node
 * endpoint: it is authenticated by a one-time enrollment code, rate limited,
 * and refuses anything that looks like a browser, so a web page can never
 * register itself as a RuntimeNode.
 */
export function createRuntimeNodeLinkRouter(service: RuntimeNodesService = runtimeNodesService): express.Router {
  const router = express.Router();

  router.post('/enroll', (req: Request, res: Response) => {
    if (req.headers.origin || req.headers.cookie) {
      throw new AppError('Runtime nodes enroll from the node agent, not from a browser.', {
        code: 'RUNTIME_NODE_CLIENT_REQUIRED',
        statusCode: 403,
      });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { nodeId } = service.redeemEnrollment({
      code: body.code,
      publicKey: body.publicKey,
      label: body.label,
      platform: body.platform,
      arch: body.arch,
      runtimeVersion: body.runtimeVersion,
      clientKey: readRequestClientAddress(req),
    });
    res.status(201).json(createApiSuccessResponse({
      nodeId,
      linkPath: RUNTIME_NODE_LINK_PATH,
      protocolVersion: RUNTIME_NODE_LINK_PROTOCOL_VERSION,
    }));
  });

  return router;
}

export default createRuntimeNodeLinkRouter();
