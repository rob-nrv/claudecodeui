// Bounded, on-demand probes for the local RuntimeNode. Each one proves a
// capability by exercising it (running the CLI, checking the workspace root)
// instead of inferring it from the platform name, and each has a hard timeout
// so a hung CLI can never stall a request. Nothing here polls, schedules
// itself, or keeps the machine awake: probes only run when a caller asks.
import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';
import type { RuntimeNodeCapabilityId, RuntimeNodeProbeOutcome } from '@/shared/types.js';
import { WORKSPACES_ROOT } from '@/shared/utils.js';

const CLAUDE_VERSION_TIMEOUT_MS = 8_000;
const GIT_VERSION_TIMEOUT_MS = 5_000;
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;
const SCRIPT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

type RunCommand = (file: string, args: string[], timeoutMs: number) => Promise<string>;

type LocalCapabilityProbeDependencies = {
  runCommand?: RunCommand;
  resolveClaudeExecutable?: () => string;
  workspacesRoot?: string;
  checkWorkspaceRoot?: (directory: string) => Promise<void>;
  nodeExecutablePath?: string;
};

function runCommandWithTimeout(file: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: MAX_COMMAND_OUTPUT_BYTES },
      (error, stdout) => {
        if (error) {
          reject(error);
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

/**
 * Runs one bounded probe cycle on this machine. Consumed by the runtime-nodes
 * service, which stamps and persists the outcomes; dependencies are injectable
 * so tests never depend on a real CLI or workspace.
 */
export async function probeLocalRuntimeCapabilities(
  dependencies: LocalCapabilityProbeDependencies = {},
): Promise<Record<RuntimeNodeCapabilityId, RuntimeNodeProbeOutcome>> {
  const runCommand = dependencies.runCommand ?? runCommandWithTimeout;
  const checkWorkspaceRoot = dependencies.checkWorkspaceRoot ?? checkDirectoryReadWrite;
  const workspacesRoot = dependencies.workspacesRoot ?? WORKSPACES_ROOT;

  let claudeCli: Promise<RuntimeNodeProbeOutcome>;
  try {
    const claudeExecutable = (dependencies.resolveClaudeExecutable ?? (() => resolveClaudeCodeExecutablePath()))();
    // A JS entry point runs through Node, the same way the SDK launches it.
    const isScript = SCRIPT_EXTENSIONS.has(path.extname(claudeExecutable).toLowerCase());
    claudeCli = isScript
      ? proveCommandRuns(runCommand, dependencies.nodeExecutablePath ?? process.execPath, [claudeExecutable, '--version'], CLAUDE_VERSION_TIMEOUT_MS)
      : proveCommandRuns(runCommand, claudeExecutable, ['--version'], CLAUDE_VERSION_TIMEOUT_MS);
  } catch {
    claudeCli = Promise.resolve({ outcome: 'failed', reason: 'executable_not_resolved' });
  }

  const [claudeOutcome, gitOutcome, workspaceOutcome] = await Promise.all([
    claudeCli,
    proveCommandRuns(runCommand, 'git', ['--version'], GIT_VERSION_TIMEOUT_MS),
    checkWorkspaceRoot(workspacesRoot).then(
      (): RuntimeNodeProbeOutcome => ({ outcome: 'proven' }),
      (): RuntimeNodeProbeOutcome => ({ outcome: 'failed', reason: 'workspace_root_inaccessible' }),
    ),
  ]);

  return {
    'claude-cli': claudeOutcome,
    'git-cli': gitOutcome,
    'workspace-filesystem': workspaceOutcome,
    // No probe here can prove that executions survive the app being
    // backgrounded or the device sleeping — that evidence belongs to the
    // Android runtime work (FT-M09). It stays unknown on every platform
    // rather than being guessed from the OS name.
    'background-execution': { outcome: 'not_probed', reason: 'no_probe_available' },
  };
}
