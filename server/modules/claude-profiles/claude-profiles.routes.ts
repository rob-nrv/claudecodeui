import express, { type Request, type Response } from 'express';

import { claudeLiveUsageService } from '@/modules/claude-profiles/claude-live-usage.service.js';
import { claudeProfilesService } from '@/modules/claude-profiles/claude-profiles.service.js';
import type { ClaudeLiveUsage, ClaudeProfile } from '@/shared/types.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

type ClaudeProfilesRouterService = {
  listProfiles(): ClaudeProfile[];
  createProfile(input: { displayName: unknown }): Promise<ClaudeProfile>;
  renameProfile(id: string, displayName: unknown): ClaudeProfile;
  setDefaultProfile(id: string): ClaudeProfile;
  removeProfile(id: string): ClaudeProfile;
  verifyProfile(id: string): Promise<ClaudeProfile>;
};

/** `null` addresses the historical un-isolated `~/.claude` account, which has no profile row. */
type ClaudeLiveUsageRouterService = {
  getLiveUsage(profileId: string | null): Promise<ClaudeLiveUsage>;
  enableBridge(profileId: string | null): Promise<ClaudeLiveUsage>;
  disableBridge(profileId: string | null): Promise<ClaudeLiveUsage>;
};

const LEGACY_HOME_LIVE_USAGE_PATH = '/legacy-home/live-usage';

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
  liveUsageService: ClaudeLiveUsageRouterService = claudeLiveUsageService,
): express.Router {
  const router = express.Router();

  // Live usage for the historical account (FT-M07). Registered before every
  // `/:id` route so this literal segment is never read as a profile id.
  router.get(
    LEGACY_HOME_LIVE_USAGE_PATH,
    asyncHandler(async (_req: Request, res: Response) => {
      res.json(createApiSuccessResponse({ liveUsage: await liveUsageService.getLiveUsage(null) }));
    }),
  );

  router.post(
    `${LEGACY_HOME_LIVE_USAGE_PATH}/bridge`,
    asyncHandler(async (_req: Request, res: Response) => {
      res.json(createApiSuccessResponse({ liveUsage: await liveUsageService.enableBridge(null) }));
    }),
  );

  router.delete(
    `${LEGACY_HOME_LIVE_USAGE_PATH}/bridge`,
    asyncHandler(async (_req: Request, res: Response) => {
      res.json(createApiSuccessResponse({ liveUsage: await liveUsageService.disableBridge(null) }));
    }),
  );

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

  // Live usage for one isolated account (FT-M07): read, and the explicit
  // user-initiated install/removal of the statusLine capture bridge.
  router.get(
    '/:id/live-usage',
    asyncHandler(async (req: Request, res: Response) => {
      const id = readPathParam(req.params.id, 'id');
      res.json(createApiSuccessResponse({ liveUsage: await liveUsageService.getLiveUsage(id) }));
    }),
  );

  router.post(
    '/:id/live-usage/bridge',
    asyncHandler(async (req: Request, res: Response) => {
      const id = readPathParam(req.params.id, 'id');
      res.json(createApiSuccessResponse({ liveUsage: await liveUsageService.enableBridge(id) }));
    }),
  );

  router.delete(
    '/:id/live-usage/bridge',
    asyncHandler(async (req: Request, res: Response) => {
      const id = readPathParam(req.params.id, 'id');
      res.json(createApiSuccessResponse({ liveUsage: await liveUsageService.disableBridge(id) }));
    }),
  );

  return router;
}

export default createClaudeProfilesRouter();
