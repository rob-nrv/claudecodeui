# Remote access and RuntimeNodes (FT-M08)

This page covers two things:

- how to use CloudCLI from another device's browser without installing anything on that device;
- how to run sessions on other machines ("RuntimeNodes") that you pick explicitly.

## What runs where

| Role | What it is | Needs |
| --- | --- | --- |
| Control plane | The CloudCLI server (`cloudcli`). It owns accounts, projects, sessions and the UI. | CloudCLI |
| Control client | Any modern browser (desktop or phone). | Nothing installed |
| RuntimeNode | A machine that executes runs. The control plane machine is always one. Other machines join with `cloudcli node`. | CloudCLI, and a signed-in Claude Code |

The browser only controls. A run executes only on the RuntimeNode its session was created for, and that binding never changes. If that node is unavailable, CloudCLI refuses the run with an explicit error; it never moves it to another node.

## Security properties

- **App port stays local.** The app port (`SERVER_PORT`, default 3001) keeps binding to `127.0.0.1`. Remote browsers and nodes arrive through a second listener, the Remote Gateway.
- **Gateway requires HTTPS.**
  - `tls` mode: the gateway terminates TLS itself, TLS 1.2 minimum.
  - `external-tls` mode: a TLS terminator on the same machine sits in front of it, and the gateway then binds loopback only.
  - In both modes the configured public origin must be `https://`.
- **Remote browser sign-in.**
  - A remote browser needs the account password **and** a one-time pairing code created from an already signed-in session.
  - Codes are 60-bit, single use, valid for 10 minutes, and rate limited per address and globally.
  - Any failed attempt burns the code it presented.
- **Remote session cookie.**
  - Pairing sets a `__Host-` cookie with `Secure; HttpOnly; SameSite=Strict`. The page never sees a token.
  - Sessions expire after 7 days idle or 30 days total, and each one can be revoked. Revoking closes the browser's open sockets immediately.
- **What the gateway refuses:**
  - credentials in URLs;
  - bearer tokens;
  - password-only login and first-account setup;
  - machine APIs (`/api/agent`, `/api/browser-use-mcp`);
  - cross-origin writes and websocket upgrades.
- **Node authentication.**
  - A node generates its own Ed25519 key and enrolls once with a 15-minute one-time code. The control plane mints the node's id.
  - Every link connection carries a signed, timestamped, single-use header.
  - Browsers can never open a node link.
  - A revoked node is disconnected at once, and its runs stop.
- **Capabilities come from probes.** They are recorded only from probes the control plane requests over the authenticated link, and only probes answered during the current connection count. Nothing a browser sends becomes a capability. Settings > Remote access shows each node's evidence; see [android-runtime-node.md](android-runtime-node.md).
- **Workspace folders are never assumed.** A project's folder on another node is never guessed. You map it explicitly, and the node verifies it inside its own `--workspace-root`. The node re-checks it at every run. Mappings belong to the project id, not to this machine's path ([portable-workspace-contract.md](portable-workspace-contract.md)).
- **Links are kept honest.** Nodes ping their control plane and re-dial a silent link; the control plane terminates links silent for 60 s, so a run never reads "running" on a dead connection.
- **Credentials never move.** A node runs Claude with its own login. CloudCLI's Claude accounts are never copied to other machines.

## 1. Enable the Remote Gateway

Add the gateway settings to the `.env` file next to CloudCLI, then restart CloudCLI.

### Built-in TLS (`tls` mode)

Use a certificate your devices trust, for example from your own CA, `mkcert`, or a certificate issued for your domain.

```
CLOUDCLI_REMOTE_GATEWAY=tls
CLOUDCLI_REMOTE_ORIGIN=https://cloudcli.example.lan:3443
CLOUDCLI_REMOTE_PORT=3443
CLOUDCLI_REMOTE_BIND=0.0.0.0
CLOUDCLI_REMOTE_TLS_CERT=C:\certs\cloudcli.pem
CLOUDCLI_REMOTE_TLS_KEY=C:\certs\cloudcli-key.pem
```

### Local TLS terminator (`external-tls` mode)

Use this when a TLS terminator on the same machine sits in front of the gateway, for example Caddy, `tailscale serve` or `cloudflared`. These are optional deployment adapters, not part of CloudCLI.

```
CLOUDCLI_REMOTE_GATEWAY=external-tls
CLOUDCLI_REMOTE_ORIGIN=https://pc.your-tailnet.ts.net
CLOUDCLI_REMOTE_PORT=3443
```

Point the terminator at `http://127.0.0.1:3443`. It must forward WebSocket upgrades and keep the `Origin` header.

### Check the result

Open **Settings > Remote access** on the machine itself. You should see:

- **Gateway:** Listening
- **App port:** This machine only

The server log also prints the gateway origin at startup. If the configuration is invalid, the gateway stays down with the reason shown, and local use is unaffected.

## 2. Pair a browser

