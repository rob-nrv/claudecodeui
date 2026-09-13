import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  normalizeServerOrigin,
  readNodeAgentCredential,
  resolveNodeAgentHome,
  writeNodeAgentCredential,
} from '@/modules/node-agent/node-agent-credential.store.js';
import type { NodeDoctorDependencies } from '@/modules/node-agent/node-agent-doctor.js';
import {
  DEFAULT_RESOURCE_GOVERNOR_POLICY,
  type ResourceGovernorPolicy,
} from '@/modules/node-agent/node-agent-resource-governor.js';
import { NODE_AGENT_RUN_JOURNAL_FILE, readNodeAgentRunJournalSummary } from '@/modules/node-agent/node-agent-run-journal.js';
import { validateNodeWorkspaceRoot } from '@/modules/node-agent/node-agent-workspace.js';

type NodeAgentCliDependencies = {
  environment: Record<string, string | undefined>;
  homeDirectory: string;
  runtimeVersion: string | null;
  log(message: string): void;
  error(message: string): void;
  fetch?: typeof fetch;
  /** Injected by tests so the doctor never runs a real CLI or network check there. */
  doctor?: NodeDoctorDependencies;
};

type ParsedFlags = Record<string, string | boolean>;

/** Every `cloudcli node` command; the Android/HC-06 docs are tested against this list. */
export const NODE_AGENT_CLI_COMMANDS = ['enroll', 'start', 'status', 'doctor'] as const;

const VALUE_FLAGS = new Set([
  'server',
  'code',
  'label',
  'state-dir',
  'workspace-root',
  'max-concurrent-runs',
  'min-free-storage-mb',
  'min-battery-percent',
  'output',
]);

const BOOLEAN_FLAGS = new Set(['force', 'json', 'no-network']);

/** Every `cloudcli node` flag; the docs are tested against this list. */
export const NODE_AGENT_CLI_FLAGS: readonly string[] = [...VALUE_FLAGS, ...BOOLEAN_FLAGS];

function parseIntegerFlag(value: string | boolean | undefined, name: string, min: number, max: number): { ok: true; value: number | undefined } | { ok: false; error: string } {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value) || Number(value) < min || Number(value) > max) {
    return { ok: false, error: `--${name} must be a whole number from ${min} to ${max}.` };
  }
  return { ok: true, value: Number(value) };
}

/** Resource Governor policy from flags (FT-M09); invalid values are refused, never clamped silently. */
export function parseResourcePolicyFlags(flags: Record<string, string | boolean>): { ok: true; policy: ResourceGovernorPolicy } | { ok: false; error: string } {
  const concurrency = parseIntegerFlag(flags['max-concurrent-runs'], 'max-concurrent-runs', 1, 16);
  const storage = parseIntegerFlag(flags['min-free-storage-mb'], 'min-free-storage-mb', 0, 1_048_576);
  const battery = parseIntegerFlag(flags['min-battery-percent'], 'min-battery-percent', 0, 100);
  for (const parsed of [concurrency, storage, battery]) {
    if (!parsed.ok) {
      return parsed;
    }
  }
  const concurrencyValue = (concurrency as { value: number | undefined }).value;
  const storageValue = (storage as { value: number | undefined }).value;
  const batteryValue = (battery as { value: number | undefined }).value;
  return {
    ok: true,
    policy: {
      maxConcurrentRuns: concurrencyValue ?? DEFAULT_RESOURCE_GOVERNOR_POLICY.maxConcurrentRuns,
      minFreeStorageBytes: storageValue === undefined ? DEFAULT_RESOURCE_GOVERNOR_POLICY.minFreeStorageBytes : storageValue * 1024 * 1024,
      // 0 turns the battery floor off.
      minBatteryPercent: batteryValue === undefined || batteryValue === 0 ? DEFAULT_RESOURCE_GOVERNOR_POLICY.minBatteryPercent : batteryValue,
    },
  };
}

function parseFlags(argumentsList: string[]): { flags: ParsedFlags; unknown: string[] } {
  const flags: ParsedFlags = {};
  const unknown: string[] = [];
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (!argument.startsWith('--')) {
      unknown.push(argument);
      continue;
    }
    const [name, inlineValue] = argument.slice(2).split(/=(.*)/s, 2);
    if (VALUE_FLAGS.has(name)) {
      const value = inlineValue ?? argumentsList[index + 1];
      if (inlineValue === undefined) {
        index += 1;
      }
      flags[name] = value ?? '';
    } else if (BOOLEAN_FLAGS.has(name) && inlineValue === undefined) {
      flags[name] = true;
    } else {
      unknown.push(argument);
    }
  }
  return { flags, unknown };
}

