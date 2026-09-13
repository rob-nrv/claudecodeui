import { randomBytes, randomUUID } from 'node:crypto';

import type { RemoteBrowserSessionRecord } from '@/modules/database/index.js';
import type { FailureRateLimiter } from '@/shared/types.js';
import {
  AppError,
  createFailureRateLimiter,
  generateOneTimeCode,
  hashSecretValue,
  normalizeOneTimeCode,
} from '@/shared/utils.js';

/** A pairing code is an introduction typed within minutes, not a credential. */
const PAIRING_CODE_TTL_MS = 10 * 60_000;
const MAX_OUTSTANDING_PAIRING_CODES = 5;
/** A paired browser unused for this long must pair again. */
const SESSION_IDLE_TIMEOUT_MS = 7 * 24 * 60 * 60_000;
/** No remote browser session outlives this, however active. */
const SESSION_ABSOLUTE_LIFETIME_MS = 30 * 24 * 60 * 60_000;
/** `last_seen_at` is written at most this often per session. */
const SESSION_TOUCH_INTERVAL_MS = 5 * 60_000;
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_LABEL_LENGTH = 80;

type RemoteAccessUser = { id: number; username: string };

type RemoteAccessServiceDependencies = {
  users: {
    getUserByUsername(username: string): (RemoteAccessUser & { password_hash: string }) | undefined;
    getUserById(userId: number): (RemoteAccessUser & Record<string, unknown>) | undefined;
  };
  comparePassword(password: string, passwordHash: string): Promise<boolean>;
  hashPassword(password: string): Promise<string>;
  store: {
    createPairingCode(input: { codeHash: string; createdByUserId: number; createdAt: number; expiresAt: number }): void;
    countOutstandingPairingCodes(now: number): number;
    burnPairingCode(codeHash: string, now: number): boolean;
    prunePairingCodes(before: number): void;
    createBrowserSession(input: {
      sessionId: string;
      tokenHash: string;
      userId: number;
      label: string | null;
      createdAt: number;
      expiresAt: number;
    }): void;
    getBrowserSessionByTokenHash(tokenHash: string): RemoteBrowserSessionRecord | null;
    getBrowserSessionById(sessionId: string): RemoteBrowserSessionRecord | null;
    touchBrowserSession(sessionId: string, lastSeenAt: number): void;
    revokeBrowserSession(sessionId: string, revokedAt: number): boolean;
    revokeAllBrowserSessions(revokedAt: number): string[];
    listActiveBrowserSessions(now: number): RemoteBrowserSessionRecord[];
  };
  now?: () => number;
  limiter?: FailureRateLimiter;
};

/** Everything a caller learns from a valid remote session cookie. */
export type RemoteSessionAuthentication = {
  sessionId: string;
  user: RemoteAccessUser & Record<string, unknown>;
};

/** Short, non-identifying description of the paired browser for the sessions list. */
function summarizeUserAgent(userAgent: unknown): string | null {
  if (typeof userAgent !== 'string' || !userAgent.trim()) {
    return null;
  }
  const browser = /Edg\//.test(userAgent) ? 'Edge'
    : /Firefox\//.test(userAgent) ? 'Firefox'
      : /Chrome\//.test(userAgent) ? 'Chrome'
        : /Safari\//.test(userAgent) ? 'Safari'
          : 'Browser';
  const platform = /iPhone|iPad/.test(userAgent) ? 'iOS'
    : /Android/.test(userAgent) ? 'Android'
      : /Windows/.test(userAgent) ? 'Windows'
        : /Mac OS X/.test(userAgent) ? 'macOS'
          : /Linux/.test(userAgent) ? 'Linux'
            : null;
  return (platform ? `${browser} on ${platform}` : browser).slice(0, MAX_LABEL_LENGTH);
}

const pairingFailedError = () => new AppError('Pairing failed. Check the pairing code, username and password.', {
  code: 'REMOTE_PAIRING_FAILED',
  statusCode: 401,
});

/**
 * Remote browser access (FT-M08): one-time pairing codes issued by an already
 * authenticated session, and the server-side sessions a paired browser holds
 * as an HttpOnly cookie. Dependencies are injectable so tests run over a
 * temporary database with a controlled clock.
 */
