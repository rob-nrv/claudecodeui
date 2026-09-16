// FT-M11: a session can be created by project id, so a server without a copy
// of the project (a Hosted Relay) never records a folder. By id, the local
// node still needs this machine's own copy; nothing runs in another folder.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  projectsDb,
  runtimeNodesDb,
  sessionsDb,
} from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/index.js';
import { setServerRole } from '@/shared/utils.js';

async function withIsolatedDatabase(runTest: (directory: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'sessions-project-id-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await writeFile(process.env.DATABASE_PATH, '');
  await initializeDatabase();
  try {
    await runTest(tempDirectory);
  } finally {
    setServerRole('control-plane');
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

const countProjects = () => (getConnection().prepare('SELECT COUNT(*) AS count FROM projects').get() as { count: number }).count;

test('control plane: by id, the local node uses the project\'s own copy or refuses; both targets at once are ambiguous', { concurrency: false }, async () => {
  await withIsolatedDatabase(async (directory) => {
    const withCopy = path.join(directory, 'app');
    projectsDb.createProjectPath(withCopy);
    const copied = projectsDb.getProjectPath(withCopy);
    const pathless = projectsDb.createProjectWithoutControlPlaneCopy('Phone only');

    const created = sessionsService.createAppSession('claude', '', 'hello there', null, null, copied?.project_id);
    const row = sessionsDb.getSessionById(created.sessionId);
    assert.equal(row?.project_id, copied?.project_id);
    assert.equal(row?.project_path, copied?.project_path);
    assert.equal(row?.runtime_node_id, runtimeNodesDb.getLocal()?.nodeId);

    const before = countProjects();
    assert.throws(
      () => sessionsService.createAppSession('claude', '', 'hello', null, null, pathless.project_id),
      { code: 'WORKSPACE_NOT_ON_NODE' },
      'no folder here: never the current directory',
    );
    assert.throws(() => sessionsService.createAppSession('claude', withCopy, 'hello', null, null, copied?.project_id), { code: 'PROJECT_TARGET_AMBIGUOUS' });
    assert.throws(() => sessionsService.createAppSession('claude', '', 'hello', null, null, 'missing-project'), { code: 'PROJECT_NOT_FOUND' });
    assert.throws(() => sessionsService.createAppSession('claude', '', 'hello'), { code: 'PROJECT_PATH_REQUIRED' });
    assert.equal(countProjects(), before);
  });
});

test('hosted relay: a folder is never recorded, and a target is never implied', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    setServerRole('hosted-relay');
    const project = projectsDb.createProjectWithoutControlPlaneCopy('Relay project');
    const before = countProjects();

    assert.throws(
      () => sessionsService.createAppSession('claude', '/srv/relay-host/app', 'hello'),
      { code: 'HOSTED_RELAY_PROJECT_PATH_UNSUPPORTED' },
    );
    assert.throws(() => sessionsService.createAppSession('claude', '', 'hello', null, null, project.project_id), { code: 'RUNTIME_NODE_REQUIRED' });
    assert.equal(countProjects(), before, 'no project row was created for a relay-host folder');
    assert.equal(runtimeNodesDb.count(), 0, 'no local node was registered on the way');
    assert.equal((getConnection().prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number }).count, 0);
  });
});
