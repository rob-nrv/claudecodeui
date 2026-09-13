import { randomUUID } from 'node:crypto';

import { isCommitHash } from '@/modules/project-workspaces/index.js';
import type { RuntimeNodeLinkService } from '@/modules/runtime-nodes/runtime-node-link.service.js';
import type {
  FetchHistoryResult,
  NormalizedMessage,
  ProviderPendingPermission,
  ProviderPermissionDecision,
  ProviderPermissionOutcomeRecord,
  ProviderPermissionResolution,
  ProviderPermissionScope,
  ProviderRuntimeWriter,
  RuntimeNodeLinkRunOptions,
} from '@/shared/types.js';
import { AppError, createNormalizedMessage } from '@/shared/utils.js';

/**
 * Provider message kinds a node may stream. Gateway kinds (`chat_subscribed`,
 * `session_upserted`, `protocol_error`, ...) are produced only by this server,
 * so a node can never impersonate them to a browser.
 */
const RELAYABLE_MESSAGE_KINDS = new Set([
  'text',
  'tool_use',
  'tool_result',
  'thinking',
  'stream_delta',
  'stream_end',
  'error',
  'complete',
  'status',
  'permission_request',
  'permission_cancelled',
  'permission_resolved',
  'session_created',
  'interactive_prompt',
  'task_notification',
]);

const REJECTION_REASONS = new Set(['already_answered', 'expired', 'cancelled', 'not_found', 'session_mismatch']);
const RUN_FINISH_OUTCOMES = new Set(['completed', 'failed', 'aborted']);
const PROVIDER_SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;
const MAX_RECENT_OUTCOMES_PER_SESSION = 20;
const MAX_TRACKED_OUTCOME_SESSIONS = 200;

type ExecutionState = 'dispatching' | 'running' | 'link_lost' | 'finished';

/** What the chat gateway gets back once a remote run is over. */
export type RemoteRunResult = {
  outcome: 'completed' | 'failed' | 'aborted' | 'rejected';
  code: string | null;
};

type RemoteRunInput = {
  nodeId: string;
  nodeLabel: string;
  appSessionId: string;
  /** Global project identity (FT-M09); the node only ever receives `cwd`, its own verified folder. */
  projectId: string;
  providerSessionId: string | null;
  command: string;
  cwd: string;
  options: RuntimeNodeLinkRunOptions;
  writer: ProviderRuntimeWriter;
  userId: string | number | null;
};

type Execution = {
  executionId: string;
  input: RemoteRunInput;
  state: ExecutionState;
  lastSeq: number;
  ackTimer: NodeJS.Timeout | null;
  graceTimer: NodeJS.Timeout | null;
  pendingApprovals: Map<string, ProviderPendingPermission>;
  cancelWaiters: Array<(aborted: boolean) => void>;
  resolve(result: RemoteRunResult): void;
};

type NotificationPort = {
  runStopped(input: { userId: string | number | null; sessionId: string; sessionName: string | null }): void;
  runFailed(input: { userId: string | number | null; sessionId: string; sessionName: string | null; error: string }): void;
  actionRequired(input: { userId: string | number | null; sessionId: string; sessionName: string | null; toolName: string }): void;
};

const NO_NOTIFICATIONS: NotificationPort = {
  runStopped: () => undefined,
  runFailed: () => undefined,
  actionRequired: () => undefined,
};

const REJECTION_MESSAGES: Record<string, string> = {
  WORKSPACE_UNAVAILABLE: 'The runtime node could not use the mapped project folder. Map the folder again on that node.',
  DUPLICATE_EXECUTION: 'The runtime node refused a duplicate dispatch of this run.',
  SESSION_BUSY: 'The runtime node is already running this session.',
  PROVIDER_UNSUPPORTED: 'The runtime node cannot run this provider.',
  INVALID_REQUEST: 'The runtime node refused the run request.',
  CANCELLED: 'The run was cancelled before it started on the runtime node.',
  RESOURCE_CONCURRENCY_LIMIT: 'The runtime node is already running as many sessions as it allows. The message was not sent, and it was not moved to another node.',
  RESOURCE_STORAGE_LOW: 'The runtime node is low on free storage and refused new runs. The message was not sent, and it was not moved to another node.',
  RESOURCE_BATTERY_LOW: 'The runtime node\'s battery is below its configured floor and it refused new runs. The message was not sent, and it was not moved to another node.',
};

function readString(value: unknown, maxLength: number): string | null {
  return typeof value === 'string' && value.length <= maxLength ? value : null;
}

function sanitizeCode(value: unknown): string {
  return typeof value === 'string' && /^[A-Z_]{1,64}$/.test(value) ? value : 'INVALID_REQUEST';
}

