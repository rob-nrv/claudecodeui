import assert from 'node:assert/strict';
import test from 'node:test';

import {
  describeRuntimeNodeStatus,
  resolveCreationTarget,
  type RuntimeNodeView,
  type RuntimeNodesListing,
} from './runtimeNodes';

const node = (overrides: Partial<RuntimeNodeView> = {}): RuntimeNodeView => ({
  nodeId: 'local-node',
  label: 'desk',
  isLocal: true,
  canExecute: true,
  platform: 'win32',
  arch: 'x64',
  runtimeVersion: '1.37.2',
  availability: { state: 'available', reason: 'fresh_probe', lastSeenAt: null, freshUntil: null },
  capabilities: [],
  ...overrides,
});

const listing = (nodes: RuntimeNodeView[]): RuntimeNodesListing => ({ localNodeId: 'local-node', nodes });

test('a new session is pre-targeted only when exactly one node can execute', () => {
  const local = node();
  assert.equal(resolveCreationTarget(null), null);
  assert.equal(resolveCreationTarget(listing([local])), local);
  // A known node that cannot execute from this server never becomes the target.
  assert.equal(resolveCreationTarget(listing([local, node({ nodeId: 'nas', isLocal: false, canExecute: false })])), local);
  assert.equal(resolveCreationTarget(listing([local, node({ nodeId: 'other', isLocal: false, canExecute: true })])), null);
  assert.equal(resolveCreationTarget(listing([node({ canExecute: false })])), null);
});

test('availability text follows backend truth and never upgrades a stale, degraded or unknown node', () => {
  assert.deepEqual(describeRuntimeNodeStatus(node()), { key: 'available', emphasis: 'positive' });
  assert.deepEqual(
    describeRuntimeNodeStatus(node({ availability: { state: 'degraded', reason: 'no_execution_capability', lastSeenAt: null, freshUntil: null } })),
    { key: 'claudeUnavailable', emphasis: 'warning' },
  );
  assert.deepEqual(
    describeRuntimeNodeStatus(node({ availability: { state: 'unavailable', reason: 'probe_stale', lastSeenAt: null, freshUntil: null } })),
    { key: 'notResponding', emphasis: 'warning' },
  );
  assert.deepEqual(
    describeRuntimeNodeStatus(node({ availability: { state: 'unknown', reason: 'never_probed', lastSeenAt: null, freshUntil: null } })),
    { key: 'unknown', emphasis: 'muted' },
  );
});
