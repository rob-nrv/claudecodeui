import type { NodeResourceGovernor } from '@/modules/node-agent/node-agent-resource-governor.js';
import type { NodeAgentRunJournal } from '@/modules/node-agent/node-agent-run-journal.js';
import { resolveNodeWorkspacePath, type NodeWorkspaceResolution } from '@/modules/node-agent/node-agent-workspace.js';
import type {
  FetchHistoryResult,
  ProviderPermissionDecision,
  ProviderPermissionResolution,
  ProviderPermissionScope,
  ProviderRuntimeWriter,
  RuntimeNodeLinkNodeFrame,
  RuntimeNodeProbeOutcome,
  RuntimeNodeResourceReport,
} from '@/shared/types.js';

const EXECUTION_ID_PATTERN = /^[0-9a-f-]{36}$/;
const APP_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const PROVIDER_SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;
const MAX_COMMAND_LENGTH = 2_000_000;
const MAX_REMEMBERED_EXECUTION_IDS = 2000;

/** The provider runtime surface the executor drives on this machine. */
export type NodeExecutorRuntime = {
  run(provider: 'claude', command: string, options: Record<string, unknown>, writer: ProviderRuntimeWriter): Promise<unknown>;
  abort(provider: 'claude', sessionId: string): Promise<boolean>;
  resolveToolApproval(requestId: string, decision: ProviderPermissionDecision, scope?: ProviderPermissionScope): ProviderPermissionResolution;
};

/** Node-local bookkeeping so this node can serve the history of runs it executed. */
export type NodeExecutorHistory = {
  recordSession(appSessionId: string, cwd: string): void;
  recordProviderSessionId(appSessionId: string, providerSessionId: string): void;
  fetchHistory(input: {
    appSessionId: string;
    providerSessionId: string;
    cwd: string;
    limit: number | null;
    offset: number;
  }): Promise<FetchHistoryResult>;
};

type FrameWithoutSeq =
  | { type: 'run.event'; executionId: string; message: unknown }
  | { type: 'run.provider_session'; executionId: string; providerSessionId: string }
  | { type: 'run.finished'; executionId: string; outcome: 'completed' | 'failed' | 'aborted' };

type Execution = {
  executionId: string;
  appSessionId: string;
  seq: number;
  /** Frames already emitted, retained so a reconnect can resume without gaps. */
  retained: RuntimeNodeLinkNodeFrame[];
  oldestRetainedSeq: number;
  finished: boolean;
  cancelRequested: boolean;
  failed: boolean;
  graceTimer: NodeJS.Timeout | null;
  retainTimer: NodeJS.Timeout | null;
};

type NodeExecutorDependencies = {
  runtime: NodeExecutorRuntime;
  history: NodeExecutorHistory;
  workspaceRoot: string;
  probe(): Promise<Record<string, RuntimeNodeProbeOutcome>>;
  send(frame: RuntimeNodeLinkNodeFrame): boolean;
  resolveWorkspace?: (workspaceRoot: string, requested: unknown) => Promise<NodeWorkspaceResolution>;
  /** FT-M09 Resource Governor; without one the executor applies no resource limit (tests, legacy callers). */
  governor?: NodeResourceGovernor | null;
  /** FT-M09 persistent run journal: accepted execution ids survive an agent restart. */
  journal?: Pick<NodeAgentRunJournal, 'has' | 'recordStarted' | 'recordFinished'> | null;
  /** FT-M09 read-only inspection of a confined folder; the answer is re-validated by the control plane. */
  inspectWorkspace?: (folder: string) => Promise<unknown>;
  /** FT-M09 repository identity recorded when a folder is mapped. */
  readRootCommits?: (folder: string) => Promise<string[]>;
  /** How long an execution survives a lost link, and how long finished frames are retained for resume. */
  graceMs?: number;
  maxRetainedFrames?: number;
  log?: (message: string) => void;
};

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readBoundedString(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' && value.trim() && value.length <= maxLength ? value : undefined;
}

/**
 * Executes what an authenticated control plane asks of this node (FT-M08).
 *
 * It re-validates everything it receives: an execution id is honoured at most
 * once (also across agent restarts when a journal is present), a session runs
 * at most once at a time, the Resource Governor may refuse a run with an
 * explicit code, the working folder must resolve inside this node's own
 * workspace root, and only whitelisted provider options reach the runtime.
 * When the link drops, runs keep going for a bounded grace; if the control
 * plane does not take them back, they are aborted here so no run continues
 * unobserved.
 */
