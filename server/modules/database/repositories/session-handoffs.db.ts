import { getConnection } from '@/modules/database/connection.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';

export type SessionHandoffRow = {
  handoff_id: string;
  target_session_id: string;
  source_session_id: string;
  task_root_session_id: string;
  source_provider: string;
  source_claude_profile_id: string | null;
  source_provider_session_id: string | null;
  source_model: string | null;
  source_effort: string | null;
  source_title: string | null;
  target_provider: string;
  target_claude_profile_id: string | null;
  handoff_package: string;
  created_at: string;
};

type CreateHandoffTargetInput = {
  handoffId: string;
  targetSessionId: string;
  targetProvider: string;
  /** Validated by the caller; becomes the target row's permanent binding. */
  targetClaudeProfileId: string | null;
  targetName: string;
  projectPath: string;
  sourceSessionId: string;
  taskRootSessionId: string;
  sourceProvider: string;
  sourceClaudeProfileId: string | null;
  sourceProviderSessionId: string | null;
  sourceModel: string | null;
  sourceEffort: string | null;
  sourceTitle: string | null;
  handoffPackage: string;
};

const HANDOFF_ROW_COLUMNS = `handoff_id, target_session_id, source_session_id, task_root_session_id,
  source_provider, source_claude_profile_id, source_provider_session_id, source_model, source_effort,
  source_title, target_provider, target_claude_profile_id, handoff_package, created_at`;

/**
 * Persistence for FT-M05 handoff lineage (`session_handoffs`).
 *
 * There is intentionally no update method: a handoff record is provenance,
 * written once with its target session and never rewritten. The source
 * session row is never touched by anything in this repository.
 */
export const sessionHandoffsDb = {
  /**
   * Creates the target session row and its lineage record atomically.
   *
   * Both inserts share one transaction so a failure on either side leaves no
   * target session without provenance, and no provenance pointing at a
   * session that does not exist.
   */
  createTargetSession(input: CreateHandoffTargetInput): void {
    const db = getConnection();

    db.transaction(() => {
      sessionsDb.createAppSession(
        input.targetSessionId,
        input.targetProvider,
        input.projectPath,
        input.targetName,
        input.targetClaudeProfileId,
      );

      db.prepare(
        `INSERT INTO session_handoffs (${HANDOFF_ROW_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
      ).run(
        input.handoffId,
        input.targetSessionId,
        input.sourceSessionId,
        input.taskRootSessionId,
        input.sourceProvider,
        input.sourceClaudeProfileId,
        input.sourceProviderSessionId,
        input.sourceModel,
        input.sourceEffort,
        input.sourceTitle,
        input.targetProvider,
        input.targetClaudeProfileId,
        input.handoffPackage,
      );
    })();
  },

  /** The handoff that created this session, or null when it was not a handoff target. */
  getByTargetSessionId(targetSessionId: string): SessionHandoffRow | null {
    const db = getConnection();
    const row = db
      .prepare(`SELECT ${HANDOFF_ROW_COLUMNS} FROM session_handoffs WHERE target_session_id = ?`)
      .get(targetSessionId) as SessionHandoffRow | undefined;
    return row ?? null;
  },

  /** Every handoff that continued this session elsewhere, oldest first. */
  listBySourceSessionId(sourceSessionId: string): SessionHandoffRow[] {
    const db = getConnection();
    return db
      .prepare(
        `SELECT ${HANDOFF_ROW_COLUMNS} FROM session_handoffs
         WHERE source_session_id = ?
         ORDER BY datetime(created_at) ASC, handoff_id ASC`
      )
      .all(sourceSessionId) as SessionHandoffRow[];
  },
};
