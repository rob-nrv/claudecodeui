import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { SessionLineage } from '../types/types';

import SessionLineageLink from './SessionLineageLink';
import SessionLineageNotice from './SessionLineageNotice';

const noop = () => undefined;

const lineage = (overrides: Partial<SessionLineage> = {}): SessionLineage => ({
  sessionId: 'target',
  taskRootSessionId: 'source',
  incoming: null,
  outgoing: [],
  ...overrides,
});

test('a handoff target names the run it came from in words', () => {
  const markup = renderToStaticMarkup(React.createElement(SessionLineageLink, {
    lineage: lineage({
      incoming: {
        handoffId: 'h1',
        createdAt: '2026-09-11 10:00:00',
        sourceSessionId: 'source',
        sourceExists: true,
        sourceTitle: 'Fix login',
        sourceProvider: 'claude',
        sourceClaudeProfileId: 'work',
        sourceModel: null,
        sourceEffort: null,
        targetProvider: 'claude',
        targetClaudeProfileId: 'personal',
        targetStarted: false,
        handoffPackage: 'PACKAGE',
      },
    }),
    onNavigateToSession: noop,
  }));

  assert.match(markup, /↪ Fix login/);
  assert.match(markup, /aria-label="Continued from “Fix login”"/);
});

test('a continued session points at where the task went next', () => {
  const markup = renderToStaticMarkup(React.createElement(SessionLineageLink, {
    lineage: lineage({
      sessionId: 'source',
      outgoing: [
        { handoffId: 'h1', createdAt: 'a', targetSessionId: 't1', targetTitle: '↪ Fix login', targetProvider: 'codex', targetClaudeProfileId: null, targetStarted: true },
        { handoffId: 'h2', createdAt: 'b', targetSessionId: 't2', targetTitle: 'Second try', targetProvider: 'claude', targetClaudeProfileId: 'personal', targetStarted: false },
      ],
    }),
    onNavigateToSession: noop,
  }));

  assert.match(markup, /→ Second try \+1/);
  assert.match(markup, /Continued in “Second try” and 1 other run/);
});

test('a session without lineage renders nothing', () => {
  assert.equal(renderToStaticMarkup(React.createElement(SessionLineageLink, { lineage: lineage(), onNavigateToSession: noop })), '');
});

test('the new-run notice states the new identity and that the previous run is unchanged', () => {
  const markup = renderToStaticMarkup(React.createElement(SessionLineageNotice, {
    targetLabel: 'Claude · Personal',
    sourceLabel: 'Claude · Work',
    sourceTitle: 'Fix login',
    canOpenSource: true,
    isContextInComposer: true,
    onOpenSource: noop,
    onUseContext: noop,
  }));

  assert.match(markup, /New run on Claude · Personal\./);
  assert.match(markup, /from Claude · Work, which stays unchanged/);
  assert.match(markup, /Open previous run/);
  assert.doesNotMatch(markup, /Put context in composer/);
});
