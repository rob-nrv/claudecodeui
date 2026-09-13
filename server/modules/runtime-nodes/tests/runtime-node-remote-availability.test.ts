import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseRemoteProbeOutcomes,
  resolveRemoteRuntimeNodeAvailability,
  toRuntimeNodeCapability,
} from '@/modules/runtime-nodes/runtime-node-availability.js';
import { planCapabilityCheck } from '@/modules/runtime-nodes/runtime-node-verification.js';
import type { RuntimeNodeCapability, RuntimeNodeView } from '@/shared/types.js';

const NOW = Date.UTC(2026, 8, 13, 12);
const CONNECTED_AT = NOW - 30_000;

const claude = (probedAt: number, status: RuntimeNodeCapability['status'] = 'available'): RuntimeNodeCapability =>
  ({ id: 'claude-cli', status, detail: null, reason: status === 'available' ? null : 'probe_failed', probedAt });

const link = (overrides: Partial<{ connectedAt: number; lastFrameAt: number; protocolCompatible: boolean }> = {}) =>
  ({ connectedAt: CONNECTED_AT, lastFrameAt: NOW - 5_000, protocolCompatible: true, ...overrides });

const availability = (input: Partial<Parameters<typeof resolveRemoteRuntimeNodeAvailability>[0]>) =>
  resolveRemoteRuntimeNodeAvailability({
    enrollment: 'active',
    link: link(),
    identityConflict: false,
    lastSeenAt: NOW - 5_000,
    capabilities: [claude(CONNECTED_AT + 1_000)],
    now: NOW,
    ...input,
  });

test('a remote node is available only with a live, compatible link and Claude proven on THIS connection', () => {
  assert.deepEqual([availability({}).state, availability({}).reason], ['available', 'link_connected']);

  const provenBeforeReconnect = availability({ capabilities: [claude(CONNECTED_AT - 1)] });
  assert.deepEqual([provenBeforeReconnect.state, provenBeforeReconnect.reason], ['degraded', 'probe_pending']);

  const failedProbe = availability({ capabilities: [claude(CONNECTED_AT + 1, 'unavailable')] });
  assert.deepEqual([failedProbe.state, failedProbe.reason], ['degraded', 'no_execution_capability']);
});

test('offline, stale, conflicting, incompatible, revoked and unenrolled nodes never read as available', () => {
  const cases: Array<[Partial<Parameters<typeof resolveRemoteRuntimeNodeAvailability>[0]>, string, string]> = [
    [{ link: null, lastSeenAt: null }, 'unknown', 'never_connected'],
    [{ link: null }, 'unavailable', 'link_offline'],
    [{ link: link({ lastFrameAt: NOW - 60_001 }) }, 'unavailable', 'link_stale'],
    [{ identityConflict: true }, 'degraded', 'identity_conflict'],
    [{ link: link({ protocolCompatible: false }) }, 'degraded', 'protocol_incompatible'],
    [{ enrollment: 'revoked' }, 'unavailable', 'revoked'],
    [{ enrollment: 'unenrolled' }, 'unknown', 'never_connected'],
  ];
  for (const [input, state, reason] of cases) {
    const result = availability(input);
    assert.deepEqual([result.state, result.reason], [state, reason], JSON.stringify(input));
  }
});

test('a node probe answer cannot add capabilities, skip sanitization or smuggle paths', () => {
  const outcomes = parseRemoteProbeOutcomes({
    'claude-cli': { outcome: 'proven', detail: '/usr/local/bin/claude 2.1.220' },
    'git-cli': { outcome: 'definitely', detail: 'git 2.45' },
    'workspace-filesystem': 'yes',
    'root-shell': { outcome: 'proven' },
    __proto__: { outcome: 'proven' },
  });
  assert.deepEqual(Object.keys(outcomes).sort(), [
    'background-execution',
    'claude-auth',
    'claude-cli',
    'claude-headless',
    'git-cli',
    'node-runtime',
    'workspace-filesystem',
  ]);
  assert.equal(outcomes['git-cli'].outcome, 'not_probed');
  assert.equal(outcomes['workspace-filesystem'].outcome, 'not_probed');
  assert.equal(outcomes['background-execution'].outcome, 'not_probed');
  const capability = toRuntimeNodeCapability('claude-cli', outcomes['claude-cli'], NOW);
  assert.equal(capability.status, 'available');
  assert.equal(capability.detail, null, 'a path-like detail is dropped');
  assert.equal(parseRemoteProbeOutcomes(null)['claude-cli'].outcome, 'not_probed');
});

function node(nodeId: string, available: boolean, proven: RuntimeNodeCapability['id'][], freshness: 'fresh' | 'stale' = 'fresh'): RuntimeNodeView {
  return {
    nodeId,
    label: nodeId.toUpperCase(),
    isLocal: nodeId === 'pc',
    canExecute: available,
    platform: null,
    arch: null,
    runtimeVersion: null,
    availability: { state: available ? 'available' : 'unavailable', reason: available ? 'link_connected' : 'link_offline', lastSeenAt: null, freshUntil: null },
    capabilities: proven.map((id) => ({ id, status: 'available', detail: null, reason: null, probedAt: NOW, verification: 'probe', freshness })),
    resources: null,
    evidence: nodeId === 'pc' ? 'local_probe' : 'node_probe',
    enrollment: nodeId === 'pc' ? 'local' : 'active',
  };
}

test('only fresh evidence verifies: a stale proof and a device-only capability both need something else', () => {
  const nodes = [node('pc', true, ['claude-cli']), node('nas', true, ['git-cli'], 'stale')];
  const stale = planCapabilityCheck({ required: ['git-cli'], currentNodeId: 'pc', nodes });
  assert.equal(stale.disposition, 'human_check', 'a stale "available" is not proof on any node');
  assert.deepEqual(stale.candidates, []);

  const background = planCapabilityCheck({ required: ['background-execution'], currentNodeId: 'pc', nodes });
  assert.deepEqual(background.requiresDeviceCheck, ['background-execution']);
  assert.equal(background.requiresExplicitAuthorization, false);
});

test('verification planning separates here, another runtime (explicit authorization) and human checks', () => {
  const nodes = [node('pc', true, ['claude-cli']), node('nas', true, ['claude-cli', 'git-cli']), node('laptop', false, ['git-cli'])];

  const here = planCapabilityCheck({ required: ['claude-cli'], currentNodeId: 'pc', nodes });
  assert.equal(here.disposition, 'here');
  assert.equal(here.requiresExplicitAuthorization, false);

  const elsewhere = planCapabilityCheck({ required: ['git-cli'], currentNodeId: 'pc', nodes });
  assert.equal(elsewhere.disposition, 'another_runtime');
  assert.deepEqual(elsewhere.candidates, [{ nodeId: 'nas', label: 'NAS' }], 'the offline laptop is never suggested');
  assert.deepEqual(elsewhere.missingHere, ['git-cli']);
  assert.equal(elsewhere.requiresExplicitAuthorization, true);

  const human = planCapabilityCheck({ required: ['background-execution'], currentNodeId: 'pc', nodes });
  assert.equal(human.disposition, 'human_check');
  assert.deepEqual(human.candidates, []);
});
