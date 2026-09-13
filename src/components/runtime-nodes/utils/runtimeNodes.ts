/**
 * Framework-free rules for showing and targeting RuntimeNodes (FT-M07, FT-M08).
 *
 * The backend (`GET /api/runtime-nodes`) decides availability from probe
 * evidence; the UI never upgrades it. Targeting is explicit: a new session is
 * only pre-targeted when exactly one node can execute, a node the user chose
 * stays chosen even when it becomes unusable, and nothing ever falls through
 * to another node on the user's behalf.
 */

export type RuntimeNodeCapabilityStatus = 'available' | 'unavailable' | 'unsupported' | 'unknown';

export type RuntimeNodeCapabilityId =
  | 'node-runtime'
  | 'claude-cli'
  | 'claude-auth'
  | 'claude-headless'
  | 'git-cli'
  | 'workspace-filesystem'
  | 'background-execution';

export type RuntimeNodeCapability = {
  id: RuntimeNodeCapabilityId;
  status: RuntimeNodeCapabilityStatus;
  detail: string | null;
  reason: string | null;
  probedAt: number | null;
  /** FT-M09: how the capability can be established; `device_check` means only a person can verify it. */
  verification?: 'probe' | 'observed_run' | 'device_check';
  /** FT-M09: stale evidence is context, never proof. */
  freshness?: 'fresh' | 'stale' | null;
};

type ResourceSignal<T> = ({ state: 'known' } & T) | { state: 'unknown'; reason: string };

/** Resource Governor report from a connected node agent (FT-M09); never present for this server's own node. */
export type RuntimeNodeResources = {
  admission: 'accepting' | 'at_capacity' | 'restricted';
  restriction: 'storage_low' | 'battery_low' | null;
  activeRuns: number;
  maxConcurrentRuns: number;
  storage: ResourceSignal<{ freeBytes: number; minFreeBytes: number }>;
  battery: ResourceSignal<{ percent: number; charging: boolean | null; minPercent: number | null }>;
  thermal: ResourceSignal<{ celsius: number }>;
  observedAt: string;
};

/** State of a project's local working copy on one node (FT-M09); never carries a path or a file name. */
export type ProjectWorkspaceState = {
  state: 'clean' | 'dirty' | 'missing' | 'unavailable' | 'identity_mismatch' | 'diverged' | 'unmapped' | 'unknown';
  reason: string | null;
  identity: 'match' | 'mismatch' | 'unrecorded' | 'unknown';
  inspectedAt: string | null;
  git: {
    rootIsFolder: boolean;
    branch: string | null;
    detached: boolean;
    headCommit: string | null;
    upstream: { ahead: number; behind: number } | null;
  } | null;
  changes: { total: number; conflicted: number; truncated: boolean } | null;
  sync: { syncable: number; localOnly: number; secret: number; userExcluded: number } | null;
};

export type RuntimeNodeAvailability = {
  state: 'available' | 'degraded' | 'unavailable' | 'unknown';
  reason:
    | 'fresh_probe'
    | 'no_execution_capability'
    | 'probe_stale'
    | 'never_probed'
    | 'link_connected'
    | 'probe_pending'
    | 'link_offline'
    | 'link_stale'
    | 'never_connected'
    | 'identity_conflict'
    | 'protocol_incompatible'
    | 'revoked';
  lastSeenAt: string | null;
  freshUntil: string | null;
};

/** Whether the current project's folder is usable on a node; never carries a path. */
export type RuntimeNodeWorkspace = {
  state: 'available' | 'mapped' | 'unmapped' | 'unavailable';
  reason: string | null;
  verifiedAt: string | null;
};

