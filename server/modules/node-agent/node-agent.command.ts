import { generateKeyPairSync } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import {
  normalizeServerOrigin,
  readNodeAgentCredential,
  resolveNodeAgentHome,
  writeNodeAgentCredential,
} from '@/modules/node-agent/node-agent-credential.store.js';
import { validateNodeWorkspaceRoot } from '@/modules/node-agent/node-agent-workspace.js';

type NodeAgentCliDependencies = {
  environment: Record<string, string | undefined>;
  homeDirectory: string;
  runtimeVersion: string | null;
  log(message: string): void;
  error(message: string): void;
  fetch?: typeof fetch;
};

type ParsedFlags = Record<string, string | boolean>;

const VALUE_FLAGS = new Set(['server', 'code', 'label', 'state-dir', 'workspace-root']);

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
    } else if (name === 'force') {
      flags.force = true;
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
  status   Show this node's identity and control plane

Options:
  --server <https-origin>     Control plane origin (enroll). http is accepted only for this machine.
  --code <XXXX-XXXX-XXXX>     One-time enrollment code (enroll)
  --label <name>              Display name for this node (enroll, optional)
  --workspace-root <folder>   Only folders inside it can be used by runs (start; default WORKSPACES_ROOT or home)
  --state-dir <folder>        Agent state (default CLOUDCLI_NODE_AGENT_HOME or ~/.cloudcli/node-agent)
  --force                     Replace an existing enrollment (enroll)
`;

/**
 * `cloudcli node ...` (FT-M08). Consumed by the CLI module through the
 * node-agent barrel; the running agent is loaded lazily so ordinary CLI
 * commands never pay for the provider runtime graph.
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
    return 0;
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
    const requestedRoot = typeof flags['workspace-root'] === 'string' && flags['workspace-root']
      ? flags['workspace-root']
      : dependencies.environment.WORKSPACES_ROOT || dependencies.homeDirectory;
    const workspaceRoot = await validateNodeWorkspaceRoot(path.resolve(requestedRoot));
    if (!workspaceRoot.ok) {
      dependencies.error(workspaceRoot.error);
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
      runtimeVersion: dependencies.runtimeVersion,
      log: (message) => dependencies.log(`[node] ${message}`),
    });
    return stop.reason === 'stopped' ? 0 : 2;
  }

  dependencies.error(`Unknown node command: ${command}`);
  dependencies.log(HELP);
  return 1;
}
