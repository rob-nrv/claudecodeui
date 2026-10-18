import type { ChatMessage } from '../types/types';

/**
 * Claude desktop collapses every run of consecutive tool calls between two
 * text blocks into one summary line ("Ran 2 commands ›"), even a single call.
 */
export const TOOL_GROUP_THRESHOLD = 1;

/** Tools that ask the user something stay inline instead of being collapsed. */
const INLINE_TOOL_NAMES = new Set(['AskUserQuestion', 'ExitPlanMode', 'exit_plan_mode']);

export interface ToolGroupItem {
  _isGroup: true;
  /** First tool of the run (kept for callers that style by tool). */
  toolName: string;
  messages: ChatMessage[];
  timestamp: ChatMessage['timestamp'];
}

export type MessageListItem = ChatMessage | ToolGroupItem;

export function isToolGroupItem(item: MessageListItem): item is ToolGroupItem {
  return '_isGroup' in item && (item as ToolGroupItem)._isGroup === true;
}

function isGroupableToolMessage(message: ChatMessage): message is ChatMessage & { toolName: string } {
  return Boolean(
    message.isToolUse
    && message.toolName
    && !message.isSubagentContainer
    && !INLINE_TOOL_NAMES.has(message.toolName),
  );
}

// Messages that render nothing (e.g. reasoning hidden when showThinking is off)
// shouldn't split an otherwise-continuous run of tools — providers like
// Codex interleave hidden reasoning between consecutive tool calls.
function rendersNothing(message: ChatMessage, showThinking: boolean): boolean {
  return Boolean(message.isThinking && !showThinking);
}

export function groupConsecutiveTools(
  messages: ChatMessage[],
  showThinking: boolean = true,
): MessageListItem[] {
  const items: MessageListItem[] = [];
  let index = 0;

  while (index < messages.length) {
    const message = messages[index];

    if (!isGroupableToolMessage(message)) {
      items.push(message);
      index += 1;
      continue;
    }

    const run: ChatMessage[] = [message];
    let nextIndex = index + 1;

    while (nextIndex < messages.length) {
      const candidate = messages[nextIndex];

      // Skip invisible interleaved messages so they don't break the run.
      if (rendersNothing(candidate, showThinking)) {
        nextIndex += 1;
        continue;
      }

      if (isGroupableToolMessage(candidate)) {
        run.push(candidate);
        nextIndex += 1;
        continue;
      }

      break;
    }

    if (run.length >= TOOL_GROUP_THRESHOLD) {
      items.push({
        _isGroup: true,
        toolName: message.toolName,
        messages: run,
        timestamp: message.timestamp,
      });
    } else {
      items.push(...run);
    }

    index = nextIndex;
  }

  return items;
}

const parseInput = (toolInput: unknown): Record<string, unknown> => {
  if (toolInput && typeof toolInput === 'object') {
    return toolInput as Record<string, unknown>;
  }
  if (typeof toolInput === 'string') {
    try {
      const parsed = JSON.parse(toolInput);
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return {};
};

const readString = (input: Record<string, unknown>, ...keys: string[]): string => {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
};

const baseName = (filePath: string): string => filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath;

type ToolKind = 'command' | 'read' | 'edit' | 'create' | 'search' | 'web' | 'todo' | 'other';

const TOOL_KINDS: Record<string, ToolKind> = {
  Bash: 'command',
  BashOutput: 'command',
  shell: 'command',
  Read: 'read',
  NotebookRead: 'read',
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  ApplyPatch: 'edit',
  apply_patch: 'edit',
  Write: 'create',
  Grep: 'search',
  Glob: 'search',
  LS: 'search',
  WebFetch: 'web',
  WebSearch: 'web',
  TodoWrite: 'todo',
  TodoRead: 'todo',
};

const kindOf = (toolName: string | undefined): ToolKind => (toolName ? TOOL_KINDS[toolName] ?? 'other' : 'other');

export type ToolSummarySegment = { text: string; strong?: boolean };
export type ToolDiffStat = { added: number; removed: number };
export type ToolGroupSummary = { segments: ToolSummarySegment[]; diff: ToolDiffStat | null };

const splitLines = (value: unknown): string[] => (typeof value === 'string' && value.length > 0 ? value.replace(/\n$/, '').split('\n') : []);

/** Line-level diff size (longest common subsequence), as a diff view would count it. */
export function countLineChanges(before: string[], after: string[]): ToolDiffStat {
  const rows = before.length + 1;
  const cols = after.length + 1;
  if (rows * cols > 4_000_000) {
    return { added: after.length, removed: before.length };
  }
  const table = new Uint32Array(rows * cols);
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] = before[i] === after[j]
        ? table[(i + 1) * cols + j + 1] + 1
        : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
    }
  }
  const common = table[0];
  return { added: after.length - common, removed: before.length - common };
}

