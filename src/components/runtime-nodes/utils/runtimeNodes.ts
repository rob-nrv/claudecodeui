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

export type RuntimeNodeCapability = {
  id: 'claude-cli' | 'git-cli' | 'workspace-filesystem' | 'background-execution';
  status: RuntimeNodeCapabilityStatus;
  detail: string | null;
  reason: string | null;
  probedAt: number | null;
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
