import express, { type Request, type Response } from 'express';

import type { ProjectWorkspaceLocator } from '@/modules/project-registry/local-project-registry.js';
import {
  ProjectRegistryInputError,
  type ProjectListFilter,
  type ProjectRegistry,
  type RegisteredProject,
} from '@/modules/project-registry/project-registry.contract.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

const PROJECT_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const FILTERS: ProjectListFilter[] = ['active', 'archived', 'all'];

const parseFilter = (value: unknown): ProjectListFilter => {
  if (value === undefined) {
    return 'active';
  }
  if (typeof value === 'string' && (FILTERS as string[]).includes(value)) {
    return value as ProjectListFilter;
  }
  throw new AppError('filter must be active, archived or all.', { code: 'INVALID_QUERY_PARAMETER', statusCode: 400 });
};

const parseProjectId = (value: unknown): string => {
  if (typeof value === 'string' && PROJECT_ID_PATTERN.test(value)) {
    return value;
  }
  throw new AppError('projectId is invalid.', { code: 'INVALID_PROJECT_ID', statusCode: 400 });
};

/**
 * Registry routes (FT-M10), mounted by the projects routes at
 * `/api/projects/registry`. Every project is listed whatever its copies; no
 * path is ever returned — only whether THIS control plane holds a copy.
 */
export function createProjectRegistryRouter(dependencies: {
  registry: ProjectRegistry;
  locator: ProjectWorkspaceLocator;
}): express.Router {
  const { registry, locator } = dependencies;
  const router = express.Router();

  const toView = (project: RegisteredProject) => ({
    ...project,
    controlPlaneCopy: locator.resolveOnControlPlane(project.projectId).ok ? 'present' as const : 'absent' as const,
  });

  router.get(
    '/',
    asyncHandler(async (req: Request, res: Response) => {
      const projects = await registry.listProjects(parseFilter(req.query.filter));
      res.json(createApiSuccessResponse({ projects: projects.map(toView) }));
    }),
  );

  router.post(
    '/',
    asyncHandler(async (req: Request, res: Response) => {
      try {
        const project = await registry.registerProject({ displayName: (req.body as { displayName?: unknown } | undefined)?.displayName });
        res.status(201).json(createApiSuccessResponse({ project: toView(project) }));
      } catch (error) {
        if (error instanceof ProjectRegistryInputError) {
          throw new AppError(error.message, { code: error.code, statusCode: 400 });
        }
        throw error;
      }
    }),
  );

  router.get(
    '/:projectId',
    asyncHandler(async (req: Request, res: Response) => {
      const projectId = parseProjectId(req.params.projectId);
      const project = await registry.getProject(projectId);
      if (!project) {
        throw new AppError('Project not found.', { code: 'PROJECT_NOT_FOUND', statusCode: 404 });
      }
      const associations = await registry.listNodeAssociations(projectId);
      res.json(createApiSuccessResponse({ project: toView(project), associations }));
    }),
  );

  return router;
}
