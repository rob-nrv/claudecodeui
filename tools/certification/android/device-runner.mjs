#!/usr/bin/env node
// The Android/Termux side of the HC-06 RuntimeNode certification harness.
// Runs from inside the `cloudcli-hc06` proot with plain Node (already
// required and present per the HC-06 setup — see docs/android-runtime-node.md),
// so it can reuse the exact same tested lib/*.mjs modules as the PC-side
// control-plane-runner instead of re-implementing JSON/log parsing in shell.
//
// It supervises the node-agent as a CHILD process (spawn, not a detached
// daemon it loses track of), so it always knows the exact pid it started —
// see lib/process-ownership.mjs for why that matters before ever signalling
// anything.
//
// Usage:
//   node tools/certification/android/device-runner.mjs <command> [options]
//
// Commands:
//   status                          Resume-state facts: enrolled, Claude
//                                    logged in, agent running, source commit.
//   check-commit                    Verifies the source includes a31c3765
//                                    (the required reconnect-fix floor).
//   doctor [--output NAME] [--no-network] [--min-free-storage-mb N]
//   start-agent [-- <extra node-agent flags>]
//   stop-agent
//   restart-agent [-- <extra node-agent flags>]
//   agent-status
//   log-summary                     Parses agent.log: accepted/duplicate/
//                                    outcome/reconnect counts.
//   storage-test                    Applies --min-free-storage-mb 1048576,
//                                    waits for you to trigger one send from
//                                    the control plane, restores on exit —
//                                    even if the test fails.
//   sigkill-test                    Captures agent+children ownership,
//                                    guides you to start a long run, then
//                                    SIGKILLs only the agent pid it itself
//                                    started and reports survivors.
//   background-test [MINUTES]       Prints the lock-screen banner, waits,
//                                    inspects agent.log for a suspension gap.
//   make-mismatch-repo PATH         Throwaway git repo, ONLY under the
//                                    workspace root.
//   remove-mismatch-repo PATH       Removes it again — refuses anything
//                                    outside the workspace root or not
//                                    named like a mismatch scratch repo.
//
// Environment (defaults match the mission's stated current Pixel state):
//   HC06_SRC              default ~/cloudcli-hc06-src
//   HC06_STATE_DIR        default ~/.cloudcli/node-agent-hc06
//   HC06_WORKSPACE_ROOT   default ~/cloudcli-workspaces-hc06
//   HC06_HOME             default ~/hc06 (agent.log, agent.pid, evidence)
import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { promisify } from 'node:util';

import { appendManifestEntry, resolveCertificationDir, writeEvidenceFile } from './lib/evidence.mjs';
import { formatHumanActionBanner, runHumanCheckpoint } from './lib/human-checkpoint.mjs';
import { acceptedExecutionIds, lastInterruptedOnRestart, noDuplicateAcceptance, outcomesByExecution, parseAgentLog, reconnectOutcome } from './lib/log-parser.mjs';
import { isSafeKillCommand, planSafeSignal, recordOwnedProcess } from './lib/process-ownership.mjs';
import { planResume } from './lib/resume-state.mjs';
import { runWithRestore } from './lib/with-restore.mjs';

const execFileAsync = promisify(execFile);
const REQUIRED_COMMIT = 'a31c3765';

function home(...segments) {
  const base = process.env.HC06_HOME ?? path.join(os.homedir(), 'hc06');
  return path.join(base, ...segments);
}
function src() {
  return process.env.HC06_SRC ?? path.join(os.homedir(), 'cloudcli-hc06-src');
}
function stateDir() {
  return process.env.HC06_STATE_DIR ?? path.join(os.homedir(), '.cloudcli', 'node-agent-hc06');
}
function workspaceRoot() {
  return process.env.HC06_WORKSPACE_ROOT ?? path.join(os.homedir(), 'cloudcli-workspaces-hc06');
}
function cliEntry() {
  return path.join(src(), 'dist-server', 'server', 'modules', 'cli', 'cli.js');
}
function agentPidFile() {
  return home('agent.pid');
}
function agentLogFile() {
  return home('agent.log');
}

