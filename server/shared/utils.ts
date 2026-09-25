import { createHash, createPrivateKey, createPublicKey, randomBytes, randomUUID, sign, verify } from 'node:crypto';
import fs from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { parseFrontMatter } from '@/shared/frontmatter.js';
import type {
  AnyRecord,
  ApiSuccessShape,
  AppErrorOptions,
  FailureRateLimiter,
  NormalizedMessage,
  ParsedRuntimeNodeLinkAuthorization,
  ProviderCurrentActiveModel,
  ProviderModelsDefinition,
  ProviderSkillSource,
  WorkspacePathValidationResult,
} from '@/shared/types.js';

//----------------- ENVIRONMENT UTILITIES ------------
/**
 * Indicates whether the backend is running in hosted Platform mode rather than
 * self-hosted OSS mode. The server bootstrap, Agent, Auth, and Browser Use
 * modules use this shared flag to keep environment-dependent behavior aligned.
 * Environment variables must be loaded before this module is evaluated.
 */
export const IS_PLATFORM = process.env.VITE_IS_PLATFORM === 'true';

/**
 * What this process is (FT-M11). `control-plane` is the user's CloudCLI server,
 * which is also its own local RuntimeNode. `hosted-relay` coordinates browsers
 * and outbound RuntimeNodes and never executes anything itself: it has no
 * local node, no local workspace and no local provider runtime.
 */
export type ServerRole = 'control-plane' | 'hosted-relay';

let serverRole: ServerRole = 'control-plane';

/** Set once by the Hosted Relay entrypoint before it serves anything; tests may reset it. */
export function setServerRole(role: ServerRole): void {
  serverRole = role;
}

/** Read at call time by modules whose "no target" default would otherwise mean this machine. */
export function isHostedRelayRole(): boolean {
  return serverRole === 'hosted-relay';
}

// ---------------------------
//----------------- NORMALIZED MESSAGE HELPER INPUT TYPES ------------
/**
 * Input payload accepted by `createNormalizedMessage`.
 *
 * Callers provide provider-specific fields plus the required `kind/provider`
 * pair; this helper fills missing envelope fields (`id`, `sessionId`,
 * `timestamp`) in a consistent way.
 */
type NormalizedMessageInput =
  {
    kind: NormalizedMessage['kind'];
    provider: NormalizedMessage['provider'];
    id?: string | null;
    sessionId?: string | null;
    timestamp?: string | null;
  } & Record<string, unknown>;

// ---------------------------
//----------------- HTTP HANDLER UTILITIES ------------
/**
 * Wraps arbitrary data in the standard API success envelope.
 *
 * Use this helper in route handlers to keep successful JSON responses consistent
 * across endpoints.
 */
export function createApiSuccessResponse<TData>(
  data: TData,
): ApiSuccessShape<TData> {
  return {
    success: true,
    data,
  };
}

/**
 * Converts an async Express handler into a standard `RequestHandler` and routes
 * rejected promises to Express error middleware.
 *
 * Use this to avoid repeating `try/catch(next)` in every async route.
 */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve(handler(req, res, next)).catch(next);
  };
}

// ---------------------------
//----------------- SHARED ERROR UTILITIES ------------
/**
 * Shared application error with HTTP status and machine-readable code metadata.
 *
 * Throw this from service/route layers when the caller should receive a
 * controlled error response rather than a generic 500.
 */
export class AppError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(message: string, options: AppErrorOptions = {}) {
    super(message);
    this.name = 'AppError';
    this.code = options.code ?? 'INTERNAL_ERROR';
    this.statusCode = options.statusCode ?? 500;
    this.details = options.details;
  }
}

// ---------------------------
//----------------- WORKSPACE PATH VALIDATION UTILITIES ------------
/**
 * Root directory that all workspace/project paths must stay under.
 *
 * This is resolved from `WORKSPACES_ROOT` when configured; otherwise it falls
 * back to the current user's home directory.
 */
export const WORKSPACES_ROOT = process.env.WORKSPACES_ROOT || os.homedir();

/**
 * System-critical paths that must never be used as workspace roots.
 *
 * The validation helper blocks these values directly and also blocks paths
 * nested under them (with explicit allow-list exceptions where necessary).
 */
export const FORBIDDEN_WORKSPACE_PATHS = [
  // Unix
  '/',
  '/etc',
  '/bin',
  '/sbin',
  '/usr',
  '/dev',
  '/proc',
  '/sys',
  '/var',
  '/boot',
  '/root',
  '/lib',
  '/lib64',
  '/opt',
  '/tmp',
  '/run',
  // Windows
  'C:\\Windows',
  'C:\\Program Files',
  'C:\\Program Files (x86)',
  'C:\\ProgramData',
  'C:\\System Volume Information',
  'C:\\$Recycle.Bin',
];

function stripWindowsLongPathPrefix(inputPath: string): string {
  if (inputPath.startsWith('\\\\?\\UNC\\')) {
    return `\\\\${inputPath.slice('\\\\?\\UNC\\'.length)}`;
  }

  if (inputPath.startsWith('\\\\?\\')) {
    return inputPath.slice('\\\\?\\'.length);
  }

  return inputPath;
}

function shouldUseWindowsPathNormalization(inputPath: string): boolean {
  if (process.platform === 'win32') {
    return true;
  }

  return inputPath.startsWith('\\\\') || /^[a-zA-Z]:([\\/]|$)/.test(inputPath);
}

/**
 * Canonicalizes project/workspace paths for stable DB keys and comparisons.
 *
 * Normalization rules:
 * - trim whitespace
 * - strip Windows long-path prefixes (`\\?\` and `\\?\UNC\`)
 * - normalize path separators and dot segments
 * - trim trailing separators except for filesystem roots
 */
