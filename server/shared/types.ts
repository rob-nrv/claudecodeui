import type { IncomingMessage } from 'node:http';
import type { Readable } from 'node:stream';

//----------------- HTTP RESPONSE SHAPES ------------
/**
 * Canonical success envelope used by backend APIs that return a structured payload.
 *
 * Use this for route handlers that need a stable `success/data` shape so frontend
 * consumers can parse responses consistently across endpoints.
 */
export type ApiSuccessShape<TData = unknown> = {
  success: true;
  data: TData;
};

/**
 * Generic plain-object record used when parsing loosely typed JSON payloads.
 *
 * Use this only after runtime shape checks, not as a replacement for validated
 * domain models.
 */
export type AnyRecord = Record<string, any>;

// ---------------------------
//----------------- WEBSOCKET TRANSPORT TYPES ------------
/**
 * Minimal websocket client contract used by backend broadcaster services.
 *
 * Any transport object added to `connectedClients` must implement these two
 * members so shared services can safely send JSON strings and check whether the
 * socket is still open before broadcasting.
 */
export type RealtimeClientConnection = {
  readyState: number;
  send(data: string): void;
};

/**
 * Authenticated user payload attached to websocket upgrade requests.
 *
 * Platform and OSS auth flows currently use either `id` or `userId`; both are
 * represented here so websocket handlers can resolve a stable writer user id.
 */
export type AuthenticatedWebSocketUser = {
  id?: string | number;
  userId?: string | number;
  username?: string;
  [key: string]: unknown;
};

/**
 * HTTP upgrade request shape after websocket authentication succeeds.
 *
 * `verifyClient` populates `request.user` with the authenticated payload, and
 * downstream websocket handlers rely on this extended request type.
 */
export type AuthenticatedWebSocketRequest = IncomingMessage & {
  user?: AuthenticatedWebSocketUser;
};

// ---------------------------
//----------------- PROVIDER MESSAGE MODEL ------------
/**
 * Providers supported by the unified server runtime.
 *
 * Use this as the source of truth whenever a function or payload needs to identify
 * a specific LLM integration.
 */
export type LLMProvider = 'claude' | 'codex' | 'cursor' | 'opencode';

/**
 * One selectable model row in a provider model catalog.
 */
export type ProviderModelOption = {
  value: string;
  label: string;
  description?: string;
  /** Stable SQLite row id used only by model-management actions. */
  recordId?: number;
  /** True for user-created rows; false for immutable CloudCLI defaults. */
  isCustom?: boolean;
  effort?: {
    default?: string;
    values: {
      value: string;
      description?: string;
    }[];
  };
  /**
   * Static, sourced model facts (context window / max output tokens) — never
   * live usage. Omitted for aliases like `default`/`best`/`opusplan` whose
   * resolved underlying model varies, since a single fixed number would be
   * false for some of them. A missing value must render as absent, not zero.
   */
  capability?: {
    contextWindowTokens?: number;
    maxOutputTokens?: number;
  };
};

/**
 * Provider model catalog returned by `GET /api/providers/:provider/models`.
 */
export type ProviderModelsDefinition = {
  OPTIONS: ProviderModelOption[];
  DEFAULT: string;
};

/**
 * One persisted custom-model row in the provider model library.
 *
 * Provider modules use this shape at the database boundary. Predefined models
 * never use this type because they remain source-controlled in provider
 * adapters. `modelId` is sent to the provider runtime, while `model` is the
 * user-supplied display name shown in pickers.
 */
export type CustomProviderModelRecord = {
  recordId: number;
  provider: LLMProvider;
  modelId: string;
  model: string;
  sortOrder: number;
};

/**
 * User-editable values accepted when creating or changing a custom model.
 *
 * `id` must be the exact provider-facing model identifier and cannot contain
 * whitespace. `model` is a concise display name. The provider is supplied by
 * the route path so a row can never be moved across providers accidentally.
 */
export type CustomProviderModelInput = {
  id: string;
  model: string;
};

// ---------------------------
//----------------- PROVIDER ACTIVE MODEL TYPES ------------
/**
 * Provider-neutral result for the model that is actively driving a session or
 * provider runtime at the time of lookup.
 *
 * `model` must always be populated. Provider adapters should use the
 * provider-specific lookup method requested by the caller, and only fall back
 * to the provider catalog `DEFAULT` value when the active model cannot be read.
 */
export type ProviderCurrentActiveModel = {
  model: string;
};

/**
 * Where a resolved session model came from.
 *
 * `session` means the app has recorded a model for this session (the user
 * picked one, or the session has been sent on at least once) and that value is
 * authoritative. `provider` means the session predates any app-recorded model
 * and the value was read back from the provider's own session state — the case
 * for sessions started directly in a provider CLI. `default` means neither was
 * available and the catalog default is standing in.
 *
 * Routes surface this so the frontend can tell a real selection apart from a
 * placeholder without re-deriving the precedence chain.
 */
export type ProviderSessionModelSource = 'session' | 'provider' | 'default';

/**
 * The model one session runs with, its persisted reasoning effort when one has
 * been recorded, and where the model answer came from.
 *
 * Returned by `providerModelsService.resolveSessionModel` and used by the
 * `/models`, `/cost` and `/status` commands, the active-model route, and the
 * composer's model picker so every surface agrees on one answer.
 */
export type ProviderSessionModel = {
  provider: LLMProvider;
  sessionId: string | null;
  model: string;
  /** NULL means this session has not recorded an effort choice yet. */
  effort: string | null;
  source: ProviderSessionModelSource;
};

/**
 * Message/event variants emitted by provider adapters and normalized transports.
 *
 * Keep this union in sync with event kinds produced by provider session adapters.
 */
export type MessageKind =
  | 'text'
  | 'tool_use'
  | 'tool_result'
  | 'thinking'
  | 'stream_delta'
  | 'stream_end'
  | 'error'
  | 'complete'
  | 'status'
  | 'permission_request'
  | 'permission_cancelled'
  | 'permission_resolved'
  | 'session_created'
  | 'interactive_prompt'
  | 'task_notification';

/**
 * Event kinds added by the chat gateway layer on top of provider message kinds.
 *
 * These are app-level realtime events (subscription acks, sidebar deltas,
 * project loading progress, protocol failures) that are not produced by any
 * provider adapter. Together with `MessageKind` they form the complete set of
 * `kind` values a websocket client can receive, so the frontend only ever
 * needs one kind-based switch.
 */
export type GatewayEventKind =
  | 'chat_subscribed'
  | 'session_upserted'
  | 'loading_progress'
  | 'protocol_error'
  | 'permission_response_ack';

/**
 * Complete set of `kind` values emitted to websocket clients.
 *
 * Every server-to-client websocket frame carries a `kind` from this union.
 * Provider runtimes emit `MessageKind` values; gateway services emit
 * `GatewayEventKind` values.
 */
export type ServerEventKind = MessageKind | GatewayEventKind;

/**
 * Provider-neutral message envelope used in REST responses and realtime channels.
 *
 * Every provider-specific message must be converted into this shape before being
 * emitted outside provider-specific modules.
 */
