import assert from 'node:assert/strict';
import test from 'node:test';

import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';

const findOption = (value: string) =>
  CLAUDE_PREDEFINED_MODELS.OPTIONS.find((option) => option.value === value);

test('capability metadata is only ever a static fact, never a fabricated number', async (t) => {
  await t.test('meta-aliases whose resolved model varies carry no capability', () => {
    for (const value of ['default', 'best', 'opusplan']) {
      const option = findOption(value);
      assert.ok(option, `expected a "${value}" option`);
      assert.equal(option?.capability, undefined);
    }
  });

  await t.test('named models carry sourced context-window/max-output facts', () => {
    const expectations: Record<string, { contextWindowTokens: number; maxOutputTokens: number }> = {
      fable: { contextWindowTokens: 1_000_000, maxOutputTokens: 128_000 },
      sonnet: { contextWindowTokens: 1_000_000, maxOutputTokens: 128_000 },
      'sonnet[1m]': { contextWindowTokens: 1_000_000, maxOutputTokens: 128_000 },
      opus: { contextWindowTokens: 1_000_000, maxOutputTokens: 128_000 },
      'opus[1m]': { contextWindowTokens: 1_000_000, maxOutputTokens: 128_000 },
      haiku: { contextWindowTokens: 200_000, maxOutputTokens: 64_000 },
    };

    for (const [value, expected] of Object.entries(expectations)) {
      const option = findOption(value);
      assert.ok(option, `expected a "${value}" option`);
      assert.deepEqual(option?.capability, expected);
    }
  });

  await t.test('no capability field is ever zero (unsupported must stay absent, not 0)', () => {
    for (const option of CLAUDE_PREDEFINED_MODELS.OPTIONS) {
      if (!option.capability) {
        continue;
      }
      assert.notEqual(option.capability.contextWindowTokens, 0);
      assert.notEqual(option.capability.maxOutputTokens, 0);
    }
  });
});