export function normalizeProjectPath(inputPath: string): string {
  if (typeof inputPath !== 'string') {
    return '';
  }

  const trimmed = inputPath.trim();
  if (!trimmed) {
    return '';
  }

  const withoutLongPrefix = stripWindowsLongPathPrefix(trimmed);
  const useWindowsPathRules = shouldUseWindowsPathNormalization(withoutLongPrefix);
  const normalized = useWindowsPathRules
    ? path.win32.normalize(withoutLongPrefix)
    : path.posix.normalize(withoutLongPrefix);

  if (!normalized) {
    return '';
  }

  const parser = useWindowsPathRules ? path.win32 : path.posix;
  const root = parser.parse(normalized).root;
  if (normalized === root) {
    return normalized;
  }

  return normalized.replace(/[\\/]+$/, '');
}

/**
 * Validates that a user-supplied workspace path is safe to use.
 *
 * Call this before any filesystem mutation that creates or registers projects.
 * The function resolves symlinks, enforces `WORKSPACES_ROOT` containment, and
 * blocks known system directories.
 */
export async function validateWorkspacePath(requestedPath: string): Promise<WorkspacePathValidationResult> {
  try {
    const normalizedRequestedPath = normalizeProjectPath(requestedPath);
    if (!normalizedRequestedPath) {
      return {
        valid: false,
        error: 'Workspace path is required',
      };
    }

    const absolutePath = path.resolve(normalizedRequestedPath);
    const normalizedPath = normalizeProjectPath(absolutePath);

    if (FORBIDDEN_WORKSPACE_PATHS.includes(normalizedPath) || normalizedPath === '/') {
      return {
        valid: false,
        error: 'Cannot use system-critical directories as workspace locations',
      };
    }

    for (const forbiddenPath of FORBIDDEN_WORKSPACE_PATHS) {
      const normalizedForbiddenPath = normalizeProjectPath(forbiddenPath);
      if (
        normalizedPath === normalizedForbiddenPath
        || normalizedPath.startsWith(`${normalizedForbiddenPath}${path.sep}`)
      ) {
        // Allow specific user-writable folders under /var.
        if (
          normalizedForbiddenPath === '/var'
          && (normalizedPath.startsWith('/var/tmp') || normalizedPath.startsWith('/var/folders'))
        ) {
          continue;
        }

        return {
          valid: false,
          error: `Cannot create workspace in system directory: ${forbiddenPath}`,
        };
      }
    }

    let resolvedPath = normalizeProjectPath(absolutePath);
    try {
      await access(absolutePath);
      resolvedPath = normalizeProjectPath(await realpath(absolutePath));
    } catch (error) {
      const fileError = error as NodeJS.ErrnoException;
      if (fileError.code !== 'ENOENT') {
        throw fileError;
      }

      const parentPath = path.dirname(absolutePath);
      try {
        const parentRealPath = await realpath(parentPath);
        resolvedPath = normalizeProjectPath(path.join(parentRealPath, path.basename(absolutePath)));
      } catch (parentError) {
        const parentFileError = parentError as NodeJS.ErrnoException;
        if (parentFileError.code !== 'ENOENT') {
          throw parentFileError;
        }
      }
    }

    const resolvedWorkspaceRoot = normalizeProjectPath(await realpath(WORKSPACES_ROOT));
    if (
      !resolvedPath.startsWith(`${resolvedWorkspaceRoot}${path.sep}`)
      && resolvedPath !== resolvedWorkspaceRoot
    ) {
      return {
        valid: false,
        error: `Workspace path must be within the allowed workspace root: ${WORKSPACES_ROOT}`,
      };
    }

    try {
      await access(absolutePath);
      const pathStats = await lstat(absolutePath);
      if (pathStats.isSymbolicLink()) {
        const symlinkTarget = await readlink(absolutePath);
        const resolvedSymlinkPath = path.resolve(path.dirname(absolutePath), symlinkTarget);
        const realSymlinkPath = await realpath(resolvedSymlinkPath);
        if (
          !realSymlinkPath.startsWith(`${resolvedWorkspaceRoot}${path.sep}`)
          && realSymlinkPath !== resolvedWorkspaceRoot
        ) {
          return {
            valid: false,
            error: 'Symlink target is outside the allowed workspace root',
          };
        }
      }
    } catch (error) {
      const fileError = error as NodeJS.ErrnoException;
      if (fileError.code !== 'ENOENT') {
        throw fileError;
      }
    }

    return {
      valid: true,
      resolvedPath,
    };
  } catch (error) {
    return {
      valid: false,
      error: `Path validation failed: ${(error as Error).message}`,
    };
  }
}

// ---------------------------
//----------------- NORMALIZED PROVIDER MESSAGE UTILITIES ------------
/**
 * Generates a stable unique id for normalized provider messages.
 */
export function generateMessageId(prefix = 'msg'): string {
  return `${prefix}_${randomUUID()}`;
}

/**
 * Creates a normalized provider message and fills the shared envelope fields.
 *
 * Provider adapters and live SDK handlers pass through provider-specific fields,
 * while this helper guarantees every emitted event has an id, session id,
 * timestamp, and provider marker.
 */
export function createNormalizedMessage(fields: NormalizedMessageInput): NormalizedMessage {
  return {
    ...fields,
    id: fields.id || generateMessageId(fields.kind),
    sessionId: fields.sessionId || '',
    timestamp: fields.timestamp || new Date().toISOString(),
    provider: fields.provider,
  };
}

