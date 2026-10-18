import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';

import i18next from 'i18next';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { initReactI18next } from 'react-i18next';

// ChatComposer reaches src/shared/utils.ts (through the voice hooks), which reads Vite's
// import.meta.env at module load. Node has no import.meta.env, so that one module gets an
// empty env here instead of the app code growing a test-only guard.
register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    const result = await nextLoad(url, context);
    if (!url.includes('/src/shared/utils.ts') || result.source == null) return result;
    const source = typeof result.source === 'string' ? result.source : new TextDecoder().decode(result.source);
    return { ...result, source: source.replace(/import\\.meta\\.env\\b/g, '(import.meta.env ?? {})') };
  }
`)}`);

const { default: ChatComposer } = await import('./ChatComposer');

const ENTER_HINT = 'Enter to send • Shift+Enter for new line • Tab to change modes • / for slash commands';

await i18next.use(initReactI18next).init({
  lng: 'en',
  ns: ['chat'],
  defaultNS: 'chat',
  resources: {
    en: { chat: { input: { hintText: { enter: ENTER_HINT }, send: 'Send', stop: 'Stop', attachFiles: 'Attach files' } } },
  },
  react: { useSuspense: false },
});

type ComposerProps = React.ComponentProps<typeof ChatComposer>;

const noop = () => undefined;

function render(overrides: Partial<ComposerProps> = {}): string {
  const props: ComposerProps = {
    pendingPermissionRequests: [],
    handlePermissionDecision: noop,
    handleGrantToolPermission: () => ({ success: true }),
    handlePermissionDismiss: noop,
    activity: null,
    isLoading: false,
    onAbortSession: noop,
    onSteerNow: async () => true,
    permissionMode: 'default',
    availablePermissionModes: ['default', 'acceptEdits', 'plan'],
    onSelectPermissionMode: noop,
    providerLabel: 'Claude',
    effort: 'high',
    availableEffortOptions: [{ value: 'low' }, { value: 'high' }],
    onSelectEffort: noop,
    model: 'opus',
    availableModelOptions: [{ value: 'opus', label: 'Opus 4.8' }],
    onSelectModel: noop,
    modelsLoading: false,
    tokenBudget: { used: 123456 },
    onShowTokenUsage: noop,
    slashCommandsCount: 42,
    onToggleCommandMenu: noop,
    hasInput: false,
    onClearInput: noop,
    onSubmit: noop,
    isDragActive: false,
    queuedDraft: null,
    onEditQueuedDraft: noop,
    onDeleteQueuedDraft: noop,
    attachedFiles: [],
    onRemoveAttachment: noop,
    uploadingFiles: new Map(),
    fileErrors: new Map(),
    showFileDropdown: false,
    filteredFiles: [],
    selectedFileIndex: -1,
    onSelectFile: noop,
    filteredCommands: [],
    selectedCommandIndex: -1,
    onCommandSelect: noop,
    onCloseCommandMenu: noop,
    isCommandMenuOpen: false,
    frequentCommands: [],
    getRootProps: () => ({}),
    getInputProps: () => ({ type: 'file' }),
    openAttachmentPicker: noop,
    inputHighlightRef: { current: null },
    renderInputWithMentions: (text) => text,
    textareaRef: { current: null },
    input: '',
    onInputChange: noop,
    onTextareaClick: noop,
    onTextareaKeyDown: noop,
    onTextareaPaste: noop,
    onTextareaScrollSync: noop,
    onTextareaInput: noop,
    placeholder: 'Message Claude',
    isTextareaExpanded: false,
    ...overrides,
  };
  return renderToStaticMarkup(React.createElement(ChatComposer, props));
}

function slot(markup: string, name: string) {
  const match = markup.match(new RegExp(`<[a-z]+[^>]*data-slot="${name}"[^>]*>`));
  assert.ok(match, `expected an element with data-slot="${name}"`);
  const classes = (match[0].match(/class="([^"]*)"/)?.[1] ?? '').split(/\s+/);
  return { index: match.index ?? -1, tag: match[0], classes };
}

const count = (markup: string, needle: string) => markup.split(needle).length - 1;

// Claude desktop composer: one box (attach, input, primary actions) and a row
// under it (permission mode on the left; model, effort and context on the right).

test('primary actions never shrink and the mode / model controls sit under the box', () => {
  const markup = render();
  const actions = slot(markup, 'composer-actions');
  assert.ok(actions.classes.includes('flex-shrink-0'), 'a shrinkable actions cluster collapses into the input');

  const formEnd = markup.indexOf('</form>');
  assert.ok(formEnd > actions.index, 'send / stop stay inside the box');
  assert.ok(markup.indexOf('aria-label="Select model and reasoning effort"') > formEnd, 'model menu is in the row under the box');
  assert.ok(markup.indexOf('aria-label="How should Claude actions be approved?"') > formEnd, 'permission mode is in the row under the box');
});

test('the keyboard hint is announced with the input instead of being drawn in the footer', () => {
  const markup = render();
  assert.match(markup, /aria-describedby="chat-composer-hint"/);
  assert.ok(markup.includes(`<span id="chat-composer-hint" class="sr-only">${ENTER_HINT}</span>`), 'the full hint is announced');
  assert.equal(count(markup, 'Shift+Enter'), 1, 'the hint is not repeated visibly');
});

test('a running composer with a draft keeps the queue hint and each primary control once', () => {
  const markup = render({ isLoading: true, input: 'follow up', hasInput: true });
  assert.ok(markup.includes('<span id="chat-composer-hint" class="sr-only">Enter to queue your next message</span>'));
  assert.equal(count(markup, 'aria-label="Queue next message"'), 1);
  assert.equal(count(markup, 'aria-label="Steer now'), 1);
  assert.equal(count(markup, 'aria-label="Select model and reasoning effort"'), 1);
  assert.equal(count(markup, 'aria-label="Attach files"'), 1);
});

test('an idle composer renders send, model and attach exactly once', () => {
  const markup = render();
  assert.equal(count(markup, 'aria-label="Send"'), 1);
  assert.equal(count(markup, 'aria-label="Select model and reasoning effort"'), 1);
  assert.equal(count(markup, 'aria-label="Attach files"'), 1);
  assert.equal(count(markup, '>Opus 4.8<'), 1);
});

test('a running composer without a draft offers stop, not send', () => {
  const markup = render({ isLoading: true });
  assert.equal(count(markup, 'aria-label="Stop"'), 1);
  assert.equal(count(markup, 'aria-label="Send"'), 0);
});