1. On a signed-in device, open **Settings > Remote access** and click **Create pairing code**.
2. On the other device, open the gateway origin.
3. Sign in with your username, your password and the code.

Paired browsers are listed in the same place. **Revoke** signs one out everywhere at once.

## 3. Enroll a RuntimeNode

1. In **Settings > Remote access > Runtime nodes**, enter a name and click **Create enrollment code**.
2. On the node, with CloudCLI installed and Claude Code signed in, run the two commands shown:

   ```
   cloudcli node enroll --server https://cloudcli.example.lan:3443 --code XXXX-XXXX-XXXX
   cloudcli node start --workspace-root /volume1/code
   ```

The node connects out to the gateway and never opens a port. It stores its key in `~/.cloudcli/node-agent/credential.json`; override the location with `--state-dir` or `CLOUDCLI_NODE_AGENT_HOME`. Enrolling again in the same state directory is refused unless you pass `--force`, which replaces that directory's credential (the old node keeps its identity on the control plane; revoke it there).

`cloudcli node status` shows the node's identity. `cloudcli node doctor` checks what the node can prove right now (toolchain, Claude login, workspace write, governor, run journal, control plane reachability) without opening a link or calling a model; add `--json` or `--output <file>` for a non-secret evidence record ([android-runtime-node.md](android-runtime-node.md)). A node on the control plane machine itself may use `--server http://127.0.0.1:3001`. Any other machine must use https.

If the gateway uses a private CA, trust it on the node with the standard `NODE_EXTRA_CA_CERTS=/path/to/ca.pem`. TLS verification is never disabled.

## 4. Choose where a new session runs

When more than one node exists, the new-session screen shows **Run on** with each node and its state in text. Possible states:

- Available
- Offline
- Checking…
- Claude CLI not found
- Credential in use elsewhere
- Revoked

Pick a node before sending. Your choice is remembered per project. If a chosen node becomes unusable, sending is blocked with the reason; nothing falls back to another node.

The first time you pick a remote node for a project, use **Map a folder on …**:

1. Enter the path of that project's copy **on the node**.
2. The node verifies the folder inside its workspace root before it can be used.

## V1 limits

- Remote nodes run Claude sessions only. They use that node's own Claude login; CloudCLI account selection does not apply there.
- Attachments cannot be sent to a remote node yet.
- Files, Git and Shell show the control plane machine, not the remote node.
- A remote session's history is read from its node. While the node is offline, that history is unavailable, and CloudCLI says so.
- A project must exist on the control plane and be mapped on the node. CloudCLI never copies or syncs workspaces. The chosen node's copy is inspected read-only and shown under **Run on** (for example *No uncommitted changes · main*).
- A node accepts at most `--max-concurrent-runs` runs (default 2) and refuses new runs below `--min-free-storage-mb` (default 512). Refusals are explicit and never move a run elsewhere.
- A handoff to a remote node is only possible when no CloudCLI Claude accounts are configured (a handoff requires choosing an account).
- Local, loopback-only browsing keeps its existing token behavior.

## HC-05 real-world validation

**Needs:**

- Machine **P**: the control plane.
- Machine **N**: a second physical machine, with CloudCLI, a signed-in Claude Code, and a clone of the test project.
- Device **B**: a browser device with neither CloudCLI nor Claude Code, for example a phone.

**Steps:**

1. **Enable the gateway on P** (section 1). In Settings > Remote access, confirm Gateway **Listening** and App port **This machine only**.
2. **Prove the app port is not exposed.**
   - On P, `netstat -ano | findstr :3001` shows only `127.0.0.1:3001`.
   - From B, `http://<P LAN IP>:3001` does not load.
3. **Enroll N** (section 3) and run `cloudcli node start --workspace-root <folder containing the clone>`. P's Settings shows N as **Available**.
4. **Pair B.** On B, open the gateway origin. The pairing form appears; pair with a code created on P (section 2).
5. **Start a run on N.**
   1. On B, open the project.
   2. **Run on** lists P and N. Choose **N** and map the clone's folder on N.
   3. Send: `Run hostname, then print the working directory`.
6. **Approve on B.** When Claude asks to run the command, approve it on B.
7. **Check where it executed.**
   - The output shows **N's** hostname and **N's** folder.
   - N's agent log shows exactly one `Run … accepted` line.
   - P ran nothing.
8. **Exercise Queue or Steer.** Send a longer task, then queue or steer a follow-up from B while it runs.
9. **Reload B during a run.** The stream continues, and N's log still shows one accepted run per message.
10. **Stop the agent on N** (Ctrl+C) and send again in that session. B shows "… is offline. The message was not sent, and it was not moved to another node."
11. **Optional revocation.** Revoke B on P; B returns to the pairing screen.

**Evidence to record:**

- the netstat output;
- screenshots from B;
- N's agent log lines;
- P's Settings > Remote access.

If only one physical machine is available, HC-05 cannot pass. Record which condition was missing.
