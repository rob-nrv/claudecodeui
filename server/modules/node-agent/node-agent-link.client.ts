import { WebSocket } from 'ws';

import type { NodeAgentCredential } from '@/modules/node-agent/node-agent-credential.store.js';
import type { RuntimeNodeLinkNodeFrame } from '@/shared/types.js';
import { RUNTIME_NODE_LINK_PROTOCOL_VERSION, signRuntimeNodeLinkRequest } from '@/shared/utils.js';

/** Exit reasons the agent reports to its operator. */
export type NodeAgentLinkStop =
  | { reason: 'stopped' }
  | { reason: 'revoked' }
  | { reason: 'authentication_failed' };

type LinkClientDependencies = {
  credential: NodeAgentCredential;
  linkUrl: string;
  runtimeVersion: string | null;
  platform: string | null;
  arch: string | null;
  getActiveExecutions(): Array<{ executionId: string; lastSeq: number }>;
  onWelcome(frame: Record<string, unknown>): void;
  onFrame(frame: Record<string, unknown>): void;
  onDisconnected(): void;
  log(message: string): void;
  heartbeatMs?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  /** Consecutive refused upgrades (401/403) before the agent gives up; clock skew and revocation both look like this. */
  maxConsecutiveAuthFailures?: number;
  createSocket?: (url: string, options: { headers: Record<string, string>; handshakeTimeout: number; maxPayload: number }) => WebSocket;
};

const CLOSE_REVOKED = 4403;
const CLOSE_IDENTITY_CONFLICT = 4429;
const HEALTHY_CONNECTION_MS = 30_000;
const IDENTITY_CONFLICT_WAIT_MS = 60_000;

/**
 * The node's outbound, authenticated link to its control plane (FT-M08). The
 * node never listens on a port: it dials out over wss with a freshly signed
 * header per attempt, says hello, heartbeats every 20 s and reconnects with
 * capped, jittered exponential backoff. A revoked credential stops the agent.
 */
export function createNodeAgentLinkClient(dependencies: LinkClientDependencies) {
  const heartbeatMs = dependencies.heartbeatMs ?? 20_000;
  const initialBackoffMs = dependencies.initialBackoffMs ?? 1_000;
  const maxBackoffMs = dependencies.maxBackoffMs ?? 30_000;
  const maxConsecutiveAuthFailures = dependencies.maxConsecutiveAuthFailures ?? 5;
  const createSocket = dependencies.createSocket ?? ((url, options) => new WebSocket(url, options));
  const linkPath = new URL(dependencies.linkUrl).pathname;

  let socket: WebSocket | null = null;
  let welcomed = false;
  let stopped = false;
  let attempt = 0;
  let consecutiveAuthFailures = 0;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let healthyTimer: NodeJS.Timeout | null = null;
  let resolveDone: (stop: NodeAgentLinkStop) => void = () => undefined;
  const done = new Promise<NodeAgentLinkStop>((resolve) => {
    resolveDone = resolve;
  });

  const clearTimers = () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (healthyTimer) clearTimeout(healthyTimer);
    heartbeatTimer = null;
    healthyTimer = null;
  };

  const finish = (stop: NodeAgentLinkStop) => {
    stopped = true;
    clearTimers();
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    resolveDone(stop);
  };

  const scheduleReconnect = (minimumDelayMs = 0) => {
    if (stopped || reconnectTimer) {
      return;
    }
    const exponential = Math.min(maxBackoffMs, initialBackoffMs * 2 ** Math.min(attempt, 10));
    const jittered = exponential * (0.8 + Math.random() * 0.4);
    const delay = Math.max(minimumDelayMs, Math.round(jittered));
    attempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };

  const connect = () => {
    if (stopped || socket) {
      return;
    }
    const authorization = signRuntimeNodeLinkRequest({
      nodeId: dependencies.credential.nodeId,
      privateKeyPem: dependencies.credential.privateKeyPem,
      path: linkPath,
    });
    const current = createSocket(dependencies.linkUrl, {
      headers: { Authorization: authorization },
      handshakeTimeout: 10_000,
      maxPayload: 16 * 1024 * 1024,
    });
    socket = current;
    welcomed = false;

    current.on('unexpected-response', (_request, response) => {
      const status = response.statusCode ?? 0;
      response.resume();
      if (status === 401 || status === 403) {
        consecutiveAuthFailures += 1;
        dependencies.log(`Control plane refused the link (${status}). Check that this node was not revoked and that its clock is correct.`);
        if (consecutiveAuthFailures >= maxConsecutiveAuthFailures) {
          current.terminate();
          finish({ reason: 'authentication_failed' });
          return;
        }
      } else {
        dependencies.log(`Control plane answered the link upgrade with HTTP ${status}.`);
      }
      current.terminate();
    });

    current.on('open', () => {
      current.send(JSON.stringify({
        type: 'hello',
        protocolVersion: RUNTIME_NODE_LINK_PROTOCOL_VERSION,
        runtimeVersion: dependencies.runtimeVersion,
        platform: dependencies.platform,
        arch: dependencies.arch,
        activeExecutions: dependencies.getActiveExecutions(),
      } satisfies RuntimeNodeLinkNodeFrame));
      heartbeatTimer = setInterval(() => {
        if (current.readyState === WebSocket.OPEN) {
          current.send(JSON.stringify({ type: 'heartbeat' }));
        }
      }, heartbeatMs);
      heartbeatTimer.unref?.();
    });

    current.on('message', (raw) => {
      let frame: Record<string, unknown> | null = null;
      try {
        const parsed = JSON.parse(raw.toString());
        frame = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
      } catch {
        frame = null;
      }
      if (!frame || typeof frame.type !== 'string') {
        return;
      }
      if (frame.type === 'welcome') {
        welcomed = true;
        consecutiveAuthFailures = 0;
        dependencies.log(`Connected to control plane as node ${dependencies.credential.nodeId}.`);
        healthyTimer = setTimeout(() => {
          attempt = 0;
        }, HEALTHY_CONNECTION_MS);
        healthyTimer.unref?.();
        dependencies.onWelcome(frame);
        return;
      }
      if (welcomed) {
        dependencies.onFrame(frame);
      }
    });

    current.on('error', (error) => {
      // Never log headers or keys; the error message itself carries neither.
      dependencies.log(`Link error: ${error.message}`);
    });

    current.on('close', (code) => {
      clearTimers();
      if (socket === current) {
        socket = null;
      }
      const wasWelcomed = welcomed;
      welcomed = false;
      if (wasWelcomed) {
        dependencies.onDisconnected();
      }
      if (stopped) {
        return;
      }
      if (code === CLOSE_REVOKED) {
        dependencies.log('This node was revoked by its control plane. Enroll it again to reconnect.');
        finish({ reason: 'revoked' });
        return;
      }
      if (code === CLOSE_IDENTITY_CONFLICT) {
        dependencies.log('Another process is using this node credential. Waiting before reconnecting.');
        scheduleReconnect(IDENTITY_CONFLICT_WAIT_MS);
        return;
      }
      scheduleReconnect();
    });
  };

  return {
    start(): Promise<NodeAgentLinkStop> {
      connect();
      return done;
    },

    send(frame: RuntimeNodeLinkNodeFrame): boolean {
      if (!socket || !welcomed || socket.readyState !== WebSocket.OPEN) {
        return false;
      }
      socket.send(JSON.stringify(frame));
      return true;
    },

    stop(): void {
      finish({ reason: 'stopped' });
      socket?.close(1000, 'agent stopping');
      socket = null;
    },
  };
}