export type NormalizedMessage = {
  id: string;
  sessionId: string;
  timestamp: string;
  provider: LLMProvider;
  kind: MessageKind;
  /**
   * Monotonic per-run sequence number assigned by the chat run registry when a
   * live event is forwarded to the websocket. History messages loaded over
   * REST do not carry it. Clients use it with `chat.subscribe` to replay only
   * the live events they missed across websocket reconnects.
   */
  seq?: number;
  role?: 'user' | 'assistant';
  content?: string;
  /**
   * Optional display-oriented metadata used by providers that need to expose
   * richer transcript artifacts without introducing a brand-new message kind.
   *
   * Current Claude usage:
   * - local slash commands expose parsed command fields
   * - compact summaries are flagged so the UI can treat them differently later
   */
  displayText?: string;
  commandName?: string;
  commandMessage?: string;
  commandArgs?: string;
  isLocalCommand?: boolean;
  isLocalCommandStdout?: boolean;
  isCompactSummary?: boolean;
  images?: unknown;
  /** Non-image files attached to a user turn after provider history normalization. */
  files?: unknown;
  toolName?: string;
  toolInput?: unknown;
  toolId?: string;
  toolResult?: {
    content?: string;
    isError?: boolean;
    toolUseResult?: unknown;
  };
  isError?: boolean;
  text?: string;
  tokens?: number;
  canInterrupt?: boolean;
  requestId?: string;
  input?: unknown;
  context?: unknown;
  reason?: string;
  newSessionId?: string;
  status?: string;
  summary?: string;
  tokenBudget?: unknown;
  subagentTools?: unknown;
  toolUseResult?: unknown;
  sequence?: number;
  rowid?: number;
  [key: string]: unknown;
};

/**
 * Output gateway shared by WebSocket and SSE provider runs.
 *
 * Runtime adapters only depend on this structural surface, which keeps them
 * independent from the transport that ultimately delivers normalized events.
 */
export type ProviderRuntimeWriter = {
  send(data: unknown): void;
  setSessionId?(sessionId: string): void;
  userId?: string | number | null;
  isWebSocketWriter?: boolean;
  isSSEStreamWriter?: boolean;
};

export type ProviderPermissionDecision = {
  allow: boolean;
  updatedInput?: unknown;
  message?: string;
  rememberEntry?: unknown;
};

/**
 * Caller scope for a tool-approval answer. `sessionId` is the app session the
 * answering client believes the request belongs to; a mismatch is rejected so
 * one session's answer can never settle another session's request.
 */
export type ProviderPermissionScope = {
  sessionId?: string | null;
};

/**
 * Public record of a tool approval still awaiting a user decision, sent in
 * `permission_request` events and `chat_subscribed.pendingPermissions`.
 * `expiresAt` is null for interactive tools that wait indefinitely.
 */
export type ProviderPendingPermission = {
  requestId: string;
  sessionId: string | null;
  toolName: string;
  input: unknown;
  receivedAt: string;
  expiresAt: string | null;
  /**
   * The SDK's own tool_use id for this request (Claude: `context.toolUseID`),
   * when the provider can supply one. Lets a client patch the exact transcript
   * row the approval belongs to once it settles, instead of relying on the
   * provider to ever rewrite that row's `input` itself — it doesn't.
   */
  toolId?: string;
};

/** How a tool approval settled: a user answer, expiry, or SDK cancellation. */
export type ProviderPermissionOutcome = 'answered' | 'expired' | 'cancelled';

/**
 * A recently settled tool approval, reported in
 * `chat_subscribed.recentPermissionOutcomes` so a reconnecting client can tell
 * answered, expired, and cancelled requests apart. `input` is only kept for
 * expired requests, which the client re-surfaces.
 */
export type ProviderPermissionOutcomeRecord = {
  requestId: string;
  sessionId: string | null;
  toolName: string;
  outcome: ProviderPermissionOutcome;
  settledAt: string;
  input?: unknown;
};

/**
 * Result of applying a user answer to a tool approval. A rejection says why
 * the answer no longer applies and is relayed to the answering client as
 * `permission_response_ack`.
 */
export type ProviderPermissionResolution =
  | { status: 'accepted' }
  | {
    status: 'rejected';
    reason: 'already_answered' | 'expired' | 'cancelled' | 'not_found' | 'session_mismatch';
  };

export type ProviderRuntimePermissionGateway = {
  resolve(
    requestId: string,
    decision: ProviderPermissionDecision,
    scope?: ProviderPermissionScope,
  ): ProviderPermissionResolution;
  listPending(sessionId: string): ProviderPendingPermission[];
  listRecentOutcomes?(sessionId: string): ProviderPermissionOutcomeRecord[];
};

/**
 * Provider-scoped application capabilities supplied to a runtime for one run.
 *
 * Keeping these lookups outside concrete SDK/CLI adapters prevents the
 * adapters from importing services that resolve back through providerRegistry.
 */
export type ProviderRuntimeContext = {
  resolveProviderSessionId(sessionId: string | null | undefined): string | null;
  resolveResumeModel(
    sessionId: string | undefined,
    requestedModel?: string | null,
  ): Promise<string | undefined>;
  getProviderModels(): Promise<ProviderModelsDefinition>;
  normalizeMessage(raw: unknown, sessionId: string | null): NormalizedMessage[];
  isProviderInstalled(): Promise<boolean>;
};

export type ProviderRunFunction = (
  command: string,
  options: AnyRecord,
  writer: ProviderRuntimeWriter,
) => Promise<unknown>;

/**
 * Shared options used to fetch historical provider messages.
 *
 * Consumers should pass provider-specific lookup hints (`projectPath`) only
 * when the selected provider requires them.
 *
 * `providerSessionId` is the provider-native session id from the sessions
 * index (transcript file name / provider database key). Provider adapters
 * must use it — never the app-facing session id they were called with — when
 * matching transcript rows on disk, because app-created sessions use an
 * app-allocated id that the provider has never seen.
 */
export type FetchHistoryOptions = {
  projectPath?: string;
  limit?: number | null;
  offset?: number;
  providerSessionId?: string;
};

/**
 * Standardized response payload returned from provider history readers.
 *
 * Use this as the contract for APIs that return paginated conversation history.
 */
export type FetchHistoryResult = {
  messages: NormalizedMessage[];
  total: number;
  hasMore: boolean;
  offset: number;
  limit: number | null;
  tokenUsage?: unknown;
};

// ---------------------------
//----------------- PROVIDER SKILL TYPES ------------
/**
 * Scope where a provider skill definition was discovered.
 *
 * Provider skill adapters should use this to describe the origin of each
 * skill markdown file without leaking provider-specific folder names into route
 * contracts. `repo` is used for Codex repository lookup locations, while
 * `project` is used for providers that treat workspace-local skills as project
 * scoped.
 */
export type ProviderSkillScope = 'user' | 'project' | 'plugin' | 'repo' | 'admin' | 'system';

/**
 * Shared input accepted by provider skill listing operations.
 *
 * Routes pass `workspacePath` when a caller wants project/repository skills for
 * a specific folder. Providers should fall back to the backend process cwd when
 * this option is omitted.
 */
