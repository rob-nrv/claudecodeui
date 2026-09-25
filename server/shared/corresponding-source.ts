import type { Request, RequestHandler, Response } from 'express';

/**
 * AGPL-3.0 section 13: where this modified version's Corresponding Source is
 * offered. Operator-supplied (CLOUDCLI_SOURCE_URL); anything but a plain https
 * URL is treated as unset so the endpoint can never redirect somewhere the
 * operator did not intend. There is deliberately no default: an unset value
 * answers 404 instead of pointing at a repository that is not this fork.
 */
export function readCorrespondingSourceUrl(env: NodeJS.ProcessEnv): string | null {
  const raw = env.CLOUDCLI_SOURCE_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Public GET /source: 302 to the configured URL, else an explicit "not configured" 404. */
export function createCorrespondingSourceHandler(env: NodeJS.ProcessEnv): RequestHandler {
  const url = readCorrespondingSourceUrl(env);
  return (_req: Request, res: Response) => {
    if (!url) {
      res.status(404).type('text/plain').send('The Corresponding Source location is not configured on this server (CLOUDCLI_SOURCE_URL).');
      return;
    }
    res.redirect(302, url);
  };
}
