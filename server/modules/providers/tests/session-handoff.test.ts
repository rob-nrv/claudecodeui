import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  claudeProfilesDb,
  closeConnection,
  getConnection,
  initializeDatabase,
  queuedMessagesDb,
  sessionHandoffsDb,
  sessionsDb,
} from '@/modules/database/index.js';
import { createSessionHandoffService } from '@/modules/providers/services/session-handoff.service.js';
import { runtimeNodesService } from '@/modules/runtime-nodes/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import type { NormalizedMessage } from '@/shared/types.js';

const execFileAsync = promisify(execFile);

const SOURCE_ID = 'source-session';

type Context = { directory: string; workspace: string; workId: string; personalId: string };

async function withHandoffFixture(runTest: (context: Context) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'session-handoff-'));
  const workspace = path.join(directory, 'workspace');
  await mkdir(workspace, { recursive: true });

  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  // An existing (empty) file keeps connection.ts from seeding it with the
  // repo's legacy database/auth.db.
  await writeFile(process.env.DATABASE_PATH, '');
  await initializeDatabase();

  const work = claudeProfilesDb.create({
    id: 'profile-work',
    displayName: 'Work',
    configDirectory: path.join(directory, 'profiles', 'work'),
    isDefault: true,
  });
  const personal = claudeProfilesDb.create({
    id: 'profile-personal',
    displayName: 'Personal',
    configDirectory: path.join(directory, 'profiles', 'personal'),
    isDefault: false,
  });
  for (const id of [work.id, personal.id]) {
    claudeProfilesDb.updateConnectionState(id, { connectionState: 'connected', verifiedIdentity: null });
  }

  sessionsDb.createAppSession(SOURCE_ID, 'claude', workspace, 'Fix login flow', work.id);
  sessionsDb.assignProviderSessionId(SOURCE_ID, 'native-source');
  sessionsDb.setSessionModel(SOURCE_ID, 'claude-opus-5');
  sessionsDb.setSessionEffort(SOURCE_ID, 'high');

  try {
    await runTest({ directory, workspace, workId: work.id, personalId: personal.id });
  } finally {
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

function textMessage(role: 'user' | 'assistant', content: string, index: number): NormalizedMessage {
  return {
    id: `m-${index}`,
    sessionId: SOURCE_ID,
    timestamp: new Date(0).toISOString(),
    provider: 'claude',
    kind: 'text',
    role,
    content,
  };
}

const offlineService = (overrides: Parameters<typeof createSessionHandoffService>[0] = {}) =>
  createSessionHandoffService({
    readGitState: async () => null,
    readSourceHistory: async () => [],
    isSessionRunning: () => false,
    hasProviderRuntime: () => true,
    ...overrides,
  });

async function assertRefused(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: Error & { code?: string }) => {
    assert.equal(error.code, code);
    return true;
  });
}

function sessionsInWorkspace(workspace: string): string[] {
  return sessionsDb.getSessionsByProjectPathIncludingArchived(workspace).map((row) => row.session_id).sort();
}

test('a handoff creates a new run bound to the chosen account and leaves the source run untouched', { concurrency: false }, async () => {
  await withHandoffFixture(async ({ workspace, workId, personalId }) => {
    const sourceBefore = sessionsDb.getSessionById(SOURCE_ID);
    const service = offlineService();

    const result = await service.createHandoff(SOURCE_ID, { provider: 'claude', claudeProfileId: personalId });

    // A. Source immutability: every column of the source row is unchanged.
    assert.deepEqual(sessionsDb.getSessionById(SOURCE_ID), sourceBefore);
    assert.equal(sourceBefore?.claude_profile_id, workId);

    // B. New run with its own identity and no borrowed native session.
    assert.notEqual(result.sessionId, SOURCE_ID);
    const target = sessionsDb.getSessionById(result.sessionId);
    assert.equal(target?.provider, 'claude');
    assert.equal(target?.claude_profile_id, personalId);
    assert.equal(target?.provider_session_id, null);
    assert.equal(target?.jsonl_path, null);
    assert.equal(target?.project_path, workspace);
    assert.equal(target?.custom_name, '↪ Fix login flow');
    assert.equal(result.claudeProfileId, personalId);

    // C/E. Lineage and provenance, from both ends.
    const targetLineage = service.getLineage(result.sessionId);
    assert.equal(targetLineage.taskRootSessionId, SOURCE_ID);
    assert.equal(targetLineage.incoming?.sourceSessionId, SOURCE_ID);
    assert.equal(targetLineage.incoming?.sourceClaudeProfileId, workId);
    assert.equal(targetLineage.incoming?.sourceProvider, 'claude');
    assert.equal(targetLineage.incoming?.sourceModel, 'claude-opus-5');
    assert.equal(targetLineage.incoming?.sourceEffort, 'high');
    assert.equal(targetLineage.incoming?.targetClaudeProfileId, personalId);
    assert.equal(targetLineage.incoming?.targetStarted, false);
    assert.equal(sessionHandoffsDb.getByTargetSessionId(result.sessionId)?.source_provider_session_id, 'native-source');

    const sourceLineage = service.getLineage(SOURCE_ID);
    assert.equal(sourceLineage.incoming, null);
    assert.deepEqual(sourceLineage.outgoing.map((entry) => entry.targetSessionId), [result.sessionId]);
    assert.equal(sourceLineage.outgoing[0].targetClaudeProfileId, personalId);
  });
});

