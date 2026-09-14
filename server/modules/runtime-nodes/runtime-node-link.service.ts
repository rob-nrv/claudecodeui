import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import { WebSocket } from 'ws';

import { normalizeRuntimeArch, normalizeRuntimePlatform } from '@/modules/runtime-nodes/runtime-node-availability.js';
import type { RuntimeNodeLinkServerFrame } from '@/shared/types.js';
import {
  AppError,
  parseRuntimeNodeLinkAuthorization,
  RUNTIME_NODE_LINK_MAX_CLOCK_SKEW_MS,
  RUNTIME_NODE_LINK_PATH,
  RUNTIME_NODE_LINK_PROTOCOL_VERSION,
  verifyRuntimeNodeLinkSignature,
} from '@/shared/utils.js';

/** Close codes a node agent can act on. */
export const RUNTIME_NODE_LINK_CLOSE = {
  unauthenticated: 4401,
  revoked: 4403,
  helloRequired: 4400,
  helloTimeout: 4408,
  superseded: 4409,
  identityConflict: 4429,
  frameTooLarge: 1009,
} as const;

const EXECUTION_ID_PATTERN = /^[0-9a-f-]{36}$/;
const MAX_ACTIVE_EXECUTIONS_IN_HELLO = 100;

type LinkCredential = { publicKey: string; status: 'active' | 'revoked' };

type LinkHello = {
  protocolVersion: number;
  runtimeVersion: string | null;
  platform: string | null;
  arch: string | null;
  activeExecutions: Array<{ executionId: string; lastSeq: number }>;
};

type LinkState = {
  nodeId: string;
  socket: WebSocket;
  connectedAt: number;
  lastFrameAt: number;
  helloReceived: boolean;
  protocolVersion: number | null;
  runtimeVersion: string | null;
  lastPersistedSeenAt: number;
  helloTimer: NodeJS.Timeout | null;
};

type PendingRequest = {
  nodeId: string;
  expectType: string;
  resolve(frame: Record<string, unknown>): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
};

export type RuntimeNodeLinkInfo = {
  connectedAt: number;
  lastFrameAt: number;
  protocolCompatible: boolean;
  runtimeVersion: string | null;
};

type RuntimeNodeLinkServiceDependencies = {
  getCredential(nodeId: string): LinkCredential | null;
  recordHello(nodeId: string, facts: { platform: string | null; arch: string | null; runtimeVersion: string | null }, at: number): void;
  recordSeen(nodeId: string, at: number): void;
  now?: () => number;
  helloTimeoutMs?: number;
  staleAfterMs?: number;
  maxFrameBytes?: number;
  conflictWindowMs?: number;
  maxSupersedesPerWindow?: number;
  conflictCooldownMs?: number;
  seenPersistIntervalMs?: number;
  /** FT-M09: how often silent links are swept; 0 disables the timer (tests call `sweepStaleLinks`). */
  sweepIntervalMs?: number;
};

function sanitizeFact(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const cleaned = value.replace(/[^A-Za-z0-9._+-]/g, '').slice(0, maxLength);
  return cleaned || null;
}

function parseHello(frame: Record<string, unknown>): LinkHello | null {
  if (frame.type !== 'hello' || typeof frame.protocolVersion !== 'number' || !Number.isInteger(frame.protocolVersion)) {
    return null;
  }
  const active = Array.isArray(frame.activeExecutions) ? frame.activeExecutions.slice(0, MAX_ACTIVE_EXECUTIONS_IN_HELLO) : [];
  const activeExecutions: LinkHello['activeExecutions'] = [];
  for (const entry of active) {
    const record = entry && typeof entry === 'object' ? entry as Record<string, unknown> : null;
    if (
      record
      && typeof record.executionId === 'string'
      && EXECUTION_ID_PATTERN.test(record.executionId)
      && typeof record.lastSeq === 'number'
      && Number.isInteger(record.lastSeq)
      && record.lastSeq >= 0
    ) {
      activeExecutions.push({ executionId: record.executionId, lastSeq: record.lastSeq });
    }
  }
  return {
    protocolVersion: frame.protocolVersion,
    runtimeVersion: sanitizeFact(frame.runtimeVersion, 32),
    platform: normalizeRuntimePlatform(frame.platform),
    arch: normalizeRuntimeArch(frame.arch),
    activeExecutions,
  };
}

