import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildLocalServerMarker,
  createRuntimeIdentity,
  parseLocalServerMarker,
  parseRuntimeHealth,
  resolveLocalServerMarkerPath,
} from '../runtime-marker.js';
import { createLocalServerMarkerStore } from '../runtime-marker.store.js';

const IDENTITY = {
  instanceId: 'instance-a',
  pid: 4242,
  startedAt: '2026-08-28T10:00:00.000Z',
};

const LOCATION = {
  host: '127.0.0.1',
  port: 3001,
  url: 'http://localhost:3001',
  installMode: 'git',
  appRoot: '/opt/cloudcli',
  version: '1.37.2',
};

async function createTemporaryHome(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-runtime-'));
}

test('the marker path stays under the shared ~/.cloudcli folder', () => {
  assert.equal(
    resolveLocalServerMarkerPath('/home/user'),
    path.join('/home/user', '.cloudcli', 'local-server.json'),
  );
});

test('each process mints a distinct instance id', () => {
  const first = createRuntimeIdentity();
  const second = createRuntimeIdentity();

  assert.notEqual(first.instanceId, second.instanceId);
  assert.equal(first.pid, process.pid);
  assert.equal(new Date(first.startedAt).toISOString(), first.startedAt);
});

test('a written marker round-trips through the store with its identity intact', async () => {
  const home = await createTemporaryHome();
  const store = createLocalServerMarkerStore(home);

  await store.write(buildLocalServerMarker(IDENTITY, LOCATION, new Date('2026-08-28T10:00:01.000Z')));

  assert.deepEqual(await store.read(), {
    ...IDENTITY,
    ...LOCATION,
    updatedAt: '2026-08-28T10:00:01.000Z',
  });
});

test('markers written by servers that predate instance identity still parse', () => {
  const marker = parseLocalServerMarker({
    pid: 99,
    host: '127.0.0.1',
    port: 3001,
    url: 'http://localhost:3001',
    installMode: 'npm',
    appRoot: '/opt/cloudcli',
    updatedAt: '2026-08-27T09:00:00.000Z',
  });

  assert.equal(marker?.instanceId, '');
  // Without startedAt the write time is the best startup evidence available.
  assert.equal(marker?.startedAt, '2026-08-27T09:00:00.000Z');
});

test('a marker without a usable address is rejected rather than half-trusted', () => {
  assert.equal(parseLocalServerMarker({ pid: 1, host: '127.0.0.1' }), null);
  assert.equal(parseLocalServerMarker({ host: '127.0.0.1', port: 3001 }), null);
  assert.equal(parseLocalServerMarker('not-an-object'), null);
});

test('a missing marker file reads as no marker instead of throwing', async () => {
  const store = createLocalServerMarkerStore(await createTemporaryHome());

  assert.equal(await store.read(), null);
});

test('a corrupt marker file reads as no marker', async () => {
  const home = await createTemporaryHome();
  const store = createLocalServerMarkerStore(home);
  await fs.mkdir(path.dirname(store.markerPath), { recursive: true });
  await fs.writeFile(store.markerPath, '{ this is not json', 'utf8');

  assert.equal(await store.read(), null);
});

test('shutdown removes only a marker the shutting-down instance still owns', async () => {
  const home = await createTemporaryHome();
  const store = createLocalServerMarkerStore(home);
  await store.write(buildLocalServerMarker({ ...IDENTITY, instanceId: 'instance-b' }, LOCATION));

  assert.equal(await store.removeIfOwnedBy(IDENTITY), false);
  assert.notEqual(await store.read(), null);

  assert.equal(await store.removeIfOwnedBy({ ...IDENTITY, instanceId: 'instance-b' }), true);
  assert.equal(await store.read(), null);
});

test('shutdown falls back to the pid when the marker predates instance identity', async () => {
  const home = await createTemporaryHome();
  const store = createLocalServerMarkerStore(home);
  await fs.mkdir(path.dirname(store.markerPath), { recursive: true });
  await fs.writeFile(
    store.markerPath,
    JSON.stringify({ pid: 4242, host: '127.0.0.1', port: 3001, url: 'http://localhost:3001' }),
    'utf8',
  );

  assert.equal(await store.removeIfOwnedBy({ ...IDENTITY, pid: 7 }), false);
  assert.equal(await store.removeIfOwnedBy(IDENTITY), true);
});

test('health parses the runtime identity a live server publishes', () => {
  assert.deepEqual(
    parseRuntimeHealth({
      status: 'ok',
      installMode: 'git',
      runtime: { instanceId: 'instance-a', startedAt: '2026-08-28T10:00:00.000Z' },
    }),
    { instanceId: 'instance-a', startedAt: '2026-08-28T10:00:00.000Z' },
  );
});

test('health from a server without a runtime block parses with a null identity', () => {
  assert.deepEqual(parseRuntimeHealth({ status: 'ok', installMode: 'git' }), {
    instanceId: null,
    startedAt: null,
  });
});

test('a responder that is not CloudCLI never parses as health', () => {
  assert.equal(parseRuntimeHealth({ status: 'ok' }), null);
  assert.equal(parseRuntimeHealth({ status: 'degraded', installMode: 'git' }), null);
  assert.equal(parseRuntimeHealth('<html>some other server</html>'), null);
});
