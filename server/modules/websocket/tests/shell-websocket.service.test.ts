import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { WebSocket } from 'ws';

import { handleShellConnection } from '@/modules/websocket/services/shell-websocket.service.js';

function createFakeSocket() {
  const socket = new EventEmitter() as EventEmitter & {
    readyState: number;
    frames: string[];
    send: (data: string) => void;
  };
  socket.readyState = WebSocket.OPEN;
  socket.frames = [];
  socket.send = (data: string) => socket.frames.push(data);
  return socket;
}

function createFakePty() {
  let dataListener: ((data: string) => void) | null = null;
  let exitListener: ((event: { exitCode: number; signal?: number }) => void) | null = null;

  return {
    killed: false,
    onData(listener: (data: string) => void) {
      dataListener = listener;
      return { dispose: () => undefined };
    },
    onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
      exitListener = listener;
      return { dispose: () => undefined };
    },
    emitData(data: string) {
      dataListener?.(data);
    },
    emitExit() {
      exitListener?.({ exitCode: 0 });
    },
    write() {},
    resize() {},
    kill() {
      this.killed = true;
    },
  };
}

test('a stale socket close cannot detach the socket that replaced it', () => {
  const pty = createFakePty();
  const dependencies = {
    resolveProviderSessionId: () => null,
    spawnPty: () => pty as never,
  };
  const initMessage = JSON.stringify({
    type: 'init',
    projectPath: process.cwd(),
    sessionId: `stale-close-${Date.now()}`,
    hasSession: false,
    provider: 'plain-shell',
    isPlainShell: true,
    initialCommand: 'test-command',
  });

  const firstSocket = createFakeSocket();
  handleShellConnection(firstSocket as never, dependencies);
  firstSocket.emit('message', initMessage);

  const replacementSocket = createFakeSocket();
  handleShellConnection(replacementSocket as never, dependencies);
  replacementSocket.emit('message', initMessage);
  replacementSocket.frames.length = 0;

  // This ordering reproduces a delayed close from a backgrounded mobile tab.
  firstSocket.emit('close');
  pty.emitData('output-after-stale-close');

  assert.equal(pty.killed, false);
  assert.equal(replacementSocket.frames.length, 1);
  assert.match(replacementSocket.frames[0], /output-after-stale-close/);

  pty.emitExit();
});

// Regression coverage for the profile-specific "Login"/"Re-login" flow
// (Settings → Claude Accounts). The frontend sends only an opaque
// `claudeProfileId`; this service resolves it to a config directory via the
// injected `resolveClaudeProfileConfigDir` dependency and adds
// `CLAUDE_CONFIG_DIR` to that one pty spawn's env object only.

function createRecordingSpawnPty() {
  const calls: Array<{ shell: string; args: string | string[]; options: { env?: NodeJS.ProcessEnv; cwd?: string } }> = [];
  const spawnPty = (shell: string, args: string | string[], options: { env?: NodeJS.ProcessEnv; cwd?: string }) => {
    calls.push({ shell, args, options });
    return createFakePty() as never;
  };
  return { spawnPty, calls };
}

function claudeLoginInitMessage(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: 'init',
    projectPath: process.cwd(),
    sessionId: null,
    hasSession: false,
    provider: 'plain-shell',
    isPlainShell: true,
    initialCommand: 'claude /login',
    ...overrides,
  });
}

test('Login on profile "work" resolves its own configDirectory and passes it as CLAUDE_CONFIG_DIR to the spawned pty only', () => {
  const { spawnPty, calls } = createRecordingSpawnPty();
  const resolved: string[] = [];
  const dependencies = {
    resolveProviderSessionId: () => null,
    resolveClaudeProfileConfigDir: (profileId: string) => {
      resolved.push(profileId);
      return profileId === 'work' ? '/home/user/.cloudcli/claude-profiles/work' : null;
    },
    spawnPty,
  };

  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const socket = createFakeSocket();
  handleShellConnection(socket as never, dependencies);
  socket.emit('message', claudeLoginInitMessage({ sessionId: `work-login-${Date.now()}`, claudeProfileId: 'work' }));

  assert.deepEqual(resolved, ['work']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.env?.CLAUDE_CONFIG_DIR, '/home/user/.cloudcli/claude-profiles/work');
  // The global process env must never be touched — only this one spawn's env object.
  assert.equal(process.env.CLAUDE_CONFIG_DIR, originalConfigDir);
});