export type ProviderSkillListOptions = {
  workspacePath?: string;
};

/**
 * One supporting file bundled with an uploaded provider skill.
 *
 * `relativePath` is resolved below the installed skill directory and must never
 * be absolute or contain traversal segments. Text files may use `utf8`; binary
 * scripts and assets should use `base64` so JSON transport does not corrupt
 * their bytes.
 */
export type ProviderSkillCreateFile = {
  relativePath: string;
  content: string;
  encoding: 'utf8' | 'base64';
};

/**
 * One skill markdown payload submitted for provider-managed installation.
 *
 * `content` is the raw markdown body that will be written to `SKILL.md`.
 * `directoryName` lets callers control the target folder name explicitly when
 * they want stable filesystem paths that differ from the markdown front matter
 * `name` field. `fileName` is optional upload metadata used only as a final
 * fallback when no directory name or front matter name is present. `files`
 * carries scripts, references, and other files from a complete skill folder.
 */
export type ProviderSkillCreateEntry = {
  content: string;
  directoryName?: string;
  fileName?: string;
  files?: ProviderSkillCreateFile[];
};

/**
 * Shared input accepted by provider skill creation operations.
 *
 * The service layer batches multiple skill definitions in one request. Each
 * entry can contain only markdown or a complete skill folder.
 */
export type ProviderSkillCreateInput = {
  entries: ProviderSkillCreateEntry[];
};

export type ProviderSkillRemoveInput = {
  directoryName: string;
};

/**
 * Normalized skill record returned by provider skill adapters.
 *
 * The `command` value is the exact invocation text the selected provider expects
 * for this skill. Claude plugin skills use a namespaced command such as
 * `/plugin-name:skill-name`, while Codex skills use the `$skill-name` form.
 * `sourcePath` points to the skill markdown file that produced the record so
 * callers can distinguish duplicate skill names across scopes.
 */
export type ProviderSkill = {
  provider: LLMProvider;
  name: string;
  description: string;
  command: string;
  scope: ProviderSkillScope;
  sourcePath: string;
  pluginName?: string;
  pluginId?: string;
};

/**
 * Internal source descriptor consumed by shared provider skill discovery logic.
 *
 * Concrete provider adapters build these records from their native lookup rules.
 * The shared skills provider then scans `rootDir` for child skill markdown files
 * and uses `commandForSkill` or `commandPrefix` to produce the provider-specific
 * invocation command. Set `recursive` only when a provider stores skills under
 * arbitrary nested folders below the source root.
 */
export type ProviderSkillSource = {
  scope: ProviderSkillScope;
  rootDir: string;
  recursive?: boolean;
  commandPrefix?: '/' | '$';
  commandForSkill?: (skillName: string) => string;
  pluginName?: string;
  pluginId?: string;
};

// ---------------------------
//----------------- SHARED ERROR TYPES ------------
/**
 * Optional metadata used when constructing application-level errors.
 *
 * `statusCode` should reflect the HTTP response status, while `code` identifies
 * the stable machine-readable error category.
 */
export type AppErrorOptions = {
  code?: string;
  statusCode?: number;
  details?: unknown;
};

// ---------------------------
//----------------- MCP TYPES ------------
/**
 * Scope where an MCP server definition is stored and resolved.
 *
 * `user` is global for a user account, `local` is provider-local, and `project`
 * is tied to a specific project path.
 */
export type McpScope = 'user' | 'local' | 'project';

/**
 * Transport protocol used by an MCP server definition.
 */
export type McpTransport = 'stdio' | 'http' | 'sse';

/**
 * Normalized MCP server model exposed to frontend and route handlers.
 *
 * Provider adapters should map provider-native config to this structure before
 * returning results.
 */
export type ProviderMcpServer = {
  provider: LLMProvider;
  name: string;
  scope: McpScope;
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  envVars?: string[];
  bearerTokenEnvVar?: string;
  envHttpHeaders?: Record<string, string>;
};

/**
 * Payload for create/update MCP server operations.
 *
 * Routes and services should accept this type, validate it, and then persist it
 * through provider-specific MCP repositories.
 */
export type UpsertProviderMcpServerInput = {
  name: string;
  scope?: McpScope;
  transport: McpTransport;
  workspacePath?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  envVars?: string[];
  bearerTokenEnvVar?: string;
  envHttpHeaders?: Record<string, string>;
};

// ---------------------------
//----------------- PROVIDER AUTH TYPES ------------
/**
 * Authentication status result returned by provider health checks.
 *
 * This shape is consumed by settings/status endpoints to report installation and
 * credential state for each provider.
 */
export type ProviderAuthStatus = {
  installed: boolean;
  provider: LLMProvider;
  authenticated: boolean;
  email: string | null;
  method: string | null;
  error?: string;
};

/**
 * Multi-account Claude profile model (`MULTI_ACCOUNT_SPEC.md` §3.1).
 *
 * This is the API-facing shape only: it deliberately excludes
 * `configDirectory` and any credential material. The frontend never sees
 * either — see §3.4/§5.2 of the spec.
 */
export type ClaudeProfileConnectionState = 'connected' | 'expired' | 'not_authenticated' | 'unknown';

export type ClaudeProfileVerificationMethod = 'cli_probe' | 'credentials_file' | 'none';

export type ClaudeProfileVerifiedIdentity = {
  value: string;
  method: ClaudeProfileVerificationMethod;
  tier: string | null;
  verifiedAt: number;
};

export type ClaudeProfile = {
  id: string;
  displayName: string;
  connectionState: ClaudeProfileConnectionState;
  verifiedIdentity: ClaudeProfileVerifiedIdentity | null;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
};

/** Parsed, non-interactive `claude auth status` JSON (`MULTI_ACCOUNT_SPEC.md` §4.3). */
export type ClaudeAuthStatusProbeResult = {
  loggedIn: boolean;
  authMethod: string | null;
  apiProvider: string | null;
  email: string | null;
  orgId: string | null;
  orgName: string | null;
  subscriptionType: string | null;
};

// ---------------------------
//----------------- CLAUDE LIVE USAGE TYPES ------------
/**
 * One Claude subscription rate-limit window as last reported by Claude Code's
 * documented statusLine JSON (`rate_limits.five_hour` / `rate_limits.seven_day`).
 *
 * `available` carries the reported value exactly as observed. `unavailable`
 * never carries a number, so a missing or reset window can never render as 0%:
 * `not_reported` covers an absent, invalid or unattributable window, and
 * `window_reset` means the last reported `resets_at` has passed, so the old
 * percentage no longer describes the current window.
 */
export type ClaudeLiveUsageWindow =
  | { state: 'available'; usedPercentage: number; resetsAt: string }
  | { state: 'unavailable'; reason: 'not_reported' | 'window_reset' };

/**
 * State of CloudCLI's statusLine capture bridge in one Claude config
 * directory's `settings.json`.
 *
 * - `not_installed`: no CloudCLI bridge; any statusLine there is the user's own.
 * - `installed`: the current bridge is configured and its script exists.
 * - `outdated`: a bridge from another CloudCLI version is configured; enabling again updates it.
 * - `broken`: the bridge is configured but its script is missing, so the status
 *   line (including a wrapped user status line) cannot run until re-enabled.
 * - `settings_unreadable`: `settings.json` exists but is not a JSON object, so
 *   CloudCLI neither interprets nor rewrites it.
 */
