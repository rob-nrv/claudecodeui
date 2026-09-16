import type { ProjectWorkspaceLocator } from '@/modules/project-registry/index.js';

/** `path: null` keeps the client folder: only for shells that name no registered project (login, usage, plain). */
export type ShellWorkspaceDecision =
  | { ok: true; path: string | null }
  | { ok: false; code: string; message: string };

type ShellWorkspaceDependencies = {
  getSession(sessionId: string): { project_id: string | null; runtime_node_id: string | null } | null;
  isRemoteBinding(runtimeNodeId: string | null): boolean;
  locator: Pick<ProjectWorkspaceLocator, 'resolve' | 'resolveOnControlPlane'>;
};

const REFUSAL_MESSAGES: Partial<Record<string, string>> = {
  WORKSPACE_NOT_ON_NODE: 'This project has no folder on the chosen runtime node, so a terminal cannot open there.',
  WORKSPACE_REMOTE_OPERATION_UNSUPPORTED: "This project's folder is on another runtime node; a terminal there is not available from this machine yet.",
  RUNTIME_NODE_OFFLINE: 'The chosen runtime node is offline; no other copy of the project is used instead.',
  RUNTIME_NODE_REVOKED: 'The chosen runtime node was revoked.',
  RUNTIME_NODE_NOT_ENROLLED: 'The chosen runtime node is not enrolled.',
  RUNTIME_NODE_NOT_FOUND: 'The chosen runtime node no longer exists.',
};

/**
 * Where a Shell for a project or session opens (FT-M10). The terminal always
 * runs on THIS machine. Its target is the session's own RuntimeNode when a
 * session is open (never the client's claim), otherwise the node the client
 * chose for the project. The target is resolved exactly: the local node opens
 * this machine's copy; a remote node — reachable or not, mapped or not — is
 * refused on its own grounds and nothing opens in this machine's folder or
 * current directory instead. Without a target (legacy sessions, no choice),
 * this machine is the target.
 */
export function createShellWorkspaceResolver(dependencies: ShellWorkspaceDependencies) {
  return (input: { sessionId: string | null; projectId: string | null; runtimeNodeId?: string | null }): ShellWorkspaceDecision => {
    const session = input.sessionId ? dependencies.getSession(input.sessionId) : null;
    if (session && dependencies.isRemoteBinding(session.runtime_node_id)) {
      return {
        ok: false,
        code: 'RUNTIME_NODE_REMOTE_SESSION',
        message: 'This session runs on another runtime node; a terminal here would not use its workspace.',
      };
    }

    const projectId = session?.project_id ?? input.projectId;
    if (!projectId) {
      return { ok: true, path: null };
    }
    const targetNodeId = session ? session.runtime_node_id : input.runtimeNodeId ?? null;
    const resolution = targetNodeId
      ? dependencies.locator.resolve({ projectId, nodeId: targetNodeId })
      : dependencies.locator.resolveOnControlPlane(projectId);
    if (resolution.ok && resolution.isLocalNode) {
      return { ok: true, path: resolution.path };
    }
    const code = resolution.ok ? 'WORKSPACE_REMOTE_OPERATION_UNSUPPORTED' : resolution.code;
    if (code === 'PROJECT_NOT_FOUND') {
      return { ok: true, path: null };
    }
    return {
      ok: false,
      code,
      message: REFUSAL_MESSAGES[code] ?? "This project's folder on the chosen runtime node is unavailable.",
    };
  };
}