test('Login on profile "personal" gets its own distinct CLAUDE_CONFIG_DIR, and does not affect a concurrent "work" login', () => {
  const { spawnPty, calls } = createRecordingSpawnPty();
  const dependencies = {
    resolveProviderSessionId: () => null,
    resolveClaudeProfileConfigDir: (profileId: string) => {
      if (profileId === 'work') return '/home/user/.cloudcli/claude-profiles/work';
      if (profileId === 'personal') return '/home/user/.cloudcli/claude-profiles/personal';
      return null;
    },
    spawnPty,
  };

  const workSocket = createFakeSocket();
  handleShellConnection(workSocket as never, dependencies);
  workSocket.emit('message', claudeLoginInitMessage({ sessionId: `work-${Date.now()}`, claudeProfileId: 'work' }));

  const personalSocket = createFakeSocket();
  handleShellConnection(personalSocket as never, dependencies);
  personalSocket.emit('message', claudeLoginInitMessage({ sessionId: `personal-${Date.now()}`, claudeProfileId: 'personal' }));

  assert.equal(calls.length, 2, 'each profile login must spawn its own pty, never share one');
  assert.equal(calls[0].options.env?.CLAUDE_CONFIG_DIR, '/home/user/.cloudcli/claude-profiles/work');
  assert.equal(calls[1].options.env?.CLAUDE_CONFIG_DIR, '/home/user/.cloudcli/claude-profiles/personal');
  assert.notEqual(calls[0].options.env?.CLAUDE_CONFIG_DIR, calls[1].options.env?.CLAUDE_CONFIG_DIR);
});

test('Re-login on the same profile (a second init call) resolves the same config dir every time', () => {
  const { spawnPty, calls } = createRecordingSpawnPty();
  const dependencies = {
    resolveProviderSessionId: () => null,
    resolveClaudeProfileConfigDir: (profileId: string) =>
      (profileId === 'work' ? '/home/user/.cloudcli/claude-profiles/work' : null),
    spawnPty,
  };

  const sessionId = `relogin-${Date.now()}`;
  const socket = createFakeSocket();
  handleShellConnection(socket as never, dependencies);
  socket.emit('message', claudeLoginInitMessage({ sessionId, claudeProfileId: 'work' }));
  // "Re-login" while already connected re-sends the exact same init shape
  // (claude /login is treated as a login command, forcing a fresh pty rather
  // than silently reusing a stale/dead one).
  socket.emit('message', claudeLoginInitMessage({ sessionId, claudeProfileId: 'work' }));

  assert.equal(calls.length, 2, 'claude /login must force a fresh pty rather than silently reattaching');
  for (const call of calls) {
    assert.equal(call.options.env?.CLAUDE_CONFIG_DIR, '/home/user/.cloudcli/claude-profiles/work');
  }
});

test('an unknown/rejected claudeProfileId gets a clean error message and never spawns a pty', () => {
  const { spawnPty, calls } = createRecordingSpawnPty();
  const dependencies = {
    resolveProviderSessionId: () => null,
    resolveClaudeProfileConfigDir: () => null, // simulates "no such profile"
    spawnPty,
  };

  const socket = createFakeSocket();
  handleShellConnection(socket as never, dependencies);
  socket.emit('message', claudeLoginInitMessage({ sessionId: `bad-profile-${Date.now()}`, claudeProfileId: 'does-not-exist' }));

  assert.equal(calls.length, 0, 'no child process may be launched for an unresolvable profile id');
  const frames = socket.frames.map((frame) => JSON.parse(frame) as Record<string, unknown>);
  const errorFrame = frames.find((frame) => frame.type === 'error');
  assert.ok(errorFrame, 'a clean, structured error frame must be sent');
  assert.equal(typeof errorFrame?.message, 'string');
  // The error must never leak a filesystem path or any profile internals.
  assert.equal(JSON.stringify(errorFrame).includes('/'), false);
});