export type ClaudeStatusLineBridgeState = 'not_installed' | 'installed' | 'outdated' | 'broken' | 'settings_unreadable';

/**
 * Backend-authoritative live usage for one Claude account (FT-M07).
 *
 * Built by the claude-profiles live-usage service, returned by its routes and
 * rendered by Settings. It never contains a config path, a credential or the
 * raw statusLine payload. `snapshot.freshness` is derived from the capture age
 * at read time, so a persisted snapshot is never presented as current.
 */
export type ClaudeLiveUsage = {
  source: 'claude_statusline';
  bridge: {
    state: ClaudeStatusLineBridgeState;
    /** True when the installed bridge chains a statusLine the user already had. */
    wrapsExistingStatusLine: boolean;
    /** True when no bridge is installed and the account has its own statusLine. */
    hasUserStatusLine: boolean;
  };
  snapshot: {
    status: 'available' | 'unavailable';
    reason: 'no_snapshot' | 'snapshot_invalid' | 'attribution_mismatch' | 'snapshot_from_future' | null;
    capturedAt: string | null;
    freshness: 'fresh' | 'stale' | null;
  };
  fiveHour: ClaudeLiveUsageWindow;
  sevenDay: ClaudeLiveUsageWindow;
};

// ---------------------------
//----------------- RUNTIME NODE TYPES ------------
/**
 * Capabilities a RuntimeNode can be probed for (FT-M07, extended in FT-M09).
 *
 * - `node-runtime`: the Node process running CloudCLI there (version, platform,
 *   architecture; an Android host is a descriptive fact, never a capability).
 * - `claude-cli`: `claude --version` runs.
 * - `claude-auth`: `claude auth status` reports a login (no model call).
 * - `claude-headless`: a headless run actually completed on that node recently
 *   (observed by its agent; never a synthetic provider call).
 * - `git-cli`, `workspace-filesystem` (root readable, and on node agents a
 *   real write proof), `background-execution` (only a device check can prove
 *   it; an observed process suspension disproves it).
 */
export type RuntimeNodeCapabilityId =
  | 'node-runtime'
  | 'claude-cli'
  | 'claude-auth'
  | 'claude-headless'
  | 'git-cli'
  | 'workspace-filesystem'
  | 'background-execution';

/**
 * Evidence-backed capability status.
 *
 * - `available`: a bounded probe ran on the node and proved it.
 * - `unavailable`: a probe ran and failed; it may succeed later.
 * - `unsupported`: a probe positively established the node will not provide it.
 * - `unknown`: nothing proves or disproves it. Never read as available, and
 *   never replaced by a guess from the platform name.
 */
export type RuntimeNodeCapabilityStatus = 'available' | 'unavailable' | 'unsupported' | 'unknown';

/**
 * Raw result of one capability prober, before it is stamped with a probe time.
 * Produced by the runtime-nodes probes and mapped to a capability by the
 * availability evaluation; `detail` must be a short non-sensitive fact such as
 * a CLI version, never a path.
 */
export type RuntimeNodeProbeOutcome =
  | { outcome: 'proven'; detail?: string | null }
  | { outcome: 'failed'; reason: string; detail?: string | null }
  | { outcome: 'not_supported'; reason: string; detail?: string | null }
  | { outcome: 'not_probed'; reason: string; detail?: string | null };

/** One capability as persisted from a probe (FT-M07). */
export type RuntimeNodeCapability = {
  id: RuntimeNodeCapabilityId;
  status: RuntimeNodeCapabilityStatus;
  detail: string | null;
  reason: string | null;
  /** Epoch milliseconds of the probe that established this entry; null when never probed. */
  probedAt: number | null;
};

/**
 * How a capability can be established at all (FT-M09): by a bounded probe, by
 * observing a real run the user started, or only by a person checking the
 * device (for example that runs survive the screen being off).
 */
export type RuntimeNodeCapabilityVerification = 'probe' | 'observed_run' | 'device_check';

/**
 * One capability as exposed by the runtime-nodes API. `freshness` is derived at
 * read time: local evidence is fresh inside the freshness window, remote
 * evidence only when it was produced on the node's CURRENT link. Stale
 * evidence is shown for context and never counts as proof.
 */
export type RuntimeNodeCapabilityView = RuntimeNodeCapability & {
  verification: RuntimeNodeCapabilityVerification;
  freshness: 'fresh' | 'stale' | null;
};

/**
 * Resource Governor state a node agent reports with its probe answer (FT-M09).
 * Unknown signals stay unknown; nothing is reported as healthy by default.
 * `admission` is what the node would do with a new run at report time; the
 * node re-checks at every run start.
 */
export type RuntimeNodeResourceReport = {
  admission: 'accepting' | 'at_capacity' | 'restricted';
  restriction: 'storage_low' | 'battery_low' | null;
  activeRuns: number;
  maxConcurrentRuns: number;
  storage: { state: 'known'; freeBytes: number; minFreeBytes: number } | { state: 'unknown'; reason: string };
  battery: { state: 'known'; percent: number; charging: boolean | null; minPercent: number | null } | { state: 'unknown'; reason: string };
  thermal: { state: 'known'; celsius: number } | { state: 'unknown'; reason: string };
};

export type RuntimeNodeResourcesView = RuntimeNodeResourceReport & { observedAt: string };

/**
 * Whether a node can take new executions right now, derived at read time from
 * probe freshness and execution capabilities. It is independent from the
 * control client's `appReady`: a node can execute while no UI bundle is served.
 *
 * - `available`: fresh probe and at least one execution capability proven.
 * - `degraded`: fresh probe, but no execution capability proven.
 * - `unavailable`: the last probe is too old to vouch for the node.
 * - `unknown`: the node has never been probed.
 */
export type RuntimeNodeAvailability = {
  state: 'available' | 'degraded' | 'unavailable' | 'unknown';
  /**
   * Local-node reasons come from probe age (FT-M07). Remote-node reasons
   * (FT-M08) come from the authenticated link: `link_connected` (live link and
   * Claude CLI proven by a probe requested during this connection),
   * `probe_pending` (connected, no probe answered yet on this connection),
   * `link_offline` / `link_stale` / `never_connected` (no usable link),
   * `identity_conflict` (the same credential keeps connecting from several
   * places), `protocol_incompatible` and `revoked`.
   */
  reason:
    | 'fresh_probe'
    | 'no_execution_capability'
    | 'probe_stale'
    | 'never_probed'
    | 'link_connected'
    | 'probe_pending'
    | 'link_offline'
    | 'link_stale'
    | 'never_connected'
    | 'identity_conflict'
    | 'protocol_incompatible'
    | 'revoked';
  lastSeenAt: string | null;
  freshUntil: string | null;
};

