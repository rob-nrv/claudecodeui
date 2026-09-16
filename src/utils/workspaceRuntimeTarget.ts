/**
 * The RuntimeNode the user is working against for the selected project
 * (FT-M10), sent with every Files, Git, TaskMaster and Worktrees request so the
 * server resolves exactly that node's copy — or refuses — instead of assuming
 * this machine. Registered by MainContent; read at request time.
 */
export type WorkspaceRuntimeTarget = { projectId: string; nodeId: string };

const WORKSPACE_PATH_PREFIXES = ['/api/file-tree/', '/api/git/', '/api/taskmaster/', '/api/worktrees', '/api/projects/'];

let resolveTarget: () => WorkspaceRuntimeTarget | null = () => null;

export function setWorkspaceRuntimeTargetResolver(resolver: () => WorkspaceRuntimeTarget | null): void {
  resolveTarget = resolver;
}

/**
 * A selected session's own node always wins (null = runtime never recorded,
 * i.e. this machine); without a session, the node chosen for the project.
 */
export function selectWorkspaceRuntimeTarget(
  projectId: string | null | undefined,
  session: Record<string, unknown> | null | undefined,
  projectChoice: string | null,
): WorkspaceRuntimeTarget | null {
  if (!projectId) {
    return null;
  }
  const nodeId = session
    ? (typeof session.runtimeNodeId === 'string' && session.runtimeNodeId ? session.runtimeNodeId : null)
    : projectChoice;
  return nodeId ? { projectId, nodeId } : null;
}

export function workspaceRuntimeTargetHeaders(url: string): Record<string, string> {
  if (!WORKSPACE_PATH_PREFIXES.some((prefix) => url.startsWith(prefix))) {
    return {};
  }
  const target = resolveTarget();
  return target ? { 'X-CloudCLI-Runtime-Node': target.nodeId, 'X-CloudCLI-Runtime-Project': target.projectId } : {};
}
