import type { NormalizedMessage } from './useSessionStore';

/**
 * Filters out any incoming realtime message whose `id` is already present.
 *
 * `chat.subscribe` replays buffered live events strictly after `lastSeq`,
 * but a client that resets its in-memory sequence tracking without losing
 * this store's already-appended messages (e.g. a mobile tab suspended and
 * woken back up mid-run) will resubscribe with a stale `lastSeq` and receive
 * events it already has. `appendRealtime`/`appendRealtimeBatch` used to
 * insert those unconditionally, so the exact same tool_use/tool_result could
 * land twice and render as two identical rows for one real approval.
 */
export function dedupeIncomingRealtimeMessages(
  existing: NormalizedMessage[],
  incoming: NormalizedMessage[],
): NormalizedMessage[] {
  const seen = new Set(existing.map((message) => message.id));
  const deduped: NormalizedMessage[] = [];
  for (const message of incoming) {
    if (seen.has(message.id)) {
      continue;
    }
    seen.add(message.id);
    deduped.push(message);
  }
  return deduped;
}

/**
 * Merges a settled tool approval's effective input into its tool_use row.
 *
 * The real Claude CLI never rewrites a tool_use's own `input` once a
 * client-side decision (e.g. an AskUserQuestion answer) resolves it — it
 * only narrates the outcome as prose in the tool_result. Without this patch,
 * `input.answers` stays empty forever and the transcript reads "Skipped"
 * even when the question was genuinely answered.
 */
export function applyToolUseInputPatch(
  messages: NormalizedMessage[],
  toolId: string,
  toolInput: unknown,
): NormalizedMessage[] {
  let changed = false;
  const next = messages.map((message) => {
    if (message.kind === 'tool_use' && message.toolId === toolId) {
      changed = true;
      return { ...message, toolInput };
    }
    return message;
  });
  return changed ? next : messages;
}