/**
 * Whether one project's workspace can be used on one node, as returned by the
 * runtime-nodes listing when it is asked about a project (FT-M08).
 *
 * - `available`: the local node, whose project path is the project itself.
 * - `mapped`: a remote node verified (itself, inside its own workspace root)
 *   the folder explicitly mapped to this project.
 * - `unmapped`: nobody mapped a folder on that node; nothing is assumed.
 * - `unavailable`: the local project folder is missing, or a node refused the
 *   mapped folder when it last checked.
 *
 * Paths are never part of this view.
 */
export type RuntimeNodeWorkspaceView = {
  state: 'available' | 'mapped' | 'unmapped' | 'unavailable';
  reason: string | null;
  verifiedAt: string | null;
};

/**
 * API-facing RuntimeNode returned by the runtime-nodes routes and used by the
 * sessions/handoff creation flows. `canExecute` is true for the local node and,
 * since FT-M08, for an enrolled remote node only while its authenticated link
 * is live and proven able to run Claude.
 */
export type RuntimeNodeView = {
  nodeId: string;
  label: string;
  isLocal: boolean;
  canExecute: boolean;
  platform: string | null;
  arch: string | null;
  runtimeVersion: string | null;
  availability: RuntimeNodeAvailability;
  capabilities: RuntimeNodeCapabilityView[];
  /**
   * Last Resource Governor report from a connected node agent; null for the
   * local node (not governed) and whenever no report arrived on the current link.
   */
  resources: RuntimeNodeResourcesView | null;
  /**
   * Who produced the capability evidence: this server probing itself, or an
   * authenticated remote node answering a probe this server asked for. A
   * remote node's answer is still that node's own report.
   */
  evidence: 'local_probe' | 'node_probe';
  /**
   * Credential lifecycle. `unenrolled` rows have no credential and can never
   * connect; `revoked` nodes are refused forever and closed immediately.
   */
  enrollment: 'local' | 'active' | 'revoked' | 'unenrolled';
  /** Present only when the listing was asked about one project. */
  workspace?: RuntimeNodeWorkspaceView;
};

/**
 * State of one project's LOCAL working copy on one RuntimeNode (FT-M09),
 * inspected by the machine that owns the folder. Never carries a path or a
 * file name. `identity` compares the repository's root commits with those the
 * node recorded when the folder was mapped.
 */
export type ProjectWorkspaceStateView = {
  state: 'clean' | 'dirty' | 'missing' | 'unavailable' | 'identity_mismatch' | 'diverged' | 'unmapped' | 'unknown';
  reason: string | null;
  identity: 'match' | 'mismatch' | 'unrecorded' | 'unknown';
  inspectedAt: string | null;
  git: {
    rootIsFolder: boolean;
    branch: string | null;
    detached: boolean;
    headCommit: string | null;
    upstream: { ahead: number; behind: number } | null;
  } | null;
  changes: {
    staged: number;
    modified: number;
    added: number;
    deleted: number;
    renamed: number;
    untracked: number;
    conflicted: number;
    total: number;
    truncated: boolean;
  } | null;
  sync: {
    syncable: number;
    localOnly: number;
    secret: number;
    userExcluded: number;
    secretContent: number;
    changesDigest: string | null;
    digestReason: string | null;
  } | null;
};

// ---------------------------
//----------------- RUNTIME NODE LINK PROTOCOL TYPES ------------
/**
 * Provider options a control plane forwards to a RuntimeNode for one run
 * (FT-M08). Deliberately a whitelist: nothing path-like (cwd comes from the
 * verified workspace mapping), no account binding (a remote node runs with its
 * own local provider login), and no attachments (they live on the control
 * plane's disk). Produced by the runtime-nodes module, consumed by the
 * node-agent module.
 */
export type RuntimeNodeLinkRunOptions = {
  model?: string;
  effort?: string;
  permissionMode?: string;
  toolsSettings?: unknown;
  sessionSummary?: string;
};

/**
 * Frames a control plane sends over an authenticated RuntimeNode link. Every
 * request carries an id minted by the control plane; a node answers only ids it
 * received, and the control plane accepts answers only to ids it is waiting
 * for. Produced by runtime-nodes, handled by node-agent.
 */
export type RuntimeNodeLinkServerFrame =
  | {
    type: 'welcome';
    nodeId: string;
    protocolVersion: number;
    serverTime: number;
    /** Answer to the node's `hello.activeExecutions`: which runs may keep streaming. */
    resume: Array<{ executionId: string; accepted: boolean; lastSeq: number }>;
  }
  | { type: 'probe.request'; requestId: string }
  | { type: 'workspace.verify'; requestId: string; path: string }
  /** FT-M09: read-only inspection of a folder the node confines to its own workspace root. */
  | { type: 'workspace.inspect'; requestId: string; path: string }
  | {
    type: 'run.start';
    executionId: string;
    appSessionId: string;
    provider: 'claude';
    providerSessionId: string | null;
    command: string;
    cwd: string;
    options: RuntimeNodeLinkRunOptions;
  }
  | { type: 'run.cancel'; executionId: string }
  | {
    type: 'approval.resolve';
    requestId: string;
    executionId: string;
    approvalId: string;
    decision: ProviderPermissionDecision;
  }
  | {
    type: 'history.fetch';
    requestId: string;
    appSessionId: string;
    providerSessionId: string;
    cwd: string;
    limit: number | null;
    offset: number;
  };

/**
 * Frames a RuntimeNode sends over its link. `seq` is per execution and
 * monotonic across `run.event`, `run.provider_session` and `run.finished`, so a
 * control plane can drop replays after a reconnect. Produced by node-agent,
 * validated field-by-field by runtime-nodes (never trusted as typed).
 */
export type RuntimeNodeLinkNodeFrame =
  | {
    type: 'hello';
    protocolVersion: number;
    runtimeVersion: string | null;
    platform: string | null;
    arch: string | null;
    activeExecutions: Array<{ executionId: string; lastSeq: number }>;
  }
  | { type: 'heartbeat' }
  | {
    type: 'probe.result';
    requestId: string;
    outcomes: Record<string, RuntimeNodeProbeOutcome>;
    /** FT-M09 Resource Governor report; validated field-by-field by runtime-nodes. */
    resources?: RuntimeNodeResourceReport | null;
  }
  | {
    type: 'workspace.result';
    requestId: string;
    ok: boolean;
    reason: string | null;
    /** The folder as the node resolved it (real path inside its workspace root) when `ok`. */
    path: string | null;
    /** FT-M09: root commits of the folder's Git history when it is a repository (identity, not a path). */
    rootCommits?: string[];
  }
  | { type: 'workspace.state'; requestId: string; ok: boolean; reason: string | null; observation: unknown }
  | { type: 'run.accepted'; executionId: string }
  | { type: 'run.rejected'; executionId: string; code: string }
  | { type: 'run.event'; executionId: string; seq: number; message: unknown }
  | { type: 'run.provider_session'; executionId: string; seq: number; providerSessionId: string }
  | { type: 'run.finished'; executionId: string; seq: number; outcome: 'completed' | 'failed' | 'aborted' }
  | { type: 'run.cancel_result'; executionId: string; aborted: boolean }
  | { type: 'approval.result'; requestId: string; resolution: ProviderPermissionResolution }
  | { type: 'history.result'; requestId: string; ok: boolean; result?: FetchHistoryResult; code?: string };

