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

async function withProviderServer(
  run: (baseUrl: string, workspacePath: string) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'provider-routes-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await writeFile(process.env.DATABASE_PATH, '');
  await initializeDatabase();

  const app = express().use(express.json()).use('/api/providers', providerRouter);
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof AppError) {
      res.status(error.statusCode).json({
        success: false,
        error: { code: error.code, message: error.message },
      });
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

test('session creation route names a CloudCLI session from the initial message', async () => {
  await withProviderServer(async (baseUrl, workspacePath) => {
    const response = await fetch(`${baseUrl}/api/providers/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'codex',
        projectPath: workspacePath,
        initialMessage: 'abcd  efg\nhij klm nop',
      }),
    });
    const payload = await response.json() as {
      data: { sessionId: string; sessionName: string };
    };

    assert.equal(response.status, 201);
    assert.equal(payload.data.sessionName, 'abcd efg hij klm');
    assert.equal(
      sessionsDb.getSessionById(payload.data.sessionId)?.custom_name,
      'abcd efg hij klm',
    );
  });
});

test('session creation route binds a Claude session to a claudeProfileId', async () => {
  await withProviderServer(async (baseUrl, workspacePath) => {
    claudeProfilesDb.create({
      id: 'route-profile-work',
      displayName: 'Work',
      configDirectory: '/tmp/route-profile-work',
      isDefault: true,
    });

    const response = await fetch(`${baseUrl}/api/providers/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'claude',
        projectPath: workspacePath,
        initialMessage: 'hello',
        claudeProfileId: 'route-profile-work',
      }),
    });
    const payload = await response.json() as { data: { sessionId: string; claudeProfileId: string | null } };

    assert.equal(response.status, 201);
    assert.equal(payload.data.claudeProfileId, 'route-profile-work');
    assert.equal(sessionsDb.getSessionById(payload.data.sessionId)?.claude_profile_id, 'route-profile-work');
  });
});