export type RuntimeNodeView = {
  nodeId: string;
  label: string;
  isLocal: boolean;
  canExecute: boolean;
  platform: string | null;
  arch: string | null;
  runtimeVersion: string | null;
  availability: RuntimeNodeAvailability;
  capabilities: RuntimeNodeCapability[];
  evidence?: 'local_probe' | 'node_probe';
  enrollment?: 'local' | 'active' | 'revoked' | 'unenrolled';
  workspace?: RuntimeNodeWorkspace;
  resources?: RuntimeNodeResources | null;
};

export type RuntimeNodesListing = {
  localNodeId: string;
  nodes: RuntimeNodeView[];
};

/** Presentation of a node's availability: a text key plus an emphasis that is never the only signal. */
export type RuntimeNodeStatusDisplay = {
  key:
    | 'available'
    | 'claudeUnavailable'
    | 'notResponding'
    | 'unknown'
    | 'offline'
    | 'checking'
    | 'conflict'
    | 'incompatible'
    | 'revoked'
    | 'neverConnected';
  emphasis: 'positive' | 'warning' | 'muted';
};

/** Why a new session cannot be created on the current target. */
export type RunTargetBlock =
  | 'choose_node'
  | 'node_missing'
  | 'node_unavailable'
  | 'provider_unsupported'
  | 'workspace_unmapped'
  | 'workspace_unavailable';

/** English defaults for blocked targets; `{{label}}` is the target node's label. */
export const RUN_TARGET_BLOCK_DEFAULTS: Record<RunTargetBlock, string> = {
  choose_node: 'Choose where this session runs.',
  node_missing: 'The node you chose is no longer available. Choose another.',
  node_unavailable: '{{label}} cannot run a session right now. Nothing will be sent to another node.',
  provider_unsupported: '{{label}} only runs Claude sessions.',
  workspace_unmapped: 'This project has no folder on {{label}} yet.',
  workspace_unavailable: '{{label}} could not use the folder mapped for this project.',
};

export type RunTargetResolution = {
  /** Sent with the session creation request; null lets the server apply its own single-node rule. */
  nodeId: string | null;
  node: RuntimeNodeView | null;
  isRemote: boolean;
  /** True when nobody chose: the only executable node is shown as the target. */
  implied: boolean;
  blocked: RunTargetBlock | null;
};

/**
 * The node a brand-new session will be bound to, or null when none can be
 * implied: the listing is not loaded, no node can execute, or several can.
 */
export function resolveCreationTarget(listing: RuntimeNodesListing | null): RuntimeNodeView | null {
  if (!listing) {
    return null;
  }
  const executable = listing.nodes.filter((node) => node.canExecute);
  return executable.length === 1 ? executable[0] : null;
}

/** Nodes a user can pick: revoked nodes are gone for good and never offered. */
export function selectableRuntimeNodes(listing: RuntimeNodesListing | null): RuntimeNodeView[] {
  return listing ? listing.nodes.filter((node) => node.enrollment !== 'revoked') : [];
}

/** The picker appears only once there is more than one node to tell apart. */
export function needsRuntimePicker(listing: RuntimeNodesListing | null): boolean {
  return selectableRuntimeNodes(listing).length > 1;
}

/**
 * Resolves the target of the next new session from backend truth and the
 * user's explicit choice. A chosen node that disappeared or cannot run now
 * BLOCKS creation instead of being replaced; with several nodes and no choice,
 * the user must choose.
 */
