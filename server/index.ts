#!/usr/bin/env node
// Load environment variables before other imports execute.
import './load-env.js';
import fs from 'fs';
import path from 'path';
import http from 'http';

import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';

import { AppError, findApplicationRoot, getModuleDirectory, IS_PLATFORM, terminalTextStyles } from '@/shared/utils.js';
import {
    closeSessionsWatcher,
    initializeSessionsWatcher,
    providerRuntimeService,
} from '@/modules/providers/index.js';
import { createShellWorkspaceResolver, createWebSocketServer } from '@/modules/websocket/index.js';
import {
    createProjectWorkspaceLocator,
    runtimeTargetMiddleware,
    setRuntimeLinkPresence,
} from '@/modules/project-registry/index.js';
import {
    buildLocalServerMarker,
    createLocalServerMarkerStore,
    createRuntimeIdentity,
} from '@/modules/runtime/index.js';
import { runtimeNodeLinkRoutes, runtimeNodesRoutes, runtimeNodesService } from '@/modules/runtime-nodes/index.js';
import { createRemoteAccess, readRemoteGatewayConfig } from '@/modules/remote-access/index.js';

import { getConnectableHost, buildLoopbackOrigins, isLoopbackHost, resolveBindHost } from '../shared/networkHosts.js';

import { createGitModule } from './modules/git/index.js';
import {
    authenticateToken,
    authenticateWebSocket,
    authRoutes,
    validateApiKey,
} from './modules/auth/index.js';
import { taskmasterRoutes } from './modules/taskmaster/index.js';
import { commandsRoutes } from './modules/commands/index.js';
import { settingsRoutes } from './modules/settings/index.js';
import { createSystemModule } from './modules/system/index.js';
import { createAgentModule } from './modules/agent/index.js';
import projectModuleRoutes from './modules/projects/projects.routes.js';
import notificationRoutes from './modules/notifications/notifications.routes.js';
import { userRoutes } from './modules/user/index.js';
import {
    getPluginPort,
    pluginsRoutes,
    startEnabledPluginServers,
    stopAllPlugins,
} from './modules/plugins/index.js';
import providerRoutes from './modules/providers/provider.routes.js';
import claudeProfilesRoutes from './modules/claude-profiles/claude-profiles.routes.js';
import { voiceRoutes } from './modules/voice/index.js';
import browserUseRoutes from './modules/browser-use/browser-use.routes.js';
import { assetsRoutes } from './modules/assets/index.js';
import { fileTreeRoutes } from './modules/file-tree/index.js';
import { worktreesRoutes } from './modules/worktrees/index.js';
import browserUseMcpRoutes from './modules/browser-use/browser-use-mcp.routes.js';
import { browserUseService } from './modules/browser-use/browser-use.service.js';
import { claudeProfilesDb, initializeDatabase, sessionsDb } from './modules/database/index.js';
import { configureWebPush } from './modules/notifications/index.js';

const __dirname = getModuleDirectory(import.meta.url);
// The server source runs from /server, while the compiled output runs from /dist-server/server.
// Resolving the app root once keeps every repo-level lookup below aligned across both layouts.
const APP_ROOT = findApplicationRoot(__dirname);
const installMode = fs.existsSync(path.join(APP_ROOT, '.git')) ? 'git' : 'npm';
// Version of the code that is actually running, captured once at process
// startup. This intentionally does NOT re-read package.json per request: after
// an update replaces the files on disk, package.json reflects the NEW version
// while this long-lived process still runs the OLD code. The frontend bundle is
// rebuilt on update, so a mismatch between this value and the frontend's
// build-time version means the server was updated but not restarted.
const RUNNING_VERSION = (() => {
    try {
        return JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version || null;
    } catch {
        return null;
    }
})();
// Minted once per process and published both in the local-server marker and on
// /health, so a runtime controller can prove the server answering a port is the
// one it started rather than a leftover marker or an unrelated instance.
const RUNTIME_IDENTITY = createRuntimeIdentity();
const systemRoutes = createSystemModule({
    appRoot: APP_ROOT,
    installMode,
    isPlatform: IS_PLATFORM,
});
console.log('SERVER_PORT from env:', process.env.SERVER_PORT);

const app = express();
const server = http.createServer(app);

const SERVER_PORT = Number.parseInt(process.env.SERVER_PORT || '3001', 10);
const VITE_PORT = process.env.VITE_PORT || 5173;

// Local-only UI: only the app's own origins (backend + Vite dev server) may
// make cross-origin requests. No wildcard, and the literal "null" origin
// (sandboxed iframes/data: URIs) is never matched since it's never added here.
const ALLOWED_ORIGINS = buildLoopbackOrigins([SERVER_PORT, VITE_PORT]);

