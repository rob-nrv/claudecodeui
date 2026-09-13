/**
 * Framework-free rules for showing and targeting RuntimeNodes (FT-M07).
 *
 * The backend (`GET /api/runtime-nodes`) decides availability from probe
 * evidence; the UI never upgrades it. Targeting is explicit: a new session is
 * only pre-targeted when exactly one node can execute, and otherwise nothing is
 * implied on the user's behalf.
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
  reason: 'fresh_probe' | 'no_execution_capability' | 'probe_stale' | 'never_probed';
  lastSeenAt: string | null;
  freshUntil: string | null;
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
};

export type RuntimeNodesListing = {
  localNodeId: string;
  nodes: RuntimeNodeView[];
};

/** Presentation of a node's availability: a text key plus an emphasis that is never the only signal. */
export type RuntimeNodeStatusDisplay = {
  key: 'available' | 'claudeUnavailable' | 'notResponding' | 'unknown';
  emphasis: 'positive' | 'warning' | 'muted';
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

export function describeRuntimeNodeStatus(node: RuntimeNodeView): RuntimeNodeStatusDisplay {
  switch (node.availability.state) {
    case 'available':
      return { key: 'available', emphasis: 'positive' };
    case 'degraded':
      return { key: 'claudeUnavailable', emphasis: 'warning' };
    case 'unavailable':
      return { key: 'notResponding', emphasis: 'warning' };
    default:
      return { key: 'unknown', emphasis: 'muted' };
  }
}
