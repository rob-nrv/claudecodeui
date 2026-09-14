// HC06-IDENTITY-EVIDENCE-REPAIR-R2: proves the identity test's evidence is
// minimized correctly, WITHOUT touching (and while re-proving unchanged)
// lib/evidence.mjs's forbidden-field guard. The real crash this reproduces:
// getWorkspaceState's ProjectWorkspaceStateView carries `sync.secret` /
// `sync.secretContent` — legitimate file-count numbers, never actual secret
// content — but the key name alone correctly trips findForbiddenField.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { writeEvidenceFile } from '../lib/evidence.mjs';
import {
  expectIdentityMismatch,
  runIdentityMismatchTest,
  summarizeIdentityTestEvidence,
} from '../lib/identity-test-evidence.mjs';

/** Shaped exactly like server/modules/project-workspaces/workspace-state.ts's ProjectWorkspaceStateView, with a nonzero secret-class file count. */
function rawStateWithSecret(overrides = {}) {
  return {
    state: 'identity_mismatch',
    reason: 'different_repository_history',
    identity: 'mismatch',
    inspectedAt: '2026-09-14T10:00:00.000Z',
    git: { rootIsFolder: true, branch: 'master', detached: false, headCommit: 'ea2c8da60fc8131776a931782bce9f01c17dbe45', upstream: null },
    changes: { staged: 0, modified: 0, added: 0, deleted: 0, renamed: 0, untracked: 0, conflicted: 0, total: 0, truncated: false },
    sync: { syncable: 0, localOnly: 0, secret: 2, userExcluded: 0, secretContent: 1, changesDigest: 'e'.repeat(64), digestReason: null },
    ...overrides,
  };
}

async function withTempDir(runTest) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'identity-evidence-'));
  try {
    await runTest(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('the forbidden-field guard is UNCHANGED: it still refuses the raw state object directly, and still refuses it wrapped in a runWithRestore-shaped result', async () => {
  await withTempDir(async (dir) => {
    const raw = rawStateWithSecret();
    await assert.rejects(() => writeEvidenceFile(dir, 'raw-state.json', raw), /looks like a secret/);
    await assert.rejects(
      () => writeEvidenceFile(dir, 'raw-result.json', { ok: true, restored: true, applyError: null, runError: null, restoreError: null, value: raw }),
      /looks like a secret/,
    );
  });
});

test('summarizeIdentityTestEvidence drops sync, changes, git and inspectedAt entirely — only state/identity/reason survive', () => {
  const raw = rawStateWithSecret();
  const summary = summarizeIdentityTestEvidence({ ok: true, restored: true, applyError: null, runError: null, restoreError: null, value: raw });
  assert.deepEqual(summary, {
    ok: true,
    restored: true,
    applyError: null,
    runError: null,
    restoreError: null,
    observed: { state: 'identity_mismatch', identity: 'mismatch', reason: 'different_repository_history' },
  });
  assert.equal('sync' in summary, false);
  assert.equal(JSON.stringify(summary).includes('secret'), false, 'the word "secret" must not appear anywhere in the summarized evidence');
});

test('summarizeIdentityTestEvidence handles a missing value (the run step never returned one) without throwing', () => {
  assert.deepEqual(
    summarizeIdentityTestEvidence({ ok: false, restored: true, applyError: 'node offline', runError: null, restoreError: null }),
    { ok: false, restored: true, applyError: 'node offline', runError: null, restoreError: null, observed: null },
  );
});

test('the summarized evidence can actually be written — the guard is not fighting the harness, just the raw object', async () => {
  await withTempDir(async (dir) => {
    const raw = rawStateWithSecret();
    const summary = summarizeIdentityTestEvidence({ ok: true, restored: true, applyError: null, runError: null, restoreError: null, value: raw });
    const target = await writeEvidenceFile(dir, 'safe.json', summary);
    const onDisk = JSON.parse(await readFile(target, 'utf8'));
    assert.deepEqual(onDisk, summary);
    assert.equal(JSON.stringify(onDisk).includes('secret'), false);
  });
});

test('expectIdentityMismatch throws a minimal message on a mismatch failure — never JSON.stringify of the full state, so the secret-shaped key can never leak into a string bypass either', async () => {
  const getState = async () => rawStateWithSecret({ state: 'clean', identity: 'match', reason: null });
  await assert.rejects(expectIdentityMismatch(getState)(), (error) => {
    assert.match(error.message, /Expected state "identity_mismatch"/);
    assert.match(error.message, /state="clean"/);
    assert.match(error.message, /identity="match"/);
    assert.equal(error.message.includes('secret'), false, 'the error string itself must never carry the raw sync object');
    assert.equal(error.message.includes('inspectedAt'), false);
    return true;
  });
});

test('expectIdentityMismatch returns the state unchanged when it really is identity_mismatch', async () => {
  const raw = rawStateWithSecret();
  const result = await expectIdentityMismatch(async () => raw)();
  assert.equal(result, raw);
});

test('runIdentityMismatchTest end to end: apply, observe a secret-bearing mismatch, restore — the returned evidence writes safely and contains no secret-shaped field', async () => {
  await withTempDir(async (dir) => {
    const calls = [];
    const result = await runIdentityMismatchTest({
      apply: async () => calls.push('apply'),
      getState: async () => rawStateWithSecret(),
      restore: async () => calls.push('restore'),
    });
    assert.deepEqual(calls, ['apply', 'restore']);
    assert.deepEqual(result, {
      ok: true,
      restored: true,
      applyError: null,
      runError: null,
      restoreError: null,
      observed: { state: 'identity_mismatch', identity: 'mismatch', reason: 'different_repository_history' },
    });
    await writeEvidenceFile(dir, 'end-to-end.json', result); // must not throw
  });
});

test('runIdentityMismatchTest on the failure path (never reaches identity_mismatch): restore still runs, and the evidence — including runError — writes safely with no secret leak', async () => {
  await withTempDir(async (dir) => {
    const result = await runIdentityMismatchTest({
      apply: async () => undefined,
      getState: async () => rawStateWithSecret({ state: 'clean', identity: 'match', reason: null }),
      restore: async () => undefined,
    });
    assert.equal(result.ok, false);
    assert.equal(result.restored, true);
    assert.match(result.runError, /Expected state "identity_mismatch"/);
    assert.equal(result.runError.includes('secret'), false);
    assert.equal(result.observed, null, 'the run step threw before returning a value, so there is nothing to observe');
    await writeEvidenceFile(dir, 'failure-path.json', result); // must not throw
  });
});
