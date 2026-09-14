// HC06-IDENTITY-REPAIR-R1: direct persistence-layer proof of the portable
// workspace identity invariant. `git_root_commits` is documented (see the
// type comment on RuntimeNodeWorkspaceRecord) as "the repository identity
// the node reported WHEN THE FOLDER WAS MAPPED" — a baseline recorded once,
// not a live mirror of whatever the current node_path happens to be. These
// tests prove `upsert` actually honors that: initializing it on the first
// mapping, and never silently replacing it on an ordinary remap.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  projectsDb,
  runtimeNodeWorkspacesDb,
} from '@/modules/database/index.js';

const NOW = Date.UTC(2026, 8, 14, 12, 0, 0);
const ROOT_A = 'a'.repeat(40);
// The real commit hash from the HC-06 hardware failure this test reproduces.
const ROOT_MISMATCH = 'ea2c8da60fc8131776a931782bce9f01c17dbe45';
let seq = 0;

async function withIsolatedDatabase(runTest: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'runtime-node-workspaces-db-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();
  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

function seedNode(nodeId: string): void {
  getConnection()
    .prepare('INSERT INTO runtime_nodes (node_id, label, is_local, platform, arch) VALUES (?, ?, 0, ?, ?)')
    .run(nodeId, nodeId, 'linux', 'arm64');
}

/** A fresh project id per call — the FK to `projects` must resolve, but the path itself is never touched on disk by these tests. */
function seedProject(): string {
  seq += 1;
  const result = projectsDb.createProjectPath(`/control-plane/project-${seq}`);
  return result.project?.project_id as string;
}

test('the first mapping for a (node, project) pair initializes git_root_commits', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    seedNode('pixel-hc06');
    const projectId = seedProject();
    runtimeNodeWorkspacesDb.upsert({
      nodeId: 'pixel-hc06', projectId, nodePath: '/root/ws/app',
      status: 'verified', reason: null, verifiedAt: NOW, gitRootCommits: [ROOT_A],
    });
    assert.deepEqual(runtimeNodeWorkspacesDb.get('pixel-hc06', projectId)?.gitRootCommits, [ROOT_A]);
  });
});

test('remapping the same (node, project) pair to an UNRELATED repository must not replace the recorded identity', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    seedNode('pixel-hc06');
    const projectId = seedProject();
    // 1-2: map project P to repository A; root identity A is recorded.
    runtimeNodeWorkspacesDb.upsert({
      nodeId: 'pixel-hc06', projectId, nodePath: '/root/cloudcli-workspaces-hc06/claudecodeui',
      status: 'verified', reason: null, verifiedAt: NOW, gitRootCommits: [ROOT_A],
    });
    assert.deepEqual(runtimeNodeWorkspacesDb.get('pixel-hc06', projectId)?.gitRootCommits, [ROOT_A]);

    // 3: remap the same (node, project) to an unrelated repository B.
    runtimeNodeWorkspacesDb.upsert({
      nodeId: 'pixel-hc06', projectId, nodePath: '/root/cloudcli-workspaces-hc06/hc06-identity-mismatch',
      status: 'verified', reason: null, verifiedAt: NOW + 1, gitRootCommits: [ROOT_MISMATCH],
    });

    // 4: expected identity A must NOT be replaced by B.
    const after = runtimeNodeWorkspacesDb.get('pixel-hc06', projectId);
    assert.deepEqual(after?.gitRootCommits, [ROOT_A], 'the recorded baseline must stay A, not silently re-baseline to the unrelated repo B');
    // The path itself does move — mapping to a different folder is still allowed.
    assert.equal(after?.nodePath, '/root/cloudcli-workspaces-hc06/hc06-identity-mismatch');

    // 6: remap back to repository A — the baseline was never disturbed, so this is a no-op on identity.
    runtimeNodeWorkspacesDb.upsert({
      nodeId: 'pixel-hc06', projectId, nodePath: '/root/cloudcli-workspaces-hc06/claudecodeui',
      status: 'verified', reason: null, verifiedAt: NOW + 2, gitRootCommits: [ROOT_A],
    });
    assert.deepEqual(runtimeNodeWorkspacesDb.get('pixel-hc06', projectId)?.gitRootCommits, [ROOT_A]);
  });
});

