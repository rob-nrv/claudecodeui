import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  initializeDatabase,
  runtimeNodeCredentialsDb,
  runtimeNodeEnrollmentsDb,
  runtimeNodesDb,
} from '@/modules/database/index.js';
import { createRuntimeNodeEnrollmentService } from '@/modules/runtime-nodes/runtime-node-enrollment.service.js';

async function withDatabase(runTest: () => Promise<void> | void): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'runtime-node-enrollment-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();
  try {
    await runTest();
  } finally {
    closeConnection();
    if (previous === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previous;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

const ed25519PublicKey = () => generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();

function createFixture() {
  const clock = { now: Date.UTC(2026, 8, 13, 12) };
  let minted = 0;
  const service = createRuntimeNodeEnrollmentService({
    store: runtimeNodeEnrollmentsDb,
    now: () => clock.now,
    createNodeId: () => `00000000-0000-4000-8000-00000000000${++minted}`,
  });
  return { clock, service };
}

test('a node enrolls with a one-time code and its own Ed25519 key; the server mints its identity', { concurrency: false }, async () => {
  await withDatabase(() => {
    const { service } = createFixture();
    const { code } = service.createEnrollment(1, `NAS${String.fromCharCode(7)} rack`);
    const publicKey = ed25519PublicKey();

    const { nodeId } = service.redeem({
      code,
      publicKey,
      label: 'ignored-because-the-code-has-a-label',
      platform: 'linux; rm -rf /',
      arch: 'x64',
      runtimeVersion: '1.37.2',
      clientKey: '198.51.100.4',
    });
    assert.equal(nodeId, '00000000-0000-4000-8000-000000000001');

    const node = runtimeNodesDb.getById(nodeId);
    assert.equal(node?.isLocal, false);
    assert.equal(node?.label, 'NAS rack', 'control characters are stripped');
    assert.equal(node?.platform, 'linuxrm-rf', 'descriptive facts are sanitized');
    assert.equal(node?.capabilitiesJson, null, 'enrolling proves no capability');
    const credential = runtimeNodeCredentialsDb.getByNodeId(nodeId);
    assert.equal(credential?.status, 'active');
    assert.equal(credential?.publicKey, publicKey);

    assert.throws(
      () => service.redeem({ code, publicKey: ed25519PublicKey(), label: 'x', platform: null, arch: null, runtimeVersion: null, clientKey: 'k' }),
      { code: 'RUNTIME_NODE_ENROLLMENT_FAILED' },
      'a code enrolls exactly one node',
    );
  });
});

test('expired codes, non-Ed25519 keys and garbage keys never enroll anything', { concurrency: false }, async () => {
  await withDatabase(() => {
    const { clock, service } = createFixture();
    const before = runtimeNodesDb.count();
    const redeem = (code: string, publicKey: unknown) =>
      service.redeem({ code, publicKey, label: null, platform: null, arch: null, runtimeVersion: null, clientKey: 'client' });

    const rsaKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const { code } = service.createEnrollment(1, null);
    assert.throws(() => redeem(code, rsaKey), { code: 'RUNTIME_NODE_ENROLLMENT_FAILED' });
    assert.throws(() => redeem(code, 'not a key'), { code: 'RUNTIME_NODE_ENROLLMENT_FAILED' });
    assert.throws(() => redeem(code, { kty: 'OKP' }), { code: 'RUNTIME_NODE_ENROLLMENT_FAILED' });

    clock.now += 15 * 60_000 + 1;
    assert.throws(() => redeem(code, ed25519PublicKey()), { code: 'RUNTIME_NODE_ENROLLMENT_FAILED' });
    assert.equal(runtimeNodesDb.count(), before);
  });
});

test('one public key is one identity: re-using it is refused without burning the code', { concurrency: false }, async () => {
  await withDatabase(() => {
    const { service } = createFixture();
    const publicKey = ed25519PublicKey();
    const redeem = (code: string, key: string) =>
      service.redeem({ code, publicKey: key, label: 'node', platform: null, arch: null, runtimeVersion: null, clientKey: 'client' });

    redeem(service.createEnrollment(1, null).code, publicKey);
    const second = service.createEnrollment(1, null).code;
    assert.throws(() => redeem(second, publicKey), { code: 'RUNTIME_NODE_KEY_CONFLICT' });
    assert.ok(redeem(second, ed25519PublicKey()).nodeId, 'the code still enrolls a node with its own key');
  });
});

test('guessing enrollment codes is rate limited', { concurrency: false }, async () => {
  await withDatabase(() => {
    const { service } = createFixture();
    const publicKey = ed25519PublicKey();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      assert.throws(
        () => service.redeem({ code: '0000-0000-0000', publicKey, label: null, platform: null, arch: null, runtimeVersion: null, clientKey: 'attacker' }),
        { code: 'RUNTIME_NODE_ENROLLMENT_FAILED' },
      );
    }
    const { code } = service.createEnrollment(1, null);
    assert.throws(
      () => service.redeem({ code, publicKey, label: null, platform: null, arch: null, runtimeVersion: null, clientKey: 'attacker' }),
      { code: 'RUNTIME_NODE_ENROLLMENT_RATE_LIMITED' },
    );

    for (let index = 0; index < 4; index += 1) {
      service.createEnrollment(1, null);
    }
    assert.throws(() => service.createEnrollment(1, null), { code: 'RUNTIME_NODE_ENROLLMENT_LIMIT' });
  });
});
