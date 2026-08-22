import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { ClaudeSessionSynchronizer } from '@/modules/providers/list/claude/claude-session-synchronizer.provider.js';

const SESSION_ID = '3957fd40-854a-4afd-9a87-717dea57afeb';
const PROJECT_PATH = '/home/robin/projects/claude-mobile-test';

/**
 * Real transcript shape emitted by Claude Code 2.1.239: several session-scoped
 * control lines (`mode`, `permission-mode`, `atis-latch`, `file-history-snapshot`)
 * precede the first line that actually carries `sessionId` + `cwd` together.
 */
function buildSessionJsonl(sessionId: string, cwd: string): string {
  const lines = [
    { type: 'mode', mode: 'normal', sessionId },
    { type: 'permission-mode', permissionMode: 'auto', sessionId },
    { type: 'atis-latch', atis: '', sessionId },
    {
      type: 'file-history-snapshot',
      messageId: 'snap-1',
      snapshot: { messageId: 'snap-1', trackedFileBackups: {}, timestamp: '2026-08-22T07:22:10.876Z' },
      isSnapshotUpdate: false,
    },
    {
      parentUuid: null,
      isSidechain: false,
      promptId: 'prompt-1',
      type: 'user',
      message: { role: 'user', content: 'Dis-moi seulement "Projet mobile test prêt".' },
      uuid: 'msg-1',
      timestamp: '2026-08-22T07:22:10.874Z',
      permissionMode: 'auto',
      origin: { kind: 'human' },
      promptSource: 'typed',
      userType: 'external',
      entrypoint: 'cli',
      cwd,
      sessionId,
      version: '2.1.239',
      gitBranch: 'main',
    },
  ];
  return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
}

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'claude-sessions-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('claude session sync: discovers an existing project session created after the last scan', async () => {
  await withIsolatedDatabase(async () => {
    const previousHome = process.env.HOME;
    const fakeHome = await mkdtemp(path.join(tmpdir(), 'claude-home-'));

    try {
      process.env.HOME = fakeHome;

      const encodedProjectDir = PROJECT_PATH.replace(/\//g, '-');
      const projectSessionsDir = path.join(fakeHome, '.claude', 'projects', encodedProjectDir);
      await mkdir(projectSessionsDir, { recursive: true });
      await writeFile(
        path.join(projectSessionsDir, `${SESSION_ID}.jsonl`),
        buildSessionJsonl(SESSION_ID, PROJECT_PATH),
        'utf8',
      );

      // Simulates the real-world case this reproduces: a previous app run
      // already advanced scan_state, and this session file was written after
      // that (e.g. on a filesystem without inode birth-time support, where a
      // naive birthtime comparison would make the file look infinitely old
      // and drop it from every scan from then on).
      const lastScanAt = new Date(Date.now() - 60_000);

      const synchronizer = new ClaudeSessionSynchronizer();
      const processed = await synchronizer.synchronize(lastScanAt);

      assert.equal(processed, 1);

      const session = sessionsDb.getSessionByProviderSessionId(SESSION_ID)
        ?? sessionsDb.getSessionById(SESSION_ID);
      assert.ok(session, 'expected the session file to be indexed into the DB');
      assert.equal(session?.project_path, PROJECT_PATH);
      assert.equal(session?.provider, 'claude');
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      await rm(fakeHome, { recursive: true, force: true });
    }
  });
});
