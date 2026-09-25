import fs from 'node:fs';
import http, { type IncomingMessage } from 'node:http';
import path from 'node:path';

import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';

import { authenticateToken, authenticateWebSocket, authRoutes, validateApiKey } from '@/modules/auth/index.js';
import { initializeDatabase, runtimeNodesDb } from '@/modules/database/index.js';
import { setRuntimeLinkPresence } from '@/modules/project-registry/index.js';
import { providerRoutes } from '@/modules/providers/index.js';
import { createRemoteAccess, readRemoteGatewayConfig } from '@/modules/remote-access/index.js';
import { runtimeNodeLinkRoutes, runtimeNodesRoutes, runtimeNodesService } from '@/modules/runtime-nodes/index.js';
import { userRoutes } from '@/modules/user/index.js';
import { createWebSocketServer } from '@/modules/websocket/index.js';
import {
  createHostedRelayProjectsRouter,
  createRouteAllowlist,
  HOSTED_RELAY_PROVIDER_ROUTES,
  HOSTED_RELAY_USER_ROUTES,
  hostedRelayUnsupported,
} from '@/modules/hosted-relay/hosted-relay-routes.js';
import { buildRelayContentSecurityPolicy } from '@/modules/hosted-relay/hosted-relay-csp.js';
import { createCorrespondingSourceHandler } from '@/shared/corresponding-source.js';
import { AppError, setServerRole } from '@/shared/utils.js';

import { buildLoopbackOrigins, isLoopbackHost } from '../../../shared/networkHosts.js';

/** A relay only carries coordination messages; nothing large is ever uploaded to it. */
export const HOSTED_RELAY_JSON_LIMIT = '1mb';

type ChatRuntime = Parameters<typeof createWebSocketServer>[1]['chat']['runtime'];

const noLocalRuntimeError = () => new AppError('The hosted relay never runs a provider itself.', {
  code: 'HOSTED_RELAY_NO_LOCAL_RUNTIME',
  statusCode: 409,
});

/**
 * The chat gateway's provider runtime on a Hosted Relay. Remote nodes run
 * Claude only, so that is the one provider a session may name; any attempt
 * to execute locally fails instead of starting a process.
 */
export const hostedRelayProviderRuntime: ChatRuntime = {
  hasRuntime: (provider) => provider === 'claude',
  run: async () => {
    throw noLocalRuntimeError();
  },
  abort: async () => false,
  resolveToolApproval: () => ({ status: 'rejected', reason: 'not_found' }),
  getPendingApprovalsForSession: () => [],
  getRecentPermissionOutcomesForSession: () => [],
};

export type HostedRelayOptions = {
  env: NodeJS.ProcessEnv;
  appRoot: string;
  runningVersion: string | null;
  host: string;
  port: number;
  isPlatform: boolean;
};

/**
 * Hosted Relay composition (FT-M11): coordination for browsers and outbound
 * RuntimeNodes, reusing the control plane's auth, remote gateway, node link,
 * registry and chat routing, but mounting none of its execution surfaces.
 * Files, Git, Shell, TaskMaster, Worktrees, uploads, plugins, provider CLIs
 * and transcripts do not exist here; their API paths answer 501.
 */