test('the target run reports itself started only once it has its own native session', { concurrency: false }, async () => {
  await withHandoffFixture(async ({ personalId }) => {
    const service = offlineService();
    const result = await service.createHandoff(SOURCE_ID, { provider: 'claude', claudeProfileId: personalId });

    sessionsDb.assignProviderSessionId(result.sessionId, 'native-target');

    assert.equal(service.getLineage(result.sessionId).incoming?.targetStarted, true);
    assert.equal(sessionsDb.getSessionById(SOURCE_ID)?.provider_session_id, 'native-source');
  });
});

test('handing off a handoff target keeps the original Task root', { concurrency: false }, async () => {
  await withHandoffFixture(async ({ personalId }) => {
    const service = offlineService();
    const first = await service.createHandoff(SOURCE_ID, { provider: 'claude', claudeProfileId: personalId });
    sessionsDb.assignProviderSessionId(first.sessionId, 'native-first');

    const second = await service.createHandoff(first.sessionId, { provider: 'codex' });

    assert.equal(second.taskRootSessionId, SOURCE_ID);
    assert.equal(service.getLineage(second.sessionId).incoming?.sourceSessionId, first.sessionId);
    assert.equal(sessionsDb.getSessionById(second.sessionId)?.claude_profile_id, null);
    assert.equal(sessionsDb.getSessionById(first.sessionId)?.claude_profile_id, personalId);
  });
});

test('the target provider and account are never chosen implicitly', { concurrency: false }, async () => {
  await withHandoffFixture(async ({ workspace, workId, personalId }) => {
    const service = offlineService();

    await assertRefused(service.createHandoff(SOURCE_ID, { provider: 'claude' }), 'HANDOFF_TARGET_PROFILE_REQUIRED');
    await assertRefused(
      service.createHandoff(SOURCE_ID, { provider: 'claude', claudeProfileId: null }),
      'HANDOFF_TARGET_PROFILE_REQUIRED',
    );
    await assertRefused(
      service.createHandoff(SOURCE_ID, { provider: 'claude', claudeProfileId: 'no-such-profile' }),
      'CLAUDE_PROFILE_NOT_FOUND',
    );
    await assertRefused(
      service.createHandoff(SOURCE_ID, { provider: 'claude', claudeProfileId: workId }),
      'HANDOFF_TARGET_UNCHANGED',
    );
    await assertRefused(
      service.createHandoff(SOURCE_ID, { provider: 'codex', claudeProfileId: personalId }),
      'HANDOFF_TARGET_PROFILE_INVALID',
    );
    await assertRefused(
      offlineService({ hasProviderRuntime: (provider) => provider !== 'codex' })
        .createHandoff(SOURCE_ID, { provider: 'codex' }),
      'HANDOFF_TARGET_PROVIDER_UNAVAILABLE',
    );

    claudeProfilesDb.updateConnectionState(personalId, { connectionState: 'not_authenticated', verifiedIdentity: null });
    await assertRefused(
      service.createHandoff(SOURCE_ID, { provider: 'claude', claudeProfileId: personalId }),
      'HANDOFF_TARGET_PROFILE_UNAVAILABLE',
    );

    // G. No refusal left a phantom target or lineage row behind.
    assert.deepEqual(sessionsInWorkspace(workspace), [SOURCE_ID]);
    assert.equal(sessionHandoffsDb.listBySourceSessionId(SOURCE_ID).length, 0);
  });
});

