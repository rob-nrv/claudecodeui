// `cloudcli node doctor` (FT-M09-R1): one local, read-mostly diagnostic of a
// RuntimeNode, built on the same evidence primitives the control plane uses.
// It never opens a node link, never sends a prompt, and never prints a
// credential, an enrollment code, a key, an account identity or an
// environment value. Its only write is the existing workspace write probe.
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { normalizeServerOrigin, readNodeAgentCredential } from '@/modules/node-agent/node-agent-credential.store.js';
import {
  buildResourceReport,
  readNodeResourceSignals,
  type NodeResourceSignals,
  type ResourceGovernorPolicy,
} from '@/modules/node-agent/node-agent-resource-governor.js';
import { NODE_AGENT_RUN_JOURNAL_FILE, readNodeAgentRunJournalSummary } from '@/modules/node-agent/node-agent-run-journal.js';
import { validateNodeWorkspaceRoot } from '@/modules/node-agent/node-agent-workspace.js';
import {
  capabilityVerification,
  detectAndroidHost,
  normalizeRuntimeArch,
  normalizeRuntimePlatform,
  probeLocalRuntimeCapabilities,
  proveDirectoryWritable,
  RUNTIME_NODE_CAPABILITY_IDS,
  toRuntimeNodeCapability,
} from '@/modules/runtime-nodes/index.js';
import type { RuntimeNodeCapabilityId, RuntimeNodeResourceReport } from '@/shared/types.js';
import { RUNTIME_NODE_LINK_PROTOCOL_VERSION } from '@/shared/utils.js';

export type DoctorCapabilityStatus = 'proven' | 'not_available' | 'not_supported' | 'unknown' | 'needs_device_check' | 'not_proven_yet';

/** The evidence record printed with `--json` or written with `--output`. Version it when its shape changes. */
export type NodeDoctorReport = {
  schema: 'cloudcli.node-doctor';
  version: 1;
  generatedAt: string;
  runtime: {
    cloudcliVersion: string | null;
    linkProtocolVersion: number;
    nodeVersion: string;
    platform: string | null;
    arch: string | null;
    androidHost: boolean;
  };
  enrollment: {
    state: 'enrolled' | 'not_enrolled' | 'invalid_server_origin';
    nodeId: string | null;
    serverOrigin: string | null;
    enrolledAt: string | null;
    credentialFile: 'owner_only' | 'readable_by_others' | 'not_checked' | 'missing';
  };
  stateDirectory: { path: string; state: 'ok' | 'missing' | 'not_a_directory' | 'not_writable'; permissions: 'owner_only' | 'open_to_others' | 'not_checked' };
  workspaceRoot: { path: string; state: 'ok' | 'invalid'; reason: string | null };
  capabilities: Array<{ id: RuntimeNodeCapabilityId; status: DoctorCapabilityStatus; reason: string | null; detail: string | null }>;
  governor: ResourceGovernorPolicy;
  /** Admission as if no run were active: the doctor cannot see a running agent's runs. */
  resourcesWhenIdle: RuntimeNodeResourceReport;
  journal:
    | { state: 'missing' | 'unreadable'; unfinished: null; interrupted: null; lastCompletedAt: null }
    | { state: 'ok'; unfinished: number; interrupted: number; lastCompletedAt: string | null };
  controlPlane: { state: 'reachable' | 'unreachable' | 'tls_untrusted' | 'skipped' | 'not_enrolled'; httpStatus: number | null; reason: string | null };
  summary: { readyForRuns: boolean; blockers: string[]; needsDeviceCheck: RuntimeNodeCapabilityId[] };
};

export type NodeDoctorDependencies = {
  probe?: typeof probeLocalRuntimeCapabilities;
  readSignals?: (workspaceRoot: string) => Promise<NodeResourceSignals>;
  fetch?: typeof fetch;
  now?: () => number;
  environment?: Record<string, string | undefined>;
  platform?: string;
  arch?: string;
  nodeVersion?: string;
};

const CONTROL_PLANE_TIMEOUT_MS = 8_000;
const TLS_ERROR_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

function toDoctorStatus(id: RuntimeNodeCapabilityId, status: string): DoctorCapabilityStatus {
  if (status === 'available') return 'proven';
  if (status === 'unavailable') return 'not_available';
  if (status === 'unsupported') return 'not_supported';
  const verification = capabilityVerification(id);
  if (verification === 'device_check') return 'needs_device_check';
  if (verification === 'observed_run') return 'not_proven_yet';
  return 'unknown';
}

