import { randomUUID } from 'node:crypto';
import os from 'node:os';

import { runtimeNodesDb, type RuntimeNodeRecord } from '@/modules/database/index.js';
import {
  RUNTIME_NODE_CAPABILITY_IDS,
  parseStoredRuntimeNodeCapabilities,
  resolveRuntimeNodeAvailability,
  toRuntimeNodeCapability,
} from '@/modules/runtime-nodes/runtime-node-availability.js';
import { probeLocalRuntimeCapabilities } from '@/modules/runtime-nodes/runtime-node-probes.js';
import type { RuntimeNodeCapabilityId, RuntimeNodeProbeOutcome, RuntimeNodeView } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/** A probe younger than this is reused instead of re-running the CLIs. */
const PROBE_REUSE_MS = 60_000;
/** Even an explicit refresh never re-probes more often than this. */
const MIN_REFRESH_INTERVAL_MS = 10_000;
const MAX_LABEL_LENGTH = 64;
const FALLBACK_LOCAL_LABEL = 'This machine';

type HostFacts = { hostname: string; platform: string; arch: string };

type RuntimeNodesServiceDependencies = {
  probeCapabilities?: () => Promise<Record<RuntimeNodeCapabilityId, RuntimeNodeProbeOutcome>>;
  now?: () => number;
  createNodeId?: () => string;
  readHostFacts?: () => HostFacts;
};

type RuntimeNodeListing = {
  localNodeId: string;
  nodes: RuntimeNodeView[];
};

type SessionRuntimeCheck = { ok: true } | { ok: false; code: 'RUNTIME_NODE_MISMATCH' };

function toNodeLabel(hostname: string): string {
  return hostname.trim().slice(0, MAX_LABEL_LENGTH) || FALLBACK_LOCAL_LABEL;
}

/**
 * `dependencies` are injectable so tests can pin probe results, time and host
 * facts over a temporary database. Routes and other modules use the default
 * instance below.
 */
