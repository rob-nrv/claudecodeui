import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import type { WebSocket } from 'ws';

import { createNodeAgentLinkClient } from '@/modules/node-agent/node-agent-link.client.js';

/** The client signs every dial, so the credential needs a real key; nothing is sent anywhere. */
const PRIVATE_KEY_PEM = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

class FakeSocket extends EventEmitter {
  readyState = 0;
  pings = 0;
  terminated = false;

  constructor(private readonly answerPings: boolean) {
    super();
  }

  send() {}

  ping() {
    this.pings += 1;
    if (this.answerPings) {
      this.emit('pong');
    }
  }

  terminate() {
    this.terminated = true;
    this.readyState = 3;
    this.emit('close', 1006);
  }

  close(code = 1000) {
    this.readyState = 3;
    this.emit('close', code);
  }

  openAndWelcome() {
    this.readyState = 1;
    this.emit('open');
    this.emit('message', Buffer.from(JSON.stringify({ type: 'welcome', resume: [] })));
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function startClient(answerPings: boolean) {
  const sockets: FakeSocket[] = [];
  let disconnects = 0;
  const client = createNodeAgentLinkClient({
    credential: { version: 1, serverOrigin: 'https://cp.example', nodeId: 'node-1', privateKeyPem: PRIVATE_KEY_PEM, publicKeyPem: '', enrolledAt: '' },
    linkUrl: 'wss://cp.example/api/runtime-node-link',
    runtimeVersion: '1.38.0',
    platform: 'linux',
    arch: 'arm64',
    getActiveExecutions: () => [],
    onWelcome: () => undefined,
    onFrame: () => undefined,
    onDisconnected: () => {
      disconnects += 1;
    },
    log: () => undefined,
    heartbeatMs: 20,
    livenessTimeoutMs: 70,
    initialBackoffMs: 60_000,
    createSocket: () => {
      const socket = new FakeSocket(answerPings);
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  });
  void client.start();
  sockets[0].openAndWelcome();
  return { client, socket: sockets[0], disconnects: () => disconnects };
}

test('a half-open link (no pong, no frame) is terminated, so runs get their bounded grace and the node re-dials', async () => {
  const silent = startClient(false);
  try {
    await sleep(200);
    assert.equal(silent.socket.terminated, true);
    assert.equal(silent.disconnects(), 1, 'the executor is told the link is gone');
  } finally {
    silent.client.stop();
  }
});

test('a link that answers pings stays up', async () => {
  const healthy = startClient(true);
  try {
    await sleep(200);
    assert.equal(healthy.socket.terminated, false);
    assert.ok(healthy.socket.pings >= 3);
    assert.equal(healthy.disconnects(), 0);
  } finally {
    healthy.client.stop();
  }
});
