# Hosted Relay (FT-M11)

**Status:** implemented and verified automatically on loopback. **Not deployed.** Public deployment waits for the decisions in [§7](#7-public-deploy-gate).

Related: [remote-access-and-runtime-nodes.md](remote-access-and-runtime-nodes.md), [cloud-apk-v1-sequencing.md](cloud-apk-v1-sequencing.md), [portable-workspace-contract.md](portable-workspace-contract.md).

## 1. What it is

The Hosted Relay is a CloudCLI server that can stay online while every machine at home is off. It **coordinates** and never **executes**.

| Role | Runs | Holds |
| --- | --- | --- |
| Hosted Relay (`npm run relay`) | Accounts, browser pairing, RuntimeNode enrollment and presence, run routing, the Project Registry (by id), session rows, the web client | Its own database: users, remote browser sessions, node public keys, project ids and names, node folder mappings (paths as reported by each node), session rows, queued messages |
| RuntimeNode (`cloudcli node start`) | Claude runs, workspace inspection, history | Repositories, the Claude login, provider credentials, its private key |
| Control Client | A browser (desktop or phone) | An HttpOnly session cookie |

The relay is **not** a RuntimeNode:

- it never registers a local node, and refuses to start on a database that holds one (a control plane's database);
- no request falls back to the relay host: without an explicit, enrolled, online node, a run is refused;
- Files, Git, Shell, TaskMaster, Worktrees, uploads, plugins, browser automation, voice, provider CLIs, MCP, skills, transcripts search and `/api/agent` do not exist there (`501 HOSTED_RELAY_UNSUPPORTED` after authentication, `401` before);
- it never copies the legacy install-folder database (`database/auth.db`) into its own.

## 2. Architecture

- **Entrypoint:** `server/relay.ts` → `createHostedRelay` in `server/modules/hosted-relay`. It reuses the control plane's modules and mounts an allowlist, not a fork:
  - auth, remote access (gateway, pairing, cookies, revocation), RuntimeNode enrollment and the signed node link;
  - `/api/runtime-nodes`, the Project Registry (`/api/projects`, `/api/projects/registry`), an allowlisted subset of `/api/providers` (session rows, remote history, queue, lineage) and of `/api/user` (onboarding);
  - the chat WebSocket, whose provider runtime cannot run anything;
  - the production web client (`dist/`), with SPA routing. No Vite redirect.
- **Role:** `server/relay-role.ts` sets the process role before any module loads. Call-time checks then close the "no target means this machine" defaults:
  - `runtimeNodesService`: no local node, never implied, never probed, local rows ignored;
  - workspace locator: no control-plane copy, ever;
  - session creation: by `projectId` only, never by a folder;
  - database connection: no legacy-database copy.
- **Presence:** unchanged FT-M08 contract. A node is online only while its authenticated outbound link is open and it answered a probe on that link; a closed or silent link reads `link_offline`/`link_stale` at once; revocation closes the link and is terminal.
- **Routing:** unchanged. A session is bound to one node at creation and only ever runs there; the refusal lists alternatives but never substitutes one.
- **Client:** unchanged except:
  - a listing may have `localNodeId: null`;
  - a project without a copy is sent by `projectId`;
  - an empty relay fleet reads "No runtime node is enrolled yet".

## 3. Running it (loopback)

```
DATABASE_PATH=/srv/cloudcli-relay/relay.db
SERVER_PORT=3001
CLOUDCLI_REMOTE_GATEWAY=external-tls        # or tls with CLOUDCLI_REMOTE_TLS_CERT/KEY
CLOUDCLI_REMOTE_ORIGIN=https://relay.example.com
CLOUDCLI_REMOTE_PORT=3443
npm run build && npm run relay
```

- The app listener stays on loopback. `HOST` set to anything else stops startup.
- Browsers and nodes reach the relay only through the gateway (https origin).
- **Bootstrap (V1, existing model):** on the relay host, over loopback (for example through an SSH tunnel):
  1. create the account (`POST /api/auth/register` or the first-run page);
  2. sign in;
  3. create pairing codes and node enrollment codes in Settings > Remote access.

  Remote browsers then pair with password + code, and nodes run `cloudcli node enroll --server https://relay.example.com …`.

## 4. Security boundary

| Area | Automated now (tested) | Gate before a public Internet deployment |
| --- | --- | --- |
| TLS | Gateway refuses non-https origins; `tls` mode TLS 1.2+; `external-tls` binds loopback only | Real certificate and terminator (provider-managed or own) |
| Browser auth | Password + one-time pairing code (rate limited, burned on failure); `__Host-` cookie `Secure; HttpOnly; SameSite=Strict`; 7 d idle / 30 d absolute; revocation closes sockets | Public account strategy (see §7) |
| Password login / first-account setup | Refused on the gateway | Stays host-only in V1 |
| Origin / CSRF | Unsafe methods and upgrades need exactly the public origin; loopback CORS only | — |
| WebSocket | Cookie + exact origin; URL tokens refused | — |
| Credentials in URLs | Refused (`token`, `access_token`, `auth`, `apiKey`, `api_key`) | — |
| Node auth | Ed25519 enrollment, signed nonce-checked link header, replay/identity-conflict protection, revocation terminal; browsers can never enroll or link | — |
| Headers | HSTS, `X-Frame-Options: DENY`, `nosniff`, `no-referrer`, `frame-ancestors 'none'`, `no-store` on API | Full CSP (the client loads Google Fonts) |
| Body limits | JSON 1 MB (413); gateway header 30 s / request 60 s timeouts | — |
| Rate limiting | Pairing and enrollment failures, per address and global | Edge rate limiting for all traffic. Behind `external-tls` every request comes from 127.0.0.1, so the per-address limits become one shared bucket until a trusted-proxy policy exists (not implemented). |
| Health | Remote callers get `{status:"ok"}` only | — |
| Surface disclosure | Unsupported paths answer 401 before authentication | — |
| Logs | No tokens, cookies or node keys logged; URL tokens redacted | Log retention and access policy |
| Data at rest | SQLite on the relay host; node paths come only from each node's verification | Disk encryption, backups, retention |
| Multi-user | Single-user model inherited (every signed-in user sees every project and node) | Membership model if more than one person uses a relay |

## 5. No-fallback proof

`server/modules/hosted-relay/tests/hosted-relay.integration.test.ts` records every child process started in the test process (instrumentation self-checked). The relay must start none.

- **Files, Git, TaskMaster, Worktrees, uploads, commands, settings, plugins, browser, voice, system update, Claude profiles, provider auth/models/MCP/search/token usage, session delete/handoff, project create/clone/delete, user Git config:** 501, locally and remotely. A project row pointing at a real folder on the relay host stays untouched (content and listing checked).
- **Shell, plugin and desktop-notification sockets:** closed with 4404.
- **Session by folder:** `HOSTED_RELAY_PROJECT_PATH_UNSUPPORTED`. **Session without a target:** `RUNTIME_NODE_REQUIRED`, even with one enrolled node.
- **Unbound session row (copied database):** `HOSTED_RELAY_NO_LOCAL_NODE`, nothing runs.
- **Offline, revoked, unknown or unenrolled target:** explicit refusal. The other capable node receives nothing.
- **Startup:** platform mode, a non-loopback app listener, or a database with a local node stops the relay.

## 6. Licence facts (not legal advice)

- `package.json`, `LICENSE` and `NOTICE`: **AGPL-3.0-or-later**, copyright Siteboon AI B.V. and contributors.
- `LICENSE` adds **Section 7** terms:
  - 7(b): preserve the attribution "CloudCLI UI (https://github.com/siteboon/claudecodeui)";
  - 7(c): modified versions must be marked as such and not presented as the original;
  - 7(d): no use of the names "Siteboon" / "CloudCLI" for publicity without written permission;
  - 7(e): no trademark rights in "CloudCLI", "CloudCLI UI" or "Siteboon".
- **§13 (Remote Network Interaction):** a modified version offered to users over a network must prominently offer those users the Corresponding Source of that version. This fork is modified; the login page's "open source" link points to the upstream repository, not to this version's source.

## 7. Public deploy gate

These decisions are needed before any Internet deployment. Development does not depend on them.

1. **Hosting:** provider and region (a container or VM with persistent disk for SQLite), and who operates it. Also, whether its TLS terminator runs on the same host, as `external-tls` requires today.
2. **Domain / subdomain** for the public origin, and certificate management if the provider does not handle it.
3. **Public auth strategy:** keep V1 (host-only account creation + pairing codes), or add a hosted account flow.
4. **Abuse controls:** edge rate limits and a trusted-proxy policy (see §4).
5. **Retention and backup** of the relay database (sessions, mappings, browser sessions).
6. **Relay outage behavior:** accepted as "nothing reachable remotely; nodes keep retrying and running runs stop observed"? Or is a standby needed?
7. **AGPL/§7 posture:**
   - a Corresponding Source link for this fork;
   - marking as a modified version;
   - naming and branding of the service with respect to 7(d)/(e).
8. **Human smoke (HC):** a real phone and a real second machine through the public origin:
   - pair;
   - see nodes online, stop one, see it offline;
   - run on an explicitly chosen node;
   - all nodes offline;
   - revoke.