function diffOf(message: ChatMessage): ToolDiffStat | null {
  if (message.toolResult?.isError) return null;
  const input = parseInput(message.toolInput);
  switch (message.toolName) {
    case 'Edit':
      return countLineChanges(splitLines(input.old_string), splitLines(input.new_string));
    case 'MultiEdit': {
      const edits = Array.isArray(input.edits) ? input.edits as Record<string, unknown>[] : [];
      return edits.reduce<ToolDiffStat>((total, edit) => {
        const part = countLineChanges(splitLines(edit.old_string), splitLines(edit.new_string));
        return { added: total.added + part.added, removed: total.removed + part.removed };
      }, { added: 0, removed: 0 });
    }
    case 'Write':
      return { added: splitLines(input.content).length, removed: 0 };
    default:
      return null;
  }
}

const fileOf = (message: ChatMessage): string => readString(parseInput(message.toolInput), 'file_path', 'path', 'notebook_path');

/*
 * Claude desktop wording, observed on the live app (2026-10-18):
 *   "Ran 3 commands, edited build.py +2 −1", "Ran a command, read 2 files",
 *   "Saved a memory, ran 2 commands, used a tool", "Read 3 files".
 * A run made of one command with a description shows that description.
 */
export function describeToolGroup(messages: ChatMessage[]): ToolGroupSummary {
  if (messages.length === 0) {
    return { segments: [], diff: null };
  }
  if (messages.length === 1 && kindOf(messages[0].toolName) === 'command') {
    const description = readString(parseInput(messages[0].toolInput), 'description');
    if (description) {
      return { segments: [{ text: description }], diff: null };
    }
  }

  const byKind = new Map<ToolKind, ChatMessage[]>();
  for (const message of messages) {
    const kind = kindOf(message.toolName);
    byKind.set(kind, [...(byKind.get(kind) ?? []), message]);
  }

  const segments: ToolSummarySegment[] = [];
  let diff: ToolDiffStat | null = null;
  const push = (...parts: ToolSummarySegment[]) => {
    if (segments.length > 0) segments.push({ text: ', ' });
    segments.push(...parts);
  };
  const files = (group: ChatMessage[]) => [...new Set(group.map(fileOf).filter(Boolean))];

  for (const [kind, group] of byKind) {
    const count = group.length;
    switch (kind) {
      case 'command':
        push({ text: count === 1 ? 'ran a command' : `ran ${count} commands` });
        break;
      case 'read': {
        const names = files(group);
        push(...(names.length === 1 ? [{ text: 'read ' }, { text: baseName(names[0]), strong: true }] : [{ text: `read ${names.length || count} files` }]));
        break;
      }
      case 'edit':
      case 'create': {
        const verb = kind === 'edit' ? 'edited' : 'created';
        const names = files(group);
        if (names.length === 1) {
          push({ text: `${verb} ` }, { text: baseName(names[0]), strong: true });
          diff = group.reduce<ToolDiffStat | null>((total, message) => {
            const part = diffOf(message);
            if (!part) return total;
            return { added: (total?.added ?? 0) + part.added, removed: (total?.removed ?? 0) + part.removed };
          }, null);
        } else {
          push({ text: `${verb} ${names.length || count} files` });
        }
        break;
      }
      case 'search':
        push({ text: count === 1 ? 'ran a search' : `ran ${count} searches` });
        break;
      case 'web':
        push({ text: count === 1 ? 'made a web request' : `made ${count} web requests` });
        break;
      case 'todo':
        push({ text: 'updated the task list' });
        break;
      default:
        push({ text: count === 1 ? 'used a tool' : `used ${count} tools` });
    }
  }

  // Only one file was edited: its line diff is shown; several files keep the count alone.
  const editedFiles = files([...(byKind.get('edit') ?? []), ...(byKind.get('create') ?? [])]);
  if (editedFiles.length !== 1 || (diff && diff.added + diff.removed === 0)) diff = null;

  const first = segments[0];
  segments[0] = { ...first, text: first.text.charAt(0).toUpperCase() + first.text.slice(1) };
  return { segments, diff };
}

/** Plain-text form of {@link describeToolGroup} (accessibility labels, tests). */
export function summarizeToolGroup(messages: ChatMessage[]): string {
  const { segments, diff } = describeToolGroup(messages);
  const text = segments.map((segment) => segment.text).join('');
  return diff ? `${text} +${diff.added} −${diff.removed}` : text;
}
