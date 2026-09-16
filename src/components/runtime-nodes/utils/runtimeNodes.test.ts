import assert from 'node:assert/strict';
import test from 'node:test';

import {
  describeRuntimeNodeStatus,
  needsRuntimePicker,
  resolveCreationTarget,
  resolveRunTarget,
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

const remote = (overrides: Partial<RuntimeNodeView> = {}): RuntimeNodeView => node({
  nodeId: 'nas',
  label: 'NAS',
  isLocal: false,
  enrollment: 'active',
  evidence: 'node_probe',
  availability: { state: 'available', reason: 'link_connected', lastSeenAt: null, freshUntil: null },
  workspace: { state: 'mapped', reason: null, verifiedAt: null },
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

test('remote link states read as offline, checking, conflict or revoked — never available', () => {
  const status = (state: RuntimeNodeView['availability']['state'], reason: RuntimeNodeView['availability']['reason']) =>
    describeRuntimeNodeStatus(remote({ availability: { state, reason, lastSeenAt: null, freshUntil: null } })).key;
  assert.equal(status('unavailable', 'link_offline'), 'offline');
  assert.equal(status('unavailable', 'link_stale'), 'offline');
  assert.equal(status('degraded', 'probe_pending'), 'checking');
  assert.equal(status('degraded', 'identity_conflict'), 'conflict');
  assert.equal(status('degraded', 'protocol_incompatible'), 'incompatible');
  assert.equal(status('unavailable', 'revoked'), 'revoked');
  assert.equal(status('unknown', 'never_connected'), 'neverConnected');
});

test('one node stays lightweight; several nodes require a visible, explicit choice', () => {
  const local = node();
  assert.equal(needsRuntimePicker(listing([local])), false);
  assert.equal(needsRuntimePicker(listing([local, remote({ enrollment: 'revoked', canExecute: false })])), false, 'revoked nodes are never offered');
  assert.equal(needsRuntimePicker(listing([local, remote()])), true);

  assert.deepEqual(resolveRunTarget(listing([local]), null, 'claude'), { nodeId: 'local-node', node: local, isRemote: false, implied: true, blocked: null });
  assert.equal(resolveRunTarget(listing([local, remote()]), null, 'claude').blocked, 'choose_node');
  assert.equal(resolveRunTarget(null, null, 'claude').blocked, null, 'unknown listing: the server applies its own rule');

  const chosen = resolveRunTarget(listing([local, remote()]), 'nas', 'claude');
  assert.deepEqual([chosen.nodeId, chosen.isRemote, chosen.implied, chosen.blocked], ['nas', true, false, null]);
});

test('a chosen node that cannot run now blocks creation instead of falling through to another node', () => {
  const local = node();
  const offline = remote({ canExecute: false, availability: { state: 'unavailable', reason: 'link_offline', lastSeenAt: null, freshUntil: null } });
  const blocked = resolveRunTarget(listing([local, offline]), 'nas', 'claude');
  assert.deepEqual([blocked.nodeId, blocked.blocked], ['nas', 'node_unavailable'], 'the local node is never substituted');

  assert.equal(resolveRunTarget(listing([local, remote()]), 'gone', 'claude').blocked, 'node_missing');
  assert.equal(resolveRunTarget(listing([local, remote()]), 'nas', 'codex').blocked, 'provider_unsupported');
  assert.equal(resolveRunTarget(listing([local, remote({ workspace: { state: 'unmapped', reason: null, verifiedAt: null } })]), 'nas', 'claude').blocked, 'workspace_unmapped');
  assert.equal(resolveRunTarget(listing([local, remote({ workspace: { state: 'unavailable', reason: 'rejected_by_node', verifiedAt: null } })]), 'nas', 'claude').blocked, 'workspace_unavailable');
});

test('hosted relay listing: no local node, nothing implied beyond real nodes, and an empty fleet says so', () => {
  const relayListing = (nodes: RuntimeNodeView[]): RuntimeNodesListing => ({ localNodeId: null, nodes });
  const offline = remote({ canExecute: false, availability: { state: 'unavailable', reason: 'link_offline', lastSeenAt: null, freshUntil: null } });

  assert.deepEqual(resolveRunTarget(relayListing([]), null, 'claude'), { nodeId: null, node: null, isRemote: false, implied: false, blocked: 'no_node' });
  const onlyOffline = resolveRunTarget(relayListing([offline]), null, 'claude');
  assert.deepEqual([onlyOffline.nodeId, onlyOffline.isRemote, onlyOffline.blocked], ['nas', true, 'node_unavailable'], 'the one node reads with its real state');
  const online = resolveRunTarget(relayListing([remote()]), null, 'claude');
  assert.deepEqual([online.nodeId, online.isRemote, online.implied, online.blocked], ['nas', true, true, null], 'sent explicitly to the server');
  assert.equal(resolveRunTarget(relayListing([remote(), remote({ nodeId: 'pixel' })]), null, 'claude').blocked, 'choose_node');
  assert.equal(resolveRunTarget(relayListing([remote({ enrollment: 'revoked', canExecute: false })]), null, 'claude').blocked, 'no_node', 'revoked nodes are gone');
});