test('omitting claudeProfileId entirely (every other shell use — main terminal, historical account login) never touches CLAUDE_CONFIG_DIR', () => {
  const { spawnPty, calls } = createRecordingSpawnPty();
  const dependencies = {
    resolveProviderSessionId: () => null,
    resolveClaudeProfileConfigDir: () => {
      throw new Error('must not be called when claudeProfileId is absent');
    },
    spawnPty,
  };

  const socket = createFakeSocket();
  handleShellConnection(socket as never, dependencies);
  socket.emit('message', claudeLoginInitMessage({ sessionId: `no-profile-${Date.now()}` }));

  assert.equal(calls.length, 1);
  assert.equal('CLAUDE_CONFIG_DIR' in (calls[0].options.env ?? {}), false);
});

test('a resolver dependency that is entirely absent (older composition) does not crash the init handler', () => {
  const { spawnPty, calls } = createRecordingSpawnPty();
  const dependencies = {
    resolveProviderSessionId: () => null,
    spawnPty,
    // resolveClaudeProfileConfigDir intentionally omitted
  };

  const socket = createFakeSocket();
  handleShellConnection(socket as never, dependencies);
  socket.emit('message', claudeLoginInitMessage({ sessionId: `no-resolver-${Date.now()}`, claudeProfileId: 'work' }));

  // Without a resolver, an explicit profileId cannot be honoured — this must
  // fail closed (reject) rather than silently spawn with no isolation.
  assert.equal(calls.length, 0);
  const frames = socket.frames.map((frame) => JSON.parse(frame) as Record<string, unknown>);
  assert.ok(frames.some((frame) => frame.type === 'error'));
});

// ---------------------------------------------------------------------------
// Pixel regression: a Shell opened FOR an existing Claude session must use
// THAT session's bound profile, never a client-supplied value, the current
// Default, or the legacy/global account. The bug: `MainContent.tsx`'s
// workspace Shell tab never passed `claudeProfileId` at all, so every
// session's Shell silently spawned against the un-isolated legacy
// `~/.claude` — which happened to be authenticated as "Work", making a
// Personal session's Shell report the Work identity via `claude /status`.
// The fix makes `sessionId` (already sent on every session-bound `init`)
// resolve the profile server-side via `resolveSessionClaudeProfileId`,
// overriding anything the client sends once a real session is involved.
// ---------------------------------------------------------------------------

function sessionShellInitMessage(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: 'init',
    projectPath: process.cwd(),
    hasSession: true,
    provider: 'claude',
    isPlainShell: false,
    ...overrides,
  });
}

// The pty session map this service keeps is module-level and outlives any
// one test, so every test below mints its own unique session/profile ids —
// reusing a literal like "session-work" across tests would silently hit the
// "reconnect to existing session" path instead of spawning, exactly like a
// real reconnect would (see test E, which relies on that same behavior on
// purpose for a single test).
let uniqueIdCounter = 0;
function uniqueId(label: string): string {
  uniqueIdCounter += 1;
  return `${label}-${uniqueIdCounter}`;
}

test('A: a Shell opened for a session bound to "work" gets the Work CLAUDE_CONFIG_DIR', () => {
  const { spawnPty, calls } = createRecordingSpawnPty();
  const sessionId = uniqueId('session-work');
  const dependencies = {
    resolveProviderSessionId: () => null,
    resolveClaudeProfileConfigDir: (profileId: string) =>
      (profileId === 'profile-work' ? '/home/user/.cloudcli/claude-profiles/profile-work' : null),
    resolveSessionClaudeProfileId: (id: string) => (id === sessionId ? 'profile-work' : null),
    spawnPty,
  };

  const socket = createFakeSocket();
  handleShellConnection(socket as never, dependencies);
  socket.emit('message', sessionShellInitMessage({ sessionId }));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.env?.CLAUDE_CONFIG_DIR, '/home/user/.cloudcli/claude-profiles/profile-work');
});

