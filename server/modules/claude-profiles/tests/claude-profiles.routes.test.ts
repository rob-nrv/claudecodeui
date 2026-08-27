import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import { createClaudeProfilesRouter } from '@/modules/claude-profiles/claude-profiles.routes.js';
import { createClaudeProfilesService } from '@/modules/claude-profiles/claude-profiles.service.js';
import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import type { ClaudeAuthStatusProbeResult } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

// Mirrors server/index.ts's global error middleware: without it, an AppError
// thrown by a route falls through to Express's default HTML error page
// instead of the app's JSON error envelope, which the assertions below rely on.
const jsonErrorMiddleware = (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      success: false,
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }
  res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
};

async function withClaudeProfilesServer(
  probeAuthStatus: (configDirectory?: string) => Promise<ClaudeAuthStatusProbeResult | null>,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-profiles-routes-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  const service = createClaudeProfilesService({ probeAuthStatus });
  const app = express();
  app.use(express.json());
  app.use('/api/claude-profiles', createClaudeProfilesRouter(service));
  app.use(jsonErrorMiddleware);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

const neverProbe = async (): Promise<ClaudeAuthStatusProbeResult | null> => {
  throw new Error('probeAuthStatus should not be called for this test');
};

test('GET / then POST /: create returns 201 and the profile never carries configDirectory or a token', async () => {
  await withClaudeProfilesServer(neverProbe, async (baseUrl) => {
    const emptyList = await fetch(`${baseUrl}/api/claude-profiles`);
    assert.equal(emptyList.status, 200);
    const emptyListBody = await emptyList.json() as { data: { profiles: unknown[] } };
    assert.deepEqual(emptyListBody.data, { profiles: [] });

    const created = await fetch(`${baseUrl}/api/claude-profiles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Personal' }),
    });
    assert.equal(created.status, 201);
    const body = await created.json() as { success: boolean; data: { profile: Record<string, unknown> } };
    assert.equal(body.success, true);
    assert.equal(body.data.profile.displayName, 'Personal');
    assert.equal(body.data.profile.isDefault, true);
    assert.equal('configDirectory' in body.data.profile, false);
    assert.equal('token' in body.data.profile, false);
    assert.equal('orgId' in body.data.profile, false);
  });
});

test('POST /: missing displayName is rejected with 400', async () => {
  await withClaudeProfilesServer(neverProbe, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/claude-profiles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 400);
    const body = await response.json() as { success: boolean };
    assert.equal(body.success, false);
  });
});

test('PATCH /:id: renames and, separately, sets default', async () => {
  await withClaudeProfilesServer(neverProbe, async (baseUrl) => {
    const created = await fetch(`${baseUrl}/api/claude-profiles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Personal' }),
    });
    const { data: { profile } } = await created.json() as { data: { profile: { id: string } } };

    const renamed = await fetch(`${baseUrl}/api/claude-profiles/${profile.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Renamed' }),
    });
    assert.equal(renamed.status, 200);
    const renamedBody = await renamed.json() as { data: { profile: { displayName: string } } };
    assert.equal(renamedBody.data.profile.displayName, 'Renamed');
  });
});

test('DELETE /:id: unknown id returns 404', async () => {
  await withClaudeProfilesServer(neverProbe, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/claude-profiles/does-not-exist`, { method: 'DELETE' });
    assert.equal(response.status, 404);
  });
});

test('POST /:id/verify: probes with the correct profile and never leaks the raw probe payload (e.g. orgId)', async () => {
  const seen: Array<string | undefined> = [];
  await withClaudeProfilesServer(
    async (configDirectory) => {
      seen.push(configDirectory);
      return {
        loggedIn: true,
        authMethod: 'claude.ai',
        apiProvider: 'firstParty',
        email: 'robin@example.com',
        orgId: 'org_should_not_leak',
        orgName: 'Acme',
        subscriptionType: 'pro',
      };
    },
    async (baseUrl) => {
      const created = await fetch(`${baseUrl}/api/claude-profiles`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: 'Personal' }),
      });
      const { data: { profile } } = await created.json() as { data: { profile: { id: string } } };

      const verified = await fetch(`${baseUrl}/api/claude-profiles/${profile.id}/verify`, { method: 'POST' });
      assert.equal(verified.status, 200);
      const verifiedBody = await verified.json() as {
        data: { profile: { connectionState: string; verifiedIdentity: { value: string } | null } };
      };
      assert.equal(verifiedBody.data.profile.connectionState, 'connected');
      assert.equal(verifiedBody.data.profile.verifiedIdentity?.value, 'robin@example.com');
      assert.equal(JSON.stringify(verifiedBody).includes('org_should_not_leak'), false);
      assert.equal(seen.length, 1);
    },
  );
});