function machineCode(value: unknown): string | null {
  return typeof value === 'string' && value ? value.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 64) : null;
}

async function inspectStateDirectory(stateDir: string): Promise<NodeDoctorReport['stateDirectory']> {
  const result: NodeDoctorReport['stateDirectory'] = { path: stateDir, state: 'ok', permissions: 'not_checked' };
  try {
    const stats = await fs.stat(stateDir);
    if (!stats.isDirectory()) {
      return { ...result, state: 'not_a_directory' };
    }
    if (process.platform !== 'win32') {
      result.permissions = (stats.mode & 0o077) === 0 ? 'owner_only' : 'open_to_others';
    }
    await fs.access(stateDir, fsConstants.W_OK);
    return result;
  } catch (error) {
    return { ...result, state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'not_writable' };
  }
}

async function credentialFileMode(stateDir: string): Promise<NodeDoctorReport['enrollment']['credentialFile']> {
  try {
    const stats = await fs.stat(path.join(stateDir, 'credential.json'));
    if (process.platform === 'win32') return 'not_checked';
    return (stats.mode & 0o077) === 0 ? 'owner_only' : 'readable_by_others';
  } catch {
    return 'missing';
  }
}

/** Reachability of the control plane's public `/health` only: no credential, no signed header, no link. */
async function checkControlPlane(origin: string, fetchImpl: typeof fetch): Promise<NodeDoctorReport['controlPlane']> {
  try {
    const response = await fetchImpl(`${origin}/health`, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(CONTROL_PLANE_TIMEOUT_MS) });
    await response.body?.cancel().catch(() => undefined);
    return { state: 'reachable', httpStatus: response.status, reason: null };
  } catch (error) {
    const failure = error as { name?: string; code?: string; cause?: { code?: string } };
    const code = failure.cause?.code ?? failure.code ?? null;
    if (code && TLS_ERROR_CODES.has(code)) {
      return { state: 'tls_untrusted', httpStatus: null, reason: machineCode(code) };
    }
    if (failure.name === 'TimeoutError' || failure.name === 'AbortError') {
      return { state: 'unreachable', httpStatus: null, reason: 'timeout' };
    }
    return { state: 'unreachable', httpStatus: null, reason: machineCode(code) ?? 'network_error' };
  }
}