async function fileExists(target) {
  try {
    await readFile(target);
    return true;
  } catch {
    return false;
  }
}

async function evidenceDir() {
  const { dir } = await resolveCertificationDir(home());
  return dir;
}

// ---------------------------------------------------------------------------
// Doctor
// ---------------------------------------------------------------------------
async function runDoctor(extraArgs = []) {
  const args = ['node', 'doctor', '--state-dir', stateDir(), '--workspace-root', workspaceRoot(), '--json', ...extraArgs];
  const { stdout } = await execFileAsync('node', [cliEntry(), ...args.slice(1)]);
  return JSON.parse(stdout);
}

async function cmdDoctor(args) {
  const outputIndex = args.indexOf('--output');
  const report = await runDoctor(args.filter((_, index) => index !== outputIndex && index !== outputIndex + 1));
  console.log(JSON.stringify(report, null, 2));
  if (outputIndex >= 0 && args[outputIndex + 1]) {
    const dir = await evidenceDir();
    await writeEvidenceFile(dir, args[outputIndex + 1], report);
    console.log(`\nWritten to ${path.join(dir, args[outputIndex + 1])}`);
  }
}

// ---------------------------------------------------------------------------
// Resume-state
// ---------------------------------------------------------------------------
async function isRequiredCommitAncestor() {
  try {
    await execFileAsync('git', ['-C', src(), 'merge-base', '--is-ancestor', REQUIRED_COMMIT, 'HEAD']);
    return true;
  } catch (error) {
    if (error && typeof error.code === 'number') return false; // git ran and said "no"
    return 'unknown'; // git itself failed to run (not a repo, unknown commit, etc.)
  }
}

async function headCommit() {
  try {
    const { stdout } = await execFileAsync('git', ['-C', src(), 'rev-parse', '--short=8', 'HEAD']);
    return stdout.trim();
  } catch {
    return 'unknown';
  }
}

async function agentIsRunning() {
  const record = await readAgentPidRecord();
  if (!record) return false;
  return (await lookupProcess(record.pid)) !== null;
}

async function cmdCheckCommit() {
  const ancestor = await isRequiredCommitAncestor();
  const head = await headCommit();
  const plan = planResume({ requiredCommit: REQUIRED_COMMIT, headCommit: head, isRequiredCommitAncestor: ancestor });
  console.log(JSON.stringify({ headCommit: head, isRequiredCommitAncestor: ancestor, plan }, null, 2));
  if (!plan.canProceed) {
    process.exitCode = 2;
  }
}

async function cmdStatus() {
  const enrolled = await fileExists(path.join(stateDir(), 'credential.json'));
  let claudeLoggedIn = false;
  try {
    const report = await runDoctor(['--no-network']);
    claudeLoggedIn = report.capabilities.find((entry) => entry.id === 'claude-auth')?.status === 'proven';
  } catch {
    claudeLoggedIn = false;
  }
  const workspaceExists = await fileExists(workspaceRoot());
  const running = await agentIsRunning();
  const ancestor = await isRequiredCommitAncestor();
  const head = await headCommit();
  const plan = planResume({
    requiredCommit: REQUIRED_COMMIT,
    headCommit: head,
    isRequiredCommitAncestor: ancestor,
    enrolled,
    claudeLoggedIn,
    workspaceMapped: workspaceExists, // best this side can observe; DB-side mapping is the control plane's fact
    agentRunning: running,
  });
  console.log(JSON.stringify({ enrolled, claudeLoggedIn, workspaceExists, agentRunning: running, headCommit: head, isRequiredCommitAncestor: ancestor, plan }, null, 2));
}

// ---------------------------------------------------------------------------
// Agent supervision — always spawned as OUR OWN child, pid captured directly
// from the spawn() call (never parsed back out of `ps` after the fact for
// the pid itself, only for later re-verification).
// ---------------------------------------------------------------------------
async function readAgentPidRecord() {
  try {
    return JSON.parse(await readFile(agentPidFile(), 'utf8'));
  } catch {
    return null;
  }
}

