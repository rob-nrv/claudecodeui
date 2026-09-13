import fs from 'node:fs/promises';
import path from 'node:path';

export type NodeRunOutcome = 'completed' | 'failed' | 'aborted' | 'interrupted';

export type NodeRunJournalEntry = {
  executionId: string;
  appSessionId: string;
  startedAt: number;
  finishedAt: number | null;
  outcome: NodeRunOutcome | null;
};

type JournalFile = {
  version: 1;
  lastCompletedAt: number | null;
  entries: NodeRunJournalEntry[];
};

/** File name of the journal inside the agent state directory. */
export const NODE_AGENT_RUN_JOURNAL_FILE = 'run-journal.json';

const EXECUTION_ID_PATTERN = /^[0-9a-f-]{36}$/;
const APP_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const OUTCOMES = new Set<NodeRunOutcome>(['completed', 'failed', 'aborted', 'interrupted']);

function parseEntry(value: unknown): NodeRunJournalEntry | null {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  if (
    !record
    || typeof record.executionId !== 'string' || !EXECUTION_ID_PATTERN.test(record.executionId)
    || typeof record.appSessionId !== 'string' || !APP_SESSION_ID_PATTERN.test(record.appSessionId)
    || typeof record.startedAt !== 'number' || !Number.isFinite(record.startedAt)
  ) {
    return null;
  }
  const finishedAt = typeof record.finishedAt === 'number' && Number.isFinite(record.finishedAt) ? record.finishedAt : null;
  const outcome = typeof record.outcome === 'string' && OUTCOMES.has(record.outcome as NodeRunOutcome) ? record.outcome as NodeRunOutcome : null;
  return { executionId: record.executionId, appSessionId: record.appSessionId, startedAt: record.startedAt, finishedAt, outcome };
}

/**
 * The minimum a node agent persists about its runs (FT-M09), owner-only in
 * its state directory: which execution ids it accepted and how each ended.
 *
 * - An execution id accepted before a restart is still refused afterwards, so
 *   no dispatch can ever run twice on this node.
 * - A run that was accepted but never finished when the agent last stopped is
 *   marked `interrupted` at the next start. The agent never resumes or re-runs
 *   it: its Claude process is gone, and the user retries explicitly.
 * - `lastCompletedAt` is the only headless-execution evidence this node has,
 *   and it comes from a run the user started — never a synthetic prompt.
 *
 * No prompt, output, path or credential is written here.
 */
export function createNodeAgentRunJournal(options: { file: string; now?: () => number; maxEntries?: number; log?: (message: string) => void }) {
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? 500;
  const log = options.log ?? (() => undefined);
  let state: JournalFile = { version: 1, lastCompletedAt: null, entries: [] };
  let writeChain: Promise<void> = Promise.resolve();

  const persist = (): Promise<void> => {
    const snapshot = `${JSON.stringify(state)}\n`;
    const write = async () => {
      await fs.mkdir(path.dirname(options.file), { recursive: true, mode: 0o700 });
      const temporary = `${options.file}.${process.pid}.tmp`;
      await fs.writeFile(temporary, snapshot, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temporary, options.file);
    };
    writeChain = writeChain.then(write, write).catch((error: unknown) => {
      // Losing the journal weakens restart evidence but never stops a run.
      log(`Run journal could not be written: ${error instanceof Error ? (error as NodeJS.ErrnoException).code ?? 'error' : 'error'}`);
    });
    return writeChain;
  };

  const prune = () => {
    if (state.entries.length > maxEntries) {
      state.entries = state.entries.slice(-maxEntries);
    }
  };

  return {
    /** Loads the journal and marks runs that never finished as interrupted. */
    async load(): Promise<{ interrupted: NodeRunJournalEntry[] }> {
      let raw: string | null = null;
      try {
        raw = await fs.readFile(options.file, 'utf8');
      } catch {
        raw = null;
      }
      if (raw !== null) {
        try {
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          const entries = Array.isArray(parsed.entries) ? parsed.entries.map(parseEntry).filter((entry): entry is NodeRunJournalEntry => entry !== null) : [];
          const lastCompletedAt = typeof parsed.lastCompletedAt === 'number' && Number.isFinite(parsed.lastCompletedAt) ? parsed.lastCompletedAt : null;
          state = { version: 1, lastCompletedAt, entries };
        } catch {
          log('Run journal was unreadable; starting a new one.');
        }
      }
      const at = now();
      const interrupted = state.entries.filter((entry) => entry.finishedAt === null);
      for (const entry of interrupted) {
        entry.finishedAt = at;
        entry.outcome = 'interrupted';
      }
      prune();
      if (interrupted.length > 0) {
        await persist();
      }
      return { interrupted: interrupted.map((entry) => ({ ...entry })) };
    },

    has(executionId: string): boolean {
      return state.entries.some((entry) => entry.executionId === executionId);
    },

    recordStarted(executionId: string, appSessionId: string): Promise<void> {
      state.entries.push({ executionId, appSessionId, startedAt: now(), finishedAt: null, outcome: null });
      prune();
      return persist();
    },

    recordFinished(executionId: string, outcome: Exclude<NodeRunOutcome, 'interrupted'>): Promise<void> {
      const entry = state.entries.find((candidate) => candidate.executionId === executionId);
      const at = now();
      if (entry) {
        entry.finishedAt = at;
        entry.outcome = outcome;
      }
      if (outcome === 'completed') {
        state.lastCompletedAt = at;
      }
      return persist();
    },

    lastCompletedAt(): number | null {
      return state.lastCompletedAt;
    },

    entries(): NodeRunJournalEntry[] {
      return state.entries.map((entry) => ({ ...entry }));
    },

    /** Resolves when every pending write has settled (tests, shutdown). */
    flush(): Promise<void> {
      return writeChain;
    },
  };
}

export type NodeAgentRunJournal = ReturnType<typeof createNodeAgentRunJournal>;

/**
 * Read-only summary for `cloudcli node status`: never marks, prunes or writes,
 * so it is safe while an agent is running.
 */
export async function readNodeAgentRunJournalSummary(file: string): Promise<
  | { state: 'missing' | 'unreadable' }
  | { state: 'ok'; unfinished: number; interrupted: number; lastCompletedAt: number | null }
> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    return { state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) {
      return { state: 'unreadable' };
    }
    const entries = parsed.entries.map(parseEntry).filter((entry): entry is NodeRunJournalEntry => entry !== null);
    return {
      state: 'ok',
      unfinished: entries.filter((entry) => entry.finishedAt === null).length,
      interrupted: entries.filter((entry) => entry.outcome === 'interrupted').length,
      lastCompletedAt: typeof parsed.lastCompletedAt === 'number' && Number.isFinite(parsed.lastCompletedAt) ? parsed.lastCompletedAt : null,
    };
  } catch {
    return { state: 'unreadable' };
  }
}