test('the legacy default Claude home is an explicit target only when no accounts exist', { concurrency: false }, async () => {
  await withHandoffFixture(async ({ workspace, workId, personalId }) => {
    sessionsDb.createAppSession('codex-source', 'codex', workspace, 'Codex task');
    sessionsDb.assignProviderSessionId('codex-source', 'native-codex');
    for (const id of [workId, personalId]) {
      claudeProfilesDb.delete(id);
    }

    const result = await offlineService().createHandoff('codex-source', { provider: 'claude', claudeProfileId: null });

    assert.equal(sessionsDb.getSessionById(result.sessionId)?.provider, 'claude');
    assert.equal(sessionsDb.getSessionById(result.sessionId)?.claude_profile_id, null);
  });
});

test('a running, never-started or failing source produces no target', { concurrency: false }, async () => {
  await withHandoffFixture(async ({ workspace, personalId }) => {
    const sourceBefore = sessionsDb.getSessionById(SOURCE_ID);

    await assertRefused(
      offlineService({ isSessionRunning: () => true }).createHandoff(SOURCE_ID, { provider: 'claude', claudeProfileId: personalId }),
      'HANDOFF_SOURCE_RUNNING',
    );

    // The run starts while the package is being built: the recheck refuses.
    let runStarted = false;
    await assertRefused(
      offlineService({
        isSessionRunning: () => runStarted,
        readGitState: async () => {
          runStarted = true;
          return null;
        },
      }).createHandoff(SOURCE_ID, { provider: 'claude', claudeProfileId: personalId }),
      'HANDOFF_SOURCE_RUNNING',
    );

    await assert.rejects(
      offlineService({ readSourceHistory: async () => { throw new Error('disk gone'); } })
        .createHandoff(SOURCE_ID, { provider: 'claude', claudeProfileId: personalId }),
      /disk gone/,
    );

    sessionsDb.createAppSession('never-ran', 'claude', workspace, 'Never ran', personalId);
    await assertRefused(
      offlineService().createHandoff('never-ran', { provider: 'codex' }),
      'HANDOFF_SOURCE_NOT_STARTED',
    );

    assert.deepEqual(sessionsInWorkspace(workspace), ['never-ran', SOURCE_ID].sort());
    assert.equal(sessionHandoffsDb.listBySourceSessionId(SOURCE_ID).length, 0);
    assert.deepEqual(sessionsDb.getSessionById(SOURCE_ID), sourceBefore);
  });
});

test('the handoff package carries useful context and provenance but no secrets', { concurrency: false }, async () => {
  await withHandoffFixture(async ({ directory, workspace, personalId }) => {
    const git = (...args: string[]) => execFileAsync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd: workspace });
    await git('init', '-q', '-b', 'main');
    await writeFile(path.join(workspace, 'login.ts'), 'export const a = 1;\n');
    await git('add', '.');
    await git('commit', '-q', '-m', 'init');
    await writeFile(path.join(workspace, 'login.ts'), 'export const a = 2;\n');

    const service = createSessionHandoffService({
      readSourceHistory: async () => [
        textMessage('user', 'Fix the login redirect loop', 1),
        textMessage('assistant', 'Looking into it', 2),
        textMessage('user', 'Use this key sk-ant-api03-SECRETSECRETSECRET and ghp_abcdefghijklmnopqrstuvwxyz0123', 3),
        textMessage('assistant', 'Redirect fixed in login.ts; tests still to run.', 4),
      ],
      isSessionRunning: () => false,
    });

    const result = await service.createHandoff(SOURCE_ID, {
      provider: 'claude',
      claudeProfileId: personalId,
      note: 'Run the auth tests next.',
    });
    const handoffPackage = service.getLineage(result.sessionId).incoming?.handoffPackage ?? '';

    assert.match(handoffPackage, /this is a NEW run/);
    assert.match(handoffPackage, /Task: Fix login flow/);
    assert.match(handoffPackage, /Previous run: Claude · Work \(session source-session/);
    assert.match(handoffPackage, /This run: Claude · Personal/);
    assert.match(handoffPackage, /> Fix the login redirect loop/);
    assert.match(handoffPackage, /> Redirect fixed in login\.ts; tests still to run\./);
    assert.match(handoffPackage, /Branch: main @ [0-9a-f]{7}/);
    assert.match(handoffPackage, /M login\.ts/);
    assert.match(handoffPackage, /Run the auth tests next\./);

    assert.doesNotMatch(handoffPackage, /sk-ant-api03/);
    assert.doesNotMatch(handoffPackage, /ghp_abcdef/);
    assert.match(handoffPackage, /\[redacted\]/);
    assert.equal(handoffPackage.includes(path.join(directory, 'profiles')), false);
    assert.doesNotMatch(handoffPackage, /native-source/);
  });
});

