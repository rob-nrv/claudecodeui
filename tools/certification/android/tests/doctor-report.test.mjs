import assert from 'node:assert/strict';
import test from 'node:test';

import {
  blockers,
  capabilityStatus,
  containsForbiddenField,
  controlPlaneState,
  diffCapabilities,
  governorPolicy,
  hasBlocker,
  isDoctorReport,
  isReadyForRuns,
  journalCounts,
} from '../lib/doctor-report.mjs';

function fixtureReport(overrides = {}) {
  return {
    schema: 'cloudcli.node-doctor',
    version: 1,
    generatedAt: '2026-09-14T10:00:00.000Z',
    runtime: { cloudcliVersion: '1.37.2', linkProtocolVersion: 1, nodeVersion: 'v22.23.2', platform: 'linux', arch: 'arm64', androidHost: true },
    enrollment: { state: 'enrolled', nodeId: 'pixel-hc06', serverOrigin: 'https://192.168.1.36:3443', enrolledAt: '2026-09-14T09:00:00.000Z', credentialFile: 'owner_only' },
    stateDirectory: { path: '/root/.cloudcli/node-agent-hc06', state: 'ok', permissions: 'owner_only' },
    workspaceRoot: { path: '/root/cloudcli-workspaces-hc06', state: 'ok', reason: null },
    capabilities: [
      { id: 'node-runtime', status: 'proven', reason: null, detail: null },
      { id: 'claude-cli', status: 'proven', reason: null, detail: null },
      { id: 'claude-auth', status: 'not_available', reason: 'not_logged_in', detail: null },
      { id: 'claude-headless', status: 'not_proven_yet', reason: null, detail: null },
      { id: 'git-cli', status: 'proven', reason: null, detail: null },
      { id: 'workspace-filesystem', status: 'proven', reason: null, detail: null },
      { id: 'background-execution', status: 'needs_device_check', reason: null, detail: null },
    ],
    governor: { maxConcurrentRuns: 1, minFreeStorageBytes: 512 * 1024 * 1024, minBatteryPercent: 0 },
    resourcesWhenIdle: { admission: 'allowed', restriction: null },
    journal: { state: 'ok', unfinished: 0, interrupted: 0, lastCompletedAt: null },
    controlPlane: { state: 'reachable', httpStatus: 200, reason: null },
    summary: { readyForRuns: false, blockers: ['claude_not_logged_in'], needsDeviceCheck: ['background-execution'] },
    ...overrides,
  };
}

test('isDoctorReport recognizes the real schema/version and rejects anything else', () => {
  assert.equal(isDoctorReport(fixtureReport()), true);
  assert.equal(isDoctorReport({ schema: 'cloudcli.node-doctor', version: 2 }), false);
  assert.equal(isDoctorReport(null), false);
  assert.equal(isDoctorReport('not an object'), false);
});

test('capabilityStatus reads a specific capability, null for one that is not present', () => {
  const report = fixtureReport();
  assert.equal(capabilityStatus(report, 'claude-auth'), 'not_available');
  assert.equal(capabilityStatus(report, 'claude-headless'), 'not_proven_yet');
  assert.equal(capabilityStatus(report, 'not-a-real-capability'), null);
});

test('isReadyForRuns and blockers reflect the summary exactly, matching the E1-enrolled fixture (signed out)', () => {
  const report = fixtureReport();
  assert.equal(isReadyForRuns(report), false);
  assert.deepEqual(blockers(report), ['claude_not_logged_in']);
  assert.equal(hasBlocker(report, 'claude_not_logged_in'), true);
  assert.equal(hasBlocker(report, 'resources_storage_low'), false);
});

test('a signed-in, ready report reads true with no blockers', () => {
  const report = fixtureReport({
    capabilities: fixtureReport().capabilities.map((entry) => (entry.id === 'claude-auth' ? { ...entry, status: 'proven', reason: null } : entry)),
    summary: { readyForRuns: true, blockers: [], needsDeviceCheck: ['background-execution'] },
  });
  assert.equal(isReadyForRuns(report), true);
  assert.deepEqual(blockers(report), []);
});

test('journalCounts normalizes an unreadable/missing journal to nulls instead of claiming 0', () => {
  assert.deepEqual(journalCounts(fixtureReport()), { state: 'ok', unfinished: 0, interrupted: 0 });
  const unreadable = fixtureReport({ journal: { state: 'unreadable', unfinished: null, interrupted: null, lastCompletedAt: null } });
  assert.deepEqual(journalCounts(unreadable), { state: 'unreadable', unfinished: null, interrupted: null });
});

test('controlPlaneState and governorPolicy read straight through', () => {
  assert.equal(controlPlaneState(fixtureReport()), 'reachable');
  assert.deepEqual(governorPolicy(fixtureReport()), { maxConcurrentRuns: 1, minFreeStorageBytes: 512 * 1024 * 1024, minBatteryPercent: 0 });
});

test('diffCapabilities pinpoints exactly the E1 -> E2 transition (Claude sign-in) and nothing else', () => {
  const before = fixtureReport();
  const after = fixtureReport({
    capabilities: before.capabilities.map((entry) => (entry.id === 'claude-auth' ? { ...entry, status: 'proven', reason: null } : entry)),
  });
  assert.deepEqual(diffCapabilities(before, after), [{ id: 'claude-auth', from: 'not_available', to: 'proven' }]);
  assert.deepEqual(diffCapabilities(before, before), [], 'no changes between identical reports');
});

test('all functions reject a non-report input rather than silently reading undefined', () => {
  assert.throws(() => capabilityStatus({}, 'claude-cli'), /not a cloudcli\.node-doctor/);
  assert.throws(() => isReadyForRuns(null), /not a cloudcli\.node-doctor/);
  assert.throws(() => diffCapabilities(fixtureReport(), {}), /not a cloudcli\.node-doctor/);
});

test('containsForbiddenField flags a key that looks like a secret, anywhere in the tree, without flagging the real report shape', () => {
  assert.equal(containsForbiddenField(fixtureReport()), null, 'the real report shape (incl. the benign enrollment.credentialFile permission label) carries none');
  assert.equal(containsForbiddenField({ ok: true, nested: { privateKey: 'x' } }), 'nested.privateKey');
  assert.equal(containsForbiddenField({ list: [{ token: 'abc' }] }), 'list.0.token');
  assert.equal(containsForbiddenField({ credentialFile: 'owner_only' }), null, 'a permission label, not a secret — must not false-positive on the real field name');
  assert.equal(containsForbiddenField({ credentialJson: '{}' }), 'credentialJson', 'but the actual credential contents would be flagged');
  assert.equal(containsForbiddenField('a plain string'), null);
  assert.equal(containsForbiddenField(42), null);
});
