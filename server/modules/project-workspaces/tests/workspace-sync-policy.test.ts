import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyWorkspacePath,
  detectSecretContentMarkers,
  normalizeWorkspaceRelativePath,
  normalizeWorkspaceSyncPolicy,
} from '@/modules/project-workspaces/workspace-sync-policy.js';

const classOf = (value: string, patterns: string[] = []) => classifyWorkspacePath(value, { version: 1, userExcludePatterns: patterns }).syncClass;

test('project content is syncable; dependencies, build output, caches and Git metadata are local-only', () => {
  for (const file of ['src/index.ts', 'README.md', '.env.example', '.claude/commands/review.md', 'CLAUDE.md', 'docs/build-notes.md', '.vscode/settings.json']) {
    assert.equal(classOf(file), 'syncable', file);
  }
  for (const file of ['node_modules/react/index.js', 'dist/app.js', 'packages/web/.next/cache/x', '.git/HEAD', 'coverage/lcov.info', 'api/__pycache__/m.pyc', 'npm-debug.log.1', 'server.log', '.DS_Store']) {
    assert.equal(classOf(file), 'local_only', file);
  }
});

test('credentials are denied by default by folder, name, extension and pattern — whatever .gitignore says', () => {
  const secrets = [
    '.env',
    'apps/api/.env.production',
    '.npmrc',
    '.git-credentials',
    'deploy/id_ed25519',
    'deploy/id_rsa_github',
    'certs/server.key',
    'certs/server.pem',
    'android/release.keystore',
    'infra/terraform.tfstate',
    'infra/terraform.tfstate.backup',
    'config/client_secret_123.apps.googleusercontent.com.json',
    'home/.ssh/config',
    '.aws/credentials',
    '.cloudcli/node-agent/credential.json',
    '.claude/settings.local.json',
    'database/auth.db',
  ];
  for (const file of secrets) {
    assert.equal(classOf(file), 'secret', file);
  }
});

test('precedence is fixed: a project exclusion never re-includes a secret, and it beats local-only and syncable', () => {
  assert.equal(classOf('.env', ['!.env', '.env']), 'secret');
  assert.equal(classOf('assets/video/intro.mp4', ['assets/video/']), 'user_excluded');
  assert.equal(classOf('big/data.bin', ['*.bin']), 'user_excluded');
  assert.equal(classOf('nested/deep/data.bin', ['/data.bin']), 'syncable', 'an anchored pattern matches only at the root');
  assert.equal(classOf('node_modules/x/y.js', ['node_modules/']), 'user_excluded');
  assert.equal(classOf('src/a/b/c.gen.ts', ['src/**/*.gen.ts']), 'user_excluded');
});

test('paths that are not plain relative workspace paths are never syncable', () => {
  for (const value of ['/etc/passwd', 'C:\\Users\\robin\\file.txt', '../outside.txt', 'a/../../b', 'nul\0byte', '', 42]) {
    assert.equal(classifyWorkspacePath(value).syncClass, 'secret', String(value));
  }
  assert.equal(normalizeWorkspaceRelativePath('src\\win\\file.ts'), 'src/win/file.ts');
  assert.equal(normalizeWorkspaceRelativePath('./src//a.ts'), 'src/a.ts');
});

test('project policies are bounded and invalid patterns are reported, not silently widened', () => {
  const { policy, rejectedPatterns } = normalizeWorkspaceSyncPolicy({ userExcludePatterns: ['*.bin', '../escape', '', 7, 'x'.repeat(300), 'media/'] });
  assert.deepEqual(policy, { version: 1, userExcludePatterns: ['*.bin', 'media/'] });
  assert.equal(rejectedPatterns, 4);
});

test('secret content markers are detected by id only, and a clean file proves nothing more than that', () => {
  const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----';
  assert.deepEqual(detectSecretContentMarkers(`{"key": "${pem}"}`), ['private_key_block']);
  assert.deepEqual(detectSecretContentMarkers(Buffer.from('token = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz"')), ['anthropic_api_key']);
  assert.deepEqual(detectSecretContentMarkers('aws_access_key_id=AKIAABCDEFGHIJKLMNOP'), ['aws_access_key_id']);
  assert.deepEqual(detectSecretContentMarkers('const answer = 42;'), []);
  assert.equal(JSON.stringify(detectSecretContentMarkers(`x ${pem}`)).includes('abc'), false);
});