const queryClaude = providerRuntimeService.getRunner('claude');
const queryCursor = providerRuntimeService.getRunner('cursor');
const queryCodex = providerRuntimeService.getRunner('codex');
const queryOpenCode = providerRuntimeService.getRunner('opencode');
const gitRoutes = createGitModule({
    queryClaude,
    queryCursor,
});
const agentRoutes = createAgentModule({
    queryClaude,
    queryCursor,
    queryCodex,
    queryOpenCode,
});

const HOST = resolveBindHost(process.env.HOST);
const DISPLAY_HOST = getConnectableHost(HOST);

// Remote access (FT-M08): a separate, explicitly configured gateway listener
// with TLS, browser pairing and revocable server-side sessions. The listener
// above is never changed by it and stays loopback-only by default.
const remoteAccess = createRemoteAccess({
    configResult: readRemoteGatewayConfig(process.env, { isPlatform: IS_PLATFORM, serverPort: SERVER_PORT }),
    localListener: { host: HOST, port: SERVER_PORT, loopbackOnly: isLoopbackHost(HOST) },
    authenticateToken,
});

// Workspace surfaces (Files, Git, TaskMaster, Worktrees) refuse an offline target as offline (FT-M10).
setRuntimeLinkPresence({ isUsable: (nodeId) => runtimeNodesService.link.isUsable(nodeId) });

// Single WebSocket server that handles chat, shell, plugin proxy and RuntimeNode link paths.
const wss = createWebSocketServer(server, {
    verifyClient: {
        isPlatform: IS_PLATFORM,
        authenticateWebSocket,
        allowedOrigins: ALLOWED_ORIGINS,
        remote: remoteAccess.websocket,
        nodeLink: {
            path: runtimeNodesService.link.path,
            verify: (request) => runtimeNodesService.link.verifyUpgrade(request),
        },
    },
    handleNodeLinkConnection: (ws, request) => runtimeNodesService.link.handleConnection(ws, request),
    onBrowserConnection: (ws, request) => remoteAccess.trackSocket(ws, request),
    chat: {
        runtime: providerRuntimeService,
    },
    shell: {
        resolveProviderSessionId: (sessionId, provider) => {
            const dbSession = sessionsDb.getSessionById(sessionId);
            if (dbSession) {
                return dbSession.provider_session_id ?? null;
            }

            return null;
        },
        resolveClaudeProfileConfigDir: (profileId) => claudeProfilesDb.getById(profileId)?.configDirectory ?? null,
        resolveSessionClaudeProfileId: (sessionId) => sessionsDb.getSessionById(sessionId)?.claude_profile_id ?? null,
        resolveWorkspace: createShellWorkspaceResolver({
            getSession: (sessionId) => sessionsDb.getSessionById(sessionId),
            isRemoteBinding: (runtimeNodeId) => runtimeNodesService.isRemoteBinding(runtimeNodeId),
            locator: createProjectWorkspaceLocator({ isUsable: (nodeId) => runtimeNodesService.link.isUsable(nodeId) }),
        }),
    },
    getPluginPort,
});

// Make WebSocket server available to routes
app.locals.wss = wss;

// Applies only to requests that arrived through the remote gateway listener:
// security headers, CSRF origin checks, URL-credential refusal and the
// remote session cookie. Local requests pass through untouched.
app.use(remoteAccess.requestGuard);

app.use(cors({
    origin(origin, callback) {
        callback(null, !origin || ALLOWED_ORIGINS.has(origin));
    },
    exposedHeaders: ['X-Refreshed-Token', 'X-Auth-Error'],
}));
app.use(express.json({
    limit: '50mb',
    type: (req) => {
        // Skip multipart/form-data requests (for file uploads like images)
        const contentType = req.headers['content-type'] || '';
        if (contentType.includes('multipart/form-data')) {
            return false;
        }
        return contentType.includes('json');
    }
}));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Public health check endpoint (no authentication required)
app.get('/health', (req, res) => {
    // Remote callers learn liveness only, nothing about the installation.
    if (remoteAccess.websocket.isRemote(req)) {
        res.json({ status: 'ok' });
        return;
    }
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        installMode,
        version: RUNNING_VERSION,
        // Whether this process can actually serve the app, not just answer
        // JSON. A runtime launcher that only starts this backend (the Android
        // Runtime Controller never runs `vite` or `npm run build`) can produce
        // a server that is "healthy" and permanently unable to show anyone
        // the app it fronts; a readiness check that stops at this endpoint
        // responding would call that ONLINE.
        appReady: fs.existsSync(path.join(APP_ROOT, 'dist', 'index.html')),
        runtime: {
            instanceId: RUNTIME_IDENTITY.instanceId,
            startedAt: RUNTIME_IDENTITY.startedAt,
        },
    });
});

