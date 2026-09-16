# Portable project identity and the Workspace Snapshot contract (FT-M09)

This page records the architecture contract that lets a project be continued
on another RuntimeNode later, without a network filesystem and without moving
provider credentials. FT-M09 implements the identity model, local workspace
inspection, the sync classification policy and the typed snapshot contract.
It does **not** implement a hosted service, snapshot storage, upload, restore
or automatic synchronization.

## The model

```
Project (global identity: project_id)
  ├── ProjectWorkspace on the control plane's own node   → projects.project_path
  ├── ProjectWorkspace on Pixel                          → runtime_node_workspaces(node, project_id).node_path
  └── ProjectWorkspace on NAS                            → runtime_node_workspaces(node, project_id).node_path
```

- **Project identity is global.** A project is its `project_id`. It never is
  `D:\some\folder` or `/root/some/folder`.
- **Workspace paths are node-local.** Each RuntimeNode maps the same project id
  to its own folder, which that node verifies inside its own `--workspace-root`.
  The path is only ever sent back to that node and never returned to a browser.
- **The control plane's `projects.project_path` is its own working copy**, i.e.
  the local node's ProjectWorkspace. Files, Git and Shell still operate on it.
- **Execution is local.** Claude, Git, builds and tests always run against a
  local working copy on the node that executes. No mounted cloud drive, SMB,
  WebDAV or FUSE path is ever an execution workspace.
- **Credentials stay on the node.** A project can move between nodes; a Claude
  login never does.

### What changed in FT-M09

Before FT-M09, `runtime_node_workspaces` was keyed by `(node_id, project_path)`:
remote mappings hung off the control plane's path string. They are now keyed by
`(node_id, project_id)`, with `ON DELETE CASCADE` from the project. Existing
FT-M08 rows are migrated through the project that owns their path; a row whose
project no longer exists cannot be expressed by id and is dropped (and counted
in the startup log).

Consequences:

- two nodes map the same project to different folders;
- this machine moving its own copy (a changed `project_path`) keeps every
  node's mapping;
- a re-created project with the same path does not silently inherit an old
  mapping.

## Project Registry (FT-M10)

A project is its `project_id` everywhere; paths are node-local knowledge.

- **Projects without a copy here.** `projects.project_path` is nullable: it is
  only THIS control plane's working copy. A project with no copy here must carry
  its own name. It is listed by `GET /api/projects/registry` (every project,
  with `controlPlaneCopy: present|absent`, never a path) and can be registered
  with `POST /api/projects/registry`. The path-based list (`GET /api/projects`,
  the sidebar) still shows only projects with a copy here.
- **Sessions reference their project by id.** `sessions.project_id` is written
  at creation (a handoff target inherits its Task's project) and never
  re-scoped. The migration fills it only from an exact `project_path` match; a
  session whose folder names no project stays NULL. `project_path` stays as
  provenance. Project listings, the conversation feed, session details,
  deletion and remote run routing all use the id.
- **`ProjectRegistry` port.** Identity and metadata only (`listProjects`,
  `getProject`, `registerProject`, `listNodeAssociations` — associations carry
  no node path). A local SQLite adapter and an in-memory fake pass one contract
  suite; a hosted adapter implements the same port later.
- **`latestCheckpoint`.** Nullable reference (snapshot id, changes digest, head
  commit, source node, time). Nothing writes it before snapshot storage exists;
  a missing or malformed field makes it null, never a partial checkpoint.
- **Workspace resolution.** One project on one explicitly chosen node: this
  machine's copy for the local node, the verified mapping for a remote node, or
  an explicit refusal — `PROJECT_NOT_FOUND`, `RUNTIME_NODE_NOT_FOUND`,
  `RUNTIME_NODE_NOT_ENROLLED`, `RUNTIME_NODE_REVOKED`, `RUNTIME_NODE_OFFLINE`,
  `WORKSPACE_NOT_ON_NODE`, `WORKSPACE_UNAVAILABLE`. A refusal never carries a
  path, and no other node's folder is ever substituted.
- **Files, Git, TaskMaster, Worktrees, Shell are target-aware.** They run on
  this machine, and every request names its RuntimeNode: the browser sends
  `X-CloudCLI-Runtime-Node` + `X-CloudCLI-Runtime-Project` (Shell: `runtimeNodeId`
  on `init`) — the selected session's node, else the node chosen for the
  project. That node alone is resolved:
  - the local node → this machine's copy, and only it (a client path never wins
    for a registered project);
  - a remote node → refused on its own grounds (`RUNTIME_NODE_NOT_ENROLLED`,
    `RUNTIME_NODE_REVOKED`, `WORKSPACE_NOT_ON_NODE`, `WORKSPACE_UNAVAILABLE`,
    `RUNTIME_NODE_OFFLINE`, `RUNTIME_NODE_NOT_FOUND`) or, when its folder is
    usable, `WORKSPACE_REMOTE_OPERATION_UNSUPPORTED` (409): these operations are
    not transported to other nodes yet. Nothing runs in this machine's folder,
    another node's folder or the current directory instead.
  - A Shell for a session always uses that session's binding
    (`RUNTIME_NODE_REMOTE_SESSION` for a remote one); a half-sent or malformed
    target is refused (`RUNTIME_TARGET_INVALID`); a target names one project and
    never applies to another. Without a target, this machine is the target.
    Shells naming no registered project (login, usage) keep their client folder.
