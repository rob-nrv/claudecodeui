#!/usr/bin/env node
// The Windows/control-plane side of the HC-06 Android RuntimeNode
// certification harness. Talks to CloudCLI only through its EXISTING
// authenticated REST/WebSocket surface (see lib/control-plane-client.mjs) —
// the same routes and frames the browser itself uses. No new server
// endpoint, no direct database access, no auth bypass.
//
// Usage:
//   node tools/certification/android/control-plane-runner.mjs <command> [options]
//
// Commands:
//   import-manual-evidence   Seed the classification store with the HC-06
//                            results already obtained by hand (section 3 of
//                            the mission) — imported, never re-labeled.
//   status                   Print the current certification status.
//   test-offline             Section 14: no-silent-failover. Guided — you
//                            confirm the device agent is stopped first.
//   test-identity            Section 15: repository-identity mismatch on
//                            workspace mapping. Guided — you create the
//                            throwaway mismatched repo on the device first.
//   test-reconnect NAME MS   Dispatches a long countdown to the node and
//                            waits through a human action (e.g. airplane
//                            mode) with the given banner/duration; classifies
//                            the observable result automatically.
//   certify                  Runs every automatable control-plane-side test
//                            in order, pausing at each human/device
//                            checkpoint.
//
// Required environment (never pass secrets as CLI arguments — they end up
// in shell history):
//   CLOUDCLI_BASE_URL         e.g. https://192.168.1.36:3443
//   CLOUDCLI_USERNAME         the operator's own CloudCLI login
//   CLOUDCLI_PASSWORD         the operator's own CloudCLI login
//   HC06_PROJECT_ID           the project id both nodes map (control plane's own project identity)
//   HC06_PROJECT_PATH         the project's path AS THE CONTROL PLANE knows it (for session creation)
//   HC06_NODE_LABEL           default "Pixel HC-06"
import readline from 'node:readline/promises';
import { WebSocket } from 'ws';

import {
  classifyRunOutcome,
  containsSdkToolDenialWording,
} from './lib/chat-frame-classifier.mjs';
import {
  createResultStore,
  importResult,
  overallStatus,
  recordResult,
  summarize,
} from './lib/classification.mjs';
import {
  createSession,
  findNodeByLabel,
  getWorkspaceState,
  listNodes,
  login,
  mapWorkspace,
} from './lib/control-plane-client.mjs';
import { appendManifestEntry, readManifest, resolveCertificationDir, writeEvidenceFile } from './lib/evidence.mjs';
import { formatHumanActionBanner, runHumanCheckpoint } from './lib/human-checkpoint.mjs';
import { runWithRestore } from './lib/with-restore.mjs';

