import assert from 'node:assert/strict';
import test from 'node:test';

import {
  selectWorkspaceRuntimeTarget,
  setWorkspaceRuntimeTargetResolver,
  workspaceRuntimeTargetHeaders,
} from './workspaceRuntimeTarget';

test('a selected session\'s own node wins; a legacy session means this machine; no session uses the project choice', () => {
  assert.deepEqual(selectWorkspaceRuntimeTarget('p1', { runtimeNodeId: 'pixel' }, 'nas'), { projectId: 'p1', nodeId: 'pixel' });
  assert.equal(selectWorkspaceRuntimeTarget('p1', { runtimeNodeId: null }, 'nas'), null, 'a session that ran here is never moved to the project choice');
  assert.deepEqual(selectWorkspaceRuntimeTarget('p1', null, 'nas'), { projectId: 'p1', nodeId: 'nas' });
  assert.equal(selectWorkspaceRuntimeTarget('p1', null, null), null);
  assert.equal(selectWorkspaceRuntimeTarget(null, { runtimeNodeId: 'pixel' }, 'nas'), null);
});

test('the target travels only on workspace requests, as a node/project pair', () => {
  setWorkspaceRuntimeTargetResolver(() => ({ projectId: 'p1', nodeId: 'pixel' }));
  try {
    const expected = { 'X-CloudCLI-Runtime-Node': 'pixel', 'X-CloudCLI-Runtime-Project': 'p1' };
    for (const url of ['/api/file-tree/projects/p1/files', '/api/git/status?project=p1', '/api/taskmaster/init/p1', '/api/worktrees?project=p1', '/api/projects/p1/taskmaster']) {
      assert.deepEqual(workspaceRuntimeTargetHeaders(url), expected, url);
    }
    for (const url of ['/api/sessions/recent', '/api/runtime-nodes', '/api/auth/status']) {
      assert.deepEqual(workspaceRuntimeTargetHeaders(url), {}, url);
    }
  } finally {
    setWorkspaceRuntimeTargetResolver(() => null);
  }
  assert.deepEqual(workspaceRuntimeTargetHeaders('/api/git/status?project=p1'), {});
});
