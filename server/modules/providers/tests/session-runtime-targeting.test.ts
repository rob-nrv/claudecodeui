import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import {
  claudeProfilesDb,
  closeConnection,
  getConnection,
  initializeDatabase,
  sessionHandoffsDb,
  sessionsDb,
} from '@/modules/database/index.js';
import providerRoutes from '@/modules/providers/provider.routes.js';
import { createSessionHandoffService } from '@/modules/providers/services/session-handoff.service.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import { runtimeNodesService } from '@/modules/runtime-nodes/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import { AppError } from '@/shared/utils.js';

const SOURCE_ID = 'source-session';

class FakeConnection {
  readyState = 1; // WS_OPEN_STATE
  send(): void {}
}

type Fixture = { workspace: string; workId: string; personalId: string };

async function withTargetingFixture(runTest: (fixture: Fixture) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'session-runtime-targeting-'));
  const workspace = path.join(directory, 'workspace');
  await mkdir(workspace, { recursive: true });

  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
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

  try {
    await runTest({ workspace, workId: work.id, personalId: personal.id });
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

const offlineHandoffService = () =>
  createSessionHandoffService({
    readGitState: async () => null,
    readSourceHistory: async () => [],
    isSessionRunning: () => false,
    hasProviderRuntime: () => true,
  });

const addRemoteNode = (): void => {
  getConnection().prepare("INSERT INTO runtime_nodes (node_id, label, is_local) VALUES ('nas-node', 'NAS', 0)").run();
};

test('a new session is bound to the local runtime node, and the binding is returned, persisted and exposed', { concurrency: false }, async () => {
  await withTargetingFixture(async ({ workspace, workId }) => {
    const localNodeId = runtimeNodesService.getLocalNodeId();

    const implied = sessionsService.createAppSession('claude', workspace, 'Fix the login flow', workId);
    assert.equal(implied.runtimeNodeId, localNodeId);
    assert.equal(implied.claudeProfileId, workId);
    assert.equal(sessionsDb.getSessionById(implied.sessionId)?.runtime_node_id, localNodeId);
    assert.equal(sessionsService.getSessionDetailsById(implied.sessionId).runtimeNodeId, localNodeId);

    const explicit = sessionsService.createAppSession('codex', workspace, 'Review the diff', undefined, localNodeId);
    assert.equal(explicit.runtimeNodeId, localNodeId);
    assert.equal(explicit.claudeProfileId, null);
  });
});

test('an unknown, non-executable or unchosen runtime target is refused and creates no session', { concurrency: false }, async () => {
  await withTargetingFixture(async ({ workspace, workId }) => {
    const countSessions = () => sessionsDb.getSessionsByProjectPathIncludingArchived(workspace).length;
    const before = countSessions();

    assert.throws(
      () => sessionsService.createAppSession('claude', workspace, 'x', workId, 'ghost-node'),
      { code: 'RUNTIME_NODE_NOT_FOUND' },
    );

    addRemoteNode();
    assert.throws(
      () => sessionsService.createAppSession('claude', workspace, 'x', workId, 'nas-node'),
      { code: 'RUNTIME_NODE_NOT_EXECUTABLE' },
    );
    // With two nodes known, the server never picks one on the user's behalf.
    assert.throws(() => sessionsService.createAppSession('claude', workspace, 'x', workId), { code: 'RUNTIME_NODE_REQUIRED' });

    assert.equal(countSessions(), before);
  });
});

test('a session created before runtime tracking keeps a null binding and is reported truthfully while running', { concurrency: false }, async () => {
  await withTargetingFixture(async ({ workspace, workId }) => {
    // The repository-level insert is exactly how pre-FT-M07 rows were created.
    sessionsDb.createAppSession('legacy-session', 'claude', workspace, 'Legacy', workId);
    const bound = sessionsService.createAppSession('claude', workspace, 'Bound run', workId);
    const localNodeId = runtimeNodesService.getLocalNodeId();

    assert.equal(sessionsDb.getSessionById('legacy-session')?.runtime_node_id, null, 'registering a node never backfills history');
    assert.equal(sessionsService.getSessionDetailsById('legacy-session').runtimeNodeId, null);

    for (const sessionId of ['legacy-session', bound.sessionId]) {
      chatRunRegistry.startRun({
        appSessionId: sessionId,
        provider: 'claude',
        providerSessionId: null,
        connection: new FakeConnection() as never,
        userId: null,
      });
    }
    const running = new Map(sessionsService.listRunningSessions().map((run) => [run.sessionId, run]));
    assert.equal(running.get('legacy-session')?.runtimeNodeId, null);
    assert.equal(running.get(bound.sessionId)?.runtimeNodeId, localNodeId);
    assert.equal(running.get(bound.sessionId)?.claudeProfileId, workId);
  });
});

test('a handoff binds the new run to a runtime node, snapshots the source runtime and never rewrites the source', { concurrency: false }, async () => {
  await withTargetingFixture(async ({ workspace, workId, personalId }) => {
    // A source run created before runtime tracking.
    sessionsDb.createAppSession(SOURCE_ID, 'claude', workspace, 'Fix login flow', workId);
    sessionsDb.assignProviderSessionId(SOURCE_ID, 'native-source');
    const sourceBefore = sessionsDb.getSessionById(SOURCE_ID);
    const localNodeId = runtimeNodesService.getLocalNodeId();
    const service = offlineHandoffService();

    const result = await service.createHandoff(SOURCE_ID, { provider: 'claude', claudeProfileId: personalId });

    assert.equal(result.runtimeNodeId, localNodeId);
    const target = sessionsDb.getSessionById(result.sessionId);
    assert.equal(target?.runtime_node_id, localNodeId);
    assert.equal(target?.claude_profile_id, personalId);
    assert.equal(target?.provider_session_id, null, 'the new run starts its own native session');
    assert.deepEqual(sessionsDb.getSessionById(SOURCE_ID), sourceBefore);

    const incoming = service.getLineage(result.sessionId).incoming;
    assert.equal(incoming?.sourceRuntimeNodeId, null, 'an unrecorded source runtime stays unrecorded');
    assert.equal(incoming?.targetRuntimeNodeId, localNodeId);
    assert.equal(service.getLineage(SOURCE_ID).outgoing[0]?.targetRuntimeNodeId, localNodeId);

    // A second hop from a runtime-bound source snapshots that binding.
    sessionsDb.assignProviderSessionId(result.sessionId, 'native-target');
    const second = await service.createHandoff(result.sessionId, { provider: 'codex', runtimeNodeId: localNodeId });
    assert.equal(service.getLineage(second.sessionId).incoming?.sourceRuntimeNodeId, localNodeId);
  });
});

test('a handoff to an unknown or non-executable runtime node is refused before anything is created', { concurrency: false }, async () => {
  await withTargetingFixture(async ({ workspace, workId, personalId }) => {
    sessionsDb.createAppSession(SOURCE_ID, 'claude', workspace, 'Fix login flow', workId);
    sessionsDb.assignProviderSessionId(SOURCE_ID, 'native-source');
    const sessionsBefore = sessionsDb.getSessionsByProjectPathIncludingArchived(workspace).length;
    const service = offlineHandoffService();

    await assert.rejects(
      service.createHandoff(SOURCE_ID, { provider: 'claude', claudeProfileId: personalId, runtimeNodeId: 'ghost-node' }),
      { code: 'RUNTIME_NODE_NOT_FOUND' },
    );
    addRemoteNode();
    await assert.rejects(
      service.createHandoff(SOURCE_ID, { provider: 'claude', claudeProfileId: personalId, runtimeNodeId: 'nas-node' }),
      { code: 'RUNTIME_NODE_NOT_EXECUTABLE' },
    );

    assert.equal(sessionHandoffsDb.listBySourceSessionId(SOURCE_ID).length, 0);
    assert.equal(sessionsDb.getSessionsByProjectPathIncludingArchived(workspace).length, sessionsBefore);
  });
});

test('POST /sessions accepts an explicit runtime node id and rejects a malformed one', { concurrency: false }, async () => {
  await withTargetingFixture(async ({ workspace, workId }) => {
    const app = express();
    app.use(express.json());
    app.use('/api/providers', providerRoutes);
    app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      const statusCode = error instanceof AppError ? error.statusCode : 500;
      const code = error instanceof AppError ? error.code : 'INTERNAL_ERROR';
      res.status(statusCode).json({ success: false, error: { code } });
    });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');

    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/providers/sessions`;
      const post = (body: Record<string, unknown>) => fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'claude', projectPath: workspace, initialMessage: 'hello', claudeProfileId: workId, ...body }),
      });

      const created = await post({ runtimeNodeId: runtimeNodesService.getLocalNodeId() });
      assert.equal(created.status, 201);
      const createdBody = await created.json() as { data: { runtimeNodeId: string } };
      assert.equal(createdBody.data.runtimeNodeId, runtimeNodesService.getLocalNodeId());

      const malformed = await post({ runtimeNodeId: 42 });
      assert.equal(malformed.status, 400);
      assert.equal((await malformed.json() as { error: { code: string } }).error.code, 'RUNTIME_NODE_ID_INVALID');

      const unknown = await post({ runtimeNodeId: 'ghost-node' });
      assert.equal(unknown.status, 404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
