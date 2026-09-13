import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { legacyClaudeHome } from '@/modules/claude-profiles/claude-home.resolver.js';
import {
  CLAUDE_LIVE_USAGE_SNAPSHOT_FILE_NAME,
  CLAUDE_STATUSLINE_BRIDGE_FILE_NAME,
  CLAUDE_STATUSLINE_BRIDGE_SCRIPT,
  CLAUDE_STATUSLINE_BRIDGE_VERSION,
  buildStatusLineBridgeCommand,
  inspectStatusLineBridge,
  planStatusLineBridgeInstall,
  planStatusLineBridgeRemoval,
} from '@/modules/claude-profiles/claude-statusline-bridge.js';
import { claudeProfilesDb } from '@/modules/database/index.js';
import type { ClaudeLiveUsage, ClaudeLiveUsageWindow } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/** A snapshot older than this is still shown, but labeled stale rather than current. */
const LIVE_USAGE_FRESH_MS = 15 * 60_000;
/** A capture time further in the future than this is not trusted at all. */
const MAX_FUTURE_SKEW_MS = 5 * 60_000;
/** No documented window resets more than seven days out; one day of slack. */
const MAX_RESET_HORIZON_MS = 8 * 24 * 60 * 60_000;
const MAX_SETTINGS_BYTES = 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 64 * 1024;
const SETTINGS_FILE_NAME = 'settings.json';
const BYTE_ORDER_MARK = '﻿';

type ClaudeSettings = Record<string, unknown>;

type SettingsRead =
  | { kind: 'missing' }
  | { kind: 'object'; settings: ClaudeSettings; raw: string }
  | { kind: 'unreadable' };

type ClaudeLiveUsageServiceDependencies = {
  homeDirectory?: string;
  platform?: NodeJS.Platform;
  nodeExecutablePath?: string;
  now?: () => number;
  pathEnvironment?: string;
};

type SnapshotEvaluationContext = {
  expectedConfigDirectory: string;
  now: number;
  platform: NodeJS.Platform;
};

const NOT_REPORTED: ClaudeLiveUsageWindow = { state: 'unavailable', reason: 'not_reported' };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function isSamePath(left: string, right: string, platform: NodeJS.Platform): boolean {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const resolvedLeft = pathApi.resolve(left);
  const resolvedRight = pathApi.resolve(right);
  return platform === 'win32'
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

function evaluateWindow(value: unknown, capturedAt: number, now: number): ClaudeLiveUsageWindow {
  if (!isPlainObject(value)) {
    return NOT_REPORTED;
  }
  const usedPercentage = value.used_percentage;
  const resetsAt = value.resets_at;
  if (typeof usedPercentage !== 'number' || !Number.isFinite(usedPercentage) || usedPercentage < 0 || usedPercentage > 100) {
    return NOT_REPORTED;
  }
  if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt) || resetsAt <= 0) {
    return NOT_REPORTED;
  }
  const resetsAtMs = resetsAt * 1000;
  if (resetsAtMs > capturedAt + MAX_RESET_HORIZON_MS) {
    return NOT_REPORTED;
  }
  // Claude Code itself drops a window once `resets_at` passes: the percentage
  // it last reported belongs to a window that no longer exists.
  if (resetsAtMs <= now) {
    return { state: 'unavailable', reason: 'window_reset' };
  }
  return { state: 'available', usedPercentage, resetsAt: new Date(resetsAtMs).toISOString() };
}

/**
 * Turns a raw snapshot file (already JSON-parsed, or null when absent) into
 * truthful per-window usage. Every failure path yields windows without a
 * number, and a snapshot recorded for a different config directory is refused
 * outright so one account's usage can never surface under another.
 *
 * Consumed by the live-usage service below and by its tests.
 */
export function evaluateClaudeLiveUsageSnapshot(
  raw: unknown,
  context: SnapshotEvaluationContext,
): Pick<ClaudeLiveUsage, 'snapshot' | 'fiveHour' | 'sevenDay'> {
  const unavailable = (
    reason: NonNullable<ClaudeLiveUsage['snapshot']['reason']>,
  ): Pick<ClaudeLiveUsage, 'snapshot' | 'fiveHour' | 'sevenDay'> => ({
    snapshot: { status: 'unavailable', reason, capturedAt: null, freshness: null },
    fiveHour: NOT_REPORTED,
    sevenDay: NOT_REPORTED,
  });

  if (raw === null || raw === undefined) {
    return unavailable('no_snapshot');
  }
  if (
    !isPlainObject(raw)
    || raw.schemaVersion !== 1
    || raw.source !== 'claude-statusline'
    || typeof raw.configDirectory !== 'string'
    || typeof raw.capturedAt !== 'number'
    || !Number.isFinite(raw.capturedAt)
    || raw.capturedAt <= 0
  ) {
    return unavailable('snapshot_invalid');
  }
  if (!isSamePath(raw.configDirectory, context.expectedConfigDirectory, context.platform)) {
    return unavailable('attribution_mismatch');
  }
  if (raw.capturedAt > context.now + MAX_FUTURE_SKEW_MS) {
    return unavailable('snapshot_from_future');
  }

  const capturedAt = raw.capturedAt;
  const rateLimits = isPlainObject(raw.rateLimits) ? raw.rateLimits : {};
  return {
    snapshot: {
      status: 'available',
      reason: null,
      capturedAt: new Date(capturedAt).toISOString(),
      freshness: context.now - capturedAt <= LIVE_USAGE_FRESH_MS ? 'fresh' : 'stale',
    },
    fiveHour: evaluateWindow(rateLimits.five_hour, capturedAt, context.now),
    sevenDay: evaluateWindow(rateLimits.seven_day, capturedAt, context.now),
  };
}

