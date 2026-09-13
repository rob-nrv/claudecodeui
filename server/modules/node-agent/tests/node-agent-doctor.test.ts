// `cloudcli node doctor` (FT-M09-R1). The real evidence primitives run with an
// injected command runner, signals and fetch: no real Claude CLI, no login, no
// network, and nothing outside temporary folders.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { writeNodeAgentCredential } from '@/modules/node-agent/node-agent-credential.store.js';
import type { NodeDoctorDependencies, NodeDoctorReport } from '@/modules/node-agent/node-agent-doctor.js';
import type { NodeResourceSignals } from '@/modules/node-agent/node-agent-resource-governor.js';
import { runNodeAgentCli } from '@/modules/node-agent/node-agent.command.js';
import { probeLocalRuntimeCapabilities } from '@/modules/runtime-nodes/index.js';

const NOW = Date.UTC(2026, 8, 13, 20, 0, 0);
const ACCOUNT_EMAIL = 'robin@example.com';
const LOGGED_IN = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: ACCOUNT_EMAIL, orgName: 'Private Org' });
const LOGGED_OUT = JSON.stringify({ loggedIn: false });
const SIGNALS: NodeResourceSignals = {
  storage: { state: 'known', freeBytes: 20 * 1024 ** 3 },
  battery: { state: 'unknown', reason: 'battery_unreadable' },
  thermal: { state: 'unknown', reason: 'no_portable_source' },
};

type Harness = {
  directory: string;
  stateDir: string;
  workspaceRoot: string;
  privateKeyPem: string;
};

async function withNode(runTest: (harness: Harness) => Promise<void>, options: { enrolled?: boolean } = {}): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'node-doctor-'));
  const stateDir = path.join(directory, 'state');
  const workspaceRoot = path.join(directory, 'workspaces');
  await mkdir(workspaceRoot, { recursive: true });
  const privateKeyPem = '-----BEGIN PRIVATE KEY-----\nnot-a-real-key-but-never-printed\n-----END PRIVATE KEY-----\n';
  if (options.enrolled !== false) {
    await writeNodeAgentCredential(stateDir, {
      version: 1,
      serverOrigin: 'https://cloudcli.example.lan:3443',
      nodeId: 'pixel-hc06-node',
      privateKeyPem,
      publicKeyPem: '-----BEGIN PUBLIC KEY-----\npublic\n-----END PUBLIC KEY-----\n',
      enrolledAt: '2026-09-13T18:00:00.000Z',
    });
    await writeFile(path.join(stateDir, 'run-journal.json'), JSON.stringify({
      version: 1,
      lastCompletedAt: NOW - 2 * 3_600_000,
      entries: [
        { executionId: randomUUID(), appSessionId: 'session-a', startedAt: NOW - 3 * 3_600_000, finishedAt: NOW - 2 * 3_600_000, outcome: 'completed' },
        { executionId: randomUUID(), appSessionId: 'session-b', startedAt: NOW - 3_600_000, finishedAt: NOW - 3_000_000, outcome: 'interrupted' },
      ],
    }));
  } else {
    await mkdir(stateDir, { recursive: true });
  }
  try {
    await runTest({ directory, stateDir, workspaceRoot, privateKeyPem });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function doctorDependencies(overrides: { authStatus?: string; fetchCalls?: Array<{ url: string; init: RequestInit | undefined }>; fetchImpl?: typeof fetch } = {}): NodeDoctorDependencies {
  const calls = overrides.fetchCalls ?? [];
  return {
    now: () => NOW,
    platform: 'linux',
    arch: 'aarch64',
    nodeVersion: 'v22.12.0',
    environment: { ANDROID_ROOT: '/system', ANDROID_DATA: '/data' },
    readSignals: async () => SIGNALS,
    fetch: overrides.fetchImpl ?? (async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response('{"status":"ok"}', { status: 200 });
    }),
    // The real probe, with every external command answered locally.
    probe: (options) => probeLocalRuntimeCapabilities({
      ...options,
      now: () => NOW,
      platform: 'linux',
      arch: 'arm64',
      nodeVersion: '22.12.0',
      environment: {},
      fileExists: async () => false,
      resolveClaudeExecutable: () => 'claude-binary',
      runCommand: async (file, args) => {
        const key = `${file} ${args.join(' ')}`;
        if (key === 'claude-binary --version') return '2.1.220 (Claude Code)\n';
        if (key === 'claude-binary auth status') return overrides.authStatus ?? LOGGED_IN;
        if (key === 'git --version') return 'git version 2.45.0\n';
        throw Object.assign(new Error(`unexpected ${key}`), { code: 'ENOENT' });
      },
    }),
  };
}