const REQUIRED_COMMIT = 'a31c3765';

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}. See the header of control-plane-runner.mjs.`);
  }
  return value;
}

/** Only what evidence-only commands (import, status) need — never requires live-server credentials. */
function evidenceConfig() {
  return {
    evidenceDir: process.env.HC06_EVIDENCE_DIR ?? new URL('./evidence', import.meta.url).pathname,
  };
}

/** Full config for anything that actually talks to the control plane. */
function config() {
  return {
    ...evidenceConfig(),
    baseUrl: requireEnv('CLOUDCLI_BASE_URL').replace(/\/$/, ''),
    username: requireEnv('CLOUDCLI_USERNAME'),
    password: requireEnv('CLOUDCLI_PASSWORD'),
    projectId: requireEnv('HC06_PROJECT_ID'),
    projectPath: requireEnv('HC06_PROJECT_PATH'),
    label: process.env.HC06_NODE_LABEL ?? 'Pixel HC-06',
  };
}

async function connect() {
  const cfg = config();
  const token = await login(cfg.baseUrl, cfg.username, cfg.password);
  const listing = await listNodes(cfg.baseUrl, token);
  const node = findNodeByLabel(listing, cfg.label);
  if (!node) {
    throw new Error(`No runtime node is labeled "${cfg.label}". Check HC06_NODE_LABEL and that the Pixel has enrolled.`);
  }
  return { cfg, token, node };
}

async function loadStore(evidenceDir) {
  const manifest = await readManifest(evidenceDir);
  const store = createResultStore();
  for (const entry of manifest.entries) {
    if (entry.kind !== 'classification') continue;
    if (entry.source === 'manual-import') {
      importResult(store, entry, { supersede: true });
    } else {
      recordResult(store, entry);
    }
  }
  return store;
}

async function saveResult(evidenceDir, entry) {
  await appendManifestEntry(evidenceDir, { kind: 'classification', ...entry });
}

function printSummary(store) {
  console.log(`\nOverall: ${overallStatus(store)}\n`);
  for (const row of summarize(store)) {
    console.log(`  [${row.status.padEnd(11)}] ${row.id} — ${row.name}${row.source === 'manual-import' ? ' (imported)' : ''}`);
    if (row.notes) console.log(`               ${row.notes}`);
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// Chat socket: a thin real-WebSocket wrapper. The actual classification
// logic lives in lib/chat-frame-classifier.mjs and is unit-tested there;
// this just accumulates frames for a real connection.
// ---------------------------------------------------------------------------
function openChat(baseUrl, token) {
  const wsUrl = `${baseUrl.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(token)}`;
  const socket = new WebSocket(wsUrl, { rejectUnauthorized: !process.env.HC06_ALLOW_SELF_SIGNED });
  const frames = [];
  socket.on('message', (raw) => {
    try {
      frames.push(JSON.parse(raw.toString()));
    } catch {
      // Non-JSON frame; ignored rather than crashing the harness.
    }
  });
  const ready = new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return {
    socket,
    frames,
    ready,
    send: (payload) => socket.send(JSON.stringify(payload)),
    close: () => socket.close(),
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdImportManualEvidence() {
  const cfg = evidenceConfig();
  const { dir } = await resolveCertificationDir(cfg.evidenceDir);
  // Section 3 of the HC06-RUNNER-R1 mission brief: real human/device
  // observations from the manual HC-06 run on 2026-09-14, before this
  // harness existed. Imported verbatim — never re-labeled by this script.
  // The pre-fix failure (real ~8-10s blip: local abort before reconnect,
  // SDK "user doesn't want to proceed" text shown) is history that led to
  // commit a31c3765, not an outstanding requirement — it is recorded to the
  // manifest as a plain note (see below) rather than as a classification
  // entry, so it can never drag the *current* overall status to FAILED.
  const imports = [
    { id: 'isolated-setup', name: 'Isolated, reproducible setup', status: 'VALIDATED', notes: 'Separate proot cloudcli-hc06; Node 22 Linux aarch64 binary, not Termux Node; build:server succeeded.' },
    { id: 'evidence-e0', name: 'E0 evidence before enrollment', status: 'VALIDATED', notes: 'doctor: Node/Claude CLI/Git/Workspace proven; login/headless/background not yet; exit 2 as expected.' },
    { id: 'enrollment', name: 'Enrollment (E1)', status: 'VALIDATED', notes: 'Enrolled independently of HC-05; credential owner-only; control plane reachable; Available; HC-05 untouched.' },
    { id: 'claude-login', name: 'Claude login (E2)', status: 'VALIDATED', notes: 'doctor: Claude login Proven, READY FOR RUNS, exit 0.' },
    { id: 'headless-run', name: 'Real headless execution (E3)', status: 'VALIDATED', notes: '`uname -m && pwd` returned aarch64 and the mapped workspace path; doctor then showed Headless run Proven.' },
    { id: 'workspace-state', name: 'Workspace-state inspection', status: 'VALIDATED', notes: 'PASS with a procedural deviation: this repo had no tracked README.md, so a temporary one was created to prove the dirty-state transition, then removed. `git checkout README.md` is NOT reliable in this repo — do not rely on it for the undo step.' },
    { id: 'reconnect-short', name: 'Short reconnect (after a31c3765)', status: 'VALIDATED', notes: 'Real Pixel retest after a31c3765: reconnected with no local abort, run completed, no duplicate output, no failover, no misleading text.' },
    { id: 'reconnect-long', name: 'Long disconnect fails explicitly', status: 'VALIDATED', notes: '~70s airplane mode: browser showed the exact "Lost the connection... not moved to another node" message. No hang, no silent resume, no failover. A fresh same-session run after reconnect returned normally.' },
    { id: 'sigkill-journal', name: 'SIGKILL: interrupted-journal / no replay', status: 'VALIDATED', notes: 'After SIGKILL + restart: "1 run(s) were interrupted... not resumed or re-run"; E4 doctor: journal ok, 1 interrupted, READY FOR RUNS.' },
    { id: 'sigkill-cleanup', name: 'SIGKILL: orphan child cleanup', status: 'CONDITIONAL', notes: 'Real observed failure: node-agent process disappeared on SIGKILL, but the Claude child AND its Bash child both survived. User manually SIGTERMed the orphans. Automatic cleanup after SIGKILL is NOT validated — this is a genuine runtime limitation, not a test-harness gap.' },
    { id: 'governor-concurrency', name: 'Resource Governor: concurrency refusal', status: 'VALIDATED', notes: 'With --max-concurrent-runs 1 and one active run, a second session got exactly "already running as many sessions as it allows... not moved to another node." No queueing, no failover.' },
  ];
  for (const entry of imports) {
    await saveResult(dir, { ...entry, source: 'manual-import', observedAt: '2026-09-14' });
  }
  await appendManifestEntry(dir, {
    kind: 'history',
    note: 'Short reconnect FAILED on real Pixel hardware before commit a31c3765: an ~8-10s airplane-mode blip caused a local abort before reconnecting, and the browser showed the SDK\'s "user doesn\'t want to proceed" denial text instead of a network error. Fixed same day; see the "reconnect-short" (post-fix) result above and docs/android-runtime-node.md.',
    observedAt: '2026-09-14',
  });
  console.log(`Imported ${imports.length} prior HC-06 results into ${dir}.`);
  printSummary(await loadStore(dir));
}

async function cmdStatus() {
  const cfg = evidenceConfig();
  const { dir } = await resolveCertificationDir(cfg.evidenceDir);
  printSummary(await loadStore(dir));
}

/** Section 14: stop the agent (device-side, guided), confirm Offline, send one message, expect the explicit refusal, restart. */
async function cmdTestOffline() {
  const cfg = config();
  const { dir } = await resolveCertificationDir(cfg.evidenceDir);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const banner = formatHumanActionBanner({
      title: 'On the Pixel, stop the HC-06 agent now.',
      instructions: ['Run: node device-runner.mjs stop-agent (or Ctrl+C the running "cloudcli node start").', 'Press Enter here once it has stopped.'],
    });
    await runHumanCheckpoint({
      banner,
      readLine: () => rl.question(''),
      detect: async () => {
        const { token } = await connect().catch(() => ({ token: null }));
        if (!token) return null;
        const cfg2 = config();
        const listing = await listNodes(cfg2.baseUrl, token, { refresh: true });
        const node = findNodeByLabel(listing, cfg2.label);
        return node && node.canExecute === false ? { canExecute: false } : null;
      },
      timeoutMs: 30_000,
      pollIntervalMs: 3_000,
    });

    const { cfg: cfgAfter, token, node } = await connect();
    const session = await createSession(cfgAfter.baseUrl, token, { projectPath: cfgAfter.projectPath, runtimeNodeId: node.nodeId });
    const chat = openChat(cfgAfter.baseUrl, token);
    await chat.ready;
    chat.send({ type: 'chat.send', sessionId: session.sessionId, content: 'HC06 offline probe: echo should never run' });

    const result = await runHumanCheckpoint({
      banner: formatHumanActionBanner({ title: 'Waiting for the explicit offline refusal...', instructions: [] }),
      readLine: async () => undefined, // no second confirmation needed; this call only waits
      detect: async () => classifyRunOutcome(chat.frames, session.sessionId),
      timeoutMs: 15_000,
      pollIntervalMs: 500,
    });
    chat.close();

    const outcome = result.outcome === 'detected' && result.detail?.outcome === 'offline_refusal' ? 'VALIDATED' : 'FAILED';
    await writeEvidenceFile(dir, `test-offline-${Date.now()}.json`, { result });
    await saveResult(dir, {
      id: 'no-silent-failover',
      name: 'No silent failover while offline',
      status: outcome,
      notes: outcome === 'VALIDATED'
        ? 'Explicit RUNTIME_NODE_OFFLINE protocol_error observed; nothing else ran.'
        : `Did not observe the expected offline refusal within the timeout: ${JSON.stringify(result)}`,
    });
    console.log(outcome === 'VALIDATED' ? 'PASS: explicit offline refusal observed.' : 'FAIL: see evidence file for the raw frames.');
    console.log('\nOn the Pixel, restart the agent now: node device-runner.mjs start-agent\n');
  } finally {
    rl.close();
  }
}

/** Section 15: map a throwaway mismatched repo (created on-device by the operator/device-runner), expect identity_mismatch, then restore the real mapping. */
async function cmdTestIdentity() {
  const cfg = config();
  const { dir } = await resolveCertificationDir(cfg.evidenceDir);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const mismatchPathAnswer = await rl.question(
      'Path to the throwaway mismatched repo on the Pixel (created ONLY under the HC-06 workspace root by device-runner.mjs make-mismatch-repo), e.g. /root/cloudcli-workspaces-hc06/mismatch-scratch: ',
    );
    const correctPathAnswer = await rl.question('Path to the CORRECT mapped project folder on the Pixel, to restore afterward: ');

    const { cfg: cfg2, token, node } = await connect();
    const result = await runWithRestore({
      apply: async () => mapWorkspace(cfg2.baseUrl, token, node.nodeId, cfg2.projectId, mismatchPathAnswer.trim()),
      run: async () => {
        const state = await getWorkspaceState(cfg2.baseUrl, token, node.nodeId, cfg2.projectId);
        if (state.state !== 'identity_mismatch') {
          throw new Error(`Expected state "identity_mismatch", got ${JSON.stringify(state)}`);
        }
        return state;
      },
      restore: async () => mapWorkspace(cfg2.baseUrl, token, node.nodeId, cfg2.projectId, correctPathAnswer.trim()),
    });

    await writeEvidenceFile(dir, `test-identity-${Date.now()}.json`, result);
    const status = result.ok ? 'VALIDATED' : result.restored ? 'FAILED' : 'CONDITIONAL';
    await saveResult(dir, {
      id: 'identity-mismatch',
      name: 'Repository-identity mismatch on workspace mapping',
      status,
      notes: result.ok
        ? 'Mapping the mismatched repo produced state: identity_mismatch as expected; the correct mapping was restored.'
        : `See evidence file. restored=${result.restored} runError=${result.runError} restoreError=${result.restoreError}`,
    });
    console.log(status === 'VALIDATED' ? 'PASS: identity_mismatch observed and the correct mapping was restored.' : `${status}: see evidence file.`);
  } finally {
    rl.close();
  }
}

/**
 * Dispatches a long countdown and drives a human action (airplane mode,
 * etc.) with a banner, then classifies the observable result:
 * "reconnected and completed" (short-blip PASS), "explicit disconnect
 * failure" (long-outage PASS), or anything else (worth a human look).
 */
async function cmdTestReconnect(name, timeoutMsArg) {
  const timeoutMs = Number(timeoutMsArg ?? 45_000);
  const cfg = config();
  const { dir } = await resolveCertificationDir(cfg.evidenceDir);
  const { cfg: cfg2, token, node } = await connect();
  const session = await createSession(cfg2.baseUrl, token, { projectPath: cfg2.projectPath, runtimeNodeId: node.nodeId });
  const chat = openChat(cfg2.baseUrl, token);
  await chat.ready;
  chat.send({ type: 'chat.send', sessionId: session.sessionId, content: 'Count slowly from 1 to 60 using sleep 1 in bash' });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let result;
  try {
    const banner = formatHumanActionBanner({
      title: name === 'short' ? 'Turn airplane mode ON now for about 8-10 seconds, then OFF.' : 'Turn airplane mode ON now for well over a minute.',
      instructions: ['Press Enter here once you have toggled it back off (short) or are leaving it on (long).', 'The harness is watching for the outcome — no need to do anything else.'],
    });
    result = await runHumanCheckpoint({
      banner,
      readLine: () => rl.question(''),
      detect: async () => classifyRunOutcome(chat.frames, session.sessionId),
      timeoutMs,
      pollIntervalMs: 1_000,
    });
  } finally {
    rl.close();
  }
  chat.close();

  const sawSdkDenialText = chat.frames.some((frame) => containsSdkToolDenialWording(frame));
  await writeEvidenceFile(dir, `test-reconnect-${name}-${Date.now()}.json`, { result, sawSdkDenialText, frameCount: chat.frames.length });

  let status = 'UNKNOWN';
  let notes;
  if (result.outcome === 'detected' && result.detail.outcome === 'completed') {
    status = sawSdkDenialText ? 'CONDITIONAL' : 'VALIDATED';
    notes = sawSdkDenialText
      ? 'Run completed, but the SDK\'s own tool-denial wording appeared in the transcript — investigate before trusting this as a clean pass.'
      : 'Reconnected and completed with no misleading text.';
  } else if (result.outcome === 'detected' && result.detail.outcome === 'link_lost_failure') {
    status = 'VALIDATED';
    notes = 'Explicit "Lost the connection... not moved to another node" observed — correct for a long outage.';
  } else {
    status = 'FAILED';
    notes = `Neither a clean completion nor an explicit disconnect failure was observed: ${JSON.stringify(result)}`;
  }
  await saveResult(dir, { id: `reconnect-${name}-harness`, name: `Reconnect (${name}, harness-driven)`, status, notes });
  console.log(`${status}: ${notes}`);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case 'import-manual-evidence':
      return cmdImportManualEvidence();
    case 'status':
      return cmdStatus();
    case 'test-offline':
      return cmdTestOffline();
    case 'test-identity':
      return cmdTestIdentity();
    case 'test-reconnect':
      return cmdTestReconnect(args[0] ?? 'short', args[1]);
    default:
      console.error(`Unknown command "${command ?? ''}". See the header of this file for the command list.`);
      process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`\n❌ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
