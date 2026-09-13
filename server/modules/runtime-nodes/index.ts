// RuntimeNode foundation (FT-M07) and multi-node control plane (FT-M08): which
// machine owns an execution, what it has actually proven it can do, and the
// authenticated links remote nodes use. Deliberately separate from the
// `runtime` module, which stays free of database imports for the CLI cold-start path.

// runtimeNodesService: used by server/index.ts, the providers module and the websocket chat gateway.
export { runtimeNodesService } from '@/modules/runtime-nodes/runtime-nodes.service.js';
export type { SessionExecutionTarget } from '@/modules/runtime-nodes/runtime-nodes.service.js';
// runtimeNodesRoutes: mounted by server/index.ts behind authentication.
export { default as runtimeNodesRoutes } from '@/modules/runtime-nodes/runtime-nodes.routes.js';
// runtimeNodeLinkRoutes: mounted by server/index.ts as the public, code-authenticated enrollment endpoint.
export { default as runtimeNodeLinkRoutes } from '@/modules/runtime-nodes/runtime-node-link.routes.js';
// probeLocalRuntimeCapabilities / proveDirectoryWritable: used by the node-agent module to answer probe requests about its own machine.
export { detectAndroidHost, probeLocalRuntimeCapabilities, proveDirectoryWritable } from '@/modules/runtime-nodes/runtime-node-probes.js';
// Evidence evaluation primitives: used by the node-agent doctor so a local diagnostic reads exactly like the control plane's view.
export {
  capabilityVerification,
  normalizeRuntimeArch,
  normalizeRuntimePlatform,
  RUNTIME_NODE_CAPABILITY_IDS,
  toRuntimeNodeCapability,
} from '@/modules/runtime-nodes/runtime-node-availability.js';
export type { RuntimeNodeRunObservations } from '@/modules/runtime-nodes/runtime-node-probes.js';
