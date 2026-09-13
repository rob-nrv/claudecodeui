# Android RuntimeNode and HC-06 (FT-M09)

This page covers:

- how to run an Android phone as a CloudCLI RuntimeNode;
- what CloudCLI can truthfully say about that node, and how `cloudcli node doctor` captures it as evidence;
- the HC-06 real-device procedure.

The currently proven route (HC-05, Pixel 9) is **Termux → proot-distro Ubuntu (aarch64) → CloudCLI node agent**. That is one proven environment, not the product abstraction. CloudCLI reasons about **capabilities with evidence**, never about "it is a phone".

Nothing here needs root, private Android APIs or Termux:API.

## What CloudCLI can prove about a node

Two places show the same evidence rules:

- **Settings > Remote access > Runtime nodes > What this node has proved**, for a connected node;
- `cloudcli node doctor`, on the node itself, without opening a link.

| Capability | How it is established | Can read |
| --- | --- | --- |
| Node runtime | The agent's own process: Node version, platform and architecture. "Android host" is detected from `ANDROID_ROOT`/`ANDROID_DATA` or `/system/build.prop`. Descriptive only. | Proven |
| Claude CLI | `claude --version` runs (8 s timeout). | Proven / Not available |
| Claude login | `claude auth status`, with no model call and no usage. The account identity is never kept. | Proven / Not available (not logged in) / Unknown |
| Headless run | Only a run **you** started that completed on this node within 24 h, read from the agent's run journal. No synthetic prompt is ever sent. | Proven / Not proven yet |
| Git | `git --version` runs. | Proven / Not available |
| Workspace folder | Workspace root is readable, plus a real write proof: a uniquely named probe file is created and removed. | Proven / Not available |
| Background execution | Only a person can prove it. If a running agent observes its own process being suspended (a timer arriving ≥ 30 s late), the Settings evidence says **Not available: process suspension observed** for 24 h. `doctor` is a one-shot check and always says **Needs device check**. | Needs device check / Not available |

Rules:

- Settings evidence counts only on the node's **current** link. Older proof reads **Proven earlier (out of date)** and is never used as proof.
- Capability reports travel only over the node's authenticated link, answering a probe the control plane asked for. A browser cannot write them.
- Availability for new runs still requires a proven Claude CLI. A signed-out login is shown, not guessed around.

## `cloudcli node doctor`

`doctor` checks a node locally and prints one report. It does **not**:

- open a node link (a running agent is never disturbed);
- send a prompt;
- change the enrollment.

Its only write is the workspace write probe, plus the `--output` file if you ask for one.

| Flag | Effect |
| --- | --- |
| `--state-dir <folder>` | Agent state to inspect (default `CLOUDCLI_NODE_AGENT_HOME` or `~/.cloudcli/node-agent`) |
| `--workspace-root <folder>` | Workspace root to check (default `WORKSPACES_ROOT` or home) |
| `--max-concurrent-runs <1-16>`, `--min-free-storage-mb <n>`, `--min-battery-percent <n>` | Governor policy to evaluate, same meaning as for `start` |
| `--json` | Print the evidence record as JSON instead of text |
| `--output <file>` | Also write the JSON record to a **new** file: owner-only (0600) on Linux/Android, never overwrites an existing file |
| `--no-network` | Skip the control plane reachability check |

**What it checks:**

