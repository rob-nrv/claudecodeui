import path from 'node:path';

import type { WebSocket } from 'ws';

import { claudeProfilesDb, sessionsDb } from '@/modules/database/index.js';
import { providerModelsService } from '@/modules/providers/index.js';
import { runtimeNodesService } from '@/modules/runtime-nodes/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients, WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import {
  getGlobalImageAssetsDir,
  isImageAttachmentDescriptor,
  normalizeAttachmentDescriptors,
  type ChatAttachmentDescriptor,
} from '@/shared/image-attachments.js';
import type {
  AnyRecord,
  AuthenticatedWebSocketRequest,
  LLMProvider,
  ProviderPermissionDecision,
  ProviderPermissionResolution,
  ProviderPermissionScope,
  ProviderRuntimeWriter,
  RuntimeNodeLinkRunOptions,
} from '@/shared/types.js';
import { parseIncomingJsonObject } from '@/shared/utils.js';

/**
 * Trust boundary for client-supplied image attachments: chat.send options come
 * straight from the browser, and the provider runtimes read the referenced
 * files off disk (Claude base64-encodes them into the prompt). Only images
 * that live directly inside the global upload store (`~/.cloudcli/assets`,
 * where POST /api/assets/images puts them) are allowed through — anything
 * else (absolute paths elsewhere, traversal, subdirectories) is dropped.
 *
 * Exported for tests; `assetsRootOverride` exists only for them.
 */
export function filterAttachmentsToUploadStore(
  attachments: unknown,
  assetsRootOverride?: string,
): ChatAttachmentDescriptor[] {
  const assetsRoot = path.resolve(assetsRootOverride ?? getGlobalImageAssetsDir());

  return normalizeAttachmentDescriptors(attachments).filter((descriptor) => {
    // Relative paths are anchored in the store; absolute ones must already be in it.
    const resolved = path.resolve(assetsRoot, descriptor.path);
    const relative = path.relative(assetsRoot, resolved);
    const isDirectChild =
      relative.length > 0 &&
      !relative.startsWith('..') &&
      !path.isAbsolute(relative) &&
      !relative.includes(path.sep) &&
      !relative.includes('/');

    if (!isDirectChild) {
      console.warn(`[Chat] Dropping attachment outside the upload store: ${descriptor.path}`);
    }
    return isDirectChild;
  });
}

/** Backward-compatible image filter consumed by existing websocket tests. */
export function filterImagesToUploadStore(
  images: unknown,
  assetsRootOverride?: string,
): ChatAttachmentDescriptor[] {
  return filterAttachmentsToUploadStore(images, assetsRootOverride);
}

/** Application boundary for dispatching provider runs and approvals. */
type ProviderRuntimeGateway = {
  hasRuntime(provider: string): boolean;
  run(
    provider: LLMProvider,
    command: string,
    options: AnyRecord,
    writer: ProviderRuntimeWriter,
  ): Promise<unknown>;
  abort(provider: LLMProvider, sessionId: string): Promise<boolean>;
  resolveToolApproval(
    requestId: string,
    payload: ProviderPermissionDecision,
    scope?: ProviderPermissionScope,
  ): ProviderPermissionResolution;
  getPendingApprovalsForSession(sessionId: string): unknown[];
  getRecentPermissionOutcomesForSession(sessionId: string): unknown[];
};

/**
 * RuntimeNode routing (FT-M08): where a bound session executes, and the
 * control plane's handle on runs executing on remote nodes.
 */
type RuntimeNodeRouting = {
  resolveSessionExecution: typeof runtimeNodesService.resolveSessionExecution;
  remoteExecution: Pick<
    typeof runtimeNodesService.remoteExecution,
    'run' | 'abort' | 'resolveToolApproval' | 'getPendingApprovals' | 'getRecentPermissionOutcomes'
  >;
};

