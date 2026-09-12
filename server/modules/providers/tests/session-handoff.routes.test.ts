import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import { claudeProfilesDb, closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import providerRouter from '@/modules/providers/provider.routes.js';
import { AppError } from '@/shared/utils.js';

async function withProviderServer(run: (baseUrl: string, workspacePath: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'session-handoff-routes-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await writeFile(process.env.DATABASE_PATH, '');
  await initializeDatabase();

  const app = express().use(express.json()).use('/api/providers', providerRouter);
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ success: false, error: { code: error.code, message: error.message } });
      return;
    }
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR' } });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`, path.join(tempDirectory, 'workspace'));
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

const postHandoff = (baseUrl: string, sessionId: string, body: unknown) =>
  fetch(`${baseUrl}/api/providers/sessions/${sessionId}/handoff`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

function seed(workspacePath: string): void {
  for (const [id, displayName] of [['profile-work', 'Work'], ['profile-personal', 'Personal']]) {
    claudeProfilesDb.create({ id, displayName, configDirectory: `/unused/${id}`, isDefault: id === 'profile-work' });
  }
  sessionsDb.createAppSession('source-session', 'claude', workspacePath, 'Fix login flow', 'profile-work');
  sessionsDb.assignProviderSessionId('source-session', 'native-source');
}

test('handoff routes create a new run and expose its lineage from both ends', async () => {
  await withProviderServer(async (baseUrl, workspacePath) => {
    seed(workspacePath);

    const targetsResponse = await fetch(`${baseUrl}/api/providers/sessions/source-session/handoff/targets`);
    assert.equal(targetsResponse.status, 200);
    const targets = await targetsResponse.json() as { data: { targets: Array<{ claudeProfileId: string | null; unavailableReason: string | null }> } };
    assert.equal(
      targets.data.targets.find((option) => option.claudeProfileId === 'profile-work')?.unavailableReason,
      'same_as_source',
    );

    const response = await postHandoff(baseUrl, 'source-session', { provider: 'claude', claudeProfileId: 'profile-personal' });
    assert.equal(response.status, 201);
    const created = await response.json() as { data: { sessionId: string; claudeProfileId: string } };
    assert.equal(created.data.claudeProfileId, 'profile-personal');
    assert.equal(sessionsDb.getSessionById('source-session')?.claude_profile_id, 'profile-work');

    const lineageResponse = await fetch(`${baseUrl}/api/providers/sessions/${created.data.sessionId}/lineage`);
    const lineage = await lineageResponse.json() as { data: { incoming: { sourceSessionId: string; handoffPackage: string } } };
    assert.equal(lineage.data.incoming.sourceSessionId, 'source-session');
    assert.match(lineage.data.incoming.handoffPackage, /Claude · Personal/);

    const sourceLineage = await (await fetch(`${baseUrl}/api/providers/sessions/source-session/lineage`)).json() as {
      data: { outgoing: Array<{ targetSessionId: string }> };
    };
    assert.deepEqual(sourceLineage.data.outgoing.map((entry) => entry.targetSessionId), [created.data.sessionId]);
  });
});

test('handoff route rejects an implicit or malformed target', async () => {
  await withProviderServer(async (baseUrl, workspacePath) => {
    seed(workspacePath);

    const cases: Array<[unknown, string]> = [
      [{}, 'HANDOFF_TARGET_PROVIDER_REQUIRED'],
      [{ provider: 'claude' }, 'HANDOFF_TARGET_PROFILE_REQUIRED'],
      [{ provider: 'claude', claudeProfileId: 42 }, 'HANDOFF_TARGET_PROFILE_INVALID'],
      [{ provider: 'claude', claudeProfileId: 'profile-personal', note: 'x'.repeat(2001) }, 'INVALID_HANDOFF_NOTE'],
    ];

    for (const [body, code] of cases) {
      const response = await postHandoff(baseUrl, 'source-session', body);
      const payload = await response.json() as { error: { code: string } };
      assert.equal(response.status, 400, code);
      assert.equal(payload.error.code, code);
    }

    const missing = await postHandoff(baseUrl, 'no-such-session', { provider: 'codex' });
    assert.equal(missing.status, 404);
    assert.equal(sessionsDb.getSessionsByProjectPathIncludingArchived(workspacePath).length, 1);
  });
});