test('B: a Shell opened for a session bound to "personal" gets the Personal CLAUDE_CONFIG_DIR', () => {
  const { spawnPty, calls } = createRecordingSpawnPty();
  const sessionId = uniqueId('session-personal');
  const dependencies = {
    resolveProviderSessionId: () => null,
    resolveClaudeProfileConfigDir: (profileId: string) =>
      (profileId === 'profile-personal' ? '/home/user/.cloudcli/claude-profiles/profile-personal' : null),
    resolveSessionClaudeProfileId: (id: string) => (id === sessionId ? 'profile-personal' : null),
    spawnPty,
  };

  const socket = createFakeSocket();
  handleShellConnection(socket as never, dependencies);
  socket.emit('message', sessionShellInitMessage({ sessionId }));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.env?.CLAUDE_CONFIG_DIR, '/home/user/.cloudcli/claude-profiles/profile-personal');
});

test('C: Work and Personal session shells get distinct ptys with no cross-contamination', () => {
  const { spawnPty, calls } = createRecordingSpawnPty();
  const workSessionId = uniqueId('session-work');
  const personalSessionId = uniqueId('session-personal');
  const dependencies = {
    resolveProviderSessionId: () => null,
    resolveClaudeProfileConfigDir: (profileId: string) => {
      if (profileId === 'profile-work') return '/home/user/.cloudcli/claude-profiles/profile-work';
      if (profileId === 'profile-personal') return '/home/user/.cloudcli/claude-profiles/profile-personal';
      return null;
    },
    resolveSessionClaudeProfileId: (id: string) => {
      if (id === workSessionId) return 'profile-work';
      if (id === personalSessionId) return 'profile-personal';
      return null;
    },
    spawnPty,
  };

  const workSocket = createFakeSocket();
  handleShellConnection(workSocket as never, dependencies);
  workSocket.emit('message', sessionShellInitMessage({ sessionId: workSessionId }));

  const personalSocket = createFakeSocket();
  handleShellConnection(personalSocket as never, dependencies);
  personalSocket.emit('message', sessionShellInitMessage({ sessionId: personalSessionId }));

  assert.equal(calls.length, 2, 'each session must spawn its own pty');
  assert.equal(calls[0].options.env?.CLAUDE_CONFIG_DIR, '/home/user/.cloudcli/claude-profiles/profile-work');
  assert.equal(calls[1].options.env?.CLAUDE_CONFIG_DIR, '/home/user/.cloudcli/claude-profiles/profile-personal');
  assert.notEqual(calls[0].options.env?.CLAUDE_CONFIG_DIR, calls[1].options.env?.CLAUDE_CONFIG_DIR);
});

test('D: changing the global Default profile after creation does not affect an existing session\'s Shell binding', () => {
  const { spawnPty, calls } = createRecordingSpawnPty();
  const sessionId = uniqueId('session-work');
  // `resolveSessionClaudeProfileId` is a pure function of sessionId only — it
  // has no notion of "current default" to consult, which is the point: the
  // binding lives on the session row, not in any global/current-selection state.
  const dependencies = {
    resolveProviderSessionId: () => null,
    resolveClaudeProfileConfigDir: (profileId: string) =>
      (profileId === 'profile-work' ? '/home/user/.cloudcli/claude-profiles/profile-work' : null),
    resolveSessionClaudeProfileId: (id: string) => (id === sessionId ? 'profile-work' : null),
    spawnPty,
  };

  const socket = createFakeSocket();
  handleShellConnection(socket as never, dependencies);
  // Simulates the Default profile having changed to "personal" elsewhere in
  // the app in between — irrelevant, since resolution never reads it.
  socket.emit('message', sessionShellInitMessage({ sessionId }));

  assert.equal(calls[0].options.env?.CLAUDE_CONFIG_DIR, '/home/user/.cloudcli/claude-profiles/profile-work');
});