test('handoff lineage survives a server restart', { concurrency: false }, async () => {
  await withHandoffFixture(async ({ personalId }) => {
    const service = offlineService();
    const result = await service.createHandoff(SOURCE_ID, { provider: 'claude', claudeProfileId: personalId });
    const before = service.getLineage(result.sessionId);

    closeConnection();
    await initializeDatabase();

    assert.deepEqual(offlineService().getLineage(result.sessionId), before);
    assert.equal(sessionsDb.getSessionById(result.sessionId)?.claude_profile_id, personalId);
  });
});

test('a handoff never moves the source queued message', { concurrency: false }, async () => {
  await withHandoffFixture(async ({ personalId }) => {
    queuedMessagesDb.save(SOURCE_ID, '{"content":"after this run"}');

    const result = await offlineService().createHandoff(SOURCE_ID, { provider: 'claude', claudeProfileId: personalId });

    assert.equal(queuedMessagesDb.get(SOURCE_ID)?.content, '{"content":"after this run"}');
    assert.equal(queuedMessagesDb.get(result.sessionId), null);
  });
});

test('target options come from the backend with explicit availability', { concurrency: false }, async () => {
  await withHandoffFixture(async ({ workId, personalId }) => {
    claudeProfilesDb.updateConnectionState(personalId, { connectionState: 'expired', verifiedIdentity: null });

    const listing = offlineService().listTargets(SOURCE_ID);
    const byKey = new Map(listing.targets.map((option) => [`${option.provider}:${option.claudeProfileId}`, option]));

    assert.equal(listing.blockedReason, null);
    assert.equal(listing.source.label, 'Claude · Work');
    assert.equal(byKey.get(`claude:${workId}`)?.unavailableReason, 'same_as_source');
    assert.equal(byKey.get(`claude:${personalId}`)?.unavailableReason, 'profile_expired');
    assert.equal(byKey.get('codex:null')?.available, true);
    assert.equal(byKey.has('claude:null'), false);

    assert.equal(offlineService({ isSessionRunning: () => true }).listTargets(SOURCE_ID).blockedReason, 'source_running');
  });
});

test("a source that ran on a remote RuntimeNode never has this machine's Git state attributed to it (FT-M10)", { concurrency: false }, async () => {
  await withHandoffFixture(async ({ personalId }) => {
    const db = getConnection();
    db.prepare("INSERT INTO runtime_nodes (node_id, label, is_local) VALUES ('pixel-node', 'Pixel', 0)").run();
    db.prepare("INSERT INTO runtime_node_credentials (node_id, public_key, status, enrolled_at) VALUES ('pixel-node', 'key', 'active', 1)").run();
    db.prepare("UPDATE sessions SET runtime_node_id = 'pixel-node' WHERE session_id = ?").run(SOURCE_ID);

    const gitReads: string[] = [];
    const service = offlineService({
      readGitState: async (projectPath) => {
        gitReads.push(projectPath);
        return { branch: 'main', head: 'abc1234', changedFileCount: 1, changedFiles: ['M local-only.ts'], diffSummary: null };
      },
    });
    const localNodeId = runtimeNodesService.getLocalNodeId();
    const result = await service.createHandoff(SOURCE_ID, { provider: 'claude', claudeProfileId: personalId, runtimeNodeId: localNodeId });
    const handoffPackage = service.getLineage(result.sessionId).incoming?.handoffPackage ?? '';

    assert.deepEqual(gitReads, [], "git is not run in this machine's folder for a run that executed on Pixel");
    assert.doesNotMatch(handoffPackage, /local-only\.ts/);
    assert.match(handoffPackage, /Git state at handoff: unavailable/);
  });
});