export function createHostedRelay(options: HostedRelayOptions) {
  setServerRole('hosted-relay');

  const app = express();
  app.disable('x-powered-by');
  const server = http.createServer(app);
  const allowedOrigins = buildLoopbackOrigins([options.port]);
  let ready = false;

  const gatewayConfig = readRemoteGatewayConfig(options.env, { isPlatform: options.isPlatform, serverPort: options.port });
  const publicOrigin = gatewayConfig.ok && gatewayConfig.config.mode !== 'off' ? gatewayConfig.config.publicOrigin : null;
  const remoteAccess = createRemoteAccess({
    configResult: gatewayConfig,
    localListener: { host: options.host, port: options.port, loopbackOnly: isLoopbackHost(options.host) },
    authenticateToken,
  });

  setRuntimeLinkPresence({ isUsable: (nodeId) => runtimeNodesService.link.isUsable(nodeId) });

  const wss = createWebSocketServer(server, {
    verifyClient: {
      isPlatform: false,
      authenticateWebSocket,
      allowedOrigins,
      remote: remoteAccess.websocket,
      nodeLink: {
        path: runtimeNodesService.link.path,
        verify: (request) => runtimeNodesService.link.verifyUpgrade(request),
      },
    },
    handleNodeLinkConnection: (ws, request) => runtimeNodesService.link.handleConnection(ws, request),
    onBrowserConnection: (ws, request) => remoteAccess.trackSocket(ws, request),
    chat: { runtime: hostedRelayProviderRuntime },
    desktopNotifications: false,
  });
  app.locals.wss = wss;

  app.use(remoteAccess.requestGuard);
  app.use(cors({
    origin(origin, callback) {
      callback(null, !origin || allowedOrigins.has(origin));
    },
    exposedHeaders: ['X-Refreshed-Token', 'X-Auth-Error'],
  }));
  app.use(express.json({ limit: HOSTED_RELAY_JSON_LIMIT }));

  app.get('/health', (req, res) => {
    if (remoteAccess.websocket.isRemote(req as IncomingMessage)) {
      res.json({ status: 'ok' });
      return;
    }
    res.status(ready ? 200 : 503).json({
      status: ready ? 'ok' : 'starting',
      role: 'hosted-relay',
      version: options.runningVersion,
      ready,
      appReady: fs.existsSync(path.join(options.appRoot, 'dist', 'index.html')),
    });
  });

  // AGPL-3.0 §13 offer: public, credential-free, and never a redirect to anything but the operator's https URL.
  app.get('/source', createCorrespondingSourceHandler(options.env));

  app.use('/api/runtime-node-link', runtimeNodeLinkRoutes);
  app.use('/api', validateApiKey);
  app.use('/api/auth', authRoutes);
  app.use('/api/remote-access', remoteAccess.router);
  app.get('/api/relay/status', authenticateToken, (_req, res) => {
    res.json({ success: true, data: { role: 'hosted-relay', executesLocally: false } });
  });
  app.use('/api/runtime-nodes', authenticateToken, runtimeNodesRoutes);
  app.use('/api/projects', authenticateToken, createHostedRelayProjectsRouter());
  app.use('/api/providers', authenticateToken, createRouteAllowlist(HOSTED_RELAY_PROVIDER_ROUTES), providerRoutes);
  // Onboarding configures the host's Git identity and provider logins, and a relay has neither
  // (Git identity lives on RuntimeNodes: /api/user/git-config answers 501). Asking a user to
  // finish it would trap them on a step they cannot complete, so it never gates the relay.
  app.get('/api/user/onboarding-status', authenticateToken, (_req, res) => {
    res.json({ success: true, hasCompletedOnboarding: true });
  });
  app.use('/api/user', authenticateToken, createRouteAllowlist(HOSTED_RELAY_USER_ROUTES), userRoutes);
  // Authentication first: an anonymous caller learns nothing about which surfaces exist.
  app.use('/api', authenticateToken, hostedRelayUnsupported);

  const distDirectory = path.join(options.appRoot, 'dist');
  app.use(express.static(distDirectory, {
    index: false,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      } else if (/\.(js|css|woff2?|ttf|eot|svg|png|jpg|jpeg|gif|ico)$/.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  }));
  app.use(express.static(path.join(options.appRoot, 'public'), { index: false }));

  app.get('*', (req, res) => {
    if (path.extname(req.path)) {
      res.status(404).send('Not found');
      return;
    }
    const indexPath = path.join(distDirectory, 'index.html');
    if (!fs.existsSync(indexPath)) {
      // No dev-server redirect: a relay serves only a production build.
      res.status(503).send('The CloudCLI web client is not built on this relay (npm run build:client).');
      return;
    }
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Content-Security-Policy', buildRelayContentSecurityPolicy(publicOrigin, fs.readFileSync(indexPath, 'utf8')));
    res.sendFile(indexPath);
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.statusCode).json({ success: false, error: { code: err.code, message: err.message, details: err.details } });
      return;
    }
    const status = (err as { status?: unknown })?.status;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      // Body-parser refusals (too large, malformed JSON) are the client's, and say nothing about the server.
      res.status(status).json({ success: false, error: { code: status === 413 ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST', message: 'Request rejected.' } });
      return;
    }
    console.error('[Relay] Unhandled error:', err instanceof Error ? err.message : 'error');
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  });

  return {
    app,
    server,
    wss,
    remoteAccess,

    /**
     * Refuses to start as anything but a relay: platform mode (no auth), a
     * non-loopback app listener, or a database that already holds a local
     * RuntimeNode (a control plane's database) all stop startup explicitly.
     */
    async start(): Promise<{ port: number; gateway: Awaited<ReturnType<typeof remoteAccess.startGateway>> }> {
      if (options.isPlatform) {
        throw new Error('The hosted relay cannot run in platform mode (VITE_IS_PLATFORM=true), which skips authentication.');
      }
      if (!isLoopbackHost(options.host)) {
        throw new Error(`HOST=${options.host}: the relay's app listener stays on loopback. Browsers and nodes reach it only through CLOUDCLI_REMOTE_GATEWAY.`);
      }
      await initializeDatabase();
      if (runtimeNodesDb.getLocal()) {
        throw new Error('This database belongs to a CloudCLI control plane (it holds a local RuntimeNode). Give the relay its own DATABASE_PATH.');
      }

      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port, options.host, () => {
          server.off('error', reject);
          resolve();
        });
      });
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : options.port;

      const gateway = await remoteAccess.startGateway({
        handleRequest: app,
        handleUpgrade: (request, socket, head) => {
          wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
        },
      });
      ready = true;
      return { port, gateway };
    },

    async close(): Promise<void> {
      ready = false;
      for (const client of wss.clients) {
        client.terminate();
      }
      wss.close();
      await remoteAccess.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export type HostedRelay = ReturnType<typeof createHostedRelay>;
