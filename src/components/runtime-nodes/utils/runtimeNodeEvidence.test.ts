import assert from 'node:assert/strict';
import test from 'node:test';

import {
  describeCapabilityEvidence,
  describeResources,
  describeWorkspaceState,
  formatEvidenceReason,
  type ProjectWorkspaceState,
  type RuntimeNodeCapability,
  type RuntimeNodeResources,
} from './runtimeNodes';

const capability = (overrides: Partial<RuntimeNodeCapability>): RuntimeNodeCapability => ({
  id: 'claude-cli',
  status: 'available',
  detail: null,
  reason: null,
  probedAt: 1,
  verification: 'probe',
  freshness: 'fresh',
  ...overrides,
});

test('only fresh proof reads as proven; device checks and awaited runs are named, never shown as failures', () => {
  assert.equal(describeCapabilityEvidence(capability({})).key, 'proven');
  assert.deepEqual(describeCapabilityEvidence(capability({ freshness: 'stale' })), { key: 'staleProof', emphasis: 'warning' });
  assert.equal(describeCapabilityEvidence(capability({ status: 'unavailable', reason: 'not_logged_in' })).key, 'unavailable');
  assert.equal(describeCapabilityEvidence(capability({ id: 'background-execution', status: 'unknown', verification: 'device_check', probedAt: null })).key, 'deviceCheck');
  assert.equal(describeCapabilityEvidence(capability({ id: 'claude-headless', status: 'unknown', verification: 'observed_run', probedAt: null })).key, 'awaitingRun');
  assert.equal(describeCapabilityEvidence(capability({ status: 'unknown', verification: undefined, freshness: undefined })).key, 'unknown', 'an older server without evidence fields stays unknown');
  assert.equal(formatEvidenceReason('process_suspension_observed'), 'process suspension observed');
  assert.equal(formatEvidenceReason(null), null);
});

test('resource and workspace displays surface only states the node established', () => {
  const resources: RuntimeNodeResources = {
    admission: 'restricted',
    restriction: 'battery_low',
    activeRuns: 0,
    maxConcurrentRuns: 1,
    storage: { state: 'unknown', reason: 'storage_unreadable' },
    battery: { state: 'known', percent: 9, charging: false, minPercent: 20 },
    thermal: { state: 'unknown', reason: 'no_portable_source' },
    observedAt: '2026-09-13T12:00:00.000Z',
  };
  assert.deepEqual(describeResources(resources), { key: 'batteryLow', emphasis: 'warning' });
  assert.equal(describeResources({ ...resources, admission: 'at_capacity', restriction: null }).key, 'atCapacity');
  assert.equal(describeResources({ ...resources, admission: 'accepting', restriction: null }).key, 'accepting');

  const workspace = (state: ProjectWorkspaceState['state']): ProjectWorkspaceState =>
    ({ state, reason: null, identity: 'unknown', inspectedAt: null, git: null, changes: null, sync: null });
  assert.deepEqual(
    (['clean', 'dirty', 'identity_mismatch', 'diverged', 'missing', 'unavailable', 'unmapped', 'unknown'] as const).map((state) => describeWorkspaceState(workspace(state)).key),
    ['clean', 'dirty', 'identityMismatch', 'diverged', 'missing', 'unavailable', 'unmapped', 'unknown'],
  );
});
