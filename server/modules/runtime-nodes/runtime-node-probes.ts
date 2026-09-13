// Bounded, on-demand probes for a RuntimeNode. Each one proves a capability by
// exercising it (running the CLI, reading its login state, writing a probe file
// in the workspace root) instead of inferring it from the platform name, and
// each has a hard timeout so a hung CLI can never stall a request. Nothing here
// polls, schedules itself, keeps the machine awake or calls a model: probes
// only run when a caller asks, and a headless run is only ever OBSERVED.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';
import type { RuntimeNodeCapabilityId, RuntimeNodeProbeOutcome } from '@/shared/types.js';
import { WORKSPACES_ROOT } from '@/shared/utils.js';

const CLAUDE_VERSION_TIMEOUT_MS = 8_000;
const CLAUDE_AUTH_TIMEOUT_MS = 10_000;
const GIT_VERSION_TIMEOUT_MS = 5_000;
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;
const SCRIPT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

/** A completed run older than this no longer proves headless execution. */
export const HEADLESS_EVIDENCE_WINDOW_MS = 24 * 60 * 60_000;
/** An observed process suspension disproves background execution for this long. */
export const SUSPENSION_EVIDENCE_WINDOW_MS = 24 * 60 * 60_000;

type RunCommand = (file: string, args: string[], timeoutMs: number) => Promise<string>;

/**
 * Evidence a long-running node agent collects about its own process (FT-M09):
 * when a run last completed on this node, and whether the process was ever
 * suspended (frozen by the OS) while running. The control plane's local node
 * has no observer, so these stay unknown there.
 */
export type RuntimeNodeRunObservations = {
  /** When suspension observation began; null for a one-shot check that observes nothing over time. */
  startedAt: number | null;
  lastCompletedRunAt(): number | null;
  lastSuspension(): { at: number; durationMs: number } | null;
};

type LocalCapabilityProbeDependencies = {
  runCommand?: RunCommand;
  resolveClaudeExecutable?: () => string;
  workspacesRoot?: string;
  checkWorkspaceRoot?: (directory: string) => Promise<void>;
  /** Node agents prove the root writable by creating and removing a probe file; the control plane only checks access. */
  proveWorkspaceWrite?: ((directory: string) => Promise<void>) | null;
  nodeExecutablePath?: string;
  environment?: Record<string, string | undefined>;
  platform?: string;
  arch?: string;
  nodeVersion?: string;
  fileExists?: (file: string) => Promise<boolean>;
  observations?: RuntimeNodeRunObservations | null;
  now?: () => number;
};

function runCommandWithTimeout(file: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: MAX_COMMAND_OUTPUT_BYTES },
      (error, stdout) => {
        if (error) {
          // stdout is kept so a command that reports its answer with a non-zero exit can still be read.
          reject(Object.assign(error, { stdout: String(stdout ?? '') }));
          return;
        }
        resolve(String(stdout));
      },
    );
  });
}

async function checkDirectoryReadWrite(directory: string): Promise<void> {
  const stats = await fs.stat(directory);
  if (!stats.isDirectory()) {
    throw new Error('Workspace root is not a directory.');
  }
  await fs.access(directory, fsConstants.R_OK | fsConstants.W_OK);
}

/**
 * Creates a uniquely named, exclusive probe file in `directory` and removes it.
 * `access()` alone can be answered optimistically inside user-space
 * containers such as proot; only a real write proves the folder is writable.
 */
