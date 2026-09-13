import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';

import {
  createFailureRateLimiter,
  generateOneTimeCode,
  hashSecretValue,
  normalizeOneTimeCode,
  parseRuntimeNodeLinkAuthorization,
  RUNTIME_NODE_LINK_PATH,
  signRuntimeNodeLinkRequest,
  verifyRuntimeNodeLinkSignature,
} from '@/shared/utils.js';

function ed25519KeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

const NONCE = 'n'.repeat(24);

test('a signed node link header verifies only for its own key, node id, path, timestamp and nonce', () => {
  const nodeA = ed25519KeyPair();
  const nodeB = ed25519KeyPair();
  const header = signRuntimeNodeLinkRequest({
    nodeId: 'node-a',
    privateKeyPem: nodeA.privateKeyPem,
    path: RUNTIME_NODE_LINK_PATH,
    timestamp: 1_700_000_000_000,
    nonce: NONCE,
  });
  const parsed = parseRuntimeNodeLinkAuthorization(header);
  assert.ok(parsed);
  assert.equal(parsed.nodeId, 'node-a');

  assert.equal(verifyRuntimeNodeLinkSignature(parsed, nodeA.publicKeyPem, RUNTIME_NODE_LINK_PATH), true);
  assert.equal(verifyRuntimeNodeLinkSignature(parsed, nodeB.publicKeyPem, RUNTIME_NODE_LINK_PATH), false, 'another node key');
  assert.equal(verifyRuntimeNodeLinkSignature(parsed, nodeA.publicKeyPem, '/ws'), false, 'another path');
  assert.equal(verifyRuntimeNodeLinkSignature({ ...parsed, nodeId: 'node-b' }, nodeA.publicKeyPem, RUNTIME_NODE_LINK_PATH), false, 'claimed id');
  assert.equal(verifyRuntimeNodeLinkSignature({ ...parsed, timestamp: parsed.timestamp + 1 }, nodeA.publicKeyPem, RUNTIME_NODE_LINK_PATH), false);
  assert.equal(verifyRuntimeNodeLinkSignature({ ...parsed, nonce: 'm'.repeat(24) }, nodeA.publicKeyPem, RUNTIME_NODE_LINK_PATH), false);

  const rsaPublicKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString();
  assert.equal(verifyRuntimeNodeLinkSignature(parsed, rsaPublicKey, RUNTIME_NODE_LINK_PATH), false, 'only Ed25519 keys');
  assert.equal(verifyRuntimeNodeLinkSignature(parsed, 'not a key', RUNTIME_NODE_LINK_PATH), false);
});

test('the node link header parser refuses malformed, duplicated, unknown or oversized fields', () => {
  const { privateKeyPem } = ed25519KeyPair();
  const valid = signRuntimeNodeLinkRequest({ nodeId: 'node-a', privateKeyPem, path: RUNTIME_NODE_LINK_PATH, nonce: NONCE });

  assert.ok(parseRuntimeNodeLinkAuthorization(valid));
  assert.equal(parseRuntimeNodeLinkAuthorization(undefined), null);
  assert.equal(parseRuntimeNodeLinkAuthorization('Bearer abc.def.ghi'), null);
  assert.equal(parseRuntimeNodeLinkAuthorization(`${valid},extra=1`), null);
  assert.equal(parseRuntimeNodeLinkAuthorization(valid.replace(/ts=\d+/, 'ts=soon')), null);
  assert.equal(parseRuntimeNodeLinkAuthorization(valid.replace(/node=[^,]+/, 'node=../../etc')), null);
  assert.equal(parseRuntimeNodeLinkAuthorization(valid.replace(/nonce=[^,]+/, 'node=node-b')), null, 'duplicate field');
  assert.equal(parseRuntimeNodeLinkAuthorization(`${valid}${'x'.repeat(600)}`), null);
});

test('one-time codes are distinct 60-bit Crockford codes, normalized leniently and stored only as hashes', () => {
  const codes = new Set(Array.from({ length: 200 }, () => generateOneTimeCode()));
  assert.equal(codes.size, 200);
  for (const code of codes) {
    assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  }

  const [code] = codes;
  assert.equal(normalizeOneTimeCode(code.toLowerCase().replace(/-/g, ' ')), code.replace(/-/g, ''));
  assert.equal(normalizeOneTimeCode('0O1I-L000-0000'), '001110000000');
  assert.equal(normalizeOneTimeCode('ABC'), null);
  assert.equal(normalizeOneTimeCode('UUUU-UUUU-UUUU'), null);
  assert.equal(normalizeOneTimeCode(42), null);

  assert.match(hashSecretValue(code), /^[0-9a-f]{64}$/);
  assert.equal(hashSecretValue(code).includes(code), false);
});

test('the failure limiter blocks per client and globally, never records refused attempts, and recovers after the window', () => {
  let now = 0;
  const limiter = createFailureRateLimiter({ windowMs: 1000, maxFailuresPerKey: 2, maxFailuresGlobal: 3, now: () => now });

  assert.equal(limiter.check('a').allowed, true);
  limiter.recordFailure('a');
  now = 100;
  limiter.recordFailure('a');
  assert.deepEqual(limiter.check('a'), { allowed: false, retryAfterMs: 900 }, 'until the oldest failure leaves the window');
  assert.equal(limiter.check('b').allowed, true);

  limiter.recordFailure('b');
  assert.equal(limiter.check('c').allowed, false, 'the global budget covers addresses never seen before');

  now = 1000;
  assert.equal(limiter.check('a').allowed, true, 'the first failure left the window');
  assert.equal(limiter.check('c').allowed, true);

  // reset() forgives one client (a successful attempt) but never refunds the global budget.
  const forgiving = createFailureRateLimiter({ windowMs: 1000, maxFailuresPerKey: 1, maxFailuresGlobal: 100, now: () => now });
  forgiving.recordFailure('d');
  assert.equal(forgiving.check('d').allowed, false);
  forgiving.reset('d');
  assert.equal(forgiving.check('d').allowed, true);
});
