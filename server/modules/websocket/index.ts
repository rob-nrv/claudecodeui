export { WS_OPEN_STATE, connectedClients } from './services/websocket-state.service.js';
export { createWebSocketServer } from './services/websocket-server.service.js';
// createShellWorkspaceResolver: used by server/index.ts to open project shells only in this machine's own copy (FT-M10).
export { createShellWorkspaceResolver } from './services/shell-workspace.service.js';
export { chatRunRegistry } from './services/chat-run-registry.service.js';
