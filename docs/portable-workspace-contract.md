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

Still path-bound (known debt, not changed by FT-M09): `sessions.project_path`
references `projects.project_path`, and a project must currently have a copy on
the control plane. Both are for the Project Registry mission to lift.

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

## Not implemented yet

- Building snapshot payloads (content capture), storage transport, upload.
- Applying a snapshot, initial checkout of a missing workspace, Git transport
  between nodes.
- Project Registry outside this control plane; projects without a control-plane
  copy; sessions referencing projects by id.
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