/** Reads a file only when it is small enough; null when it does not exist. */
async function readBoundedFile(filePath: string, maxBytes: number): Promise<string | null> {
  let size: number;
  try {
    size = (await fs.stat(filePath)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  if (size > maxBytes) {
    throw new Error('File exceeds the size CloudCLI reads.');
  }
  return fs.readFile(filePath, 'utf8');
}

async function readSettings(settingsPath: string): Promise<SettingsRead> {
  let raw: string | null;
  try {
    raw = await readBoundedFile(settingsPath, MAX_SETTINGS_BYTES);
  } catch {
    return { kind: 'unreadable' };
  }
  if (raw === null) {
    return { kind: 'missing' };
  }
  try {
    const parsed: unknown = JSON.parse(raw.startsWith(BYTE_ORDER_MARK) ? raw.slice(1) : raw);
    return isPlainObject(parsed) ? { kind: 'object', settings: parsed, raw } : { kind: 'unreadable' };
  } catch {
    return { kind: 'unreadable' };
  }
}

/** Keeps the file's BOM, indentation and trailing newline so the only real change is statusLine. */
function serializeSettings(settings: ClaudeSettings, originalRaw: string | null): string {
  const byteOrderMark = originalRaw?.startsWith(BYTE_ORDER_MARK) ? BYTE_ORDER_MARK : '';
  const indentation = originalRaw?.match(/^([ \t]+)"/m)?.[1] ?? 2;
  const trailingNewline = originalRaw === null || originalRaw.endsWith('\n') ? '\n' : '';
  return `${byteOrderMark}${JSON.stringify(settings, null, indentation)}${trailingNewline}`;
}

async function writeFileAtomically(filePath: string, content: string, mode: number): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporaryPath, content, { encoding: 'utf8', mode });
  try {
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(directoryPath: string): Promise<boolean> {
  try {
    return (await fs.stat(directoryPath)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * `dependencies` are injectable so tests can run against a temporary home
 * directory, a fixed clock and a chosen platform. The claude-profiles routes
 * use the default instance below.
 *
 * Every method takes the account explicitly: a Claude profile id, or `null`
 * for the historical un-isolated `~/.claude` account that has no profile row.
 */
export function createClaudeLiveUsageService(dependencies: ClaudeLiveUsageServiceDependencies = {}) {
  const homeDirectory = dependencies.homeDirectory ?? os.homedir();
  const platform = dependencies.platform ?? process.platform;
  const nodeExecutablePath = dependencies.nodeExecutablePath ?? process.execPath;
  const now = dependencies.now ?? Date.now;
  const scriptPath = path.join(homeDirectory, '.cloudcli', 'bin', CLAUDE_STATUSLINE_BRIDGE_FILE_NAME);

  // The directory always comes from the profile row (or the resolver for the
  // legacy account) — never from client input.
  const resolveConfigDirectory = (profileId: string | null): string => {
    if (profileId === null) {
      return legacyClaudeHome(homeDirectory);
    }
    const profile = claudeProfilesDb.getById(profileId);
    if (!profile) {
      throw new AppError('Claude profile not found.', {
        code: 'CLAUDE_PROFILE_NOT_FOUND',
        statusCode: 404,
      });
    }
    return profile.configDirectory;
  };

  const readBridgeState = async (settings: SettingsRead): Promise<ClaudeLiveUsage['bridge']> => {
    if (settings.kind === 'unreadable') {
      return { state: 'settings_unreadable', wrapsExistingStatusLine: false, hasUserStatusLine: false };
    }
    if (settings.kind === 'missing') {
      return { state: 'not_installed', wrapsExistingStatusLine: false, hasUserStatusLine: false };
    }

    const inspection = inspectStatusLineBridge(settings.settings);
    if (inspection.installedVersion === null) {
      return { state: 'not_installed', wrapsExistingStatusLine: false, hasUserStatusLine: inspection.hasUserStatusLine };
    }

    let state: ClaudeLiveUsage['bridge']['state'];
    if (!(await isFile(scriptPath))) {
      state = 'broken';
    } else if (inspection.installedVersion !== CLAUDE_STATUSLINE_BRIDGE_VERSION) {
      state = 'outdated';
    } else {
      state = (await fs.readFile(scriptPath, 'utf8')) === CLAUDE_STATUSLINE_BRIDGE_SCRIPT ? 'installed' : 'outdated';
    }
    return { state, wrapsExistingStatusLine: inspection.wrapsExistingStatusLine, hasUserStatusLine: false };
  };

  const readSnapshot = async (configDirectory: string): Promise<unknown> => {
    let raw: string | null;
    try {
      raw = await readBoundedFile(path.join(configDirectory, CLAUDE_LIVE_USAGE_SNAPSHOT_FILE_NAME), MAX_SNAPSHOT_BYTES);
    } catch {
      // Present but unreadable or oversized: invalid, not absent.
      return {};
    }
    if (raw === null) {
      return null;
    }
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  };

  const buildView = async (configDirectory: string): Promise<ClaudeLiveUsage> => {
    const settings = await readSettings(path.join(configDirectory, SETTINGS_FILE_NAME));
    const bridge = await readBridgeState(settings);
    const evaluation = evaluateClaudeLiveUsageSnapshot(await readSnapshot(configDirectory), {
      expectedConfigDirectory: configDirectory,
      now: now(),
      platform,
    });
    return { source: 'claude_statusline', bridge, ...evaluation };
  };

  const assertSettingsReadable = (settings: SettingsRead): void => {
    if (settings.kind === 'unreadable') {
      throw new AppError('This account\'s Claude settings.json could not be read as a JSON object, so CloudCLI will not change it.', {
        code: 'LIVE_USAGE_SETTINGS_UNREADABLE',
        statusCode: 409,
      });
    }
  };

  const writeSettings = async (settingsPath: string, next: ClaudeSettings, previous: SettingsRead): Promise<void> => {
    let mode = 0o600;
    if (previous.kind === 'object') {
      try {
        mode = (await fs.stat(settingsPath)).mode & 0o777;
      } catch {
        mode = 0o600;
      }
    }
    await writeFileAtomically(settingsPath, serializeSettings(next, previous.kind === 'object' ? previous.raw : null), mode);
  };

  const isNodeOnPath = async (): Promise<boolean> => {
    const pathEnvironment = dependencies.pathEnvironment ?? process.env.PATH ?? process.env.Path ?? '';
    const entries = pathEnvironment.split(path.delimiter).filter(Boolean);
    const matches = await Promise.all(entries.map((entry) => isFile(path.join(entry, 'node.exe'))));
    return matches.some(Boolean);
  };

  return {
    /** Current live usage for one account, derived from disk at read time. */
    async getLiveUsage(profileId: string | null): Promise<ClaudeLiveUsage> {
      return buildView(resolveConfigDirectory(profileId));
    },

    /**
     * Explicit, user-initiated install of the bridge in this account's
     * settings.json. An existing statusLine is wrapped (never replaced) and
     * the script is written before settings point at it. Nothing is written
     * when the settings cannot be interpreted.
     */
    async enableBridge(profileId: string | null): Promise<ClaudeLiveUsage> {
      const configDirectory = resolveConfigDirectory(profileId);
      if (!(await isDirectory(configDirectory))) {
        throw new AppError('This Claude account has no configuration directory yet. Sign in to it first.', {
          code: 'LIVE_USAGE_CONFIG_DIRECTORY_MISSING',
          statusCode: 409,
        });
      }

      const settingsPath = path.join(configDirectory, SETTINGS_FILE_NAME);
      const current = await readSettings(settingsPath);
      assertSettingsReadable(current);
      if (platform === 'win32' && !(await isNodeOnPath())) {
        throw new AppError('Node.js is not on PATH, so Claude Code could not start the usage bridge.', {
          code: 'LIVE_USAGE_NODE_NOT_ON_PATH',
          statusCode: 409,
        });
      }

      const next = planStatusLineBridgeInstall(
        current.kind === 'object' ? current.settings : {},
        (wrappedCommand) => buildStatusLineBridgeCommand({ platform, nodeExecutablePath, scriptPath, wrappedCommand }),
      );

      await fs.mkdir(path.dirname(scriptPath), { recursive: true });
      await writeFileAtomically(scriptPath, CLAUDE_STATUSLINE_BRIDGE_SCRIPT, 0o644);
      await writeSettings(settingsPath, next, current);
      return buildView(configDirectory);
    },

    /**
     * Removes the bridge and restores the statusLine exactly as it was before
     * CloudCLI. A statusLine CloudCLI did not write is left untouched. The
     * shared script file stays, since other accounts may still use it.
     */
    async disableBridge(profileId: string | null): Promise<ClaudeLiveUsage> {
      const configDirectory = resolveConfigDirectory(profileId);
      const settingsPath = path.join(configDirectory, SETTINGS_FILE_NAME);
      const current = await readSettings(settingsPath);
      assertSettingsReadable(current);

      if (current.kind === 'object') {
        const next = planStatusLineBridgeRemoval(current.settings);
        if (next) {
          await writeSettings(settingsPath, next, current);
        }
      }
      return buildView(configDirectory);
    },
  };
}

// claudeLiveUsageService: used by the claude-profiles routes for FT-M07 Provider Live Usage.
export const claudeLiveUsageService = createClaudeLiveUsageService();
