import assert from 'node:assert/strict';
import test from 'node:test';

import { readRemoteGatewayConfig } from '@/modules/remote-access/remote-gateway-config.js';

const context = { isPlatform: false, serverPort: 3001 };

test('the remote gateway is off unless explicitly enabled', () => {
  assert.deepEqual(readRemoteGatewayConfig({}, context), { ok: true, config: { mode: 'off' } });
  assert.deepEqual(readRemoteGatewayConfig({ CLOUDCLI_REMOTE_GATEWAY: 'off' }, context), { ok: true, config: { mode: 'off' } });
  assert.equal(readRemoteGatewayConfig({ CLOUDCLI_REMOTE_GATEWAY: 'public' }, context).ok, false);
});

test('an enabled gateway requires an exact https origin and never runs in platform mode', () => {
  const base = { CLOUDCLI_REMOTE_GATEWAY: 'external-tls' };
  assert.equal(readRemoteGatewayConfig(base, context).ok, false, 'origin required');
  assert.equal(readRemoteGatewayConfig({ ...base, CLOUDCLI_REMOTE_ORIGIN: 'http://pc.example' }, context).ok, false, 'plaintext refused');
  assert.equal(readRemoteGatewayConfig({ ...base, CLOUDCLI_REMOTE_ORIGIN: 'https://pc.example/app' }, context).ok, false, 'path refused');
  assert.equal(readRemoteGatewayConfig({ ...base, CLOUDCLI_REMOTE_ORIGIN: 'https://user:pw@pc.example' }, context).ok, false, 'credentials refused');
  assert.equal(readRemoteGatewayConfig({ ...base, CLOUDCLI_REMOTE_ORIGIN: 'https://pc.example?token=1' }, context).ok, false, 'query refused');
  assert.equal(
    readRemoteGatewayConfig({ ...base, CLOUDCLI_REMOTE_ORIGIN: 'https://pc.example' }, { ...context, isPlatform: true }).ok,
    false,
    'platform mode skips authentication',
  );

  const valid = readRemoteGatewayConfig({ ...base, CLOUDCLI_REMOTE_ORIGIN: 'https://PC.example:8443/' }, context);
  assert.deepEqual(valid, {
    ok: true,
    config: { mode: 'external-tls', bindHost: '127.0.0.1', port: 3443, publicOrigin: 'https://pc.example:8443' },
  });
});

test('external TLS termination only binds loopback, and the gateway port never reuses SERVER_PORT', () => {
  const base = { CLOUDCLI_REMOTE_GATEWAY: 'external-tls', CLOUDCLI_REMOTE_ORIGIN: 'https://pc.example' };
  assert.equal(readRemoteGatewayConfig({ ...base, CLOUDCLI_REMOTE_BIND: '0.0.0.0' }, context).ok, false);
  assert.equal(readRemoteGatewayConfig({ ...base, CLOUDCLI_REMOTE_BIND: '192.168.1.20' }, context).ok, false);
  assert.equal(readRemoteGatewayConfig({ ...base, CLOUDCLI_REMOTE_PORT: '3001' }, context).ok, false);
  assert.equal(readRemoteGatewayConfig({ ...base, CLOUDCLI_REMOTE_PORT: '99999' }, context).ok, false);
});

test('built-in TLS needs a certificate and key and may bind the network', () => {
  const base = { CLOUDCLI_REMOTE_GATEWAY: 'tls', CLOUDCLI_REMOTE_ORIGIN: 'https://pc.example:3443' };
  assert.equal(readRemoteGatewayConfig(base, context).ok, false);
  assert.equal(readRemoteGatewayConfig({ ...base, CLOUDCLI_REMOTE_TLS_CERT: 'cert.pem' }, context).ok, false);
  assert.deepEqual(readRemoteGatewayConfig({ ...base, CLOUDCLI_REMOTE_TLS_CERT: 'cert.pem', CLOUDCLI_REMOTE_TLS_KEY: 'key.pem' }, context), {
    ok: true,
    config: {
      mode: 'tls',
      bindHost: '0.0.0.0',
      port: 3443,
      publicOrigin: 'https://pc.example:3443',
      certPath: 'cert.pem',
      keyPath: 'key.pem',
    },
  });
});
