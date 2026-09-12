import assert from 'node:assert/strict';
import test from 'node:test';

import type { HandoffTargetOption, SessionLineage } from '../types/types';

import {
  HandoffRequestError,
  buildHandoffRequest,
  isHandoffDraftActive,
  planHandoffDraftOwnership,
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

test('isHandoffDraftActive agrees exactly with resolveHandoffPrefill about which sessions are live targets', () => {
  const base = { lineage: lineageFor(), sessionId: 'target', hasMessages: false, isBusy: false };
  const cases = [
    base,
    { ...base, sessionId: 'other' },
    { ...base, hasMessages: true },
    { ...base, isBusy: true },
    { ...base, lineage: lineageFor({ targetStarted: true }) },
    { ...base, lineage: { ...lineageFor(), incoming: null } },
    { ...base, sessionId: null },
  ];

  for (const input of cases) {
    assert.equal(isHandoffDraftActive(input), resolveHandoffPrefill(input) !== null, JSON.stringify(input.sessionId));
  }
  // The one case where they must differ in VALUE (not truthiness): an empty
  // package string is still "no package to show" but is never possible here
  // since the backend never persists an empty handoff_package — covered by
  // the identical eligibility gate above, not a separate branch.
});

// FT-M05-R1: pure ownership state machine backing ChatInterface's handoff
// draft effect. `trackedSessionId` models "which session currently owns the
// shared composer input for an unsent handoff draft".
test('A. TARGET OWNERSHIP — an eligible target with an empty composer claims the canonical package', () => {
  const plan = planHandoffDraftOwnership(
    { trackedSessionId: null },
    { sessionId: 'target', isActive: true, input: '' },
    null,
    'PACKAGE',
  );

  assert.equal(plan.trackedSessionId, 'target');
  assert.equal(plan.loadInput, 'PACKAGE');
  assert.equal(plan.stashSessionId, null);
  assert.equal(plan.consumeSessionId, null);
  assert.equal(plan.resetInput, false);
});

test('B/C. SOURCE AND THIRD-SESSION ISOLATION — switching away stashes the target draft under its own key and clears the shared input', () => {
  const plan = planHandoffDraftOwnership(
    { trackedSessionId: 'target' },
    { sessionId: 'source', isActive: false, input: 'PACKAGE plus a note I typed' },
    null,
    null,
  );

  assert.equal(plan.stashSessionId, 'target');
  assert.equal(plan.stashContent, 'PACKAGE plus a note I typed');
  assert.equal(plan.resetInput, true);
  assert.equal(plan.trackedSessionId, null);
  assert.equal(plan.loadInput, null, 'source never claims/loads a handoff draft that is not its own');

  // A third, unrelated session sees exactly the same isolation — the plan
  // has no notion of "source" vs. "any other session", which is the point.
  const thirdSessionPlan = planHandoffDraftOwnership(
    { trackedSessionId: 'target' },
    { sessionId: 'unrelated-session', isActive: false, input: 'PACKAGE plus a note I typed' },
    null,
    null,
  );
  assert.deepEqual(thirdSessionPlan, plan, 'the outcome does not depend on which foreign session is now active');
});

test('D. RELOAD — recomputing the plan for the same still-eligible session is a no-op (idempotent)', () => {
  const claimed = planHandoffDraftOwnership(
    { trackedSessionId: null },
    { sessionId: 'target', isActive: true, input: '' },
    null,
    'PACKAGE',
  );
  assert.equal(claimed.trackedSessionId, 'target');

  const steadyState = planHandoffDraftOwnership(
    { trackedSessionId: claimed.trackedSessionId },
    { sessionId: 'target', isActive: true, input: 'PACKAGE' },
    'PACKAGE',
    'PACKAGE',
  );

  assert.equal(steadyState.trackedSessionId, 'target');
  assert.equal(steadyState.loadInput, null, 'already claimed — nothing to (re-)load');
  assert.equal(steadyState.stashSessionId, null);
  assert.equal(steadyState.consumeSessionId, null);
  assert.equal(steadyState.resetInput, false);
});

test('E. CLOSE/REOPEN SOURCE is a structural guarantee, not a plan branch: readHandoffDraft is keyed per session, so a fresh mount on the source session never even looks at the target\'s key', () => {
  // No plan computation is needed for this session at all — it never had a
  // tracked draft, so a cold start goes straight to "not a target, nothing
  // to claim".
  const plan = planHandoffDraftOwnership(
    { trackedSessionId: null },
    { sessionId: 'source', isActive: false, input: '' },
    null,
    null,
  );
  assert.deepEqual(plan, { stashSessionId: null, stashContent: '', consumeSessionId: null, resetInput: false, trackedSessionId: null, loadInput: null });
});

test('F. RETURN TARGET — returning to a still-eligible target restores its own stashed edit over the canonical package', () => {
  const plan = planHandoffDraftOwnership(
    { trackedSessionId: null },
    { sessionId: 'target', isActive: true, input: '' },
    'PACKAGE plus my edit',
    'PACKAGE',
  );

  assert.equal(plan.trackedSessionId, 'target');
  assert.equal(plan.loadInput, 'PACKAGE plus my edit');
});

test('G. AFTER SEND — the same session becoming ineligible consumes (not stashes) its draft', () => {
  const plan = planHandoffDraftOwnership(
    { trackedSessionId: 'target' },
    { sessionId: 'target', isActive: false, input: '' },
    null,
    null,
  );

  assert.equal(plan.consumeSessionId, 'target');
  assert.equal(plan.stashSessionId, null, 'a send must not preserve the draft for a later restore');
  assert.equal(plan.trackedSessionId, null);
  assert.equal(plan.resetInput, false, 'the composer already cleared its own input on send');
});

test('H. NORMAL DRAFTS — an eligible target never overwrites text already in the composer', () => {
  const plan = planHandoffDraftOwnership(
    { trackedSessionId: null },
    { sessionId: 'target', isActive: true, input: 'something the user was already typing' },
    null,
    'PACKAGE',
  );

  assert.equal(plan.trackedSessionId, null);
  assert.equal(plan.loadInput, null);
});

test('a direct switch between two live handoff targets loads the new one instead of leaving the input blank', () => {
  const plan = planHandoffDraftOwnership(
    { trackedSessionId: 'target-1' },
    { sessionId: 'target-2', isActive: true, input: 'target-1 leftover' },
    null,
    'PACKAGE-2',
  );

  assert.equal(plan.stashSessionId, 'target-1');
  assert.equal(plan.stashContent, 'target-1 leftover');
  assert.equal(plan.trackedSessionId, 'target-2');
  assert.equal(plan.loadInput, 'PACKAGE-2');
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