// RuntimeNode enrollment (public, authenticated by a one-time code, rate
// limited, browsers refused; FT-M08). Mounted before the optional API key
// check because node agents never hold that key.
app.use('/api/runtime-node-link', runtimeNodeLinkRoutes);

// Optional API key validation (if configured)
app.use('/api', validateApiKey);

// Authentication routes (public)
app.use('/api/auth', authRoutes);

// Remote browser pairing, remote sessions and gateway status (FT-M08)
app.use('/api/remote-access', remoteAccess.router);

// File Tree API Routes (protected)
app.use('/api/file-tree', authenticateToken, runtimeTargetMiddleware, fileTreeRoutes);

// Projects API Routes (protected)
app.use('/api/projects', authenticateToken, runtimeTargetMiddleware, projectModuleRoutes);

// Chat attachment upload/serving (global ~/.cloudcli/assets store, protected)
app.use('/api/assets', authenticateToken, assetsRoutes);

// Git API Routes (protected)
app.use('/api/git', authenticateToken, runtimeTargetMiddleware, gitRoutes);

// Git worktree management (protected)
app.use('/api/worktrees', authenticateToken, runtimeTargetMiddleware, worktreesRoutes);

// TaskMaster API Routes (protected)
app.use('/api/taskmaster', authenticateToken, runtimeTargetMiddleware, taskmasterRoutes);

// Commands API Routes (protected)
app.use('/api/commands', authenticateToken, commandsRoutes);

// Settings API Routes (protected)
app.use('/api/settings', authenticateToken, settingsRoutes);

app.use('/api/system', authenticateToken, systemRoutes);

app.use('/api/notifications', authenticateToken, notificationRoutes);

// User API Routes (protected)
app.use('/api/user', authenticateToken, userRoutes);

// Plugins API Routes (protected)
app.use('/api/plugins', authenticateToken, pluginsRoutes);

// Browser MCP bridge API (local token protected)
app.use('/api/browser-use-mcp', browserUseMcpRoutes);

// Browser API Routes (protected)
app.use('/api/browser-use', authenticateToken, browserUseRoutes);

// Unified provider MCP routes (protected)
app.use('/api/providers', authenticateToken, providerRoutes);

// Claude multi-account profile routes (protected)
app.use('/api/claude-profiles', authenticateToken, claudeProfilesRoutes);

// RuntimeNode identity and probed capabilities (protected, read-only; FT-M07)
app.use('/api/runtime-nodes', authenticateToken, runtimeNodesRoutes);

// Agent API Routes (uses API key authentication)
app.use('/api/agent', agentRoutes);

app.use('/api/voice', authenticateToken, voiceRoutes);

// Serve public files (like api-docs.html)
app.use(express.static(path.join(APP_ROOT, 'public')));

// Static files served after API routes
// Add cache control: HTML files should not be cached, but assets can be cached
app.use(express.static(path.join(APP_ROOT, 'dist'), {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
            // Prevent HTML caching to avoid service worker issues after builds
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        } else if (filePath.match(/\.(js|css|woff2?|ttf|eot|svg|png|jpg|jpeg|gif|ico)$/)) {
            // Cache static assets for 1 year (they have hashed names)
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
    }
}));

// API Routes (protected)
// /api/config endpoint removed - no longer needed
// Frontend now uses window.location for WebSocket URLs

// Chat uploads live under /api/assets (server/modules/assets), which stores
// images and general files in the global ~/.cloudcli/assets folder.

// Serve React app for all other routes (excluding static files)
app.get('*', (req, res) => {
    // Skip requests for static assets (files with extensions)
    if (path.extname(req.path)) {
        return res.status(404).send('Not found');
    }

    // Only serve index.html for HTML routes, not for static assets
    // Static assets should already be handled by express.static middleware above
    const indexPath = path.join(APP_ROOT, 'dist', 'index.html');

    // Check if dist/index.html exists (production build available)
    if (fs.existsSync(indexPath)) {
        // Set no-cache headers for HTML to prevent service worker issues
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.sendFile(indexPath);
    } else {
        // In development, redirect to Vite dev server only if dist doesn't exist
        const redirectHost = getConnectableHost(req.hostname);
        res.redirect(`${req.protocol}://${redirectHost}:${VITE_PORT}`);
    }
});

// global error middleware must be last
app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
      },
    });
  }

  console.error(err);

  return res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    },
  });
});

const localServerMarkerStore = createLocalServerMarkerStore();

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function writeLocalServerMarker() {
    await localServerMarkerStore.write(buildLocalServerMarker(RUNTIME_IDENTITY, {
        host: HOST,
        port: Number.parseInt(String(SERVER_PORT), 10),
        url: `http://${DISPLAY_HOST}:${SERVER_PORT}`,
        installMode,
        appRoot: APP_ROOT,
        version: RUNNING_VERSION,
    }));
}

