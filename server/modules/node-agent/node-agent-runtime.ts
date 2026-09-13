// Composition of a running node agent. Loaded only after the agent command has
// pointed DATABASE_PATH at the agent's own database, so nothing here can ever
// open the control plane's database on the same machine.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import type { NodeAgentCredential } from '@/modules/node-agent/node-agent-credential.store.js';
import { createNodeAgentExecutor } from '@/modules/node-agent/node-agent-executor.service.js';
import { createNodeAgentLinkClient, type NodeAgentLinkStop } from '@/modules/node-agent/node-agent-link.client.js';
import { createProviderRuntimeService, sessionsService } from '@/modules/providers/index.js';
import { probeLocalRuntimeCapabilities } from '@/modules/runtime-nodes/index.js';

const MAX_TRANSCRIPT_PROJECT_DIRECTORIES = 20_000;

/** Claude Code's own config home on this node (its own login; nothing is copied here). */
function claudeConfigHome(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/** Finds `<claude home>/projects/<any>/<providerSessionId>.jsonl` without trusting any path from the network. */
async function findTranscript(providerSessionId: string): Promise<string | null> {
  const projectsRoot = path.join(claudeConfigHome(), 'projects');
  let entries: string[];
  try {
    entries = await fs.readdir(projectsRoot);
  } catch {
    return null;
  }
  for (const entry of entries.slice(0, MAX_TRANSCRIPT_PROJECT_DIRECTORIES)) {
    const candidate = path.join(projectsRoot, entry, `${providerSessionId}.jsonl`);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Not in this project directory.
    }
  }
  return null;
}

/**
 * Starts the agent: node-local database, provider runtime, executor and link.
 * Resolves when the link stops for good (revocation, refused credential or an
 * explicit stop).
 */
export async function runNodeAgent(options: {
  credential: NodeAgentCredential;
  linkUrl: string;
  workspaceRoot: string;
  runtimeVersion: string | null;
  log(message: string): void;
}): Promise<NodeAgentLinkStop> {
  await initializeDatabase();

  const providerSessionIds = new Map<string, string>();
  const runtime = createProviderRuntimeService({
    // The control plane's session row is authoritative for the native id; it arrives with each run.
    resolveProviderSessionId: (sessionId) => (sessionId ? providerSessionIds.get(sessionId) ?? null : null),
  });

  let link: ReturnType<typeof createNodeAgentLinkClient> | null = null;
  const executor = createNodeAgentExecutor({
    workspaceRoot: options.workspaceRoot,
    log: options.log,
    send: (frame) => link?.send(frame) ?? false,
    probe: async () => probeLocalRuntimeCapabilities({ workspacesRoot: options.workspaceRoot }),
    runtime: {
      run: (provider, command, runOptions, writer) => {
        const appSessionId = String(runOptions.sessionId);
        const native = writer && 'getSessionId' in writer ? (writer as { getSessionId(): string | null }).getSessionId() : null;
        if (native) {
          providerSessionIds.set(appSessionId, native);
        } else {
          providerSessionIds.delete(appSessionId);
        }
        return runtime.run(provider, command, runOptions, writer);
      },
      abort: (provider, sessionId) => runtime.abort(provider, sessionId),
      resolveToolApproval: (requestId, decision, scope) => runtime.resolveToolApproval(requestId, decision, scope),
    },
    history: {
      recordSession(appSessionId, cwd) {
        if (!sessionsDb.getSessionById(appSessionId)) {
          sessionsDb.createAppSession(appSessionId, 'claude', cwd, undefined, null, null);
        }
      },
      recordProviderSessionId(appSessionId, providerSessionId) {
        providerSessionIds.set(appSessionId, providerSessionId);
        const row = sessionsDb.getSessionById(appSessionId);
        if (row && row.provider_session_id !== providerSessionId) {
          sessionsDb.assignProviderSessionId(appSessionId, providerSessionId);
        }
      },
      async fetchHistory(input) {
        if (!sessionsDb.getSessionById(input.appSessionId)) {
          sessionsDb.createAppSession(input.appSessionId, 'claude', input.cwd, undefined, null, null);
        }
        const row = sessionsDb.getSessionById(input.appSessionId);
        if (row && row.provider_session_id !== input.providerSessionId) {
          sessionsDb.assignProviderSessionId(input.appSessionId, input.providerSessionId);
        }
        const transcript = await findTranscript(input.providerSessionId);
        if (transcript) {
          sessionsDb.setJsonlPath(input.appSessionId, transcript);
        }
        return sessionsService.fetchHistory(input.appSessionId, { limit: input.limit, offset: input.offset });
      },
    },
  });

  link = createNodeAgentLinkClient({
    credential: options.credential,
    linkUrl: options.linkUrl,
    runtimeVersion: options.runtimeVersion,
    platform: process.platform,
    arch: process.arch,
    getActiveExecutions: () => executor.activeExecutions(),
    onWelcome: (frame) => executor.onWelcome(frame.resume),
    onFrame: (frame) => {
      void executor.handleFrame(frame);
    },
    onDisconnected: () => executor.onDisconnected(),
    log: options.log,
  });

  const shutdown = async () => {
    options.log('Stopping: aborting runs on this node.');
    await executor.abortAll('agent stopping');
    link?.stop();
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());

  const stop = await link.start();
  await executor.abortAll(`link stopped (${stop.reason})`);
  return stop;
}
