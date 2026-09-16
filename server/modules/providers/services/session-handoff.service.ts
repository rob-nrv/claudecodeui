import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

import {
  claudeProfilesDb,
  sessionHandoffsDb,
  sessionsDb,
  type SessionHandoffRow,
} from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import { runtimeNodesService } from '@/modules/runtime-nodes/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import type { ClaudeProfileConnectionState, LLMProvider, NormalizedMessage } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

const execFileAsync = promisify(execFile);

const PROVIDER_LABELS: Record<LLMProvider, string> = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
  opencode: 'OpenCode',
};

const MAX_REQUEST_EXCERPT_CHARS = 800;
const MAX_REPLY_EXCERPT_CHARS = 1500;
const MAX_GIT_STATUS_LINES = 20;
const MAX_TARGET_NAME_CHARS = 120;
const GIT_TIMEOUT_MS = 5000;

/** Connection states under which a Claude account cannot run a new session. */
const UNAVAILABLE_PROFILE_STATES: ReadonlySet<ClaudeProfileConnectionState> = new Set(['expired', 'not_authenticated']);

/**
 * Credential shapes scrubbed from the package before it is persisted. The
 * package never reads auth/config files in the first place; this only guards
 * against a token the user pasted into the conversation being carried along.
 */
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
];

type HandoffGitState = {
  branch: string | null;
  head: string | null;
  changedFileCount: number;
  changedFiles: string[];
  diffSummary: string | null;
};

type SessionRow = NonNullable<ReturnType<typeof sessionsDb.getSessionById>>;

type HandoffTargetInput = {
  provider: LLMProvider;
  /**
   * `undefined` means the caller did not choose. For a Claude target that is
   * refused: the account is always an explicit choice, never a default.
   */
  claudeProfileId?: string | null;
  /**
   * RuntimeNode the new run is bound to. `undefined` is only accepted while a
   * single node exists (see `runtimeNodesService.resolveExecutionTarget`).
   */
  runtimeNodeId?: string;
  note?: string | null;
};

type HandoffTargetUnavailableReason =
  | 'same_as_source'
  | 'profile_expired'
  | 'profile_not_authenticated'
  | 'runtime_unavailable';

type HandoffTargetOption = {
  provider: LLMProvider;
  claudeProfileId: string | null;
  label: string;
  connectionState: ClaudeProfileConnectionState | null;
  available: boolean;
  unavailableReason: HandoffTargetUnavailableReason | null;
};

type HandoffSourceBlockedReason = 'source_running' | 'source_not_started' | 'source_no_workspace';

type HandoffTargetsResult = {
  sourceSessionId: string;
  source: {
    title: string;
    provider: LLMProvider;
    claudeProfileId: string | null;
    label: string;
  };
  blockedReason: HandoffSourceBlockedReason | null;
  targets: HandoffTargetOption[];
};

type CreateHandoffResult = {
  handoffId: string;
  sessionId: string;
  provider: LLMProvider;
  claudeProfileId: string | null;
  projectPath: string;
  sessionName: string;
  sourceSessionId: string;
  taskRootSessionId: string;
  /** The RuntimeNode the new run is permanently bound to. */
  runtimeNodeId: string;
};

type SessionLineageView = {
  sessionId: string;
  taskRootSessionId: string;
  incoming: {
    handoffId: string;
    createdAt: string;
    sourceSessionId: string;
    sourceExists: boolean;
    sourceTitle: string | null;
    sourceProvider: LLMProvider;
    sourceClaudeProfileId: string | null;
    sourceModel: string | null;
    sourceEffort: string | null;
    /** Runtime binding snapshot of the source run; null when it was never recorded. */
    sourceRuntimeNodeId: string | null;
    targetProvider: LLMProvider;
    targetClaudeProfileId: string | null;
    targetRuntimeNodeId: string | null;
    /** True once the target produced its own native session. */
    targetStarted: boolean;
    handoffPackage: string;
  } | null;
  outgoing: Array<{
    handoffId: string;
    createdAt: string;
    targetSessionId: string;
    targetTitle: string | null;
    targetProvider: LLMProvider;
    targetClaudeProfileId: string | null;
    targetRuntimeNodeId: string | null;
    targetStarted: boolean;
  }>;
};