/**
 * One parsed `Authorization: CloudCLI-Node-v1 ...` upgrade header. Produced by
 * the shared node-link auth parser; the runtime-nodes link service verifies the
 * signature against the enrolled public key, the clock window and its nonce
 * cache before trusting `nodeId`.
 */
export type ParsedRuntimeNodeLinkAuthorization = {
  nodeId: string;
  timestamp: number;
  nonce: string;
  signature: string;
};

// ---------------------------
//----------------- ABUSE RATE LIMIT TYPES ------------
/**
 * In-memory failure limiter returned by `createFailureRateLimiter`. Used by
 * remote browser pairing (remote-access) and RuntimeNode enrollment
 * (runtime-nodes) so guessing a one-time code or a password is throttled per
 * client address and globally. `retryAfterMs` is 0 when an attempt is allowed.
 */
export type FailureRateLimiter = {
  check(clientKey: string): { allowed: boolean; retryAfterMs: number };
  recordFailure(clientKey: string): void;
  reset(clientKey: string): void;
};

// ---------------------------
//----------------- SHARED DATABASE CREDENTIAL TYPES ------------
/**
 * Safe credential view returned by credential listing APIs.
 *
 * This intentionally excludes the raw credential secret while still exposing
 * metadata needed for UI rendering and management operations.
 */
export type CredentialPublicRow = {
  id: number;
  credential_name: string;
  credential_type: string;
  description: string | null;
  created_at: string;
  is_active: number;
};

/**
 * Result returned after creating a credential record.
 *
 * Use this return shape when callers need the created id and display metadata,
 * but must never receive the stored secret value.
 */
export type CreateCredentialResult = {
  id: number | bigint;
  credentialName: string;
  credentialType: string;
};

// ---------------------------
//----------------- PROJECT PERSISTENCE TYPES ------------
/**
 * Canonical project row shape returned by the projects repository.
 *
 * Use this type whenever backend services need to pass around one database
 * project record without leaking raw SQL row typing across modules.
 */
export type ProjectRepositoryRow = {
  project_id: string;
  /** This control plane's working copy; null when the project has no copy here (FT-M10). */
  project_path: string | null;
  custom_project_name: string | null;
  isStarred: number;
  isArchived: number;
};

/**
 * Result category returned by `projectsDb.createProjectPath`.
 *
 * `created` means a fresh row was inserted, `reactivated_archived` means an
 * existing archived path was accepted and updated, and `active_conflict` means
 * an already-active path blocked project creation.
 */
export type CreateProjectPathOutcome =
  | 'created'
  | 'reactivated_archived'
  | 'active_conflict';

/**
 * Structured result returned by project-path upsert operations.
 *
 * Services should use this result to decide whether a request succeeded,
 * should return a conflict, or needs follow-up retrieval of row metadata.
 */
export type CreateProjectPathResult = {
  outcome: CreateProjectPathOutcome;
  project: ProjectRepositoryRow | null;
};

/**
 * Validation result for user-supplied workspace/project paths.
 *
 * `resolvedPath` is present only when validation succeeds. `error` is present
 * only when validation fails and is suitable for user-facing diagnostics.
 */
export type WorkspacePathValidationResult = {
  valid: boolean;
  resolvedPath?: string;
  error?: string;
};

// ---------------------------
//----------------- GIT WORKTREE MANAGEMENT ------------
/**
 * Captured output of one completed `git` invocation.
 *
 * Returned by `GitCommandRunner` implementations so worktree services can read
 * both streams without caring about process plumbing.
 */
export type GitCommandResult = {
  stdout: string;
  stderr: string;
};

/**
 * Executes `git <args>` inside `cwd` and resolves with the captured output.
 *
 * All worktree services receive their git access through this contract so
 * tests can inject a fake runner instead of spawning real processes. The
 * promise must reject (with `stderr` attached when available) on a non-zero
 * exit code.
 */
export type GitCommandRunner = (args: string[], cwd: string) => Promise<GitCommandResult>;

/**
 * One entry parsed from `git worktree list --porcelain`.
 *
 * This is the raw repository-level view (path/HEAD/branch/flags) before any
 * enrichment with project links or ahead/behind counts. `branch` is null for
 * detached-HEAD worktrees.
 */
export type WorktreePorcelainEntry = {
  path: string;
  headSha: string | null;
  branch: string | null;
  isDetached: boolean;
  isLocked: boolean;
  isPrunable: boolean;
};

/**
 * Fully enriched worktree row served to the UI.
 *
 * Extends the porcelain entry with everything the Worktrees panel renders:
 * dirty-file count, ahead/behind relative to the base branch (the branch
 * checked out in the main worktree), last-commit metadata, and the CloudCLI
 * project row linked to the worktree directory (if one was registered).
 */
export type WorktreeDescriptor = {
  path: string;
  branch: string | null;
  headSha: string | null;
  isMain: boolean;
  isCurrent: boolean;
  isLocked: boolean;
  isDetached: boolean;
  changedFileCount: number;
  ahead: number;
  behind: number;
  lastCommitSubject: string | null;
  lastCommitDate: string | null;
  linkedProjectId: string | null;
  linkedProjectArchived: boolean;
};

/**
 * Response payload of `GET /api/worktrees`.
 *
 * `baseBranch` is the branch checked out in the main worktree — the merge
 * target offered by the UI. `worktrees` always lists the main worktree first.
 */
export type WorktreeListResult = {
  repositoryRoot: string;
  baseBranch: string | null;
  worktrees: WorktreeDescriptor[];
};

// ---------------------------
//----------------- WORKTREE SERVICE INPUTS AND RESULTS ------------
/**
 * Input accepted by the worktree-listing workflow.
 *
 * `projectPath` may point at the main checkout or any linked worktree. The
 * service uses Git to resolve the complete repository-level worktree list.
 */
export type ListWorktreesInput = {
  projectPath: string;
};

/**
 * Input accepted when creating a linked Git worktree.
 *
 * `branch` is checked out when it already exists, otherwise it is created from
 * `baseBranch`. When `baseBranch` is omitted, the main worktree branch is used.
 */
export type CreateWorktreeInput = {
  projectPath: string;
  branch: string;
  baseBranch?: string | null;
};

/**
 * Result of successfully creating a linked Git worktree.
 *
 * `createdBranch` distinguishes a new branch from an existing branch checkout,
 * allowing API clients to accurately describe what Git changed.
 */
export type CreateWorktreeResult = {
  worktreePath: string;
  branch: string;
  createdBranch: boolean;
};

/**
 * Result of atomically creating and registering a worktree for project use.
 *
 * The Worktrees application service compensates the Git creation if project
 * registration fails, so routes only receive this shape after both steps pass.
 */
export type CreateAndOpenWorktreeResult = CreateWorktreeResult & {
  project: WorktreeProjectView;
};

/**
 * Input accepted when registering an existing worktree as a CloudCLI project.
 *
 * The service verifies that `worktreePath` belongs to the repository containing
 * `projectPath` before it creates or restores any project record.
 */
