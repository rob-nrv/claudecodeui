import express, { type Request, type Response } from 'express';

import { claudeProfilesService } from '@/modules/claude-profiles/claude-profiles.service.js';
import type { ClaudeProfile } from '@/shared/types.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

type ClaudeProfilesRouterService = {
  listProfiles(): ClaudeProfile[];
  createProfile(input: { displayName: unknown }): Promise<ClaudeProfile>;
  renameProfile(id: string, displayName: unknown): ClaudeProfile;
  setDefaultProfile(id: string): ClaudeProfile;
  removeProfile(id: string): ClaudeProfile;
  verifyProfile(id: string): Promise<ClaudeProfile>;
};

const readPathParam = (value: unknown, name: string): string => {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }

  throw new AppError(`${name} path parameter is invalid.`, {
    code: 'INVALID_PATH_PARAMETER',
    statusCode: 400,
  });
};

/**
 * Factory so tests can bind the router to a `claudeProfilesService` built
 * with an injected auth-status probe (see `claude-profiles.service.ts`) and
 * a temporary database, instead of the real singleton — mirrors
 * `createGitRouter`'s dependency-injection shape elsewhere in this codebase.
 */
export function createClaudeProfilesRouter(
  service: ClaudeProfilesRouterService = claudeProfilesService,
): express.Router {
  const router = express.Router();

  router.get(
    '/',
    asyncHandler(async (_req: Request, res: Response) => {
      res.json(createApiSuccessResponse({ profiles: service.listProfiles() }));
    }),
  );

  router.post(
    '/',
    asyncHandler(async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const profile = await service.createProfile({ displayName: body.displayName });
      res.status(201).json(createApiSuccessResponse({ profile }));
    }),
  );

  /**
   * Accepts either (or both) of `displayName` (rename) and `isDefault: true`
   * (set default) in one PATCH body, matching the plan's 5-route surface
   * rather than adding a separate endpoint per field.
   */
  router.patch(
    '/:id',
    asyncHandler(async (req: Request, res: Response) => {
      const id = readPathParam(req.params.id, 'id');
      const body = (req.body ?? {}) as Record<string, unknown>;

      let profile = null;
      if (typeof body.displayName === 'string') {
        profile = service.renameProfile(id, body.displayName);
      }
      if (body.isDefault === true) {
        profile = service.setDefaultProfile(id);
      }

      if (!profile) {
        throw new AppError('No supported field to update was provided.', {
          code: 'CLAUDE_PROFILE_UPDATE_EMPTY',
          statusCode: 400,
        });
      }

      res.json(createApiSuccessResponse({ profile }));
    }),
  );

  router.delete(
    '/:id',
    asyncHandler(async (req: Request, res: Response) => {
      const id = readPathParam(req.params.id, 'id');
      const profile = service.removeProfile(id);
      res.json(createApiSuccessResponse({ profile }));
    }),
  );

  router.post(
    '/:id/verify',
    asyncHandler(async (req: Request, res: Response) => {
      const id = readPathParam(req.params.id, 'id');
      const profile = await service.verifyProfile(id);
      res.json(createApiSuccessResponse({ profile }));
    }),
  );

  return router;
}

export default createClaudeProfilesRouter();
