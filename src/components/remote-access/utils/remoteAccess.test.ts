import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildNodeAgentCommands,
  describeGateway,
  describeLocalListener,
  resolveEnrollmentOrigin,
  type RemoteGatewayStatus,
} from './remoteAccess';

const gateway = (overrides: Partial<RemoteGatewayStatus> = {}): RemoteGatewayStatus => ({
  mode: 'tls',
  state: 'listening',
  publicOrigin: 'https://pc.example:3443',
  bindHost: '0.0.0.0',
  port: 3443,
  error: null,
  ...overrides,
});

test('gateway and app port states are spelled out and never read as safe when they are not', () => {
  assert.deepEqual(describeGateway(gateway()), { key: 'listening', emphasis: 'positive' });
  assert.deepEqual(describeGateway(gateway({ state: 'failed', error: 'port in use' })), { key: 'failed', emphasis: 'warning' });
  assert.deepEqual(describeGateway(gateway({ mode: 'off', state: 'disabled' })), { key: 'off', emphasis: 'muted' });
  assert.deepEqual(describeLocalListener({ host: '127.0.0.1', port: 3001, loopbackOnly: true }), { key: 'loopbackOnly', emphasis: 'positive' });
  assert.deepEqual(describeLocalListener({ host: '0.0.0.0', port: 3001, loopbackOnly: false }), { key: 'exposed', emphasis: 'warning' });
});

test('nodes enroll against the listening gateway, otherwise against this page, and the code only appears in the command', () => {
  assert.equal(resolveEnrollmentOrigin(gateway(), 'http://localhost:3001'), 'https://pc.example:3443');
  assert.equal(resolveEnrollmentOrigin(gateway({ state: 'failed' }), 'http://localhost:3001'), 'http://localhost:3001');
  assert.equal(resolveEnrollmentOrigin(null, 'http://localhost:3001'), 'http://localhost:3001');
  assert.deepEqual(buildNodeAgentCommands('https://pc.example:3443', 'ABCD-EFGH-JKMN'), [
    'cloudcli node enroll --server https://pc.example:3443 --code ABCD-EFGH-JKMN',
    'cloudcli node start --workspace-root <folder containing your projects>',
  ]);
});