- **Handoff** does not read Git state from this machine for a source run that
  executed on a remote node; it reads as unavailable.
- **Identity** is unchanged from FT-M09: a remap never re-baselines
  `git_root_commits`, and a mismatch reads as `identity_mismatch` on that node.

## Local workspace state

`GET /api/runtime-nodes/:nodeId/workspaces/:projectId/state` asks the machine
that owns the folder to inspect it read-only:

- the control plane inspects its own copy;
- a remote node inspects its mapped folder over its authenticated link
  (`workspace.inspect`), confined to its workspace root.

Git runs with `--no-optional-locks`, `core.fsmonitor=false`, `LC_ALL=C` and no
prompts, and inspection never commits, stashes, resets, fetches, merges or
deletes. The answer carries counts, branch, HEAD, upstream ahead/behind and
root commits — never a path or a file name — and the control plane re-validates
every field.

States, in precedence order:

| State | Meaning |
| --- | --- |
| `missing` | The mapped folder does not exist on that node. |
| `unavailable` | The folder cannot be used, the node is offline/revoked, or it did not answer. |
| `unknown` | Not a Git repository, Git failed or timed out, or changes unreadable. Never shown as clean. |
| `identity_mismatch` | The folder's root commits do not match those recorded when it was mapped. |
| `dirty` (`unmerged_paths`) | Unmerged paths. |
| `diverged` | Local branch is both ahead of and behind its upstream (local knowledge; no fetch). |
| `dirty` (`uncommitted_changes`) | Tracked or untracked changes. |
| `clean` | No changes in the folder. |
| `unmapped` | No folder mapped on that node. |

**Identity** compares the repository's root commits with those the node
reported when the folder was mapped (`git_root_commits`). FT-M08 mappings have
none recorded: they read `unrecorded` until the folder is mapped again.

## Git and dirty state: separate roles

- **Git** carries committed history: root commits (identity), branch, HEAD,
  upstream relation. CloudCLI never auto-commits user work to make a project
  portable.
- **The change set** carries uncommitted, syncable work on top of HEAD:
  modified, added, deleted, renamed and untracked files, each with a content
  hash. Its SHA-256 `changesDigest` (order-independent) is the conflict basis:
  same HEAD + same digest means the same syncable working copy.

## Sync classification (security boundary)

Every path is classified deterministically. Precedence:
**secret > user_excluded > local_only > syncable**.

| Class | Examples | Future sync |
| --- | --- | --- |
| `secret` | `.env`, `.env.*` (not `.example/.sample/.template/.dist/.defaults`), `.npmrc`, `.netrc`, `.git-credentials`, `id_rsa*`/`id_ed25519*`, `*.pem`, `*.key`, `*.p12`, `*.keystore`, `*.tfstate`, `.ssh/`, `.aws/`, `.kube/`, `.docker/`, `.cloudcli/`, `.claude/settings.local.json`, `credential(s).json`, `auth.db` | Never read into a checkpoint, never listed by name |
| `user_excluded` | Project patterns (`*`, `**`, trailing `/`) | Excluded |
| `local_only` | `.git/`, `node_modules/`, `dist/`, `build/`, `.next/`, caches, `__pycache__/`, `.venv/`, `target/`, `*.log`, `*.tmp` | Regenerated per node |
| `syncable` | Everything else | May be checkpointed |

- A project pattern can never re-include a secret.
- `.gitignore` is neither required nor trusted to keep secrets out.
- Content is checked too: a syncable-by-name file whose first 256 KB contain a
  high-confidence credential marker (private key block, AWS key id, Anthropic
  / GitHub / Slack / Google keys) is treated as secret and left out of the
  digest. **This detection is best-effort and not perfect**; a checkpoint must
  also honour the project's own exclusions.