export async function runNodeDoctor(
  input: {
    stateDir: string;
    workspaceRoot: string;
    runtimeVersion: string | null;
    policy: ResourceGovernorPolicy;
    checkControlPlane: boolean;
  },
  dependencies: NodeDoctorDependencies = {},
): Promise<NodeDoctorReport> {
  const now = dependencies.now ?? Date.now;
  const environment = dependencies.environment ?? process.env;
  const platform = dependencies.platform ?? process.platform;
  const arch = dependencies.arch ?? process.arch;
  const nodeVersion = (dependencies.nodeVersion ?? process.versions.node).replace(/[^0-9.]/g, '');
  const probe = dependencies.probe ?? probeLocalRuntimeCapabilities;
  const readSignals = dependencies.readSignals ?? readNodeResourceSignals;

  const [credential, stateDirectory, credentialFile, journalSummary, androidHost] = await Promise.all([
    readNodeAgentCredential(input.stateDir),
    inspectStateDirectory(input.stateDir),
    credentialFileMode(input.stateDir),
    readNodeAgentRunJournalSummary(path.join(input.stateDir, NODE_AGENT_RUN_JOURNAL_FILE)),
    detectAndroidHost({
      platform,
      environment,
      fileExists: (file) => fs.access(file).then(() => true, () => false),
    }).catch(() => false),
  ]);

  const origin = credential ? normalizeServerOrigin(credential.serverOrigin) : null;
  const enrollment: NodeDoctorReport['enrollment'] = credential
    ? {
      state: origin?.ok ? 'enrolled' : 'invalid_server_origin',
      nodeId: credential.nodeId,
      serverOrigin: origin?.ok ? origin.origin : null,
      enrolledAt: credential.enrolledAt,
      credentialFile,
    }
    : { state: 'not_enrolled', nodeId: null, serverOrigin: null, enrolledAt: null, credentialFile: credentialFile === 'missing' ? 'missing' : credentialFile };

  const validatedRoot = await validateNodeWorkspaceRoot(path.resolve(input.workspaceRoot));
  const workspaceRoot: NodeDoctorReport['workspaceRoot'] = validatedRoot.ok
    ? { path: validatedRoot.path, state: 'ok', reason: null }
    : { path: path.resolve(input.workspaceRoot), state: 'invalid', reason: validatedRoot.error };

  const lastCompletedAt = journalSummary.state === 'ok' ? journalSummary.lastCompletedAt : null;
  const [outcomes, signals, controlPlane] = await Promise.all([
    probe({
      workspacesRoot: workspaceRoot.path,
      proveWorkspaceWrite: workspaceRoot.state === 'ok' ? proveDirectoryWritable : null,
      checkWorkspaceRoot: workspaceRoot.state === 'ok' ? undefined : async () => {
        throw new Error('invalid workspace root');
      },
      observations: {
        // A one-shot check observes no suspension; only the journal's completed runs count.
        startedAt: null,
        lastCompletedRunAt: () => lastCompletedAt,
        lastSuspension: () => null,
      },
    }),
    readSignals(workspaceRoot.path),
    input.checkControlPlane && enrollment.serverOrigin
      ? checkControlPlane(enrollment.serverOrigin, dependencies.fetch ?? fetch)
      : Promise.resolve<NodeDoctorReport['controlPlane']>({
        state: enrollment.serverOrigin ? 'skipped' : 'not_enrolled',
        httpStatus: null,
        reason: null,
      }),
  ]);

  const probedAt = now();
  const capabilities = RUNTIME_NODE_CAPABILITY_IDS.map((id) => {
    const capability = toRuntimeNodeCapability(id, outcomes[id] ?? { outcome: 'not_probed', reason: 'not_reported' }, probedAt);
    return { id, status: toDoctorStatus(id, capability.status), reason: capability.reason, detail: capability.detail };
  });
  const statusOf = (id: RuntimeNodeCapabilityId) => capabilities.find((capability) => capability.id === id)?.status;

  const blockers: string[] = [];
  if (enrollment.state !== 'enrolled') blockers.push(enrollment.state);
  if (stateDirectory.state !== 'ok') blockers.push(`state_directory_${stateDirectory.state}`);
  if (workspaceRoot.state !== 'ok') blockers.push('workspace_root_invalid');
  if (statusOf('claude-cli') !== 'proven') blockers.push('claude_cli_not_proven');
  if (statusOf('claude-auth') === 'not_available') blockers.push('claude_not_logged_in');
  if (statusOf('workspace-filesystem') !== 'proven') blockers.push('workspace_not_proven');
  if (controlPlane.state === 'unreachable' || controlPlane.state === 'tls_untrusted') blockers.push(`control_plane_${controlPlane.state}`);
  const resourcesWhenIdle = buildResourceReport(input.policy, 0, signals);
  if (resourcesWhenIdle.admission === 'restricted') blockers.push(`resources_${resourcesWhenIdle.restriction}`);

  return {
    schema: 'cloudcli.node-doctor',
    version: 1,
    generatedAt: new Date(probedAt).toISOString(),
    runtime: {
      cloudcliVersion: input.runtimeVersion,
      linkProtocolVersion: RUNTIME_NODE_LINK_PROTOCOL_VERSION,
      nodeVersion,
      platform: normalizeRuntimePlatform(platform),
      arch: normalizeRuntimeArch(arch),
      androidHost,
    },
    enrollment,
    stateDirectory,
    workspaceRoot,
    capabilities,
    governor: input.policy,
    resourcesWhenIdle,
    journal: journalSummary.state === 'ok'
      ? {
        state: 'ok',
        unfinished: journalSummary.unfinished,
        interrupted: journalSummary.interrupted,
        lastCompletedAt: journalSummary.lastCompletedAt === null ? null : new Date(journalSummary.lastCompletedAt).toISOString(),
      }
      : { state: journalSummary.state, unfinished: null, interrupted: null, lastCompletedAt: null },
    controlPlane,
    summary: {
      readyForRuns: blockers.length === 0,
      blockers,
      needsDeviceCheck: capabilities.filter((capability) => capability.status === 'needs_device_check').map((capability) => capability.id),
    },
  };
}