/**
 * Build the unified terminal `complete` lifecycle message.
 *
 * Contract: every provider run ends with exactly one `complete` (the
 * abort-session handler emits it on behalf of cancelled runs, so aborted runs
 * must NOT emit their own). The frontend treats `complete` as the only
 * terminal signal and never needs provider-specific handling:
 *
 * - `sessionId`     — the id the client knows this run by ('' if never discovered)
 * - `actualSessionId` — canonical id after the run; equals `sessionId` unless
 *                       the provider rewrote it mid-run
 * - `exitCode`      — 0 on success; a missing/null code (e.g. killed process)
 *                     is reported as failure
 * - `success`       — exitCode === 0 and not aborted
 * - `aborted`       — run was cancelled by the user
 */
export function createCompleteMessage(opts: {
  provider: NormalizedMessage['provider'];
  sessionId?: string | null;
  actualSessionId?: string | null;
  exitCode?: number | null;
  aborted?: boolean;
}): NormalizedMessage {
  const exitCode = typeof opts.exitCode === 'number' ? opts.exitCode : 1;
  const aborted = Boolean(opts.aborted);

  return createNormalizedMessage({
    kind: 'complete',
    provider: opts.provider,
    sessionId: opts.sessionId || null,
    actualSessionId: opts.actualSessionId || opts.sessionId || null,
    exitCode,
    success: exitCode === 0 && !aborted,
    aborted,
  });
}

// ---------------------------
//----------------- CONVERSATION HISTORY PAGINATION UTILITIES ------------
/**
 * Slices one page from the END of a chronologically ordered message list.
 *
 * This is the single pagination contract for conversation history across all
 * providers: `offset = 0` returns the most recent `limit` items, increasing
 * offsets walk backwards in time (for "scroll up to load older" UIs), and a
 * `null` limit returns everything. Items must already be sorted oldest-first;
 * the returned page preserves that order.
 *
 * Every provider history reader must use this helper instead of slicing
 * manually so `offset`/`limit` query params behave identically regardless of
 * which provider produced the session.
 */
export function sliceTailPage<T>(
  items: T[],
  limit: number | null,
  offset: number,
): { page: T[]; hasMore: boolean } {
  const total = items.length;
  const normalizedOffset = Math.max(0, offset);

  if (limit === null) {
    // A null limit returns the full list; offset still trims newest entries
    // so "everything before the page I already have" stays expressible.
    const end = Math.max(0, total - normalizedOffset);
    return {
      page: items.slice(0, end),
      hasMore: false,
    };
  }

  const end = Math.max(0, total - normalizedOffset);
  const start = Math.max(0, end - Math.max(0, limit));
  return {
    page: items.slice(start, end),
    hasMore: start > 0,
  };
}

// ---------------------------
//----------------- MCP CONFIG PARSING UTILITIES ------------
/**
 * Safely narrows an unknown value to a plain object record.
 *
 * This deliberately rejects arrays, `null`, and primitive values so callers can
 * treat the returned value as a JSON-style object map without repeating the same
 * defensive shape checks at every config read site.
 */
export const readObjectRecord = (value: any): AnyRecord | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return value as AnyRecord;
};

/**
 * Reads an optional string from unknown input and normalizes empty or whitespace-only
 * values to `undefined`.
 *
 * This is useful when parsing config files where a field may be missing, present
 * with the wrong type, or present as an empty string that should be treated as
 * "not configured".
 */
export const readOptionalString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
};

/**
 * Reads an optional string array from unknown input.
 *
 * Non-array values are ignored, and any array entries that are not strings are
 * filtered out. This lets provider config readers consume loosely shaped JSON/TOML
 * data without failing on incidental invalid members.
 */
export const readStringArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.filter((entry): entry is string => typeof entry === 'string');
};

/**
 * Reads an optional string-to-string map from unknown input.
 *
 * The function first ensures the source value is a plain object, then keeps only
 * keys whose values are strings. If no valid entries remain, it returns `undefined`
 * so callers can distinguish "no usable map" from an empty object that was
 * intentionally authored downstream.
 */
export const readStringRecord = (value: unknown): Record<string, string> | undefined => {
  const record = readObjectRecord(value);
  if (!record) {
    return undefined;
  }

  const normalized: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === 'string') {
      normalized[key] = entry;
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
};

// ---------------------------
//----------------- PROVIDER MODEL LOOKUP UTILITIES ------------
/**
 * Builds the standard "default current model" result used when a provider
 * cannot resolve a session-backed active model.
 *
 * Provider model adapters should call this after loading their supported model
 * catalog so the fallback stays aligned with the provider's current `DEFAULT`
 * selection instead of drifting to a hard-coded duplicate.
 */
export function buildDefaultProviderCurrentActiveModel(
  models: ProviderModelsDefinition,
): ProviderCurrentActiveModel {
  return {
    model: models.DEFAULT,
  };
}

// ---------------------------
//----------------- WEBSOCKET PAYLOAD PARSING UTILITIES ------------
/**
 * Parses one websocket message payload into a plain JSON object record.
 *
 * Use this in realtime handlers that receive raw websocket payloads as `string`,
 * `Buffer`, `ArrayBuffer`, or chunk arrays. The helper converts supported
 * payload formats to UTF-8 text, parses JSON, and returns only object payloads.
 * Primitive/array/invalid payloads return `null` so callers can handle bad input
 * without throwing from deeply nested message handlers.
 */
export const parseIncomingJsonObject = (payload: unknown): AnyRecord | null => {
  let text: string | null = null;

  if (typeof payload === 'string') {
    text = payload;
  } else if (Buffer.isBuffer(payload)) {
    text = payload.toString('utf8');
  } else if (payload instanceof ArrayBuffer) {
    text = Buffer.from(payload).toString('utf8');
  } else if (Array.isArray(payload)) {
    const buffers = payload
      .map((entry) => {
        if (Buffer.isBuffer(entry)) {
          return entry;
        }

        if (entry instanceof ArrayBuffer) {
          return Buffer.from(entry);
        }

        if (ArrayBuffer.isView(entry)) {
          return Buffer.from(entry.buffer, entry.byteOffset, entry.byteLength);
        }

        return null;
      })
      .filter((entry): entry is Buffer => entry !== null);

    if (buffers.length > 0) {
      text = Buffer.concat(buffers).toString('utf8');
    }
  }

  if (typeof text !== 'string' || text.trim().length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    return readObjectRecord(parsed);
  } catch {
    return null;
  }
};

