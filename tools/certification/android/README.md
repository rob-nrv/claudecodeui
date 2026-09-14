# Android RuntimeNode certification harness (HC-06 and beyond)

Automates as much of the HC-06 Android RuntimeNode procedure
(`docs/android-runtime-node.md`) as can be automated without an auth bypass
or direct database access, so a person only does the handful of things that
genuinely require a physical Android action — airplane mode, locking the
screen, the one-time Claude/enrollment sign-ins.

This is deliberately **not** a one-shot HC-06 script: it is a small,
reusable library (`lib/`) plus two thin CLI entrypoints, so the next
RuntimeNode certification (a different phone, a future capability) reuses
the same pieces instead of starting over.

**HC-06 is still a human validation.** This harness collects evidence and
classifies it (`VALIDATED` / `CONDITIONAL` / `FAILED` / `SKIPPED` /
`UNKNOWN`); it never unilaterally declares HC-06 passed. A `CONDITIONAL`
result (the SIGKILL orphan-cleanup finding, currently) never rounds up to
`VALIDATED` just because everything else did.

## Architecture

```
tools/certification/android/
  lib/                          pure decision logic — unit-tested, no
                                 device/server/network required
    classification.mjs          VALIDATED/CONDITIONAL/FAILED/SKIPPED/UNKNOWN
                                 rules; import vs record; overall status
    evidence.mjs                the one module that touches disk: the
                                 append-only, resumable evidence folder
    resume-state.mjs            "can we resume the existing HC-06 env, or
                                 must we stop" — including the a31c3765 floor
    log-parser.mjs               parses agent.log text into structured events
    doctor-report.mjs           reads an already-parsed `doctor --json` report
    process-ownership.mjs       "did we actually start this process, is it
                                 safe to signal" — never a broad pkill/killall
    human-checkpoint.mjs        the "ask a human to do something physical,
                                 then detect what happened, with a timeout"
                                 state machine
    with-restore.mjs            generic "apply, run, ALWAYS restore" guard
                                 (governor swaps, throwaway workspace mappings)
    control-plane-client.mjs    thin wrapper over CloudCLI's EXISTING
                                 authenticated REST routes (login, runtime
                                 nodes, workspace mapping, session creation)
    chat-frame-classifier.mjs   reads the chat WebSocket's frames (the same
                                 ones the browser gets) into "offline
                                 refusal" / "link lost" / "governor refusal" /
                                 "completed" / etc.
  tests/                        node:test files for everything in lib/ —
                                 fake fetch, fake sockets, fake clocks, a real
                                 temp directory for evidence.mjs. No real
                                 Pixel or control plane required.
  control-plane-runner.mjs      Windows/PC-side CLI: talks to the control
                                 plane over its real REST/WebSocket surface
  device-runner.mjs             Android/Termux-side CLI: supervises the
                                 node-agent as a child process, runs
                                 `cloudcli node doctor`, parses its own log
```

### Why `device-runner.mjs` (Node), not `device-runner.sh`