export function resolveRunTarget(
  listing: RuntimeNodesListing | null,
  explicitNodeId: string | null,
  provider: string,
): RunTargetResolution {
  const none = (blocked: RunTargetBlock | null): RunTargetResolution =>
    ({ nodeId: null, node: null, isRemote: false, implied: false, blocked });

  if (!listing) {
    return none(null);
  }

  const selectable = selectableRuntimeNodes(listing);
  let node: RuntimeNodeView | null;
  let implied = false;
  if (explicitNodeId) {
    node = selectable.find((candidate) => candidate.nodeId === explicitNodeId) ?? null;
    if (!node) {
      return none('node_missing');
    }
  } else {
    node = resolveCreationTarget(listing);
    implied = true;
    if (!node) {
      return none(selectable.length > 1 ? 'choose_node' : null);
    }
  }

  const base = { nodeId: node.nodeId, node, isRemote: !node.isLocal, implied };
  if (!node.canExecute) {
    return { ...base, blocked: 'node_unavailable' };
  }
  if (!node.isLocal && provider !== 'claude') {
    return { ...base, blocked: 'provider_unsupported' };
  }
  if (!node.isLocal && node.workspace?.state === 'unmapped') {
    return { ...base, blocked: 'workspace_unmapped' };
  }
  if (!node.isLocal && node.workspace?.state === 'unavailable') {
    return { ...base, blocked: 'workspace_unavailable' };
  }
  return { ...base, blocked: null };
}

export function describeRuntimeNodeStatus(node: RuntimeNodeView): RuntimeNodeStatusDisplay {
  const { state, reason } = node.availability;
  switch (state) {
    case 'available':
      return { key: 'available', emphasis: 'positive' };
    case 'degraded':
      if (reason === 'probe_pending') return { key: 'checking', emphasis: 'muted' };
      if (reason === 'identity_conflict') return { key: 'conflict', emphasis: 'warning' };
      if (reason === 'protocol_incompatible') return { key: 'incompatible', emphasis: 'warning' };
      return { key: 'claudeUnavailable', emphasis: 'warning' };
    case 'unavailable':
      if (reason === 'revoked') return { key: 'revoked', emphasis: 'muted' };
      if (reason === 'link_offline' || reason === 'link_stale') return { key: 'offline', emphasis: 'warning' };
      return { key: 'notResponding', emphasis: 'warning' };
    default:
      return reason === 'never_connected' ? { key: 'neverConnected', emphasis: 'muted' } : { key: 'unknown', emphasis: 'muted' };
  }
}

/** English defaults for capability names in the evidence list. */
export const CAPABILITY_LABEL_DEFAULTS: Record<RuntimeNodeCapabilityId, string> = {
  'node-runtime': 'Node runtime',
  'claude-cli': 'Claude CLI',
  'claude-auth': 'Claude login',
  'claude-headless': 'Headless run',
  'git-cli': 'Git',
  'workspace-filesystem': 'Workspace folder',
  'background-execution': 'Background execution',
};

export type CapabilityEvidenceDisplay = {
  key: 'proven' | 'staleProof' | 'unavailable' | 'unsupported' | 'deviceCheck' | 'awaitingRun' | 'unknown';
  emphasis: 'positive' | 'warning' | 'muted';
};

export const CAPABILITY_EVIDENCE_DEFAULTS: Record<CapabilityEvidenceDisplay['key'], string> = {
  proven: 'Proven',
  staleProof: 'Proven earlier (out of date)',
  unavailable: 'Not available',
  unsupported: 'Not supported',
  deviceCheck: 'Needs a check on the device',
  awaitingRun: 'Not proven yet (needs a completed run)',
  unknown: 'Unknown',
};

/**
 * How one capability's evidence is shown (FT-M09). Only fresh proof reads as
 * proven; what only a person can verify, or only a real run can prove, says so
 * instead of reading as a failure or a success.
 */
export function describeCapabilityEvidence(capability: RuntimeNodeCapability): CapabilityEvidenceDisplay {
  switch (capability.status) {
    case 'available':
      return capability.freshness === 'stale' ? { key: 'staleProof', emphasis: 'warning' } : { key: 'proven', emphasis: 'positive' };
    case 'unavailable':
      return { key: 'unavailable', emphasis: 'warning' };
    case 'unsupported':
      return { key: 'unsupported', emphasis: 'muted' };
    default:
      if (capability.verification === 'device_check') return { key: 'deviceCheck', emphasis: 'muted' };
      if (capability.verification === 'observed_run') return { key: 'awaitingRun', emphasis: 'muted' };
      return { key: 'unknown', emphasis: 'muted' };
  }
}

