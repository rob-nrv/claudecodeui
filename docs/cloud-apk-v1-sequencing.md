# CloudCLI Cloud and APK V1 — sequencing dossier (post FT-M09)

**Status:** proposal for review. Nothing here is a fixed product decision.

- HC-06 (real Pixel validation of FT-M09) has **not** been performed.
- The recommendations assume it passes.
- Open decisions are listed explicitly, not settled here.

Related: [portable-workspace-contract.md](portable-workspace-contract.md), [android-runtime-node.md](android-runtime-node.md), [remote-access-and-runtime-nodes.md](remote-access-and-runtime-nodes.md).

## 1. Fixed target

- **CloudCLI Cloud** (always reachable), made of:
  - a minimal Relay / Coordination layer;
  - a Project Registry;
  - Workspace Sync (snapshot transport and storage).
- **RuntimeNodes** (PC, Android, NAS, future nodes):
  - local provider credentials and local execution;
  - local working copies;
  - outbound connections only.
- **Control clients** (APK, browser, desktop): may also be RuntimeNodes.
- **Two product goals:**
  - no machine at home needs to stay on just to open CloudCLI and see project and runtime state;
  - a project survives its last execution machine going offline.

## 2. Current factual state (repository HEAD)

**Control plane**

- The control plane is the full CloudCLI server (Express + SQLite) on one user machine.
- It owns users, projects, sessions, the Queue, approvals, notifications and the UI.
- The Remote Gateway (TLS or external TLS) is the only non-loopback listener for browsers and nodes.

**RuntimeNodes**

- Nodes enroll once (Ed25519, one-time code) and keep an outbound signed wss link with liveness in both directions.
- Runs are dispatched by the control plane with per-execution ids, seq replay and bounded reconnect grace.
- There is no failover. The node agent keeps a run journal (no duplicate ids across restarts) and a Resource Governor.
- Capabilities come only from probes over the link. `cloudcli node doctor` produces the same evidence locally.

**Project identity**

- Global identity is `project_id`, a UUID local to one control plane.
- Remote folder mappings are keyed by `(node_id, project_id)` and carry the Git root commits recorded at mapping time.
- **Still path-bound:**
  - `projects.project_path` is required and unique;
  - `sessions.project_path` references it;
  - Files, Git and Shell run on the control plane's copy.

**Workspace**

- Implemented:
  - read-only inspection on the owning machine;
  - deterministic sync classification (secret > user_excluded > local_only > syncable; secrets and Git metadata match case-insensitively);
  - the Workspace Snapshot manifest v1 and its strict validator;
  - the restore assessment gate.
- Not implemented: payload capture, storage, transport, apply, initial checkout.

**Existing hosted "platform" mode (upstream, not ours)**

- `VITE_IS_PLATFORM=true` makes the server trust the first database user for HTTP and WebSocket.
- `electron/cloud.js` manages *hosted CloudCLI environments* on `cloudcli.ai`:
  - `/api/v1/environments` with `X-API-Key`;
  - a subdomain per environment;
  - start/stop/credentials, and `ssh.cloudcli.ai`.
- That is **hosted execution** (the whole server and provider login in the cloud). It is the opposite of the fixed target.
- The Relay must not reuse its auth bypass or its "server lives in the cloud" semantics.

**Licence**

- AGPL-3.0-or-later (`LICENSE`, `NOTICE`).
- A hosted service built from this code triggers the AGPL network-use source obligation (§13). See §9.

## 3. Open debt

| Area | Debt | Blocks |
| --- | --- | --- |
| Project Registry | FT-M10 (local-first): projects may exist without a control-plane copy, sessions reference `project_id`, a nullable `latestCheckpoint` reference, a `ProjectRegistry` port with a local SQLite adapter and an in-memory fake. Still open: project ids are minted by one control plane, no hosted adapter, no membership model, no sidebar view of projects without a copy here. | Hosted registry, all-nodes-offline project view in the UI, Continue Here |
| Workspace Sync | No payload capture, storage, encryption, transport, apply or initial checkout. The restore-time filesystem checks in the contract doc are unimplemented. | Continuing on another node after the source goes offline |
| Hosted Relay | Every coordination path terminates in the user's control plane (browser auth, node link, dispatch, Queue, approvals, notifications, history reads). No hosted presence. | Opening CloudCLI with the PC off |
| Sessions | History lives on the node that ran it (remote) or in `~/.claude` (local). Nothing durable in the cloud. | Reading a finished session while its node is offline |
| APK | No CloudCLI cockpit app (see §7). | Product APK V1 |

## 4. Sequencing options