/**
 * Reads a JSON config file and guarantees a plain object result.
 *
 * Missing files are treated as an empty config object so provider-specific MCP
 * readers can operate against first-run environments without special-case file
 * existence checks. If the file exists but contains invalid JSON, the parse error
 * is preserved and rethrown.
 */
export const readJsonConfig = async (filePath: string): Promise<Record<string, unknown>> => {
  try {
    const content = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return readObjectRecord(parsed) ?? {};
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {};
    }

    throw error;
  }
};

/**
 * Writes a JSON config file with stable, human-readable formatting.
 *
 * The parent directory is created automatically so callers can persist config into
 * provider-specific folders without pre-creating the directory tree. Output always
 * ends with a trailing newline to keep the file diff-friendly.
 */
export const writeJsonConfig = async (filePath: string, data: Record<string, unknown>): Promise<void> => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
};

// ---------------------------
//----------------- PROVIDER SKILL FILE UTILITIES ------------
async function hasGitMarker(dirPath: string): Promise<boolean> {
  try {
    const gitMarkerStats = await stat(path.join(dirPath, '.git'));
    return gitMarkerStats.isDirectory() || gitMarkerStats.isFile();
  } catch {
    return false;
  }
}

/**
 * Finds the highest git worktree root visible from a starting directory.
 *
 * Provider skill systems such as Codex and OpenCode walk upward through parent
 * folders when resolving repository/project skills. Use this helper when a
 * provider needs the topmost `.git` marker instead of only the nearest one, so
 * monorepos and nested package folders discover shared root-level skills once.
 */
export async function findTopmostGitRoot(startPath: string): Promise<string | null> {
  let currentPath = path.resolve(startPath);
  let topmostGitRoot: string | null = null;

  while (true) {
    if (await hasGitMarker(currentPath)) {
      topmostGitRoot = currentPath;
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      break;
    }

    currentPath = parentPath;
  }

  return topmostGitRoot;
}

/**
 * Adds one provider skill source after normalizing and de-duplicating its root.
 *
 * Provider skill lookup rules often point at overlapping folders (for example a
 * workspace folder can also be the git root). Use this helper while building a
 * provider's `ProviderSkillSource[]` so the shared skills scanner reads each
 * physical root once and still preserves provider-specific scope/command data.
 */
export function addUniqueProviderSkillSource(
  sources: ProviderSkillSource[],
  seenRootDirs: Set<string>,
  source: ProviderSkillSource,
): void {
  const normalizedRootDir = path.resolve(source.rootDir);
  if (seenRootDirs.has(normalizedRootDir)) {
    return;
  }

  seenRootDirs.add(normalizedRootDir);
  sources.push({ ...source, rootDir: normalizedRootDir });
}

// ---------------------------
//----------------- PROVIDER SKILL MARKDOWN UTILITIES ------------
/**
 * Finds direct child skill markdown files under a provider skill root.
 *
 * Skill systems usually store one skill per child directory, so direct mode
 * scans only `<root>/<skill-name>/SKILL.md`. Recursive mode is reserved for
 * provider sources that can nest skills arbitrarily, and it returns every
 * descendant `SKILL.md`. Missing or unreadable roots return an empty list
 * because users may not have every provider installed or configured.
 */
export async function findProviderSkillMarkdownFiles(
  rootDir: string,
  options: { recursive?: boolean } = {},
): Promise<string[]> {
  const skillFiles: string[] = [];

  const collectRecursive = async (dirPath: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    try {
      const skillPath = path.join(dirPath, 'SKILL.md');
      const skillStats = await stat(skillPath);
      if (skillStats.isFile()) {
        skillFiles.push(skillPath);
      }
    } catch {
      // Directories without SKILL.md are expected while walking plugin trees.
    }

    for (const entry of entries) {
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        await collectRecursive(path.join(dirPath, entry.name));
      }
    }
  };

  if (options.recursive) {
    await collectRecursive(rootDir);
    return skillFiles.sort((left, right) => left.localeCompare(right));
  }

  try {
    const entries = await readdir(rootDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) {
        continue;
      }

      const skillPath = path.join(rootDir, entry.name, 'SKILL.md');
      try {
        const skillStats = await stat(skillPath);
        if (skillStats.isFile()) {
          skillFiles.push(skillPath);
        }
      } catch {
        // A partial skill directory should not block discovery of sibling skills.
      }
    }

    return skillFiles.sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

/**
 * Reads the `name` and `description` fields from a provider skill markdown file.
 *
 * The metadata is expected in markdown front matter. If a skill omits `name`, the
 * parent directory name is used as a stable fallback so providers can still
 * expose the skill. Missing descriptions are normalized to an empty string.
 */
export async function readProviderSkillMarkdownDefinition(
  skillPath: string,
): Promise<{ name: string; description: string }> {
  const content = await readFile(skillPath, 'utf8');
  return readProviderSkillMarkdownDefinitionFromContent(
    content,
    path.basename(path.dirname(skillPath)),
  );
}

/**
 * Reads the `name` and `description` fields from raw skill markdown content.
 *
 * This keeps filesystem discovery and newly uploaded skill creation aligned on
 * the same front matter parsing rules. `fallbackName` is used when the markdown
 * omits a `name` field so callers still get a stable, non-empty skill id.
 */
