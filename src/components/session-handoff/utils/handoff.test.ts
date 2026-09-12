import assert from 'node:assert/strict';
import test from 'node:test';

import type { HandoffTargetOption, SessionLineage } from '../types/types';

import {
  HandoffRequestError,
  buildHandoffRequest,
  readApiResult,
  resolveHandoffPrefill,
  shouldReloadTargetsAfterError,
} from './handoff';

const claudeOption = (claudeProfileId: string | null): HandoffTargetOption => ({
  provider: 'claude',
  claudeProfileId,
  label: 'Claude · Personal',
  connectionState: 'connected',
  available: true,
  unavailableReason: null,
});

const lineageFor = (overrides: Partial<NonNullable<SessionLineage['incoming']>> = {}): SessionLineage => ({
  sessionId: 'target',
  taskRootSessionId: 'source',
  incoming: {
    handoffId: 'h1',
    createdAt: '2026-09-11 10:00:00',
    sourceSessionId: 'source',
    sourceExists: true,
    sourceTitle: 'Fix login',
    sourceProvider: 'claude',
    sourceClaudeProfileId: 'work',
    sourceModel: null,
    sourceEffort: null,
    targetProvider: 'claude',
    targetClaudeProfileId: 'personal',
    targetStarted: false,
    handoffPackage: 'PACKAGE',
    ...overrides,
  },
  outgoing: [],
});

test('a Claude handoff request always names the account, even the legacy null one', () => {
  assert.deepEqual(buildHandoffRequest(claudeOption('personal'), '  '), { provider: 'claude', claudeProfileId: 'personal' });
  assert.deepEqual(buildHandoffRequest(claudeOption(null), ''), { provider: 'claude', claudeProfileId: null });
  assert.equal('claudeProfileId' in buildHandoffRequest(claudeOption(null), ''), true);
});

test('a non-Claude handoff request carries no account and keeps the trimmed note', () => {
  const request = buildHandoffRequest({ ...claudeOption(null), provider: 'codex', label: 'Codex' }, ' run tests ');
  assert.deepEqual(request, { provider: 'codex', note: 'run tests' });
});

test('the package is prefilled only for an unstarted target with nothing on screen', () => {
  const base = { lineage: lineageFor(), sessionId: 'target', hasMessages: false, isBusy: false };

  assert.equal(resolveHandoffPrefill(base), 'PACKAGE');
  assert.equal(resolveHandoffPrefill({ ...base, sessionId: 'other' }), null);
  assert.equal(resolveHandoffPrefill({ ...base, hasMessages: true }), null);
  assert.equal(resolveHandoffPrefill({ ...base, isBusy: true }), null);
  assert.equal(resolveHandoffPrefill({ ...base, lineage: lineageFor({ targetStarted: true }) }), null);
  assert.equal(resolveHandoffPrefill({ ...base, lineage: { ...lineageFor(), incoming: null } }), null);
});

test('API errors keep the backend code so the dialog can explain and recover', async () => {
  const response = new Response(
    JSON.stringify({ success: false, error: { code: 'HANDOFF_SOURCE_RUNNING', message: 'Still running' } }),
    { status: 409 },
  );

  await assert.rejects(readApiResult(response), (error: unknown) => {
    assert.ok(error instanceof HandoffRequestError);
    assert.equal(error.code, 'HANDOFF_SOURCE_RUNNING');
    assert.equal(error.message, 'Still running');
    return true;
  });
  assert.equal(shouldReloadTargetsAfterError('HANDOFF_SOURCE_RUNNING'), true);
  assert.equal(shouldReloadTargetsAfterError('HANDOFF_TARGET_UNCHANGED'), false);

  const ok = new Response(JSON.stringify({ success: true, data: { sessionId: 'x' } }), { status: 201 });
  assert.deepEqual(await readApiResult(ok), { sessionId: 'x' });
});
