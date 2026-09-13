import { createPublicKey, randomUUID } from 'node:crypto';

import type { EnrollmentRedemption } from '@/modules/database/index.js';
import type { FailureRateLimiter } from '@/shared/types.js';
import {
  AppError,
  createFailureRateLimiter,
  generateOneTimeCode,
  hashSecretValue,
  normalizeOneTimeCode,
} from '@/shared/utils.js';

const ENROLLMENT_CODE_TTL_MS = 15 * 60_000;
const MAX_OUTSTANDING_ENROLLMENTS = 5;
const MAX_LABEL_LENGTH = 64;
const MAX_FACT_LENGTH = 32;
const MAX_VERSION_LENGTH = 32;
const MAX_PUBLIC_KEY_LENGTH = 1024;

type EnrollmentStore = {
  create(input: { codeHash: string; label: string | null; createdByUserId: number | null; createdAt: number; expiresAt: number }): void;
  countOutstanding(now: number): number;
  prune(before: number): void;
  redeem(
    codeHash: string,
    now: number,
    node: { nodeId: string; label: string; platform: string | null; arch: string | null; runtimeVersion: string | null; publicKey: string },
  ): EnrollmentRedemption;
};

/** Labels are display text chosen by a person; control characters and oversize input never reach the UI. */
function sanitizeLabel(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const cleaned = [...value].filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127).join('').trim().slice(0, MAX_LABEL_LENGTH);
  return cleaned || null;
}

/** Platform/arch/version are descriptive facts a node reports; they never imply a capability. */
function sanitizeFact(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const cleaned = value.replace(/[^A-Za-z0-9._+-]/g, '').slice(0, maxLength);
  return cleaned || null;
}

/** Accepts only an Ed25519 public key and re-exports it canonically, so one key has exactly one stored form. */
function canonicalizeEd25519PublicKey(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_PUBLIC_KEY_LENGTH) {
    return null;
  }
  try {
    const key = createPublicKey(value);
    if (key.asymmetricKeyType !== 'ed25519') {
      return null;
    }
    return key.export({ type: 'spki', format: 'pem' }).toString();
  } catch {
    return null;
  }
}

const enrollmentFailedError = () => new AppError('Enrollment failed. Create a new enrollment code in CloudCLI and try again.', {
  code: 'RUNTIME_NODE_ENROLLMENT_FAILED',
  statusCode: 401,
});

/**
 * One-time RuntimeNode enrollment (FT-M08). An authenticated user issues a
 * short-lived code; the node agent redeems it with a public key it generated
 * itself, and the control plane mints the node id. Nothing a client sends
 * decides the node's identity.
 */
export function createRuntimeNodeEnrollmentService(dependencies: {
  store: EnrollmentStore;
  now?: () => number;
  createNodeId?: () => string;
  limiter?: FailureRateLimiter;
}) {
  const now = dependencies.now ?? Date.now;
  const createNodeId = dependencies.createNodeId ?? randomUUID;
  const limiter = dependencies.limiter ?? createFailureRateLimiter({
    windowMs: 15 * 60_000,
    maxFailuresPerKey: 10,
    maxFailuresGlobal: 30,
    now,
  });

  return {
    createEnrollment(userId: number | null, labelInput: unknown): { code: string; expiresAt: string; label: string | null } {
      const at = now();
      dependencies.store.prune(at - ENROLLMENT_CODE_TTL_MS);
      if (dependencies.store.countOutstanding(at) >= MAX_OUTSTANDING_ENROLLMENTS) {
        throw new AppError('Too many enrollment codes are waiting to be used. Wait for one to expire.', {
          code: 'RUNTIME_NODE_ENROLLMENT_LIMIT',
          statusCode: 429,
        });
      }
      const code = generateOneTimeCode();
      const label = sanitizeLabel(labelInput);
      const expiresAt = at + ENROLLMENT_CODE_TTL_MS;
      dependencies.store.create({
        codeHash: hashSecretValue(normalizeOneTimeCode(code) as string),
        label,
        createdByUserId: userId,
        createdAt: at,
        expiresAt,
      });
      return { code, expiresAt: new Date(expiresAt).toISOString(), label };
    },

    redeem(input: {
      code: unknown;
      publicKey: unknown;
      label: unknown;
      platform: unknown;
      arch: unknown;
      runtimeVersion: unknown;
      clientKey: string;
    }): { nodeId: string } {
      const gate = limiter.check(input.clientKey);
      if (!gate.allowed) {
        throw new AppError('Too many failed enrollment attempts. Try again later.', {
          code: 'RUNTIME_NODE_ENROLLMENT_RATE_LIMITED',
          statusCode: 429,
          details: { retryAfterSeconds: Math.ceil(gate.retryAfterMs / 1000) },
        });
      }

      const normalizedCode = normalizeOneTimeCode(input.code);
      const publicKey = canonicalizeEd25519PublicKey(input.publicKey);
      if (!normalizedCode || !publicKey) {
        limiter.recordFailure(input.clientKey);
        throw enrollmentFailedError();
      }

      const redemption = dependencies.store.redeem(hashSecretValue(normalizedCode), now(), {
        nodeId: createNodeId(),
        label: sanitizeLabel(input.label) ?? 'Runtime node',
        platform: sanitizeFact(input.platform, MAX_FACT_LENGTH),
        arch: sanitizeFact(input.arch, MAX_FACT_LENGTH),
        runtimeVersion: sanitizeFact(input.runtimeVersion, MAX_VERSION_LENGTH),
        publicKey,
      });

      if (redemption.status === 'key_conflict') {
        // The code was not burned; the key is simply refused.
        throw new AppError('This node key is already enrolled. Generate a new key to enroll another node.', {
          code: 'RUNTIME_NODE_KEY_CONFLICT',
          statusCode: 409,
        });
      }
      if (redemption.status !== 'enrolled') {
        limiter.recordFailure(input.clientKey);
        throw enrollmentFailedError();
      }
      limiter.reset(input.clientKey);
      return { nodeId: redemption.nodeId };
    },
  };
}