test('remapping to a different clone/path of the SAME repository (matching root identity) is a normal, harmless upsert', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    seedNode('pixel-hc06');
    const projectId = seedProject();
    runtimeNodeWorkspacesDb.upsert({
      nodeId: 'pixel-hc06', projectId, nodePath: '/root/ws/app-clone-1',
      status: 'verified', reason: null, verifiedAt: NOW, gitRootCommits: [ROOT_A],
    });
    // A second clone of the exact same repository history, mapped at a
    // different local path — its own verification also reports ROOT_A.
    runtimeNodeWorkspacesDb.upsert({
      nodeId: 'pixel-hc06', projectId, nodePath: '/root/ws/app-clone-2',
      status: 'verified', reason: null, verifiedAt: NOW + 1, gitRootCommits: [ROOT_A],
    });
    const after = runtimeNodeWorkspacesDb.get('pixel-hc06', projectId);
    assert.deepEqual(after?.gitRootCommits, [ROOT_A]);
    assert.equal(after?.nodePath, '/root/ws/app-clone-2');
  });
});

test('a mapping whose identity was never recorded (legacy FT-M08 row, or a folder with no git history yet) still initializes on the next ordinary upsert', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    seedNode('pixel-hc06');
    const projectId = seedProject();
    // Simulates a legacy row (git_root_commits IS NULL) or a folder that had
    // no commits yet (empty array) — both read back as "unrecorded", not a
    // baseline to protect.
    runtimeNodeWorkspacesDb.upsert({
      nodeId: 'pixel-hc06', projectId, nodePath: '/root/ws/empty-repo',
      status: 'verified', reason: null, verifiedAt: NOW, gitRootCommits: [],
    });
    assert.deepEqual(runtimeNodeWorkspacesDb.get('pixel-hc06', projectId)?.gitRootCommits, []);

    runtimeNodeWorkspacesDb.upsert({
      nodeId: 'pixel-hc06', projectId, nodePath: '/root/ws/now-has-history',
      status: 'verified', reason: null, verifiedAt: NOW + 1, gitRootCommits: [ROOT_A],
    });
    assert.deepEqual(runtimeNodeWorkspacesDb.get('pixel-hc06', projectId)?.gitRootCommits, [ROOT_A], 'an unrecorded baseline may still be initialized — this is not a re-baseline, it is the first real one');
  });
});

test('unmapping and mapping again (an explicit reset, not an implicit re-baseline) freely re-initializes identity', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    seedNode('pixel-hc06');
    const projectId = seedProject();
    runtimeNodeWorkspacesDb.upsert({
      nodeId: 'pixel-hc06', projectId, nodePath: '/root/ws/app',
      status: 'verified', reason: null, verifiedAt: NOW, gitRootCommits: [ROOT_A],
    });
    assert.equal(runtimeNodeWorkspacesDb.delete('pixel-hc06', projectId), true);
    assert.equal(runtimeNodeWorkspacesDb.get('pixel-hc06', projectId), null);

    runtimeNodeWorkspacesDb.upsert({
      nodeId: 'pixel-hc06', projectId, nodePath: '/root/ws/totally-different-repo',
      status: 'verified', reason: null, verifiedAt: NOW + 1, gitRootCommits: [ROOT_MISMATCH],
    });
    assert.deepEqual(
      runtimeNodeWorkspacesDb.get('pixel-hc06', projectId)?.gitRootCommits,
      [ROOT_MISMATCH],
      'an explicit delete-then-map is the existing, intentional way to reset identity — never invented implicitly inside an ordinary remap',
    );
  });
});
