import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  appendManifestEntry,
  findForbiddenField,
  readManifest,
  resolveCertificationDir,
  writeEvidenceFile,
} from '../lib/evidence.mjs';

async function withTempHc06Dir(runTest) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hc06-evidence-'));
  try {
    await runTest(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('findForbiddenField flags secret-shaped keys but never a legitimate result code', () => {
  assert.equal(findForbiddenField({ code: 'RUNTIME_NODE_OFFLINE', message: 'offline' }), null, 'a REST/WS error code is exactly the evidence we need to keep');
  assert.equal(findForbiddenField({ nested: { privateKeyPem: 'x' } }), 'nested.privateKeyPem');
  assert.equal(findForbiddenField({ enrollmentCode: '1234-5678-9012' }), 'enrollmentCode');
  assert.equal(findForbiddenField({ headers: { Authorization: 'Bearer x' } }), 'headers.Authorization');
});

test('resolveCertificationDir creates a fresh, timestamped campaign directory and records the pointer', async () => {
  await withTempHc06Dir(async (hc06Dir) => {
    const result = await resolveCertificationDir(hc06Dir, { now: () => new Date('2026-09-14T12:00:00.000Z') });
    assert.equal(result.resumed, false);
    assert.match(result.name, /^certification-2026-09-14/);
    const pointer = await readFile(path.join(hc06Dir, '.certification-current'), 'utf8');
    assert.equal(pointer.trim(), result.name);
  });
});

test('resolveCertificationDir resumes the same directory on a later call by default, instead of starting a disconnected new one', async () => {
  await withTempHc06Dir(async (hc06Dir) => {
    const first = await resolveCertificationDir(hc06Dir, { now: () => new Date('2026-09-14T12:00:00.000Z') });
    const second = await resolveCertificationDir(hc06Dir, { now: () => new Date('2026-09-14T13:00:00.000Z') });
    assert.equal(second.resumed, true);
    assert.equal(second.dir, first.dir);
  });
});

test('resolveCertificationDir with resume:false starts a new campaign without touching the old one', async () => {
  await withTempHc06Dir(async (hc06Dir) => {
    const first = await resolveCertificationDir(hc06Dir, { now: () => new Date('2026-09-14T12:00:00.000Z') });
    await writeEvidenceFile(first.dir, 'kept.json', { kept: true });
    const second = await resolveCertificationDir(hc06Dir, { now: () => new Date('2026-09-14T14:00:00.000Z'), resume: false });
    assert.notEqual(second.dir, first.dir);
    // The old evidence is still there, untouched.
    assert.deepEqual(JSON.parse(await readFile(path.join(first.dir, 'kept.json'), 'utf8')), { kept: true });
  });
});

test('writeEvidenceFile never overwrites an existing file', async () => {
  await withTempHc06Dir(async (hc06Dir) => {
    const { dir } = await resolveCertificationDir(hc06Dir);
    await writeEvidenceFile(dir, 'E5-storage-floor.json', { blocker: 'resources_storage_low' });
    await assert.rejects(
      () => writeEvidenceFile(dir, 'E5-storage-floor.json', { blocker: 'something else now' }),
      /already exists/,
    );
    // The original content survives the refused overwrite attempt.
    const onDisk = JSON.parse(await readFile(path.join(dir, 'E5-storage-floor.json'), 'utf8'));
    assert.deepEqual(onDisk, { blocker: 'resources_storage_low' });
  });
});

test('writeEvidenceFile refuses to write data containing a forbidden field, and writes nothing at all', async () => {
  await withTempHc06Dir(async (hc06Dir) => {
    const { dir } = await resolveCertificationDir(hc06Dir);
    await assert.rejects(
      () => writeEvidenceFile(dir, 'leaky.json', { enrollmentCode: '1234-5678-9012' }),
      /looks like a secret/,
    );
    assert.deepEqual((await readdir(dir)).filter((name) => name !== 'manifest.json'), []);
  });
});

test('writeEvidenceFile writes owner-only-mode JSON that round-trips exactly', async () => {
  await withTempHc06Dir(async (hc06Dir) => {
    const { dir } = await resolveCertificationDir(hc06Dir);
    const data = { id: 'reconnect-short', outcome: 'reconnected_without_local_abort', lines: [1, 2, 3] };
    const target = await writeEvidenceFile(dir, 'reconnect-short.json', data);
    assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), data);
  });
});

test('appendManifestEntry accumulates entries across calls without ever dropping a prior one', async () => {
  await withTempHc06Dir(async (hc06Dir) => {
    const { dir } = await resolveCertificationDir(hc06Dir);
    await appendManifestEntry(dir, { step: 'E0', result: 'not_ready' });
    await appendManifestEntry(dir, { step: 'E1', result: 'enrolled' });
    const manifest = await readManifest(dir);
    assert.deepEqual(manifest.entries.map((entry) => entry.step), ['E0', 'E1']);
    assert.ok(manifest.entries.every((entry) => typeof entry.appendedAt === 'string'));
  });
});

test('appendManifestEntry refuses an entry with a forbidden field, leaving the manifest unchanged', async () => {
  await withTempHc06Dir(async (hc06Dir) => {
    const { dir } = await resolveCertificationDir(hc06Dir);
    await appendManifestEntry(dir, { step: 'E1', result: 'enrolled' });
    await assert.rejects(() => appendManifestEntry(dir, { step: 'E1b', token: 'abc' }), /looks like a secret/);
    const manifest = await readManifest(dir);
    assert.deepEqual(manifest.entries.map((entry) => entry.step), ['E1'], 'the rejected write left the manifest exactly as it was');
  });
});

test('readManifest on a fresh directory (no manifest.json yet) returns an empty, well-shaped manifest rather than throwing', async () => {
  await withTempHc06Dir(async (hc06Dir) => {
    const { dir } = await resolveCertificationDir(hc06Dir);
    assert.deepEqual(await readManifest(dir), { schema: 'cloudcli.hc06-certification-manifest', version: 1, entries: [] });
  });
});

test('a crashed write never leaves a corrupt manifest.json: no .tmp files remain after a normal run', async () => {
  await withTempHc06Dir(async (hc06Dir) => {
    const { dir } = await resolveCertificationDir(hc06Dir);
    await appendManifestEntry(dir, { step: 'E0' });
    await appendManifestEntry(dir, { step: 'E1' });
    const leftovers = (await readdir(dir)).filter((name) => name.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
  });
});
