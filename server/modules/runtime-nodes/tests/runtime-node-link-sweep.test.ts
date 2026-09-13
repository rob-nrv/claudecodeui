import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import test from 'node:test';

import type { WebSocket } from 'ws';

import { createRuntimeNodeLinkService } from '@/modules/runtime-nodes/runtime-node-link.service.js';
import { RUNTIME_NODE_LINK_PATH, RUNTIME_NODE_LINK_PROTOCOL_VERSION, signRuntimeNodeLinkRequest } from '@/shared/utils.js';

class FakeServerSocket extends EventEmitter {
  readyState = 1;
  terminated = false;
  sent: Array<Record<string, unknown>> = [];
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
    this.emit('close');
  }
  terminate() {
    this.terminated = true;
    this.readyState = 3;
    this.emit('close');
  }
  frame(value: Record<string, unknown>) {
    this.emit('message', Buffer.from(JSON.stringify(value)), false);
  }
}

test('a silent link is swept and closed through the normal path; a live one is left alone; hello facts are normalized', () => {
  let clock = Date.now();
  const keys = new Map<string, { publicKey: string; privateKey: string }>();
  for (const nodeId of ['pixel', 'nas']) {
    const pair = generateKeyPairSync('ed25519');
    keys.set(nodeId, {
      publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    });
  }
  const hellos: Array<{ nodeId: string; platform: string | null; arch: string | null }> = [];
  const link = createRuntimeNodeLinkService({
    getCredential: (nodeId) => (keys.has(nodeId) ? { publicKey: keys.get(nodeId)!.publicKey, status: 'active' } : null),
    recordHello: (nodeId, facts) => hellos.push({ nodeId, platform: facts.platform, arch: facts.arch }),
    recordSeen: () => undefined,
    now: () => clock,
    sweepIntervalMs: 0,
  });
  const closed: string[] = [];
  link.onLinkClosed((nodeId) => closed.push(nodeId));

  const connect = (nodeId: string) => {
    const request = {
      url: RUNTIME_NODE_LINK_PATH,
      headers: { authorization: signRuntimeNodeLinkRequest({ nodeId, privateKeyPem: keys.get(nodeId)!.privateKey, path: RUNTIME_NODE_LINK_PATH, timestamp: clock }) },
    } as unknown as IncomingMessage;
    assert.equal(link.verifyUpgrade(request), true);
    const socket = new FakeServerSocket();
    link.handleConnection(socket as unknown as WebSocket, request);
    socket.frame({ type: 'hello', protocolVersion: RUNTIME_NODE_LINK_PROTOCOL_VERSION, platform: 'linux', arch: 'aarch64', runtimeVersion: '1.38.0', activeExecutions: [] });
    return socket;
  };

  const pixel = connect('pixel');
  const nas = connect('nas');
  assert.deepEqual(hellos, [
    { nodeId: 'pixel', platform: 'linux', arch: 'arm64' },
    { nodeId: 'nas', platform: 'linux', arch: 'arm64' },
  ]);

  clock += 45_000;
  nas.frame({ type: 'heartbeat' });
  assert.deepEqual(link.sweepStaleLinks(), [], 'nothing is stale yet');

  clock += 30_000;
  assert.deepEqual(link.sweepStaleLinks(), ['pixel']);
  assert.equal(pixel.terminated, true);
  assert.equal(nas.terminated, false);
  assert.deepEqual(closed, ['pixel'], 'close listeners run, so the pixel runs enter their bounded grace');
  assert.equal(link.getLinkInfo('pixel'), null);
  assert.notEqual(link.getLinkInfo('nas'), null);
});