async function runDoctor(harness: Harness, argumentsList: string[], doctor: NodeDoctorDependencies) {
  const logs: string[] = [];
  const errors: string[] = [];
  const environment: Record<string, string | undefined> = {};
  const code = await runNodeAgentCli(['doctor', '--state-dir', harness.stateDir, '--workspace-root', harness.workspaceRoot, ...argumentsList], {
    environment,
    homeDirectory: harness.directory,
    runtimeVersion: '1.37.2',
    log: (message) => logs.push(message),
    error: (message) => errors.push(message),
    doctor,
  });
  return { code, logs, errors, environment, output: logs.join('\n') };
}

test('doctor --json states what this node can prove, from the same evidence rules, with nothing secret in it', async () => {
  await withNode(async (harness) => {
    const fetchCalls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const { code, output, environment } = await runDoctor(harness, ['--json', '--max-concurrent-runs', '1'], doctorDependencies({ fetchCalls }));
    const report = JSON.parse(output) as NodeDoctorReport;

    assert.equal(code, 0);
    assert.deepEqual([report.schema, report.version], ['cloudcli.node-doctor', 1]);
    assert.deepEqual(report.runtime, { cloudcliVersion: '1.37.2', linkProtocolVersion: 1, nodeVersion: '22.12.0', platform: 'linux', arch: 'arm64', androidHost: true });
    assert.deepEqual(
      [report.enrollment.state, report.enrollment.nodeId, report.enrollment.serverOrigin],
      ['enrolled', 'pixel-hc06-node', 'https://cloudcli.example.lan:3443'],
    );
    assert.equal(report.stateDirectory.state, 'ok');
    assert.equal(report.workspaceRoot.state, 'ok');
    assert.deepEqual(
      Object.fromEntries(report.capabilities.map((capability) => [capability.id, capability.status])),
      {
        'node-runtime': 'proven',
        'claude-cli': 'proven',
        'claude-auth': 'proven',
        'claude-headless': 'proven',
        'git-cli': 'proven',
        'workspace-filesystem': 'proven',
        'background-execution': 'needs_device_check',
      },
    );
    assert.equal(report.capabilities.find((capability) => capability.id === 'workspace-filesystem')?.detail, 'readable and write verified');
    assert.equal(report.capabilities.find((capability) => capability.id === 'background-execution')?.detail, null, 'a one-shot check claims no suspension observation');
    assert.deepEqual(report.governor, { maxConcurrentRuns: 1, minFreeStorageBytes: 512 * 1024 * 1024, minBatteryPercent: null });
    assert.equal(report.resourcesWhenIdle.admission, 'accepting');
    assert.deepEqual(report.resourcesWhenIdle.battery, { state: 'unknown', reason: 'battery_unreadable' });
    assert.deepEqual(report.journal, { state: 'ok', unfinished: 0, interrupted: 1, lastCompletedAt: new Date(NOW - 2 * 3_600_000).toISOString() });
    assert.deepEqual(report.controlPlane, { state: 'reachable', httpStatus: 200, reason: null });
    assert.deepEqual(report.summary, { readyForRuns: true, blockers: [], needsDeviceCheck: ['background-execution'] });

    assert.deepEqual(fetchCalls.map((call) => call.url), ['https://cloudcli.example.lan:3443/health']);
    assert.equal(JSON.stringify(fetchCalls[0].init?.headers ?? {}).toLowerCase().includes('authorization'), false, 'no credential is sent');
    for (const secret of [ACCOUNT_EMAIL, 'Private Org', 'PRIVATE KEY', 'not-a-real-key', 'ANDROID_DATA', '/data']) {
      assert.equal(output.includes(secret), false, `leaked ${secret}`);
    }
    assert.equal(await access(path.join(harness.stateDir, 'agent.db')).then(() => true, () => false), false, 'doctor opens no database');
    assert.equal(environment.DATABASE_PATH, path.join(harness.stateDir, 'agent.db'), 'any accidental database access would stay in the agent state');
    assert.deepEqual(await readdirNames(harness.workspaceRoot), [], 'the write probe leaves nothing behind');
  });
});

async function readdirNames(directory: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  return readdir(directory);
}

