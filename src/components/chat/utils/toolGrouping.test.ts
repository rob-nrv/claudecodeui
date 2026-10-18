import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatMessage } from '../types/types';

import { countLineChanges, describeToolGroup, groupConsecutiveTools, isToolGroupItem, summarizeToolGroup } from './toolGrouping';

const tool = (toolName: string, toolInput: unknown = {}): ChatMessage => ({
  type: 'assistant',
  content: '',
  timestamp: '2026-10-18T10:00:00.000Z',
  isToolUse: true,
  toolName,
  toolInput,
} as ChatMessage);

const text = (content: string): ChatMessage => ({
  type: 'assistant',
  content,
  timestamp: '2026-10-18T10:00:00.000Z',
} as ChatMessage);

test('a single tool call between text blocks is collapsed into a group', () => {
  const items = groupConsecutiveTools([text('a'), tool('Bash', { command: 'ls' }), text('b')]);
  assert.equal(items.length, 3);
  assert.ok(isToolGroupItem(items[1]));
});

test('consecutive calls of different tools form one group', () => {
  const items = groupConsecutiveTools([tool('Read', { file_path: '/a/notes.md' }), tool('Glob', { pattern: '**/*.gd' })]);
  assert.equal(items.length, 1);
  assert.ok(isToolGroupItem(items[0]));
  assert.equal(items[0].messages.length, 2);
});

test('questions to the user and plan approval are never collapsed', () => {
  const items = groupConsecutiveTools([tool('Bash'), tool('AskUserQuestion'), tool('Bash')]);
  assert.equal(items.length, 3);
  assert.ok(isToolGroupItem(items[0]));
  assert.ok(!isToolGroupItem(items[1]));
  assert.ok(isToolGroupItem(items[2]));
});

test('a single command is summarized by its description', () => {
  assert.equal(
    summarizeToolGroup([tool('Bash', { command: 'unzip x', description: 'Listed the release notes in the archive' })]),
    'Listed the release notes in the archive',
  );
  assert.equal(summarizeToolGroup([tool('Bash', { command: 'ls' })]), 'Ran a command');
});

test('runs are phrased per kind in order, the way Claude desktop words them', () => {
  assert.equal(summarizeToolGroup([tool('Bash'), tool('Bash')]), 'Ran 2 commands');
  assert.equal(summarizeToolGroup([tool('Read', { file_path: '/a/1.md' }), tool('Read', { file_path: '/a/2.md' }), tool('Read', { file_path: '/a/3.md' })]), 'Read 3 files');
  assert.equal(summarizeToolGroup([tool('Bash'), tool('Read', { file_path: '/a/1.png' }), tool('Read', { file_path: '/a/2.png' })]), 'Ran a command, read 2 files');
  assert.equal(summarizeToolGroup([tool('Bash'), tool('Read', { file_path: '/a/shot.png' })]), 'Ran a command, read shot.png');
  assert.equal(summarizeToolGroup([tool('mcp__memory__save'), tool('Bash'), tool('Bash')]), 'Used a tool, ran 2 commands');
});

test('a single edited file carries its line diff', () => {
  const summary = describeToolGroup([
    tool('Bash'), tool('Bash'), tool('Bash'),
    tool('Edit', { file_path: '/w/build.py', old_string: ['a', 'b', 'c'].join('\n'), new_string: ['a', 'B', 'c', 'd'].join('\n') }),
  ]);
  assert.deepEqual(summary.segments, [{ text: 'Ran 3 commands' }, { text: ', ' }, { text: 'edited ' }, { text: 'build.py', strong: true }]);
  assert.deepEqual(summary.diff, { added: 2, removed: 1 });
  assert.equal(describeToolGroup([tool('Edit', { file_path: '/a' }), tool('Edit', { file_path: '/b' })]).diff, null);
});

test('line changes are counted like a diff view', () => {
  assert.deepEqual(countLineChanges(['a', 'b', 'c'], ['a', 'c']), { added: 0, removed: 1 });
  assert.deepEqual(countLineChanges([], ['x', 'y']), { added: 2, removed: 0 });
});

test('single file tools name the file', () => {
  assert.equal(summarizeToolGroup([tool('Read', { file_path: 'C:\\work\\notes.md' })]), 'Read notes.md');
  assert.equal(summarizeToolGroup([tool('Edit', { file_path: '/repo/src/App.tsx' })]), 'Edited App.tsx');
});
