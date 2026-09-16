import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';

import {
  projectsDb,
  runtimeNodeCredentialsDb,
  runtimeNodeEnrollmentsDb,
  runtimeNodesDb,
  runtimeNodeWorkspacesDb,
  type RuntimeNodeCredentialRecord,
  type RuntimeNodeRecord,
} from '@/modules/database/index.js';
import {
  createNotificationEvent,
  notifyRunFailed,
  notifyRunStopped,
  notifyUserIfEnabled,
} from '@/modules/notifications/index.js';
import {
  classifyWorkspaceState,
  inspectWorkspaceFolder,
  parseWorkspaceObservation,
  type WorkspaceObservation,
} from '@/modules/project-workspaces/index.js';
import {
  RUNTIME_NODE_CAPABILITY_IDS,
  normalizeRuntimeArch,
  normalizeRuntimePlatform,
  parseRemoteProbeOutcomes,
  parseRemoteResourceReport,
  parseStoredRuntimeNodeCapabilities,
  resolveRemoteRuntimeNodeAvailability,
  resolveRuntimeNodeAvailability,
  toRuntimeNodeCapability,
  toRuntimeNodeCapabilityViews,
} from '@/modules/runtime-nodes/runtime-node-availability.js';
import { createRuntimeNodeEnrollmentService } from '@/modules/runtime-nodes/runtime-node-enrollment.service.js';
import {
  createRuntimeNodeLinkService,
  RUNTIME_NODE_LINK_CLOSE,
  type RuntimeNodeLinkService,
} from '@/modules/runtime-nodes/runtime-node-link.service.js';
import { probeLocalRuntimeCapabilities } from '@/modules/runtime-nodes/runtime-node-probes.js';
import {
  createRuntimeNodeRemoteExecutionService,
  type RuntimeNodeRemoteExecutionService,
} from '@/modules/runtime-nodes/runtime-node-remote-execution.service.js';
import { planCapabilityCheck } from '@/modules/runtime-nodes/runtime-node-verification.js';
import type {
  FetchHistoryResult,
  ProjectRepositoryRow,
  ProjectWorkspaceStateView,
  RuntimeNodeCapabilityId,
  RuntimeNodeProbeOutcome,
  RuntimeNodeResourcesView,
  RuntimeNodeView,
  RuntimeNodeWorkspaceView,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/** A probe younger than this is reused instead of re-running the CLIs. */
const PROBE_REUSE_MS = 60_000;
/** Even an explicit refresh never re-probes more often than this. */
const MIN_REFRESH_INTERVAL_MS = 10_000;
const MAX_LABEL_LENGTH = 64;
const MAX_WORKSPACE_PATH_LENGTH = 1024;
const FALLBACK_LOCAL_LABEL = 'This machine';

type HostFacts = { hostname: string; platform: string; arch: string };

type NotificationPort = Parameters<typeof createRuntimeNodeRemoteExecutionService>[0]['notifications'];

type RuntimeNodesServiceDependencies = {
  probeCapabilities?: () => Promise<Record<RuntimeNodeCapabilityId, RuntimeNodeProbeOutcome>>;
  now?: () => number;
  createNodeId?: () => string;
  readHostFacts?: () => HostFacts;
  link?: RuntimeNodeLinkService;
  remoteExecution?: RuntimeNodeRemoteExecutionService;
  notifications?: NotificationPort;
  /** Whether the local project folder exists; injectable so tests never depend on real paths. */
  isDirectory?: (directory: string) => Promise<boolean>;
  /** Read-only inspection of this machine's own copy of a project (FT-M09); injectable for tests. */
  inspectLocalWorkspace?: (folder: string) => Promise<WorkspaceObservation>;
};

type RuntimeNodeListing = {
  localNodeId: string;
  nodes: RuntimeNodeView[];
};

type SessionRuntimeCheck = { ok: true } | { ok: false; code: 'RUNTIME_NODE_MISMATCH' };

type SessionBinding = {
  session_id: string;
  provider: string;
  runtime_node_id: string | null;
  claude_profile_id: string | null;
  /** The session's project (FT-M10); its mapping on the bound node is looked up by this id, never by a path. */
  project_id: string | null;
  provider_session_id: string | null;
};

/** Where one existing session's next run executes, or why it cannot run anywhere. */
export type SessionExecutionTarget =
  | { kind: 'local' }
  | { kind: 'remote'; nodeId: string; nodeLabel: string; cwd: string; projectId: string }
  | { kind: 'refused'; code: string; message: string; alternatives: Array<{ nodeId: string; label: string }> };

function toNodeLabel(hostname: string): string {
  return hostname.trim().slice(0, MAX_LABEL_LENGTH) || FALLBACK_LOCAL_LABEL;
}

async function isExistingDirectory(directory: string): Promise<boolean> {
  try {
    return (await fs.stat(directory)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * `dependencies` are injectable so tests can pin probe results, time, host
 * facts and the node link over a temporary database. Routes and other modules
 * use the default instance below.
 *
 * Project identity (FT-M09): a project is its `project_id`. The control plane's
 * `projects.project_path` is only THIS machine's working copy (the local
 * node's workspace); every remote node maps the same project id to its own
 * local folder, verified by that node.
 */
export function createRuntimeNodesService(dependencies: RuntimeNodesServiceDependencies = {}) {
  const probeCapabilities = dependencies.probeCapabilities ?? (() => probeLocalRuntimeCapabilities());
  const now = dependencies.now ?? Date.now;
  const createNodeId = dependencies.createNodeId ?? randomUUID;
  const readHostFacts = dependencies.readHostFacts
    ?? ((): HostFacts => ({ hostname: os.hostname(), platform: process.platform, arch: process.arch }));
  const isDirectory = dependencies.isDirectory ?? isExistingDirectory;
  const inspectLocalWorkspace = dependencies.inspectLocalWorkspace ?? ((folder: string) => inspectWorkspaceFolder(folder));
  let inFlightProbe: Promise<void> | null = null;
  const inFlightRemoteProbes = new Map<string, Promise<void>>();
  /** Resource Governor reports, valid only for the link that produced them. */
  const resourcesByNode = new Map<string, RuntimeNodeResourcesView>();
  /** One workspace inspection per node and project at a time: repeated requests share it instead of spawning more Git. */
  const inFlightInspections = new Map<string, Promise<ProjectWorkspaceStateView>>();

  const link = dependencies.link ?? createRuntimeNodeLinkService({
    getCredential: (nodeId) => runtimeNodeCredentialsDb.getByNodeId(nodeId),
    recordHello: (nodeId, facts, at) => {
      runtimeNodesDb.updateRemoteFacts(nodeId, facts);
      runtimeNodesDb.recordSeen(nodeId, at);
    },
    recordSeen: (nodeId, at) => runtimeNodesDb.recordSeen(nodeId, at),
    now,
  });
  const remoteExecution = dependencies.remoteExecution ?? createRuntimeNodeRemoteExecutionService({
    link,
    notifications: dependencies.notifications,
    onWorkspaceRejected: (nodeId, projectId) =>
      runtimeNodeWorkspacesDb.markUnavailable(nodeId, projectId, 'rejected_by_node', now()),
  });
  const enrollment = createRuntimeNodeEnrollmentService({ store: runtimeNodeEnrollmentsDb, now });

  const registerLocal = (runtimeVersion: string | null): RuntimeNodeRecord => {
    const facts = readHostFacts();
    return runtimeNodesDb.upsertLocal(createNodeId(), {
      label: toNodeLabel(facts.hostname),
      platform: normalizeRuntimePlatform(facts.platform),
      arch: normalizeRuntimeArch(facts.arch),
      runtimeVersion,
    });
  };

  // Lazily registers when startup registration has not happened (tests, CLI
  // tools), so a new execution can always be bound to a real node id.
  const getLocalNode = (): RuntimeNodeRecord => runtimeNodesDb.getLocal() ?? registerLocal(null);

  const toView = (record: RuntimeNodeRecord, at: number, credential: RuntimeNodeCredentialRecord | null): RuntimeNodeView => {
    const capabilities = parseStoredRuntimeNodeCapabilities(record.capabilitiesJson);
    if (record.isLocal) {
      return {
        nodeId: record.nodeId,
        label: record.label,
        isLocal: true,
        canExecute: true,
        platform: record.platform,
        arch: record.arch,
        runtimeVersion: record.runtimeVersion,
        availability: resolveRuntimeNodeAvailability({ lastSeenAt: record.lastSeenAt, capabilities, now: at }),
        capabilities: toRuntimeNodeCapabilityViews(capabilities, { kind: 'local', now: at }),
        resources: null,
        evidence: 'local_probe',
        enrollment: 'local',
      };
    }

    const enrollmentState = credential ? credential.status : 'unenrolled';
    const linkInfo = credential?.status === 'active' ? link.getLinkInfo(record.nodeId) : null;
    const availability = resolveRemoteRuntimeNodeAvailability({
      enrollment: enrollmentState,
      link: linkInfo,
      identityConflict: credential?.status === 'active' && link.hasIdentityConflict(record.nodeId),
      lastSeenAt: record.lastSeenAt,
      capabilities,
      now: at,
    });
    const resources = linkInfo ? resourcesByNode.get(record.nodeId) ?? null : null;
    return {
      nodeId: record.nodeId,
      label: record.label,
      isLocal: false,
      canExecute: availability.state === 'available' && link.isUsable(record.nodeId),
      platform: record.platform,
      arch: record.arch,
      runtimeVersion: linkInfo?.runtimeVersion ?? record.runtimeVersion,
      availability,
      capabilities: toRuntimeNodeCapabilityViews(capabilities, { kind: 'remote', connectedAt: linkInfo?.connectedAt ?? null }),
      resources: resources && linkInfo && Date.parse(resources.observedAt) >= linkInfo.connectedAt ? resources : null,
      evidence: 'node_probe',
      enrollment: enrollmentState,
    };
  };

  const credentialsByNode = (): Map<string, RuntimeNodeCredentialRecord> =>
    new Map(runtimeNodeCredentialsDb.listAll().map((credential) => [credential.nodeId, credential]));

  const viewOf = (nodeId: string): RuntimeNodeView | null => {
    const record = runtimeNodesDb.getById(nodeId);
    return record ? toView(record, now(), runtimeNodeCredentialsDb.getByNodeId(nodeId)) : null;
  };

  const listAlternatives = (excludeNodeId: string | null): Array<{ nodeId: string; label: string }> => {
    const at = now();
    const credentials = credentialsByNode();
    return runtimeNodesDb
      .list()
      .map((record) => toView(record, at, credentials.get(record.nodeId) ?? null))
      .filter((view) => view.canExecute && view.nodeId !== excludeNodeId)
      .map((view) => ({ nodeId: view.nodeId, label: view.label }));
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

  /**
   * Asks a connected remote node to probe itself. Only the answer to this
   * server's own request is recorded, and it is sanitized to known ids.
   */
  const probeRemoteNode = (nodeId: string): Promise<void> => {
    const existing = inFlightRemoteProbes.get(nodeId);
    if (existing) {
      return existing;
    }
    const probe = (async () => {
      try {
        const answer = await remoteExecution.probe(nodeId);
        const outcomes = parseRemoteProbeOutcomes(answer.outcomes);
        const probedAt = now();
        const capabilities = RUNTIME_NODE_CAPABILITY_IDS.map((id) => toRuntimeNodeCapability(id, outcomes[id], probedAt));
        runtimeNodesDb.recordProbe(nodeId, { lastSeenAt: probedAt, capabilitiesJson: JSON.stringify(capabilities) });
        const resources = parseRemoteResourceReport(answer.resources);
        if (resources) {
          resourcesByNode.set(nodeId, { ...resources, observedAt: new Date(probedAt).toISOString() });
        } else {
          resourcesByNode.delete(nodeId);
        }
      } catch (error) {
        console.warn(`[RuntimeNodes] Remote capability probe of ${nodeId} failed:`, error instanceof AppError ? error.code : 'error');
      }
    })().finally(() => inFlightRemoteProbes.delete(nodeId));
    inFlightRemoteProbes.set(nodeId, probe);
    return probe;
  };

  // A freshly authenticated node proves nothing until it answers a probe on this connection.
  link.onLinkOpened((nodeId) => {
    void probeRemoteNode(nodeId);
  });
  link.onLinkClosed((nodeId) => {
    resourcesByNode.delete(nodeId);
  });

  const describeWorkspace = async (view: RuntimeNodeView, project: ProjectRepositoryRow): Promise<RuntimeNodeWorkspaceView> => {
    if (view.isLocal) {
      if (project.project_path === null) {
        return { state: 'unavailable', reason: 'no_control_plane_copy', verifiedAt: null };
      }
      return (await isDirectory(project.project_path))
        ? { state: 'available', reason: null, verifiedAt: null }
        : { state: 'unavailable', reason: 'project_folder_missing', verifiedAt: null };
    }
    const mapping = runtimeNodeWorkspacesDb.get(view.nodeId, project.project_id);
    if (!mapping) {
      return { state: 'unmapped', reason: null, verifiedAt: null };
    }
    return {
      state: mapping.status === 'verified' ? 'mapped' : 'unavailable',
      reason: mapping.reason,
      verifiedAt: new Date(mapping.verifiedAt).toISOString(),
    };
  };

  const refused = (code: string, message: string, excludeNodeId: string | null): SessionExecutionTarget => ({
    kind: 'refused',
    code,
    message,
    alternatives: listAlternatives(excludeNodeId),
  });

  const requireRemoteNode = (nodeId: string): { record: RuntimeNodeRecord; credential: RuntimeNodeCredentialRecord } => {
    const record = runtimeNodesDb.getById(nodeId);
    if (!record) {
      throw new AppError('Runtime node not found.', { code: 'RUNTIME_NODE_NOT_FOUND', statusCode: 404 });
    }
    const credential = runtimeNodeCredentialsDb.getByNodeId(nodeId);
    if (record.isLocal || !credential) {
      throw new AppError(`"${record.label}" is not an enrolled remote runtime node.`, {
        code: 'RUNTIME_NODE_NOT_REMOTE',
        statusCode: 409,
      });
    }
    return { record, credential };
  };

  const requireProject = (projectId: string): ProjectRepositoryRow => {
    const project = projectsDb.getProjectById(projectId);
    if (!project) {
      throw new AppError('Project not found.', { code: 'PROJECT_NOT_FOUND', statusCode: 404 });
    }
    return project;
  };

  /**
   * The project owning this machine's copy at a path, for a NEW run whose
   * caller only knows the folder it chose here; null when it is not a
   * registered project. Existing sessions carry their project id instead.
   */
  const projectIdForPath = (projectPath: string | null | undefined): string | null => {
    const trimmed = projectPath?.trim() ?? '';
    return trimmed ? projectsDb.getProjectPath(trimmed)?.project_id ?? null : null;
  };

  const workspaceState = (
    state: ProjectWorkspaceStateView['state'],
    reason: string | null,
    inspectedAt: number | null = null,
  ): ProjectWorkspaceStateView => ({
    state,
    reason,
    identity: 'unknown',
    inspectedAt: inspectedAt === null ? null : new Date(inspectedAt).toISOString(),
    git: null,
    changes: null,
    sync: null,
  });

  const toWorkspaceStateView = (observation: WorkspaceObservation, expectedRootCommits: string[] | null, at: number): ProjectWorkspaceStateView => {
    const classified = classifyWorkspaceState({ observation, expectedRootCommits });
    const git = observation.git;
    return {
      state: classified.state,
      reason: classified.reason,
      identity: classified.identity,
      inspectedAt: new Date(at).toISOString(),
      git: git.state === 'repository'
        ? { rootIsFolder: git.rootIsFolder, branch: git.branch, detached: git.detached, headCommit: git.headCommit, upstream: git.upstream }
        : null,
      changes: observation.changes,
      sync: observation.sync,
    };
  };

  const inspectProjectWorkspaceOnce = async (nodeId: string, projectId: string): Promise<ProjectWorkspaceStateView> => {
    const project = requireProject(projectId);
    const record = runtimeNodesDb.getById(nodeId);
    if (!record) {
      throw new AppError('Runtime node not found.', { code: 'RUNTIME_NODE_NOT_FOUND', statusCode: 404 });
    }
    if (record.isLocal) {
      if (project.project_path === null) {
        return workspaceState('unmapped', 'no_control_plane_copy');
      }
      let observation: WorkspaceObservation;
      try {
        observation = await inspectLocalWorkspace(project.project_path);
      } catch {
        return workspaceState('unknown', 'inspection_failed', now());
      }
      return toWorkspaceStateView(observation, null, now());
    }

    const { credential } = requireRemoteNode(nodeId);
    if (credential.status !== 'active') {
      return workspaceState('unavailable', 'node_revoked');
    }
    const mapping = runtimeNodeWorkspacesDb.get(nodeId, project.project_id);
    if (!mapping) {
      return workspaceState('unmapped', null);
    }
    if (!link.isUsable(nodeId)) {
      return workspaceState('unavailable', 'node_offline');
    }
    let answer: Awaited<ReturnType<RuntimeNodeRemoteExecutionService['inspectWorkspace']>>;
    try {
      answer = await remoteExecution.inspectWorkspace(nodeId, mapping.nodePath);
    } catch (error) {
      return workspaceState('unavailable', error instanceof AppError && error.code === 'RUNTIME_NODE_TIMEOUT' ? 'node_timeout' : 'node_offline');
    }
    const at = now();
    if (!answer.ok) {
      return workspaceState(answer.reason === 'folder_not_found' ? 'missing' : 'unavailable', answer.reason, at);
    }
    const observation = parseWorkspaceObservation(answer.observation);
    if (!observation) {
      return workspaceState('unknown', 'malformed_node_answer', at);
    }
    return toWorkspaceStateView(observation, mapping.gitRootCommits, at);
  };

  return {
    /**
     * Registers this machine as the local node (or refreshes its descriptive
     * facts) without probing. Consumed by server/index.ts at startup.
     */
    registerLocalNode(runtimeVersion: string | null): RuntimeNodeView {
      return toView(registerLocal(runtimeVersion), now(), null);
    },

    /** The stable id of this machine's node. */
    getLocalNodeId(): string {
      return getLocalNode().nodeId;
    },

    /**
     * Lists known nodes with availability derived at read time. The local node
     * is re-probed only when its evidence is older than the reuse window (or,
     * on an explicit refresh, older than the minimum refresh interval);
     * connected remote nodes are asked to probe themselves under the same
     * rules. With `projectId`, each node also says whether that project's
     * workspace is usable there. Consumed by the runtime-nodes routes.
     */
    async listNodes(options: { refresh?: boolean; projectId?: string } = {}): Promise<RuntimeNodeListing> {
      const project = options.projectId ? requireProject(options.projectId) : null;
      const local = getLocalNode();
      const shouldProbe = (lastSeenAt: number | null, connectedAt = 0): boolean => {
        const age = lastSeenAt === null ? Number.POSITIVE_INFINITY : now() - lastSeenAt;
        return age >= PROBE_REUSE_MS
          || age < 0
          || (lastSeenAt !== null && lastSeenAt < connectedAt)
          || (options.refresh === true && age >= MIN_REFRESH_INTERVAL_MS);
      };

      const probes: Promise<void>[] = [];
      if (shouldProbe(local.lastSeenAt)) {
        probes.push(probeLocalNode());
      }
      for (const record of runtimeNodesDb.list()) {
        const info = record.isLocal ? null : link.getLinkInfo(record.nodeId);
        const capabilities = parseStoredRuntimeNodeCapabilities(record.capabilitiesJson);
        const lastProbeAt = capabilities.reduce<number | null>(
          (latest, capability) => (capability.probedAt !== null && (latest === null || capability.probedAt > latest) ? capability.probedAt : latest),
          null,
        );
        if (info && link.isUsable(record.nodeId) && shouldProbe(lastProbeAt, info.connectedAt)) {
          probes.push(probeRemoteNode(record.nodeId));
        }
      }
      await Promise.allSettled(probes);

      const at = now();
      const credentials = credentialsByNode();
      const nodes = runtimeNodesDb.list().map((record) => toView(record, at, credentials.get(record.nodeId) ?? null));
      if (project) {
        for (const node of nodes) {
          node.workspace = await describeWorkspace(node, project);
        }
      }
      return { localNodeId: local.nodeId, nodes };
    },

    /**
     * Resolves which node a NEW Run/Leg is bound to. An explicit id must name a
     * node that can execute right now. Without one, the target is only implied
     * while exactly one non-revoked node exists, so a second node can never be
     * picked — or failed over to — silently. Consumed by the providers module
     * when creating app sessions and handoff targets.
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
        if (node.isLocal) {
          return node.nodeId;
        }
        const credential = runtimeNodeCredentialsDb.getByNodeId(node.nodeId);
        if (!credential) {
          throw new AppError(`"${node.label}" cannot run sessions from this server yet.`, {
            code: 'RUNTIME_NODE_NOT_EXECUTABLE',
            statusCode: 409,
          });
        }
        if (credential.status === 'revoked') {
          throw new AppError(`"${node.label}" was revoked and can no longer run sessions.`, {
            code: 'RUNTIME_NODE_REVOKED',
            statusCode: 409,
          });
        }
        const view = toView(node, now(), credential);
        if (!view.canExecute) {
          throw new AppError(`"${node.label}" is not available to run a new session right now.`, {
            code: 'RUNTIME_NODE_UNAVAILABLE',
            statusCode: 409,
            details: { availability: view.availability.reason, alternatives: listAlternatives(node.nodeId) },
          });
        }
        return node.nodeId;
      }

      if (runtimeNodesDb.countNotRevoked() === 1) {
        return local.nodeId;
      }

      throw new AppError('Choose which runtime node runs the new session.', {
        code: 'RUNTIME_NODE_REQUIRED',
        statusCode: 400,
      });
    },

    /**
     * Refuses a new run on a remote node that cannot honestly run it: only
     * Claude is probed there, CloudCLI accounts (credentials) stay on the
     * machine that owns them, and the project needs a folder that node itself
     * verified. A no-op for the local node. Consumed by the providers module
     * right after `resolveExecutionTarget`.
     */
    assertNodeCanRun(
      nodeId: string,
      run: { provider: string; claudeProfileId: string | null; projectId?: string | null; projectPath?: string },
    ): void {
      const node = runtimeNodesDb.getById(nodeId);
      if (!node || node.isLocal) {
        return;
      }
      if (run.provider !== 'claude') {
        throw new AppError(`"${node.label}" only runs Claude sessions.`, {
          code: 'RUNTIME_NODE_PROVIDER_UNSUPPORTED',
          statusCode: 409,
        });
      }
      if (run.claudeProfileId) {
        throw new AppError(`"${node.label}" runs with its own Claude login; CloudCLI accounts are never copied to other machines.`, {
          code: 'RUNTIME_NODE_PROFILE_UNAVAILABLE',
          statusCode: 409,
        });
      }
      const projectId = run.projectId ?? projectIdForPath(run.projectPath);
      const mapping = projectId ? runtimeNodeWorkspacesDb.get(nodeId, projectId) : null;
      if (!mapping || mapping.status !== 'verified') {
        throw new AppError(`This project has no verified folder on "${node.label}".`, {
          code: 'RUNTIME_NODE_WORKSPACE_UNAVAILABLE',
          statusCode: 409,
        });
      }
    },

    /**
     * A bound session only ever runs on its own node. NULL (never recorded)
     * keeps the pre-FT-M07 behavior of running locally.
     */
    checkSessionRunsHere(sessionRuntimeNodeId: string | null | undefined): SessionRuntimeCheck {
      if (!sessionRuntimeNodeId) {
        return { ok: true };
      }
      return sessionRuntimeNodeId === getLocalNode().nodeId
        ? { ok: true }
        : { ok: false, code: 'RUNTIME_NODE_MISMATCH' };
    },

    /**
     * Where the next run of an EXISTING session executes (FT-M08). The binding
     * is read from the session row and never changes; an unusable bound node
     * produces a refusal listing alternatives the user may choose explicitly
     * (by a handoff) — nothing is ever substituted. Consumed by the websocket
     * chat gateway before a run starts.
     */
    resolveSessionExecution(session: SessionBinding): SessionExecutionTarget {
      const bound = session.runtime_node_id;
      if (!bound || bound === getLocalNode().nodeId) {
        return { kind: 'local' };
      }
      const record = runtimeNodesDb.getById(bound);
      const credential = record ? runtimeNodeCredentialsDb.getByNodeId(bound) : null;
      if (!record || record.isLocal || !credential) {
        return refused('RUNTIME_NODE_MISMATCH', 'This session is bound to another runtime node and cannot run on this one.', bound);
      }
      if (credential.status === 'revoked') {
        return refused('RUNTIME_NODE_REVOKED', `"${record.label}" was revoked. This session cannot run anywhere else.`, bound);
      }
      if (!link.isUsable(bound)) {
        return refused('RUNTIME_NODE_OFFLINE', `"${record.label}" is offline. The message was not sent, and it was not moved to another node.`, bound);
      }
      if (session.provider !== 'claude' || session.claude_profile_id) {
        return refused('RUNTIME_NODE_PROVIDER_UNSUPPORTED', `"${record.label}" cannot run this session's provider or account.`, bound);
      }
      const projectId = session.project_id;
      const mapping = projectId ? runtimeNodeWorkspacesDb.get(bound, projectId) : null;
      if (!projectId || !mapping || mapping.status !== 'verified') {
        return refused('RUNTIME_NODE_WORKSPACE_UNAVAILABLE', `This project has no verified folder on "${record.label}".`, bound);
      }
      return { kind: 'remote', nodeId: bound, nodeLabel: record.label, cwd: mapping.nodePath, projectId };
    },

    /** True when a session's binding names an enrolled remote node (its history lives there). */
    isRemoteBinding(runtimeNodeId: string | null | undefined): boolean {
      if (!runtimeNodeId) {
        return false;
      }
      const record = runtimeNodesDb.getById(runtimeNodeId);
      return Boolean(record && !record.isLocal && runtimeNodeCredentialsDb.getByNodeId(runtimeNodeId));
    },

    /**
     * Reads a remote session's history from the node that ran it. Offline or
     * revoked nodes produce an explicit error; nothing is read from this
     * machine's disk instead. Consumed by the providers sessions service.
     */
    async fetchRemoteHistory(session: SessionBinding, page: { limit: number | null; offset: number }): Promise<FetchHistoryResult> {
      const { record, credential } = requireRemoteNode(session.runtime_node_id ?? '');
      if (credential.status === 'revoked') {
        throw new AppError(`The history of this session is stored on "${record.label}", which was revoked.`, {
          code: 'RUNTIME_NODE_REVOKED',
          statusCode: 409,
        });
      }
      const projectId = session.project_id;
      const mapping = projectId ? runtimeNodeWorkspacesDb.get(record.nodeId, projectId) : null;
      if (!mapping || !session.provider_session_id) {
        return { messages: [], total: 0, hasMore: false, offset: page.offset, limit: page.limit };
      }
      if (!link.isUsable(record.nodeId)) {
        throw new AppError(`The history of this session is stored on "${record.label}", which is offline.`, {
          code: 'RUNTIME_NODE_OFFLINE',
          statusCode: 409,
        });
      }
      return remoteExecution.fetchHistory(record.nodeId, {
        appSessionId: session.session_id,
        providerSessionId: session.provider_session_id,
        cwd: mapping.nodePath,
        limit: page.limit,
        offset: page.offset,
      });
    },

    /**
     * Maps a project (by id) to a folder on a remote node. The folder is
     * verified by that node, inside its own workspace root; only its answer
     * is stored, together with the repository identity it reported.
     */
    async mapWorkspace(input: { nodeId: string; projectId: string; path: unknown }): Promise<RuntimeNodeWorkspaceView> {
      const { record, credential } = requireRemoteNode(input.nodeId);
      if (credential.status !== 'active') {
        throw new AppError(`"${record.label}" was revoked.`, { code: 'RUNTIME_NODE_REVOKED', statusCode: 409 });
      }
      const requestedPath = typeof input.path === 'string' ? input.path.trim() : '';
      if (!requestedPath || requestedPath.length > MAX_WORKSPACE_PATH_LENGTH || requestedPath.includes('\0')) {
        throw new AppError('path must be a folder path on the runtime node.', { code: 'RUNTIME_NODE_WORKSPACE_PATH_INVALID', statusCode: 400 });
      }
      const project = requireProject(input.projectId);
      if (!link.isUsable(record.nodeId)) {
        throw new AppError(`"${record.label}" is offline; the folder cannot be verified.`, { code: 'RUNTIME_NODE_OFFLINE', statusCode: 409 });
      }
      const verification = await remoteExecution.verifyWorkspace(record.nodeId, requestedPath);
      if (!verification.ok || !verification.path) {
        throw new AppError(`"${record.label}" refused this folder.`, {
          code: 'RUNTIME_NODE_WORKSPACE_REJECTED',
          statusCode: 422,
          details: { reason: verification.reason },
        });
      }
      const verifiedAt = now();
      runtimeNodeWorkspacesDb.upsert({
        nodeId: record.nodeId,
        projectId: project.project_id,
        nodePath: verification.path,
        status: 'verified',
        reason: null,
        verifiedAt,
        gitRootCommits: verification.rootCommits,
      });
      return { state: 'mapped', reason: null, verifiedAt: new Date(verifiedAt).toISOString() };
    },

    unmapWorkspace(nodeId: string, projectId: string): boolean {
      requireRemoteNode(nodeId);
      return runtimeNodeWorkspacesDb.delete(nodeId, requireProject(projectId).project_id);
    },

    /**
     * State of a project's LOCAL working copy on one node (FT-M09), inspected
     * read-only by the machine that owns the folder: this server for its own
     * copy, the node itself for a mapped folder. Nothing is inferred from
     * another node's copy or from this server's path; an unmapped, offline or
     * unanswered node reads as such.
     */
    inspectProjectWorkspace(nodeId: string, projectId: string): Promise<ProjectWorkspaceStateView> {
      const key = `${nodeId}\0${projectId}`;
      const existing = inFlightInspections.get(key);
      if (existing) {
        return existing;
      }
      const inspection = inspectProjectWorkspaceOnce(nodeId, projectId).finally(() => inFlightInspections.delete(key));
      inFlightInspections.set(key, inspection);
      return inspection;
    },

    /** Revokes a remote node: terminal, closes its link and fails its runs at once. */
    revokeNode(nodeId: string): { revoked: boolean } {
      const { record } = requireRemoteNode(nodeId);
      const revoked = runtimeNodeCredentialsDb.revoke(record.nodeId, now());
      link.disconnect(record.nodeId, RUNTIME_NODE_LINK_CLOSE.revoked, 'revoked');
      remoteExecution.failNodeRuns(record.nodeId, 'RUNTIME_NODE_REVOKED', `"${record.label}" was revoked. The run was stopped and not moved to another node.`);
      return { revoked };
    },

    createEnrollment(userId: number | null, label: unknown) {
      return enrollment.createEnrollment(userId, label);
    },

    redeemEnrollment(input: Parameters<typeof enrollment.redeem>[0]) {
      return enrollment.redeem(input);
    },

    /** Where a check needing `capabilities` can be verified; never runs it. */
    async planVerification(input: { capabilities: RuntimeNodeCapabilityId[]; nodeId: string | null }) {
      const listing = await this.listNodes();
      return planCapabilityCheck({ required: input.capabilities, currentNodeId: input.nodeId, nodes: listing.nodes });
    },

    getNodeView(nodeId: string): RuntimeNodeView | null {
      return viewOf(nodeId);
    },

    /** The link and remote execution services, for the websocket gateway and chat routing. */
    link,
    remoteExecution,
  };
}

export type RuntimeNodesService = ReturnType<typeof createRuntimeNodesService>;

// The notification orchestrator is plain JS whose `= null` defaults infer as `null`-only parameters.
const notificationApi = { notifyRunStopped, notifyRunFailed, notifyUserIfEnabled, createNotificationEvent } as unknown as {
  notifyRunStopped(input: Record<string, unknown>): void;
  notifyRunFailed(input: Record<string, unknown>): void;
  notifyUserIfEnabled(input: { userId: unknown; event: unknown }): void;
  createNotificationEvent(input: Record<string, unknown>): unknown;
};

// runtimeNodesService: used by server/index.ts (startup registration, node link wiring), the runtime-nodes routes,
// the providers module (binding new sessions/handoff targets, remote history) and the websocket chat gateway (run routing).
export const runtimeNodesService = createRuntimeNodesService({
  notifications: {
    runStopped: ({ userId, sessionId, sessionName }) =>
      notificationApi.notifyRunStopped({ userId, provider: 'claude', sessionId, sessionName, stopReason: 'completed' }),
    runFailed: ({ userId, sessionId, sessionName, error }) =>
      notificationApi.notifyRunFailed({ userId, provider: 'claude', sessionId, sessionName, error }),
    actionRequired: ({ userId, sessionId, sessionName, toolName }) =>
      notificationApi.notifyUserIfEnabled({
        userId,
        event: notificationApi.createNotificationEvent({
          provider: 'claude',
          sessionId,
          kind: 'action_required',
          code: 'permission.required',
          meta: { toolName, sessionName },
          severity: 'warning',
          requiresUserAction: true,
        }),
      }),
  },
});