export function createNodeAgentExecutor(dependencies: NodeExecutorDependencies) {
  // HC-06 repair: this is a last-resort backstop for "the control plane is
  // simply never coming back" (it locally interrupts the SDK session, which
  // is not reversible). The control plane's own reconnectGraceMs, widened for
  // realistic Android reconnect latency, plus its heartbeat-staleness margin,
  // is the authoritative decision for anything shorter — see
  // runtime-node-remote-execution.service.ts. This value must stay well above
  // that combined budget, so the node never gives up first and locally
  // interrupts a session (poisoning it with the SDK's own "user doesn't want
  // to proceed" denial text) while the control plane would still have
  // resumed it.
  const graceMs = dependencies.graceMs ?? 90_000;
  const maxRetainedFrames = dependencies.maxRetainedFrames ?? 2000;
  const resolveWorkspace = dependencies.resolveWorkspace ?? resolveNodeWorkspacePath;
  const log = dependencies.log ?? (() => undefined);
  const governor = dependencies.governor ?? null;
  const journal = dependencies.journal ?? null;

  const executions = new Map<string, Execution>();
  const executionIdBySession = new Map<string, string>();
  const rememberedExecutionIds = new Set<string>();
  const providerSessionIdBySession = new Map<string, string>();
  /** Starts that were cancelled while still being admitted: they never run. */
  const cancelledBeforeAccept = new Set<string>();

  const remember = (executionId: string) => {
    rememberedExecutionIds.add(executionId);
    while (rememberedExecutionIds.size > MAX_REMEMBERED_EXECUTION_IDS) {
      const oldest = rememberedExecutionIds.values().next().value;
      if (oldest === undefined) {
        break;
      }
      rememberedExecutionIds.delete(oldest);
    }
  };

  const emit = (execution: Execution, frame: FrameWithoutSeq) => {
    execution.seq += 1;
    const sequenced = { ...frame, seq: execution.seq } as RuntimeNodeLinkNodeFrame;
    execution.retained.push(sequenced);
    if (execution.retained.length > maxRetainedFrames) {
      execution.retained.shift();
      execution.oldestRetainedSeq += 1;
    }
    dependencies.send(sequenced);
  };

  const dropExecution = (execution: Execution) => {
    if (execution.graceTimer) clearTimeout(execution.graceTimer);
    if (execution.retainTimer) clearTimeout(execution.retainTimer);
    executions.delete(execution.executionId);
  };

  const abortLocally = async (execution: Execution, reason: string) => {
    if (execution.finished) {
      dropExecution(execution);
      return;
    }
    log(`Aborting run ${execution.executionId}: ${reason}`);
    execution.cancelRequested = true;
    try {
      await dependencies.runtime.abort('claude', execution.appSessionId);
    } catch {
      // The run's own completion path still finishes it.
    }
  };

  const reject = (executionId: string, code: string) => {
    dependencies.send({ type: 'run.rejected', executionId, code });
  };

  const startRun = async (frame: Record<string, unknown>) => {
    const executionId = typeof frame.executionId === 'string' && EXECUTION_ID_PATTERN.test(frame.executionId) ? frame.executionId : null;
    if (!executionId) {
      return;
    }
    if (rememberedExecutionIds.has(executionId) || journal?.has(executionId)) {
      // A replayed or duplicated dispatch is never executed twice, even after this agent restarted.
      reject(executionId, 'DUPLICATE_EXECUTION');
      return;
    }
    remember(executionId);

    const appSessionId = typeof frame.appSessionId === 'string' && APP_SESSION_ID_PATTERN.test(frame.appSessionId) ? frame.appSessionId : null;
    const providerSessionId = frame.providerSessionId === null
      ? null
      : typeof frame.providerSessionId === 'string' && PROVIDER_SESSION_ID_PATTERN.test(frame.providerSessionId) ? frame.providerSessionId : undefined;
    const command = typeof frame.command === 'string' && frame.command.length <= MAX_COMMAND_LENGTH ? frame.command : null;
    const options = readRecord(frame.options) ?? {};
    if (frame.provider !== 'claude') {
      reject(executionId, 'PROVIDER_UNSUPPORTED');
      return;
    }
    if (!appSessionId || providerSessionId === undefined || command === null) {
      reject(executionId, 'INVALID_REQUEST');
      return;
    }
    if (executionIdBySession.has(appSessionId)) {
      reject(executionId, 'SESSION_BUSY');
      return;
    }
    if (governor && executionIdBySession.size >= governor.policy.maxConcurrentRuns) {
      reject(executionId, 'RESOURCE_CONCURRENCY_LIMIT');
      return;
    }

    // Reserve the session (and a concurrency slot) before any await so two starts can never interleave.
    executionIdBySession.set(appSessionId, executionId);
    const release = (code: string) => {
      if (executionIdBySession.get(appSessionId) === executionId) {
        executionIdBySession.delete(appSessionId);
      }
      cancelledBeforeAccept.delete(executionId);
      reject(executionId, code);
    };

    const workspace = await resolveWorkspace(dependencies.workspaceRoot, frame.cwd);
    if (!workspace.ok) {
      release('WORKSPACE_UNAVAILABLE');
      return;
    }
    if (governor) {
      let refusal: string | null;
      try {
        refusal = await governor.admitSignals(executionIdBySession.size - 1);
      } catch {
        // A signal that cannot be read is unknown, and unknown never blocks.
        refusal = null;
      }
      if (refusal) {
        log(`Run ${executionId} refused by the resource governor: ${refusal}`);
        release(refusal);
        return;
      }
    }
    if (cancelledBeforeAccept.has(executionId)) {
      release('CANCELLED');
      return;
    }
    await journal?.recordStarted(executionId, appSessionId);
    if (cancelledBeforeAccept.has(executionId)) {
      // Cancelled during the journal write: it never runs, and the journal records how it ended.
      void journal?.recordFinished(executionId, 'aborted');
      release('CANCELLED');
      return;
    }

    const execution: Execution = {
      executionId,
      appSessionId,
      seq: 0,
      retained: [],
      oldestRetainedSeq: 1,
      finished: false,
      cancelRequested: false,
      failed: false,
      graceTimer: null,
      retainTimer: null,
    };
    executions.set(executionId, execution);
    dependencies.send({ type: 'run.accepted', executionId });
    log(`Run ${executionId} accepted for session ${appSessionId}`);

    const captureProviderSessionId = (id: unknown) => {
      if (typeof id !== 'string' || !PROVIDER_SESSION_ID_PATTERN.test(id) || providerSessionIdBySession.get(appSessionId) === id) {
        return;
      }
      providerSessionIdBySession.set(appSessionId, id);
      try {
        dependencies.history.recordProviderSessionId(appSessionId, id);
      } catch {
        // History bookkeeping never interrupts a run.
      }
      emit(execution, { type: 'run.provider_session', executionId, providerSessionId: id });
    };

    if (providerSessionId) {
      providerSessionIdBySession.set(appSessionId, providerSessionId);
    } else {
      providerSessionIdBySession.delete(appSessionId);
    }
    try {
      dependencies.history.recordSession(appSessionId, workspace.path);
      if (providerSessionId) {
        dependencies.history.recordProviderSessionId(appSessionId, providerSessionId);
      }
    } catch {
      // History bookkeeping never prevents a run.
    }

    const writer: ProviderRuntimeWriter & { getSessionId(): string | null; updateWebSocket(): void } = {
      userId: null,
      isWebSocketWriter: true,
      send(data: unknown) {
        const message = readRecord(data);
        if (!message || typeof message.kind !== 'string') {
          return;
        }
        if (message.kind === 'session_created') {
          captureProviderSessionId(typeof message.newSessionId === 'string' && message.newSessionId ? message.newSessionId : message.sessionId);
          return;
        }
        if (message.kind === 'error' || (message.kind === 'complete' && message.exitCode !== 0 && message.aborted !== true)) {
          execution.failed = true;
        }
        emit(execution, { type: 'run.event', executionId, message });
      },
      setSessionId(id: string) {
        captureProviderSessionId(id);
      },
      getSessionId() {
        return providerSessionIdBySession.get(appSessionId) ?? null;
      },
      updateWebSocket() {
        // Streaming goes through the link; nothing to swap.
      },
    };

    const runtimeOptions: Record<string, unknown> = {
      sessionId: appSessionId,
      cwd: workspace.path,
      projectPath: workspace.path,
      model: readBoundedString(options.model, 200),
      effort: readBoundedString(options.effort, 32),
      permissionMode: readBoundedString(options.permissionMode, 32),
      toolsSettings: readRecord(options.toolsSettings) ?? undefined,
      sessionSummary: readBoundedString(options.sessionSummary, 200),
    };

    try {
      await dependencies.runtime.run('claude', command, runtimeOptions, writer);
    } catch (error) {
      execution.failed = true;
      log(`Run ${executionId} failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      execution.finished = true;
      if (executionIdBySession.get(appSessionId) === executionId) {
        executionIdBySession.delete(appSessionId);
      }
      const outcome = execution.cancelRequested ? 'aborted' : execution.failed ? 'failed' : 'completed';
      void journal?.recordFinished(executionId, outcome);
      emit(execution, { type: 'run.finished', executionId, outcome });
      log(`Run ${executionId} finished (${outcome})`);
      // Kept briefly so a control plane reconnecting right now still receives the end of the run.
      execution.retainTimer = setTimeout(() => dropExecution(execution), graceMs);
      execution.retainTimer.unref?.();
    }
  };

  return {
    /**
     * Executions a reconnecting node reports in its hello: accepted runs, and
     * runs still being admitted (lastSeq 0), so the control plane can take
     * those back too instead of never hearing about them.
     */
    activeExecutions(): Array<{ executionId: string; lastSeq: number }> {
      const accepted = [...executions.values()].map((execution) => ({ executionId: execution.executionId, lastSeq: execution.seq }));
      const admitting = [...executionIdBySession.values()]
        .filter((executionId) => !executions.has(executionId))
        .map((executionId) => ({ executionId, lastSeq: 0 }));
      return [...accepted, ...admitting];
    },

    /** Runs holding a concurrency slot right now (admitting or running). */
    activeRunCount(): number {
      return executionIdBySession.size;
    },

    /** The link dropped: every live run gets a bounded grace, then is aborted here. */
    onDisconnected(): void {
      for (const execution of executions.values()) {
        if (execution.finished || execution.graceTimer) {
          continue;
        }
        execution.graceTimer = setTimeout(() => {
          execution.graceTimer = null;
          void abortLocally(execution, 'control plane did not reconnect');
        }, graceMs);
        execution.graceTimer.unref?.();
      }
    },

    /** Applies the control plane's answer to this node's hello. */
    onWelcome(resume: unknown): void {
      const answers = Array.isArray(resume) ? resume : [];
      const answered = new Set<string>();
      for (const entry of answers) {
        const record = readRecord(entry);
        const execution = record && typeof record.executionId === 'string' ? executions.get(record.executionId) : undefined;
        if (!record || !execution) {
          continue;
        }
        answered.add(execution.executionId);
        if (execution.graceTimer) {
          clearTimeout(execution.graceTimer);
          execution.graceTimer = null;
        }
        const lastSeq = typeof record.lastSeq === 'number' && Number.isInteger(record.lastSeq) ? record.lastSeq : 0;
        if (record.accepted !== true || lastSeq + 1 < execution.oldestRetainedSeq) {
          // Not taken back, or frames it missed are gone: stop rather than continue unobserved.
          void abortLocally(execution, record.accepted === true ? 'resume gap' : 'control plane no longer tracks it');
          continue;
        }
        for (const frame of execution.retained) {
          if ((frame as { seq?: number }).seq !== undefined && (frame as { seq: number }).seq > lastSeq) {
            dependencies.send(frame);
          }
        }
      }
      for (const execution of executions.values()) {
        if (!answered.has(execution.executionId)) {
          void abortLocally(execution, 'not resumed');
        }
      }
      const takenBack = new Set(
        answers
          .map(readRecord)
          .filter((record): record is Record<string, unknown> => Boolean(record && record.accepted === true && typeof record.executionId === 'string'))
          .map((record) => record.executionId as string),
      );
      for (const executionId of executionIdBySession.values()) {
        if (!executions.has(executionId) && !takenBack.has(executionId)) {
          // Still being admitted when the link dropped, and not taken back: it must never start unobserved.
          cancelledBeforeAccept.add(executionId);
        }
      }
    },

    /** Handles one frame from the control plane (after the welcome). */
    async handleFrame(frame: Record<string, unknown>): Promise<void> {
      switch (frame.type) {
        case 'probe.request': {
          if (typeof frame.requestId !== 'string') return;
          let outcomes: Record<string, RuntimeNodeProbeOutcome> = {};
          try {
            outcomes = await dependencies.probe();
          } catch {
            outcomes = {};
          }
          let resources: RuntimeNodeResourceReport | null = null;
          try {
            resources = governor ? await governor.report(executionIdBySession.size) : null;
          } catch {
            resources = null;
          }
          dependencies.send({ type: 'probe.result', requestId: frame.requestId, outcomes, resources });
          return;
        }

        case 'workspace.verify': {
          if (typeof frame.requestId !== 'string') return;
          const resolution = await resolveWorkspace(dependencies.workspaceRoot, frame.path);
          if (!resolution.ok) {
            dependencies.send({ type: 'workspace.result', requestId: frame.requestId, ok: false, reason: resolution.reason, path: null });
            return;
          }
          let rootCommits: string[] = [];
          try {
            rootCommits = dependencies.readRootCommits ? await dependencies.readRootCommits(resolution.path) : [];
          } catch {
            rootCommits = [];
          }
          dependencies.send({ type: 'workspace.result', requestId: frame.requestId, ok: true, reason: null, path: resolution.path, rootCommits });
          return;
        }

        case 'workspace.inspect': {
          if (typeof frame.requestId !== 'string') return;
          const resolution = await resolveWorkspace(dependencies.workspaceRoot, frame.path);
          if (!resolution.ok || !dependencies.inspectWorkspace) {
            dependencies.send({
              type: 'workspace.state',
              requestId: frame.requestId,
              ok: false,
              reason: resolution.ok ? 'inspection_unsupported' : resolution.reason,
              observation: null,
            });
            return;
          }
          try {
            const observation = await dependencies.inspectWorkspace(resolution.path);
            dependencies.send({ type: 'workspace.state', requestId: frame.requestId, ok: true, reason: null, observation });
          } catch {
            dependencies.send({ type: 'workspace.state', requestId: frame.requestId, ok: false, reason: 'inspection_failed', observation: null });
          }
          return;
        }

        case 'run.start':
          await startRun(frame);
          return;

        case 'run.cancel': {
          if (typeof frame.executionId !== 'string' || !EXECUTION_ID_PATTERN.test(frame.executionId)) return;
          // A cancel for a start not seen yet still burns the id: a late start can never run.
          remember(frame.executionId);
          const execution = executions.get(frame.executionId);
          if (!execution || execution.finished) {
            if (!execution && [...executionIdBySession.values()].includes(frame.executionId)) {
              // The start is still being admitted: it will be refused instead of running.
              cancelledBeforeAccept.add(frame.executionId);
            }
            dependencies.send({ type: 'run.cancel_result', executionId: frame.executionId, aborted: false });
            return;
          }
          execution.cancelRequested = true;
          let aborted = false;
          try {
            aborted = await dependencies.runtime.abort('claude', execution.appSessionId);
          } catch {
            aborted = false;
          }
          dependencies.send({ type: 'run.cancel_result', executionId: frame.executionId, aborted });
          return;
        }

        case 'approval.resolve': {
          if (typeof frame.requestId !== 'string') return;
          const execution = typeof frame.executionId === 'string' ? executions.get(frame.executionId) : undefined;
          const decision = readRecord(frame.decision);
          const approvalId = typeof frame.approvalId === 'string' ? frame.approvalId : '';
          const resolution: ProviderPermissionResolution = execution && !execution.finished && decision && approvalId
            ? dependencies.runtime.resolveToolApproval(approvalId, {
              allow: decision.allow === true,
              updatedInput: decision.updatedInput,
              message: typeof decision.message === 'string' ? decision.message : undefined,
              rememberEntry: decision.rememberEntry,
            }, { sessionId: execution.appSessionId })
            : { status: 'rejected', reason: 'not_found' };
          dependencies.send({ type: 'approval.result', requestId: frame.requestId, resolution });
          return;
        }

        case 'history.fetch': {
          if (typeof frame.requestId !== 'string') return;
          const appSessionId = typeof frame.appSessionId === 'string' && APP_SESSION_ID_PATTERN.test(frame.appSessionId) ? frame.appSessionId : null;
          const providerSessionId = typeof frame.providerSessionId === 'string' && PROVIDER_SESSION_ID_PATTERN.test(frame.providerSessionId) ? frame.providerSessionId : null;
          const workspace = await resolveWorkspace(dependencies.workspaceRoot, frame.cwd);
          if (!appSessionId || !providerSessionId || !workspace.ok) {
            dependencies.send({ type: 'history.result', requestId: frame.requestId, ok: false, code: 'HISTORY_UNAVAILABLE' });
            return;
          }
          try {
            const result = await dependencies.history.fetchHistory({
              appSessionId,
              providerSessionId,
              cwd: workspace.path,
              limit: typeof frame.limit === 'number' && Number.isInteger(frame.limit) && frame.limit > 0 ? Math.min(frame.limit, 500) : null,
              offset: typeof frame.offset === 'number' && Number.isInteger(frame.offset) && frame.offset >= 0 ? frame.offset : 0,
            });
            dependencies.send({ type: 'history.result', requestId: frame.requestId, ok: true, result });
          } catch {
            dependencies.send({ type: 'history.result', requestId: frame.requestId, ok: false, code: 'HISTORY_UNAVAILABLE' });
          }
          return;
        }

        default:
          return;
      }
    },

    /** Aborts every live run (agent shutdown). */
    async abortAll(reason: string): Promise<void> {
      await Promise.all([...executions.values()].map((execution) => abortLocally(execution, reason)));
    },
  };
}

export type NodeAgentExecutor = ReturnType<typeof createNodeAgentExecutor>;
