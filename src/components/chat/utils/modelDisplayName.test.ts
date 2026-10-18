import assert from 'node:assert/strict';
import test from 'node:test';

import { formatModelDisplayName } from './modelDisplayName';

test('raw Claude model ids read as family and version', () => {
  assert.equal(formatModelDisplayName('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(formatModelDisplayName('claude-sonnet-4-20250514'), 'Sonnet 4');
  assert.equal(formatModelDisplayName('claude-fable-5-1'), 'Fable 5.1');
});

test('labels that are not raw ids are left as written', () => {
  assert.equal(formatModelDisplayName('Opus 5.5'), 'Opus 5.5');
  assert.equal(formatModelDisplayName('gpt-5.3-codex'), 'gpt-5.3-codex');
  assert.equal(formatModelDisplayName('default'), 'default');
});