async function lookupProcess(pid) {
  try {
    // A minimal, portable ps invocation; works on both Termux/Android's
    // toybox ps and a standard Linux ps. `-o` order is fixed so parsing is stable.
    const { stdout } = await execFileAsync('ps', ['-o', 'pid,args', '-p', String(pid)]);
    const line = stdout.split('\n').slice(1).find((row) => row.trim().startsWith(String(pid)));
    if (!line) return null;
    const cmdline = line.trim().slice(String(pid).length).trim();
    return { pid, cmdline, startTime: null }; // toybox ps has no portable lstart; ownership review falls back to cmdline-only (see lib/process-ownership.mjs)
  } catch {
    return null;
  }
}

async function cmdStartAgent(extraFlags) {
  if (await agentIsRunning()) {
    console.log('The agent is already running (per agent.pid) — not starting a second one.');
    return;
  }
  await mkdir(home(), { recursive: true });
  const args = ['node', cliEntry(), 'node', 'start', '--state-dir', stateDir(), '--workspace-root', workspaceRoot(), ...extraFlags];
  const child = spawn(args[0], args.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], detached: false });
  const logStream = await import('node:fs').then((fs) => fs.createWriteStream(agentLogFile(), { flags: 'a', mode: 0o600 }));
  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);
  const cmdline = args.slice(1).join(' ');
  await writeFile(agentPidFile(), JSON.stringify(recordOwnedProcess({ pid: child.pid, role: 'node-agent', commandSubstring: 'cli.js node start', cmdlineAtCapture: cmdline }), null, 2), { mode: 0o600 });
  child.unref();
  console.log(`Started node-agent as pid ${child.pid}, logging to ${agentLogFile()}.`);
}

async function cmdStopAgent() {
  const record = await readAgentPidRecord();
  if (!record) {
    console.log('No agent.pid on record — nothing to stop.');
    return;
  }
  const current = await lookupProcess(record.pid);
  const plan = planSafeSignal([record], [{ pid: record.pid, current }]);
  if (plan.verified.length === 0) {
    console.log(`Refusing to stop pid ${record.pid}: ownership could not be verified (${JSON.stringify(plan.needsHumanConfirmation)}). It may have already exited.`);
    return;
  }
  process.kill(record.pid, 'SIGTERM');
  console.log(`Sent SIGTERM to node-agent pid ${record.pid}.`);
}

async function cmdRestartAgent(extraFlags) {
  await cmdStopAgent();
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  await cmdStartAgent(extraFlags);
}

async function cmdAgentStatus() {
  const record = await readAgentPidRecord();
  if (!record) {
    console.log(JSON.stringify({ running: false, reason: 'no agent.pid on record' }));
    return;
  }
  const current = await lookupProcess(record.pid);
  console.log(JSON.stringify({ running: current !== null, pid: record.pid, current }, null, 2));
}

// ---------------------------------------------------------------------------
// Log evidence
// ---------------------------------------------------------------------------
async function cmdLogSummary() {
  const text = await fileExists(agentLogFile()) ? await readFile(agentLogFile(), 'utf8') : '';
  const events = parseAgentLog(text);
  const summary = {
    acceptedExecutions: acceptedExecutionIds(events).length,
    duplicateAcceptance: noDuplicateAcceptance(events),
    outcomes: Object.fromEntries(outcomesByExecution(events)),
    lastReconnectOutcome: reconnectOutcome(events),
    lastInterruptedOnRestart: lastInterruptedOnRestart(events),
  };
  console.log(JSON.stringify(summary, null, 2));
  const dir = await evidenceDir();
  await appendManifestEntry(dir, { kind: 'log-summary', ...summary });
}