const CAPABILITY_LABELS: Record<RuntimeNodeCapabilityId, string> = {
  'node-runtime': 'Node runtime',
  'claude-cli': 'Claude CLI',
  'claude-auth': 'Claude login',
  'claude-headless': 'Headless run',
  'git-cli': 'Git',
  'workspace-filesystem': 'Workspace folder',
  'background-execution': 'Background execution',
};

const STATUS_LABELS: Record<DoctorCapabilityStatus, string> = {
  proven: 'Proven',
  not_available: 'Not available',
  not_supported: 'Not supported',
  unknown: 'Unknown',
  needs_device_check: 'Needs device check',
  not_proven_yet: 'Not proven yet',
};

const human = (value: string | null) => (value ? value.replace(/_/g, ' ') : '');
const megabytes = (bytes: number) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`);

/** Human-readable report lines; carries exactly the same (non-secret) facts as the JSON record. */
export function formatNodeDoctorReport(report: NodeDoctorReport): string[] {
  const lines: string[] = [];
  const row = (label: string, value: string) => lines.push(`${`${label}:`.padEnd(16)}${value}`);
  lines.push(`CloudCLI node doctor (${report.generatedAt})`);
  row('Runtime', `CloudCLI ${report.runtime.cloudcliVersion ?? 'unknown'} · link protocol ${report.runtime.linkProtocolVersion} · Node ${report.runtime.nodeVersion} · ${report.runtime.platform ?? '?'} ${report.runtime.arch ?? '?'}${report.runtime.androidHost ? ' (Android host)' : ''}`);
  row('Enrollment', report.enrollment.state === 'enrolled'
    ? `enrolled as ${report.enrollment.nodeId} -> ${report.enrollment.serverOrigin} (credential file: ${human(report.enrollment.credentialFile)})`
    : human(report.enrollment.state));
  row('State dir', `${human(report.stateDirectory.state)} · ${report.stateDirectory.path} · ${human(report.stateDirectory.permissions)}`);
  row('Workspace root', `${report.workspaceRoot.state === 'ok' ? 'ok' : `invalid: ${report.workspaceRoot.reason}`} · ${report.workspaceRoot.path}`);
  row('Control plane', `${human(report.controlPlane.state)}${report.controlPlane.httpStatus !== null ? ` (HTTP ${report.controlPlane.httpStatus})` : ''}${report.controlPlane.reason ? ` (${human(report.controlPlane.reason)})` : ''}`);
  lines.push('Capabilities:');
  for (const capability of report.capabilities) {
    const note = capability.detail ?? human(capability.reason);
    lines.push(`  ${CAPABILITY_LABELS[capability.id].padEnd(22)}${STATUS_LABELS[capability.status].padEnd(20)}${note}`.trimEnd());
  }
  const governor = report.governor;
  row('Governor', `at most ${governor.maxConcurrentRuns} concurrent run(s) · storage floor ${Math.round(governor.minFreeStorageBytes / 1024 ** 2)} MB · battery floor ${governor.minBatteryPercent === null ? 'off' : `${governor.minBatteryPercent}%`}`);
  const resources = report.resourcesWhenIdle;
  row('Resources', [
    resources.admission === 'accepting' ? 'accepting runs when idle' : `refusing runs: ${human(resources.restriction)}`,
    resources.storage.state === 'known' ? `storage ${megabytes(resources.storage.freeBytes)} free` : `storage unknown (${human(resources.storage.reason)})`,
    resources.battery.state === 'known' ? `battery ${resources.battery.percent}%${resources.battery.charging ? ' charging' : ''}` : `battery unknown (${human(resources.battery.reason)})`,
    resources.thermal.state === 'known' ? `thermal ${resources.thermal.celsius} C` : `thermal unknown (${human(resources.thermal.reason)})`,
  ].join(' · '));
  row('Run journal', report.journal.state === 'ok'
    ? `ok · ${report.journal.unfinished} unfinished · ${report.journal.interrupted} interrupted · last completed ${report.journal.lastCompletedAt ?? 'never'}`
    : human(report.journal.state));
  row('Link', 'not opened by doctor; a running agent\'s link state is in CloudCLI Settings > Remote access');
  row('Result', report.summary.readyForRuns ? 'READY FOR RUNS' : `NOT READY: ${report.summary.blockers.map(human).join(', ')}`);
  if (report.summary.needsDeviceCheck.length > 0) {
    row('Device check', report.summary.needsDeviceCheck.map((id) => CAPABILITY_LABELS[id]).join(', '));
  }
  return lines;
}