export async function proveDirectoryWritable(directory: string): Promise<void> {
  const probeFile = path.join(directory, `.cloudcli-write-probe-${randomUUID()}.tmp`);
  const handle = await fs.open(probeFile, 'wx', 0o600);
  try {
    await handle.writeFile('cloudcli');
  } finally {
    await handle.close();
    await fs.unlink(probeFile).catch(() => undefined);
  }
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/** Machine reason only: never the error message, which can embed paths. */
function describeCommandFailure(error: unknown): string {
  const candidate = (error ?? {}) as { code?: unknown; killed?: unknown };
  if (candidate.code === 'ENOENT') {
    return 'executable_not_found';
  }
  if (candidate.killed === true || candidate.code === 'ETIMEDOUT') {
    return 'probe_timeout';
  }
  if (candidate.code === 'EACCES' || candidate.code === 'EPERM') {
    return 'permission_denied';
  }
  return 'command_failed';
}

async function proveCommandRuns(
  runCommand: RunCommand,
  file: string,
  args: string[],
  timeoutMs: number,
): Promise<RuntimeNodeProbeOutcome> {
  try {
    const stdout = await runCommand(file, args, timeoutMs);
    return { outcome: 'proven', detail: stdout };
  } catch (error) {
    return { outcome: 'failed', reason: describeCommandFailure(error) };
  }
}

function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

/**
 * Whether this process runs on an Android host, from evidence only: Node's own
 * platform (`android` for a native Termux build), the variables Android sets
 * for every app process (inherited inside proot distributions), or the
 * system build file. Descriptive — it never grants or denies a capability.
 */
export async function detectAndroidHost(input: {
  platform: string;
  environment: Record<string, string | undefined>;
  fileExists: (file: string) => Promise<boolean>;
}): Promise<boolean> {
  if (input.platform === 'android') {
    return true;
  }
  if (input.platform !== 'linux') {
    return false;
  }
  if (input.environment.ANDROID_ROOT && input.environment.ANDROID_DATA) {
    return true;
  }
  return input.fileExists('/system/build.prop');
}

/** Reads `claude auth status` without ever keeping the account identity. */
function parseAuthStatus(stdout: unknown): { loggedIn: boolean; method: string | null } | null {
  if (typeof stdout !== 'string' || !stdout.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.loggedIn !== 'boolean') {
      return null;
    }
    const method = typeof parsed.authMethod === 'string' && /^[A-Za-z0-9._ -]{1,32}$/.test(parsed.authMethod) ? parsed.authMethod : null;
    return { loggedIn: parsed.loggedIn, method };
  } catch {
    return null;
  }
}

async function probeClaudeAuth(
  runCommand: RunCommand,
  launcher: { file: string; prefix: string[] } | null,
  environment: Record<string, string | undefined>,
): Promise<RuntimeNodeProbeOutcome> {
  if (!launcher) {
    return { outcome: 'not_probed', reason: 'claude_executable_not_resolved' };
  }
  let status: ReturnType<typeof parseAuthStatus>;
  try {
    status = parseAuthStatus(await runCommand(launcher.file, [...launcher.prefix, 'auth', 'status'], CLAUDE_AUTH_TIMEOUT_MS));
  } catch (error) {
    status = parseAuthStatus((error as { stdout?: unknown }).stdout);
    if (!status) {
      return { outcome: 'not_probed', reason: describeCommandFailure(error) === 'probe_timeout' ? 'auth_status_timeout' : 'auth_status_unreadable' };
    }
  }
  if (!status) {
    return { outcome: 'not_probed', reason: 'auth_status_unreadable' };
  }
  if (status.loggedIn) {
    return { outcome: 'proven', detail: status.method ? `signed in (${status.method})` : 'signed in' };
  }
  // Credentials supplied through the environment are not always visible to `auth status`.
  if (environment.ANTHROPIC_API_KEY || environment.CLAUDE_CODE_OAUTH_TOKEN) {
    return { outcome: 'not_probed', reason: 'credentials_from_environment' };
  }
  return { outcome: 'failed', reason: 'not_logged_in' };
}

function probeHeadless(observations: RuntimeNodeRunObservations | null, now: number): RuntimeNodeProbeOutcome {
  if (!observations) {
    return { outcome: 'not_probed', reason: 'no_run_observer' };
  }
  const completedAt = observations.lastCompletedRunAt();
  if (completedAt === null) {
    return { outcome: 'not_probed', reason: 'awaiting_completed_run' };
  }
  const age = now - completedAt;
  if (age < 0 || age > HEADLESS_EVIDENCE_WINDOW_MS) {
    return { outcome: 'not_probed', reason: 'completed_run_too_old', detail: `last completed run ${formatAge(age)} ago` };
  }
  return { outcome: 'proven', detail: `run completed ${formatAge(age)} ago` };
}