export function readProviderSkillMarkdownDefinitionFromContent(
  content: string,
  fallbackName: string,
): { name: string; description: string } {
  const parsed = parseFrontMatter(content);
  const data = readObjectRecord(parsed.data) ?? {};

  return {
    name: readOptionalString(data.name) ?? fallbackName,
    description: readOptionalString(data.description) ?? '',
  };
}

// ---------------------------
//----------------- SESSION SYNCHRONIZER TITLE HELPERS ------------
/**
 * Produces a compact session title suitable for UI rendering and DB storage.
 *
 * Use this when converting provider-native names into a consistent title value.
 * The helper collapses repeated whitespace, trims the result, and truncates it
 * to 120 characters so every provider writes stable and bounded metadata.
 * If the normalized input is empty, it returns the supplied fallback title.
 */
export function normalizeSessionName(rawValue: string | undefined, fallback: string): string {
  const normalized = (rawValue ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return fallback;
  }

  return normalized.slice(0, 120);
}

// ---------------------------
//----------------- PROVIDER SESSION VALUE NORMALIZATION UTILITIES ------------
/**
 * Converts provider-native timestamps into ISO strings.
 *
 * Provider CLIs commonly persist epoch timestamps as milliseconds, seconds, or
 * already-formatted date strings. Use this helper when normalizing session
 * metadata or transcript events so every provider writes the same ISO timestamp
 * shape to API responses and database rows.
 */
export function normalizeProviderTimestamp(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const millis = value < 1_000_000_000_000 ? value * 1000 : value;
    return new Date(millis).toISOString();
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return normalizeProviderTimestamp(parsed);
    }

    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return date.toISOString();
    }
  }

  return new Date().toISOString();
}

/**
 * Parses a JSON string or narrows an existing object into a plain record.
 *
 * Use this when provider databases store structured JSON inside text columns.
 * Invalid JSON, arrays, and primitive values return `null` so callers can skip
 * malformed optional metadata without hiding the rest of a session transcript.
 */
export function readJsonRecord(value: unknown): AnyRecord | null {
  if (typeof value !== 'string') {
    return readObjectRecord(value);
  }

  try {
    return readObjectRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

// ---------------------------
//----------------- OPENCODE SESSION STORAGE UTILITIES ------------
/**
 * Resolves the OpenCode SQLite session database path.
 *
 * OpenCode stores session, message, part, and project metadata in one shared
 * `opencode.db` file under its XDG data directory. Provider readers and
 * synchronizers should use this path for read-only access and should never store
 * it as a deletable transcript path for an individual app session row.
 */
export function getOpenCodeDatabasePath(): string {
  return path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
}

/**
 * Decodes an OpenCode text payload that was persisted as a JSON string literal.
 *
 * OpenCode can store the first user prompt (and other text parts) as `"hello"`
 * instead of `hello`. Used by both the OpenCode session reader (transcript
 * history) and the OpenCode synchronizer (session titling) so a session name or
 * message body never surfaces with surrounding quote characters. Only fully
 * quoted, valid JSON string literals are unwrapped; ordinary prose that merely
 * happens to start/end with a quote is returned untouched.
 */
export function unwrapJsonStringLiteral(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) {
    return value;
  }

  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed === 'string' ? parsed : value;
  } catch {
    return value;
  }
}

// ---------------------------
//----------------- SAFE DIRECTORY NAME UTILITIES ------------
/**
 * Validates that a user or provider supplied identifier can safely be treated
 * as one leaf directory name under an existing root folder.
 *
 * Use this before composing paths like `<root>/<session-id>/file.db>` to block
 * path traversal and accidental nested paths. The returned string is trimmed but
 * otherwise unchanged so callers can still match the provider's on-disk naming.
 */
export function sanitizeLeafDirectoryName(inputName: string, label = 'directory name'): string {
  const normalized = inputName.trim();
  if (!normalized) {
    throw new Error(`${label} is required.`);
  }

  if (
    normalized.includes('..')
    || normalized.includes(path.posix.sep)
    || normalized.includes(path.win32.sep)
    || normalized !== path.basename(normalized)
  ) {
    throw new Error(`Invalid ${label} "${inputName}".`);
  }

  return normalized;
}

// ---------------------------
//----------------- SESSION SYNCHRONIZER FILESYSTEM HELPERS ------------
/**
 * Resolves the most trustworthy "created at" instant from a `fs.Stats`-like
 * object.
 *
 * Many filesystems (ext4 without inode birth-time support, overlayfs, tmpfs,
 * proot/container mounts, etc.) don't track file birth time and report it as
 * the epoch (`birthtimeMs === 0`). Treating that as a real timestamp makes
 * every such file look infinitely old, so incremental scans that compare
 * against `lastScanAt` silently drop it forever. Falling back to `mtime`
 * (always populated) keeps "created after last scan" meaningful on those
 * filesystems, at the cost of using "last modified" as a proxy for "created"
 * only in that fallback case.
 */
export function resolveArtifactCreatedAtMs(fileStat: { birthtimeMs: number; mtimeMs: number }): number {
  return fileStat.birthtimeMs > 0 ? fileStat.birthtimeMs : fileStat.mtimeMs;
}

/**
 * Recursively discovers files that match one extension, with optional incremental filtering.
 *
 * Provider synchronizers call this to find transcript artifacts under provider
 * home directories. Pass `lastScanAt` to include only files created after the
 * previous scan, or pass `null` to perform a full rescan. Missing directories
 * are treated as empty because not every provider exists on every machine.
 */
