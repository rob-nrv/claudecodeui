import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import { resolveTerminatorClientAddress, startRemoteGateway } from '@/modules/remote-access/remote-gateway.service.js';
import { readRequestClientAddress } from '@/shared/utils.js';

test('only the entry the local terminator appended is trusted as the client address', () => {
  assert.equal(resolveTerminatorClientAddress('203.0.113.9', '127.0.0.1'), '203.0.113.9');
  assert.equal(resolveTerminatorClientAddress('6.6.6.6, 203.0.113.9', '127.0.0.1'), '203.0.113.9', 'a forged leading entry is ignored');
  assert.equal(resolveTerminatorClientAddress(['1.1.1.1', '2001:db8::7'], '127.0.0.1'), '2001:db8::7');
  assert.equal(resolveTerminatorClientAddress(undefined, '127.0.0.1'), '127.0.0.1');
  assert.equal(resolveTerminatorClientAddress('not-an-ip', '127.0.0.1'), '127.0.0.1', 'garbage never becomes a rate-limit key');
  assert.equal(resolveTerminatorClientAddress('203.0.113.9, ', '127.0.0.1'), '127.0.0.1');
  assert.equal(resolveTerminatorClientAddress('1.2.3.4', '203.0.113.50'), '203.0.113.50', 'a non-loopback peer is not a trusted proxy');
  assert.equal(resolveTerminatorClientAddress('1.2.3.4', '::1'), '1.2.3.4');
  assert.equal(resolveTerminatorClientAddress('1.2.3.4', '::ffff:127.0.0.1'), '1.2.3.4');
});

async function keyFor(mode: 'external-tls', headers: Record<string, string>): Promise<string> {
  let seen = '';
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const gateway = await startRemoteGateway(
    { mode, bindHost: '127.0.0.1', port, publicOrigin: 'https://relay.test' },
    {
      handleRequest: (request, response) => {
        seen = readRequestClientAddress(request);
        response.end('ok');
      },
      handleUpgrade: () => undefined,
    },
    () => undefined,
  );
  try {
    await new Promise<void>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, headers }, (response) => {
        response.resume();
        response.on('end', resolve);
      }).on('error', reject);
    });
  } finally {
    await gateway?.close();
  }
  return seen;
}

test('behind external-tls, rate limits are keyed per real client instead of one shared bucket', async () => {
  assert.equal(await keyFor('external-tls', { 'x-forwarded-for': '198.51.100.20' }), '198.51.100.20');
  assert.equal(await keyFor('external-tls', { 'x-forwarded-for': '9.9.9.9, 198.51.100.21' }), '198.51.100.21');
  assert.notEqual(await keyFor('external-tls', {}), '198.51.100.20', 'no header: the terminator peer, never a stale value');
});
