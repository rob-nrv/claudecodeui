import { getConnection } from '@/modules/database/connection.js';
import type {
  ClaudeProfileConnectionState,
  ClaudeProfileVerificationMethod,
  ClaudeProfileVerifiedIdentity,
} from '@/shared/types.js';

/**
 * Internal, server-only row shape. Unlike the public `ClaudeProfile` API
 * type, this includes `configDirectory` — it must never leave this
 * repository/the `claude-profiles` service layer (`MULTI_ACCOUNT_SPEC.md`
 * §3.4/§5.2).
 */
export type ClaudeProfileRecord = {
  id: string;
  displayName: string;
  configDirectory: string;
  isDefault: boolean;
  connectionState: ClaudeProfileConnectionState;
  verifiedIdentity: ClaudeProfileVerifiedIdentity | null;
  createdAt: string;
  updatedAt: string;
};

type ClaudeProfileRow = {
  id: string;
  display_name: string;
  config_directory: string;
  is_default: number;
  connection_state: string;
  verified_identity_value: string | null;
  verified_identity_method: string | null;
  verified_identity_tier: string | null;
  verified_identity_verified_at: number | null;
  created_at: string;
  updated_at: string;
};

const toRecord = (row: ClaudeProfileRow): ClaudeProfileRecord => ({
  id: row.id,
  displayName: row.display_name,
  configDirectory: row.config_directory,
  isDefault: Boolean(row.is_default),
  connectionState: row.connection_state as ClaudeProfileConnectionState,
  verifiedIdentity: row.verified_identity_value
    ? {
      value: row.verified_identity_value,
      method: (row.verified_identity_method ?? 'none') as ClaudeProfileVerificationMethod,
      tier: row.verified_identity_tier,
      verifiedAt: row.verified_identity_verified_at ?? 0,
    }
    : null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const readById = (id: string): ClaudeProfileRow | undefined =>
  getConnection().prepare('SELECT * FROM claude_profiles WHERE id = ?').get(id) as ClaudeProfileRow | undefined;

export const claudeProfilesDb = {
  list(): ClaudeProfileRecord[] {
    const rows = getConnection()
      .prepare('SELECT * FROM claude_profiles ORDER BY created_at ASC, id ASC')
      .all() as ClaudeProfileRow[];
    return rows.map(toRecord);
  },

  count(): number {
    const row = getConnection()
      .prepare('SELECT COUNT(*) AS count FROM claude_profiles')
      .get() as { count: number };
    return row.count;
  },

  getById(id: string): ClaudeProfileRecord | null {
    const row = readById(id);
    return row ? toRecord(row) : null;
  },

  create(input: {
    id: string;
    displayName: string;
    configDirectory: string;
    isDefault: boolean;
  }): ClaudeProfileRecord {
    const db = getConnection();
    const insert = db.transaction(() => {
      if (input.isDefault) {
        db.prepare('UPDATE claude_profiles SET is_default = 0').run();
      }
      db.prepare(`
        INSERT INTO claude_profiles (id, display_name, config_directory, is_default, connection_state)
        VALUES (?, ?, ?, ?, 'unknown')
      `).run(input.id, input.displayName, input.configDirectory, input.isDefault ? 1 : 0);
    });
    insert();

    const row = readById(input.id);
    if (!row) {
      throw new Error('Created Claude profile could not be read back.');
    }
    return toRecord(row);
  },

  updateDisplayName(id: string, displayName: string): ClaudeProfileRecord | null {
    getConnection()
      .prepare('UPDATE claude_profiles SET display_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(displayName, id);
    const row = readById(id);
    return row ? toRecord(row) : null;
  },

  /** Unsets every other profile's default flag before setting this one's. */
  setDefault(id: string): ClaudeProfileRecord | null {
    const db = getConnection();
    const update = db.transaction(() => {
      const existing = readById(id);
      if (!existing) {
        return null;
      }
      db.prepare('UPDATE claude_profiles SET is_default = 0').run();
      db.prepare('UPDATE claude_profiles SET is_default = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
      return readById(id) ?? null;
    });
    const row = update();
    return row ? toRecord(row) : null;
  },

  updateConnectionState(
    id: string,
    state: {
      connectionState: ClaudeProfileConnectionState;
      verifiedIdentity: ClaudeProfileVerifiedIdentity | null;
    },
  ): ClaudeProfileRecord | null {
    getConnection().prepare(`
      UPDATE claude_profiles
      SET connection_state = ?,
          verified_identity_value = ?,
          verified_identity_method = ?,
          verified_identity_tier = ?,
          verified_identity_verified_at = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      state.connectionState,
      state.verifiedIdentity?.value ?? null,
      state.verifiedIdentity?.method ?? null,
      state.verifiedIdentity?.tier ?? null,
      state.verifiedIdentity?.verifiedAt ?? null,
      id,
    );
    const row = readById(id);
    return row ? toRecord(row) : null;
  },

  /**
   * Removes only the CloudCLI registration row. The profile's isolated
   * config directory (credentials, `.claude.json`, session history) is left
   * on disk untouched — see the service layer for why.
   */
  delete(id: string): ClaudeProfileRecord | null {
    const db = getConnection();
    const remove = db.transaction(() => {
      const existing = readById(id);
      if (!existing) {
        return null;
      }

      db.prepare('DELETE FROM claude_profiles WHERE id = ?').run(id);

      if (existing.is_default) {
        const next = db
          .prepare('SELECT id FROM claude_profiles ORDER BY created_at ASC, id ASC LIMIT 1')
          .get() as { id: string } | undefined;
        if (next) {
          db.prepare('UPDATE claude_profiles SET is_default = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
            .run(next.id);
        }
      }

      return existing;
    });

    const row = remove();
    return row ? toRecord(row) : null;
  },
};
