import crypto from 'node:crypto';

import type {
  ProviderPendingPermission,
  ProviderPermissionDecision,
  ProviderPermissionOutcome,
  ProviderPermissionOutcomeRecord,
  ProviderPermissionResolution,
  ProviderPermissionScope,
} from '@/shared/types.js';

/**
 * How long a non-interactive tool approval (Edit, Bash, Read, ...) waits for
 * the user. The previous 55s window expired before a phone user could react
 * to the push notification; see docs/mobile-north-star/DECISIONS.md D5.
 * `CLAUDE_TOOL_APPROVAL_TIMEOUT_MS` still overrides it.
 *
 * Consumed by `claude-runtime.provider.js` (canUseTool) and its tests.
 */
export const TOOL_APPROVAL_TIMEOUT_MS =
  Number.parseInt(process.env.CLAUDE_TOOL_APPROVAL_TIMEOUT_MS ?? '', 10) || 15 * 60 * 1000;

/**
 * How long settled approvals stay queryable. Lets a late or duplicate answer
 * be told *why* it no longer applies, and lets a client that reconnects learn
 * that a request expired while it was away.
 */
const SETTLED_RETENTION_MS = 30 * 60 * 1000;
const MAX_SETTLED_RECORDS = 200;

type ToolApprovalWaitResult =
  | { outcome: 'answered'; decision: ProviderPermissionDecision }
  | { outcome: 'expired' }
  | { outcome: 'cancelled' };

type OpenToolApprovalOptions = {
  requestId?: string;
  /** App session id the request belongs to; responses must match it. */
  sessionId: string | null;
  toolName: string;
  input: unknown;
  /** The SDK's tool_use id, when the caller has one. See `ProviderPendingPermission.toolId`. */
  toolId?: string;
  /** 0 waits indefinitely (interactive tools such as AskUserQuestion). */
  timeoutMs: number;
  /** The SDK's per-tool abort signal (run aborted or turn interrupted). */
  signal?: AbortSignal;
  /** Runs synchronously when the request settles without a user answer. */
  onSettledWithoutAnswer?: (outcome: 'expired' | 'cancelled', request: ProviderPendingPermission) => void;
};

type PendingEntry = {
  request: ProviderPendingPermission;
  answer: (decision: ProviderPermissionDecision) => void;
};

/**
 * Model-facing tool result for an expired approval. Expiry is not a denial:
 * the native SDK only offers allow/deny (its `interrupt` flag rewrites the
 * message into "the user doesn't want to proceed"), so the distinction has to
 * be carried by the message itself.
 *
 * Consumed by `claude-runtime.provider.js`; the frontend recognises the
 * "Permission request expired" prefix to label the tool row as expired.
 */
export function buildExpiredApprovalMessage(timeoutMs: number): string {
  const window = timeoutMs >= 60_000
    ? `${Math.round(timeoutMs / 60_000)} minute${Math.round(timeoutMs / 60_000) === 1 ? '' : 's'}`
    : `${Math.max(1, Math.round(timeoutMs / 1000))} seconds`;
  return `Permission request expired: nobody answered within ${window}, so this tool call did not run. `
    + 'The user did not deny it. Do not retry it on your own; tell the user what still needs their approval and end your turn.';
}

/**
 * Creates the backend source of truth for tool approvals of one runtime.
 *
 * A request is `pending` until exactly one of: a user answer, expiry, or
 * cancellation (SDK abort). The first settlement wins; every later answer is
 * rejected with the reason, so a response can never be applied twice.
 *
 * In-memory on purpose: a pending request is only meaningful while the Claude
 * run that asked is alive in this server process.
 *
 * Consumed by `claude-runtime.provider.js` (singleton below) and by tests,
 * which build isolated registries.
 */