test('session creation route rejects an unknown claudeProfileId', async () => {
  await withProviderServer(async (baseUrl, workspacePath) => {
    const response = await fetch(`${baseUrl}/api/providers/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'claude',
        projectPath: workspacePath,
        initialMessage: 'hello',
        claudeProfileId: 'no-such-profile',
      }),
    });
    const payload = await response.json() as { error: { code: string } };

    assert.equal(response.status, 404);
    assert.equal(payload.error.code, 'CLAUDE_PROFILE_NOT_FOUND');
  });
});

test('conversation search streams title matches before transcript results', async () => {
  await withProviderServer(async (baseUrl, workspacePath) => {
    sessionsDb.createAppSession(
      'title-only-session',
      'codex',
      workspacePath,
      'Release planning notes',
    );
    const transcriptPath = path.join(path.dirname(workspacePath), 'codex-search.jsonl');
    await writeFile(transcriptPath, `${JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-08-12T09:00:00.000Z',
      payload: {
        type: 'user_message',
        kind: 'plain',
        message: 'Release planning also appears in this conversation.',
      },
    })}\n`);
    sessionsDb.createSession(
      'transcript-session',
      'codex',
      workspacePath,
      'Unrelated session',
      undefined,
      undefined,
      transcriptPath,
    );

    const response = await fetch(
      `${baseUrl}/api/providers/search/sessions?q=release%20planning&limit=50`,
    );
    const eventStream = await response.text();
    const titleEventIndex = eventStream.indexOf('event: title-results');
    const conversationEventIndex = eventStream.indexOf('event: result');
    const doneEventIndex = eventStream.indexOf('event: done');

    assert.equal(response.status, 200);
    assert.ok(titleEventIndex >= 0);
    assert.ok(conversationEventIndex > titleEventIndex);
    assert.ok(doneEventIndex > titleEventIndex);

    const titleDataLine = eventStream
      .slice(titleEventIndex, conversationEventIndex)
      .split('\n')
      .find((line) => line.startsWith('data: '));
    assert.ok(titleDataLine);

    const titlePayload = JSON.parse(titleDataLine.slice('data: '.length)) as {
      titleResults: Array<{
        sessionId: string;
        sessionTitle: string;
        provider: string;
      }>;
    };
    assert.equal(titlePayload.titleResults.length, 1);
    assert.equal(titlePayload.titleResults[0]?.sessionId, 'title-only-session');
    assert.equal(titlePayload.titleResults[0]?.sessionTitle, 'Release planning notes');
    assert.equal(titlePayload.titleResults[0]?.provider, 'codex');
  });
});

test('reasoning effort is persisted and returned with the active session model', async () => {
  await withProviderServer(async (baseUrl, workspacePath) => {
    sessionsDb.createAppSession('effort-session', 'codex', workspacePath);

    const updateResponse = await fetch(
      `${baseUrl}/api/providers/codex/sessions/effort-session/active-effort`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ effort: 'ultra' }),
      },
    );
    const updatePayload = await updateResponse.json() as {
      data: { effort: string; sessionId: string };
    };

    assert.equal(updateResponse.status, 200);
    assert.equal(updatePayload.data.effort, 'ultra');
    assert.equal(sessionsDb.getSessionById('effort-session')?.effort, 'ultra');

    const readResponse = await fetch(
      `${baseUrl}/api/providers/codex/sessions/effort-session/active-model`,
    );
    const readPayload = await readResponse.json() as {
      data: { effort: string | null; sessionId: string };
    };

    assert.equal(readResponse.status, 200);
    assert.equal(readPayload.data.sessionId, 'effort-session');
    assert.equal(readPayload.data.effort, 'ultra');
  });
});

test('model routes expose immutable defaults and full custom model CRUD', async () => {
  await withProviderServer(async (baseUrl) => {
    const initialResponse = await fetch(`${baseUrl}/api/providers/codex/models`);
    const initialPayload = await initialResponse.json() as {
      data: {
        cache?: unknown;
        models: {
          OPTIONS: Array<{ recordId?: number; value: string; isCustom: boolean }>;
        };
      };
    };
    assert.equal(initialResponse.status, 200);
    assert.equal('cache' in initialPayload.data, false);
    const predefined = initialPayload.data.models.OPTIONS[0];
    assert.equal(predefined.isCustom, false);
    assert.equal(predefined.recordId, undefined);

    const createResponse = await fetch(`${baseUrl}/api/providers/codex/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'Gateway GPT', id: 'gateway/gpt' }),
    });
    const createPayload = await createResponse.json() as {
      data: { model: { recordId: number; value: string; label: string; isCustom: boolean } };
    };
    assert.equal(createResponse.status, 201);
    assert.equal(createPayload.data.model.isCustom, true);
    const customRecordId = createPayload.data.model.recordId;

    const updateResponse = await fetch(
      `${baseUrl}/api/providers/codex/models/${customRecordId}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'Gateway GPT Updated', id: 'gateway/gpt-v2' }),
      },
    );
    const updatePayload = await updateResponse.json() as {
      data: { model: { value: string; label: string } };
    };
    assert.equal(updateResponse.status, 200);
    assert.equal(updatePayload.data.model.value, 'gateway/gpt-v2');
    assert.equal(updatePayload.data.model.label, 'Gateway GPT Updated');

    const immutableResponse = await fetch(
      `${baseUrl}/api/providers/codex/models/999999`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'Changed', id: 'changed' }),
      },
    );
    const immutablePayload = await immutableResponse.json() as { error: { code: string } };
    assert.equal(immutableResponse.status, 404);
    assert.equal(immutablePayload.error.code, 'MODEL_NOT_FOUND');

    const deleteResponse = await fetch(
      `${baseUrl}/api/providers/codex/models/${customRecordId}`,
      { method: 'DELETE' },
    );
    const deletePayload = await deleteResponse.json() as {
      data: { models: { OPTIONS: Array<{ recordId: number }> } };
    };
    assert.equal(deleteResponse.status, 200);
    assert.equal(
      deletePayload.data.models.OPTIONS.some((option) => option.recordId === customRecordId),
      false,
    );
  });
});

// FT-M03 Queue 2.0 foundations: server-side "send after this run finishes"
// queue. These cover the HTTP surface; CAS atomicity itself is covered at the
// repository level in queued-messages.db.integration.test.ts.
test('queued-message route returns null for a session with nothing queued', async () => {
  await withProviderServer(async (baseUrl, workspacePath) => {
    sessionsDb.createAppSession('session-empty-queue', 'claude', workspacePath);

    const response = await fetch(`${baseUrl}/api/providers/sessions/session-empty-queue/queued-message`);
    const payload = await response.json() as { data: { message: unknown; claimToken: string | null } };

    assert.equal(response.status, 200);
    assert.equal(payload.data.message, null);
    assert.equal(payload.data.claimToken, null);
  });
});

test('queued-message route rejects an unknown session', async () => {
  await withProviderServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/providers/sessions/no-such-session/queued-message`);
    const payload = await response.json() as { error: { code: string } };

    assert.equal(response.status, 404);
    assert.equal(payload.error.code, 'SESSION_NOT_FOUND');
  });
});