export async function findFilesRecursivelyCreatedAfter(
  rootDir: string,
  extension: string,
  lastScanAt: Date | null,
  fileList: string[] = []
): Promise<string[]> {
  try {
    const entries = await readdir(rootDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(rootDir, entry.name);

      if (entry.isDirectory()) {
        await findFilesRecursivelyCreatedAfter(fullPath, extension, lastScanAt, fileList);
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith(extension)) {
        continue;
      }

      if (!lastScanAt) {
        fileList.push(fullPath);
        continue;
      }

      const fileStat = await stat(fullPath);
      if (resolveArtifactCreatedAtMs(fileStat) > lastScanAt.getTime()) {
        fileList.push(fullPath);
      }
    }
  } catch {
    // Missing provider folders are expected in first-run or partial setups.
  }

  return fileList;
}

/**
 * Reads file creation/update timestamps and maps them to DB-friendly ISO strings.
 *
 * Session indexers use this to persist `created_at` and `updated_at` metadata
 * when upserting sessions. If the file cannot be read, an empty object is
 * returned so indexing can continue for other files.
 */
export async function readFileTimestamps(
  filePath: string
): Promise<{ createdAt?: string; updatedAt?: string }> {
  try {
    const fileStat = await stat(filePath);
    return {
      createdAt: new Date(resolveArtifactCreatedAtMs(fileStat)).toISOString(),
      updatedAt: fileStat.mtime.toISOString(),
    };
  } catch {
    return {};
  }
}

// ---------------------------
//----------------- SESSION SYNCHRONIZER JSONL PARSING HELPERS ------------
/**
 * Builds a first-seen key/value lookup map from a JSONL file.
 *
 * Use this for provider index files where session id -> display name metadata
 * is stored line-by-line. The first value for each key wins, preserving the
 * earliest known label while avoiding repeated map overwrites.
 */
export async function buildLookupMap(
  filePath: string,
  keyField: string,
  valueField: string
): Promise<Map<string, string>> {
  const lookup = new Map<string, string>();

  try {
    const fileStream = fs.createReadStream(filePath);
    const lineReader = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    for await (const line of lineReader) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const key = parsed[keyField];
      const value = parsed[valueField];

      if (typeof key === 'string' && typeof value === 'string' && !lookup.has(key)) {
        lookup.set(key, value);
      }
    }
  } catch {
    // Missing or unreadable lookup files should not block session sync.
  }

  return lookup;
}

/**
 * Reads a JSONL file and returns the first extracted payload that matches caller criteria.
 *
 * The caller supplies an `extractor` that validates provider-specific row
 * shapes. This helper centralizes line-by-line parsing and lets indexers stop
 * scanning as soon as one valid row is found.
 */
export async function extractFirstValidJsonlData<T>(
  filePath: string,
  extractor: (parsedJson: unknown) => T | null | undefined
): Promise<T | null> {
  try {
    const fileStream = fs.createReadStream(filePath);
    const lineReader = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    for await (const line of lineReader) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      const parsed = JSON.parse(trimmed);
      const extracted = extractor(parsed);
      if (extracted) {
        lineReader.close();
        fileStream.close();
        return extracted;
      }
    }
  } catch {
    // Ignore malformed or missing artifacts so full scans keep progressing.
  }

  return null;
}

// ---------------------------
//----------------- CLI PROMPT ARGUMENT UTILITIES ------------
/**
 * Makes a prompt safe to pass as one CLI argument to `.cmd`-shimmed tools on
 * Windows (cursor-agent and opencode installed via npm-style shims).
 *
 * cmd.exe cannot carry newlines inside an argument: everything after the
 * first newline is silently dropped before the target CLI ever sees it, which
 * truncates multi-line prompts and any appended `<images_input>` block.
 * Collapsing newline runs to single spaces loses formatting but never loses
 * content, so runtimes should call this on win32 right before spawning.
 *
 * Used by the cursor and opencode spawn runtimes.
 */
export function flattenPromptForWindowsShell(prompt: string): string {
  if (process.platform !== 'win32' || typeof prompt !== 'string') {
    return prompt;
  }
  return prompt.replace(/\s*\r?\n\s*/g, ' ').trim();
}

// ---------------------------
//----------------- TERMINAL OUTPUT UTILITIES ------------
const ANSI_TERMINAL_STYLES = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
} as const;

/**
 * Applies the small, consistent ANSI style vocabulary used by backend
 * terminal output. The CLI and server bootstrap share these formatters so
 * status, warning, and startup messages use one implementation. Callers
 * should pass complete display strings and write the returned value directly
 * to stdout or stderr; the reset suffix prevents styling subsequent output.
 */
export const terminalTextStyles = {
  info: (text: string): string =>
    `${ANSI_TERMINAL_STYLES.cyan}${text}${ANSI_TERMINAL_STYLES.reset}`,
  ok: (text: string): string =>
    `${ANSI_TERMINAL_STYLES.green}${text}${ANSI_TERMINAL_STYLES.reset}`,
  warn: (text: string): string =>
    `${ANSI_TERMINAL_STYLES.yellow}${text}${ANSI_TERMINAL_STYLES.reset}`,
  error: (text: string): string =>
    `${ANSI_TERMINAL_STYLES.yellow}${text}${ANSI_TERMINAL_STYLES.reset}`,
  tip: (text: string): string =>
    `${ANSI_TERMINAL_STYLES.blue}${text}${ANSI_TERMINAL_STYLES.reset}`,
  bright: (text: string): string =>
    `${ANSI_TERMINAL_STYLES.bright}${text}${ANSI_TERMINAL_STYLES.reset}`,
  dim: (text: string): string =>
    `${ANSI_TERMINAL_STYLES.dim}${text}${ANSI_TERMINAL_STYLES.reset}`,
};

// ---------------------------
//----------------- RUNTIME PATH RESOLUTION UTILITIES ------------
/**
 * Resolves the directory containing an ES module from `import.meta.url`.
 * Backend entrypoints and feature composition roots use this instead of
 * recreating CommonJS `__dirname` logic.
 */
export function getModuleDirectory(importMetaUrl: string): string {
  return path.dirname(fileURLToPath(importMetaUrl));
}