export function createToolApprovalRegistry(options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const pending = new Map<string, PendingEntry>();
  const settled = new Map<string, ProviderPermissionOutcomeRecord>();

  const pruneSettled = () => {
    const cutoff = now() - SETTLED_RETENTION_MS;
    // Map iteration is insertion order, so the oldest records come first.
    for (const [requestId, record] of settled) {
      if (Date.parse(record.settledAt) >= cutoff && settled.size <= MAX_SETTLED_RECORDS) {
        break;
      }
      settled.delete(requestId);
    }
  };

  const settle = (request: ProviderPendingPermission, outcome: ProviderPermissionOutcome) => {
    pending.delete(request.requestId);
    settled.set(request.requestId, {
      requestId: request.requestId,
      sessionId: request.sessionId,
      toolName: request.toolName,
      outcome,
      settledAt: new Date(now()).toISOString(),
      // Only an expired request is re-surfaced to the user, so only it keeps
      // its (possibly large) input.
      ...(outcome === 'expired' ? { input: request.input } : {}),
    });
    pruneSettled();
  };

  return {
    /**
     * Registers a pending approval synchronously and returns its public record
     * plus a promise for how it settles.
     */
    open(openOptions: OpenToolApprovalOptions): {
      request: ProviderPendingPermission;
      result: Promise<ToolApprovalWaitResult>;
    } {
      const receivedAtMs = now();
      const request: ProviderPendingPermission = {
        requestId: openOptions.requestId ?? crypto.randomUUID(),
        sessionId: openOptions.sessionId,
        toolName: openOptions.toolName,
        input: openOptions.input,
        receivedAt: new Date(receivedAtMs).toISOString(),
        expiresAt: openOptions.timeoutMs > 0
          ? new Date(receivedAtMs + openOptions.timeoutMs).toISOString()
          : null,
        ...(openOptions.toolId ? { toolId: openOptions.toolId } : {}),
      };

      let resolveResult!: (result: ToolApprovalWaitResult) => void;
      const result = new Promise<ToolApprovalWaitResult>((resolve) => {
        resolveResult = resolve;
      });

      let timer: ReturnType<typeof setTimeout> | null = null;
      const { signal } = openOptions;

      const finish = (waitResult: ToolApprovalWaitResult) => {
        if (pending.get(request.requestId) !== entry) {
          return;
        }
        if (timer) {
          clearTimeout(timer);
        }
        signal?.removeEventListener('abort', handleAbort);
        settle(request, waitResult.outcome);
        if (waitResult.outcome !== 'answered') {
          openOptions.onSettledWithoutAnswer?.(waitResult.outcome, request);
        }
        resolveResult(waitResult);
      };

      const handleAbort = () => finish({ outcome: 'cancelled' });
      const entry: PendingEntry = {
        request,
        answer: (decision) => finish({ outcome: 'answered', decision }),
      };
      pending.set(request.requestId, entry);

      if (signal?.aborted) {
        handleAbort();
        return { request, result };
      }
      signal?.addEventListener('abort', handleAbort, { once: true });

      if (openOptions.timeoutMs > 0) {
        timer = setTimeout(() => finish({ outcome: 'expired' }), openOptions.timeoutMs);
      }

      return { request, result };
    },

    /**
     * Applies a user answer. Only a pending request in the same session is
     * accepted; anything else is rejected with the reason it no longer applies.
     */
    resolve(
      requestId: string,
      decision: ProviderPermissionDecision,
      scope: ProviderPermissionScope = {},
    ): ProviderPermissionResolution {
      const entry = pending.get(requestId);
      const record = entry?.request ?? settled.get(requestId);
      if (!record) {
        return { status: 'rejected', reason: 'not_found' };
      }
      // Checked before revealing the outcome: another session's request must
      // stay opaque to this caller.
      if (scope.sessionId && record.sessionId && scope.sessionId !== record.sessionId) {
        return { status: 'rejected', reason: 'session_mismatch' };
      }
      if (entry) {
        entry.answer(decision);
        return { status: 'accepted' };
      }
      const outcome = settled.get(requestId)!.outcome;
      return { status: 'rejected', reason: outcome === 'answered' ? 'already_answered' : outcome };
    },

    listPending(sessionId: string): ProviderPendingPermission[] {
      return Array.from(pending.values())
        .map((entry) => entry.request)
        .filter((request) => request.sessionId === sessionId);
    },

    listRecentOutcomes(sessionId: string): ProviderPermissionOutcomeRecord[] {
      pruneSettled();
      return Array.from(settled.values()).filter((record) => record.sessionId === sessionId);
    },
  };
}

/**
 * The Claude runtime's approval registry, consumed by
 * `claude-runtime.provider.js` for canUseTool and its `permissions` gateway.
 */
export const claudeToolApprovals = createToolApprovalRegistry();
