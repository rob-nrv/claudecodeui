import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { PendingPermissionRequest } from '../../types/types';

import PermissionRequestsBanner from './PermissionRequestsBanner';

const noop = () => undefined;

function render(requests: PendingPermissionRequest[]): string {
  return renderToStaticMarkup(
    React.createElement(PermissionRequestsBanner, {
      pendingPermissionRequests: requests,
      handlePermissionDecision: noop,
      handleGrantToolPermission: () => ({ success: true }),
      handlePermissionDismiss: noop,
    }),
  );
}

const bash = (overrides: Partial<PendingPermissionRequest>): PendingPermissionRequest => ({
  requestId: 'r1',
  toolName: 'Bash',
  input: { command: 'npm test' },
  sessionId: 'session-1',
  ...overrides,
});

const disabledButtonCount = (markup: string) => (markup.match(/<button[^>]*disabled=""/g) ?? []).length;

test('an expired approval renders as a settled notice with no approve or deny action', () => {
  const markup = render([bash({ status: 'expired' })]);
  assert.match(markup, /Permission request expired/);
  assert.match(markup, /npm test/);
  assert.match(markup, /Dismiss/);
  assert.doesNotMatch(markup, /Allow once|Deny/);
});

test('a request that is no longer available renders without actions', () => {
  const markup = render([bash({ status: 'unavailable' })]);
  assert.match(markup, /no longer available/);
  assert.doesNotMatch(markup, /Allow once/);
});

test('a request whose answer is being sent keeps its actions disabled', () => {
  const markup = render([bash({ status: 'submitting' })]);
  assert.match(markup, /Sending your answer/);
  assert.equal(disabledButtonCount(markup), 3);
});

test('a pending request is answerable, and says so when the last answer was not sent', () => {
  const pending = render([bash({ status: 'pending' })]);
  assert.match(pending, /Allow once/);
  assert.equal(disabledButtonCount(pending), 0);

  const notSent = render([bash({ status: 'pending', notice: 'not_sent' })]);
  assert.match(notSent, /Your answer was not sent/);
  assert.equal(disabledButtonCount(notSent), 0);
});

test('an AskUserQuestion being sent cannot be submitted or skipped again', () => {
  const markup = render([{
    requestId: 'q1',
    toolName: 'AskUserQuestion',
    sessionId: 'session-1',
    status: 'submitting',
    input: { questions: [{ question: 'Pick one?', header: 'Pick', options: [{ label: 'A' }, { label: 'B' }] }] },
  }]);
  assert.match(markup, /Sending…/);
  assert.match(markup, /<button[^>]*disabled=""[^>]*>Skip/);
});
