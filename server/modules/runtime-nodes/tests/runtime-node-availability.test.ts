import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RUNTIME_NODE_FRESHNESS_MS,
  parseStoredRuntimeNodeCapabilities,
  resolveRuntimeNodeAvailability,
  toRuntimeNodeCapability,
} from '@/modules/runtime-nodes/runtime-node-availability.js';
import type { RuntimeNodeCapability, RuntimeNodeCapabilityId, RuntimeNodeCapabilityStatus } from '@/shared/types.js';

const NOW = Date.UTC(2026, 8, 13, 12, 0, 0);

const capability = (id: RuntimeNodeCapabilityId, status: RuntimeNodeCapabilityStatus): RuntimeNodeCapability => ({
  id,
  status,
  detail: null,
  reason: status === 'available' ? null : 'probe_failed',
  probedAt: status === 'unknown' ? null : NOW,
});

const allCapabilities = (claudeStatus: RuntimeNodeCapabilityStatus): RuntimeNodeCapability[] => [
  capability('claude-cli', claudeStatus),
  capability('git-cli', 'available'),
  capability('workspace-filesystem', 'available'),
  capability('background-execution', 'unknown'),
];

test('a proven probe becomes available with a short, path-free detail', () => {
  assert.deepEqual(
    toRuntimeNodeCapability('claude-cli', { outcome: 'proven', detail: '2.1.220 (Claude Code)\nsecond line' }, NOW),
    { id: 'claude-cli', status: 'available', detail: '2.1.220 (Claude Code)', reason: null, probedAt: NOW },
  );
  assert.equal(toRuntimeNodeCapability('git-cli', { outcome: 'proven', detail: '/usr/bin/git' }, NOW).detail, null);
  assert.equal(toRuntimeNodeCapability('git-cli', { outcome: 'proven', detail: 'C:\\Git\\git.exe' }, NOW).detail, null);
});

test('failed, unsupported and not-probed outcomes stay distinct and none of them reads as available', () => {
  assert.deepEqual(
    toRuntimeNodeCapability('claude-cli', { outcome: 'failed', reason: 'executable_not_found' }, NOW),
    { id: 'claude-cli', status: 'unavailable', detail: null, reason: 'executable_not_found', probedAt: NOW },
  );
  assert.deepEqual(
    toRuntimeNodeCapability('background-execution', { outcome: 'not_supported', reason: 'no_background_service' }, NOW),
    { id: 'background-execution', status: 'unsupported', detail: null, reason: 'no_background_service', probedAt: NOW },
  );
  assert.deepEqual(
    toRuntimeNodeCapability('background-execution', { outcome: 'not_probed', reason: 'no_probe_available' }, NOW),
    { id: 'background-execution', status: 'unknown', detail: null, reason: 'no_probe_available', probedAt: null },
  );
});

test('a node that was never probed is unknown, never available', () => {
  assert.deepEqual(
    resolveRuntimeNodeAvailability({ lastSeenAt: null, capabilities: allCapabilities('available'), now: NOW }),
    { state: 'unknown', reason: 'never_probed', lastSeenAt: null, freshUntil: null },
  );
});

test('a fresh probe that proved the Claude CLI is available', () => {
  const availability = resolveRuntimeNodeAvailability({
    lastSeenAt: NOW - 1_000,
    capabilities: allCapabilities('available'),
    now: NOW,
  });
  assert.equal(availability.state, 'available');
  assert.equal(availability.reason, 'fresh_probe');
  assert.equal(availability.lastSeenAt, new Date(NOW - 1_000).toISOString());
  assert.equal(availability.freshUntil, new Date(NOW - 1_000 + RUNTIME_NODE_FRESHNESS_MS).toISOString());
});

test('a fresh probe without a proven execution capability is degraded, whether Claude failed or is unknown', () => {
  for (const claudeStatus of ['unavailable', 'unsupported', 'unknown'] as const) {
    const availability = resolveRuntimeNodeAvailability({
      lastSeenAt: NOW,
      capabilities: allCapabilities(claudeStatus),
      now: NOW,
    });
    assert.equal(availability.state, 'degraded', claudeStatus);
    assert.equal(availability.reason, 'no_execution_capability');
  }
});

test('evidence older than the freshness window is unavailable, even if it once proved everything', () => {
  const availability = resolveRuntimeNodeAvailability({
    lastSeenAt: NOW - RUNTIME_NODE_FRESHNESS_MS - 1,
    capabilities: allCapabilities('available'),
    now: NOW,
  });
  assert.equal(availability.state, 'unavailable');
  assert.equal(availability.reason, 'probe_stale');
});

test('a probe time far in the future is not trusted as fresh', () => {
  const availability = resolveRuntimeNodeAvailability({
    lastSeenAt: NOW + 10 * 60_000,
    capabilities: allCapabilities('available'),
    now: NOW,
  });
  assert.equal(availability.state, 'unavailable');
});

test('stored capabilities round-trip a real probe result', () => {
  const probed = allCapabilities('available');
  assert.deepEqual(parseStoredRuntimeNodeCapabilities(JSON.stringify(probed)), probed);
});

test('stored capabilities are untrusted: malformed data, unknown ids and unstamped claims all collapse to unknown', () => {
  const unknownEverywhere = ['claude-cli', 'git-cli', 'workspace-filesystem', 'background-execution'].map((id) => ({
    id,
    status: 'unknown',
    detail: null,
    reason: 'not_recorded',
    probedAt: null,
  }));

  assert.deepEqual(parseStoredRuntimeNodeCapabilities(null), unknownEverywhere);
  assert.deepEqual(parseStoredRuntimeNodeCapabilities('{not json'), unknownEverywhere);
  assert.deepEqual(parseStoredRuntimeNodeCapabilities(JSON.stringify({ 'claude-cli': 'available' })), unknownEverywhere);

  const spoofed = parseStoredRuntimeNodeCapabilities(JSON.stringify([
    // "available" with no probe time is a claim, not evidence.
    { id: 'claude-cli', status: 'available', detail: '9.9.9' },
    { id: 'git-cli', status: 'totally-available', probedAt: NOW },
    { id: 'root-access', status: 'available', probedAt: NOW },
  ]));
  assert.deepEqual(spoofed, unknownEverywhere);
});