- Unclassifiable paths (absolute, traversal, NUL) are denied.
- Secret folders, Claude local settings and Git metadata match in **any letter
  case**, because Windows and macOS resolve `.SSH/` or `.GIT/` to the real
  folders. `.git` as a folder **or** as a gitlink file (and the NTFS short name
  `git~1`) is never syncable at any depth; restoring one could rewrite hooks or
  redirect a repository. Other local-only folders (`node_modules/`, `dist/`, …)
  still match case-sensitively.
- Files Git ignores are not part of the change set at all (inspection uses
  `git status`, which omits them), so they are neither synced nor digested.

## Workspace Snapshot manifest, version 1

Typed in `server/modules/project-workspaces/workspace-snapshot.contract.ts`.

| Field | Content |
| --- | --- |
| `schema`, `version` | `cloudcli.workspace-snapshot`, `1` |
| `snapshotId` | UUID |
| `projectId` | Global project identity |
| `createdAt` | ISO time |
| `sourceNodeId` | RuntimeNode whose working copy was captured |
| `parentSnapshotId` | Lineage for future three-way checks, or null |
| `git` | `rootCommits`, `branch`, `headCommit`; null when not a repository |
| `changes[]` | Syncable paths only: `path`, `change`, `previousPath`, `contentSha256`, `sizeBytes`, `mode` |
| `exclusions` | Counts of `localOnly`, `secret`, `userExcluded`, and the policy used — no excluded names |
| `changesDigest` | Digest of `changes` |
| `payload` | `{ transport: 'none' }` — no storage transport exists yet |

The validator rejects unknown fields (nothing can ride along, such as a token or
a config path), unsafe or non-syncable paths (including either side of a
rename), bad hashes, duplicate paths, a digest that does not match the change
set, and any payload transport other than `none`. Snapshot payloads are never
meant to live in the SQL database.

## Conflict model

`assessWorkspaceRestore(target, snapshot)` decides whether a snapshot could be
applied to a target node's working copy without losing anything:

| Decision | When |
| --- | --- |
| `up_to_date` | Same HEAD and the target's digest equals the snapshot's (not truncated), or nothing to apply. |
| `apply` | Target is clean at the snapshot's HEAD. |
| `blocked` | Anything else, with explicit blockers. |

Blockers:

- `target_missing`
- `target_unavailable`
- `target_state_unknown`
- `git_state_mismatch`
- `identity_mismatch`
- `target_has_unmerged_paths`
- `target_diverged`
- `target_has_local_changes`
- `revision_differs`

A different HEAD always blocks: ancestry across nodes is never guessed without
fetching. Divergent work is surfaced, never overwritten.

## Restore-time requirements (for the mission that applies snapshots)

The manifest accepts paths that are valid on Linux but unsafe or ambiguous on
the filesystem a snapshot may be restored to. The applying node must check them
against its **own** filesystem before writing anything, and block instead of guessing:

- **Case or Unicode collisions:** `src/A.ts` and `src/a.ts`, or NFC and NFD
  spellings of the same name, collapse to one file on case-insensitive or
  normalizing filesystems.
- **Windows-reserved names and syntax:** `CON`, `NUL`, trailing dots or spaces,
  and `:` (alternate data streams, e.g. `file.txt:stream`).
- **Symlinks:** a symlink entry's target (hashed, not stored as a path) must
  resolve inside the workspace, or be refused.
- **Look-alike names:** bidirectional or invisible control characters in names
  should be surfaced to the user rather than silently written.

## Not implemented yet

- Building snapshot payloads (content capture), storage transport, upload.
- Applying a snapshot, initial checkout of a missing workspace, Git transport
  between nodes.
- A hosted Project Registry adapter (the port and a local adapter exist, FT-M10).
- A sidebar view of projects without a copy on this control plane (they are
  listed by the registry API only).
- Writing `latestCheckpoint` (the nullable reference exists, FT-M10).
- Per-project exclude configuration storage (the policy type exists; nothing
  persists user patterns yet).
- "Continue Here" / Runtime Handoff.

## Cloud and relay readiness

What a future hosted layer would need to store, and what it never needs:

| Future component | Needs | Never needs |
| --- | --- | --- |
| Relay / coordination | Authenticated outbound node links, routing, presence (the FT-M08 link protocol is already outbound-only) | Provider credentials, project content |
| Project Registry | `project_id`, metadata, node ↔ project mappings (without node paths if the node keeps them), root-commit identity, latest snapshot ids and digests | Control-plane paths, node credentials' private keys, Claude auth |
| Workspace storage | Validated manifests plus encrypted syncable payloads | Secret-classified files, `.claude`, node state |

Nothing in FT-M09 requires any node to stay online for another node to be
chosen, and an all-nodes-offline project stays a valid project whose nodes
read as offline.
