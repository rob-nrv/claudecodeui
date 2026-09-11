import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QuestionAnswerContent } from './QuestionAnswerContent';

// Regression coverage for the chat-interface crash where an AskUserQuestion
// payload loaded from a session transcript arrives with a non-array `questions`
// or a question missing its `options` array. Rendering must degrade gracefully
// instead of throwing "TypeError: e.map is not a function".

test('renders without throwing when questions is a non-array value', () => {
  assert.doesNotThrow(() => {
    renderToStaticMarkup(
      React.createElement(QuestionAnswerContent, {
        // Malformed: object instead of an array
        questions: { 0: { question: 'q?', options: [{ label: 'a' }] } } as never,
        answers: {},
      }),
    );
  });
});

test('renders without throwing when a question is missing options[]', () => {
  assert.doesNotThrow(() => {
    renderToStaticMarkup(
      React.createElement(QuestionAnswerContent, {
        questions: [{ question: 'Pick one?', header: 'H' } as never],
        answers: { 'Pick one?': 'X' },
      }),
    );
  });
});

test('renders without throwing when options[] contains malformed entries', () => {
  assert.doesNotThrow(() => {
    renderToStaticMarkup(
      React.createElement(QuestionAnswerContent, {
        questions: [{ question: 'Pick one?', options: [null, 'oops', { label: 'A' }] } as never],
        answers: { 'Pick one?': 'A, Custom' },
      }),
    );
  });
});

test('renders without throwing when a questions entry is null/non-object', () => {
  assert.doesNotThrow(() => {
    renderToStaticMarkup(
      React.createElement(QuestionAnswerContent, {
        questions: [null, 'oops', { question: 'Ok?', options: [{ label: 'A' }] }] as never,
        answers: {},
      }),
    );
  });
});

test('renders without throwing when an answer is a non-string value', () => {
  assert.doesNotThrow(() => {
    renderToStaticMarkup(
      React.createElement(QuestionAnswerContent, {
        questions: [{ question: 'Pick one?', options: [{ label: 'A' }] }],
        // Malformed: answer is an object instead of the expected string
        answers: { 'Pick one?': { unexpected: true } } as never,
      }),
    );
  });
});

test('still renders a well-formed question + answer', () => {
  const html = renderToStaticMarkup(
    React.createElement(QuestionAnswerContent, {
      questions: [{ question: 'Pick one?', header: 'H', options: [{ label: 'A' }, { label: 'B' }] }],
      answers: { 'Pick one?': 'A' },
    }),
  );
  assert.ok(html.includes('Pick one?'));
});

// HC-02: AskUserQuestion displayed -> answered for real -> the transcript
// must never read "Skipped". This component's own logic was already
// correct (it derives `skipped` from `!answer`); the bug was upstream —
// `answers` never reached this prop for a genuinely answered question
// because the CLI never rewrites the tool_use's own input (fixed in
// useSessionStore's `applyToolUseInputPatch` + the `permission_resolved`
// `toolId`/`toolInput` wiring). This test pins the contract this component
// must keep honouring once that data actually arrives.
test('a question that was really answered never renders as Skipped', () => {
  const markup = renderToStaticMarkup(
    React.createElement(QuestionAnswerContent, {
      questions: [{ question: 'Quelle option choisis-tu ?', header: 'Choix', options: [{ label: 'Option A' }, { label: 'Option B' }] }],
      answers: { 'Quelle option choisis-tu ?': 'Option A' },
    }),
  );
  assert.match(markup, /Option A/);
  assert.doesNotMatch(markup, /Skipped/);
});

// A question the CLI rejected (InputValidationError) was never shown to the
// user, so the transcript must not claim they skipped it.
test('a question rejected by input validation is not labelled as skipped', () => {
  const markup = renderToStaticMarkup(
    React.createElement(QuestionAnswerContent, {
      questions: [{ question: 'Pick one?', header: 'Pick', options: [{ label: 'Only' }] }],
      answers: {},
      resultError: '<tool_use_error>InputValidationError: [{"code":"too_small","path":["questions",0,"options"]}]',
    }),
  );
  assert.match(markup, /Not shown — Claude sent an invalid question/);
  assert.doesNotMatch(markup, /Skipped/);
});

test('an unanswered question without a failure is still labelled as skipped', () => {
  const markup = renderToStaticMarkup(
    React.createElement(QuestionAnswerContent, {
      questions: [{ question: 'Pick one?', options: [{ label: 'A' }, { label: 'B' }] }],
      answers: {},
    }),
  );
  assert.match(markup, /Skipped/);
});
