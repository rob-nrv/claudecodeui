// HC06-IDENTITY-REPAIR-R1: the default HC06_EVIDENCE_DIR was computed with
// `new URL('./evidence', import.meta.url).pathname`, which on Windows keeps
// the leading "/" before the drive letter and never decodes percent-escapes
// — a repo path containing a space (this one does: "PROJET CLOUDCLI V2")
// comes back with a literal "%20". Resolving that pathname produced the
// real observed corruption: "D:\D:\Claude\PROJET%20CLOUDCLI%20V2\...".
// `fileURLToPath` is the fix; this test guards the regression directly
// against the actual exported config function, not just against Node's
// own (already-correct) `fileURLToPath` implementation.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { evidenceConfig } from '../control-plane-runner.mjs';

test('the default evidence directory never doubles the drive letter and never leaves a percent-escape behind', () => {
  delete process.env.HC06_EVIDENCE_DIR;
  const { evidenceDir } = evidenceConfig();

  assert.equal(/^[A-Za-z]:\\[A-Za-z]:\\/.test(evidenceDir), false, `expected no doubled drive letter, got ${evidenceDir}`);
  assert.equal(evidenceDir.includes('%20'), false, `expected no leftover percent-escape, got ${evidenceDir}`);
  assert.equal(evidenceDir.includes('%'), false, `expected no percent-escape of any kind, got ${evidenceDir}`);

  // Ends in a plain "evidence" folder alongside this file, exactly what
  // fileURLToPath(new URL('./evidence', import.meta.url)) would resolve to.
  const expected = fileURLToPath(new URL('../evidence', import.meta.url)); // tests/ -> android/evidence
  assert.equal(evidenceDir, expected);
});

test('HC06_EVIDENCE_DIR still overrides the default exactly, unaffected by the fix', () => {
  process.env.HC06_EVIDENCE_DIR = '/tmp/some-other-evidence-dir';
  try {
    assert.equal(evidenceConfig().evidenceDir, '/tmp/some-other-evidence-dir');
  } finally {
    delete process.env.HC06_EVIDENCE_DIR;
  }
});