function probeBackground(observations: RuntimeNodeRunObservations | null, now: number): RuntimeNodeProbeOutcome {
  if (!observations || observations.startedAt === null) {
    return { outcome: 'not_probed', reason: 'requires_device_verification' };
  }
  const suspension = observations.lastSuspension();
  if (suspension && now - suspension.at <= SUSPENSION_EVIDENCE_WINDOW_MS) {
    return {
      outcome: 'failed',
      reason: 'process_suspension_observed',
      detail: `suspended ${formatAge(suspension.durationMs)} about ${formatAge(now - suspension.at)} ago`,
    };
  }
  // No observed suspension is NOT proof: the process may simply never have been backgrounded.
  return { outcome: 'not_probed', reason: 'requires_device_verification', detail: `no suspension observed in ${formatAge(now - observations.startedAt)}` };
}

/**
 * Runs one bounded probe cycle on this machine. Consumed by the runtime-nodes
 * service (the control plane's own node) and the node agent (answering its
 * control plane); dependencies are injectable so tests never depend on a real
 * CLI or workspace.
 */
export async function probeLocalRuntimeCapabilities(
  dependencies: LocalCapabilityProbeDependencies = {},
): Promise<Record<RuntimeNodeCapabilityId, RuntimeNodeProbeOutcome>> {
  const runCommand = dependencies.runCommand ?? runCommandWithTimeout;
  const checkWorkspaceRoot = dependencies.checkWorkspaceRoot ?? checkDirectoryReadWrite;
  const workspacesRoot = dependencies.workspacesRoot ?? WORKSPACES_ROOT;
  const environment = dependencies.environment ?? process.env;
  const now = (dependencies.now ?? Date.now)();
  const platform = dependencies.platform ?? process.platform;

  let launcher: { file: string; prefix: string[] } | null = null;
  try {
    const claudeExecutable = (dependencies.resolveClaudeExecutable ?? (() => resolveClaudeCodeExecutablePath()))();
    // A JS entry point runs through Node, the same way the SDK launches it.
    launcher = SCRIPT_EXTENSIONS.has(path.extname(claudeExecutable).toLowerCase())
      ? { file: dependencies.nodeExecutablePath ?? process.execPath, prefix: [claudeExecutable] }
      : { file: claudeExecutable, prefix: [] };
  } catch {
    launcher = null;
  }

  const workspaceProbe = async (): Promise<RuntimeNodeProbeOutcome> => {
    try {
      await checkWorkspaceRoot(workspacesRoot);
    } catch {
      return { outcome: 'failed', reason: 'workspace_root_inaccessible' };
    }
    if (!dependencies.proveWorkspaceWrite) {
      return { outcome: 'proven', detail: 'readable and writable (access check)' };
    }
    try {
      await dependencies.proveWorkspaceWrite(workspacesRoot);
      return { outcome: 'proven', detail: 'readable and write verified' };
    } catch {
      return { outcome: 'failed', reason: 'workspace_root_not_writable' };
    }
  };

  const nodeRuntimeProbe = async (): Promise<RuntimeNodeProbeOutcome> => {
    const android = await detectAndroidHost({ platform, environment, fileExists: dependencies.fileExists ?? pathExists }).catch(() => false);
    const version = (dependencies.nodeVersion ?? process.versions.node).replace(/[^0-9.]/g, '');
    return {
      outcome: 'proven',
      detail: `Node ${version} ${platform} ${dependencies.arch ?? process.arch}${android ? ' (Android host)' : ''}`,
    };
  };

  const [nodeOutcome, claudeOutcome, authOutcome, gitOutcome, workspaceOutcome] = await Promise.all([
    nodeRuntimeProbe(),
    launcher
      ? proveCommandRuns(runCommand, launcher.file, [...launcher.prefix, '--version'], CLAUDE_VERSION_TIMEOUT_MS)
      : Promise.resolve<RuntimeNodeProbeOutcome>({ outcome: 'failed', reason: 'executable_not_resolved' }),
    probeClaudeAuth(runCommand, launcher, environment),
    proveCommandRuns(runCommand, 'git', ['--version'], GIT_VERSION_TIMEOUT_MS),
    workspaceProbe(),
  ]);

  const observations = dependencies.observations ?? null;
  return {
    'node-runtime': nodeOutcome,
    'claude-cli': claudeOutcome,
    'claude-auth': authOutcome,
    'claude-headless': probeHeadless(observations, now),
    'git-cli': gitOutcome,
    'workspace-filesystem': workspaceOutcome,
    // Only a person can prove that runs survive the app being backgrounded or
    // the device sleeping; an observed suspension is the one thing a process
    // can prove about itself, and it disproves it.
    'background-execution': probeBackground(observations, now),
  };
}