async function removeLocalServerMarker() {
    try {
        await localServerMarkerStore.removeIfOwnedBy(RUNTIME_IDENTITY);
    } catch (error) {
        console.warn('[WARN] Could not remove local server marker:', getErrorMessage(error));
    }
}

// Initialize database and start server
async function startServer() {
    try {
        // Initialize authentication database
        await initializeDatabase();

        // Register this machine as the local RuntimeNode: stable id, descriptive
        // facts only. Capabilities are probed later, on demand and bounded.
        runtimeNodesService.registerLocalNode(RUNNING_VERSION);

        // Configure Web Push (VAPID keys)
        configureWebPush();

        // Check if running in production mode (dist folder exists)
        const distIndexPath = path.join(APP_ROOT, 'dist', 'index.html');
        const isProduction = fs.existsSync(distIndexPath);

        // Log Claude implementation mode
        console.log(`${terminalTextStyles.info('[INFO]')} Using Claude Agents SDK for Claude integration`);
        console.log('');

        if (isProduction) {
            console.log(`${terminalTextStyles.info('[INFO]')} To run in production mode, go to http://${DISPLAY_HOST}:${SERVER_PORT}`);
        }

        console.log(`${terminalTextStyles.info('[INFO]')} To run in development mode with hot-module replacement, go to http://${DISPLAY_HOST}:${VITE_PORT}`);
   
        server.listen(SERVER_PORT, HOST, async () => {
            const appInstallPath = APP_ROOT;
            await writeLocalServerMarker().catch((error) => {
                console.warn('[WARN] Could not write local server marker:', error.message);
            });

            console.log('');
            console.log(terminalTextStyles.dim('═'.repeat(63)));
            console.log(`  ${terminalTextStyles.bright('CloudCLI Server - Ready')}`);
            console.log(terminalTextStyles.dim('═'.repeat(63)));
            console.log('');
            console.log(`${terminalTextStyles.info('[INFO]')} Server URL:  ${terminalTextStyles.bright('http://' + DISPLAY_HOST + ':' + SERVER_PORT)}`);
            console.log(`${terminalTextStyles.info('[INFO]')} Installed at: ${terminalTextStyles.dim(appInstallPath)}`);
            console.log(`${terminalTextStyles.tip('[TIP]')}  Run "cloudcli status" for full configuration details`);
            console.log('');

            if (!isLoopbackHost(HOST)) {
                console.warn(`${terminalTextStyles.warn('[WARN]')} HOST=${HOST}: port ${SERVER_PORT} is reachable from the network without the remote gateway's TLS and pairing. Keep it on loopback and use CLOUDCLI_REMOTE_GATEWAY for remote access.`);
            }

            // The remote gateway is a second listener; its failure never affects this one.
            const gatewayStatus = await remoteAccess.startGateway({
                handleRequest: app,
                handleUpgrade: (request, socket, head) => {
                    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
                },
            });
            if (gatewayStatus.state === 'listening') {
                console.log(`${terminalTextStyles.info('[INFO]')} Remote gateway (${gatewayStatus.mode}): ${terminalTextStyles.bright(String(gatewayStatus.publicOrigin))} on ${gatewayStatus.bindHost}:${gatewayStatus.port}`);
            } else if (gatewayStatus.state === 'failed') {
                console.warn(`${terminalTextStyles.warn('[WARN]')} Remote gateway not started: ${gatewayStatus.error}`);
            }

            // Start watching the projects folder for changes
            await initializeSessionsWatcher();

            // Start server-side plugin processes for enabled plugins
            startEnabledPluginServers().catch(err => {
                console.error('[Plugins] Error during startup:', err.message);
            });
        });

        await closeSessionsWatcher();
        // Clean up plugin processes on shutdown
        const shutdownRuntimeServices = async () => {
            try {
                await browserUseService.stopAllSessions();
            } catch (err) {
                console.error('[Browser] Error stopping sessions during shutdown:', getErrorMessage(err));
            }
            try {
                await stopAllPlugins();
            } catch (err) {
                console.error('[Plugins] Error stopping plugins during shutdown:', getErrorMessage(err));
            }
            try {
                await remoteAccess.close();
            } catch (err) {
                console.error('[Remote] Error closing the remote gateway during shutdown:', getErrorMessage(err));
            }
            try {
                await removeLocalServerMarker();
            } catch (err) {
                console.error('[Local Server] Error removing server marker during shutdown:', getErrorMessage(err));
            }
            process.exit(0);
        };
        process.on('SIGTERM', () => void shutdownRuntimeServices());
        process.on('SIGINT', () => void shutdownRuntimeServices());
    } catch (error) {
        console.error('[ERROR] Failed to start server:', error);
        process.exit(1);
    }
}

startServer();