function isFetchHistoryResult(value: unknown): value is FetchHistoryResult {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  return Boolean(
    record
    && Array.isArray(record.messages)
    && typeof record.total === 'number'
    && typeof record.hasMore === 'boolean'
    && typeof record.offset === 'number'
    && (record.limit === null || typeof record.limit === 'number'),
  );
}

/**
 * Runs on remote RuntimeNodes, from the control plane's side (FT-M08).
 *
 * Every run gets a fresh `executionId` and is dispatched exactly once — never
 * re-sent after a reconnect, never redirected to another node. Frames are
 * accepted only from the node that owns the execution and only with a
 * strictly increasing `seq`. A link that drops mid-run gets a bounded grace
 * period to resume; after it the run fails explicitly.
 */
export function createRuntimeNodeRemoteExecutionService(dependencies: {
  link: RuntimeNodeLinkService;
  notifications?: NotificationPort;
  onWorkspaceRejected?(nodeId: string, projectId: string): void;
  ackTimeoutMs?: number;
  reconnectGraceMs?: number;
  cancelTimeoutMs?: number;
  requestTimeoutMs?: number;
}) {
  const { link } = dependencies;
  const notifications = dependencies.notifications ?? NO_NOTIFICATIONS;
  const ackTimeoutMs = dependencies.ackTimeoutMs ?? 10_000;
  const reconnectGraceMs = dependencies.reconnectGraceMs ?? 20_000;
  const cancelTimeoutMs = dependencies.cancelTimeoutMs ?? 8_000;
  const requestTimeoutMs = dependencies.requestTimeoutMs ?? 15_000;

  const executions = new Map<string, Execution>();
  const executionIdBySession = new Map<string, string>();
  const recentOutcomesBySession = new Map<string, ProviderPermissionOutcomeRecord[]>();

  const emitError = (execution: Execution, content: string) => {
    execution.input.writer.send(createNormalizedMessage({
      kind: 'error',
      content,
      sessionId: execution.input.appSessionId,
      provider: 'claude',
    }));
  };

  const recordOutcome = (sessionId: string, outcome: ProviderPermissionOutcomeRecord) => {
    const list = recentOutcomesBySession.get(sessionId) ?? [];
    list.push(outcome);
    recentOutcomesBySession.delete(sessionId);
    recentOutcomesBySession.set(sessionId, list.slice(-MAX_RECENT_OUTCOMES_PER_SESSION));
    while (recentOutcomesBySession.size > MAX_TRACKED_OUTCOME_SESSIONS) {
      const oldest = recentOutcomesBySession.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      recentOutcomesBySession.delete(oldest);
    }
  };

  const finish = (execution: Execution, result: RemoteRunResult) => {
    if (execution.state === 'finished') {
      return;
    }
    execution.state = 'finished';
    if (execution.ackTimer) clearTimeout(execution.ackTimer);
    if (execution.graceTimer) clearTimeout(execution.graceTimer);
    executions.delete(execution.executionId);
    if (executionIdBySession.get(execution.input.appSessionId) === execution.executionId) {
      executionIdBySession.delete(execution.input.appSessionId);
    }
    execution.pendingApprovals.clear();
    // A node may report the aborted end of its run before its cancel answer.
    for (const waiter of execution.cancelWaiters.splice(0)) {
      waiter(result.outcome === 'aborted');
    }
    execution.resolve(result);
  };

  const trackApprovals = (execution: Execution, message: Record<string, unknown>) => {
    const appSessionId = execution.input.appSessionId;
    const requestId = readString(message.requestId, 200);
    if (!requestId) {
      return;
    }
    if (message.kind === 'permission_request') {
      const toolName = readString(message.toolName, 200) ?? 'tool';
      execution.pendingApprovals.set(requestId, {
        requestId,
        sessionId: appSessionId,
        toolName,
        input: message.input,
        receivedAt: new Date().toISOString(),
        expiresAt: readString(message.expiresAt, 64),
        ...(readString(message.toolId, 200) ? { toolId: message.toolId as string } : {}),
      });
      notifications.actionRequired({
        userId: execution.input.userId,
        sessionId: appSessionId,
        sessionName: execution.input.options.sessionSummary ?? null,
        toolName,
      });
      return;
    }
    const pendingApproval = execution.pendingApprovals.get(requestId);
    execution.pendingApprovals.delete(requestId);
    const outcome = message.kind === 'permission_resolved'
      ? 'answered'
      : message.reason === 'timeout' ? 'expired' : 'cancelled';
    recordOutcome(appSessionId, {
      requestId,
      sessionId: appSessionId,
      toolName: pendingApproval?.toolName ?? 'tool',
      outcome,
      settledAt: new Date().toISOString(),
      ...(message.kind === 'permission_resolved' && 'toolInput' in message ? { input: message.toolInput } : {}),
    });
  };

  const acceptSeq = (execution: Execution, seq: unknown): boolean => {
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq <= execution.lastSeq) {
      return false;
    }
    execution.lastSeq = seq;
    return true;
  };

  const markRunning = (execution: Execution) => {
    if (execution.state === 'dispatching') {
      execution.state = 'running';
      if (execution.ackTimer) {
        clearTimeout(execution.ackTimer);
        execution.ackTimer = null;
      }
    }
  };

  link.onNodeFrame((nodeId, frame) => {
    const executionId = typeof frame.executionId === 'string' ? frame.executionId : '';
    const execution = executions.get(executionId);
    // Frames about runs this node does not own are dropped: one node can never
    // write into another node's run.
    if (!execution || execution.input.nodeId !== nodeId || execution.state === 'finished') {
      return;
    }

    switch (frame.type) {
      case 'run.accepted':
        markRunning(execution);
        return;

      case 'run.rejected': {
        const code = sanitizeCode(frame.code);
        emitError(execution, REJECTION_MESSAGES[code] ?? REJECTION_MESSAGES.INVALID_REQUEST);
        if (code === 'WORKSPACE_UNAVAILABLE') {
          dependencies.onWorkspaceRejected?.(nodeId, execution.input.projectId);
        }
        finish(execution, { outcome: 'rejected', code });
        return;
      }

      case 'run.event': {
        if (!acceptSeq(execution, frame.seq)) {
          return;
        }
        markRunning(execution);
        const message = frame.message && typeof frame.message === 'object' && !Array.isArray(frame.message)
          ? frame.message as Record<string, unknown>
          : null;
        if (!message || typeof message.kind !== 'string' || !RELAYABLE_MESSAGE_KINDS.has(message.kind)) {
          return;
        }
        if (message.kind === 'permission_request' || message.kind === 'permission_resolved' || message.kind === 'permission_cancelled') {
          trackApprovals(execution, message);
        }
        if (message.kind === 'complete' && message.aborted !== true && message.exitCode === 0) {
          notifications.runStopped({
            userId: execution.input.userId,
            sessionId: execution.input.appSessionId,
            sessionName: execution.input.options.sessionSummary ?? null,
          });
        }
        // The writer remaps session ids and sequences for the browser; the
        // provider label is this server's, never the node's claim.
        execution.input.writer.send({ ...message, provider: 'claude' } as NormalizedMessage);
        return;
      }

      case 'run.provider_session': {
        if (!acceptSeq(execution, frame.seq)) {
          return;
        }
        markRunning(execution);
        const providerSessionId = readString(frame.providerSessionId, 200);
        if (providerSessionId && PROVIDER_SESSION_ID_PATTERN.test(providerSessionId)) {
          execution.input.writer.setSessionId?.(providerSessionId);
        }
        return;
      }

      case 'run.finished': {
        if (!acceptSeq(execution, frame.seq) || !RUN_FINISH_OUTCOMES.has(String(frame.outcome))) {
          return;
        }
        const outcome = frame.outcome as 'completed' | 'failed' | 'aborted';
        if (outcome === 'failed') {
          notifications.runFailed({
            userId: execution.input.userId,
            sessionId: execution.input.appSessionId,
            sessionName: execution.input.options.sessionSummary ?? null,
            error: `Run failed on ${execution.input.nodeLabel}`,
          });
        }
        finish(execution, { outcome, code: null });
        return;
      }

      case 'run.cancel_result':
        for (const waiter of execution.cancelWaiters.splice(0)) {
          waiter(frame.aborted === true);
        }
        return;

      default:
        return;
    }
  });

  link.onLinkClosed((nodeId) => {
    for (const execution of executions.values()) {
      if (execution.input.nodeId !== nodeId || execution.state === 'finished' || execution.state === 'link_lost') {
        continue;
      }
      execution.state = 'link_lost';
      if (execution.ackTimer) {
        clearTimeout(execution.ackTimer);
        execution.ackTimer = null;
      }
      for (const waiter of execution.cancelWaiters.splice(0)) {
        waiter(false);
      }
      execution.graceTimer = setTimeout(() => {
        emitError(execution, `Lost the connection to ${execution.input.nodeLabel}. The run was stopped there and was not moved to another node.`);
        finish(execution, { outcome: 'failed', code: 'RUNTIME_NODE_DISCONNECTED' });
      }, reconnectGraceMs);
      execution.graceTimer.unref?.();
    }
  });

  link.setResumeResolver((nodeId, active) => {
    const reported = new Set(active.map((entry) => entry.executionId));
    const resume = active.map((entry) => {
      const execution = executions.get(entry.executionId);
      if (!execution || execution.input.nodeId !== nodeId || execution.state === 'finished') {
        return { executionId: entry.executionId, accepted: false, lastSeq: 0 };
      }
      if (execution.graceTimer) {
        clearTimeout(execution.graceTimer);
        execution.graceTimer = null;
      }
      execution.state = execution.state === 'dispatching' ? 'dispatching' : 'running';
      return { executionId: entry.executionId, accepted: true, lastSeq: execution.lastSeq };
    });

    // A node that reconnects without a run it owned has lost it (restart): fail now, not after the grace.
    for (const execution of [...executions.values()]) {
      if (execution.input.nodeId === nodeId && execution.state === 'link_lost' && !reported.has(execution.executionId)) {
        emitError(execution, `${execution.input.nodeLabel} restarted and no longer has this run. It was not moved to another node.`);
        finish(execution, { outcome: 'failed', code: 'RUNTIME_NODE_RESTARTED' });
      }
    }
    return resume;
  });

  return {
    /**
     * Dispatches one run to its bound node and resolves when that run is over.
     * Never throws for run-level failures: they are streamed to the writer and
     * reported in the result.
     */
    run(input: RemoteRunInput): Promise<RemoteRunResult> {
      if (executionIdBySession.has(input.appSessionId)) {
        return Promise.resolve({ outcome: 'rejected', code: 'RUN_IN_PROGRESS' });
      }

      return new Promise<RemoteRunResult>((resolve) => {
        const execution: Execution = {
          executionId: randomUUID(),
          input,
          state: 'dispatching',
          lastSeq: 0,
          ackTimer: null,
          graceTimer: null,
          pendingApprovals: new Map(),
          cancelWaiters: [],
          resolve,
        };

        if (!link.isUsable(input.nodeId)) {
          emitError(execution, `${input.nodeLabel} is offline. The run was not started, and it was not moved to another node.`);
          resolve({ outcome: 'rejected', code: 'RUNTIME_NODE_OFFLINE' });
          return;
        }

        executions.set(execution.executionId, execution);
        executionIdBySession.set(input.appSessionId, execution.executionId);

        const sent = link.send(input.nodeId, {
          type: 'run.start',
          executionId: execution.executionId,
          appSessionId: input.appSessionId,
          provider: 'claude',
          providerSessionId: input.providerSessionId,
          command: input.command,
          cwd: input.cwd,
          options: input.options,
        });
        if (!sent) {
          emitError(execution, `${input.nodeLabel} is offline. The run was not started, and it was not moved to another node.`);
          finish(execution, { outcome: 'rejected', code: 'RUNTIME_NODE_OFFLINE' });
          return;
        }

        execution.ackTimer = setTimeout(() => {
          if (execution.state !== 'dispatching') {
            return;
          }
          // Cancel too, so a start that is merely late can never begin unobserved.
          link.send(input.nodeId, { type: 'run.cancel', executionId: execution.executionId });
          emitError(execution, `${input.nodeLabel} did not acknowledge the run. It was cancelled there and not moved to another node.`);
          finish(execution, { outcome: 'failed', code: 'RUNTIME_NODE_ACK_TIMEOUT' });
        }, ackTimeoutMs);
        execution.ackTimer.unref?.();
      });
    },

    hasActiveRun(appSessionId: string): boolean {
      return executionIdBySession.has(appSessionId);
    },

    /** Cancels the session's remote run. `null` means no remote run exists for the session. */
    async abort(appSessionId: string): Promise<boolean | null> {
      const execution = executions.get(executionIdBySession.get(appSessionId) ?? '');
      if (!execution) {
        return null;
      }
      if (!link.send(execution.input.nodeId, { type: 'run.cancel', executionId: execution.executionId })) {
        return false;
      }
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), cancelTimeoutMs);
        timer.unref?.();
        execution.cancelWaiters.push((aborted) => {
          clearTimeout(timer);
          resolve(aborted);
        });
      });
    },

    /** Relays an approval answer to the node owning it. `null` means no remote run owns this approval id. */
    async resolveToolApproval(
      approvalId: string,
      decision: ProviderPermissionDecision,
      scope: ProviderPermissionScope = {},
    ): Promise<ProviderPermissionResolution | null> {
      const execution = [...executions.values()].find((candidate) => candidate.pendingApprovals.has(approvalId));
      if (!execution) {
        return null;
      }
      if (scope.sessionId && scope.sessionId !== execution.input.appSessionId) {
        return { status: 'rejected', reason: 'session_mismatch' };
      }
      try {
        const answer = await link.request(execution.input.nodeId, {
          type: 'approval.resolve',
          executionId: execution.executionId,
          approvalId,
          decision: {
            allow: decision.allow === true,
            updatedInput: decision.updatedInput,
            message: typeof decision.message === 'string' ? decision.message.slice(0, 4000) : undefined,
            rememberEntry: decision.rememberEntry,
          },
        }, 'approval.result', requestTimeoutMs);
        const resolution = answer.resolution as Record<string, unknown> | undefined;
        if (resolution?.status === 'accepted') {
          return { status: 'accepted' };
        }
        const reason = String(resolution?.reason ?? 'not_found');
        return {
          status: 'rejected',
          reason: (REJECTION_REASONS.has(reason) ? reason : 'not_found') as Extract<ProviderPermissionResolution, { status: 'rejected' }>['reason'],
        };
      } catch {
        return { status: 'rejected', reason: 'cancelled' };
      }
    },

    getPendingApprovals(appSessionId: string): ProviderPendingPermission[] {
      const execution = executions.get(executionIdBySession.get(appSessionId) ?? '');
      return execution ? [...execution.pendingApprovals.values()] : [];
    },

    getRecentPermissionOutcomes(appSessionId: string): ProviderPermissionOutcomeRecord[] {
      return [...(recentOutcomesBySession.get(appSessionId) ?? [])];
    },

    /** Fails every run of a node immediately (revocation), without waiting for any grace. */
    failNodeRuns(nodeId: string, code: string, message: string): void {
      for (const execution of [...executions.values()]) {
        if (execution.input.nodeId === nodeId) {
          emitError(execution, message);
          finish(execution, { outcome: 'failed', code });
        }
      }
    },

    /** Raw, untrusted probe answer: the runtime-nodes service reduces both parts to known shapes. */
    async probe(nodeId: string): Promise<{ outcomes: unknown; resources: unknown }> {
      const answer = await link.request(nodeId, { type: 'probe.request' }, 'probe.result', 20_000);
      return { outcomes: answer.outcomes, resources: answer.resources };
    },

    async verifyWorkspace(nodeId: string, requestedPath: string): Promise<{ ok: boolean; reason: string | null; path: string | null; rootCommits: string[] }> {
      const answer = await link.request(nodeId, { type: 'workspace.verify', path: requestedPath }, 'workspace.result', requestTimeoutMs);
      const reason = typeof answer.reason === 'string' ? answer.reason.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 64) : null;
      const resolvedPath = readString(answer.path, 4096);
      const rootCommits = Array.isArray(answer.rootCommits) ? [...new Set(answer.rootCommits.filter(isCommitHash))].sort().slice(0, 3) : [];
      return answer.ok === true && resolvedPath
        ? { ok: true, reason: null, path: resolvedPath, rootCommits }
        : { ok: false, reason: reason ?? 'workspace_rejected', path: null, rootCommits: [] };
    },

    /**
     * Asks a node to inspect a mapped folder read-only (FT-M09). The
     * observation stays untrusted until the runtime-nodes service parses it.
     */
    async inspectWorkspace(nodeId: string, nodePath: string): Promise<{ ok: true; observation: unknown } | { ok: false; reason: string }> {
      const answer = await link.request(nodeId, { type: 'workspace.inspect', path: nodePath }, 'workspace.state', Math.max(requestTimeoutMs, 45_000));
      if (answer.ok === true) {
        return { ok: true, observation: answer.observation };
      }
      const reason = typeof answer.reason === 'string' ? answer.reason.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 64) : '';
      return { ok: false, reason: reason || 'workspace_rejected' };
    },

    async fetchHistory(nodeId: string, input: {
      appSessionId: string;
      providerSessionId: string;
      cwd: string;
      limit: number | null;
      offset: number;
    }): Promise<FetchHistoryResult> {
      const answer = await link.request(nodeId, { type: 'history.fetch', ...input }, 'history.result', requestTimeoutMs);
      if (answer.ok !== true || !isFetchHistoryResult(answer.result)) {
        throw new AppError('The runtime node could not read this session history.', {
          code: 'RUNTIME_NODE_HISTORY_UNAVAILABLE',
          statusCode: 502,
        });
      }
      return answer.result;
    },
  };
}

export type RuntimeNodeRemoteExecutionService = ReturnType<typeof createRuntimeNodeRemoteExecutionService>;
