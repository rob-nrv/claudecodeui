// Capability-aware verification planning (FT-M08). Given what a check needs,
// decide whether it can run where the work already runs, on another
// RuntimeNode the user would have to authorize explicitly, or only by a human.
// Pure: nothing here executes, schedules or chooses a node on anyone's behalf.
import type { RuntimeNodeCapabilityId, RuntimeNodeView } from '@/shared/types.js';

export type CapabilityCheckPlan = {
  /**
   * - `here`: the current node is available and proved every capability.
   * - `another_runtime`: only other available nodes proved them; running there
   *   needs the user's explicit authorization.
   * - `human_check`: no available node proved them (for example
   *   `background-execution`, which nothing can probe yet).
   */
  disposition: 'here' | 'another_runtime' | 'human_check';
  currentNodeId: string | null;
  required: RuntimeNodeCapabilityId[];
  /** Capabilities the current node has not proved. */
  missingHere: RuntimeNodeCapabilityId[];
  candidates: Array<{ nodeId: string; label: string }>;
  requiresExplicitAuthorization: boolean;
};

function provenCapabilities(node: RuntimeNodeView): Set<RuntimeNodeCapabilityId> {
  return new Set(node.capabilities.filter((capability) => capability.status === 'available').map((capability) => capability.id));
}

function satisfies(node: RuntimeNodeView, required: RuntimeNodeCapabilityId[]): boolean {
  if (!node.canExecute || node.availability.state !== 'available') {
    return false;
  }
  const proven = provenCapabilities(node);
  return required.every((id) => proven.has(id));
}

/**
 * Plans where a check needing `required` capabilities can be verified.
 * Consumed by the runtime-nodes service (verification route).
 */
export function planCapabilityCheck(input: {
  required: RuntimeNodeCapabilityId[];
  currentNodeId: string | null;
  nodes: RuntimeNodeView[];
}): CapabilityCheckPlan {
  const current = input.nodes.find((node) => node.nodeId === input.currentNodeId) ?? null;
  const provenHere = current ? provenCapabilities(current) : new Set<RuntimeNodeCapabilityId>();
  const missingHere = input.required.filter((id) => !current || !current.canExecute || !provenHere.has(id));

  if (current && satisfies(current, input.required)) {
    return {
      disposition: 'here',
      currentNodeId: current.nodeId,
      required: input.required,
      missingHere: [],
      candidates: [],
      requiresExplicitAuthorization: false,
    };
  }

  const candidates = input.nodes
    .filter((node) => node.nodeId !== input.currentNodeId && satisfies(node, input.required))
    .map((node) => ({ nodeId: node.nodeId, label: node.label }));

  return {
    disposition: candidates.length > 0 ? 'another_runtime' : 'human_check',
    currentNodeId: current?.nodeId ?? null,
    required: input.required,
    missingHere,
    candidates,
    requiresExplicitAuthorization: candidates.length > 0,
  };
}
