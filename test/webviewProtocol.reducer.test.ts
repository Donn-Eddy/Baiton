import * as assert from 'assert';
import {
  reduce,
  initialWebviewState,
  pendingToolRecord,
  toRenderRecords,
  toolUpdate,
  ConversationRecord,
  WebviewState,
  RenderRecord,
  ConversationItem,
  SessionItem,
} from '../src/orchestrator/webviewProtocol';

describe('webview protocol reducer', () => {
  const rec = (
    role: RenderRecord['role'],
    content: string,
  ): RenderRecord => ({ role, content });

  it('renderConversation replaces the records and clears the empty state', () => {
    const state: WebviewState = {
      ...initialWebviewState(),
      records: [rec('user', 'old')],
      empty: { endpoint: 'http://x', model: 'm' },
    };
    const records = [rec('user', 'hi'), rec('assistant', 'hello')];
    const next = reduce(state, { type: 'renderConversation', records });

    assert.deepStrictEqual(next.records, records);
    assert.strictEqual(next.empty, undefined);
    // Reducer is pure: the input records array is copied, not aliased.
    assert.notStrictEqual(next.records, records);
    // Input state is not mutated.
    assert.deepStrictEqual(state.records, [rec('user', 'old')]);
  });

  it('appendMessage appends one record and clears the empty state', () => {
    const state: WebviewState = {
      ...initialWebviewState(),
      records: [rec('user', 'first')],
      empty: { endpoint: null, model: null },
    };
    const record = rec('assistant', 'second');
    const next = reduce(state, { type: 'appendMessage', record });

    assert.deepStrictEqual(next.records, [rec('user', 'first'), record]);
    assert.strictEqual(next.empty, undefined);
    // Input state is not mutated.
    assert.deepStrictEqual(state.records, [rec('user', 'first')]);
  });

  it('setConversations sets the selector entries', () => {
    const items: ConversationItem[] = [
      { id: 'workspace', label: 'Workspace' },
      { id: 'my-spec', label: 'my-spec' },
    ];
    const next = reduce(initialWebviewState(), { type: 'setConversations', items });

    assert.deepStrictEqual(next.conversations, items);
    // Copied, not aliased.
    assert.notStrictEqual(next.conversations, items);
  });

  it('setActive sets the active conversation id', () => {
    const next = reduce(initialWebviewState(), {
      type: 'setActive',
      conversationId: 'my-spec',
    });

    assert.strictEqual(next.activeId, 'my-spec');
  });

  it('setSessions sets the session list', () => {
    const items: SessionItem[] = [
      { id: '20260913-120000-a1b2', title: 'Add the login flow', updatedAt: '2026-09-13T12:00:00.000Z', scopeId: 'workspace' },
      { id: '20260912-090000-c3d4', title: 'New chat', updatedAt: '2026-09-12T09:00:00.000Z', scopeId: 'workspace' },
    ];
    const next = reduce(initialWebviewState(), { type: 'setSessions', items });

    assert.deepStrictEqual(next.sessions, items);
    // Copied, not aliased.
    assert.notStrictEqual(next.sessions, items);
  });

  it('setActiveSession sets the active session id', () => {
    const next = reduce(initialWebviewState(), {
      type: 'setActiveSession',
      sessionId: '20260913-120000-a1b2',
    });

    assert.strictEqual(next.activeSessionId, '20260913-120000-a1b2');
  });

  it('a fresh state has no sessions and no active session', () => {
    const seed = initialWebviewState();
    assert.deepStrictEqual(seed.sessions, []);
    assert.strictEqual(seed.activeSessionId, '');
  });

  it('showError sets the inline error with its optional fix action', () => {
    const withAction = reduce(initialWebviewState(), {
      type: 'showError',
      message: 'API key missing',
      action: 'setApiKey',
    });
    assert.deepStrictEqual(withAction.error, {
      message: 'API key missing',
      action: 'setApiKey',
    });

    const withoutAction = reduce(initialWebviewState(), {
      type: 'showError',
      message: 'endpoint unreachable',
    });
    assert.deepStrictEqual(withoutAction.error, {
      message: 'endpoint unreachable',
      action: undefined,
    });
  });

  it('setBusy toggles the busy flag both ways', () => {
    const busy = reduce(initialWebviewState(), { type: 'setBusy', busy: true });
    assert.strictEqual(busy.busy, true);

    const idle = reduce(busy, { type: 'setBusy', busy: false });
    assert.strictEqual(idle.busy, false);
  });

  it('setEmptyState sets the empty-state descriptor with configured values', () => {
    const configured = reduce(initialWebviewState(), {
      type: 'setEmptyState',
      endpoint: 'http://localhost:1234',
      model: 'gpt-x',
    });
    assert.deepStrictEqual(configured.empty, {
      endpoint: 'http://localhost:1234',
      model: 'gpt-x',
    });

    const unset = reduce(initialWebviewState(), {
      type: 'setEmptyState',
      endpoint: null,
      model: null,
    });
    assert.deepStrictEqual(unset.empty, { endpoint: null, model: null });
  });

  it('streamDelta starts a streaming assistant record, then grows it', () => {
    const seed: WebviewState = {
      ...initialWebviewState(),
      records: [rec('user', 'hi')],
      empty: { endpoint: null, model: null },
    };
    const started = reduce(seed, { type: 'streamDelta', text: 'Hel' });
    assert.deepStrictEqual(started.records, [
      rec('user', 'hi'),
      { role: 'assistant', content: 'Hel', streaming: true },
    ]);
    assert.strictEqual(started.empty, undefined);

    const grown = reduce(started, { type: 'streamDelta', text: 'lo' });
    assert.deepStrictEqual(grown.records, [
      rec('user', 'hi'),
      { role: 'assistant', content: 'Hello', streaming: true },
    ]);
    // Input state is not mutated.
    assert.strictEqual(started.records[1].content, 'Hel');
  });

  it('streamEnd finalizes the trailing streaming record and is a no-op otherwise', () => {
    const streaming = reduce(initialWebviewState(), { type: 'streamDelta', text: 'partial' });
    const ended = reduce(streaming, { type: 'streamEnd' });
    assert.deepStrictEqual(ended.records, [{ role: 'assistant', content: 'partial', streaming: false }]);

    const idle: WebviewState = { ...initialWebviewState(), records: [rec('user', 'x')] };
    assert.strictEqual(reduce(idle, { type: 'streamEnd' }), idle);
  });

  it('appendMessage replaces a trailing streaming record with the final assistant message', () => {
    const streaming = reduce(initialWebviewState(), { type: 'streamDelta', text: 'Hel' });
    const final = reduce(streaming, { type: 'appendMessage', record: rec('assistant', 'Hello') });
    assert.deepStrictEqual(final.records, [rec('assistant', 'Hello')]);
  });

  it('appendMessage of a non-assistant record finalizes a trailing streaming record first', () => {
    const streaming = reduce(initialWebviewState(), { type: 'streamDelta', text: 'thinking' });
    const next = reduce(streaming, { type: 'appendMessage', record: rec('tool', 'result') });
    assert.deepStrictEqual(next.records, [
      { role: 'assistant', content: 'thinking', streaming: false },
      rec('tool', 'result'),
    ]);
  });

  it('does not mutate the input state on any message', () => {
    const seed = initialWebviewState();
    const snapshot = JSON.stringify(seed);
    reduce(seed, { type: 'setBusy', busy: true });
    reduce(seed, { type: 'appendMessage', record: rec('user', 'x') });
    reduce(seed, { type: 'setActive', conversationId: 'y' });
    reduce(seed, { type: 'setSessions', items: [{ id: 's', title: 't', updatedAt: 1, scopeId: 'workspace' }] });
    reduce(seed, { type: 'setActiveSession', sessionId: 's' });
    assert.strictEqual(JSON.stringify(seed), snapshot);
  });
});