| Criterion | A. Project Registry first | B. Hosted Relay first | C. Snapshot payload/transport first | D. Combined minimal vertical slice |
| --- | --- | --- | --- | --- |
| Depends on | Nothing new | A registry to route by; without one it relays to the PC control plane | Registry identity and a durable checkpoint reference | All three at once |
| Migrations | sessions → project_id; projects without a copy (SQLite, fixture-testable) | Few, but built on path-bound identity → redone later | New snapshot tables and references | All of the above together |
| Security boundary | Local; unchanged | New internet-facing auth for browsers and nodes | Secret leakage and overwrite risk; encryption choice | Everything new at once |
| Risk | Low–medium (data migration) | Medium–high (new exposed service, rework) | High (data loss, secrets) | Highest |
| Testable locally before deployment | Fully | Largely (local relay fixture), but its value needs a deployment | Fully with an object-store fake | Partly |
| Effect on current gateway | None | Replaced or duplicated | None | Replaced |
| Effect on project identity | Completes it | Freezes today's debt into the relay protocol | Attaches snapshots to per-control-plane ids | Must solve it inline |
| `sessions.project_path` debt | Removed | Kept | Kept | Must be removed inline |
| All-nodes-offline state | Modelled (no hosting yet) | Reachable only if the relay also hosts state | No | Yes |
| Projects without a control-plane copy | Yes | No | No | Yes |
| Future Continue Here | Prerequisite | Needed for remote coordination | Core mechanism | Yes |
| Future APK | Neutral | Gives the cockpit something to connect to | Neutral | Yes |
| Rollback risk | Low with backups and migration fixtures | Medium | Medium–high | High |
| User/cloud decisions needed | None to start | Provider, domain, auth model, AGPL posture | Encryption model, retention, storage provider | All |

## 5. Recommended order (proposal)

**A → B → C, then Continue Here.**

**1. A — Project Registry completion (local-first, no deployment)**

- Sessions reference `project_id`.
- Projects can exist without a control-plane copy.
- A durable checkpoint reference field (null until C).
- A `ProjectRegistry` port with a local SQLite adapter and an in-memory fake.
- Presence and snapshot contract types, without transport.

This removes the identity debt every later step would otherwise bake in, and needs no external decision.

**2. B — Hosted coordination service (one compact service)**

- Contents: Project Registry, Runtime Presence and the Relay, reusing the existing node link protocol and browser pairing concepts.
- Developed and proven against local fixtures first (§10). Deployed only once provider and AGPL posture are decided.
- The user's machine stops being required to *open* CloudCLI.
- Runs still execute on nodes; the relay only routes to them.

**3. C — Workspace Snapshot payload, storage and apply**

- Behind the existing manifest v1 and restore gate.
- With the restore-time filesystem checks, an object-store port and an explicit encryption decision.

**4. Continue Here / Runtime Handoff**

- Built on 1–3.

**Why not the others:**

- **B first:** it relays to the path-bound PC control plane, so its protocol would be reworked after A.
- **C first:** it attaches durable data to identities that A changes.
- **D:** it forces every open decision (provider, auth, encryption, AGPL) into one mission.

## 6. Minimum cloud contracts (for the next missions)

One hosted service is enough to start; nothing below requires microservices.

**Project Registry**

- **Stores:**
  - `projectId`, owner/membership and display metadata;
  - repository identity (root commits, optionally a remote URL **with credentials stripped**);
  - workspace policy (exclude patterns);
  - `latestCheckpoint` (snapshot id + `changesDigest` + head commit + source node + time);
  - associations `(projectId, nodeId, state, lastVerifiedAt)`.
- **Never stores:** node-local paths (they stay on the node or its control plane), provider credentials, node private keys, file contents.

**Runtime Presence**

- **Stores:** `nodeId`, label, enrollment state, link state, last seen, a capability summary (ids, status, freshness — no details beyond sanitized ones), governor admission summary, protocol version.
- **Routing metadata:** which relay connection holds the node's link.
- **Never stores:** provider credentials, account identity, environment values.

**Workspace Snapshot Storage**

- **What is stored:**
  - the validated manifest v1;
  - payload objects keyed by `contentSha256` (content-addressed, deduplicated per project or per owner — a decision, see §9);
  - a size cap per file and per snapshot;
  - retention per project.
- **Enforcement:** secret and exclusion rules are enforced **on the source node before upload**, and re-validated by the service (manifest validator). The service never classifies content itself.
- **Encryption boundary:** at rest (service-managed keys) or end-to-end (node-held keys) — an open decision.

**Coordination**