type SessionHandoffServiceDependencies = {
  readGitState?: (projectPath: string) => Promise<HandoffGitState | null>;
  readSourceHistory?: (sessionId: string) => Promise<NormalizedMessage[] | null>;
  isSessionRunning?: (sessionId: string) => boolean;
  hasProviderRuntime?: (provider: LLMProvider) => boolean;
  createId?: () => string;
};

async function readGitStateFromWorkspace(projectPath: string): Promise<HandoffGitState | null> {
  // Read-only inspection: optional locks off so a concurrent git operation in
  // the workspace is never blocked by `git status` refreshing the index.
  const runGit = async (args: string[]): Promise<string> => {
    const { stdout } = await execFileAsync('git', args, {
      cwd: projectPath,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    return stdout;
  };

  try {
    if ((await runGit(['rev-parse', '--is-inside-work-tree'])).trim() !== 'true') {
      return null;
    }
  } catch {
    return null;
  }

  const [branch, head, status, diffSummary] = await Promise.all([
    runGit(['rev-parse', '--abbrev-ref', 'HEAD']).then((value) => value.trim() || null, () => null),
    runGit(['rev-parse', '--short', 'HEAD']).then((value) => value.trim() || null, () => null),
    runGit(['status', '--porcelain=v1']).catch(() => ''),
    runGit(['diff', '--shortstat', 'HEAD']).then((value) => value.trim() || null, () => null),
  ]);
  const statusLines = status.split('\n').filter((line) => line.trim().length > 0);

  return {
    branch,
    head,
    changedFileCount: statusLines.length,
    changedFiles: statusLines.slice(0, MAX_GIT_STATUS_LINES),
    diffSummary,
  };
}

async function readHistoryForPackage(sessionId: string): Promise<NormalizedMessage[] | null> {
  try {
    return (await sessionsService.fetchHistory(sessionId)).messages;
  } catch {
    return null;
  }
}

function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((current, pattern) => current.replace(pattern, '[redacted]'), text);
}

function truncate(text: string, maxChars: number): string {
  const trimmed = text.trim();
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars - 1).trimEnd()}…` : trimmed;
}

function quote(text: string): string {
  return text.split('\n').map((line) => `> ${line}`).join('\n');
}

function sessionTitle(session: Pick<SessionRow, 'custom_name'>): string {
  return session.custom_name?.trim() || 'Untitled Session';
}

function describeExecution(provider: LLMProvider, claudeProfileId: string | null): string {
  if (provider !== 'claude') {
    return PROVIDER_LABELS[provider] ?? provider;
  }
  if (!claudeProfileId) {
    return 'Claude · default account';
  }
  const profile = claudeProfilesDb.getById(claudeProfileId);
  return `Claude · ${profile?.displayName ?? 'removed account'}`;
}

/**
 * Conversational text only: tool traffic, local command echoes and compact
 * summaries are noise for someone picking the task up.
 */
function pickConversationExcerpts(messages: NormalizedMessage[]): {
  originalRequest: string | null;
  latestRequest: string | null;
  latestReply: string | null;
} {
  const conversational = messages.filter((message) =>
    message.kind === 'text'
    && (message.role === 'user' || message.role === 'assistant')
    && typeof message.content === 'string'
    && message.content.trim().length > 0
    && !message.isLocalCommand
    && !message.isLocalCommandStdout
    && !message.isCompactSummary,
  );
  const userMessages = conversational.filter((message) => message.role === 'user');
  const assistantMessages = conversational.filter((message) => message.role === 'assistant');
  const originalRequest = userMessages[0]?.content ?? null;
  const latestRequest = userMessages.length > 1 ? userMessages[userMessages.length - 1].content ?? null : null;

  return {
    originalRequest,
    latestRequest,
    latestReply: assistantMessages[assistantMessages.length - 1]?.content ?? null,
  };
}

function buildHandoffPackage(context: {
  title: string;
  sourceSessionId: string;
  sourceLabel: string;
  targetLabel: string;
  projectPath: string;
  sourceLastActivity: string | null;
  history: NormalizedMessage[] | null;
  git: HandoffGitState | null;
  note: string | null;
}): string {
  const sections: string[] = [
    [
      'Handoff from another CloudCLI session: this is a NEW run.',
      'The previous run is not resumed here and stays unchanged. Only the context below is carried over; no credentials or account data are included.',
    ].join('\n'),
    [
      `Task: ${context.title}`,
      `Previous run: ${context.sourceLabel} (session ${context.sourceSessionId}${context.sourceLastActivity ? `, last active ${context.sourceLastActivity}` : ''})`,
      `This run: ${context.targetLabel}`,
      `Workspace: ${context.projectPath}`,
    ].join('\n'),
  ];

  if (context.history) {
    const excerpts = pickConversationExcerpts(context.history);
    if (excerpts.originalRequest) {
      sections.push(`Original request:\n${quote(truncate(excerpts.originalRequest, MAX_REQUEST_EXCERPT_CHARS))}`);
    }
    if (excerpts.latestRequest) {
      sections.push(`Latest request:\n${quote(truncate(excerpts.latestRequest, MAX_REQUEST_EXCERPT_CHARS))}`);
    }
    if (excerpts.latestReply) {
      sections.push(`Latest reply from the previous run (excerpt):\n${quote(truncate(excerpts.latestReply, MAX_REPLY_EXCERPT_CHARS))}`);
    }
  } else {
    sections.push('Conversation excerpt: unavailable (the previous transcript could not be read).');
  }

  if (context.git) {
    const gitLines = [
      'Git state at handoff:',
      `- Branch: ${context.git.branch ?? 'unknown'}${context.git.head ? ` @ ${context.git.head}` : ''}`,
      `- Uncommitted changes: ${context.git.changedFileCount} file(s)`,
      ...context.git.changedFiles.map((line) => `  ${line}`),
    ];
    if (context.git.changedFileCount > context.git.changedFiles.length) {
      gitLines.push(`  … ${context.git.changedFileCount - context.git.changedFiles.length} more`);
    }
    if (context.git.diffSummary) {
      gitLines.push(`- Diff vs HEAD: ${context.git.diffSummary}`);
    }
    sections.push(gitLines.join('\n'));
  } else {
    sections.push('Git state at handoff: unavailable (not a git repository or git could not run).');
  }

  if (context.note) {
    sections.push(`Notes for this run:\n${context.note}`);
  }

  sections.push('Before changing anything, re-check the workspace (git status, tests): it may have moved since this handoff. Then continue the task.');

  return redactSecrets(sections.join('\n\n'));
}

/**
 * `dependencies` are injectable so tests can pin git/history/run state without
 * a real workspace, transcript or live run. Routes use the default instance.
 */
export function createSessionHandoffService(dependencies: SessionHandoffServiceDependencies = {}) {
  const readGitState = dependencies.readGitState ?? readGitStateFromWorkspace;
  const readSourceHistory = dependencies.readSourceHistory ?? readHistoryForPackage;
  const isSessionRunning = dependencies.isSessionRunning
    ?? ((sessionId: string) => chatRunRegistry.getRun(sessionId)?.status === 'running');
  const hasProviderRuntime = dependencies.hasProviderRuntime
    ?? ((provider: LLMProvider) => {
      try {
        return Boolean(providerRegistry.resolveProvider(provider).runtime);
      } catch {
        return false;
      }
    });
  const createId = dependencies.createId ?? randomUUID;

  const requireSession = (sessionId: string): SessionRow => {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }
    return session;
  };

  const readSourceBlockedReason = (source: SessionRow): HandoffSourceBlockedReason | null => {
    if (isSessionRunning(source.session_id)) {
      return 'source_running';
    }
    if (!source.provider_session_id) {
      return 'source_not_started';
    }
    if (!source.project_path?.trim()) {
      return 'source_no_workspace';
    }
    return null;
  };

  const assertSourceCanHandoff = (source: SessionRow): void => {
    const blockedReason = readSourceBlockedReason(source);
    if (blockedReason === 'source_running') {
      throw new AppError('This session is still running. Wait for it to finish or stop it before handing the task off.', {
        code: 'HANDOFF_SOURCE_RUNNING',
        statusCode: 409,
      });
    }
    if (blockedReason === 'source_not_started') {
      throw new AppError('This session has not produced a conversation yet, so there is nothing to hand off.', {
        code: 'HANDOFF_SOURCE_NOT_STARTED',
        statusCode: 409,
      });
    }
    if (blockedReason === 'source_no_workspace') {
      throw new AppError('This session has no workspace to continue in.', {
        code: 'HANDOFF_SOURCE_NO_WORKSPACE',
        statusCode: 409,
      });
    }
  };

  /**
   * Validates the explicit target and returns the binding the new session
   * will carry. Nothing here ever falls back to a default account/provider.
   */
  const resolveTargetBinding = (source: SessionRow, input: HandoffTargetInput): string | null => {
    if (!hasProviderRuntime(input.provider)) {
      throw new AppError(`Provider "${input.provider}" is not available on this server.`, {
        code: 'HANDOFF_TARGET_PROVIDER_UNAVAILABLE',
        statusCode: 409,
      });
    }

    let targetClaudeProfileId: string | null = null;
    if (input.provider === 'claude') {
      if (input.claudeProfileId === undefined) {
        throw new AppError('Choose which Claude account runs the new session.', {
          code: 'HANDOFF_TARGET_PROFILE_REQUIRED',
          statusCode: 400,
        });
      }
      if (input.claudeProfileId === null) {
        // The un-isolated ~/.claude home is only a real, explicit choice when
        // no isolated accounts exist; otherwise null would be a silent default.
        if (claudeProfilesDb.count() > 0) {
          throw new AppError('Choose which Claude account runs the new session.', {
            code: 'HANDOFF_TARGET_PROFILE_REQUIRED',
            statusCode: 400,
          });
        }
      } else {
        const profile = claudeProfilesDb.getById(input.claudeProfileId);
        if (!profile) {
          throw new AppError('Claude profile not found.', {
            code: 'CLAUDE_PROFILE_NOT_FOUND',
            statusCode: 404,
          });
        }
        if (UNAVAILABLE_PROFILE_STATES.has(profile.connectionState)) {
          throw new AppError(`The Claude account "${profile.displayName}" is not signed in. Reconnect it in Settings first.`, {
            code: 'HANDOFF_TARGET_PROFILE_UNAVAILABLE',
            statusCode: 409,
          });
        }
        targetClaudeProfileId = profile.id;
      }
    } else if (input.claudeProfileId) {
      throw new AppError('Only Claude sessions can be bound to a Claude account.', {
        code: 'HANDOFF_TARGET_PROFILE_INVALID',
        statusCode: 400,
      });
    }

    const sourceProvider = source.provider as LLMProvider;
    const sourceBinding = sourceProvider === 'claude' ? source.claude_profile_id ?? null : null;
    if (sourceProvider === input.provider && sourceBinding === targetClaudeProfileId) {
      throw new AppError('Pick a different account or provider: the new run would be identical to this one.', {
        code: 'HANDOFF_TARGET_UNCHANGED',
        statusCode: 409,
      });
    }

    return targetClaudeProfileId;
  };

  const toIncomingView = (row: SessionHandoffRow): NonNullable<SessionLineageView['incoming']> => {
    const sourceRow = sessionsDb.getSessionById(row.source_session_id);
    const targetRow = sessionsDb.getSessionById(row.target_session_id);
    return {
      handoffId: row.handoff_id,
      createdAt: row.created_at,
      sourceSessionId: row.source_session_id,
      sourceExists: Boolean(sourceRow),
      sourceTitle: sourceRow ? sessionTitle(sourceRow) : row.source_title,
      sourceProvider: row.source_provider as LLMProvider,
      sourceClaudeProfileId: row.source_claude_profile_id,
      sourceModel: row.source_model,
      sourceEffort: row.source_effort,
      sourceRuntimeNodeId: row.source_runtime_node_id,
      targetProvider: row.target_provider as LLMProvider,
      targetClaudeProfileId: row.target_claude_profile_id,
      targetRuntimeNodeId: row.target_runtime_node_id,
      targetStarted: Boolean(targetRow?.provider_session_id),
      handoffPackage: row.handoff_package,
    };
  };

  return {
    /**
     * Lists every explicit target for the handoff dialog, with availability
     * decided here (backend truth) rather than guessed by the client.
     */
    listTargets(sourceSessionId: string): HandoffTargetsResult {
      const source = requireSession(sourceSessionId);
      const sourceProvider = source.provider as LLMProvider;
      const sourceBinding = sourceProvider === 'claude' ? source.claude_profile_id ?? null : null;
      const targets: HandoffTargetOption[] = [];

      const markSameAsSource = (option: HandoffTargetOption): HandoffTargetOption =>
        option.provider === sourceProvider && option.claudeProfileId === sourceBinding
          ? { ...option, available: false, unavailableReason: 'same_as_source' }
          : option;

      const claudeRuntimeAvailable = hasProviderRuntime('claude');
      const profiles = claudeProfilesDb.list();
      if (profiles.length === 0) {
        targets.push(markSameAsSource({
          provider: 'claude',
          claudeProfileId: null,
          label: 'Claude',
          connectionState: null,
          available: claudeRuntimeAvailable,
          unavailableReason: claudeRuntimeAvailable ? null : 'runtime_unavailable',
        }));
      }
      for (const profile of profiles) {
        const unavailableReason: HandoffTargetUnavailableReason | null = !claudeRuntimeAvailable
          ? 'runtime_unavailable'
          : profile.connectionState === 'expired'
            ? 'profile_expired'
            : profile.connectionState === 'not_authenticated'
              ? 'profile_not_authenticated'
              : null;
        targets.push(markSameAsSource({
          provider: 'claude',
          claudeProfileId: profile.id,
          label: `Claude · ${profile.displayName}`,
          connectionState: profile.connectionState,
          available: unavailableReason === null,
          unavailableReason,
        }));
      }

      for (const provider of providerRegistry.listProviders()) {
        if (provider.id === 'claude') {
          continue;
        }
        const runtimeAvailable = hasProviderRuntime(provider.id);
        targets.push(markSameAsSource({
          provider: provider.id,
          claudeProfileId: null,
          label: PROVIDER_LABELS[provider.id] ?? provider.id,
          connectionState: null,
          available: runtimeAvailable,
          unavailableReason: runtimeAvailable ? null : 'runtime_unavailable',
        }));
      }

      return {
        sourceSessionId: source.session_id,
        source: {
          title: sessionTitle(source),
          provider: sourceProvider,
          claudeProfileId: sourceBinding,
          label: describeExecution(sourceProvider, sourceBinding),
        },
        blockedReason: readSourceBlockedReason(source),
        targets,
      };
    },

    /**
     * Continues a Task in a NEW session (Run/Leg) bound to an explicitly
     * chosen provider/account.
     *
     * The source session row is only ever read. The target starts with no
     * native session: its first send creates one under its own binding, so
     * there is no copied transcript and no false native continuity — the
     * portable context travels as the handoff package instead.
     */
    async createHandoff(sourceSessionId: string, input: HandoffTargetInput): Promise<CreateHandoffResult> {
      const source = requireSession(sourceSessionId);
      assertSourceCanHandoff(source);
      const targetClaudeProfileId = resolveTargetBinding(source, input);
      // Resolved before any I/O, like the account: a refused runtime creates nothing.
      const targetRuntimeNodeId = runtimeNodesService.resolveExecutionTarget(input.runtimeNodeId);
      runtimeNodesService.assertNodeCanRun(targetRuntimeNodeId, {
        provider: input.provider,
        claudeProfileId: targetClaudeProfileId,
        projectId: source.project_id,
        projectPath: source.project_path?.trim() ?? '',
      });

      const sourceProvider = source.provider as LLMProvider;
      const sourceBinding = sourceProvider === 'claude' ? source.claude_profile_id ?? null : null;
      const projectPath = source.project_path?.trim() ?? '';
      const title = sessionTitle(source);
      const parentHandoff = sessionHandoffsDb.getByTargetSessionId(source.session_id);
      const taskRootSessionId = parentHandoff?.task_root_session_id ?? source.session_id;

      const [history, git] = await Promise.all([
        readSourceHistory(source.session_id),
        readGitState(projectPath),
      ]);

      // Package building awaited I/O: a run may have started meanwhile.
      assertSourceCanHandoff(source);

      const handoffPackage = buildHandoffPackage({
        title,
        sourceSessionId: source.session_id,
        sourceLabel: describeExecution(sourceProvider, sourceBinding),
        targetLabel: describeExecution(input.provider, targetClaudeProfileId),
        projectPath,
        sourceLastActivity: source.updated_at ?? null,
        history,
        git,
        note: input.note?.trim() || null,
      });

      const handoffId = createId();
      const targetSessionId = createId();
      const sessionName = truncate(`↪ ${title}`, MAX_TARGET_NAME_CHARS);

      sessionHandoffsDb.createTargetSession({
        handoffId,
        targetSessionId,
        targetProvider: input.provider,
        targetClaudeProfileId,
        targetRuntimeNodeId,
        targetName: sessionName,
        projectPath,
        projectId: source.project_id,
        sourceSessionId: source.session_id,
        taskRootSessionId,
        sourceProvider,
        sourceClaudeProfileId: sourceBinding,
        // Snapshot only: the source row itself is never rewritten.
        sourceRuntimeNodeId: source.runtime_node_id ?? null,
        sourceProviderSessionId: source.provider_session_id,
        sourceModel: source.model,
        sourceEffort: source.effort,
        sourceTitle: title,
        handoffPackage,
      });

      return {
        handoffId,
        sessionId: targetSessionId,
        provider: input.provider,
        claudeProfileId: targetClaudeProfileId,
        projectPath,
        sessionName,
        sourceSessionId: source.session_id,
        taskRootSessionId,
        runtimeNodeId: targetRuntimeNodeId,
      };
    },

    /**
     * Returns where a session came from and where it was continued, straight
     * from persisted lineage so it survives reloads, reconnects and restarts.
     */
    getLineage(sessionId: string): SessionLineageView {
      const session = requireSession(sessionId);
      const incomingRow = sessionHandoffsDb.getByTargetSessionId(session.session_id);

      return {
        sessionId: session.session_id,
        taskRootSessionId: incomingRow?.task_root_session_id ?? session.session_id,
        incoming: incomingRow ? toIncomingView(incomingRow) : null,
        outgoing: sessionHandoffsDb.listBySourceSessionId(session.session_id).map((row) => {
          const targetRow = sessionsDb.getSessionById(row.target_session_id);
          return {
            handoffId: row.handoff_id,
            createdAt: row.created_at,
            targetSessionId: row.target_session_id,
            targetTitle: targetRow ? sessionTitle(targetRow) : null,
            targetProvider: row.target_provider as LLMProvider,
            targetClaudeProfileId: row.target_claude_profile_id,
            targetRuntimeNodeId: row.target_runtime_node_id,
            targetStarted: Boolean(targetRow?.provider_session_id),
          };
        }),
      };
    },
  };
}

// sessionHandoffService: used by provider routes for FT-M05 handoff targets, creation and lineage.
export const sessionHandoffService = createSessionHandoffService();