const HELP = `
Usage: cloudcli node <command> [options]

Run this machine as a CloudCLI RuntimeNode. The node connects OUT to its control
plane over wss; it never opens a port. Its Claude login stays on this machine.

Commands:
  enroll   Enroll with a one-time code created in CloudCLI (Settings > Remote access)
  start    Connect to the control plane and execute runs routed to this node
  status   Show this node's identity, control plane and run journal summary
  doctor   Check what this node can prove right now, without opening a link or calling a model

Options:
  --server <https-origin>     Control plane origin (enroll). http is accepted only for this machine.
  --code <XXXX-XXXX-XXXX>     One-time enrollment code (enroll)
  --label <name>              Display name for this node (enroll, optional)
  --workspace-root <folder>   Only folders inside it can be used by runs (start, doctor; default WORKSPACES_ROOT or home)
  --state-dir <folder>        Agent state (default CLOUDCLI_NODE_AGENT_HOME or ~/.cloudcli/node-agent)
  --force                     Replace an existing enrollment (enroll)

Resource governor (start, doctor):
  --max-concurrent-runs <n>   Runs this node accepts at once (1-16, default 2)
  --min-free-storage-mb <n>   Refuse new runs below this free space in the workspace root (default 512, 0 = off)
  --min-battery-percent <n>   Refuse new runs below this battery level while not charging, when the
                              battery can be read (default off). Unknown battery never blocks.

Doctor:
  --json                      Print the evidence record as JSON (no credential, key, code, account or environment value)
  --output <file>             Also write the JSON evidence record to a NEW file (owner-only; never overwrites)
  --no-network                Skip the control plane reachability check (GET /health, no credential sent)
  Exit code: 0 ready for runs, 2 not ready (see Result), 1 usage error.
`;

