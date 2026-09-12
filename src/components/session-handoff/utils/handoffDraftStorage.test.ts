import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { clearHandoffDraft, handoffDraftKey, readHandoffDraft, writeHandoffDraft } from './handoffDraftStorage';

// This Node test environment has no DOM/localStorage global; a minimal,
// self-contained in-memory stand-in is enough to exercise the real
// read/write/clear contract without adding a jsdom dependency. Functions
// under test only touch `localStorage` when called, never at import time, so
// installing the stand-in in `beforeEach` (after the module is already
// loaded) is enough.
class MemoryStorage {
  private store = new Map<string, string>();

  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }
}

beforeEach(() => {
  (globalThis as unknown as { localStorage: MemoryStorage }).localStorage = new MemoryStorage();
});

test('a session with no draft reads null', () => {
  assert.equal(readHandoffDraft('target'), null);
});

test('write then read round-trips the exact content', () => {
  writeHandoffDraft('target', 'PACKAGE');
  assert.equal(readHandoffDraft('target'), 'PACKAGE');
});

test('writing an empty (or whitespace-only) value clears the draft instead of storing blank text', () => {
  writeHandoffDraft('target', 'PACKAGE');
  writeHandoffDraft('target', '   ');
  assert.equal(readHandoffDraft('target'), null);
});

test('clear removes the draft unconditionally', () => {
  writeHandoffDraft('target', 'PACKAGE');
  clearHandoffDraft('target');
  assert.equal(readHandoffDraft('target'), null);
});

test('two sessions never see or clobber each other\'s draft', () => {
  writeHandoffDraft('target-a', 'PACKAGE A');
  writeHandoffDraft('target-b', 'PACKAGE B');

  assert.equal(readHandoffDraft('target-a'), 'PACKAGE A');
  assert.equal(readHandoffDraft('target-b'), 'PACKAGE B');

  clearHandoffDraft('target-a');
  assert.equal(readHandoffDraft('target-a'), null);
  assert.equal(readHandoffDraft('target-b'), 'PACKAGE B', 'clearing one session must not touch another');
});

test('the storage key is namespaced per session id, matching the queued-message pattern', () => {
  assert.equal(handoffDraftKey('abc'), 'handoff_draft_abc');
  assert.notEqual(handoffDraftKey('abc'), handoffDraftKey('abd'));
});