type ChatWebSocketDependencies = {
  /** Central dispatcher for every provider SDK/CLI runtime on this machine. */
  runtime: ProviderRuntimeGateway;
  /** Defaults to the runtime-nodes module; injectable for routing tests. */
  runtimeNodes?: RuntimeNodeRouting;
};

const MAX_REMOTE_OPTION_STRING = 200;

/**
 * Extracts the authenticated request user id in the formats currently produced
 * by platform and OSS auth code paths.
 */
function readRequestUserId(
  request: AuthenticatedWebSocketRequest | undefined
): string | number | null {
  const user = request?.user;
  if (!user) {
    return null;
  }

  if (typeof user.id === 'string' || typeof user.id === 'number') {
    return user.id;
  }

  if (typeof user.userId === 'string' || typeof user.userId === 'number') {
    return user.userId;
  }

  return null;
}

function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WS_OPEN_STATE) {
    ws.send(JSON.stringify(payload));
  }
}

/**
 * Reports a protocol-level failure to the requesting client.
 *
 * Protocol errors deliberately use their own `kind` (instead of the provider
 * `error` message kind) so the frontend can distinguish "your request was
 * invalid" from "the model run produced an error" without inspecting text.
 */
function sendProtocolError(
  ws: WebSocket,
  code: string,
  error: string,
  sessionId?: string,
  extra: AnyRecord = {},
): void {
  sendJson(ws, {
    kind: 'protocol_error',
    code,
    error,
    sessionId: sessionId ?? null,
    timestamp: new Date().toISOString(),
    ...extra,
  });
}

function readRequiredSessionId(data: AnyRecord): string | null {
  const sessionId = typeof data.sessionId === 'string' ? data.sessionId.trim() : '';
  return sessionId.length > 0 ? sessionId : null;
}

function readBoundedString(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' && value.trim() && value.length <= maxLength ? value : undefined;
}

/**
 * The only client options forwarded to a remote node: nothing path-like, no
 * account and no attachment reference ever leaves this server.
 */
function pickRemoteRunOptions(options: AnyRecord): RuntimeNodeLinkRunOptions {
  const toolsSettings = options.toolsSettings && typeof options.toolsSettings === 'object' && !Array.isArray(options.toolsSettings)
    && JSON.stringify(options.toolsSettings).length <= 64_000
    ? options.toolsSettings
    : undefined;
  return {
    model: readBoundedString(options.model, MAX_REMOTE_OPTION_STRING),
    effort: readBoundedString(options.effort, 32),
    permissionMode: readBoundedString(options.permissionMode, 32),
    toolsSettings,
    sessionSummary: readBoundedString(options.sessionSummary, MAX_REMOTE_OPTION_STRING),
  };
}

/**
 * Handles `chat.send`: resolves the session row (provider, project path, node
 * binding and provider-native id all come from the database — never from the
 * client), registers the run, and dispatches to the provider runtime on this
 * machine or on the session's own RuntimeNode.
 */
