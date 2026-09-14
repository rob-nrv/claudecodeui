// HC-06 repair: a real Android network blip (airplane mode, a tunnel) fails
// reconnect attempts almost instantly with ENETUNREACH while it's down, so
// with a single doubling backoff ceiling the gap between attempts can grow
// past the moment the network actually comes back — burning the run's
// bounded reconnect grace on backoff instead of retries. These tests pin the
// resulting cadence: dense early retries, still capped by whatever ceiling
// the caller configured, only growing to the full ceiling for a sustained
// outage.
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import type { WebSocket } from 'ws';

import { createNodeAgentLinkClient } from '@/modules/node-agent/node-agent-link.client.js';

const PRIVATE_KEY_PEM = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

/** Fails every dial immediately, like ENETUNREACH while the radio is down. */
class UnreachableSocket extends EventEmitter {
  readyState = 0;
  constructor() {
    super();
    setImmediate(() => {
      this.emit('error', new Error('connect ENETUNREACH 192.168.1.36:3443'));
      this.emit('close', 1006);
    });
  }
  send() {}
  ping() {}
  terminate() {}
  close() {}
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function startFailingClient(overrides: Partial<Parameters<typeof createNodeAgentLinkClient>[0]> = {}) {
  const attemptsAt: number[] = [];
  const start = Date.now();
  const client = createNodeAgentLinkClient({
    credential: { version: 1, serverOrigin: 'https://cp.example', nodeId: 'node-1', privateKeyPem: PRIVATE_KEY_PEM, publicKeyPem: '', enrolledAt: '' },
    linkUrl: 'wss://cp.example/api/runtime-node-link',
    runtimeVersion: '1.38.0',
    platform: 'linux',
    arch: 'arm64',
    getActiveExecutions: () => [],
    onWelcome: () => undefined,
    onFrame: () => undefined,
    onDisconnected: () => undefined,
    log: () => undefined,
    createSocket: () => {
      attemptsAt.push(Date.now() - start);
      return new UnreachableSocket() as unknown as WebSocket;
    },
    ...overrides,
  });
  void client.start();
  return { client, attemptsAt };
}

test('the first several retries land close together, well under the sustained-outage ceiling', async () => {
  // Scaled down 100x from the real defaults (initial 1s/fast-cap 6s/6
  // attempts) so the test runs in milliseconds instead of tens of seconds.
  const { client, attemptsAt } = startFailingClient({
    initialBackoffMs: 10,
    fastRetryMaxBackoffMs: 60,
    fastRetryAttempts: 6,
    maxBackoffMs: 300,
  });
  try {
    // Nominal cumulative time to the 7th dial (index 6, still in the fast
    // phase for attempt<6) is ~300ms; with jitter this comfortably lands
    // inside a 500ms wait without yet crossing into the slow-phase gap.
    await sleep(500);
    assert.ok(attemptsAt.length >= 7, `expected at least 7 dial attempts within 500ms, got ${attemptsAt.length}: ${JSON.stringify(attemptsAt)}`);
    const gaps = attemptsAt.slice(1, 7).map((at, index) => at - attemptsAt[index]);
    for (const gap of gaps) {
      assert.ok(gap <= 80, `expected every gap during the fast-retry phase to stay near the 60ms cap (with jitter), got ${gap}ms in ${JSON.stringify(gaps)}`);
    }
  } finally {
    client.stop();
  }
});

test('after the fast-retry phase, backoff grows to the full ceiling for a sustained outage', async () => {
  const { client, attemptsAt } = startFailingClient({
    initialBackoffMs: 5,
    fastRetryMaxBackoffMs: 15,
    fastRetryAttempts: 2,
    maxBackoffMs: 1_000,
  });
  try {
    // Attempts 0-1 are capped at 15ms; attempt 2 onward doubles unbounded
    // (until it would reach 1_000ms), so a few attempts later the gap is
    // already several times the fast-retry cap.
    await sleep(400);
    assert.ok(attemptsAt.length >= 6, `expected at least 6 attempts within 400ms, got ${JSON.stringify(attemptsAt)}`);
    const lateGap = attemptsAt[5] - attemptsAt[4];
    assert.ok(lateGap > 50, `expected the gap once past the fast-retry phase to have grown well beyond the 15ms fast cap, got ${lateGap}ms in ${JSON.stringify(attemptsAt)}`);
  } finally {
    client.stop();
  }
});

test('a fast-retry ceiling above the caller\'s own maxBackoffMs never overrides it', async () => {
  // Mirrors how the multi-node integration test configures a node
  // (initialBackoffMs: 50, maxBackoffMs: 200) — smaller than the real
  // fastRetryMaxBackoffMs default (6_000). The fast-retry phase must never
  // make reconnects slower than the caller's own explicit ceiling.
  const { client, attemptsAt } = startFailingClient({ initialBackoffMs: 10, maxBackoffMs: 40 });
  try {
    await sleep(300);
    assert.ok(attemptsAt.length >= 5, `expected several attempts within 300ms given a 40ms ceiling, got ${JSON.stringify(attemptsAt)}`);
    const gaps = attemptsAt.slice(1).map((at, index) => at - attemptsAt[index]);
    // 40ms cap * 1.2 jitter, plus slack for real setTimeout/event-loop
    // scheduling overhead under test load (not backoff jitter).
    for (const gap of gaps) {
      assert.ok(gap <= 80, `expected no gap to exceed the caller's 40ms ceiling (plus jitter), got ${gap}ms in ${JSON.stringify(gaps)}`);
    }
  } finally {
    client.stop();
  }
});
