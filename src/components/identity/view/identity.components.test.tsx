import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { resolveExecutionIdentity } from '../../../shared/identity';

import ExecutionIdentityBadge from './ExecutionIdentityBadge';
import IdentityMonogram from './IdentityMonogram';

const PROFILES = new Map([
  ['work-id', 'Work'],
  ['personal-id', 'Personal'],
]);

const identityFor = (claudeProfileId: string | null) =>
  resolveExecutionIdentity({ provider: 'claude', claudeProfileId, profileNamesById: PROFILES });

test('the execution badge renders the account name, not just a colour', () => {
  const markup = renderToStaticMarkup(
    React.createElement(ExecutionIdentityBadge, { identity: identityFor('work-id') }),
  );

  assert.match(markup, />Work</);
  assert.match(markup, />W</);
  assert.match(markup, /title="Claude · Work"/);
  assert.match(markup, /aria-label="Claude · Work"/);
});

test('Work and Personal produce visibly different badge text', () => {
  const work = renderToStaticMarkup(
    React.createElement(ExecutionIdentityBadge, { identity: identityFor('work-id') }),
  );
  const personal = renderToStaticMarkup(
    React.createElement(ExecutionIdentityBadge, { identity: identityFor('personal-id') }),
  );

  assert.notEqual(work, personal);
  assert.match(personal, />Personal</);
  assert.match(personal, />P</);
});

test('the execution badge renders nothing for an unbound execution', () => {
  const markup = renderToStaticMarkup(
    React.createElement(ExecutionIdentityBadge, { identity: identityFor(null) }),
  );

  assert.equal(markup, '');
});

test('a removed account is still labelled rather than silently dropped', () => {
  const markup = renderToStaticMarkup(
    React.createElement(ExecutionIdentityBadge, { identity: identityFor('deleted-id') }),
  );

  assert.match(markup, />Unknown account</);
  assert.match(markup, />\?</);
});

test('the execution badge truncates instead of overflowing a narrow row', () => {
  const longName = new Map([['work-id', 'Work account for the very long client engagement']]);
  const markup = renderToStaticMarkup(
    React.createElement(ExecutionIdentityBadge, {
      identity: resolveExecutionIdentity({
        provider: 'claude',
        claudeProfileId: 'work-id',
        profileNamesById: longName,
      }),
    }),
  );

  assert.match(markup, /truncate/);
  assert.match(markup, /min-w-0/);
});

test('the monogram is decorative — the readable label carries the meaning', () => {
  const markup = renderToStaticMarkup(
    React.createElement(IdentityMonogram, { monogram: 'C' }),
  );

  assert.match(markup, /aria-hidden="true"/);
  assert.match(markup, />C</);
});