test('E: reconnect/resume (a second init for the same session) resolves the identical profile binding', () => {
  const { spawnPty, calls } = createRecordingSpawnPty();
  const sessionId = uniqueId('session-work');
  const dependencies = {
    resolveProviderSessionId: () => null,
    resolveClaudeProfileConfigDir: (profileId: string) =>
      (profileId === 'profile-work' ? '/home/user/.cloudcli/claude-profiles/profile-work' : null),
    resolveSessionClaudeProfileId: (id: string) => (id === sessionId ? 'profile-work' : null),
    spawnPty,
  };

  const firstSocket = createFakeSocket();
  handleShellConnection(firstSocket as never, dependencies);
  firstSocket.emit('message', sessionShellInitMessage({ sessionId, forceRestart: true }));

  const secondSocket = createFakeSocket();
  handleShellConnection(secondSocket as never, dependencies);
  secondSocket.emit('message', sessionShellInitMessage({ sessionId, forceRestart: true }));

  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.options.env?.CLAUDE_CONFIG_DIR, '/home/user/.cloudcli/claude-profiles/profile-work');
  }
});

test('F: a legacy session with no bound profile spawns its Shell exactly as before (no CLAUDE_CONFIG_DIR)', () => {
  const { spawnPty, calls } = createRecordingSpawnPty();
  const sessionId = uniqueId('session-legacy');
  const dependencies = {
    resolveProviderSessionId: () => null,
    resolveClaudeProfileConfigDir: () => {
      throw new Error('must not be called: nothing is bound');
    },
    resolveSessionClaudeProfileId: () => null, // legacy session row: claude_profile_id is NULL
    spawnPty,
  };

  const socket = createFakeSocket();
  handleShellConnection(socket as never, dependencies);
  socket.emit('message', sessionShellInitMessage({ sessionId }));

  assert.equal(calls.length, 1);
  assert.equal('CLAUDE_CONFIG_DIR' in (calls[0].options.env ?? {}), false);
});

test('G: a session bound to a since-deleted profile gets a clean error and spawns zero ptys — no fallback', () => {
  const { spawnPty, calls } = createRecordingSpawnPty();
  const sessionId = uniqueId('session-orphaned');
  const dependencies = {
    resolveProviderSessionId: () => null,
    resolveClaudeProfileConfigDir: () => null, // the profile row is gone
    resolveSessionClaudeProfileId: (id: string) => (id === sessionId ? 'profile-removed' : null),
    spawnPty,
  };

  const socket = createFakeSocket();
  handleShellConnection(socket as never, dependencies);
  socket.emit('message', sessionShellInitMessage({ sessionId }));

  assert.equal(calls.length, 0, 'no pty may be spawned for an orphaned profile binding');
  const frames = socket.frames.map((frame) => JSON.parse(frame) as Record<string, unknown>);
  assert.ok(frames.some((frame) => frame.type === 'error'));
});

test('H: a non-Claude session (e.g. Codex) is unaffected — no profile lookup drives its Shell', () => {
  const { spawnPty, calls } = createRecordingSpawnPty();
  const sessionId = uniqueId('session-codex');
  const dependencies = {
    resolveProviderSessionId: () => null,
    resolveClaudeProfileConfigDir: () => {
      throw new Error('must not be called for a non-Claude session');
    },
    // A non-Claude session row never has claude_profile_id set.
    resolveSessionClaudeProfileId: () => null,
    spawnPty,
  };

  const socket = createFakeSocket();
  handleShellConnection(socket as never, dependencies);
  socket.emit('message', sessionShellInitMessage({ sessionId, provider: 'codex' }));

  assert.equal(calls.length, 1);
  assert.equal('CLAUDE_CONFIG_DIR' in (calls[0].options.env ?? {}), false);
});

