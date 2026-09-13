import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_PATH_LENGTH = 4096;

export type NodeWorkspaceResolution = { ok: true; path: string } | { ok: false; reason: string };

function comparable(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

/**
 * Resolves a folder the control plane asks this node to use, confined to the
 * node's own workspace root. Symlinks are resolved before the containment
 * check, so a link inside the root that points elsewhere is refused. Used for
 * mapping verification, at every run start and for every history read — the
 * control plane's word is never enough.
 */
export async function resolveNodeWorkspacePath(workspaceRoot: string, requested: unknown): Promise<NodeWorkspaceResolution> {
  if (typeof requested !== 'string' || !requested || requested.length > MAX_PATH_LENGTH || requested.includes('\0')) {
    return { ok: false, reason: 'path_invalid' };
  }
  if (!path.isAbsolute(requested)) {
    return { ok: false, reason: 'path_not_absolute' };
  }

  let rootReal: string;
  try {
    rootReal = await fs.realpath(workspaceRoot);
  } catch {
    return { ok: false, reason: 'workspace_root_unavailable' };
  }

  let folderReal: string;
  try {
    folderReal = await fs.realpath(requested);
  } catch {
    return { ok: false, reason: 'folder_not_found' };
  }

  const relative = path.relative(comparable(rootReal), comparable(folderReal));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return { ok: false, reason: 'outside_workspace_root' };
  }

  try {
    if (!(await fs.stat(folderReal)).isDirectory()) {
      return { ok: false, reason: 'not_a_directory' };
    }
    await fs.access(folderReal, fsConstants.R_OK | fsConstants.W_OK);
  } catch {
    return { ok: false, reason: 'folder_not_accessible' };
  }

  return { ok: true, path: folderReal };
}

/** A filesystem root as the workspace root would confine nothing; the agent refuses to start with one. */
export async function validateNodeWorkspaceRoot(workspaceRoot: string): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  try {
    const real = await fs.realpath(workspaceRoot);
    if (!(await fs.stat(real)).isDirectory()) {
      return { ok: false, error: 'The workspace root is not a directory.' };
    }
    if (path.parse(real).root === real) {
      return { ok: false, error: 'The workspace root cannot be a filesystem root. Choose the folder that contains your projects.' };
    }
    return { ok: true, path: real };
  } catch {
    return { ok: false, error: 'The workspace root does not exist.' };
  }
}