describe('toRenderRecords', () => {
  const call = (id: string, name: string, args: string) => ({ id, name, arguments: args });

  it('pairs an assistant tool call with its answering tool record into one row', () => {
    const records: ConversationRecord[] = [
      { role: 'user', content: 'read it' },
      { role: 'assistant', content: '', tool_calls: [call('c1', 'read_file', '{"path":"src/foo.ts"}')] },
      { role: 'tool', content: 'file body', tool_call_id: 'c1' },
      { role: 'assistant', content: 'Done.' },
    ];

    assert.deepStrictEqual(toRenderRecords(records), [
      { role: 'user', content: 'read it' },
      {
        role: 'tool',
        content: 'file body',
        tool: { id: 'c1', name: 'read_file', args: '{"path":"src/foo.ts"}', result: 'ok' },
      },
      { role: 'assistant', content: 'Done.' },
    ]);
  });

  it('emits no text bubble for an assistant record that is only tool calls', () => {
    const records: ConversationRecord[] = [
      { role: 'assistant', content: '   ', tool_calls: [call('c1', 'list_specs', '{}')] },
      { role: 'tool', content: 'ok', tool_call_id: 'c1' },
    ];
    const out = toRenderRecords(records);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].role, 'tool');
  });

  it('keeps the assistant text bubble when the tool-call turn also carries text', () => {
    const records: ConversationRecord[] = [
      { role: 'assistant', content: 'Looking.', tool_calls: [call('c1', 'search', '{"q":"x"}')] },
      { role: 'tool', content: 'hit', tool_call_id: 'c1' },
    ];
    const out = toRenderRecords(records);
    assert.deepStrictEqual(out[0], { role: 'assistant', content: 'Looking.' });
    assert.strictEqual(out[1].tool?.result, 'ok');
  });

  it('derives an error indicator from an `Error: ` tool result', () => {
    const records: ConversationRecord[] = [
      { role: 'assistant', content: '', tool_calls: [call('c1', 'read_file', '{"path":"nope"}')] },
      { role: 'tool', content: 'Error: no such file', tool_call_id: 'c1' },
    ];
    const [row] = toRenderRecords(records);
    assert.strictEqual(row.tool?.result, 'error');
    assert.strictEqual(row.content, 'Error: no such file');
  });

  it('renders a call with no answering record as pending with empty content', () => {
    const records: ConversationRecord[] = [
      { role: 'assistant', content: '', tool_calls: [call('c1', 'search', '{"q":"x"}')] },
    ];
    assert.deepStrictEqual(toRenderRecords(records), [
      {
        role: 'tool',
        content: '',
        tool: { id: 'c1', name: 'search', args: '{"q":"x"}', result: 'pending' },
      },
    ]);
  });

  it('renders an orphan tool result as a plain tool message', () => {
    const records: ConversationRecord[] = [
      { role: 'tool', content: 'stray', tool_call_id: 'ghost' },
    ];
    assert.deepStrictEqual(toRenderRecords(records), [{ role: 'tool', content: 'stray' }]);
  });

  it('pairs several calls in one assistant turn, each with its own result', () => {
    const records: ConversationRecord[] = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [call('a', 'read_file', '{"path":"a"}'), call('b', 'read_file', '{"path":"b"}')],
      },
      { role: 'tool', content: 'A', tool_call_id: 'a' },
      { role: 'tool', content: 'Error: b failed', tool_call_id: 'b' },
    ];
    const out = toRenderRecords(records);
    assert.strictEqual(out.length, 2);
    assert.deepStrictEqual(
      out.map((r) => [r.tool?.id, r.tool?.result, r.content]),
      [
        ['a', 'ok', 'A'],
        ['b', 'error', 'Error: b failed'],
      ],
    );
  });

  it('does not pair a tool record that precedes the call it names', () => {
    const records: ConversationRecord[] = [
      { role: 'tool', content: 'early', tool_call_id: 'c1' },
      { role: 'assistant', content: '', tool_calls: [call('c1', 'search', '{}')] },
    ];
    const out = toRenderRecords(records);
    assert.deepStrictEqual(out[0], { role: 'tool', content: 'early' });
    assert.strictEqual(out[1].tool?.result, 'pending');
  });
});