test('I: a client-supplied claudeProfileId is ignored for a session-bound Shell — the session row always wins', () => {
  const { spawnPty, calls } = createRecordingSpawnPty();
  const sessionId = uniqueId('session-personal');
  const dependencies = {
    resolveProviderSessionId: () => null,
    resolveClaudeProfileConfigDir: (profileId: string) => {
      if (profileId === 'profile-personal') return '/home/user/.cloudcli/claude-profiles/profile-personal';
      if (profileId === 'attacker-supplied') return '/home/user/.cloudcli/claude-profiles/attacker-supplied';
      return null;
    },
    resolveSessionClaudeProfileId: (id: string) => (id === sessionId ? 'profile-personal' : null),
    spawnPty,
  };

  const socket = createFakeSocket();
  handleShellConnection(socket as never, dependencies);
  // A stale/buggy/malicious client claims a different profile than the one
  // actually bound to this session; the backend must not honour it.
  socket.emit('message', sessionShellInitMessage({ sessionId, claudeProfileId: 'attacker-supplied' }));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.env?.CLAUDE_CONFIG_DIR, '/home/user/.cloudcli/claude-profiles/profile-personal');
});

test('J: resolving a session-bound profile never touches the global process.env', () => {
  const { spawnPty } = createRecordingSpawnPty();
  const sessionId = uniqueId('session-work');
  const dependencies = {
    resolveProviderSessionId: () => null,
    resolveClaudeProfileConfigDir: (profileId: string) =>
      (profileId === 'profile-work' ? '/home/user/.cloudcli/claude-profiles/profile-work' : null),
    resolveSessionClaudeProfileId: (id: string) => (id === sessionId ? 'profile-work' : null),
    spawnPty,
  };

  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const socket = createFakeSocket();
  handleShellConnection(socket as never, dependencies);
  socket.emit('message', sessionShellInitMessage({ sessionId }));

  assert.equal(process.env.CLAUDE_CONFIG_DIR, originalConfigDir);
});

test('REAL child process: two sessions bound to different profiles get their own CLAUDE_CONFIG_DIR through the real OS process (no spawnPty mock)', async () => {
  const tempWork = await mkdtemp(path.join(os.tmpdir(), 'cc-real-session-work-'));
  const tempPersonal = await mkdtemp(path.join(os.tmpdir(), 'cc-real-session-personal-'));
  const workSessionId = uniqueId('real-session-work');
  const personalSessionId = uniqueId('real-session-personal');
  try {
    const dependencies = {
      resolveProviderSessionId: () => null,
      resolveClaudeProfileConfigDir: (profileId: string) => {
        if (profileId === 'profile-work') return tempWork;
        if (profileId === 'profile-personal') return tempPersonal;
        return null;
      },
      resolveSessionClaudeProfileId: (id: string) => {
        if (id === workSessionId) return 'profile-work';
        if (id === personalSessionId) return 'profile-personal';
        return null;
      },
      // spawnPty deliberately NOT provided: falls through to the real pty.spawn.
    };

    const workSocket = createFakeSocket();
    handleShellConnection(workSocket as never, dependencies);
    workSocket.emit(
      'message',
      sessionShellInitMessage({
        sessionId: workSessionId,
        isPlainShell: true,
        initialCommand: 'echo "CLAUDE_CONFIG_DIR_PROBE=$CLAUDE_CONFIG_DIR"',
      }),
    );
    await waitFor(() => collectOutput(workSocket).includes('CLAUDE_CONFIG_DIR_PROBE='));

    const personalSocket = createFakeSocket();
    handleShellConnection(personalSocket as never, dependencies);
    personalSocket.emit(
      'message',
      sessionShellInitMessage({
        sessionId: personalSessionId,
        isPlainShell: true,
        initialCommand: 'echo "CLAUDE_CONFIG_DIR_PROBE=$CLAUDE_CONFIG_DIR"',
      }),
    );
    await waitFor(() => collectOutput(personalSocket).includes('CLAUDE_CONFIG_DIR_PROBE='));

    assert.ok(collectOutput(workSocket).includes(`CLAUDE_CONFIG_DIR_PROBE=${tempWork}`));
    assert.ok(collectOutput(personalSocket).includes(`CLAUDE_CONFIG_DIR_PROBE=${tempPersonal}`));
  } finally {
    await rm(tempWork, { recursive: true, force: true });
    await rm(tempPersonal, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// REAL (non-mocked) integration tests.
//
// A Pixel test found that a real `Work → Login` wrote into the real, global
// `~/.claude` instead of Work's isolated directory. Root cause (proven
// separately, not by these tests): the *running server process* was a stale
// build compiled before this feature existed — the source code above was
// already correct, and the mocked `spawnPty` tests above already passed
// against it. That is exactly the gap: a mocked `env` object proves our code
// *builds* the right object, never that a real OS process actually receives
// it. These tests spawn a **real** child process — `dependencies.spawnPty`
// is intentionally left undefined so `shell-websocket.service.ts` falls
// through to the real `node-pty` `pty.spawn` it uses in production — and
// read back real process output, so a regression like "the env never
// actually reaches the child" cannot hide behind a mock again.
// ---------------------------------------------------------------------------

function isBinaryAvailable(command: string): boolean {
  try {
    execFileSync(command, ['--version'], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

const CLAUDE_BINARY_AVAILABLE = isBinaryAvailable('claude');

function waitFor(predicate: () => boolean, timeoutMs = 20000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error('Timed out waiting for condition'));
        return;
      }
      setTimeout(check, 100);
    };
    check();
  });
}

function collectOutput(socket: ReturnType<typeof createFakeSocket>): string {
  return socket.frames
    .map((frame) => JSON.parse(frame) as Record<string, unknown>)
    .filter((frame) => frame.type === 'output')
    .map((frame) => String(frame.data))
    .join('');
}

// Real terminal output from `claude` includes ANSI cursor-positioning codes
// (e.g. `[3G`) that a real pty/terminal renderer collapses visually but which
// land *between* characters in the raw string — e.g. `"loggedIn":` and
// `false` end up split by a cursor jump. Strip them before asserting on
// content, exactly as `shell-websocket.service.ts`'s own URL detection does.
const ANSI_ESCAPE_SEQUENCE_REGEX = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;
function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_SEQUENCE_REGEX, '');
}

