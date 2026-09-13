import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import type { Duplex } from 'node:stream';

import type { RequestHandler } from 'express';

import { remoteAccessDb, userDb } from '@/modules/database/index.js';
import {
  authenticateRemoteUpgrade,
  createRemoteRequestGuard,
} from '@/modules/remote-access/remote-access.middleware.js';
import { createRemoteAccessRouter } from '@/modules/remote-access/remote-access.routes.js';
import { createRemoteAccessService, type RemoteAccessService } from '@/modules/remote-access/remote-access.service.js';
import type { RemoteGatewayConfigResult } from '@/modules/remote-access/remote-gateway-config.js';
import {
  describeConfiguredGateway,
  startRemoteGateway,
  type RemoteGatewayStatus,
} from '@/modules/remote-access/remote-gateway.service.js';
import { createRemoteSocketRegistry } from '@/modules/remote-access/remote-socket-registry.js';
import { isRemoteTransport, readRemoteSessionId } from '@/modules/remote-access/remote-transport.js';

type BcryptAdapter = {
  hash(password: string, saltRounds: number): Promise<string>;
  compare(password: string, passwordHash: string): Promise<boolean>;
};

type LocalListenerFacts = { host: string; port: number; loopbackOnly: boolean };

const require = createRequire(import.meta.url);

function createDefaultService(): RemoteAccessService {
  const bcrypt = require('bcrypt') as BcryptAdapter;
  return createRemoteAccessService({
    users: {
      getUserByUsername: (username) =>
        userDb.getUserByUsername(username) as unknown as ({ id: number; username: string; password_hash: string } | undefined),
      getUserById: (userId) =>
        userDb.getUserById(userId) as unknown as ({ id: number; username: string } & Record<string, unknown>) | undefined,
    },
    comparePassword: (password, passwordHash) => bcrypt.compare(password, passwordHash),
    hashPassword: (password) => bcrypt.hash(password, 12),
    store: remoteAccessDb,
  });
}

/**
 * Composition root of remote browser access (FT-M08), consumed by the server
 * entrypoint. It owns the request guard, the pairing/session routes, browser
 * upgrade authentication, revocation of open sockets and the optional gateway
 * listener. `service` is injectable for integration tests.
 */
export function createRemoteAccess(options: {
  configResult: RemoteGatewayConfigResult;
  localListener: LocalListenerFacts;
  authenticateToken: RequestHandler;
  service?: RemoteAccessService;
}) {
  const service = options.service ?? createDefaultService();
  const publicOrigin = options.configResult.ok && options.configResult.config.mode !== 'off'
    ? options.configResult.config.publicOrigin
    : null;
  const sockets = createRemoteSocketRegistry({ isSessionActive: (sessionId) => service.isSessionActive(sessionId) });
  service.onSessionsRevoked((sessionIds) => sockets.closeSessions(sessionIds));

  let gatewayStatus: RemoteGatewayStatus = describeConfiguredGateway(options.configResult);
  let gatewayHandle: { close(): Promise<void> } | null = null;

  const getStatus = () => ({ gateway: gatewayStatus, localListener: options.localListener });

  return {
    service,
    requestGuard: createRemoteRequestGuard({ publicOrigin, service }),
    router: createRemoteAccessRouter({ service, authenticateToken: options.authenticateToken, getStatus }),
    getStatus,

    /** Browser upgrade authentication for requests that arrived through the gateway. */
    websocket: {
      isRemote: (request: IncomingMessage) => isRemoteTransport(request),
      authenticate: (request: IncomingMessage) => authenticateRemoteUpgrade(request, { publicOrigin, service }),
    },

    /** Registers an open remote browser socket so revocation or expiry closes it. */
    trackSocket(socket: Parameters<ReturnType<typeof createRemoteSocketRegistry>['track']>[1], request: IncomingMessage): void {
      const sessionId = readRemoteSessionId(request);
      if (sessionId) {
        sockets.track(sessionId, socket);
      }
    },

    async startGateway(handlers: {
      handleRequest(request: IncomingMessage, response: ServerResponse): void;
      handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
    }): Promise<RemoteGatewayStatus> {
      if (options.configResult.ok && gatewayStatus.state === 'starting') {
        gatewayHandle = await startRemoteGateway(options.configResult.config, handlers, (status) => {
          gatewayStatus = status;
        });
      }
      return gatewayStatus;
    },

    async close(): Promise<void> {
      await gatewayHandle?.close();
      gatewayHandle = null;
    },
  };
}
