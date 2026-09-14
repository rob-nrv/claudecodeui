// Pure classification of frames the chat WebSocket sends to the browser
// (every one carries a `kind`; see server/modules/websocket/services/
// chat-websocket.service.ts's `sendProtocolError` and the various
// `createNormalizedMessage`/`createCompleteMessage` call sites, and
// server/modules/runtime-nodes/runtime-node-remote-execution.service.ts's
// `REJECTION_MESSAGES`). No socket or timer here — feed it a frame you
// already received, get back what it means for the certification harness.

export function isProtocolError(frame, code) {
  return frame?.kind === 'protocol_error' && (code === undefined || frame.code === code);
}

/** The "session bound to this node, but the node has no live link" refusal — resolved before any run object exists (chat-websocket.service.ts's resolveSessionExecution path). */
export function isOfflineRefusal(frame) {
  return isProtocolError(frame, 'RUNTIME_NODE_OFFLINE');
}

export function offlineRefusalAlternatives(frame) {
  return isOfflineRefusal(frame) ? (frame.alternatives ?? []) : null;
}

/** A run-level `kind: 'error'` message, as emitted by the remote-execution service's `emitError`. */
export function isErrorEvent(frame) {
  return frame?.kind === 'error' && typeof frame.content === 'string';
}

function errorContentMatches(frame, pattern) {
  return isErrorEvent(frame) && pattern.test(frame.content);
}

/** The link-loss failure after the (now widened, HC-06) reconnect grace expires — see runtime-node-remote-execution.service.ts's `failDisconnected`. */
export function isLinkLostFailure(frame) {
  return errorContentMatches(frame, /^Lost the connection to .+\. The run was stopped there and was not moved to another node\.$/);
}

/** The concurrency-governor refusal — REJECTION_MESSAGES.RESOURCE_CONCURRENCY_LIMIT, verbatim. */
export function isConcurrencyGovernorRefusal(frame) {
  return errorContentMatches(frame, /^The runtime node is already running as many sessions as it allows\. The message was not sent, and it was not moved to another node\.$/);
}

/** The storage-floor governor refusal — REJECTION_MESSAGES.RESOURCE_STORAGE_LOW, verbatim. */
export function isStorageGovernorRefusal(frame) {
  return errorContentMatches(frame, /^The runtime node is low on free storage and refused new runs\. The message was not sent, and it was not moved to another node\.$/);
}

/** A node that restarted and lost track of a run it used to own. */
export function isRestartedFailure(frame) {
  return errorContentMatches(frame, /restarted and no longer has this run\. It was not moved to another node\./);
}

/**
 * The SDK's own hard-coded tool-denial text for an interrupted tool_use
 * (see server/modules/providers/list/claude/claude-tool-approvals.provider.ts's
 * comment) — this string should never legitimately reach the browser for a
 * run that resumed or failed explicitly; the harness treats seeing it at
 * all as a finding worth flagging, not a pass/fail signal by itself.
 */
export function containsSdkToolDenialWording(frame) {
  const text = typeof frame?.content === 'string' ? frame.content : typeof frame?.message === 'string' ? frame.message : '';
  return /doesn't want to proceed with this tool use/i.test(text);
}

export function isCompletion(frame) {
  return frame?.kind === 'complete';
}

export function completionExitCode(frame) {
  return isCompletion(frame) ? frame.exitCode ?? null : null;
}

export function isTextEvent(frame) {
  return frame?.kind === 'text' && typeof frame.content === 'string';
}

/**
 * Watches a growing list of frames for a session and reports the first
 * terminal-ish outcome recognized (an explicit refusal, a link-lost
 * failure, or a normal completion). Returns `null` while nothing terminal
 * has happened yet — callers pair this with
 * lib/human-checkpoint.mjs's `detect` contract directly.
 */
export function classifyRunOutcome(frames, sessionId) {
  const relevant = frames.filter((frame) => frame.sessionId === sessionId || frame.sessionId === null);
  for (const frame of relevant) {
    if (isOfflineRefusal(frame)) return { outcome: 'offline_refusal', frame };
    if (isLinkLostFailure(frame)) return { outcome: 'link_lost_failure', frame };
    if (isConcurrencyGovernorRefusal(frame)) return { outcome: 'concurrency_refused', frame };
    if (isStorageGovernorRefusal(frame)) return { outcome: 'storage_refused', frame };
    if (isRestartedFailure(frame)) return { outcome: 'restarted_failure', frame };
    if (isCompletion(frame)) return { outcome: 'completed', frame, exitCode: completionExitCode(frame) };
  }
  return null;
}