test('REAL child process: CLAUDE_CONFIG_DIR set for a profile login is actually inherited by the OS process (no spawnPty mock)', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'cc-real-env-probe-'));
  try {
    const dependencies = {
      resolveProviderSessionId: () => null,
      resolveClaudeProfileConfigDir: (profileId: string) => (profileId === 'probe-profile' ? tempDir : null),
      // spawnPty deliberately NOT provided: falls through to the real pty.spawn.
    };

    const socket = createFakeSocket();
    handleShellConnection(socket as never, dependencies);
    socket.emit(
      'message',
      JSON.stringify({
        type: 'init',
        projectPath: process.cwd(),
        sessionId: `real-env-probe-${Date.now()}`,
        hasSession: false,
        provider: 'plain-shell',
        isPlainShell: true,
        initialCommand: 'echo "CLAUDE_CONFIG_DIR_PROBE=$CLAUDE_CONFIG_DIR"',
        claudeProfileId: 'probe-profile',
      }),
    );

    await waitFor(() => collectOutput(socket).includes('CLAUDE_CONFIG_DIR_PROBE='));

    const output = collectOutput(socket);
    assert.ok(
      output.includes(`CLAUDE_CONFIG_DIR_PROBE=${tempDir}`),
      `expected the real spawned shell to report CLAUDE_CONFIG_DIR=${tempDir}, got: ${output}`,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('REAL child process: omitting claudeProfileId means the real shell sees no CLAUDE_CONFIG_DIR at all', async () => {
  const socket = createFakeSocket();
  const dependencies = {
    resolveProviderSessionId: () => null,
    resolveClaudeProfileConfigDir: () => {
      throw new Error('must not be called when claudeProfileId is absent');
    },
  };

  handleShellConnection(socket as never, dependencies);
  socket.emit(
    'message',
    JSON.stringify({
      type: 'init',
      projectPath: process.cwd(),
      sessionId: `real-no-profile-${Date.now()}`,
      hasSession: false,
      provider: 'plain-shell',
      isPlainShell: true,
      initialCommand: 'echo "CLAUDE_CONFIG_DIR_PROBE=[$CLAUDE_CONFIG_DIR]"',
    }),
  );

  await waitFor(() => collectOutput(socket).includes('CLAUDE_CONFIG_DIR_PROBE='));

  const output = collectOutput(socket);
  assert.ok(output.includes('CLAUDE_CONFIG_DIR_PROBE=[]'), `expected an empty CLAUDE_CONFIG_DIR, got: ${output}`);
});

test(
  'REAL claude binary: two temporary profile dirs each report loggedIn:false independently, through the exact server code path (no spawnPty mock, no real login)',
  { skip: !CLAUDE_BINARY_AVAILABLE ? 'claude CLI not found on PATH' : false },
  async () => {
    const tempA = await mkdtemp(path.join(os.tmpdir(), 'cc-real-claude-a-'));
    const tempB = await mkdtemp(path.join(os.tmpdir(), 'cc-real-claude-b-'));
    try {
      const dependencies = {
        resolveProviderSessionId: () => null,
        resolveClaudeProfileConfigDir: (profileId: string) => {
          if (profileId === 'profile-a') return tempA;
          if (profileId === 'profile-b') return tempB;
          return null;
        },
      };

      const socketA = createFakeSocket();
      handleShellConnection(socketA as never, dependencies);
      socketA.emit(
        'message',
        JSON.stringify({
          type: 'init',
          projectPath: process.cwd(),
          sessionId: `real-claude-a-${Date.now()}`,
          hasSession: false,
          provider: 'plain-shell',
          isPlainShell: true,
          initialCommand: 'claude auth status',
          claudeProfileId: 'profile-a',
        }),
      );
      await waitFor(() => collectOutput(socketA).includes('loggedIn'));

      const socketB = createFakeSocket();
      handleShellConnection(socketB as never, dependencies);
      socketB.emit(
        'message',
        JSON.stringify({
          type: 'init',
          projectPath: process.cwd(),
          sessionId: `real-claude-b-${Date.now()}`,
          hasSession: false,
          provider: 'plain-shell',
          isPlainShell: true,
          initialCommand: 'claude auth status',
          claudeProfileId: 'profile-b',
        }),
      );
      await waitFor(() => collectOutput(socketB).includes('loggedIn'));

      const outputA = stripAnsi(collectOutput(socketA));
      const outputB = stripAnsi(collectOutput(socketB));

      // Both are fresh temp dirs: neither has ever been authenticated, and —
      // critically — neither may read the real default account's state. This
      // is the same shape of check that would have caught the Pixel bug: a
      // stale backend that ignores claudeProfileId would instead report the
      // real, already-authenticated default account's `loggedIn: true` here.
      assert.match(outputA, /"loggedIn":\s*false/, `profile-a output: ${outputA}`);
      assert.match(outputB, /"loggedIn":\s*false/, `profile-b output: ${outputB}`);
    } finally {
      await rm(tempA, { recursive: true, force: true });
      await rm(tempB, { recursive: true, force: true });
    }
  },
);

test('shell output detects and normalizes a wrapped authentication URL', () => {
  const pty = createFakePty();
  const socket = createFakeSocket();
  const dependencies = {
    resolveProviderSessionId: () => null,
    spawnPty: () => pty as never,
  };

  handleShellConnection(socket as never, dependencies);
  socket.emit(
    'message',
    JSON.stringify({
      type: 'init',
      projectPath: process.cwd(),
      sessionId: `wrapped-url-${Date.now()}`,
      hasSession: false,
      provider: 'plain-shell',
      isPlainShell: true,
      initialCommand: 'test-command',
    })
  );
  socket.frames.length = 0;

  pty.emitData("Continue in your browser: https://example.com/authorize?\ncode=abc\x1b[0m");

  const frames = socket.frames.map((frame) => JSON.parse(frame) as Record<string, unknown>);
  const authenticationFrame = frames.find((frame) => frame.type === 'auth_url');
  assert.deepEqual(authenticationFrame, {
    type: 'auth_url',
    url: 'https://example.com/authorize?code=abc',
    autoOpen: false,
  });

  pty.emitExit();
});
