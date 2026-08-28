// Runtime identity and state primitives shared by every CloudCLI runtime
// controller: the desktop app today, an Android wrapper next, and any
// Linux/NAS/VPS supervisor after that. Platform-specific launching stays in the
// controller; what "online" means lives here so they cannot disagree.
export {
  type LocalServerMarker,
  type RuntimeHealth,
  type RuntimeIdentity,
  buildLocalServerMarker,
  createRuntimeIdentity,
  parseLocalServerMarker,
  parseRuntimeHealth,
  resolveHealthUrl,
  resolveLocalServerMarkerPath,
} from './runtime-marker.js';
export {
  type LocalServerMarkerStore,
  createLocalServerMarkerStore,
} from './runtime-marker.store.js';
export {
  type RuntimeEvidence,
  type RuntimeIntent,
  type RuntimeState,
  type RuntimeStatus,
  type RuntimeStatusReason,
  DEFAULT_STARTUP_GRACE_MS,
  resolveRuntimeStatus,
} from './runtime-status.js';
export {
  type RuntimeController,
  type RuntimeStopOptions,
  type RuntimeStopOutcome,
  type RuntimeStopResult,
  DEFAULT_STOP_TIMEOUT_MS,
  createRuntimeController,
} from './runtime-controller.service.js';
export {
  type RuntimeProbe,
  type RuntimeProbeDependencies,
  type RuntimeProbeOptions,
  createRuntimeProbe,
} from './runtime-probe.js';
export {
  type RuntimeRestartOptions,
  type RuntimeRestartOutcome,
  type RuntimeRestartResult,
  type RuntimeRestartService,
  DEFAULT_RESTART_TIMEOUT_MS,
  createRuntimeRestartService,
} from './runtime-restart.service.js';
export {
  type RuntimeStartDependencies,
  type RuntimeStartOptions,
  type RuntimeStartOutcome,
  type RuntimeStartResult,
  type RuntimeStartService,
  DEFAULT_START_TIMEOUT_MS,
  createRuntimeStartService,
} from './runtime-start.service.js';
export {
  createDetachedServerLauncher,
  createLocalRuntimeController,
  createLocalRuntimeRestartService,
  createLocalRuntimeStartService,
  isProcessAlive,
  resolveFallbackHealthUrl,
  resolveServerEntryPath,
} from './runtime.module.js';