async function handleChatSend(
  ws: WebSocket,
  userId: string | number | null,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): Promise<void> {
  const routing = dependencies.runtimeNodes ?? runtimeNodesService;
  const sessionId = readRequiredSessionId(data);
  if (!sessionId) {
    sendProtocolError(ws, 'SESSION_ID_REQUIRED', 'chat.send requires a sessionId.');
    return;
  }

  const session = sessionsDb.getSessionById(sessionId);
  if (!session) {
    sendProtocolError(
      ws,
      'SESSION_NOT_FOUND',
      `Session "${sessionId}" was not found. Create it via POST /api/providers/sessions first.`,
      sessionId
    );
    return;
  }

  const provider = session.provider as LLMProvider;
  if (!dependencies.runtime.hasRuntime(provider)) {
    sendProtocolError(ws, 'UNSUPPORTED_PROVIDER', `Provider "${provider}" is not available.`, sessionId);
    return;
  }

  // The Claude account this session is bound to is read from the session
  // row only, never from the client (CLOUDCLI_EXTENSION_PLAN.md F5). A bound
  // session whose profile has since been removed must halt here rather than
  // silently falling back to the legacy/default account — that would risk
  // running a Work session under a Personal account or vice versa.
  let claudeProfileId: string | null = null;
  if (session.claude_profile_id) {
    if (!claudeProfilesDb.getById(session.claude_profile_id)) {
      sendProtocolError(
        ws,
        'CLAUDE_PROFILE_UNAVAILABLE',
        'The Claude account this session is bound to is no longer available.',
        sessionId
      );
      return;
    }
    claudeProfileId = session.claude_profile_id;
  }

  // A session bound to a RuntimeNode only ever executes on that node. An
  // unusable bound node halts here with the reason and the nodes the user may
  // choose explicitly (by a handoff) — nothing is ever substituted. Legacy
  // (never recorded) bindings keep running locally exactly as before.
  const target = routing.resolveSessionExecution(session);
  if (target.kind === 'refused') {
    sendProtocolError(ws, target.code, target.message, sessionId, { alternatives: target.alternatives });
    return;
  }

  const clientOptions = (data.options ?? {}) as AnyRecord;
  const command = typeof data.content === 'string' ? data.content : '';

  const attachmentCandidates = [
    ...normalizeAttachmentDescriptors(clientOptions.images),
    ...normalizeAttachmentDescriptors(clientOptions.files),
    ...normalizeAttachmentDescriptors(clientOptions.attachments),
  ];
  if (target.kind === 'remote' && attachmentCandidates.length > 0) {
    // Uploaded files live on this server's disk; a remote node cannot read them.
    sendProtocolError(
      ws,
      'RUNTIME_NODE_ATTACHMENTS_UNSUPPORTED',
      `Attachments cannot be sent to "${target.nodeLabel}" yet. Send the message without attachments.`,
      sessionId,
    );
    return;
  }

  const run = chatRunRegistry.startRun({
    appSessionId: sessionId,
    provider,
    providerSessionId: session.provider_session_id,
    connection: ws,
    userId,
  });

  if (!run) {
    sendProtocolError(
      ws,
      'RUN_IN_PROGRESS',
      `Session "${sessionId}" already has a run in progress.`,
      sessionId
    );
    return;
  }

  // Record what this turn runs with so reopening the session later restores the
  // same model and reasoning effort, and so the resume path has a
  // session-scoped model answer to use.
  if (typeof clientOptions.model === 'string' && clientOptions.model.trim()) {
    providerModelsService.setSessionModel(provider, sessionId, clientOptions.model);
  }
  if (typeof clientOptions.effort === 'string' && clientOptions.effort.trim()) {
    providerModelsService.setSessionEffort(provider, sessionId, clientOptions.effort);
  }

  if (target.kind === 'remote') {
    let completion: { exitCode: number; aborted?: boolean } = { exitCode: 1 };
    try {
      const result = await routing.remoteExecution.run({
        nodeId: target.nodeId,
        nodeLabel: target.nodeLabel,
        appSessionId: sessionId,
        projectPath: target.projectPath,
        providerSessionId: session.provider_session_id,
        command,
        cwd: target.cwd,
        options: pickRemoteRunOptions(clientOptions),
        writer: run.writer,
        userId,
      });
      // An aborted remote run ends exactly like a locally aborted one, whichever
      // of its own end or the cancel acknowledgement reached this server first.
      completion = result.outcome === 'aborted'
        ? { exitCode: 0, aborted: true }
        : { exitCode: result.outcome === 'completed' ? 0 : 1 };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[Chat] Remote run dispatch failed', { sessionId, nodeId: target.nodeId, error: message });
    } finally {
      chatRunRegistry.completeRunIfCurrent(run, completion);
    }
    return;
  }

  const verifiedAttachments = filterAttachmentsToUploadStore(attachmentCandidates);
  const uniqueAttachments = verifiedAttachments.filter(
    (descriptor, index, all) => all.findIndex((candidate) => candidate.path === descriptor.path) === index,
  );

  // The provider runtimes receive the stable app session id. When their
  // CLI/SDK needs the provider-native id for resume, they resolve it from the
  // session row themselves (sessionsService.resolveProviderSessionId).
  // Brand-new sessions have no provider id yet, so the runtime starts fresh
  // and announces one, which the gateway writer captures and maps back to the
  // app session id.
  const runtimeOptions: AnyRecord = {
    ...clientOptions,
    // Attachments are re-validated server-side: only direct children of the
    // global upload store may reach provider runtimes or their file tools.
    attachments: uniqueAttachments,
    images: uniqueAttachments.filter(isImageAttachmentDescriptor),
    files: uniqueAttachments.filter((descriptor) => !isImageAttachmentDescriptor(descriptor)),
    sessionId,
    cwd: clientOptions.cwd ?? session.project_path ?? undefined,
    projectPath: session.project_path ?? clientOptions.projectPath,
    // Resolved above from the session row only; a client-supplied
    // `options.claudeProfileId` is never forwarded (CLOUDCLI_EXTENSION_PLAN.md F5).
    claudeProfileId: claudeProfileId ?? undefined,
  };

  try {
    await dependencies.runtime.run(provider, command, runtimeOptions, run.writer);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Chat] Provider runtime "${provider}" failed`, { sessionId, error: message });
  } finally {
    // Safety net: a runtime that crashed (or resolved) without emitting its
    // terminal `complete` would otherwise leave the session stuck in
    // "processing" forever on every connected client. Scoped to THIS run —
    // a queued message can start the session's next run before this promise
    // settles, and the session-keyed completeRun would kill that new run.
    chatRunRegistry.completeRunIfCurrent(run, { exitCode: 1 });
  }
}

/**
 * Interrupts the session's run wherever it executes: on its remote node when
 * one owns the run, otherwise through the local provider runtime.
 */
async function interruptRun(
  sessionId: string,
  provider: LLMProvider,
  dependencies: ChatWebSocketDependencies,
): Promise<boolean> {
  const routing = dependencies.runtimeNodes ?? runtimeNodesService;
  const remoteAborted = await routing.remoteExecution.abort(sessionId);
  return remoteAborted ?? dependencies.runtime.abort(provider, sessionId);
}

/**
 * Handles `chat.abort`: cancels the run for one app session and emits the
 * terminal `complete` on its behalf (runtimes skip their own complete for
 * aborted runs, and the registry drops any duplicate).
 */
async function handleChatAbort(
  ws: WebSocket,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): Promise<void> {
  const sessionId = readRequiredSessionId(data);
  if (!sessionId) {
    sendProtocolError(ws, 'SESSION_ID_REQUIRED', 'chat.abort requires a sessionId.');
    return;
  }

  const run = chatRunRegistry.getRun(sessionId);
  if (!run || run.status !== 'running') {
    sendProtocolError(ws, 'NO_ACTIVE_RUN', `Session "${sessionId}" has no active run.`, sessionId);
    return;
  }

  const success = await interruptRun(sessionId, run.provider, dependencies);

  chatRunRegistry.completeRun(sessionId, {
    exitCode: success ? 0 : 1,
    aborted: true,
  });
}

/**
 * Handles `chat.steer` (FT-M06): interrupts the session's ACTIVE run and
 * immediately dispatches the given content as the session's next turn — the
 * one primitive in this codebase that genuinely acts on the run in progress,
 * as opposed to Queue (`queued_messages`), which only ever runs after the
 * current turn finishes on its own.
 *
 * Deliberately thin: the interrupt half is byte-for-byte `handleChatAbort`'s
 * own logic (same "explicit error if nothing is running", same "complete the
 * run whether or not the provider's interrupt call itself reports success" —
 * a stalled provider process must never wedge Steer), and the dispatch half
 * is a literal `handleChatSend` call, so a steered send is indistinguishable
 * from a normal one to every downstream concern (provider/profile/node
 * resolution, model/effort persistence, attachment validation) — nothing
 * here ever writes to `queued_messages`, and no new session is created; this
 * is the same session, same native id, continued on the same node.
 */
async function handleChatSteer(
  ws: WebSocket,
  userId: string | number | null,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): Promise<void> {
  const sessionId = readRequiredSessionId(data);
  if (!sessionId) {
    sendProtocolError(ws, 'SESSION_ID_REQUIRED', 'chat.steer requires a sessionId.');
    return;
  }

  // Verified fresh against the registry, never trusted from client state: the
  // run may have finished a moment before this message arrived.
  const run = chatRunRegistry.getRun(sessionId);
  if (!run || run.status !== 'running') {
    sendProtocolError(ws, 'STEER_NOT_ACTIVE', `Session "${sessionId}" has no active run to steer.`, sessionId);
    return;
  }

  const interrupted = await interruptRun(sessionId, run.provider, dependencies);
  chatRunRegistry.completeRun(sessionId, {
    exitCode: interrupted ? 0 : 1,
    aborted: true,
  });

  await handleChatSend(ws, userId, { ...data, type: 'chat.send' }, dependencies);
}

/**
 * Handles `chat.subscribe`: for each requested session, reports whether a run
 * is processing, re-attaches the live stream to this socket, replays missed
 * events (seq > lastSeq), and includes pending permission requests.
 *
 * This single message replaces the old `check-session-status`,
 * `get-pending-permissions`, and Claude-only writer reconnect flows.
 */
function handleChatSubscribe(
  ws: WebSocket,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): void {
  const routing = dependencies.runtimeNodes ?? runtimeNodesService;
  const targets = Array.isArray(data.sessions) ? data.sessions : [];

  for (const target of targets) {
    if (!target || typeof target !== 'object') {
      continue;
    }

    const sessionId = typeof (target as AnyRecord).sessionId === 'string'
      ? ((target as AnyRecord).sessionId as string).trim()
      : '';
    if (!sessionId) {
      continue;
    }

    const lastSeqRaw = (target as AnyRecord).lastSeq;
    const lastSeq = typeof lastSeqRaw === 'number' && Number.isFinite(lastSeqRaw)
      ? Math.max(0, Math.floor(lastSeqRaw))
      : 0;

    const run = chatRunRegistry.getRun(sessionId);
    const isProcessing = chatRunRegistry.isProcessing(sessionId);

    // Future live events for this run should land on the socket that asked —
    // this is what makes mid-stream page refreshes work for all providers.
    if (isProcessing) {
      chatRunRegistry.attachConnection(sessionId, ws);
    }

    // Pending approvals are tracked under the app session id inside the
    // local Claude runtime, and by the remote execution service for runs on
    // other nodes (from the events those nodes streamed).
    const pendingPermissions = [
      ...dependencies.runtime.getPendingApprovalsForSession(sessionId),
      ...routing.remoteExecution.getPendingApprovals(sessionId),
    ];
    // Recently settled approvals let a reconnecting client tell answered,
    // expired, and cancelled requests apart instead of guessing from absence.
    const recentPermissionOutcomes = [
      ...dependencies.runtime.getRecentPermissionOutcomesForSession(sessionId),
      ...routing.remoteExecution.getRecentPermissionOutcomes(sessionId),
    ];

    sendJson(ws, {
      kind: 'chat_subscribed',
      sessionId,
      isProcessing,
      lastSeq: run?.lastSeq ?? 0,
      pendingPermissions,
      recentPermissionOutcomes,
      timestamp: new Date().toISOString(),
    });

    // Replay only for RUNNING runs, strictly after the ack. Completed runs
    // are fully persisted to the provider transcript and served over REST —
    // replaying them (e.g. after a page reload where the client's lastSeq is
    // 0) would duplicate messages the history fetch already returned.
    if (isProcessing) {
      for (const event of chatRunRegistry.replayEvents(sessionId, lastSeq)) {
        sendJson(ws, event);
      }
    }
  }
}

/**
 * Handles `chat.permission-response`: forwards a tool-approval decision to the
 * pending approval resolver — the remote node that owns the request when a
 * remote run raised it, otherwise the local provider runtimes.
 *
 * Always acknowledges to the answering socket — that socket is not
 * necessarily the one the run streams to — so the client can leave its
 * "sending" state: accepted, or rejected with why (already answered, expired,
 * cancelled, unknown, or belonging to another session).
 */
async function handlePermissionResponse(
  ws: WebSocket,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): Promise<void> {
  if (typeof data.requestId !== 'string' || data.requestId.length === 0) {
    return;
  }

  const routing = dependencies.runtimeNodes ?? runtimeNodesService;
  const sessionId = readRequiredSessionId(data);
  const decision: ProviderPermissionDecision = {
    allow: Boolean(data.allow),
    updatedInput: data.updatedInput,
    message: typeof data.message === 'string' ? data.message : undefined,
    rememberEntry: data.rememberEntry,
  };
  const remoteResolution = await routing.remoteExecution.resolveToolApproval(data.requestId, decision, { sessionId });
  const resolution = remoteResolution ?? dependencies.runtime.resolveToolApproval(data.requestId, decision, { sessionId });

  sendJson(ws, {
    kind: 'permission_response_ack',
    requestId: data.requestId,
    sessionId,
    accepted: resolution.status === 'accepted',
    reason: resolution.status === 'rejected' ? resolution.reason : null,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Handles authenticated chat websocket messages used by the main chat panel.
 *
 * Inbound protocol (client to server):
 * - `chat.send`                { sessionId, content, options? }
 * - `chat.abort`               { sessionId }
 * - `chat.steer`               { sessionId, content, options? }
 * - `chat.subscribe`           { sessions: [{ sessionId, lastSeq? }] }
 * - `chat.permission-response` { requestId, sessionId, allow, updatedInput?, message?, rememberEntry? }
 *
 * Outbound protocol (server to client): every frame is `kind`-based — either
 * a provider `NormalizedMessage` (with `seq`) or a gateway event
 * (`chat_subscribed`, `session_upserted`, `loading_progress`,
 * `protocol_error`, `permission_response_ack`).
 */
export function handleChatConnection(
  ws: WebSocket,
  request: AuthenticatedWebSocketRequest,
  dependencies: ChatWebSocketDependencies
): void {
  console.log('[INFO] Chat WebSocket connected');
  connectedClients.add(ws);

  const userId = readRequestUserId(request);

  ws.on('message', async (rawMessage) => {
    try {
      const parsed = parseIncomingJsonObject(rawMessage);
      if (!parsed) {
        throw new Error('Invalid websocket payload');
      }

      const data = parsed as AnyRecord;
      const messageType = typeof data.type === 'string' ? data.type : '';

      switch (messageType) {
        case 'chat.send':
          await handleChatSend(ws, userId, data, dependencies);
          return;
        case 'chat.abort':
          await handleChatAbort(ws, data, dependencies);
          return;
        case 'chat.steer':
          await handleChatSteer(ws, userId, data, dependencies);
          return;
        case 'chat.subscribe':
          handleChatSubscribe(ws, data, dependencies);
          return;
        case 'chat.permission-response':
          await handlePermissionResponse(ws, data, dependencies);
          return;
        default:
          sendProtocolError(ws, 'UNKNOWN_MESSAGE_TYPE', `Unknown message type "${messageType}".`);
          return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ERROR] Chat WebSocket error:', message);
      sendProtocolError(ws, 'INTERNAL_ERROR', message);
    }
  });

  ws.on('close', () => {
    console.log('[INFO] Chat client disconnected');
    connectedClients.delete(ws);
  });
}