export function createRuntimeNodesService(dependencies: RuntimeNodesServiceDependencies = {}) {
  const probeCapabilities = dependencies.probeCapabilities ?? (() => probeLocalRuntimeCapabilities());
  const now = dependencies.now ?? Date.now;
  const createNodeId = dependencies.createNodeId ?? randomUUID;
  const readHostFacts = dependencies.readHostFacts
    ?? ((): HostFacts => ({ hostname: os.hostname(), platform: process.platform, arch: process.arch }));
  let inFlightProbe: Promise<void> | null = null;

  const registerLocal = (runtimeVersion: string | null): RuntimeNodeRecord => {
    const facts = readHostFacts();
    return runtimeNodesDb.upsertLocal(createNodeId(), {
      label: toNodeLabel(facts.hostname),
      platform: facts.platform,
      arch: facts.arch,
      runtimeVersion,
    });
  };

  // Lazily registers when startup registration has not happened (tests, CLI
  // tools), so a new execution can always be bound to a real node id.
  const getLocalNode = (): RuntimeNodeRecord => runtimeNodesDb.getLocal() ?? registerLocal(null);

  const toView = (record: RuntimeNodeRecord, at: number): RuntimeNodeView => {
    const capabilities = parseStoredRuntimeNodeCapabilities(record.capabilitiesJson);
    return {
      nodeId: record.nodeId,
      label: record.label,
      isLocal: record.isLocal,
      // Only the local node can execute until remote transport exists (FT-M08).
      canExecute: record.isLocal,
      platform: record.platform,
      arch: record.arch,
      runtimeVersion: record.runtimeVersion,
      availability: resolveRuntimeNodeAvailability({ lastSeenAt: record.lastSeenAt, capabilities, now: at }),
      capabilities,
    };
  };

  // Single-flight: concurrent readers share one probe cycle instead of each
  // spawning CLIs.
  const probeLocalNode = (): Promise<void> => {
    if (inFlightProbe) {
      return inFlightProbe;
    }

    const nodeId = getLocalNode().nodeId;
    const run = async (): Promise<void> => {
      try {
        const outcomes = await probeCapabilities();
        const probedAt = now();
        const capabilities = RUNTIME_NODE_CAPABILITY_IDS.map((id) =>
          toRuntimeNodeCapability(id, outcomes[id] ?? { outcome: 'not_probed', reason: 'no_probe_available' }, probedAt),
        );
        runtimeNodesDb.recordProbe(nodeId, { lastSeenAt: probedAt, capabilitiesJson: JSON.stringify(capabilities) });
      } catch (error) {
        // A cycle that could not complete must not refresh lastSeen: the
        // previous evidence is left to age into `unavailable` on its own.
        console.warn('[RuntimeNodes] Local capability probe failed:', error instanceof Error ? error.message : String(error));
      }
    };

    const probe = run().finally(() => {
      if (inFlightProbe === probe) {
        inFlightProbe = null;
      }
    });
    inFlightProbe = probe;
    return probe;
  };

  return {
    /**
     * Registers this machine as the local node (or refreshes its descriptive
     * facts) without probing. Consumed by server/index.ts at startup.
     */
    registerLocalNode(runtimeVersion: string | null): RuntimeNodeView {
      return toView(registerLocal(runtimeVersion), now());
    },

    /** The stable id of this machine's node. */
    getLocalNodeId(): string {
      return getLocalNode().nodeId;
    },

    /**
     * Lists known nodes with availability derived at read time. The local node
     * is re-probed only when its evidence is older than the reuse window (or,
     * on an explicit refresh, older than the minimum refresh interval).
     * Consumed by the runtime-nodes routes.
     */
    async listNodes(options: { refresh?: boolean } = {}): Promise<RuntimeNodeListing> {
      const local = getLocalNode();
      const age = local.lastSeenAt === null ? Number.POSITIVE_INFINITY : now() - local.lastSeenAt;
      const shouldProbe = age >= PROBE_REUSE_MS
        || age < 0
        || (options.refresh === true && age >= MIN_REFRESH_INTERVAL_MS);
      if (shouldProbe) {
        await probeLocalNode();
      }

      const at = now();
      return {
        localNodeId: local.nodeId,
        nodes: runtimeNodesDb.list().map((record) => toView(record, at)),
      };
    },

    /**
     * Resolves which node a NEW Run/Leg is bound to. An explicit id must name a
     * node that can execute from this server. Without one, the target is only
     * implied when exactly one node exists at all, so a second node can never
     * be picked — or failed over to — silently. Consumed by the providers
     * module when creating app sessions and handoff targets.
     */
    resolveExecutionTarget(requestedNodeId?: string | null): string {
      const local = getLocalNode();

      if (typeof requestedNodeId === 'string' && requestedNodeId.trim()) {
        const node = runtimeNodesDb.getById(requestedNodeId.trim());
        if (!node) {
          throw new AppError('Runtime node not found.', {
            code: 'RUNTIME_NODE_NOT_FOUND',
            statusCode: 404,
          });
        }
        if (!node.isLocal) {
          throw new AppError(`"${node.label}" cannot run sessions from this server yet.`, {
            code: 'RUNTIME_NODE_NOT_EXECUTABLE',
            statusCode: 409,
          });
        }
        return node.nodeId;
      }

      if (runtimeNodesDb.count() === 1) {
        return local.nodeId;
      }

      throw new AppError('Choose which runtime node runs the new session.', {
        code: 'RUNTIME_NODE_REQUIRED',
        statusCode: 400,
      });
    },

    /**
     * A bound session only ever runs on its own node. NULL (never recorded)
     * keeps the pre-FT-M07 behavior of running locally. Consumed by the
     * websocket chat gateway before a run starts.
     */
    checkSessionRunsHere(sessionRuntimeNodeId: string | null | undefined): SessionRuntimeCheck {
      if (!sessionRuntimeNodeId) {
        return { ok: true };
      }
      return sessionRuntimeNodeId === getLocalNode().nodeId
        ? { ok: true }
        : { ok: false, code: 'RUNTIME_NODE_MISMATCH' };
    },
  };
}

// runtimeNodesService: used by server/index.ts (startup registration), the runtime-nodes routes,
// the providers module (binding new sessions/handoff targets) and the websocket chat gateway (run guard).
export const runtimeNodesService = createRuntimeNodesService();
