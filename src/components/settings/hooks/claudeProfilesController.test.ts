import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createClaudeProfilesController,
  INITIAL_CLAUDE_PROFILES_STATE,
  type ClaudeProfilesApi,
  type ClaudeProfilesState,
} from './claudeProfilesController';
import type { ClaudeProfile } from './useClaudeProfiles.types';

// Regression coverage for the Pixel bug report: "+ Add account" -> type a
// name -> Save gave no visible feedback and it was unclear whether the
// profile was actually persisted. Root cause: the old hook set
// `loading: true` on every fetchProfiles() call, including the background
// refresh a successful create triggers, and the component did
// `if (loading) return null` — so the whole section (form included) blinked
// away and back on every save. These tests exercise the extracted,
// framework-free controller directly (no DOM/testing-library needed).
//
// Note: `harness.state` is a getter — always read it fresh (`harness.state.x`)
// rather than destructuring `state` once up front, which would freeze it at
// whatever the value was at that instant.

function makeProfile(overrides: Partial<ClaudeProfile> = {}): ClaudeProfile {
  return {
    id: 'profile-1',
    displayName: 'Robin',
    connectionState: 'unknown',
    verifiedIdentity: null,
    isDefault: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const okResponse = (data: unknown) => ({
  ok: true,
  json: async () => ({ success: true, data }),
});

const failResponse = (message: string) => ({
  ok: false,
  json: async () => ({ success: false, error: { message } }),
});

function createHarness(initialProfiles: ClaudeProfile[] = []) {
  const calls: { list: number; create: string[]; rename: Array<[string, string]>; setDefault: string[]; remove: string[]; verify: string[] } = {
    list: 0,
    create: [],
    rename: [],
    setDefault: [],
    remove: [],
    verify: [],
  };

  let profiles = [...initialProfiles];
  let nextId = 1;
  let createShouldFail: string | null = null;

  const api: ClaudeProfilesApi = {
    async list() {
      calls.list += 1;
      return okResponse({ profiles });
    },
    async create(displayName: string) {
      calls.create.push(displayName);
      if (createShouldFail) {
        return failResponse(createShouldFail);
      }
      const created = makeProfile({
        id: `profile-${nextId++}`,
        displayName,
        isDefault: profiles.length === 0,
        connectionState: 'unknown',
      });
      profiles = [...profiles, created];
      return okResponse({ profile: created });
    },
    async rename(id: string, displayName: string) {
      calls.rename.push([id, displayName]);
      profiles = profiles.map((p) => (p.id === id ? { ...p, displayName } : p));
      return okResponse({ profile: profiles.find((p) => p.id === id) });
    },
    async setDefault(id: string) {
      calls.setDefault.push(id);
      profiles = profiles.map((p) => ({ ...p, isDefault: p.id === id }));
      return okResponse({ profile: profiles.find((p) => p.id === id) });
    },
    async remove(id: string) {
      calls.remove.push(id);
      profiles = profiles.filter((p) => p.id !== id);
      return okResponse({ profile: makeProfile({ id }) });
    },
    async verify(id: string) {
      calls.verify.push(id);
      return okResponse({ profile: profiles.find((p) => p.id === id) });
    },
  };

  const stateHistory: ClaudeProfilesState[] = [INITIAL_CLAUDE_PROFILES_STATE];
  let currentState = INITIAL_CLAUDE_PROFILES_STATE;
  const setState = (updater: (previous: ClaudeProfilesState) => ClaudeProfilesState) => {
    currentState = updater(currentState);
    stateHistory.push(currentState);
  };

  const controller = createClaudeProfilesController(api, setState);

  return {
    controller,
    calls,
    stateHistory,
    setCreateShouldFail: (message: string | null) => { createShouldFail = message; },
    get state() { return currentState; },
  };
}

test('fetchProfiles: initial load sets loading, then clears it and populates profiles', async () => {
  const harness = createHarness([makeProfile()]);
  assert.equal(harness.state.loading, true);

  await harness.controller.fetchProfiles();

  assert.equal(harness.state.loading, false);
  assert.equal(harness.state.refreshing, false);
  assert.equal(harness.state.profiles.length, 1);
});

test('createProfile: API round-trip — calls create then refreshes the list', async () => {
  const harness = createHarness();

  await harness.controller.fetchProfiles(); // simulate mount
  const ok = await harness.controller.createProfile('Robin');

  assert.equal(ok, true);
  assert.deepEqual(harness.calls.create, ['Robin']);
  assert.equal(harness.calls.list, 2, 'list must be refetched after a successful create');
});

test('createProfile: Save actually persists the profile — it appears in state.profiles', async () => {
  const harness = createHarness();
  await harness.controller.fetchProfiles();

  await harness.controller.createProfile('Robin');

  assert.equal(harness.state.profiles.length, 1);
  assert.equal(harness.state.profiles[0].displayName, 'Robin');
});

test('createProfile: never sets loading back to true (the exact bug) — only refreshing toggles', async () => {
  const harness = createHarness();
  await harness.controller.fetchProfiles();

  const afterInitialLoadIndex = harness.stateHistory.findIndex((s) => s.loading === false);
  assert.notEqual(afterInitialLoadIndex, -1, 'the initial fetch must settle loading to false');

  await harness.controller.createProfile('Robin');

  // This is the literal regression: the old code set `loading: true` again
  // for the create-triggered background refresh, and the component's
  // `if (loading) return null` made the whole section (form included) blink
  // away and back, which is what "Save gives no visible feedback" was.
  const afterInitialLoad = harness.stateHistory.slice(afterInitialLoadIndex);
  assert.ok(afterInitialLoad.every((s) => s.loading === false), 'loading must never flip true again after the first load');
  assert.ok(afterInitialLoad.some((s) => s.refreshing === true), 'the create-triggered refresh must use refreshing, not loading');
});

test('createProfile: sets creating true while in flight and false once settled', async () => {
  const harness = createHarness();
  await harness.controller.fetchProfiles();

  await harness.controller.createProfile('Robin');

  assert.ok(harness.stateHistory.some((s) => s.creating === true), 'creating must be true at some point during the call');
  assert.equal(harness.stateHistory[harness.stateHistory.length - 1].creating, false);
});

test('createProfile: sets justCreated on success, for a one-shot success message', async () => {
  const harness = createHarness();
  await harness.controller.fetchProfiles();

  await harness.controller.createProfile('Robin');

  assert.equal(harness.state.justCreated?.displayName, 'Robin');
});

test('createProfile then createProfile again: two profiles can really be created (profile A then profile B)', async () => {
  const harness = createHarness();
  await harness.controller.fetchProfiles();

  await harness.controller.createProfile('Personal');
  await harness.controller.createProfile('Work');

  assert.equal(harness.state.profiles.length, 2);
  assert.deepEqual(harness.state.profiles.map((p) => p.displayName), ['Personal', 'Work']);
  assert.notEqual(harness.state.profiles[0].id, harness.state.profiles[1].id);
});

test('createProfile: a failed Save leaves the caller able to keep the form open and surfaces an error, without touching profiles', async () => {
  const harness = createHarness();
  await harness.controller.fetchProfiles();
  harness.setCreateShouldFail('duplicate name');

  const ok = await harness.controller.createProfile('Robin');

  assert.equal(ok, false, 'the caller (the component) uses this to decide whether to close the form');
  assert.equal(harness.state.error, 'duplicate name');
  assert.equal(harness.state.profiles.length, 0, 'a failed create must not fabricate a profile');
  assert.equal(harness.state.justCreated, null);
});

test('createProfile: starting a new create clears a stale justCreated from a previous one', async () => {
  const harness = createHarness();
  await harness.controller.fetchProfiles();
  await harness.controller.createProfile('Personal');
  assert.equal(harness.state.justCreated?.displayName, 'Personal');

  await harness.controller.createProfile('Work');
  assert.equal(harness.state.justCreated?.displayName, 'Work', 'the success message must reflect the latest save, not a stale one');
});

test('dismissJustCreated: clears the success message (used when "+ Add account" is opened again)', async () => {
  const harness = createHarness();
  await harness.controller.fetchProfiles();
  await harness.controller.createProfile('Robin');
  assert.ok(harness.state.justCreated);

  harness.controller.dismissJustCreated();
  assert.equal(harness.state.justCreated, null);
});

test('rename/setDefault/remove/verify: each refreshes the list and reports success', async () => {
  const harness = createHarness([makeProfile({ id: 'a', displayName: 'Personal', isDefault: true })]);
  await harness.controller.fetchProfiles();

  assert.equal(await harness.controller.renameProfile('a', 'Renamed'), true);
  assert.equal(harness.state.profiles[0].displayName, 'Renamed');

  assert.equal(await harness.controller.setDefaultProfile('a'), true);
  assert.deepEqual(harness.calls.setDefault, ['a']);

  assert.equal(await harness.controller.verifyProfile('a'), true);
  assert.deepEqual(harness.calls.verify, ['a']);

  assert.equal(await harness.controller.removeProfile('a'), true);
  assert.equal(harness.state.profiles.length, 0);
});
