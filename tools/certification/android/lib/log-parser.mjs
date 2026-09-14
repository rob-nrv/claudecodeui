// Pure parsing of node-agent's own log text (as printed by
// server/modules/node-agent/*.ts's `log(...)` calls and
// server/modules/node-agent/node-agent-runtime.ts's startup message). Takes
// a string, returns plain data — no filesystem, so it's testable against
// fixture text without a device or a running agent.

const ACCEPTED_RE = /^\[node\] Run ([0-9a-f-]{36}) accepted for session (\S+)/;
const FINISHED_RE = /^\[node\] Run ([0-9a-f-]{36}) finished \((completed|failed|aborted)\)/;
const ABORTING_RE = /^\[node\] Aborting run ([0-9a-f-]{36}): (.+)$/;
const GOVERNOR_REFUSED_RE = /^\[node\] Run ([0-9a-f-]{36}) refused by the resource governor: (\S+)/;
const CONNECTED_RE = /Connected to control plane as node (\S+)\.?$/;
const LINK_ERROR_RE = /^\[node\] Link error: (.+)$/;
const INTERRUPTED_ON_RESTART_RE = /^(\d+) run\(s\) were interrupted when this agent last stopped\./;

/**
 * Parses one agent.log's full text into structured events, each carrying
 * the 1-based line number it came from (for cross-referencing evidence).
 * Unrecognized lines are silently skipped — this is a log, not a protocol.
 */
export function parseAgentLog(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const events = [];
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    let match;
    if ((match = ACCEPTED_RE.exec(line))) {
      events.push({ type: 'accepted', executionId: match[1], sessionId: match[2], lineNumber });
      return;
    }
    if ((match = FINISHED_RE.exec(line))) {
      events.push({ type: 'finished', executionId: match[1], outcome: match[2], lineNumber });
      return;
    }
    if ((match = ABORTING_RE.exec(line))) {
      events.push({ type: 'aborting', executionId: match[1], reason: match[2], lineNumber });
      return;
    }
    if ((match = GOVERNOR_REFUSED_RE.exec(line))) {
      events.push({ type: 'governor_refused', executionId: match[1], code: match[2], lineNumber });
      return;
    }
    if ((match = CONNECTED_RE.exec(line))) {
      events.push({ type: 'connected', nodeId: match[1], lineNumber });
      return;
    }
    if ((match = LINK_ERROR_RE.exec(line))) {
      events.push({ type: 'link_error', message: match[1], lineNumber });
      return;
    }
    if ((match = INTERRUPTED_ON_RESTART_RE.exec(line))) {
      events.push({ type: 'interrupted_on_restart', count: Number(match[1]), lineNumber });
      return;
    }
  });
  return events;
}

/** How many distinct execution ids were ever accepted — the duplicate-dispatch check counts this, not lines. */
export function acceptedExecutionIds(events) {
  return [...new Set(events.filter((event) => event.type === 'accepted').map((event) => event.executionId))];
}

/**
 * True only if every accepted execution id was accepted exactly once. A node
 * that ever logged the same id twice — even if the second attempt would
 * have been the one rejected as DUPLICATE_EXECUTION upstream — is a finding
 * worth surfacing, so this checks the raw count, not de-duplicated identity.
 */
export function noDuplicateAcceptance(events) {
  const counts = new Map();
  for (const event of events) {
    if (event.type !== 'accepted') continue;
    counts.set(event.executionId, (counts.get(event.executionId) ?? 0) + 1);
  }
  const duplicated = [...counts.entries()].filter(([, count]) => count > 1).map(([executionId]) => executionId);
  return { ok: duplicated.length === 0, duplicated };
}

/** Final outcome per execution id, from `finished`/`aborting` events, in log order (last one wins). */
export function outcomesByExecution(events) {
  const outcomes = new Map();
  for (const event of events) {
    if (event.type === 'finished') {
      outcomes.set(event.executionId, event.outcome);
    }
  }
  return outcomes;
}

/** True once a `connected` event appears after the last `link_error` for this parse — i.e. the node ended up reconnected, not stuck retrying. */
export function endedConnected(events) {
  const lastConnected = [...events].reverse().find((event) => event.type === 'connected');
  const lastLinkError = [...events].reverse().find((event) => event.type === 'link_error');
  if (!lastConnected) return false;
  if (!lastLinkError) return true;
  return lastConnected.lineNumber > lastLinkError.lineNumber;
}

/**
 * Classifies one reconnect window: did the node abort locally (`aborting`)
 * before it reconnected (`connected`) after the given start line? This is
 * the exact HC-06 short-reconnect question — a premature local abort before
 * the reconnect is exactly the a31c3765 regression, whether or not the
 * reconnect itself later succeeds.
 */
export function reconnectOutcome(events, sinceLineNumber = 0) {
  const windowed = events.filter((event) => event.lineNumber >= sinceLineNumber);
  const abortedAt = windowed.find((event) => event.type === 'aborting' && /control plane did not reconnect/.test(event.reason));
  const connectedAt = windowed.find((event) => event.type === 'connected');
  if (abortedAt && (!connectedAt || abortedAt.lineNumber < connectedAt.lineNumber)) {
    return { outcome: 'aborted_before_reconnect', abortedAt, connectedAt: connectedAt ?? null };
  }
  if (connectedAt) {
    return { outcome: 'reconnected_without_local_abort', connectedAt };
  }
  return { outcome: 'no_reconnect_observed' };
}

/** The count from the last "N run(s) were interrupted when this agent last stopped." line, or null if the agent has never reported one. */
export function lastInterruptedOnRestart(events) {
  const matches = events.filter((event) => event.type === 'interrupted_on_restart');
  return matches.length > 0 ? matches[matches.length - 1].count : null;
}
