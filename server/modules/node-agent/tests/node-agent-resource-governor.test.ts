import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildResourceReport,
  evaluateResourceAdmission,
  readNodeResourceSignals,
  type NodeResourceSignals,
  type ResourceGovernorPolicy,
} from '@/modules/node-agent/node-agent-resource-governor.js';
import { parseResourcePolicyFlags } from '@/modules/node-agent/node-agent.command.js';

const MB = 1024 * 1024;
const policy: ResourceGovernorPolicy = { maxConcurrentRuns: 1, minFreeStorageBytes: 512 * MB, minBatteryPercent: 20 };
const unknownSignals: NodeResourceSignals = {
  storage: { state: 'unknown', reason: 'storage_unreadable' },
  battery: { state: 'unknown', reason: 'battery_unreadable' },
  thermal: { state: 'unknown', reason: 'no_portable_source' },
};

test('admission is deterministic: concurrency, then storage, then battery', () => {
  const lowEverything: NodeResourceSignals = {
    storage: { state: 'known', freeBytes: 100 * MB },
    battery: { state: 'known', percent: 5, charging: false },
    thermal: { state: 'unknown', reason: 'no_portable_source' },
  };
  assert.equal(evaluateResourceAdmission(policy, 1, lowEverything).refusal, 'RESOURCE_CONCURRENCY_LIMIT');
  assert.equal(evaluateResourceAdmission(policy, 0, lowEverything).refusal, 'RESOURCE_STORAGE_LOW');
  assert.equal(evaluateResourceAdmission(policy, 0, { ...lowEverything, storage: { state: 'known', freeBytes: 4096 * MB } }).refusal, 'RESOURCE_BATTERY_LOW');
  assert.equal(
    evaluateResourceAdmission(policy, 0, { ...lowEverything, storage: { state: 'known', freeBytes: 4096 * MB }, battery: { state: 'known', percent: 5, charging: true } }).refusal,
    null,
    'a charging device is not refused for its battery level',
  );
  assert.equal(evaluateResourceAdmission({ ...policy, minFreeStorageBytes: 0, minBatteryPercent: null }, 0, lowEverything).refusal, null, 'floors can be turned off');
});

test('unknown signals never block and are reported as unknown, never as healthy', () => {
  assert.deepEqual(evaluateResourceAdmission(policy, 0, unknownSignals), { admission: 'accepting', restriction: null, refusal: null });
  assert.deepEqual(buildResourceReport(policy, 0, unknownSignals), {
    admission: 'accepting',
    restriction: null,
    activeRuns: 0,
    maxConcurrentRuns: 1,
    storage: { state: 'unknown', reason: 'storage_unreadable' },
    battery: { state: 'unknown', reason: 'battery_unreadable' },
    thermal: { state: 'unknown', reason: 'no_portable_source' },
  });
  assert.deepEqual(
    buildResourceReport(policy, 1, { ...unknownSignals, storage: { state: 'known', freeBytes: 1000 * MB } }).storage,
    { state: 'known', freeBytes: 1000 * MB, minFreeBytes: 512 * MB },
  );
  assert.equal(buildResourceReport(policy, 1, unknownSignals).admission, 'at_capacity');
});

test('signals come from portable sources; a denied or absent battery reads as unknown', async () => {
  const sysfs: Record<string, string> = {
    '/sys/class/power_supply/AC/type': 'Mains\n',
    '/sys/class/power_supply/battery/type': 'Battery\n',
    '/sys/class/power_supply/battery/capacity': '64\n',
    '/sys/class/power_supply/battery/status': 'Discharging\n',
  };
  const known = await readNodeResourceSignals('/workspaces', {
    platform: 'linux',
    statfs: async () => ({ bavail: 1000n, bsize: 4096n }),
    readdir: async () => ['AC', 'battery'],
    readFile: async (file) => {
      if (!(file in sysfs)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return sysfs[file];
    },
  });
  assert.deepEqual(known, {
    storage: { state: 'known', freeBytes: 4_096_000 },
    battery: { state: 'known', percent: 64, charging: false },
    thermal: { state: 'unknown', reason: 'no_portable_source' },
  });

  const android = await readNodeResourceSignals('/workspaces', {
    platform: 'linux',
    statfs: async () => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    },
    readdir: async () => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    },
  });
  assert.deepEqual(android.storage, { state: 'unknown', reason: 'storage_unreadable' });
  assert.deepEqual(android.battery, { state: 'unknown', reason: 'battery_unreadable' });

  const desktop = await readNodeResourceSignals('/workspaces', { platform: 'win32', statfs: async () => ({ bavail: 1, bsize: 1 }) });
  assert.deepEqual(desktop.battery, { state: 'unknown', reason: 'no_portable_source' });

  const noBattery = await readNodeResourceSignals('/workspaces', { platform: 'linux', statfs: async () => ({ bavail: 1, bsize: 1 }), readdir: async () => [], readFile: async () => '' });
  assert.deepEqual(noBattery.battery, { state: 'unknown', reason: 'no_battery_reported' });
});

test('governor flags are validated, never clamped silently', () => {
  assert.deepEqual(parseResourcePolicyFlags({}), { ok: true, policy: { maxConcurrentRuns: 2, minFreeStorageBytes: 512 * MB, minBatteryPercent: null } });
  assert.deepEqual(
    parseResourcePolicyFlags({ 'max-concurrent-runs': '1', 'min-free-storage-mb': '0', 'min-battery-percent': '25' }),
    { ok: true, policy: { maxConcurrentRuns: 1, minFreeStorageBytes: 0, minBatteryPercent: 25 } },
  );
  assert.equal(parseResourcePolicyFlags({ 'min-battery-percent': '0' }).ok && (parseResourcePolicyFlags({ 'min-battery-percent': '0' }) as { policy: ResourceGovernorPolicy }).policy.minBatteryPercent, null);
  for (const flags of [{ 'max-concurrent-runs': '0' }, { 'max-concurrent-runs': '17' }, { 'max-concurrent-runs': '1.5' }, { 'min-free-storage-mb': '-1' }, { 'min-battery-percent': '101' }, { 'max-concurrent-runs': true }]) {
    assert.equal(parseResourcePolicyFlags(flags as never).ok, false, JSON.stringify(flags));
  }
});
