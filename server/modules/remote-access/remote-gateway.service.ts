import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import type { Duplex } from 'node:stream';

import type { RemoteGatewayConfig, RemoteGatewayConfigResult } from '@/modules/remote-access/remote-gateway-config.js';
import { markRemoteTransport } from '@/modules/remote-access/remote-transport.js';
import { setTrustedClientAddress } from '@/shared/utils.js';

/** What the gateway is doing right now; exposed (without secrets or key paths) in Settings. */
export type RemoteGatewayStatus = {
  mode: RemoteGatewayConfig['mode'] | 'invalid';
  state: 'disabled' | 'starting' | 'listening' | 'failed';
  publicOrigin: string | null;
  bindHost: string | null;
  port: number | null;
  error: string | null;
};

type GatewayHandlers = {
  handleRequest(request: IncomingMessage, response: ServerResponse): void;
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
};

/** Initial status derived from configuration alone, before anything listens. */
export function describeConfiguredGateway(result: RemoteGatewayConfigResult): RemoteGatewayStatus {
  if (!result.ok) {
    return { mode: 'invalid', state: 'failed', publicOrigin: null, bindHost: null, port: null, error: result.error };
  }
  const { config } = result;
  if (config.mode === 'off') {
    return { mode: 'off', state: 'disabled', publicOrigin: null, bindHost: null, port: null, error: null };
  }
  return { mode: config.mode, state: 'starting', publicOrigin: config.publicOrigin, bindHost: config.bindHost, port: config.port, error: null };
}

function describeListenError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'EADDRINUSE') return 'The remote gateway port is already in use.';
  if (code === 'EACCES') return 'Not allowed to listen on the remote gateway port.';
  if (code === 'EADDRNOTAVAIL') return 'The remote gateway bind address is not available on this machine.';
  return 'The remote gateway could not start.';
}

/**
 * Client address behind a same-machine TLS terminator (external-tls). The
 * terminator appends the peer it saw as the LAST X-Forwarded-For entry, so
 * that entry is the only one a client cannot choose; earlier ones are ignored.
 * An absent or malformed header falls back to the TCP peer (the terminator
 * itself), never to a client-supplied value. Headers from a non-loopback peer
 * are ignored.
 */
export function resolveTerminatorClientAddress(forwardedFor: string | string[] | undefined, peer: string | undefined): string {
  // Defence in depth: the listener is loopback-bound, but a header from any other peer is never believed.
  if (!peer || !/^(127\.|::1$|::ffff:127\.)/.test(peer)) {
    return peer || 'unknown';
  }
  const header = Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor;
  const last = header?.split(',').pop()?.trim();
  return last && isIP(last) ? last : peer || 'unknown';
}

/**
 * Starts the second, remote-facing listener. Every request and upgrade it
 * receives is marked as remote before the application sees it. Failure never
 * affects the local listener: it is reported through the returned status.
 */
export async function startRemoteGateway(
  config: RemoteGatewayConfig,
  handlers: GatewayHandlers,
  onStatus: (status: RemoteGatewayStatus) => void,
): Promise<{ close(): Promise<void> } | null> {
  if (config.mode === 'off') {
    return null;
  }

  const baseStatus = { mode: config.mode, publicOrigin: config.publicOrigin, bindHost: config.bindHost, port: config.port };
  // Only external-tls listens on loopback for a terminator we operate; a tls-mode peer is the client itself.
  const markRemote = (request: IncomingMessage) => {
    markRemoteTransport(request);
    if (config.mode === 'external-tls') {
      setTrustedClientAddress(request, resolveTerminatorClientAddress(request.headers['x-forwarded-for'], request.socket.remoteAddress));
    }
  };
  const onRequest = (request: IncomingMessage, response: ServerResponse) => {
    markRemote(request);
    handlers.handleRequest(request, response);
  };

  let server: http.Server | https.Server;
  try {
    server = config.mode === 'tls'
      ? https.createServer({
        cert: fs.readFileSync(config.certPath),
        key: fs.readFileSync(config.keyPath),
        minVersion: 'TLSv1.2',
      }, onRequest)
      : http.createServer(onRequest);
  } catch {
    // Never echo file contents or key material; the path is operator-supplied configuration.
    onStatus({ ...baseStatus, state: 'failed', error: 'The TLS certificate or key could not be loaded.' });
    return null;
  }

  server.headersTimeout = 30_000;
  server.requestTimeout = 60_000;
  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    markRemote(request);
    handlers.handleUpgrade(request, socket, head);
  });

  const listening = await new Promise<boolean>((resolve) => {
    server.once('error', (error) => {
      onStatus({ ...baseStatus, state: 'failed', error: describeListenError(error) });
      resolve(false);
    });
    server.listen(config.port, config.bindHost, () => resolve(true));
  });

  if (!listening) {
    return null;
  }

  onStatus({ ...baseStatus, state: 'listening', error: null });
  return {
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