The mission brief sketches a `device-runner.sh`. This harness implements it
as a Node script instead: Node 22 is already required and present on the
device (it's how the node-agent itself runs), and writing it in Node lets it
reuse the exact same tested `lib/*.mjs` modules the PC side uses — JSON and
log parsing, evidence writing, process-ownership checks — instead of
re-implementing that logic a second time in shell, where it would be
untested. The **user-visible surface is still one command**: `node
device-runner.mjs <command>`.

### Why two processes, not one coordinated program

The control plane and the Android device are different machines with no
back-channel between the two runner scripts themselves (adding one would
mean a new server endpoint, which was explicitly out of scope). Coordination
between them is the human: the PC side prints exactly what to run on the
device and waits; the device side prints exactly what to check on the PC.
Neither side ever guesses at the other's state.

## What is fully automated

- Reading `cloudcli node doctor --json` and asserting on it (blockers,
  capability transitions, journal counts) — `lib/doctor-report.mjs`.
- Starting/stopping/restarting the node-agent as this runner's own tracked
  child process, never a detached daemon it loses the pid of.
- Parsing `agent.log` for accepted/duplicate/outcome/reconnect evidence.
- The control-plane side of: no-silent-failover (stop the agent, guided;
  send one message; assert the explicit `RUNTIME_NODE_OFFLINE` refusal),
  the repository-identity mismatch (map a throwaway repo; assert
  `identity_mismatch`; always restore the real mapping even if the
  assertion fails), and a harness-driven reconnect test (dispatch a long
  countdown, wait through a human network action, classify the outcome).
- The storage-governor floor (device restarts itself with
  `--min-free-storage-mb 1048576`, asserts the doctor blocker, always
  restores the default flags — even if the assertion throws).
- The SIGKILL test's *mechanics*: capturing exact pid ownership before ever
  signalling anything, `kill -9` only that one verified pid, then checking
  named survivors afterward. It does **not** auto-decide whether an orphan
  found this way is safe to clean up — see Safety guarantees.
- Evidence: append-only, resumable, secret-scanned before every write.

## Human actions that remain (minimized)

- Airplane mode on/off (the reconnect tests).
- Locking/unlocking the screen (the background-execution test).
- The one-time Claude sign-in and the one-time enrollment code (both
  already done for the current Pixel — resume mode skips them).
- Confirming each command the runner prints ("press Enter once you've...")
  — these are cheap checkpoints, not blind waits.

## Safety guarantees

- **No auth bypass, no direct DB writes.** `control-plane-runner.mjs` only
  calls `POST /api/auth/login`, `GET/PUT/DELETE /api/runtime-nodes/...` and
  `POST /api/providers/sessions` — the same authenticated routes the
  browser uses. See `lib/control-plane-client.mjs`.
- **Never a broad kill.** `lib/process-ownership.mjs#isSafeKillCommand`
  accepts only `kill [-signal] <one explicit pid>`; `pkill`, `killall`, a
  negative pid (process group) or more than one pid are all refused by
  construction. `planSafeSignal` only clears a pid the runner itself
  recorded starting, re-verified by cmdline (and start time, when the
  device's `ps` exposes one) against the current process — a pid whose
  cmdline no longer matches, or whose start time changed, reads as **not
  owned** (the pid was reused by something else), never as "close enough".
- **Governor/workspace changes always restore.** `lib/with-restore.mjs`
  guarantees the restore step runs whether the test passed, failed, or the
  *apply* step itself failed — and reports `restored: false` explicitly
  rather than ever silently assuming success.
- **The mismatch-repo scratch folder is triple-guarded.**
  `make-mismatch-repo`/`remove-mismatch-repo` refuse anything outside the
  configured workspace root, and removal additionally refuses a folder that
  isn't named with "mismatch" and doesn't contain this runner's own marker
  file — it will not remove a folder it didn't create.
- **Evidence never carries a secret.** `lib/evidence.mjs#findForbiddenField`
  scans every object before it's written (curated key names — private/public
  keys, tokens, the enrollment code, account email/org, `Authorization`
  headers — deliberately **not** a bare `code` or `credential`, which are
  legitimate REST/WS/doctor field names) and refuses the write instead of
  redacting-and-continuing.
- **Nothing is silently declared VALIDATED.** `lib/classification.mjs`:
  overall status is the worst status present; an imported result cannot be
  overwritten by a later import without an explicit `supersede: true`; the
  known SIGKILL orphan finding is recorded as `CONDITIONAL` and stays that
  way until an actual clean re-test supersedes it.

## Resume mode (the default)

Every command resolves the *same* evidence folder across separate
invocations (`lib/evidence.mjs#resolveCertificationDir`, via a
`.certification-current` pointer file under `~/hc06`) instead of starting a
disconnected new one each time — evidence accumulates across a whole HC-06
session, including across a restart of the runner itself.

`device-runner.mjs check-commit` / `status` enforce the required floor:
Pixel source must include commit `a31c3765` (the HC-06 reconnect-fix — see
`docs/android-runtime-node.md`). If the ancestor check can't even be run
(not a git checkout, unknown commit), that is treated exactly as
conservatively as "too old" — never assumed fine.

Nothing in resume mode re-enrolls the node, re-authenticates Claude, or
touches `~/.cloudcli/node-agent-hc06` / `~/hc06` / the mapped workspace.

## Fresh-setup mode

Not built in this pass — resume mode (the current, real Pixel HC-06
environment) was the priority, and the mission explicitly said not to
jeopardize it to make bootstrap fancy. The manual steps in
`docs/android-runtime-node.md` §"Reproducible setup" remain the procedure
for a brand-new device; `device-runner.mjs`'s `lib/` pieces (evidence,
resume-state, doctor-report) are already reusable from a future bootstrap
script without change.

## Running the harness's own tests

```sh
node --test tools/certification/android/tests/*.test.mjs
```

No real Pixel, no running control plane, no network — fakes and a real
temporary directory only (see each test file's fixtures).

## Configuration

`control-plane-runner.mjs` (environment variables — never CLI arguments,
so credentials never land in shell history):

| Variable | Meaning |
| --- | --- |
| `CLOUDCLI_BASE_URL` | e.g. `https://192.168.1.36:3443` |
| `CLOUDCLI_USERNAME` / `CLOUDCLI_PASSWORD` | your own CloudCLI login |
| `HC06_PROJECT_ID` / `HC06_PROJECT_PATH` | the project both nodes map |
| `HC06_NODE_LABEL` | default `Pixel HC-06` |
| `HC06_EVIDENCE_DIR` | default `tools/certification/android/evidence` |

`device-runner.mjs` (defaults already match the mission's stated current
Pixel state):

| Variable | Default |
| --- | --- |
| `HC06_SRC` | `~/cloudcli-hc06-src` |
| `HC06_STATE_DIR` | `~/.cloudcli/node-agent-hc06` |
| `HC06_WORKSPACE_ROOT` | `~/cloudcli-workspaces-hc06` |
| `HC06_HOME` | `~/hc06` |

## Known limitations

- `sigkill-test` detects orphan survivors and prints the exact `kill -9
  <pid>` for each, but never signals them itself — that step is a printed
  suggestion for a human to confirm and run, matching the mission's "if
  automatic safe cleanup cannot be proved, stop and ask" instruction. It
  does not attempt to fix the underlying runtime limitation (a Claude/Bash
  child surviving its parent node-agent's SIGKILL) — that is a real product
  behavior worth its own, separate fix, not something to patch inside a
  certification tool.
- The device's `ps` (Termux/toybox) has no portable process-start-time
  field, so `process-ownership.mjs` ownership checks after the *first*
  verification run at `confidence: 'low'` (cmdline match only) rather than
  `'high'` — by design, this is never auto-signalled without a human
  confirming it, per `planSafeSignal`.
- Cross-machine coordination is entirely human-mediated (see "Why two
  processes"); there is no live sync between `control-plane-runner.mjs` and
  `device-runner.mjs` beyond what each prints for the other side to act on.
