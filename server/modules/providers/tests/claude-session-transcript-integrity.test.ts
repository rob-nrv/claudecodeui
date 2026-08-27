import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { claudeProfilesDb, closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { ClaudeSessionSynchronizer } from '@/modules/providers/list/claude/claude-session-synchronizer.provider.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';

/**
 * Regression coverage for a real Pixel-found bug: a Claude session bound to a
 * multi-account profile (LOT 2) never got its `jsonl_path` populated, because
 * `ClaudeSessionSynchronizer` only ever scanned the legacy `~/.claude/projects`
 * tree — never a profile's own isolated directory (`claude-home.resolver.ts`).
 * `fetchHistory` requires `jsonl_path` to find a transcript at all, so this
 * made a profile-bound session's PERSISTED history come back completely empty
 * on every reload, forever — a still-connected browser tab kept showing the
 * live turn it had just streamed in over the websocket, but anything from
 * before a reload (a first "hello" sent an hour earlier, in the real report)
 * silently disappeared. The data itself was always intact on disk.
 */

function userTurnLine(sessionId: string, cwd: string, text: string, timestamp: string, uuid: string) {
  return JSON.stringify({
    type: 'user',
    sessionId,
    cwd,
    timestamp,
    uuid,
    message: { role: 'user', content: text },
  });
}

function assistantTurnLine(sessionId: string, text: string, timestamp: string, uuid: string) {
  return JSON.stringify({
    type: 'assistant',
    sessionId,
    timestamp,
    uuid,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  });
}

/** Mirrors the real transcript shape: control lines interleave with the actual turns. */
function buildTwoTurnTranscript(sessionId: string, cwd: string): string {
  const lines = [
    JSON.stringify({ type: 'queue-operation', sessionId }),
    userTurnLine(sessionId, cwd, 'hello', '2026-08-27T13:07:42.143Z', 'turn-1-user'),
    JSON.stringify({ type: 'atis-latch', sessionId }),
    assistantTurnLine(sessionId, 'réponse #1', '2026-08-27T13:07:46.094Z', 'turn-1-assistant'),
    JSON.stringify({ type: 'last-prompt', sessionId, lastPrompt: 'hello' }),
    JSON.stringify({ type: 'queue-operation', sessionId }),
    userTurnLine(sessionId, cwd, 'hello #2', '2026-08-27T14:49:38.775Z', 'turn-2-user'),
    assistantTurnLine(sessionId, 'réponse #2', '2026-08-27T14:49:41.463Z', 'turn-2-assistant'),
    JSON.stringify({ type: 'last-prompt', sessionId, lastPrompt: 'hello #2' }),
    JSON.stringify({ type: 'mode', sessionId, mode: 'normal' }),
  ];
  return `${lines.join('\n')}\n`;
}

function buildOneTurnTranscript(sessionId: string, cwd: string): string {
  const lines = [
    userTurnLine(sessionId, cwd, 'hello', '2026-08-27T13:07:42.143Z', 'turn-1-user'),
    assistantTurnLine(sessionId, 'réponse #1', '2026-08-27T13:07:46.094Z', 'turn-1-assistant'),
  ];
  return `${lines.join('\n')}\n`;
}

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'claude-transcript-integrity-db-'));
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

function extractTextTurns(messages: Array<Record<string, unknown>>): Array<{ role: unknown; content: unknown }> {
  return messages
    .filter((message) => message.kind === 'text')
    .map((message) => ({ role: message.role, content: message.content }));
}