export function createRemoteAccessService(dependencies: RemoteAccessServiceDependencies) {
  const now = dependencies.now ?? Date.now;
  const limiter = dependencies.limiter ?? createFailureRateLimiter({
    windowMs: 15 * 60_000,
    maxFailuresPerKey: 5,
    maxFailuresGlobal: 20,
    now,
  });
  const revocationListeners = new Set<(sessionIds: string[]) => void>();
  let equalizingPasswordHash: Promise<string> | null = null;

  const notifyRevoked = (sessionIds: string[]) => {
    if (sessionIds.length === 0) {
      return;
    }
    for (const listener of revocationListeners) {
      listener(sessionIds);
    }
  };

  const isUsable = (record: RemoteBrowserSessionRecord, at: number): boolean =>
    record.revokedAt === null && at < record.expiresAt && at - record.lastSeenAt <= SESSION_IDLE_TIMEOUT_MS;

  return {
    /** Issues one pairing code for the authenticated user; the plain code is returned exactly once. */
    createPairingCode(userId: number): { code: string; expiresAt: string } {
      const at = now();
      dependencies.store.prunePairingCodes(at - PAIRING_CODE_TTL_MS);
      if (dependencies.store.countOutstandingPairingCodes(at) >= MAX_OUTSTANDING_PAIRING_CODES) {
        throw new AppError('Too many pairing codes are waiting to be used. Wait for one to expire.', {
          code: 'REMOTE_PAIRING_CODE_LIMIT',
          statusCode: 429,
        });
      }

      const code = generateOneTimeCode();
      const expiresAt = at + PAIRING_CODE_TTL_MS;
      dependencies.store.createPairingCode({
        codeHash: hashSecretValue(normalizeOneTimeCode(code) as string),
        createdByUserId: userId,
        createdAt: at,
        expiresAt,
      });
      return { code, expiresAt: new Date(expiresAt).toISOString() };
    },

    /**
     * Pairs a browser: the password AND a valid pairing code are both required.
     * Every failure counts against the client and global limits, and any
     * attempt that presents a still-valid code burns it — a known code can
     * never be used to guess the password.
     */
    async pairBrowser(input: {
      username: unknown;
      password: unknown;
      pairingCode: unknown;
      clientKey: string;
      userAgent: unknown;
    }): Promise<{ token: string; sessionId: string; expiresAt: string; user: RemoteAccessUser }> {
      const gate = limiter.check(input.clientKey);
      if (!gate.allowed) {
        throw new AppError('Too many failed pairing attempts. Try again later.', {
          code: 'REMOTE_PAIRING_RATE_LIMITED',
          statusCode: 429,
          details: { retryAfterSeconds: Math.ceil(gate.retryAfterMs / 1000) },
        });
      }

      const at = now();
      const username = typeof input.username === 'string' ? input.username.trim() : '';
      const password = typeof input.password === 'string' ? input.password : '';
      const normalizedCode = normalizeOneTimeCode(input.pairingCode);
      const codeHash = normalizedCode ? hashSecretValue(normalizedCode) : null;

      const user = username && password.length <= 1024 ? dependencies.users.getUserByUsername(username) : undefined;
      let passwordMatches = false;
      if (user) {
        passwordMatches = await dependencies.comparePassword(password, user.password_hash);
      } else {
        // Spend the same bcrypt work for unknown users so timing does not reveal usernames.
        equalizingPasswordHash ??= dependencies.hashPassword(randomBytes(16).toString('hex'));
        await dependencies.comparePassword(password, await equalizingPasswordHash);
      }

      // Burning first makes the code single-use whatever else happens below.
      const codeBurned = codeHash ? dependencies.store.burnPairingCode(codeHash, at) : false;
      if (!user || !passwordMatches || !codeBurned) {
        limiter.recordFailure(input.clientKey);
        throw pairingFailedError();
      }

      limiter.reset(input.clientKey);
      const token = randomBytes(32).toString('base64url');
      const sessionId = randomUUID();
      const expiresAt = at + SESSION_ABSOLUTE_LIFETIME_MS;
      dependencies.store.createBrowserSession({
        sessionId,
        tokenHash: hashSecretValue(token),
        userId: user.id,
        label: summarizeUserAgent(input.userAgent),
        createdAt: at,
        expiresAt,
      });
      return { token, sessionId, expiresAt: new Date(expiresAt).toISOString(), user: { id: user.id, username: user.username } };
    },

    /**
     * Resolves a session cookie value to its user, enforcing revocation, idle
     * and absolute expiry on every call. Anything malformed is simply null.
     */
    authenticate(token: string | null | undefined): RemoteSessionAuthentication | null {
      if (typeof token !== 'string' || !SESSION_TOKEN_PATTERN.test(token)) {
        return null;
      }
      const at = now();
      const record = dependencies.store.getBrowserSessionByTokenHash(hashSecretValue(token));
      if (!record || !isUsable(record, at)) {
        return null;
      }
      const user = dependencies.users.getUserById(record.userId);
      if (!user) {
        return null;
      }
      if (at - record.lastSeenAt >= SESSION_TOUCH_INTERVAL_MS) {
        dependencies.store.touchBrowserSession(record.sessionId, at);
      }
      return { sessionId: record.sessionId, user };
    },

    /** Whether a session id can still be used; open sockets are re-checked with this. */
    isSessionActive(sessionId: string): boolean {
      const record = dependencies.store.getBrowserSessionById(sessionId);
      return Boolean(record && isUsable(record, now()));
    },

    listSessions(currentSessionId: string | null) {
      const at = now();
      return dependencies.store
        .listActiveBrowserSessions(at)
        .filter((record) => isUsable(record, at))
        .map((record) => ({
          sessionId: record.sessionId,
          label: record.label,
          createdAt: new Date(record.createdAt).toISOString(),
          lastSeenAt: new Date(record.lastSeenAt).toISOString(),
          expiresAt: new Date(record.expiresAt).toISOString(),
          current: record.sessionId === currentSessionId,
        }));
    },

    revokeSession(sessionId: string): boolean {
      const revoked = dependencies.store.revokeBrowserSession(sessionId, now());
      if (revoked) {
        notifyRevoked([sessionId]);
      }
      return revoked;
    },

    revokeAllSessions(): number {
      const sessionIds = dependencies.store.revokeAllBrowserSessions(now());
      notifyRevoked(sessionIds);
      return sessionIds.length;
    },

    /** Called with revoked session ids so their open sockets close immediately. */
    onSessionsRevoked(listener: (sessionIds: string[]) => void): void {
      revocationListeners.add(listener);
    },
  };
}

export type RemoteAccessService = ReturnType<typeof createRemoteAccessService>;