export type OpenWorktreeInput = {
  projectPath: string;
  worktreePath: string;
};

/**
 * Project view returned after a worktree is opened in CloudCLI.
 *
 * This deliberately mirrors the project-selection payload used by the Projects
 * module so the frontend can switch to the worktree without another lookup.
 */
export type WorktreeProjectView = {
  projectId: string;
  path: string;
  fullPath: string;
  displayName: string;
  isStarred: boolean;
  sessions: [];
  sessionMeta: { hasMore: false; total: 0 };
};

/**
 * Input accepted when removing a linked Git worktree.
 *
 * `force` permits removal with local changes. `deleteBranch` requests
 * best-effort branch cleanup after the worktree directory is removed.
 */
export type RemoveWorktreeInput = {
  projectPath: string;
  worktreePath: string;
  force?: boolean;
  deleteBranch?: boolean;
};

/**
 * Result of removing a linked Git worktree.
 *
 * `archivalError` reports best-effort project archival failure after Git has
 * already removed the worktree, allowing callers to represent partial success.
 */
export type RemoveWorktreeResult = {
  removedPath: string;
  branch: string | null;
  branchDeleted: boolean;
  archivedProjectId: string | null;
  archivalError: string | null;
};

/**
 * Input accepted when merging a linked worktree into the main worktree branch.
 *
 * The service verifies both worktrees are clean, supports squash and regular
 * merges, and may remove the source worktree after a successful merge.
 */
export type MergeWorktreeInput = {
  projectPath: string;
  worktreePath: string;
  squash?: boolean;
  message?: string | null;
  removeAfterMerge?: boolean;
};

/**
 * Result of a completed worktree merge.
 *
 * `removedWorktree` is populated only when post-merge removal succeeds.
 * `cleanupError` reports failed optional removal without misrepresenting the
 * already-completed merge as a failure.
 */
export type MergeWorktreeResult = {
  mergedBranch: string;
  targetBranch: string;
  squash: boolean;
  removedWorktree: RemoveWorktreeResult | null;
  cleanupError: string | null;
};

// ---------------------------
//----------------- WORKTREE MODULE DEPENDENCY CONTRACTS ------------
/**
 * Filesystem capability required by the Worktrees module.
 *
 * Production wiring checks the real filesystem; unit tests provide a small
 * deterministic fake so worktree creation never touches developer directories.
 */
export type WorktreeFileSystem = {
  pathExists(candidatePath: string): Promise<boolean>;
};

/**
 * Project-management boundary consumed by Worktrees workflows.
 *
 * The Worktrees module uses this contract instead of importing Database or
 * Projects internals. Production adapters delegate through those modules'
 * `index.ts` barrels, while unit tests supply in-memory functions.
 */
export type WorktreeProjectGateway = {
  getProjectPathById(projectId: string): string | null;
  getProjectByPath(projectPath: string): ProjectRepositoryRow | null;
  createProject(input: {
    projectPath: string;
    customName: string;
  }): Promise<{
    outcome: 'created' | 'reactivated_archived';
    project: { projectId: string };
  }>;
  restoreProject(projectId: string): void | Promise<void>;
  archiveProject(projectId: string): void | Promise<void>;
};

/**
 * Complete application-service surface used by the Worktrees HTTP router.
 *
 * Routes parse transport values and call these functions; they do not import
 * repositories, filesystem adapters, Git runners, or individual service files.
 */
export type WorktreeServices = {
  resolveProjectPath(projectId: string): string;
  list(input: ListWorktreesInput): Promise<WorktreeListResult>;
  create(input: CreateWorktreeInput): Promise<CreateWorktreeResult>;
  createAndOpen(input: CreateWorktreeInput): Promise<CreateAndOpenWorktreeResult>;
  open(input: OpenWorktreeInput): Promise<WorktreeProjectView>;
  merge(input: MergeWorktreeInput): Promise<MergeWorktreeResult>;
  remove(input: RemoveWorktreeInput): Promise<RemoveWorktreeResult>;
};

// ---------------------------
//----------------- FILE TREE MODULE CONTRACTS ------------
/**
 * One filesystem item returned by the File Tree API.
 *
 * The service populates metadata without following symlinks and recursively
 * attaches `children` only while the requested depth permits traversal. The
 * frontend uses the absolute `path` as the stable identifier for editor and
 * file-operation requests.
 */
export type FileTreeNode = {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
  modified: string | null;
  permissions: string;
  permissionsRwx: string;
  isSymlink?: boolean;
  children?: FileTreeNode[];
};

/**
 * Minimal directory-entry shape required during File Tree traversal.
 *
 * Production adapts Node `Dirent` objects to this structural contract. Tests
 * provide small handwritten entries and therefore never read real directories.
 */
export type FileTreeDirectoryEntry = {
  name: string;
  isDirectory(): boolean;
};

/**
 * Minimal file-stat shape used for tree metadata and delete decisions.
 *
 * The numeric mode is converted to octal and rwx strings for the UI. `lstat`
 * supplies symlink state while `stat` is used when deciding file versus folder
 * deletion behavior.
 */
export type FileTreeStats = {
  size: number;
  mtime: Date;
  mode: number;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
};

/**
 * Complete filesystem capability injected into File Tree services.
 *
 * The production composition root delegates these operations to Node's fs
 * APIs. Unit tests provide deterministic path-keyed fakes so service tests
 * cannot inspect, write, rename, or delete developer files.
 */
