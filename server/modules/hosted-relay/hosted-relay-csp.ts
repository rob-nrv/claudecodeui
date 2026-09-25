import { createHash } from 'node:crypto';

/** SHA-256 CSP sources for every inline classic script in the built index.html. */
export function hashInlineScripts(html: string): string[] {
  const hashes: string[] = [];
  for (const match of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
    hashes.push(`'sha256-${createHash('sha256').update(match[1]).digest('base64')}'`);
  }
  return hashes;
}

/**
 * Content-Security-Policy for the relay's web client. Scripts are limited to
 * the bundle and the exact inline service-worker registration (by hash);
 * Google Fonts is the only third-party origin the client loads. `wss:` is
 * pinned to the public origin because some browsers do not let 'self' cover it.
 */
export function buildRelayContentSecurityPolicy(publicOrigin: string | null, html: string): string {
  const websocketOrigin = publicOrigin ? publicOrigin.replace(/^https:/, 'wss:') : null;
  return [
    "default-src 'self'",
    `script-src 'self' ${hashInlineScripts(html).join(' ')}`.trim(),
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob:",
    `connect-src 'self'${websocketOrigin ? ` ${websocketOrigin}` : ''}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * AGPL-3.0 §13: where this modified version's Corresponding Source is offered.
 * Operator-supplied (CLOUDCLI_SOURCE_URL); anything but a plain https URL is
 * treated as unset so the endpoint can never redirect somewhere unexpected.
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