/** A machine reason as short readable text; reasons are server-sanitized snake_case tokens. */
export function formatEvidenceReason(reason: string | null): string | null {
  return reason ? reason.replace(/_/g, ' ') : null;
}

export type ResourcesDisplay = {
  key: 'accepting' | 'atCapacity' | 'storageLow' | 'batteryLow';
  emphasis: 'positive' | 'warning';
};

export const RESOURCES_DEFAULTS: Record<ResourcesDisplay['key'], string> = {
  accepting: 'Accepting runs ({{active}}/{{max}})',
  atCapacity: 'At capacity ({{active}}/{{max}} runs)',
  storageLow: 'Refusing runs: low storage',
  batteryLow: 'Refusing runs: low battery',
};

export function describeResources(resources: RuntimeNodeResources): ResourcesDisplay {
  if (resources.admission === 'at_capacity') return { key: 'atCapacity', emphasis: 'warning' };
  if (resources.admission === 'restricted') {
    return resources.restriction === 'battery_low' ? { key: 'batteryLow', emphasis: 'warning' } : { key: 'storageLow', emphasis: 'warning' };
  }
  return { key: 'accepting', emphasis: 'positive' };
}

export type WorkspaceStateDisplay = {
  key: 'clean' | 'dirty' | 'missing' | 'unavailable' | 'identityMismatch' | 'diverged' | 'unmapped' | 'unknown';
  emphasis: 'positive' | 'warning' | 'muted';
};

export const WORKSPACE_STATE_DEFAULTS: Record<WorkspaceStateDisplay['key'], string> = {
  clean: 'No uncommitted changes',
  dirty: '{{count}} uncommitted change(s)',
  missing: 'Folder not found',
  unavailable: 'Cannot be checked right now',
  identityMismatch: 'Holds a different repository than when it was mapped',
  diverged: 'Diverged from its upstream branch',
  unmapped: 'No folder mapped',
  unknown: 'State unknown',
};

/** Only states the node actually established are shown; nothing here claims sync or cloud state. */
export function describeWorkspaceState(workspace: ProjectWorkspaceState): WorkspaceStateDisplay {
  switch (workspace.state) {
    case 'clean':
      return { key: 'clean', emphasis: 'positive' };
    case 'dirty':
      return { key: 'dirty', emphasis: 'warning' };
    case 'identity_mismatch':
      return { key: 'identityMismatch', emphasis: 'warning' };
    case 'diverged':
      return { key: 'diverged', emphasis: 'warning' };
    case 'missing':
      return { key: 'missing', emphasis: 'warning' };
    case 'unavailable':
      return { key: 'unavailable', emphasis: 'muted' };
    case 'unmapped':
      return { key: 'unmapped', emphasis: 'muted' };
    default:
      return { key: 'unknown', emphasis: 'muted' };
  }
}

const RUNTIME_TARGET_STORAGE_PREFIX = 'cloudcli.runtimeTarget.';

/** The node a user last chose for new sessions in a project; a UI preference, re-validated by the server every time. */
export function readRuntimeTargetChoice(projectId: string | null): string | null {
  if (!projectId) {
    return null;
  }
  try {
    return window.localStorage.getItem(`${RUNTIME_TARGET_STORAGE_PREFIX}${projectId}`);
  } catch {
    return null;
  }
}

export function writeRuntimeTargetChoice(projectId: string | null, nodeId: string | null): void {
  if (!projectId) {
    return;
  }
  try {
    if (nodeId) {
      window.localStorage.setItem(`${RUNTIME_TARGET_STORAGE_PREFIX}${projectId}`, nodeId);
    } else {
      window.localStorage.removeItem(`${RUNTIME_TARGET_STORAGE_PREFIX}${projectId}`);
    }
  } catch {
    // Storage unavailable: the choice simply lasts for this page.
  }
}