async function writeEvidenceFile(file: string, content: string): Promise<void> {
  await fs.writeFile(file, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
}

/**
 * `cloudcli node ...` (FT-M08). Consumed by the CLI module through the
 * node-agent barrel; the running agent and the doctor are loaded lazily so
 * ordinary commands never pay for the provider runtime graph.
 */
export async function runNodeAgentCli(argumentsList: string[], dependencies: NodeAgentCliDependencies): Promise<number> {
  const [command, ...rest] = argumentsList;
  const { flags, unknown } = parseFlags(rest);
  if (!command || command === 'help' || command === '--help') {
    dependencies.log(HELP);
    return command ? 0 : 1;
  }
  if (unknown.length > 0) {
    dependencies.error(`Unknown arguments: ${unknown.join(' ')}`);
    return 1;
  }

  const stateDir = resolveNodeAgentHome({
    stateDir: typeof flags['state-dir'] === 'string' ? flags['state-dir'] : undefined,
    env: dependencies.environment,
    homeDirectory: dependencies.homeDirectory,
  });
  const requestedWorkspaceRoot = typeof flags['workspace-root'] === 'string' && flags['workspace-root']
    ? flags['workspace-root']
    : dependencies.environment.WORKSPACES_ROOT || dependencies.homeDirectory;

  if (command === 'status') {
    const credential = await readNodeAgentCredential(stateDir);
    if (!credential) {
      dependencies.log(`Not enrolled (state: ${stateDir}).`);
      return 1;
    }
    dependencies.log(`Node id:        ${credential.nodeId}`);
    dependencies.log(`Control plane:  ${credential.serverOrigin}`);
    dependencies.log(`Enrolled at:    ${credential.enrolledAt}`);
    dependencies.log(`State:          ${stateDir}`);
    const journal = await readNodeAgentRunJournalSummary(path.join(stateDir, NODE_AGENT_RUN_JOURNAL_FILE));
    if (journal.state === 'ok') {
      dependencies.log(`Runs:           ${journal.unfinished} unfinished, ${journal.interrupted} interrupted by an agent stop`);
      dependencies.log(`Last completed: ${journal.lastCompletedAt === null ? 'never' : new Date(journal.lastCompletedAt).toISOString()}`);
    } else {
      dependencies.log(`Run journal:    ${journal.state}`);
    }
    return 0;
  }

  if (command === 'doctor') {
    const resourcePolicy = parseResourcePolicyFlags(flags);
    if (!resourcePolicy.ok) {
      dependencies.error(resourcePolicy.error);
      return 1;
    }
    if (flags.output !== undefined && (typeof flags.output !== 'string' || !flags.output)) {
      dependencies.error('--output needs a file path.');
      return 1;
    }
    // Anything that would open a database lands in the agent's own state, never a control plane database.
    dependencies.environment.DATABASE_PATH = path.join(stateDir, 'agent.db');
    const { formatNodeDoctorReport, runNodeDoctor } = await import('@/modules/node-agent/node-agent-doctor.js');
    const report = await runNodeDoctor({
      stateDir,
      workspaceRoot: requestedWorkspaceRoot,
      runtimeVersion: dependencies.runtimeVersion,
      policy: resourcePolicy.policy,
      checkControlPlane: flags['no-network'] !== true,
    }, dependencies.doctor);
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (flags.json === true) {
      dependencies.log(json.trimEnd());
    } else {
      formatNodeDoctorReport(report).forEach((line) => dependencies.log(line));
    }
    if (typeof flags.output === 'string') {
      const file = path.resolve(flags.output);
      try {
        await writeEvidenceFile(file, json);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        dependencies.error(code === 'EEXIST' ? `${file} already exists; choose a new file name.` : `Could not write ${file} (${code ?? 'error'}).`);
        return 1;
      }
      dependencies.log(`Evidence record written to ${file}`);
    }
    return report.summary.readyForRuns ? 0 : 2;
  }

  if (command === 'enroll') {
    const server = normalizeServerOrigin(flags.server);
    if (!server.ok) {
      dependencies.error(server.error);
      return 1;
    }
    if (typeof flags.code !== 'string' || !flags.code) {
      dependencies.error('An --code from CloudCLI (Settings > Remote access) is required.');
      return 1;
    }
    if (await readNodeAgentCredential(stateDir) && flags.force !== true) {
      dependencies.error(`This machine is already enrolled (state: ${stateDir}). Use --force to replace it.`);
      return 1;
    }

    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const fetchImpl = dependencies.fetch ?? fetch;

    let response: Response;
    try {
      response = await fetchImpl(`${server.origin}/api/runtime-node-link/enroll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: flags.code,
          publicKey: publicKeyPem,
          label: typeof flags.label === 'string' && flags.label ? flags.label : os.hostname(),
          platform: process.platform,
          arch: process.arch,
          runtimeVersion: dependencies.runtimeVersion,
        }),
      });
    } catch (error) {
      dependencies.error(`Could not reach ${server.origin}: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }

    const body = await response.json().catch(() => null) as { data?: { nodeId?: unknown }; error?: { message?: unknown } } | null;
    const nodeId = body?.data?.nodeId;
    if (!response.ok || typeof nodeId !== 'string') {
      const message = typeof body?.error?.message === 'string' ? body.error.message : `HTTP ${response.status}`;
      dependencies.error(`Enrollment refused: ${message}`);
      return 1;
    }

    const file = await writeNodeAgentCredential(stateDir, {
      version: 1,
      serverOrigin: server.origin,
      nodeId,
      privateKeyPem,
      publicKeyPem,
      enrolledAt: new Date().toISOString(),
    });
    dependencies.log(`Enrolled as RuntimeNode ${nodeId}.`);
    dependencies.log(`Credential stored at ${file} (keep it private; it is never sent anywhere).`);
    dependencies.log('Start the node with: cloudcli node start');
    return 0;
  }

  if (command === 'start') {
    const credential = await readNodeAgentCredential(stateDir);
    if (!credential) {
      dependencies.error(`Not enrolled (state: ${stateDir}). Run: cloudcli node enroll --server <origin> --code <code>`);
      return 1;
    }
    const server = normalizeServerOrigin(credential.serverOrigin);
    if (!server.ok) {
      dependencies.error(server.error);
      return 1;
    }
    const workspaceRoot = await validateNodeWorkspaceRoot(path.resolve(requestedWorkspaceRoot));
    if (!workspaceRoot.ok) {
      dependencies.error(workspaceRoot.error);
      return 1;
    }
    const resourcePolicy = parseResourcePolicyFlags(flags);
    if (!resourcePolicy.ok) {
      dependencies.error(resourcePolicy.error);
      return 1;
    }

    // The agent keeps its own database. Set before the runtime graph loads.
    dependencies.environment.DATABASE_PATH = path.join(stateDir, 'agent.db');
    dependencies.log(`RuntimeNode ${credential.nodeId} -> ${credential.serverOrigin}`);
    dependencies.log(`Workspace root: ${workspaceRoot.path}`);

    const { runNodeAgent } = await import('@/modules/node-agent/node-agent-runtime.js');
    const stop = await runNodeAgent({
      credential,
      linkUrl: server.linkUrl,
      workspaceRoot: workspaceRoot.path,
      stateDir,
      resourcePolicy: resourcePolicy.policy,
      runtimeVersion: dependencies.runtimeVersion,
      log: (message) => dependencies.log(`[node] ${message}`),
    });
    return stop.reason === 'stopped' ? 0 : 2;
  }

  dependencies.error(`Unknown node command: ${command}`);
  dependencies.log(HELP);
  return 1;
}
