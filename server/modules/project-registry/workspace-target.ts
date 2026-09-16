import { AsyncLocalStorage } from 'node:async_hooks';

import type { NextFunction, Request, Response } from 'express';

import {
  createProjectWorkspaceLocator,
  toWorkspaceResolutionError,
  type ProjectWorkspaceLocator,
  type RuntimeNodeLinkPresence,
} from '@/modules/project-registry/local-project-registry.js';
import { AppError } from '@/shared/utils.js';

/**
 * The RuntimeNode a browser is working against for one project (FT-M10): the
 * node of the selected session, or the node chosen for the project. Sent by
 * the client as a pair so a target can never leak onto another project.
 */
export const RUNTIME_TARGET_NODE_HEADER = 'x-cloudcli-runtime-node';
export const RUNTIME_TARGET_PROJECT_HEADER = 'x-cloudcli-runtime-project';

const NODE_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const PROJECT_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

type RuntimeTarget = { projectId: string; nodeId: string };

const requestTargets = new AsyncLocalStorage<RuntimeTarget | null>();

const readHeader = (req: Request, name: string): string | null => {
  const value = req.headers[name];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
};

/** Reads the explicit target of a workspace request; malformed or half-sent targets are refused, never ignored. */
export function runtimeTargetMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const nodeId = readHeader(req, RUNTIME_TARGET_NODE_HEADER);
  const projectId = readHeader(req, RUNTIME_TARGET_PROJECT_HEADER);
  if (!nodeId && !projectId) {
    requestTargets.run(null, next);
    return;
  }
  if (!nodeId || !projectId || !NODE_ID_PATTERN.test(nodeId) || !PROJECT_ID_PATTERN.test(projectId)) {
    next(new AppError('The runtime target must name both a valid node and a valid project.', {
      code: 'RUNTIME_TARGET_INVALID',
      statusCode: 400,
    }));
    return;
  }
  requestTargets.run({ projectId, nodeId }, next);
}

/** The explicitly targeted node for this project in the current request, or null when none was sent for it. */
export function readRequestRuntimeTarget(projectId: string): string | null {
  const target = requestTargets.getStore();
  return target && target.projectId === projectId ? target.nodeId : null;
}

/**
 * Path of a project's working copy for a surface that runs on THIS machine
 * (Files, Git, TaskMaster, Worktrees). With an explicit target, exactly that
 * node is resolved: the local node yields this machine's copy; a remote node
 * is refused on its own grounds (not enrolled, revoked, not mapped, offline)
 * or, when its folder is usable, because these operations are not available
 * on another machine yet. Without a target, this machine is the target.
 * "null" keeps the surfaces' project-not-found contract. Never another node's
 * folder, never the current directory.
 */
export function resolveWorkspacePathForTarget(
  locator: ProjectWorkspaceLocator,
  projectId: string,
  targetNodeId: string | null,
): string | null {
  const resolution = targetNodeId
    ? locator.resolve({ projectId, nodeId: targetNodeId })
    : locator.resolveOnControlPlane(projectId);
  if (resolution.ok && resolution.isLocalNode) {
    return resolution.path;
  }
  if (resolution.ok) {
    throw new AppError('This project\'s folder is on another runtime node; this operation is not available there from this machine yet.', {
      code: 'WORKSPACE_REMOTE_OPERATION_UNSUPPORTED',
      statusCode: 409,
      details: { projectId, nodeId: resolution.nodeId },
    });
  }
  if (resolution.code === 'PROJECT_NOT_FOUND') {
    return null;
  }
  throw toWorkspaceResolutionError(resolution);
}

let linkPresence: RuntimeNodeLinkPresence = { isUsable: () => false };

/** Lets server/index.ts report real node links, so an offline target reads as offline. */
export function setRuntimeLinkPresence(presence: RuntimeNodeLinkPresence): void {
  linkPresence = presence;
}

const requestWorkspaces = createProjectWorkspaceLocator({ isUsable: (nodeId) => linkPresence.isUsable(nodeId) });

/** `resolveWorkspacePathForTarget` for the current request's explicit target; consumed by the workspace surfaces' modules. */
export function resolveRequestWorkspacePath(projectId: string): string | null {
  return resolveWorkspacePathForTarget(requestWorkspaces, projectId, readRequestRuntimeTarget(projectId));
}