test('a profile-bound session\'s full transcript survives restart/resume: both turns reload, in order, no duplicates', async () => {
  await withIsolatedDatabase(async () => {
    const previousHome = process.env.HOME;
    const fakeHome = await mkdtemp(path.join(tmpdir(), 'claude-legacy-home-'));
    process.env.HOME = fakeHome;

    const projectPath = '/home/robin/IslandOS';
    const encodedProjectDir = projectPath.replace(/\//g, '-');
    const providerSessionId = 'bf4a90d6-7e58-4581-8971-f588c3a085ce';
    const profileConfigDirectory = await mkdtemp(path.join(tmpdir(), 'claude-profile-work-'));

    try {
      const profile = claudeProfilesDb.create({
        id: 'profile-work',
        displayName: 'Work',
        configDirectory: profileConfigDirectory,
        isDefault: true,
      });

      const appSessionId = sessionsDb.createAppSession(
        'app-session-work',
        'claude',
        projectPath,
        'hello',
        profile.id,
      );
      sessionsDb.assignProviderSessionId(appSessionId, providerSessionId);

      // Turn 1 only, exactly as it existed right after the first "hello".
      const projectSessionsDir = path.join(profileConfigDirectory, 'projects', encodedProjectDir);
      await mkdir(projectSessionsDir, { recursive: true });
      const jsonlPath = path.join(projectSessionsDir, `${providerSessionId}.jsonl`);
      await writeFile(jsonlPath, buildOneTurnTranscript(providerSessionId, projectPath), 'utf8');

      // The shared scan cursor already moved past turn 1's file-creation time —
      // simulating exactly what a real install looks like after days of
      // legacy-only scans. A synchronizer that (incorrectly) applied this same
      // bound to the profile directory would find nothing and jsonl_path would
      // stay NULL forever, which is the bug this test catches.
      const staleCursor = new Date(Date.now() + 60_000);

      // "Restart": a fresh synchronizer instance, exactly like server boot.
      const firstSync = new ClaudeSessionSynchronizer();
      await firstSync.synchronize(staleCursor);

      const boundAfterFirstSync = sessionsDb.getSessionById(appSessionId);
      assert.ok(boundAfterFirstSync?.jsonl_path, 'jsonl_path must be populated for a profile-bound session');
      assert.equal(boundAfterFirstSync?.claude_profile_id, 'profile-work', 'sync must never touch the profile binding');

      const sessionsProvider = new ClaudeSessionsProvider();
      const afterTurn1 = await sessionsProvider.fetchHistory(appSessionId, {
        providerSessionId,
        projectPath,
        limit: null,
        offset: 0,
      });
      const turnsAfterTurn1 = extractTextTurns(afterTurn1.messages as Array<Record<string, unknown>>);
      assert.deepEqual(turnsAfterTurn1, [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'réponse #1' },
      ]);

      // Now "hello #2" is appended (turn 2), exactly as it would be after the
      // real Claude process resumes and prints a second turn into the SAME file.
      await writeFile(jsonlPath, buildTwoTurnTranscript(providerSessionId, projectPath), 'utf8');

      // "Reload": another sync pass (e.g. the next GET /api/projects call).
      const secondSync = new ClaudeSessionSynchronizer();
      await secondSync.synchronize(staleCursor);

      const afterTurn2 = await sessionsProvider.fetchHistory(appSessionId, {
        providerSessionId,
        projectPath,
        limit: null,
        offset: 0,
      });
      const turnsAfterTurn2 = extractTextTurns(afterTurn2.messages as Array<Record<string, unknown>>);

      assert.deepEqual(turnsAfterTurn2, [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'réponse #1' },
        { role: 'user', content: 'hello #2' },
        { role: 'assistant', content: 'réponse #2' },
      ], 'turn 1 must still be present alongside turn 2, in order, with no duplicates');

      const boundAfterSecondSync = sessionsDb.getSessionById(appSessionId);
      assert.equal(boundAfterSecondSync?.claude_profile_id, 'profile-work');
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      await rm(fakeHome, { recursive: true, force: true });
      await rm(profileConfigDirectory, { recursive: true, force: true });
    }
  });
});