test('queued-message route rejects a payload with no content', async () => {
  await withProviderServer(async (baseUrl, workspacePath) => {
    sessionsDb.createAppSession('session-bad-payload', 'claude', workspacePath);

    const response = await fetch(`${baseUrl}/api/providers/sessions/session-bad-payload/queued-message`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ options: { model: 'sonnet' } }),
    });
    const payload = await response.json() as { error: { code: string } };

    assert.equal(response.status, 400);
    assert.equal(payload.error.code, 'QUEUED_MESSAGE_CONTENT_REQUIRED');
  });
});

test('save, claim, and restore round-trip through the HTTP surface', async () => {
  await withProviderServer(async (baseUrl, workspacePath) => {
    sessionsDb.createAppSession('session-queue-flow', 'claude', workspacePath);
    const base = `${baseUrl}/api/providers/sessions/session-queue-flow/queued-message`;

    const saveResponse = await fetch(base, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'ship it', options: { model: 'sonnet' }, attachments: [] }),
    });
    assert.equal(saveResponse.status, 200);

    const getResponse = await fetch(base);
    const getPayload = await getResponse.json() as {
      data: { message: { content: string }; claimToken: string };
    };
    assert.equal(getPayload.data.message.content, 'ship it');
    assert.ok(getPayload.data.claimToken);

    // A stale token (e.g. from a page that hasn't refetched) must not claim.
    const staleClaimResponse = await fetch(`${base}/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ claimToken: '{"content":"stale"}' }),
    });
    const staleClaimPayload = await staleClaimResponse.json() as { data: { claimed: boolean } };
    assert.equal(staleClaimPayload.data.claimed, false);

    const claimResponse = await fetch(`${base}/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ claimToken: getPayload.data.claimToken }),
    });
    const claimPayload = await claimResponse.json() as {
      data: { claimed: boolean; message: { content: string } | null };
    };
    assert.equal(claimPayload.data.claimed, true);
    assert.equal(claimPayload.data.message?.content, 'ship it');

    // A second claim of the same token must fail: it was already delivered.
    const secondClaimResponse = await fetch(`${base}/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ claimToken: getPayload.data.claimToken }),
    });
    const secondClaimPayload = await secondClaimResponse.json() as { data: { claimed: boolean } };
    assert.equal(secondClaimPayload.data.claimed, false);

    // Simulate a failed delivery: restore the claimed message.
    const restoreResponse = await fetch(`${base}/restore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ claimToken: getPayload.data.claimToken }),
    });
    assert.equal(restoreResponse.status, 200);

    const afterRestoreResponse = await fetch(base);
    const afterRestorePayload = await afterRestoreResponse.json() as { data: { message: { content: string } } };
    assert.equal(afterRestorePayload.data.message.content, 'ship it');

    const deleteResponse = await fetch(base, { method: 'DELETE' });
    assert.equal(deleteResponse.status, 200);

    const afterDeleteResponse = await fetch(base);
    const afterDeletePayload = await afterDeleteResponse.json() as { data: { message: unknown } };
    assert.equal(afterDeletePayload.data.message, null);
  });
});
