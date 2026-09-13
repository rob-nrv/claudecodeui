# Android RuntimeNode and HC-06 (FT-M09)

This page describes how to run an Android phone as a CloudCLI RuntimeNode, what
CloudCLI can truthfully say about it, and the HC-06 real-device procedure.

The currently proven route (HC-05, Pixel 9) is **Termux → proot-distro Ubuntu
(aarch64) → CloudCLI node agent**. That is one proven environment, not the
product abstraction: CloudCLI reasons about **capabilities with evidence**,
never about "it is a phone".

Nothing here needs root, private Android APIs or Termux:API.

## What CloudCLI can prove about a node

Open **Settings > Remote access > Runtime nodes**, then **What this node has
proved** under the node.

| Capability | How it is established | Can read |
| --- | --- | --- |
| Node runtime | The agent's own process: Node version, platform, architecture. "Android host" is detected from `ANDROID_ROOT`/`ANDROID_DATA` or `/system/build.prop`. Descriptive only. | Proven |
| Claude CLI | `claude --version` runs, 8 s timeout. | Proven / Not available |
| Claude login | `claude auth status` (no model call, no usage). The account identity is never kept. | Proven / Not available (not logged in) / Unknown |
| Headless run | Only a run **you** started that completed on this node within 24 h (from the agent's run journal). No synthetic prompt is ever sent. | Proven / Not proven yet |
| Git | `git --version` runs. | Proven / Not available |
| Workspace folder | Workspace root readable, plus a real write proof (a uniquely named probe file created and removed). | Proven / Not available |
| Background execution | Only a person can prove it. If the agent observes that its own process was suspended (a timer arriving ≥ 30 s late), it reports **Not available: process suspension observed** for 24 h. | Needs a check on the device / Not available |

Rules:

- Evidence counts only on the node's **current** link; older proof reads
  **Proven earlier (out of date)** and is never used as proof.
- Capability reports travel only over the node's authenticated link, answering
  a probe the control plane asked for. A browser cannot write them.
- Availability for new runs still requires a proven Claude CLI (FT-M08 rule); a
  signed-out login is shown, not guessed around.

## Resource Governor

The node agent bounds its own work:

| Flag (`cloudcli node start`) | Default | Effect |
| --- | --- | --- |
| `--max-concurrent-runs <1-16>` | 2 | A run beyond the limit is refused with `RESOURCE_CONCURRENCY_LIMIT`. |
| `--min-free-storage-mb <n>` | 512 (0 = off) | Refused with `RESOURCE_STORAGE_LOW` when free space in the workspace root is known and below it. |
| `--min-battery-percent <n>` | off | Refused with `RESOURCE_BATTERY_LOW` when the battery is **known**, not charging, and below it. |

- Checks run in that order, at every run start.
- A refused run is never queued, retried or moved to another node; the browser
  shows the reason.
- **Unknown signals never block and are never shown as healthy.** Inside
  Termux/proot, `/sys/class/power_supply` is usually denied, so the battery
  reads *unknown* and the battery floor has no effect. Thermal state has no
  portable permission-free source and is always *unknown*.
- The control plane's own node is not governed and reports no resource state.

## Durability: exact guarantees

| Situation | Behavior |
| --- | --- |
| Browser reload or disconnect | The run continues on the node; a reloaded browser resubscribes (FT-M08). |
| Network blip shorter than 20 s | The node keeps running; on reconnect it replays exactly the frames the control plane missed (seq-checked). No re-dispatch. |
| Link silent (half-open, e.g. Wi-Fi → mobile switch) | The node pings every 20 s and drops a link with no answer for 60 s. The control plane terminates links silent for 60 s. Both then follow the normal disconnect path. |
| Link down longer than 20 s | The control plane fails the run explicitly ("not moved to another node"); the node aborts it so nothing runs unobserved. |
| Agent stopped with Ctrl+C / SIGTERM | Runs are aborted and recorded as aborted. |
| Agent killed hard, then restarted | The run journal marks the unfinished run **interrupted**. It is never resumed or re-run, and its execution id is refused if ever dispatched again. |
| Control plane restarted | A reconnecting node's runs are not taken back; the node aborts them. |

Non-guarantees:

- A run does **not** survive the agent process dying.
- If the agent is killed with SIGKILL, a Claude child process might outlive it
  briefly; CloudCLI cannot guarantee it was terminated (HC-06 step 7 records
  what actually happens).
- Background survival with the screen off is unproven until a person checks it.

The journal (`<state-dir>/run-journal.json`, owner-only) holds execution ids,
session ids, times and outcomes only — no prompt, output, path or credential.
`cloudcli node status` summarizes it.

## Reproducible setup (isolated, non-destructive)

The HC-06 setup is **side by side** with the existing HC-05 environment. It uses
a separate proot distribution, a separate state directory, a separate workspace
root and a **new node enrollment**. It never modifies, reinstalls or removes
the existing distribution or its node identity.

> The commands below are reference commands for a person to run on the device.
> They were not executed by FT-M09 automation. Stop and record the output if a
> command behaves differently on your versions.

### Prerequisites

- An ARM64 Android phone with Termux from F-Droid or GitHub (the Play Store build is outdated).
- The CloudCLI control plane with the Remote Gateway enabled ([remote-access-and-runtime-nodes.md](remote-access-and-runtime-nodes.md)).
- A Claude account you are willing to sign in with on the phone.

### 1. Termux (user, on device)

```sh
pkg update
pkg install proot-distro git
```

Optional: `termux-wake-lock` keeps the CPU awake while Termux runs. It changes
the device's behavior; it is not proof of background execution.

### 2. Isolated Ubuntu (user, on device)

```sh
proot-distro list
proot-distro install --override-alias cloudcli-hc06 ubuntu
proot-distro login cloudcli-hc06
```

If your `proot-distro` does not support `--override-alias` (check
`proot-distro install --help`), **stop**. Do not reinstall or reset the
existing distribution; record the version instead.

Inside the new distribution:

```sh
apt update && apt install -y curl git ca-certificates build-essential python3
uname -m    # expect aarch64
```

### 3. Node (glibc build inside Ubuntu, not Termux's Node)

```sh
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
. ~/.nvm/nvm.sh
nvm install 22
command -v node   # must NOT be under /data/data/com.termux
```

### 4. CloudCLI

```sh
git clone <your CloudCLI repository URL> ~/cloudcli
cd ~/cloudcli
git checkout <commit under test>
npm ci --no-audit --no-fund
npm run build:server
```

### 5. Claude Code and login (user)

```sh
npm install -g @anthropic-ai/claude-code
claude --version
```

Do not sign in yet: HC-06 first records the signed-out state (step 8). Sign in
later with `claude`, then check `claude auth status`.

### 6. Workspace root and test project

```sh
mkdir -p ~/cloudcli-workspaces-hc06
git clone <test project URL> ~/cloudcli-workspaces-hc06/<project>
```

Use a clone of a project that also exists on the control plane.

### 7. Enroll (user: code from Settings > Remote access)

```sh
# Only if the gateway uses a private CA:
export NODE_EXTRA_CA_CERTS=/path/to/ca.pem
node ~/cloudcli/dist-server/server/modules/cli/cli.js node enroll \
  --server https://<gateway-origin> --code <one-time code> \
  --label "Pixel HC-06" --state-dir ~/.cloudcli/node-agent-hc06
```

Never write the code, the key or `credential.json` into notes or screenshots.

### 8. Start

```sh
node ~/cloudcli/dist-server/server/modules/cli/cli.js node start \
  --state-dir ~/.cloudcli/node-agent-hc06 \
  --workspace-root ~/cloudcli-workspaces-hc06 \
  --max-concurrent-runs 1
```

The log prints the governor policy. `node status --state-dir …` shows identity
and the journal summary.

### Cleanup boundaries

- Revoke **Pixel HC-06** in Settings > Remote access (the HC-05 node stays).
- Inside `cloudcli-hc06` only: `rm -rf ~/.cloudcli/node-agent-hc06 ~/cloudcli-workspaces-hc06`.
- Removing the whole isolated distribution: `proot-distro remove cloudcli-hc06`.
  Read the alias twice first; never remove the HC-05 distribution.

## HC-06 procedure

**Roles:**

- **P**: the Windows PC control plane.
- **A**: the Pixel, isolated `cloudcli-hc06` node.
- **B**: a browser device.

Steps marked **[device]** or **[user]** need a person.

1. **Isolated setup** [device]. Complete steps 1-6 above. Record the
   `proot-distro list` output before and after, showing the original
   distribution untouched.
2. **Enroll and start** [device]. Steps 7-8. On P, Settings lists
   *Pixel HC-06* as Available, next to the HC-05 node.
3. **Capability evidence, signed out** [user]. Open *What this node has proved*.
   Expected:
   - Node runtime: Proven, `linux arm64 (Android host)`.
   - Claude CLI: Proven.
   - Claude login: Not available (not logged in).
   - Headless run: Not proven yet.
   - Git: Proven.
   - Workspace folder: Proven (write verified).
   - Background execution: Needs a check on the device.

   Screenshot it.
4. **Real headless run** [user, uses real Claude usage]. Sign in on A
   (`claude`), refresh the node list: Claude login is Proven. On B, open the
   project, Run on *Pixel HC-06*, map `~/cloudcli-workspaces-hc06/<project>`,
   send `Run uname -m and pwd`, approve. Output shows `aarch64` and A's folder.
   Refresh evidence: Headless run is Proven.
5. **Workspace state** [user]. The picker shows *Folder on Pixel HC-06: No
   uncommitted changes · <branch>*. On A: `echo hc06 >> README.md`; re-select
   the node: *1 uncommitted change(s)*. The PC's own copy is not involved:
   compare with `git status` on P. Undo on A with `git checkout README.md`.
6. **Reconnect** [device].
   1. Send a long task (for example `Count slowly from 1 to 60 using sleep 1 in bash`).
   2. Toggle airplane mode on A for about 10 s, then back.
   3. The stream resumes on B, and A's log shows one `Run … accepted` for it.
   4. Repeat with airplane mode for 90 s: B shows an explicit *Lost the
      connection … not moved to another node*, and A logs the abort.
7. **Agent restart** [device].
   1. During a long run, from a second Termux session in the same distribution,
      run `pgrep -f "node start"`, then `kill -9 <pid>`.
   2. Record `pgrep -f claude` right after: this answers the SIGKILL
      non-guarantee.
   3. Restart the agent. The log says `1 run(s) were interrupted …`, and
      `node status` shows it.
   4. Nothing re-ran.
8. **No duplicate execution** [user]. Across steps 4-7, count `Run … accepted`
   lines on A: exactly one per message sent from B.
9. **Resource Governor** [user].
   1. With `--max-concurrent-runs 1`, start a long run in session X, then send
      in another session Y bound to *Pixel HC-06*. B shows *already running as
      many sessions as it allows … not moved to another node*, and A logs
      `refused by the resource governor: RESOURCE_CONCURRENCY_LIMIT`.
   2. Restart the agent with `--min-free-storage-mb 1048576`. Any send is
      refused with the low-storage message.
   3. Record the Settings resource line, including *battery unknown* if so.
10. **Unknown / unavailable** [device]. Record Background execution before and
    after a screen-off test: start a long run, turn the screen off for 5
    minutes, turn it on. Record whether the run finished (A's log timestamps)
    and whether the capability flipped to *process suspension observed*.
    Repeat once with `termux-wake-lock`.
11. **No silent failover** [user]. Stop the agent (Ctrl+C) and send in a
    *Pixel HC-06* session. B shows *… is offline. The message was not sent, and
    it was not moved to another node.* P ran nothing.
12. **Identity and mapping** [user].
    1. Map the same project on the HC-05 node and on *Pixel HC-06* to their
       different folders; both work. The project in P's sidebar is one project.
    2. Map *Pixel HC-06* to a different repository folder: *Holds a different
       repository than when it was mapped*.
    3. Map it back.

**Evidence to record:**

- screenshots from steps 3, 4, 5, 9 and 11;
- A's agent log;
- `node status` output;
- `proot-distro list` before and after;
- the step 7 `pgrep` outputs;
- the step 10 timings.

Never include codes, keys or `credential.json`.

**Classify each Android autonomy claim:**

| Claim | VALIDATED when | CONDITIONAL when | UNKNOWN when |
| --- | --- | --- | --- |
| Isolated reproducible setup | Steps 1-2 pass with the original distro untouched | Passed with deviations recorded | Not attempted |
| Truthful capability evidence | Step 3 matches | Some rows differ with an explained cause | Not recorded |
| Headless Claude execution | Step 4 passes | Needed retries or manual fixes | Not run |
| Reconnect / no duplicate | Steps 6 and 8 pass | Only the short blip passed | Not run |
| Restart honesty | Step 7 passes and no orphan Claude process | Passes but an orphan was observed | Not run |
| Resource Governor | Step 9 passes | Only concurrency verified | Not run |
| Background execution | Runs finished with the screen off, with no suspension observed | Only with `termux-wake-lock`, or suspension observed | Screen-off test not done |
| No silent failover | Step 11 passes | — | Not run |
| Portable identity / mapping | Steps 5 and 12 pass | Identity shown as *unrecorded* only | Not run |

HC-06 is a human validation: CloudCLI automation never declares it passed.