// ---------------------------------------------------------------------------
// Storage governor test — apply/run/restore, restore ALWAYS runs.
// ---------------------------------------------------------------------------
async function cmdStorageTest() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const result = await runWithRestore({
      apply: async () => cmdRestartAgent(['--min-free-storage-mb', '1048576']),
      run: async () => {
        const report = await runDoctor(['--min-free-storage-mb', '1048576']);
        if (!report.summary.blockers.includes('resources_storage_low')) {
          throw new Error(`Expected blocker "resources_storage_low", got ${JSON.stringify(report.summary.blockers)}`);
        }
        console.log(formatHumanActionBanner({
          title: 'On the PC, send one message to a Pixel HC-06 session now.',
          instructions: ['Expect the explicit low-storage refusal, not a queued or local run.', 'Press Enter here once you have seen it.'],
        }));
        await rl.question('');
        return report;
      },
      restore: async () => cmdRestartAgent(['--max-concurrent-runs', '1']),
    });
    const dir = await evidenceDir();
    await writeEvidenceFile(dir, `storage-test-${Date.now()}.json`, { ok: result.ok, restored: result.restored, applyError: result.applyError, runError: result.runError, restoreError: result.restoreError });
    console.log(result.ok ? 'PASS: storage-floor blocker observed, and normal configuration restored.' : `NOT CLEAN: ${JSON.stringify(result)}`);
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// SIGKILL test — only ever signals the exact pid it started.
// ---------------------------------------------------------------------------
async function cmdSigkillTest() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const agentRecord = await readAgentPidRecord();
    if (!agentRecord) {
      console.log('No agent.pid on record. Start the agent first: node device-runner.mjs start-agent');
      return;
    }
    console.log(formatHumanActionBanner({
      title: 'On the PC, start a long run bound to Pixel HC-06 now.',
      instructions: ['Wait until it is clearly mid-run (a Claude process and its Bash child both exist).', 'Press Enter here once it is running.'],
    }));
    await rl.question('');

    const kill = isSafeKillCommand(`kill -9 ${agentRecord.pid}`);
    if (!kill.safe) {
      throw new Error(`Refusing to proceed: kill command failed its own safety check (${kill.reason})`);
    }
    process.kill(agentRecord.pid, 'SIGKILL');
    console.log(`Sent SIGKILL to node-agent pid ${agentRecord.pid} (the exact pid this runner started — never a pattern match).`);

    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const claudePids = await listPidsByCommand('claude');
    const bashPids = await listPidsByCommand('sleep'); // the HC-06 procedure's own long-task uses `sleep 1` in bash
    const survivors = { claude: claudePids, bashLike: bashPids };
    const dir = await evidenceDir();
    await writeEvidenceFile(dir, `sigkill-test-${Date.now()}.json`, { agentPid: agentRecord.pid, survivors });
    console.log(`Survivors after SIGKILL: ${JSON.stringify(survivors)}`);
    console.log(survivors.claude.length > 0 || survivors.bashLike.length > 0
      ? 'CONDITIONAL: orphan child process(es) survived the agent SIGKILL — a real runtime limitation, not something this harness silently cleans up.'
      : 'No orphans observed this time.');
    console.log('\nIf cleanup is needed, confirm each pid individually — this runner never broad-kills by name:');
    for (const pid of [...survivors.claude, ...survivors.bashLike]) {
      console.log(`  kill -9 ${pid}   # confirm this is the orphan before running it yourself`);
    }
    console.log('\nRestart the agent when ready: node device-runner.mjs start-agent');
  } finally {
    rl.close();
  }
}