- CloudCLI version and link protocol;
- Node version, platform, normalized architecture, Android host;
- enrollment: node id, control plane origin, enrollment time, whether `credential.json` is owner-only;
- state directory health and permissions;
- workspace root validity and write proof;
- every capability above;
- the governor policy, and admission evaluated as if no run were active (the doctor cannot see a running agent's runs);
- free storage, battery and thermal signals (unknown stays unknown);
- run journal health: missing / unreadable / ok, with unfinished runs, interrupted runs and last completed run;
- reachability of the control plane's public `GET /health`, with no credential and no signed header. Outcomes: reachable, unreachable, `tls_untrusted` for a certificate the node does not trust, or skipped.

**The record never contains:**

- the private or public key;
- an enrollment code;
- an auth token;
- the Claude account email or organization;
- environment values;
- file contents or file names from the workspace.

The paths of the state directory and workspace root are included.

**Exit codes:** `0` ready for runs; `2` not ready, with the blockers listed under **Result**; `1` usage error.

The link state of a *running* agent is not observable from `doctor`; Settings > Remote access shows it.

## Resource Governor

The node agent bounds its own work:

| Flag (`cloudcli node start`, also evaluated by `doctor`) | Default | Effect |
| --- | --- | --- |
| `--max-concurrent-runs <1-16>` | 2 | A run beyond the limit is refused with `RESOURCE_CONCURRENCY_LIMIT` |
| `--min-free-storage-mb <n>` | 512 (0 = off) | Refused with `RESOURCE_STORAGE_LOW` when free space in the workspace root is known and below it |
| `--min-battery-percent <n>` | off (0 = off) | Refused with `RESOURCE_BATTERY_LOW` when the battery is **known**, not charging (an unknown charging state counts as not charging), and below it |

How it applies:

- The checks run in that order, at every run start. Being exactly at a floor is allowed.
- A refused run is never queued, retried or moved to another node; the browser shows the reason.
- **Unknown signals never block and are never shown as healthy.** Inside Termux/proot, `/sys/class/power_supply` is usually denied, so the battery reads *unknown* and the battery floor has no effect.
- Thermal state has no portable, permission-free source, so it is always *unknown*.
- The control plane's own node is not governed.

## Durability: exact guarantees

| Situation | Behavior |
| --- | --- |
| Browser reload or disconnect | The run continues on the node; a reloaded browser resubscribes. |
| Network blip shorter than 20 s | The node keeps running. On reconnect it replays exactly the frames the control plane missed; already-seen frames are dropped. No re-dispatch. |
| Link silent (half-open, e.g. Wi-Fi → mobile switch) | The node pings every 20 s and drops a link with no answer for 60 s; the control plane terminates links silent for 60 s. Both then follow the normal disconnect path. |
| Link down longer than 20 s | The control plane fails the run explicitly ("not moved to another node"), and the node aborts it so nothing runs unobserved. |
| Agent stopped with Ctrl+C / SIGTERM | Runs are aborted and recorded as aborted. |
| Agent killed hard, then restarted | The run journal marks the unfinished run **interrupted**. It is never resumed or re-run, and its execution id is refused if it is ever dispatched again. |
| Control plane restarted | A reconnecting node's runs are not taken back; the node aborts them. |

**Non-guarantees:**

- A run does **not** survive the agent process dying.
- If the agent is killed with SIGKILL, a Claude child process might outlive it; CloudCLI cannot guarantee it was terminated (HC-06 step 7 records what actually happens).
- Background survival with the screen off is unproven until a person checks it.

**The run journal** (`<state-dir>/run-journal.json`, owner-only) holds execution ids, session ids, times and outcomes only — no prompt, output, path or credential. A damaged journal reads as *unreadable* and proves nothing; the agent starts a new one.

## Reproducible setup (isolated, non-destructive)

The HC-06 setup runs **side by side** with the existing HC-05 environment. It uses:

- a separate proot container named `cloudcli-hc06`;
- a separate state directory and a separate workspace root;
- a **new node enrollment**.

It never modifies, reinstalls, renames, restores or removes the existing distribution or its node identity.

> These are reference commands for a person to run on the device. They were not executed by automation. Stop and record the output whenever a command behaves differently from what is described.

### Prerequisites

- An ARM64 Android phone with Termux from F-Droid or GitHub (the Play Store build is outdated).
- The CloudCLI control plane with the Remote Gateway enabled ([remote-access-and-runtime-nodes.md](remote-access-and-runtime-nodes.md)).
- A Claude account you are willing to sign in with on the phone.

### 1. Termux (on device)

```sh
pkg update
pkg install proot-distro git
```

Optional: `termux-wake-lock` keeps the CPU awake while Termux runs. It changes device behavior and is not proof of background execution.

### 2. Isolated container (on device, guarded)

```sh
proot-distro list
proot-distro install --help
```

**Before installing, all three checks must pass:**

1. Record the `proot-distro list` output (evidence that the HC-05 distribution exists and is untouched).
2. If `cloudcli-hc06` **already appears** in the list, **stop**. Do not remove, rename or restore anything; record it.
3. Read the `install --help` output:
   - if it lists `--name`, run `proot-distro install --name cloudcli-hc06 ubuntu`;
   - if it lists only `--override-alias`, run `proot-distro install --override-alias cloudcli-hc06 ubuntu`;
   - if it lists neither, **stop** and record your version. Do not install over, reset or restore the existing distribution.

`ubuntu` is the distribution used for HC-05; use the same name your `proot-distro list` shows for it.

Then log in to the new container only:

```sh
proot-distro login cloudcli-hc06
apt update && apt install -y curl git ca-certificates build-essential python3
```

### 3. Node (glibc build inside the container, not Termux's Node)

```sh
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
. ~/.nvm/nvm.sh
nvm install 22
```

`doctor` (step 6) reports the Node version and platform; `command -v node` must not point under `/data/data/com.termux`.

### 4. CloudCLI

```sh
git clone <your CloudCLI repository URL> ~/cloudcli
cd ~/cloudcli
git checkout <commit under test>
npm ci --no-audit --no-fund
npm run build:server
```

### 5. Claude Code (do not sign in yet)

```sh
npm install -g @anthropic-ai/claude-code
```

### 6. Workspace root, test project, first doctor

```sh
mkdir -p ~/cloudcli-workspaces-hc06 ~/hc06
git clone <test project URL> ~/cloudcli-workspaces-hc06/<project>
node ~/cloudcli/dist-server/server/modules/cli/cli.js node doctor --state-dir ~/.cloudcli/node-agent-hc06 --workspace-root ~/cloudcli-workspaces-hc06 --no-network --output ~/hc06/E0-before-enroll.json
```

Use a clone of a project that also exists on the control plane.

Expected result: **NOT READY**, with blockers `not enrolled` and `claude not logged in`. Every toolchain row should be Proven: Node runtime (`linux arm64`, Android host), Claude CLI, Git, Workspace folder. Anything else is a setup finding to record before going further.

### 7. Enroll (code from Settings > Remote access)

```sh
# Only if the gateway uses a private CA:
export NODE_EXTRA_CA_CERTS=/path/to/ca.pem
node ~/cloudcli/dist-server/server/modules/cli/cli.js node enroll --server https://<gateway-origin> --code <one-time code> --label "Pixel HC-06" --state-dir ~/.cloudcli/node-agent-hc06
node ~/cloudcli/dist-server/server/modules/cli/cli.js node doctor --state-dir ~/.cloudcli/node-agent-hc06 --workspace-root ~/cloudcli-workspaces-hc06 --max-concurrent-runs 1 --output ~/hc06/E1-enrolled.json
```

- **Control plane:** `reachable` is expected. `tls_untrusted` means `NODE_EXTRA_CA_CERTS` is missing or wrong; fix that before starting.
- Never paste the code, a key or `credential.json` into notes or screenshots.

### 8. Start, with a log file for evidence

In a dedicated Termux session inside `cloudcli-hc06`:

```sh
node ~/cloudcli/dist-server/server/modules/cli/cli.js node start --state-dir ~/.cloudcli/node-agent-hc06 --workspace-root ~/cloudcli-workspaces-hc06 --max-concurrent-runs 1 2>&1 | tee -a ~/hc06/agent.log
```

### Cleanup boundaries

- Revoke **Pixel HC-06** in Settings > Remote access. The HC-05 node stays.
- Inside `cloudcli-hc06` only:

  ```sh
  rm -rf ~/.cloudcli/node-agent-hc06 ~/cloudcli-workspaces-hc06 ~/hc06
  ```

- To remove the whole isolated container, from Termux (outside any container), first read `proot-distro list` and check the name twice:

  ```sh
  proot-distro remove cloudcli-hc06
  ```

  Never remove the HC-05 distribution.

## HC-06 procedure

**Roles:**

- **P** — the Windows PC control plane.
- **A** — the Pixel, isolated `cloudcli-hc06` node.
- **B** — a browser device.

**Legend:**

- **[auto]** — `doctor` or a log count produces the evidence.
- **[user]** — needs you in CloudCLI.
- **[device]** — needs physical device actions.

All evidence files go to `~/hc06/` on A. They contain no secrets (see *The record never contains* above).

The doctor command used in the steps below:

```sh
node ~/cloudcli/dist-server/server/modules/cli/cli.js node doctor --state-dir ~/.cloudcli/node-agent-hc06 --workspace-root ~/cloudcli-workspaces-hc06 --max-concurrent-runs 1 --output ~/hc06/<name>.json
```

1. **[device] Isolated setup.** Steps 1-6 above, with `E0-before-enroll.json`. Record `proot-distro list` before and after.
2. **[user][auto] Enroll and start.**
   - Steps 7-8, with `E1-enrolled.json`: enrolled, control plane reachable, credential file owner-only.
   - On P, Settings lists *Pixel HC-06* as Available next to the HC-05 node. Take one screenshot of its *What this node has proved*.
3. **[auto] Signed-out evidence.** `E1-enrolled.json` must show:
   - Claude login: Not available (not logged in);
   - Headless run: Not proven yet;
   - Background execution: Needs device check;
   - every toolchain row Proven.
4. **[user][device] Real headless run** (uses real Claude usage).
   1. In a second Termux session inside `cloudcli-hc06`, run `claude` and sign in.
   2. Run the doctor to `E2-signed-in.json`: Claude login is Proven.
   3. On B, open the project, choose Run on *Pixel HC-06*, map `~/cloudcli-workspaces-hc06/<project>`, send `Run uname -m and pwd`, approve. The output shows `aarch64` and A's folder.
   4. Run the doctor to `E3-after-run.json`: Headless run is Proven, and the journal's last completed run is set.
5. **[user] Workspace state.**
   1. The picker shows *Folder on Pixel HC-06: No uncommitted changes · <branch>*.
   2. On A: `echo hc06 >> ~/cloudcli-workspaces-hc06/<project>/README.md`. Re-select the node: *1 uncommitted change(s)*. The PC copy is not involved.
   3. Undo with `git -C ~/cloudcli-workspaces-hc06/<project> checkout README.md`.
6. **[device] Reconnect.**
   1. Send a long task (for example `Count slowly from 1 to 60 using sleep 1 in bash`).
   2. Airplane mode on A for about 10 s, then back: the stream resumes on B.
   3. Repeat with 90 s: B shows *Lost the connection … not moved to another node*.
7. **[device][auto] Agent restart.**
   1. During a long run, from another Termux session in the container: `pgrep -f "cli.js node start"`, then `kill -9 <pid>`.
   2. Run `pgrep -f claude` and record its output right away: this answers the SIGKILL non-guarantee.
   3. Restart step 8's command: the log says `1 run(s) were interrupted …`.
   4. Run the doctor to `E4-after-kill.json`: the journal shows `interrupted` ≥ 1, and nothing re-ran.
8. **[auto] No duplicate execution.** `grep -c "accepted for session" ~/hc06/agent.log` must equal the number of messages B sent to *Pixel HC-06* that were not refused.
9. **[user][auto] Resource Governor.**
   1. With `--max-concurrent-runs 1`, start a long run in session X, then send in another session Y bound to *Pixel HC-06*.
   2. B shows *already running as many sessions as it allows … not moved to another node*.
   3. `grep "refused by the resource governor: RESOURCE_CONCURRENCY_LIMIT" ~/hc06/agent.log` finds it.
   4. Run the doctor with `--min-free-storage-mb 1048576` to `E5-storage-floor.json`: blocker `resources storage low`.
   5. Restart the agent with the same flag and send once: the send is refused with the low-storage message.
   6. Restart without the flag.
10. **[device] Background execution.**
    1. Start a long run, turn the screen off for 5 minutes, turn it on.
    2. Record whether the run finished (timestamps in `agent.log`), and whether Settings now shows *Not available: process suspension observed*.
    3. Repeat once with `termux-wake-lock`.
11. **[user] No silent failover.** Stop the agent (Ctrl+C) and send in a *Pixel HC-06* session. B shows *… is offline. The message was not sent, and it was not moved to another node.* P ran nothing.
12. **[user] Identity and mapping.**
    1. Map the same project on the HC-05 node and on *Pixel HC-06* to their different folders; both work, and P shows one project.
    2. Map *Pixel HC-06* to a different repository folder: *Holds a different repository than when it was mapped*.
    3. Map it back.

**Evidence to keep:**

- `~/hc06/E0…E5*.json`;
- `~/hc06/agent.log`;
- the one Settings screenshot;
- screenshots of B for steps 4, 6, 9 and 11;
- the `proot-distro list` and `pgrep` outputs;
- the step 10 timings.

Never include codes, keys or `credential.json`.

**Classify each Android autonomy claim:**

| Claim | VALIDATED when | CONDITIONAL when | UNKNOWN when |
| --- | --- | --- | --- |
| Isolated reproducible setup | Steps 1-2 pass with the original distro untouched | Passed with recorded deviations | Not attempted |
| Truthful capability evidence | E0-E3 match the expectations and Settings agrees | Some rows differ with an explained cause | Not recorded |
| Headless Claude execution | Step 4 passes (E3 proves it) | Needed retries or manual fixes | Not run |
| Reconnect / no duplicate | Steps 6 and 8 pass | Only the short blip passed | Not run |
| Restart honesty | Step 7 passes and no orphan Claude process | Passes, but an orphan was observed | Not run |
| Resource Governor | Step 9 passes | Only concurrency verified | Not run |
| Background execution | Runs finished with the screen off, and no suspension was observed | Only with `termux-wake-lock`, or a suspension was observed | Screen-off test not done |
| No silent failover | Step 11 passes | — | Not run |
| Portable identity / mapping | Steps 5 and 12 pass | Identity shown as *unrecorded* only | Not run |

HC-06 is a human validation: CloudCLI automation never declares it passed.
