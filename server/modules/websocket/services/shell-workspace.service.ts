import type { WorkspaceResolution } from '@/modules/project-registry/index.js';

/** `path: null` keeps the client folder: only for shells that name no registered project (login, usage, plain). */
export type ShellWorkspaceDecision =
  | { ok: true; path: string | null }
  | { ok: false; code: string; message: string };

type ShellWorkspaceDependencies = {
  getSession(sessionId: string): { project_id: string | null; runtime_node_id: string | null } | null;
  isRemoteBinding(runtimeNodeId: string | null): boolean;
  resolveOnControlPlane(projectId: string): WorkspaceResolution;
};

const REFUSAL_MESSAGES: Partial<Record<string, string>> = {
  WORKSPACE_NOT_ON_NODE: 'This project has no folder on this machine, so a terminal cannot open here.',
};

/**
 * Where a Shell for a project or session opens (FT-M10). The terminal always
 * runs on THIS machine, so it opens only in this machine's own copy of the
 * project, resolved by id: a session bound to a remote RuntimeNode, or a
 * project with no copy here, is refused — never opened in the control plane's
 * folder or current directory instead. A session's own project wins over the
 * client's claim, as its Claude binding does.
 */
export function createShellWorkspaceResolver(dependencies: ShellWorkspaceDependencies) {
  return (input: { sessionId: string | null; projectId: string | null }): ShellWorkspaceDecision => {
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
    const resolution = dependencies.resolveOnControlPlane(projectId);
    if (resolution.ok) {
      return { ok: true, path: resolution.path };
    }
    if (resolution.code === 'PROJECT_NOT_FOUND') {
      return { ok: true, path: null };
    }
    return {
      ok: false,
      code: resolution.code,
      message: REFUSAL_MESSAGES[resolution.code] ?? 'This project\'s folder on this machine is unavailable.',
    };
  };
}