/**
 * Walks upward to the nearest `server` directory in either source or compiled
 * output. Callers use this stable anchor for server-relative resources.
 */
export function findServerRoot(startDirectory: string): string {
  let currentDirectory = startDirectory;
  while (path.basename(currentDirectory) !== 'server') {
    const parentDirectory = path.dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      throw new Error(`Could not resolve the backend server root from "${startDirectory}".`);
    }
    currentDirectory = parentDirectory;
  }
  return currentDirectory;
}

/**
 * Resolves the application root from a source or `dist-server/server` path so
 * package-level resources work identically before and after compilation.
 */
export function findApplicationRoot(startDirectory: string): string {
  const serverRoot = findServerRoot(startDirectory);
  const parentDirectory = path.dirname(serverRoot);
  return path.basename(parentDirectory) === 'dist-server'
    ? path.dirname(parentDirectory)
    : parentDirectory;
}

// ---------------------------
//----------------- ONE-TIME CODE AND SECRET HASH UTILITIES ------------
/** Crockford base32: no I, L, O or U, so a code retyped on a phone is unambiguous. */
const ONE_TIME_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ONE_TIME_CODE_LENGTH = 12;

/**
 * Generates a short-lived, human-typed code: 12 Crockford base32 characters
 * (60 bits from the CSPRNG) formatted `XXXX-XXXX-XXXX`. Used by remote browser
 * pairing (remote-access) and RuntimeNode enrollment (runtime-nodes).
 *
 * Callers must persist only `hashSecretValue(normalizeOneTimeCode(code))`, show
 * the code once, expire it within minutes and redeem it at most once: a code is
 * an introduction, never a long-lived credential.
 */