test('doctor names blockers and exits 2: signed-out Claude, invalid root, unreachable or untrusted control plane, corrupt journal', async () => {
  await withNode(async (harness) => {
    const signedOut = await runDoctor(harness, [], doctorDependencies({ authStatus: LOGGED_OUT }));
    assert.equal(signedOut.code, 2);
    assert.match(signedOut.output, /Claude login\s+Not available\s+not logged in/);
    assert.match(signedOut.output, /Background execution\s+Needs device check/);
    assert.match(signedOut.output, /Result:\s+NOT READY: claude not logged in/);

    const untrusted = await runDoctor(harness, ['--json'], doctorDependencies({
      fetchImpl: async () => {
        throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'SELF_SIGNED_CERT_IN_CHAIN' } });
      },
    }));
    const untrustedReport = JSON.parse(untrusted.output) as NodeDoctorReport;
    assert.deepEqual(untrustedReport.controlPlane, { state: 'tls_untrusted', httpStatus: null, reason: 'self_signed_cert_in_chain' });
    assert.deepEqual(untrustedReport.summary.blockers, ['control_plane_tls_untrusted']);

    const refused = await runDoctor(harness, ['--json'], doctorDependencies({
      fetchImpl: async () => {
        throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
      },
    }));
    assert.deepEqual((JSON.parse(refused.output) as NodeDoctorReport).controlPlane, { state: 'unreachable', httpStatus: null, reason: 'econnrefused' });

    const fetchCalls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const offline = await runDoctor(harness, ['--json', '--no-network'], doctorDependencies({ fetchCalls }));
    assert.equal((JSON.parse(offline.output) as NodeDoctorReport).controlPlane.state, 'skipped');
    assert.equal(fetchCalls.length, 0);

    await writeFile(path.join(harness.stateDir, 'run-journal.json'), '{ truncated');
    const corrupt = JSON.parse((await runDoctor(harness, ['--json', '--no-network'], doctorDependencies())).output) as NodeDoctorReport;
    assert.deepEqual(corrupt.journal, { state: 'unreadable', unfinished: null, interrupted: null, lastCompletedAt: null });
    assert.equal(corrupt.capabilities.find((capability) => capability.id === 'claude-headless')?.status, 'not_proven_yet', 'an unreadable journal proves no headless run');

    const rootInvalid = await runNodeAgentCli(['doctor', '--json', '--no-network', '--state-dir', harness.stateDir, '--workspace-root', path.parse(harness.directory).root], {
      environment: {},
      homeDirectory: harness.directory,
      runtimeVersion: '1.37.2',
      log: () => undefined,
      error: () => undefined,
      doctor: doctorDependencies(),
    });
    assert.equal(rootInvalid, 2);
  });
});

test('doctor on a machine that is not enrolled says so and checks no control plane', async () => {
  await withNode(async (harness) => {
    const fetchCalls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const result = await runDoctor(harness, ['--json'], doctorDependencies({ fetchCalls }));
    const report = JSON.parse(result.output) as NodeDoctorReport;
    assert.equal(result.code, 2);
    assert.deepEqual([report.enrollment.state, report.controlPlane.state], ['not_enrolled', 'not_enrolled']);
    assert.deepEqual(report.summary.blockers, ['not_enrolled']);
    assert.equal(report.journal.state, 'missing');
    assert.equal(fetchCalls.length, 0);
  }, { enrolled: false });
});

test('--output writes the evidence record to a new owner-only file and never overwrites one', async () => {
  await withNode(async (harness) => {
    const file = path.join(harness.directory, 'hc06-doctor.json');
    const first = await runDoctor(harness, ['--no-network', '--output', file], doctorDependencies());
    assert.equal(first.code, 0);
    assert.match(first.output, /Evidence record written to/);
    const record = JSON.parse(await readFile(file, 'utf8')) as NodeDoctorReport;
    assert.equal(record.schema, 'cloudcli.node-doctor');
    if (process.platform !== 'win32') {
      assert.equal((await stat(file)).mode & 0o777, 0o600);
    }

    const second = await runDoctor(harness, ['--no-network', '--output', file], doctorDependencies());
    assert.equal(second.code, 1);
    assert.match(second.errors.join('\n'), /already exists/);

    const usage = await runDoctor(harness, ['--output'], doctorDependencies());
    assert.equal(usage.code, 1);
    const invalidFlag = await runDoctor(harness, ['--max-concurrent-runs', '0'], doctorDependencies());
    assert.equal(invalidFlag.code, 1);
    const booleanWithValue = await runDoctor(harness, ['--json=yes'], doctorDependencies());
    assert.equal(booleanWithValue.code, 1);
  });
});