/**
 * The control plane's side of RuntimeNode links (FT-M08): verifies signed
 * upgrades, keeps at most one live link per node, correlates request/response
 * frames and tells listeners when links open or close. It never executes
 * anything and never interprets run content; see the remote execution service.
 */
export function createRuntimeNodeLinkService(dependencies: RuntimeNodeLinkServiceDependencies) {
  const now = dependencies.now ?? Date.now;
  const helloTimeoutMs = dependencies.helloTimeoutMs ?? 5_000;
  const staleAfterMs = dependencies.staleAfterMs ?? 60_000;
  const maxFrameBytes = dependencies.maxFrameBytes ?? 8 * 1024 * 1024;
  const conflictWindowMs = dependencies.conflictWindowMs ?? 60_000;
  const maxSupersedesPerWindow = dependencies.maxSupersedesPerWindow ?? 3;
  const conflictCooldownMs = dependencies.conflictCooldownMs ?? 60_000;
  const seenPersistIntervalMs = dependencies.seenPersistIntervalMs ?? 60_000;
  const sweepIntervalMs = dependencies.sweepIntervalMs ?? 15_000;
  let sweepTimer: NodeJS.Timeout | null = null;

  const links = new Map<string, LinkState>();
  const verifiedRequests = new WeakMap<object, string>();
  /** Nonces of accepted signatures, kept past the clock window so a header can never be replayed. */
  const seenNonces = new Map<string, number>();
  const MAX_SEEN_NONCES = 10_000;
  const supersedesByNode = new Map<string, number[]>();
  const conflictUntilByNode = new Map<string, number>();
  const pending = new Map<string, PendingRequest>();

  const frameListeners = new Set<(nodeId: string, frame: Record<string, unknown>) => void>();
  const openListeners = new Set<(nodeId: string) => void>();
  const closeListeners = new Set<(nodeId: string, info: { staleForMs: number }) => void>();

  const notifyClosed = (nodeId: string, staleForMs: number) => {
    for (const listener of closeListeners) {
      listener(nodeId, { staleForMs: Math.max(0, staleForMs) });
    }
  };
  let resolveResume: (nodeId: string, active: LinkHello['activeExecutions']) => Array<{ executionId: string; accepted: boolean; lastSeq: number }>
    = (_nodeId, active) => active.map((entry) => ({ executionId: entry.executionId, accepted: false, lastSeq: 0 }));

  const pruneNonces = (at: number) => {
    for (const [key, expiresAt] of seenNonces) {
      if (expiresAt <= at) {
        seenNonces.delete(key);
      }
    }
  };

  const hasIdentityConflict = (nodeId: string): boolean => (conflictUntilByNode.get(nodeId) ?? 0) > now();

  const sendFrame = (link: LinkState, frame: RuntimeNodeLinkServerFrame): boolean => {
    if (link.socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    link.socket.send(JSON.stringify(frame));
    return true;
  };

  const isLive = (link: LinkState | undefined): link is LinkState =>
    Boolean(link && link.helloReceived && link.socket.readyState === WebSocket.OPEN);

  const service = {
    path: RUNTIME_NODE_LINK_PATH,

    /**
     * Upgrade check for the node link path. A browser (any Origin header) is
     * refused before any lookup; then header shape, clock window, nonce reuse,
     * credential status, identity-conflict cooldown and the Ed25519 signature
     * must all pass. Nonces are recorded only after a valid signature, so
     * unauthenticated traffic cannot fill the cache.
     */
    verifyUpgrade(request: IncomingMessage): boolean {
      if (request.headers.origin) {
        return false;
      }
      const requestPath = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (requestPath !== RUNTIME_NODE_LINK_PATH) {
        return false;
      }
      const parsed = parseRuntimeNodeLinkAuthorization(request.headers.authorization);
      if (!parsed) {
        return false;
      }
      const at = now();
      if (Math.abs(at - parsed.timestamp) > RUNTIME_NODE_LINK_MAX_CLOCK_SKEW_MS) {
        return false;
      }
      const nonceKey = `${parsed.nodeId}:${parsed.nonce}`;
      pruneNonces(at);
      if (seenNonces.has(nonceKey)) {
        return false;
      }
      const credential = dependencies.getCredential(parsed.nodeId);
      if (!credential || credential.status !== 'active' || hasIdentityConflict(parsed.nodeId)) {
        return false;
      }
      if (!verifyRuntimeNodeLinkSignature(parsed, credential.publicKey, requestPath)) {
        return false;
      }
      if (seenNonces.size >= MAX_SEEN_NONCES) {
        // Fail closed rather than forget nonces that could still be replayed.
        return false;
      }
      seenNonces.set(nonceKey, at + 2 * RUNTIME_NODE_LINK_MAX_CLOCK_SKEW_MS);
      verifiedRequests.set(request, parsed.nodeId);
      return true;
    },

    /** Takes ownership of a socket whose upgrade `verifyUpgrade` accepted. */
    handleConnection(socket: WebSocket, request: IncomingMessage): void {
      const nodeId = verifiedRequests.get(request);
      verifiedRequests.delete(request);
      if (!nodeId) {
        socket.close(RUNTIME_NODE_LINK_CLOSE.unauthenticated, 'unauthenticated');
        return;
      }

      const at = now();
      if (!sweepTimer && sweepIntervalMs > 0) {
        sweepTimer = setInterval(() => service.sweepStaleLinks(), sweepIntervalMs);
        sweepTimer.unref?.();
      }
      const previous = links.get(nodeId);
      if (previous) {
        // Newest authenticated connection wins (reconnect after a half-open
        // drop), but a credential that keeps connecting from several places
        // is an identity conflict and gets no link at all for a while.
        const recent = (supersedesByNode.get(nodeId) ?? []).filter((timestamp) => at - timestamp < conflictWindowMs);
        recent.push(at);
        supersedesByNode.set(nodeId, recent);
        links.delete(nodeId);
        previous.socket.close(RUNTIME_NODE_LINK_CLOSE.superseded, 'superseded');
        // HC-06 repair: a half-open link (its process vanished — e.g. an
        // Android radio going down — without ever sending a close frame)
        // never reaches the natural `socket.on('close', ...)` notification
        // below, because by the time that old socket's close eventually
        // fires, this map entry already points at the new link and the
        // guard there drops it. Without this, a reconnect after ANY outage,
        // however long, was silently treated as if nothing had happened:
        // the remote-execution service never got to judge whether the gap
        // was still within its bounded grace. Notifying here, with how long
        // the old link was actually silent, restores that judgment for the
        // common "reconnect via a fresh connection" path, not just a clean
        // close followed later by a reconnect.
        if (previous.helloReceived) {
          notifyClosed(nodeId, now() - previous.lastFrameAt);
        }
        if (recent.length > maxSupersedesPerWindow) {
          conflictUntilByNode.set(nodeId, at + conflictCooldownMs);
          console.warn(`[RuntimeNodes] Identity conflict for node ${nodeId}; refusing links for ${Math.round(conflictCooldownMs / 1000)}s.`);
          socket.close(RUNTIME_NODE_LINK_CLOSE.identityConflict, 'identity conflict');
          return;
        }
      }

      const link: LinkState = {
        nodeId,
        socket,
        connectedAt: at,
        lastFrameAt: at,
        helloReceived: false,
        protocolVersion: null,
        runtimeVersion: null,
        lastPersistedSeenAt: 0,
        helloTimer: null,
      };
      links.set(nodeId, link);
      link.helloTimer = setTimeout(() => {
        if (!link.helloReceived) {
          socket.close(RUNTIME_NODE_LINK_CLOSE.helloTimeout, 'hello required');
        }
      }, helloTimeoutMs);
      link.helloTimer.unref?.();

      socket.on('message', (raw: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
        const size = Array.isArray(raw) ? raw.reduce((total, part) => total + part.length, 0) : (raw as Buffer).byteLength;
        if (isBinary || size > maxFrameBytes) {
          socket.close(RUNTIME_NODE_LINK_CLOSE.frameTooLarge, 'frame rejected');
          return;
        }
        let frame: Record<string, unknown> | null = null;
        try {
          const parsed = JSON.parse(Array.isArray(raw) ? Buffer.concat(raw).toString('utf8') : raw.toString());
          frame = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
        } catch {
          frame = null;
        }
        if (!frame || typeof frame.type !== 'string' || links.get(nodeId) !== link) {
          return;
        }

        const frameAt = now();
        link.lastFrameAt = frameAt;
        if (frameAt - link.lastPersistedSeenAt >= seenPersistIntervalMs) {
          link.lastPersistedSeenAt = frameAt;
          dependencies.recordSeen(nodeId, frameAt);
        }

        if (!link.helloReceived) {
          const hello = parseHello(frame);
          if (!hello) {
            socket.close(RUNTIME_NODE_LINK_CLOSE.helloRequired, 'hello required');
            return;
          }
          link.helloReceived = true;
          if (link.helloTimer) {
            clearTimeout(link.helloTimer);
            link.helloTimer = null;
          }
          link.protocolVersion = hello.protocolVersion;
          link.runtimeVersion = hello.runtimeVersion;
          link.lastPersistedSeenAt = frameAt;
          dependencies.recordHello(nodeId, { platform: hello.platform, arch: hello.arch, runtimeVersion: hello.runtimeVersion }, frameAt);
          sendFrame(link, {
            type: 'welcome',
            nodeId,
            protocolVersion: RUNTIME_NODE_LINK_PROTOCOL_VERSION,
            serverTime: frameAt,
            resume: hello.protocolVersion === RUNTIME_NODE_LINK_PROTOCOL_VERSION ? resolveResume(nodeId, hello.activeExecutions) : [],
          });
          for (const listener of openListeners) {
            listener(nodeId);
          }
          return;
        }

        if (frame.type === 'heartbeat' || frame.type === 'hello') {
          return;
        }

        // Answers are accepted only for requests this server sent to THIS node
        // and only with the expected frame type; anything else is dropped.
        if (typeof frame.requestId === 'string') {
          const waiting = pending.get(frame.requestId);
          if (waiting && waiting.nodeId === nodeId && waiting.expectType === frame.type) {
            pending.delete(frame.requestId);
            clearTimeout(waiting.timer);
            waiting.resolve(frame);
          }
          return;
        }

        for (const listener of frameListeners) {
          listener(nodeId, frame);
        }
      });

      socket.on('close', () => {
        if (link.helloTimer) {
          clearTimeout(link.helloTimer);
        }
        if (links.get(nodeId) !== link) {
          return;
        }
        links.delete(nodeId);
        for (const [requestId, waiting] of pending) {
          if (waiting.nodeId === nodeId) {
            pending.delete(requestId);
            clearTimeout(waiting.timer);
            waiting.reject(new AppError('The runtime node disconnected.', { code: 'RUNTIME_NODE_OFFLINE', statusCode: 409 }));
          }
        }
        if (link.helloReceived) {
          notifyClosed(nodeId, now() - link.lastFrameAt);
        }
      });
    },

    /** A live link with a completed hello; staleness is judged separately by availability. */
    getLinkInfo(nodeId: string): RuntimeNodeLinkInfo | null {
      const link = links.get(nodeId);
      if (!isLive(link)) {
        return null;
      }
      return {
        connectedAt: link.connectedAt,
        lastFrameAt: link.lastFrameAt,
        protocolCompatible: link.protocolVersion === RUNTIME_NODE_LINK_PROTOCOL_VERSION,
        runtimeVersion: link.runtimeVersion,
      };
    },

    /** Usable for execution: live, compatible, recently heard from, and not in identity conflict. */
    isUsable(nodeId: string): boolean {
      const link = links.get(nodeId);
      return isLive(link)
        && link.protocolVersion === RUNTIME_NODE_LINK_PROTOCOL_VERSION
        && now() - link.lastFrameAt <= staleAfterMs
        && !hasIdentityConflict(nodeId);
    },

    hasIdentityConflict,

    /**
     * Terminates links that have been silent past the stale window (FT-M09).
     * A half-open socket (a phone that lost its network) never emits `close`
     * on its own; without this its runs would read "running" indefinitely.
     * Terminating triggers the normal close path: runs get their bounded
     * reconnect grace, then fail explicitly. Returns the node ids swept.
     */
    sweepStaleLinks(): string[] {
      const at = now();
      const swept: string[] = [];
      for (const link of links.values()) {
        if (at - link.lastFrameAt > staleAfterMs && link.socket.readyState === WebSocket.OPEN) {
          swept.push(link.nodeId);
          link.socket.terminate();
        }
      }
      return swept;
    },

    send(nodeId: string, frame: RuntimeNodeLinkServerFrame): boolean {
      const link = links.get(nodeId);
      return isLive(link) ? sendFrame(link, frame) : false;
    },

    /**
     * Sends a request frame with a fresh `requestId` and resolves with the
     * node's answer of `expectType`, or rejects on timeout or disconnect.
     */
    request(
      nodeId: string,
      frame: { type: 'probe.request' | 'workspace.verify' | 'workspace.inspect' | 'approval.resolve' | 'history.fetch' } & Record<string, unknown>,
      expectType: string,
      timeoutMs: number,
    ): Promise<Record<string, unknown>> {
      const link = links.get(nodeId);
      if (!isLive(link) || !service.isUsable(nodeId)) {
        return Promise.reject(new AppError('The runtime node is offline.', { code: 'RUNTIME_NODE_OFFLINE', statusCode: 409 }));
      }
      const requestId = randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new AppError('The runtime node did not answer in time.', { code: 'RUNTIME_NODE_TIMEOUT', statusCode: 504 }));
        }, timeoutMs);
        timer.unref?.();
        pending.set(requestId, { nodeId, expectType, resolve, reject, timer });
        if (!sendFrame(link, { ...frame, requestId } as RuntimeNodeLinkServerFrame)) {
          pending.delete(requestId);
          clearTimeout(timer);
          reject(new AppError('The runtime node is offline.', { code: 'RUNTIME_NODE_OFFLINE', statusCode: 409 }));
        }
      });
    },

    onNodeFrame(listener: (nodeId: string, frame: Record<string, unknown>) => void): void {
      frameListeners.add(listener);
    },

    onLinkOpened(listener: (nodeId: string) => void): void {
      openListeners.add(listener);
    },

    /**
     * `staleForMs` is how long this link had already been silent (measured
     * from its last received frame or heartbeat) by the time the loss was
     * noticed — 0 for a clean, immediate close; potentially large when a
     * half-open link was only discovered because a new connection replaced
     * it. Callers use it to judge whether a run can still trust a resume.
     */
    onLinkClosed(listener: (nodeId: string, info: { staleForMs: number }) => void): void {
      closeListeners.add(listener);
    },

    /** Installed by the remote execution service: which runs a reconnecting node may keep streaming. */
    setResumeResolver(resolver: typeof resolveResume): void {
      resolveResume = resolver;
    },

    /** Closes a node's link (revocation). */
    disconnect(nodeId: string, code: number, reason: string): void {
      links.get(nodeId)?.socket.close(code, reason);
    },

    listConnectedNodeIds(): string[] {
      return [...links.values()].filter((link) => isLive(link)).map((link) => link.nodeId);
    },
  };

  return service;
}

export type RuntimeNodeLinkService = ReturnType<typeof createRuntimeNodeLinkService>;