async function listPidsByCommand(substring) {
  try {
    const { stdout } = await execFileAsync('pgrep', ['-f', substring]);
    return stdout.split('\n').map((line) => line.trim()).filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Background/screen-off test
// ---------------------------------------------------------------------------
async function cmdBackgroundTest(minutesArg) {
  const minutes = Number(minutesArg ?? 5);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const before = await fileExists(agentLogFile()) ? (await readFile(agentLogFile(), 'utf8')).length : 0;
    const result = await runHumanCheckpoint({
      banner: formatHumanActionBanner({
        title: 'Lock the Pixel screen now.',
        instructions: [`Do not unlock for ${minutes} minutes.`, 'Timer started.'],
      }),
      readLine: () => rl.question(''),
      detect: async () => {
        const running = await agentIsRunning();
        return running ? null : { agentSurvived: false }; // only reports something once we KNOW it died; a live agent means "still waiting"
      },
      timeoutMs: minutes * 60_000,
      pollIntervalMs: 15_000,
    });
    const stillRunning = await agentIsRunning();
    const after = await fileExists(agentLogFile()) ? (await readFile(agentLogFile(), 'utf8')).length : 0;
    const dir = await evidenceDir();
    const evidence = { minutes, result, agentSurvived: stillRunning, logGrewDuringTest: after > before };
    await writeEvidenceFile(dir, `background-test-${Date.now()}.json`, evidence);
    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// Mismatch-repo scratch helpers — confined strictly to the workspace root.
// ---------------------------------------------------------------------------
function assertUnderWorkspaceRoot(target) {
  const resolved = path.resolve(target);
  const root = path.resolve(workspaceRoot());
  const relative = path.relative(root, resolved);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing: ${resolved} is not inside the HC-06 workspace root (${root}).`);
  }
  return resolved;
}

async function cmdMakeMismatchRepo(targetPath) {
  if (!targetPath) throw new Error('Usage: make-mismatch-repo <path under the workspace root>');
  const resolved = assertUnderWorkspaceRoot(targetPath);
  await mkdir(resolved, { recursive: true });
  await execFileAsync('git', ['-C', resolved, 'init', '-q']);
  await writeFile(path.join(resolved, 'README.md'), 'HC-06 identity-mismatch scratch repo. Safe to delete.\n');
  await execFileAsync('git', ['-C', resolved, 'add', 'README.md']);
  await execFileAsync('git', ['-C', resolved, '-c', 'user.email=hc06@example.invalid', '-c', 'user.name=HC-06 Harness', 'commit', '-q', '-m', 'HC-06 mismatch scratch repo']);
  console.log(`Created a throwaway git repo at ${resolved}.`);
}

async function cmdRemoveMismatchRepo(targetPath) {
  if (!targetPath) throw new Error('Usage: remove-mismatch-repo <path under the workspace root>');
  const resolved = assertUnderWorkspaceRoot(targetPath);
  if (!path.basename(resolved).toLowerCase().includes('mismatch')) {
    throw new Error(`Refusing: ${resolved} is not named like a mismatch scratch repo (expected "mismatch" in the folder name) — remove it by hand if you're sure.`);
  }
  const marker = path.join(resolved, 'README.md');
  const content = await fileExists(marker) ? await readFile(marker, 'utf8') : '';
  if (!content.includes('HC-06 identity-mismatch scratch repo')) {
    throw new Error(`Refusing: ${resolved} does not contain this runner's own marker file — it was not (or is no longer) created by make-mismatch-repo.`);
  }
  await rm(resolved, { recursive: true, force: true });
  console.log(`Removed ${resolved}.`);
}

// ---------------------------------------------------------------------------

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const dashDash = rest.indexOf('--');
  const positional = dashDash >= 0 ? rest.slice(0, dashDash) : rest;
  const extraFlags = dashDash >= 0 ? rest.slice(dashDash + 1) : [];

  switch (command) {
    case 'status': return cmdStatus();
    case 'check-commit': return cmdCheckCommit();
    case 'doctor': return cmdDoctor(rest);
    case 'start-agent': return cmdStartAgent(extraFlags);
    case 'stop-agent': return cmdStopAgent();
    case 'restart-agent': return cmdRestartAgent(extraFlags);
    case 'agent-status': return cmdAgentStatus();
    case 'log-summary': return cmdLogSummary();
    case 'storage-test': return cmdStorageTest();
    case 'sigkill-test': return cmdSigkillTest();
    case 'background-test': return cmdBackgroundTest(positional[0]);
    case 'make-mismatch-repo': return cmdMakeMismatchRepo(positional[0]);
    case 'remove-mismatch-repo': return cmdRemoveMismatchRepo(positional[0]);
    default:
      console.error(`Unknown command "${command ?? ''}". See the header of this file for the command list.`);
      process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`\n❌ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