export type FileTreeFileSystem = {
  access(candidatePath: string): Promise<void>;
  stat(candidatePath: string): Promise<FileTreeStats>;
  lstat(candidatePath: string): Promise<FileTreeStats>;
  // Streamed rather than returned as an array so a directory with millions of
  // children is abandoned at the entry limit instead of being materialized.
  openDirectory(directoryPath: string): AsyncIterable<FileTreeDirectoryEntry>;
  realpath(candidatePath: string): Promise<string>;
  readTextFile(filePath: string): Promise<string>;
  writeTextFile(filePath: string, content: string): Promise<void>;
  makeDirectory(directoryPath: string, recursive: boolean): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  removeDirectory(directoryPath: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
  copyFile(sourcePath: string, destinationPath: string): Promise<void>;
  createReadStream(filePath: string): Readable;
};

/**
 * Project lookup boundary consumed by File Tree workflows.
 *
 * File Tree services resolve DB-assigned project ids through this contract and
 * never import the Database module or its repositories directly.
 */
export type FileTreeProjectGateway = {
  getProjectPathById(projectId: string): string | null | Promise<string | null>;
};

/**
 * Workspace validation boundary used by filesystem browsing and folder creation.
 *
 * The injected validator enforces the configured workspace root and resolves
 * symlinks before the File Tree service exposes or mutates paths.
 */
export type FileTreeWorkspaceGateway = {
  rootPath: string;
  validatePath(candidatePath: string): Promise<WorkspacePathValidationResult>;
};

/**
 * Uploaded-file record passed from the Multer transport adapter into the File
 * Tree service.
 *
 * Transport-specific field names are normalized so upload workflows do not
 * depend on Express or Multer types.
 */
export type FileTreeUploadedFile = {
  originalName: string;
  temporaryPath: string;
  size: number;
  mimeType: string;
};

/**
 * Logger boundary for expected File Tree diagnostics.
 *
 * Production delegates to the server console. Unit tests use no-op or captured
 * loggers and never patch the global console singleton.
 */
export type FileTreeLogger = {
  error(message: string, error?: unknown): void;
};

/**
 * Required production dependencies for the File Tree application service.
 *
 * Filesystem, project lookup, workspace policy, MIME detection, concurrency,
 * and logging are all explicit so service construction has no hidden process,
 * repository, or machine-wide defaults.
 */
export type FileTreeServiceDependencies = {
  fileSystem: FileTreeFileSystem;
  projects: FileTreeProjectGateway;
  workspace: FileTreeWorkspaceGateway;
  resolveMimeType(filePath: string): string;
  fileSystemConcurrency: number;
  logger: FileTreeLogger;
};

/**
 * Complete File Tree application-service surface consumed by HTTP routes.
 *
 * Routes parse transport inputs and call these methods; they never resolve
 * project repositories, validate filesystem ownership, or perform filesystem
 * mutations themselves.
 */
export type FileTreeServices = {
  browseWorkspace(inputPath: string | null): Promise<{
    path: string;
    suggestions: Array<{ path: string; name: string; type: 'directory' }>;
  }>;
  createWorkspaceFolder(folderPath: string): Promise<{ success: true; path: string }>;
  readTextFile(projectId: string, filePath: string): Promise<{ content: string; path: string }>;
  openFile(projectId: string, filePath: string): Promise<{ contentType: string; stream: Readable }>;
  saveTextFile(projectId: string, filePath: string, content: string): Promise<{
    success: true;
    path: string;
    message: string;
  }>;
  listProjectFiles(
    projectId: string,
    options?: { respectGitignore: boolean },
  ): Promise<FileTreeNode[]>;
  createEntry(input: {
    projectId: string;
    parentPath: string;
    type: 'file' | 'directory';
    name: string;
  }): Promise<{ success: true; path: string; name: string; type: 'file' | 'directory'; message: string }>;
  renameEntry(input: { projectId: string; oldPath: string; newName: string }): Promise<{
    success: true;
    oldPath: string;
    newPath: string;
    newName: string;
    message: string;
  }>;
  deleteEntry(input: { projectId: string; targetPath: string }): Promise<{
    success: true;
    path: string;
    type: 'file' | 'directory';
    message: string;
  }>;
  storeUploadedFiles(input: {
    projectId: string;
    targetPath: string;
    relativePaths: string[];
    requestedFileCount: number;
    files: FileTreeUploadedFile[];
  }): Promise<{
    success: true;
    files: Array<{ name: string; path: string; size: number; mimeType: string }>;
    uploadedCount: number;
    requestedFileCount: number;
    targetPath: string;
    message: string;
  }>;
};

// ---------------------------
//----------------- VOICE MODULE CONTRACTS ------------
/**
 * Per-request voice settings parsed from authenticated HTTP headers.
 *
 * The Voice routes create this value from the optional `x-voice-*` headers and
 * pass it to the Voice service. Empty values mean "use the server-configured
 * default"; the backend base URL is intentionally absent because clients must
 * never control the server's outbound destination.
 */
export type VoiceRequestOverrides = {
  apiKey?: string;
  sttModel?: string;
  ttsModel?: string;
  ttsVoice?: string;
  ttsFormat?: string;
};

/**
 * Uploaded audio accepted by the Voice transcription service.
 *
 * Routes translate Multer's transport-specific file object into this minimal
 * shape so the service does not depend on Express or Multer types.
 */
export type VoiceAudioUpload = {
  bytes: Buffer;
  mimeType: string;
  fileName: string;
};

/**
 * Successful speech payload returned by the Voice service.
 *
 * The route copies `contentType` to the client response and pipes `body`
 * without buffering the complete synthesized audio in application memory.
 */
export type VoiceSpeechPayload = {
  contentType: string;
  body: ReadableStream<Uint8Array> | null;
};

/**
 * Explicit service result used by Voice routes instead of transport-aware
 * exceptions.
 *
 * Services return `ok: false` with the exact client status/message for expected
 * backend, validation, and timeout failures. Routes only translate the result
 * into HTTP output, while unexpected programming errors still reject normally.
 */
export type VoiceServiceResult<TValue> =
  | { ok: true; value: TValue }
  | { ok: false; status: number; error: string };

/**
 * Complete application-service surface consumed by the Voice HTTP router.
 *
 * The composition root supplies a concrete implementation with environment
 * configuration and an injected outbound HTTP adapter. Unit tests use the same
 * contract with handwritten fetch fakes and never patch global state.
 */
export type VoiceService = {
  getHealth(): { configured: boolean };
  transcribe(input: {
    audio: VoiceAudioUpload;
    overrides: VoiceRequestOverrides;
  }): Promise<VoiceServiceResult<{ text: string }>>;
  synthesizeSpeech(input: {
    text: string;
    overrides: VoiceRequestOverrides;
  }): Promise<VoiceServiceResult<VoiceSpeechPayload>>;
};

// ---------------------------
//----------------- CLI MODULE CONTRACTS ------------
/**
 * Output boundary used by the CLI and Sandbox services.
 *
 * Production wiring delegates to the real console. Unit tests collect these
 * calls in arrays, which keeps command assertions deterministic and avoids
 * monkey-patching the global console singleton.
 */
export type CliOutput = {
  log(message?: string): void;
  error(message?: string): void;
};

/**
 * Minimal synchronous filesystem surface shared by CLI status reporting and
 * sandbox workspace validation.
 *
 * The production composition root adapts Node's filesystem module. Tests supply
 * path-keyed fakes, so service tests never inspect or modify the real machine.
 */
export type CliFileSystem = {
  pathExists(filePath: string): boolean;
  getFileStats(filePath: string): { size: number; modifiedAt: Date };
};

/**
 * Mutable environment view owned by the CLI application.
 *
 * CLI options update this object before the server starts. Production passes
 * `process.env`; tests pass a plain record to verify option precedence without
 * changing process-wide environment state.
 */
export type CliEnvironment = Record<string, string | undefined>;

/**
 * Package metadata displayed by CLI help, status, version, and update commands.
 *
 * The composition root reads this once from the application package file and
 * injects only the fields the service needs.
 */
export type CliPackageMetadata = {
  version: string;
  homepage?: string;
  bugsUrl?: string;
};

/**
 * Executable CLI application returned by the CLI composition root.
 *
 * The thin executable entrypoint passes `process.argv` arguments to `run` and
 * copies the returned code to `process.exitCode`. Tests invoke the same method
 * directly with isolated dependencies.
 */
export type CliApplication = {
  run(argumentsList: string[]): Promise<number>;
};

/**
 * Sandbox command service consumed by the top-level CLI command dispatcher.
 *
 * Keeping this behind one required dependency lets CLI tests use a tiny fake,
 * while focused Sandbox tests exercise subprocess and filesystem behavior with
 * their own handwritten adapters.
 */
export type SandboxCommandService = {
  execute(argumentsList: string[]): Promise<number>;
};