export function generateOneTimeCode(): string {
  const bytes = randomBytes(ONE_TIME_CODE_LENGTH);
  let code = '';
  for (let index = 0; index < ONE_TIME_CODE_LENGTH; index += 1) {
    // 256 is a multiple of 32, so the modulo introduces no bias.
    code += ONE_TIME_CODE_ALPHABET[bytes[index] % ONE_TIME_CODE_ALPHABET.length];
  }
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`;
}

/**
 * Canonicalizes a typed one-time code: case, spaces and dashes are ignored and
 * the look-alikes O, I and L read as 0, 1 and 1. Returns null for anything that
 * cannot be a code, so callers refuse it without touching the database.
 */
export function normalizeOneTimeCode(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > 64) {
    return null;
  }
  const compact = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (compact.length !== ONE_TIME_CODE_LENGTH) {
    return null;
  }
  return [...compact].every((character) => ONE_TIME_CODE_ALPHABET.includes(character)) ? compact : null;
}

/**
 * SHA-256 hex digest of a high-entropy secret (random session tokens,
 * normalized one-time codes). Remote-access and runtime-nodes persist only this
 * digest, so reading the database never yields a usable credential. It is not
 * a password hash and must never be used for user-chosen secrets.
 */
export function hashSecretValue(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

// ---------------------------
//----------------- ABUSE RATE LIMIT UTILITIES ------------
/**
 * Creates an in-memory sliding-window failure limiter for guessable secrets
 * (remote-access pairing, runtime-nodes enrollment). Only failures are counted:
 * an attempt is refused once its client key or the whole process reached the
 * failure budget inside the window, so spraying from many addresses still hits
 * the global cap. Memory is bounded — at most `maxTrackedKeys` client keys are
 * tracked and refused attempts are never recorded.
 */
export function createFailureRateLimiter(options: {
  windowMs: number;
  maxFailuresPerKey: number;
  maxFailuresGlobal: number;
  maxTrackedKeys?: number;
  now?: () => number;
}): FailureRateLimiter {
  const now = options.now ?? Date.now;
  const maxTrackedKeys = options.maxTrackedKeys ?? 1000;
  const failuresByKey = new Map<string, number[]>();
  let globalFailures: number[] = [];

  const withinWindow = (timestamps: number[], at: number): number[] =>
    timestamps.filter((timestamp) => at - timestamp < options.windowMs);
  const retryAfter = (timestamps: number[], at: number): number =>
    timestamps.length > 0 ? Math.max(1, options.windowMs - (at - timestamps[0])) : 0;

  return {
    check(clientKey) {
      const at = now();
      globalFailures = withinWindow(globalFailures, at);
      const keyFailures = withinWindow(failuresByKey.get(clientKey) ?? [], at);
      if (keyFailures.length > 0) {
        failuresByKey.set(clientKey, keyFailures);
      } else {
        failuresByKey.delete(clientKey);
      }

      if (keyFailures.length >= options.maxFailuresPerKey) {
        return { allowed: false, retryAfterMs: retryAfter(keyFailures, at) };
      }
      if (globalFailures.length >= options.maxFailuresGlobal) {
        return { allowed: false, retryAfterMs: retryAfter(globalFailures, at) };
      }
      return { allowed: true, retryAfterMs: 0 };
    },

    recordFailure(clientKey) {
      const at = now();
      globalFailures = withinWindow(globalFailures, at);
      globalFailures.push(at);
      const keyFailures = withinWindow(failuresByKey.get(clientKey) ?? [], at);
      keyFailures.push(at);
      // Re-inserting keeps Map order = recency, so eviction drops the stalest key.
      failuresByKey.delete(clientKey);
      failuresByKey.set(clientKey, keyFailures);
      while (failuresByKey.size > maxTrackedKeys) {
        const stalest = failuresByKey.keys().next().value;
        if (stalest === undefined) {
          break;
        }
        failuresByKey.delete(stalest);
      }
    },

    reset(clientKey) {
      failuresByKey.delete(clientKey);
    },
  };
}

const trustedClientAddresses = new WeakMap<object, string>();

/**
 * Records the client address a trusted local TLS terminator reported for this
 * request. Only the Remote Gateway in external-tls mode calls this: that
 * listener binds loopback, so its only peer is the operator's own proxy.
 */
export function setTrustedClientAddress(request: object, address: string): void {
  trustedClientAddresses.set(request, address);
}

/**
 * Address used to key rate limits. Forwarding headers are never read here
 * because any client can forge them; the only override is the address the
 * gateway recorded from its own loopback-bound terminator (see
 * `setTrustedClientAddress`). Without a terminator it is the TCP peer. Used by
 * remote-access and runtime-nodes.
 */
export function readRequestClientAddress(request: { socket?: { remoteAddress?: string } | null }): string {
  return trustedClientAddresses.get(request) ?? (request.socket?.remoteAddress || 'unknown');
}

// ---------------------------
//----------------- RUNTIME NODE LINK AUTH UTILITIES ------------
/**
 * WebSocket path of the authenticated RuntimeNode link. Accepted by the server
 * entrypoint's websocket gateway (runtime-nodes) and dialed by node-agent.
 */
export const RUNTIME_NODE_LINK_PATH = '/runtime-node-link';

/**
 * Link protocol version spoken by runtime-nodes and node-agent. A node on
 * another version stays visible but never executes (`protocol_incompatible`).
 */
export const RUNTIME_NODE_LINK_PROTOCOL_VERSION = 1;

/**
 * Largest difference accepted between a node's signed timestamp and the control
 * plane clock (runtime-nodes). Nonces are remembered at least this long, so a
 * captured header can never be replayed inside the window either.
 */
export const RUNTIME_NODE_LINK_MAX_CLOCK_SKEW_MS = 120_000;

const RUNTIME_NODE_LINK_AUTH_SCHEME = 'CloudCLI-Node-v1';
const RUNTIME_NODE_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const RUNTIME_NODE_NONCE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const RUNTIME_NODE_SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{16,200}$/;

function buildRuntimeNodeLinkSignedPayload(nodeId: string, timestamp: number, nonce: string, requestPath: string): string {
  return `${RUNTIME_NODE_LINK_AUTH_SCHEME}\n${nodeId}\n${timestamp}\n${nonce}\n${requestPath}`;
}

/**
 * Builds the `Authorization` header a RuntimeNode sends when opening its link
 * (node-agent): an Ed25519 signature over the scheme, node id, timestamp, a
 * fresh random nonce and the request path. The private key never leaves the
 * node, and nothing in the header is reusable once the control plane has seen
 * its nonce.
 */
export function signRuntimeNodeLinkRequest(input: {
  nodeId: string;
  privateKeyPem: string;
  path: string;
  timestamp?: number;
  nonce?: string;
}): string {
  const timestamp = input.timestamp ?? Date.now();
  const nonce = input.nonce ?? randomBytes(18).toString('base64url');
  const payload = Buffer.from(buildRuntimeNodeLinkSignedPayload(input.nodeId, timestamp, nonce, input.path), 'utf8');
  const signature = sign(null, payload, createPrivateKey(input.privateKeyPem)).toString('base64url');
  return `${RUNTIME_NODE_LINK_AUTH_SCHEME} node=${input.nodeId},ts=${timestamp},nonce=${nonce},sig=${signature}`;
}

/**
 * Strictly parses a node link `Authorization` header (runtime-nodes). Any
 * missing, duplicated, unknown or malformed field yields null. Parsing proves
 * nothing: the caller must still verify the signature, clock window and nonce.
 */
export function parseRuntimeNodeLinkAuthorization(header: unknown): ParsedRuntimeNodeLinkAuthorization | null {
  const prefix = `${RUNTIME_NODE_LINK_AUTH_SCHEME} `;
  if (typeof header !== 'string' || header.length > 512 || !header.startsWith(prefix)) {
    return null;
  }

  const fields = new Map<string, string>();
  for (const part of header.slice(prefix.length).split(',')) {
    const separator = part.indexOf('=');
    if (separator <= 0) {
      return null;
    }
    const key = part.slice(0, separator).trim();
    if (fields.has(key)) {
      return null;
    }
    fields.set(key, part.slice(separator + 1).trim());
  }

  const nodeId = fields.get('node') ?? '';
  const timestamp = fields.get('ts') ?? '';
  const nonce = fields.get('nonce') ?? '';
  const signature = fields.get('sig') ?? '';
  if (
    fields.size !== 4
    || !RUNTIME_NODE_ID_PATTERN.test(nodeId)
    || !/^\d{1,16}$/.test(timestamp)
    || !RUNTIME_NODE_NONCE_PATTERN.test(nonce)
    || !RUNTIME_NODE_SIGNATURE_PATTERN.test(signature)
  ) {
    return null;
  }

  return { nodeId, timestamp: Number(timestamp), nonce, signature };
}

/**
 * Verifies a parsed node link signature against the node's enrolled Ed25519
 * public key for the requested path (runtime-nodes). It checks neither the
 * clock window nor nonce reuse; the caller must. Any key or signature error
 * reads as a failed verification.
 */
export function verifyRuntimeNodeLinkSignature(
  parsed: ParsedRuntimeNodeLinkAuthorization,
  publicKeyPem: string,
  requestPath: string,
): boolean {
  try {
    const publicKey = createPublicKey(publicKeyPem);
    if (publicKey.asymmetricKeyType !== 'ed25519') {
      return false;
    }
    const payload = Buffer.from(
      buildRuntimeNodeLinkSignedPayload(parsed.nodeId, parsed.timestamp, parsed.nonce, requestPath),
      'utf8',
    );
    return verify(null, payload, publicKey, Buffer.from(parsed.signature, 'base64url'));
  } catch {
    return false;
  }
}