describe('updateTool', () => {
  const pending = pendingToolRecord({ id: 'c1', name: 'read_file', arguments: '{"path":"a"}' });

  it('settles the pending row with the matching call id', () => {
    const state: WebviewState = { ...initialWebviewState(), records: [pending] };
    const next = reduce(state, toolUpdate('c1', 'the body'));

    assert.deepStrictEqual(next.records, [
      {
        role: 'tool',
        content: 'the body',
        tool: { id: 'c1', name: 'read_file', args: '{"path":"a"}', result: 'ok' },
      },
    ]);
    // Input state is not mutated.
    assert.strictEqual(state.records[0].tool?.result, 'pending');
  });

  it('marks the row as an error when the result content is an error', () => {
    const state: WebviewState = { ...initialWebviewState(), records: [pending] };
    const next = reduce(state, toolUpdate('c1', 'Error: denied'));
    assert.strictEqual(next.records[0].tool?.result, 'error');
  });

  it('settles only the first row carrying the call id and leaves others alone', () => {
    const other = pendingToolRecord({ id: 'c2', name: 'search', arguments: '{}' });
    const state: WebviewState = { ...initialWebviewState(), records: [pending, other] };
    const next = reduce(state, toolUpdate('c1', 'done'));
    assert.strictEqual(next.records[0].tool?.result, 'ok');
    assert.strictEqual(next.records[1].tool?.result, 'pending');
  });

  it('is a no-op when no rendered row carries the call id', () => {
    const state: WebviewState = { ...initialWebviewState(), records: [pending] };
    assert.strictEqual(reduce(state, toolUpdate('nope', 'x')), state);
  });
});