- **Browser/client auth:** hosted account plus device pairing; revocable sessions (the Remote Gateway model generalized). Never a bearer token in URLs.
- **Node auth:** the existing Ed25519 enrollment and signed, nonce-checked link, re-pointed at the hosted service.
- **Links:** nodes stay outbound-only.
- **Run dispatch:** per-execution ids, a single dispatch, seq replay and the no-failover rule, as today.
- **Queue:** needs a durable single-slot queue per session in the hosted state.
- **Approvals:** relayed to the owning node, as today.
- **Notifications:** push from the hosted service.
- **Reconnect:** hello-authoritative resume, as today (hardened tonight).

## 7. APK V1 — current reality

**What exists**

- **One Android module:** `android/app`, applicationId `ai.cloudcli.runtimecontroller`.
  - label **"CloudCLI Runtime"**, version 0.1.0 (code 1), minSdk 26, targetSdk 34;
  - no signing config in the repository.
- **Components:** a launcher `MainActivity`, a `SettingsActivity`, a non-exported `TermuxResultReceiver`.
  - **No Service, no foreground service, no notification channel, no WebView or TWA, no deep links.**
- **Permissions:** `com.termux.permission.RUN_COMMAND`, `INTERNET` (used only for a 127.0.0.1 health poll), `<queries>` for `com.termux`.
- **Behavior:**
  - Start/Stop/Status run inside the user's Termux proot-distro through the documented `RUN_COMMAND` intent;
  - START runs the **full CloudCLI server** (`node dist-server/server/index.js`);
  - "Open CloudCLI" opens that URL in the browser.
- **Validation history:** device-validated as V0 (commit `42da6ba0`, restart fix `3f3e951c`).
- **What the user runs is a Runtime Controller, not the CloudCLI app.**
  - The FT-M08/HC-05 RuntimeNode agent (`cloudcli node start`) is started by hand in Termux; the controller does not know about node-agent mode.
