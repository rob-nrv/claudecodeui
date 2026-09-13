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

test('the footer wraps instead of letting tools and actions shrink into each other', () => {
  const markup = render();
  assert.ok(slot(markup, 'prompt-input-footer').classes.includes('flex-wrap'));

  const tools = slot(markup, 'prompt-input-tools').classes;
  assert.ok(tools.includes('shrink-0'));
  assert.ok(!tools.includes('min-w-0'), 'a shrinkable tools row spills its buttons under the actions');

  const actions = slot(markup, 'composer-actions').classes;
  assert.ok(actions.includes('shrink-0'));
  assert.ok(actions.includes('ml-auto'), 'wrapped actions must stay right-aligned');
});

test('the helper hint sits outside the primary actions and only takes leftover room', () => {
  const markup = render();
  const tools = slot(markup, 'prompt-input-tools');
  const hint = slot(markup, 'composer-hint');
  const actions = slot(markup, 'composer-actions');

  assert.ok(tools.index < hint.index && hint.index < actions.index);
  for (const cls of ['hidden', 'lg:flex', 'min-w-0', 'flex-1', 'basis-0', 'h-4', 'overflow-hidden', 'flex-wrap']) {
    assert.ok(hint.classes.includes(cls), `hint is missing ${cls}`);
  }
  assert.ok(!hint.classes.includes('shrink-0'));
  assert.ok(hint.tag.includes(`title="${ENTER_HINT}"`), 'the full hint stays available on hover');
  assert.doesNotMatch(markup.slice(actions.index), /Shift\+Enter/);

  const segments = [...markup.slice(hint.index, actions.index).matchAll(/<span class="max-w-full truncate">([^<]*)<\/span>/g)]
    .map((match) => match[1]);
  assert.deepEqual(segments, ['Enter to send', '• Shift+Enter for new line', '• Tab to change modes', '• / for slash commands']);
});

test('a running composer with a draft keeps one queue hint phrase and each primary control once', () => {
  const markup = render({ isLoading: true, input: 'follow up', hasInput: true });
  const hint = slot(markup, 'composer-hint');
  const actions = slot(markup, 'composer-actions');

  assert.match(hint.tag, /title="Enter to queue your next message"/);
  assert.equal(count(markup.slice(hint.index, actions.index), '<span class="max-w-full truncate">'), 1);
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

test('the slash-command badge grows for multi-digit counts instead of overflowing a fixed circle', () => {
  const markup = render({ slashCommandsCount: 128 });
  const badge = markup.match(/<span class="([^"]*)">128<\/span>/);
  assert.ok(badge, 'badge keeps the full count');
  const classes = badge[1].split(/\s+/);
  assert.ok(classes.includes('min-w-4') && classes.includes('h-4'));
  assert.ok(!classes.includes('w-4'));
});