test('a Personal-profile session is discovered independently of a Work-profile session in the same sync pass', async () => {
  await withIsolatedDatabase(async () => {
    const previousHome = process.env.HOME;
    const fakeHome = await mkdtemp(path.join(tmpdir(), 'claude-legacy-home-'));
    process.env.HOME = fakeHome;

    const projectPath = '/home/robin/IslandOS';
    const encodedProjectDir = projectPath.replace(/\//g, '-');
    const workProviderSessionId = 'work-provider-session';
    const personalProviderSessionId = 'personal-provider-session';
    const workDir = await mkdtemp(path.join(tmpdir(), 'claude-profile-work-'));
    const personalDir = await mkdtemp(path.join(tmpdir(), 'claude-profile-personal-'));

    try {
      const workProfile = claudeProfilesDb.create({
        id: 'profile-work',
        displayName: 'Work',
        configDirectory: workDir,
        isDefault: true,
      });
      const personalProfile = claudeProfilesDb.create({
        id: 'profile-personal',
        displayName: 'Personal',
        configDirectory: personalDir,
        isDefault: false,
      });

      const workSessionId = sessionsDb.createAppSession('app-session-work', 'claude', projectPath, 'hello', workProfile.id);
      sessionsDb.assignProviderSessionId(workSessionId, workProviderSessionId);
      const personalSessionId = sessionsDb.createAppSession('app-session-personal', 'claude', projectPath, 'hello', personalProfile.id);
      sessionsDb.assignProviderSessionId(personalSessionId, personalProviderSessionId);

      const workProjectDir = path.join(workDir, 'projects', encodedProjectDir);
      await mkdir(workProjectDir, { recursive: true });
      await writeFile(
        path.join(workProjectDir, `${workProviderSessionId}.jsonl`),
        buildOneTurnTranscript(workProviderSessionId, projectPath),
        'utf8',
      );

      const personalProjectDir = path.join(personalDir, 'projects', encodedProjectDir);
      await mkdir(personalProjectDir, { recursive: true });
      await writeFile(
        path.join(personalProjectDir, `${personalProviderSessionId}.jsonl`),
        buildOneTurnTranscript(personalProviderSessionId, projectPath),
        'utf8',
      );

      await new ClaudeSessionSynchronizer().synchronize(new Date(Date.now() + 60_000));

      const workRow = sessionsDb.getSessionById(workSessionId);
      const personalRow = sessionsDb.getSessionById(personalSessionId);

      assert.ok(workRow?.jsonl_path?.startsWith(workDir));
      assert.ok(personalRow?.jsonl_path?.startsWith(personalDir));
      assert.notEqual(workRow?.jsonl_path, personalRow?.jsonl_path);
      assert.equal(workRow?.claude_profile_id, 'profile-work');
      assert.equal(personalRow?.claude_profile_id, 'profile-personal');
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      await rm(fakeHome, { recursive: true, force: true });
      await rm(workDir, { recursive: true, force: true });
      await rm(personalDir, { recursive: true, force: true });
    }
  });
});

test('a legacy (no-profile) session\'s discovery is unaffected: still bound only by the shared since cursor', async () => {
  await withIsolatedDatabase(async () => {
    const previousHome = process.env.HOME;
    const fakeHome = await mkdtemp(path.join(tmpdir(), 'claude-legacy-home-'));
    const projectPath = '/home/robin/legacy-project';
    const encodedProjectDir = projectPath.replace(/\//g, '-');
    const legacySessionId = 'legacy-provider-session';

    try {
      process.env.HOME = fakeHome;

      const projectSessionsDir = path.join(fakeHome, '.claude', 'projects', encodedProjectDir);
      await mkdir(projectSessionsDir, { recursive: true });
      await writeFile(
        path.join(projectSessionsDir, `${legacySessionId}.jsonl`),
        buildOneTurnTranscript(legacySessionId, projectPath),
        'utf8',
      );

      // A cursor set in the FUTURE relative to the file: the legacy home stays
      // bound by this cursor (unchanged behavior), so the file must be skipped.
      const futureCursor = new Date(Date.now() + 60_000);
      const processed = await new ClaudeSessionSynchronizer().synchronize(futureCursor);

      assert.equal(processed, 0, 'legacy scans must remain bounded by the since cursor exactly as before');
      const session = sessionsDb.getSessionByProviderSessionId(legacySessionId);
      assert.equal(session, null);
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
