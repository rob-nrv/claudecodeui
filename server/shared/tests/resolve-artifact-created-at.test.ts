import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveArtifactCreatedAtMs } from '@/shared/utils.js';

test('uses birthtime when the filesystem actually reports one', () => {
  const createdAtMs = resolveArtifactCreatedAtMs({ birthtimeMs: 1_000, mtimeMs: 5_000 });
  assert.equal(createdAtMs, 1_000);
});

test('falls back to mtime when birthtime is the unset epoch (0)', () => {
  // Reproduces what Node reports for JSONL transcripts on filesystems without
  // inode birth-time support (ext4 without the feature, overlayfs, tmpfs,
  // proot/container bind mounts): `birthtimeMs` is always 0, so treating it as
  // real would make every freshly written session file look infinitely old.
  const createdAtMs = resolveArtifactCreatedAtMs({ birthtimeMs: 0, mtimeMs: 5_000 });
  assert.equal(createdAtMs, 5_000);
});