- **PWA:** `public/manifest.json` ("CloudCLI UI", standalone) and `public/sw.js` (push and notification-click deep links). Installed from Chrome, the PWA served by a control plane is today's closest thing to a CloudCLI app on Android.
- **Electron desktop app:** local server controller plus the upstream hosted-environment client.
- **Earlier research (untracked, user-owned `docs/mobile-north-star/`):**
  - recommends a TWA over a bare WebView, because a WebView lacks the Push API (decision D14, marked as the user's call);
  - says the app must hold no wake locks (D22).

**What does not exist**

- A CloudCLI cockpit APK.
- A native login or hosted-cloud connection shell.
- Production pairing/onboarding in an app.
- A controller that runs the node agent instead of a full server.
- Dual-role integration (cockpit + runtime on one phone).
- Release signing or an update path.

## 8. APK packaging options

| | 1. CloudCLI app + separate runtime companion | 2. One merged APK | 3. CloudCLI app with an optional installable companion |
| --- | --- | --- | --- |
| Process lifecycle / background | App is a thin TWA; runtime lives in Termux + companion; failures isolated | App process and runtime controller coupled; Doze and background limits apply to one package | As 1 |
| Termux/proot dependence | Companion only | Whole app depends on Termux permissions and package visibility | Companion only |
| Licensing | App: AGPL web client in a shell. Companion invokes Termux (GPL) by intent, not by redistribution. | Bundling Termux/proot binaries would be redistribution (GPL obligations). The Claude Code CLI cannot be bundled without Anthropic's terms. | As 1 |
| Updates | Web UI updates server-side; app and companion ship independently | Every runtime change ships the whole app | As 1 |
| Permissions | App: notifications, internet. Companion: `RUN_COMMAND`, `<queries>` | Union of both in one app | As 1 |
| Store implications | App can target a store. Companion (Termux-dependent) fits direct APK / F-Droid-style distribution. | Termux-dependent permissions and executing code outside the app sandbox face store review; executing binaries from app storage hits Android W^X restrictions without Termux | As 1 |
| Control-only device | Yes, app alone | Carries unused runtime parts | Yes |
| Acting as RuntimeNode | Companion present | Yes | When installed |
| Fresh install | Two installs | One install, but Termux setup remains | One install; companion offered when the user wants a runtime |
| Extensibility (more runtimes/providers) | Companion swappable | Monolithic | Companion swappable |

**Classification:**

- **Option 3 — LIKELY** for V1. It is option 1's architecture with the companion detected and offered from the app. Detection uses package visibility plus the node's own capability evidence, never the device type.
- **Option 1 — LIKELY** as the underlying structure.
- **Option 2 — NEEDS RESEARCH:** store policy, W^X, GPL redistribution; unattractive on current evidence.
- **CONDITIONAL on:**
  - the D14 decision (TWA vs WebView);
  - the distribution channel(s);
  - the companion switching from "run full server" to "run node agent" once the hosted service (B) exists.

## 9. Security and privacy threat model (upcoming Cloud phase)

| Threat | Mitigation direction | Needs a user/product decision |
| --- | --- | --- |
| Cloud compromise | Store no provider credentials, no node private keys, no node paths. Snapshots end-to-end encrypted *or* explicitly operator-readable. | **Yes:** E2E vs at-rest encryption |
| Cloud operator visibility | Same as above; minimize metadata (counts, not names, in exclusions) | **Yes** |
| Stolen browser session | HttpOnly device sessions, idle and absolute expiry, per-device revocation (Remote Gateway model) | Session lifetimes |
| Lost or stolen phone | Revoke the device session and the node credential independently; the Claude login stays on the phone (the user signs out there) | Remote wipe? (**yes**, if wanted) |
| Malicious RuntimeNode | Evidence only from that node's authenticated link; frames only for its own runs; manifests re-validated; a node cannot author another node's state | — |
| Node impersonation / replay | Ed25519 enrollment, signed nonce-checked upgrades, one live link per node, identity-conflict cooldown (existing) | — |
| Revoked node | Terminal revocation closes the link and fails its runs (existing); the registry must drop its associations | — |
| Compromised snapshot | Strict manifest validation, syncable paths only, restore gate, restore-time filesystem checks, never auto-apply | Auto-apply policy (recommend never) |
| Poisoned Git repository | Git metadata never synced; inspection runs no fetch or fsmonitor; `git status` may still run repository-configured clean filters (documented) | Whether to also disable filters during inspection |
| Secret leakage during sync | Classification before upload (names + content markers, best-effort), project excludes, service-side re-validation | Default content-scan strictness |
| Workspace overwrite / conflicts | Restore gate blocks on local changes, divergence, different HEAD, unknown state | Conflict UX |
| Multiple concurrent writers | One execution per session per node (existing); checkpoint lineage (`parentSnapshotId`); compare-and-set on `latestCheckpoint` | Branching vs linear checkpoints |
| AGPL network use | A hosted service built from this code must offer its source to users | **Yes:** licence posture |

## 10. Test strategy for the next missions (no infrastructure purchase)

- **Ports and adapters:** `ProjectRegistry`, `PresenceStore`, `SnapshotObjectStore`, `RelayTransport`, each with an in-memory implementation used by tests.
- **Local relay fixture:** the hosted service started in-process on loopback. The existing `multi-node.integration.test.ts` pattern already runs a real control plane and two node agents over real sockets.
- **Deterministic network faults:** fake links that drop, supersede and replay (as in `runtime-node-remote-execution.durability.test.ts`), plus stale-sweep clocks.
- **Migration fixtures:** built like `runtime-node-workspaces.migration.test.ts` for sessions → `project_id` and for projects without a copy.
- **Three simulated RuntimeNodes:** PC, phone and NAS, as recording runtimes, never calling a provider.
- **Isolated auth fixtures:** temporary databases and homes via `server/test-support/isolated-test-home.ts`.
- **Real deployment:** needed only to prove reachability, TLS termination and push delivery.

## 11. Future feature compatibility

The rule stays: a new feature is not a new page. The proposed order does not block these directions:

| Feature | How the architecture accommodates it |
| --- | --- |
| **Browser as a RuntimeNode capability** | Another capability id with probe evidence; routed like any node |
| **Voice** | A Composer input; server-side it is a normal message; no hosted dependency |
| **Durable Tasks** | Distinct from the Queue (single slot) and Steer (in-run). Belongs in hosted state keyed by `project_id` after A/B. |
| **API / Tokens** | Advanced Settings. Hosted tokens are scoped to the registry/relay and never grant provider credentials. |
| **Continue Here** | Registry (A) + presence (B) + snapshots (C) + restore gate (exists) |
| **Running as a universal activity cockpit** | Presence and run state from the relay; runs stay per node |
| **Needs You** | Approvals and interactive prompts are already relayed per execution; hosted notifications generalize them |

## 12. Explicit non-goals of this dossier

No hosted deployment, cloud provider choice, snapshot transport, APK build, UI design, or change to FT-M09 behavior beyond the hardening fixes recorded in git history.

## 13. Human decisions and gates

1. **HC-06** on the real Pixel (device gate for FT-M09).
2. Confirm the sequencing (A → B → C) or choose another.
3. **Cloud provider and domain** — gates B's deployment, not its development.
4. **Snapshot encryption model:** E2E or at rest; key custody.
5. **AGPL posture** for a hosted service.
6. **APK:** TWA vs WebView (D14), distribution channel(s), companion packaging.
7. **Membership model:** single user vs shared projects.
8. **Retention and size limits** for checkpoints.
