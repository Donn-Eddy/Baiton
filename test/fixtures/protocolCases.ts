import type {
  HostToWebview,
  InterventionView,
  ProviderGroup,
  ProviderModelItem,
  WebviewState,
} from '../../src/orchestrator/webviewProtocol';
import { RUN_MODES } from '../../src/model/mode';

/**
 * Shared fixture cases both reducer implementations (the TypeScript core and
 * the `media/protocol.js` browser mirror) are folded over by
 * `test/webviewProtocol.mirror.test.ts`. Every `messages` entry must be a
 * valid `HostToWebview` variant: the TS reducer throws on unknown message
 * types while the mirror returns the state unchanged, so an unknown type
 * would diverge before any comparison could run.
 */

export interface ProtocolCase {
  name: string;
  /** Starting state; omit for `initialWebviewState()`. */
  state?: WebviewState;
  /** Messages folded left-to-right over the starting state. */
  messages: HostToWebview[];
  /** True when the fold must return the identical state reference (no-op). */
  sameReference?: boolean;
}

/** A fresh minimal WebviewState literal (not `initialWebviewState()`, to catch seed drift). */
export function seed(over: Partial<WebviewState> = {}): WebviewState {
  return {
    conversations: [],
    activeId: '',
    sessions: [],
    activeSessionId: '',
    readOnly: false,
    records: [],
    busy: false,
    autoMode: false,
    mode: 'spec',
    runActive: false,
    providers: [],
    selection: null,
    ...over,
  };
}

/** A minimal pending intervention card, overridable per field. */
export function ask(over: Partial<InterventionView> = {}): InterventionView {
  return { id: 'a1', kind: 'confirm', prompt: 'Approve?', status: 'pending', ...over };
}

/** A minimal provider group, overridable per field. */
export function group(over: Partial<ProviderGroup> = {}): ProviderGroup {
  return { id: 'google', label: 'Google AI Studio', enabled: true, models: [{ id: 'gemini-2.5-pro' }], ...over };
}

/** A minimal provider model item, overridable per field. */
export function modelItem(over: Partial<ProviderModelItem> = {}): ProviderModelItem {
  return { id: 'gemini-2.5-pro', ...over };
}

const cases: ProtocolCase[] = [];

// (1) renderConversation over a non-empty state
cases.push({
  name: 'renderConversation replaces records',
  state: seed({ records: [{ role: 'user', content: 'old' }] }),
  messages: [{ type: 'renderConversation', records: [{ role: 'user', content: 'new' }] }],
});

// (2) renderConversation clears the empty-state flag
cases.push({
  name: 'renderConversation clears empty',
  state: seed({ empty: { endpoint: null, model: null } }),
  messages: [{ type: 'renderConversation', records: [] }],
});

// (3) appendMessage onto an empty state
cases.push({
  name: 'appendMessage appends to empty conversation',
  messages: [{ type: 'appendMessage', record: { role: 'user', content: 'hi' } }],
});

// (4) appendMessage assistant replaces a trailing streaming record
cases.push({
  name: 'appendMessage assistant replaces trailing streaming record',
  state: seed({ records: [{ role: 'assistant', content: 'par', streaming: true }] }),
  messages: [{ type: 'appendMessage', record: { role: 'assistant', content: 'partial: full text' } }],
});

// (5) appendMessage user finalizes a trailing streaming record then appends
cases.push({
  name: 'appendMessage user finalizes streaming then appends',
  state: seed({ records: [{ role: 'assistant', content: 'str', streaming: true }] }),
  messages: [{ type: 'appendMessage', record: { role: 'user', content: 'next' } }],
});

// (6) streamDelta starts a record
cases.push({
  name: 'streamDelta starts a streaming record',
  messages: [{ type: 'streamDelta', text: 'hel' }],
});

// (7) streamDelta grows a trailing streaming record
cases.push({
  name: 'streamDelta grows the streaming record',
  state: seed({ records: [{ role: 'assistant', content: 'hel', streaming: true }] }),
  messages: [{ type: 'streamDelta', text: 'lo' }],
});

// (8) streamEnd on a streaming record
cases.push({
  name: 'streamEnd finalizes the streaming record',
  state: seed({ records: [{ role: 'assistant', content: 'text', streaming: true }] }),
  messages: [{ type: 'streamEnd' }],
});

// (9) streamEnd with no streaming record is a no-op
cases.push({
  name: 'streamEnd without a streaming record is a no-op',
  state: seed({ records: [{ role: 'user', content: 'plain' }] }),
  messages: [{ type: 'streamEnd' }],
  sameReference: true,
});

// (10) updateTool settles a pending row ok
cases.push({
  name: 'updateTool settles pending row ok',
  state: seed({
    records: [{ role: 'tool', content: '', tool: { id: 't1', name: 'Bash', args: '{}', result: 'pending' } }],
  }),
  messages: [{ type: 'updateTool', callId: 't1', result: 'ok', content: 'done' }],
});

// (11) updateTool settles a pending row error
cases.push({
  name: 'updateTool settles pending row error',
  state: seed({
    records: [{ role: 'tool', content: '', tool: { id: 't2', name: 'Bash', args: '{}', result: 'pending' } }],
  }),
  messages: [{ type: 'updateTool', callId: 't2', result: 'error', content: 'Error: nope' }],
});

// (12) updateTool with an unmatched call id is a no-op
cases.push({
  name: 'updateTool with unmatched call id is a no-op',
  state: seed({
    records: [{ role: 'tool', content: '', tool: { id: 't3', name: 'Bash', args: '{}', result: 'pending' } }],
  }),
  messages: [{ type: 'updateTool', callId: 'other', result: 'ok', content: 'done' }],
  sameReference: true,
});

// (13) showIntervention appends to an empty conversation
cases.push({
  name: 'showIntervention appends pending card to empty conversation',
  messages: [{ type: 'showIntervention', intervention: ask() }],
});

// (14) showIntervention replaces an already-rendered same-id card in place
cases.push({
  name: 'showIntervention replaces already-rendered card in place',
  state: seed({
    records: [
      { role: 'user', content: 'before' },
      { role: 'system', content: 'Approve?', intervention: ask({ status: 'resolved' }) },
    ],
  }),
  messages: [{ type: 'showIntervention', intervention: ask({ status: 'pending' }) }],
});

// (15) showIntervention finalizes a trailing streaming record first
cases.push({
  name: 'showIntervention finalizes trailing streaming record first',
  state: seed({ records: [{ role: 'assistant', content: 'str', streaming: true }] }),
  messages: [{ type: 'showIntervention', intervention: ask() }],
});

// (16) showIntervention question kind with options
cases.push({
  name: 'showIntervention question kind with options and free text',
  messages: [
    {
      type: 'showIntervention',
      intervention: ask({
        id: 'q1',
        kind: 'question',
        prompt: 'Which path?',
        options: [
          { id: 'o1', label: 'Option one' },
          { id: 'o2', label: 'Option two', detail: 'second line' },
        ],
        allowFreeText: true,
        placeholder: 'type here',
      }),
    },
  ],
});

// (17) showIntervention permission kind
cases.push({
  name: 'showIntervention permission kind carries agent/tool/args/detail',
  messages: [
    {
      type: 'showIntervention',
      intervention: ask({
        id: 'p1',
        kind: 'permission',
        prompt: 'Allow Bash?',
        detail: 'runs in workspace',
        agent: 'claude',
        tool: 'Bash',
        args: '{"cmd":"ls"}',
      }),
    },
  ],
});

// (18) resolveIntervention with option answer + rationale + auto
cases.push({
  name: 'resolveIntervention settles pending card with option answer',
  state: seed({
    records: [{ role: 'system', content: 'Which path?', intervention: ask({ id: 'q1', status: 'pending' }) }],
  }),
  messages: [
    {
      type: 'resolveIntervention',
      id: 'q1',
      answer: { kind: 'option', optionId: 'o2', label: 'Option two' },
      rationale: 'user picked',
      auto: false,
    },
  ],
});

// (19) resolveIntervention with text answer, rationale+auto omitted
// pins the written-but-undefined rationale/auto keys
cases.push({
  name: 'resolveIntervention with text answer omits rationale and auto',
  state: seed({
    records: [{ role: 'system', content: 'Code:', intervention: ask({ status: 'pending' }) }],
  }),
  messages: [{ type: 'resolveIntervention', id: 'a1', answer: { kind: 'text', text: 'typed' } }],
});

// (20) resolveIntervention approved with auto true
cases.push({
  name: 'resolveIntervention approved by auto mode',
  state: seed({
    records: [{ role: 'system', content: 'Approve?', intervention: ask({ status: 'pending' }) }],
  }),
  messages: [
    { type: 'resolveIntervention', id: 'a1', answer: { kind: 'approved' }, rationale: 'safe', auto: true },
  ],
});

// (21) resolveIntervention declined with reason omitted
cases.push({
  name: 'resolveIntervention declined without a reason',
  state: seed({
    records: [{ role: 'system', content: 'Approve?', intervention: ask({ status: 'pending' }) }],
  }),
  messages: [{ type: 'resolveIntervention', id: 'a1', answer: { kind: 'declined' } }],
});

// (22) resolveIntervention unknown id is a no-op
cases.push({
  name: 'resolveIntervention unknown id is a no-op',
  state: seed({
    records: [{ role: 'system', content: 'Approve?', intervention: ask({ status: 'pending' }) }],
  }),
  messages: [
    { type: 'resolveIntervention', id: 'nope', answer: { kind: 'approved' }, rationale: 'x', auto: true },
  ],
  sameReference: true,
});

// (23) resolveIntervention already-resolved card is a no-op
cases.push({
  name: 'resolveIntervention already-resolved card is a no-op',
  state: seed({
    records: [
      {
        role: 'system',
        content: 'Approve?',
        intervention: ask({ status: 'resolved', answer: { kind: 'approved' } }),
      },
    ],
  }),
  messages: [{ type: 'resolveIntervention', id: 'a1', answer: { kind: 'declined' } }],
  sameReference: true,
});

// (24) duplicate ids: only the first pending card settles
cases.push({
  name: 'resolveIntervention settles only the first pending card',
  state: seed({
    records: [
      { role: 'system', content: 'first', intervention: ask({ status: 'pending' }) },
      { role: 'system', content: 'second', intervention: ask({ status: 'pending' }) },
    ],
  }),
  messages: [{ type: 'resolveIntervention', id: 'a1', answer: { kind: 'declined', reason: 'no' } }],
});

// (25) resolveIntervention settles the first pending one when the earlier record is resolved
cases.push({
  name: 'resolveIntervention skips an already-resolved twin before a pending one',
  state: seed({
    records: [
      {
        role: 'system',
        content: 'first',
        intervention: ask({ status: 'resolved', answer: { kind: 'approved' } }),
      },
      { role: 'system', content: 'second', intervention: ask({ status: 'pending' }) },
    ],
  }),
  messages: [{ type: 'resolveIntervention', id: 'a1', answer: { kind: 'text', text: 'done' } }],
});

// (26) setAutoMode true
cases.push({
  name: 'setAutoMode true',
  messages: [{ type: 'setAutoMode', enabled: true }],
});

// (27) setAutoMode false
cases.push({
  name: 'setAutoMode false',
  state: seed({ autoMode: true }),
  messages: [{ type: 'setAutoMode', enabled: false }],
});

// (28) multi-message sequence interleaving auto mode with interventions
cases.push({
  name: 'interleaved auto mode and intervention sequence',
  messages: [
    { type: 'setAutoMode', enabled: true },
    { type: 'showIntervention', intervention: ask() },
    { type: 'resolveIntervention', id: 'a1', answer: { kind: 'approved' }, rationale: 'safe', auto: true },
    { type: 'showIntervention', intervention: ask({ id: 'a2', kind: 'question', prompt: 'Pick' }) },
    { type: 'setAutoMode', enabled: false },
    { type: 'resolveIntervention', id: 'a2', answer: { kind: 'text', text: 'user' } },
  ],
});

// (29) setConversations and setActive
cases.push({
  name: 'setConversations and setActive',
  messages: [
    { type: 'setConversations', items: [{ id: 'workspace', label: 'Workspace' }] },
    { type: 'setActive', conversationId: 'workspace' },
  ],
});

// (30) setSessions and setActiveSession
cases.push({
  name: 'setSessions and setActiveSession',
  messages: [
    {
      type: 'setSessions',
      items: [{ id: 's1', title: 'Session', updatedAt: 1234, scopeId: 'workspace', depth: 0 }],
    },
    { type: 'setActiveSession', sessionId: 's1' },
  ],
});

// (31) showError with action
cases.push({
  name: 'showError with action',
  messages: [{ type: 'showError', message: 'bad key', action: 'setApiKey' }],
});

// (32) showError without action
cases.push({
  name: 'showError without action',
  messages: [{ type: 'showError', message: 'boom' }],
});

// (33) setBusy
cases.push({
  name: 'setBusy toggles busy',
  messages: [{ type: 'setBusy', busy: true }],
});

// (34) setEmptyState with null endpoint and model
cases.push({
  name: 'setEmptyState with null endpoint and model',
  messages: [{ type: 'setEmptyState', endpoint: null, model: null }],
});

// (35) setEmptyState with values
cases.push({
  name: 'setEmptyState with endpoint and model',
  messages: [{ type: 'setEmptyState', endpoint: 'http://x', model: 'm' }],
});

// (36) an Auto-mode escalated card (summary, detail, command, audit reason)
// is shown, then settled by the user, carrying its escalation unchanged
cases.push({
  name: 'escalated card shows and settles with its escalation intact',
  messages: [
    {
      type: 'showIntervention',
      intervention: ask({
        kind: 'permission',
        prompt: 'Allow Bash?',
        agent: 'claude',
        tool: 'Bash',
        args: '{"command":"python scripts/seed.py"}',
        detail: 'Planner wants to run a script that edits rows in the dev database.',
        escalation: {
          summary: 'Planner wants to run a script that edits rows in the dev database.',
          detail: 'The script opens a connection to postgres://dev.',
          command: 'python scripts/seed.py',
          reason: 'the command is not a recognised read-only or verification command',
        },
      }),
    },
    { type: 'resolveIntervention', id: 'a1', answer: { kind: 'declined', reason: 'not now' } },
  ],
});

// (37) setProviders with the full provider list in catalog order and an active selection
cases.push({
  name: 'setProviders sets groups and the active selection',
  messages: [
    {
      type: 'setProviders',
      groups: [
        group({ id: 'copilot', label: 'GitHub Copilot', models: [{ id: 'gpt-4o', label: 'GPT-4o' }] }),
        group(),
        group({
          id: 'opencode',
          label: 'OpenCode Go',
          enabled: false,
          reason: 'Set an API key for OpenCode Go to use it.',
          models: [],
        }),
        group({ id: 'mistral', label: 'Mistral AI' }),
        group({
          id: 'openai',
          label: 'OpenAI / Custom',
          enabled: false,
          reason: 'Set baiton.orchestrator.endpoint to use OpenAI / Custom.',
          models: [],
        }),
      ],
      selection: { provider: 'google', model: 'gemini-2.5-pro' },
    },
  ],
});

// (38) setProviders with no selection chosen yet
cases.push({
  name: 'setProviders with a null selection',
  messages: [{ type: 'setProviders', groups: [group()], selection: null }],
});

// (39) setProviders clears the dropdown when no provider is available
cases.push({
  name: 'setProviders with no groups at all',
  messages: [{ type: 'setProviders', groups: [], selection: null }],
});

// (40) setProviders replaces a previously set provider list and selection
cases.push({
  name: 'setProviders replaces a previously set list',
  state: seed({
    providers: [group({ id: 'mistral', label: 'Mistral AI' })],
    selection: { provider: 'mistral', model: 'mistral-large-latest' },
  }),
  messages: [
    {
      type: 'setProviders',
      groups: [group({ id: 'copilot', label: 'GitHub Copilot' })],
      selection: { provider: 'copilot', model: 'gpt-4o' },
    },
  ],
});

// (41) setProviders leaves records, busy and auto mode untouched
cases.push({
  name: 'setProviders keeps records, busy and auto mode',
  state: seed({ records: [{ role: 'user', content: 'hi' }], busy: true, autoMode: true }),
  messages: [
    { type: 'setProviders', groups: [group()], selection: { provider: 'google', model: 'gemini-2.5-pro' } },
  ],
});

// (42) multi-message sequence interleaving provider updates with the empty state and streaming
cases.push({
  name: 'interleaved setProviders, empty state and streaming',
  messages: [
    {
      type: 'setProviders',
      groups: [
        group({
          id: 'copilot',
          label: 'GitHub Copilot',
          enabled: false,
          reason: 'Sign in to GitHub Copilot to use it.',
          models: [],
        }),
      ],
      selection: null,
    },
    { type: 'setEmptyState', endpoint: null, model: null },
    { type: 'streamDelta', text: 'hel' },
    {
      type: 'setProviders',
      groups: [group()],
      selection: { provider: 'google', model: 'gemini-2.5-pro' },
    },
  ],
});

// (43) showError with a provider-scoped key action
cases.push({
  name: 'showError with a provider-scoped key action',
  messages: [
    {
      type: 'showError',
      message: 'The Google AI Studio API key is not configured.',
      action: 'setApiKey',
      provider: 'google',
    },
  ],
});

// (44) showError replaces a provider-scoped error with a plain one: the
// `provider` key is cleared (present-undefined) rather than carried over
cases.push({
  name: 'showError replaces a provider-scoped error with a plain one',
  state: seed(),
  messages: [
    { type: 'showError', message: 'a', action: 'setApiKey', provider: 'mistral' },
    { type: 'showError', message: 'b' },
  ],
});

// (44b) showError with a provider-scoped endpoint action (a feed provider
// whose models.dev entry publishes no URL)
cases.push({
  name: 'showError with a provider-scoped endpoint action',
  messages: [
    {
      type: 'showError',
      message: 'The Deep Infra endpoint is not configured.',
      action: 'setEndpoint',
      provider: 'deepinfra',
    },
  ],
});

// (45) setProviders carries the catalog refresh time
cases.push({
  name: 'setProviders carries refreshedAt',
  messages: [
    {
      type: 'setProviders',
      groups: [group()],
      selection: { provider: 'google', model: 'gemini-2.5-pro' },
      refreshedAt: '2026-09-26T10:00:00.000Z',
    },
  ],
});

// (46) a setProviders without refreshedAt clears a previous one: the key stays
// present with the value `undefined` in both reducers
cases.push({
  name: 'setProviders without refreshedAt clears a previous one',
  state: seed({
    providers: [group()],
    selection: { provider: 'google', model: 'gemini-2.5-pro' },
    refreshedAt: '2026-09-01T00:00:00.000Z',
  }),
  messages: [
    { type: 'setProviders', groups: [group()], selection: { provider: 'google', model: 'gemini-2.5-pro' } },
  ],
});

// (47) setProviders with a group whose catalog snapshot is stale
cases.push({
  name: 'setProviders with a stale group',
  messages: [
    {
      type: 'setProviders',
      groups: [group({ stale: true, staleReason: 'models.dev fetch failed: timeout' })],
      selection: { provider: 'google', model: 'gemini-2.5-pro' },
    },
  ],
});

// (48) setProviders with a preserved selection marked as a custom model id
cases.push({
  name: 'setProviders with a custom model marker',
  messages: [
    {
      type: 'setProviders',
      groups: [group({ models: [modelItem(), modelItem({ id: 'gemini-9-preview', custom: true })] })],
      selection: { provider: 'google', model: 'gemini-9-preview' },
    },
  ],
});

// (49) setProviders with per-model reasoning-effort levels
cases.push({
  name: 'setProviders with per-model efforts',
  messages: [
    {
      type: 'setProviders',
      groups: [
        group({
          id: 'anthropic',
          label: 'Anthropic',
          models: [
            modelItem({ id: 'claude-sonnet-5', label: 'Claude Sonnet 5', efforts: ['low', 'medium', 'high'] }),
          ],
        }),
      ],
      selection: { provider: 'anthropic', model: 'claude-sonnet-5' },
    },
  ],
});

// (50) setProviders with a feed-derived provider id: an open string id survives the fold
cases.push({
  name: 'setProviders with a feed-derived provider id',
  messages: [
    {
      type: 'setProviders',
      groups: [
        group({
          id: 'deepinfra',
          label: 'DeepInfra',
          models: [modelItem({ id: 'deepseek-ai/DeepSeek-V3' })],
        }),
      ],
      selection: { provider: 'deepinfra', model: 'deepseek-ai/DeepSeek-V3' },
      refreshedAt: '2026-09-26T09:30:00.000Z',
    },
  ],
});

// (51) multi-message fold over the new fields: a fresh post, the empty state, then a stale re-post
cases.push({
  name: 'setProviders then setEmptyState then a stale re-post',
  messages: [
    {
      type: 'setProviders',
      groups: [group({ models: [modelItem(), modelItem({ id: 'gemini-9-preview', custom: true })] })],
      selection: { provider: 'google', model: 'gemini-9-preview' },
      refreshedAt: '2026-09-26T10:00:00.000Z',
    },
    { type: 'setEmptyState', endpoint: null, model: 'gemini-9-preview' },
    {
      type: 'setProviders',
      groups: [group({ stale: true, staleReason: 'models.dev fetch failed: offline' })],
      selection: { provider: 'google', model: 'gemini-2.5-pro' },
    },
  ],
});

// (52) setMode over a fresh state, once per mode: every RunMode folds the same way
for (const mode of RUN_MODES) {
  cases.push({
    name: `setMode sets the mode to ${mode}`,
    messages: [{ type: 'setMode', mode }],
  });
}

// (53) setMode over a state already carrying a mode: the new mode wins
cases.push({
  name: 'setMode overwrites a previously set mode',
  state: seed({ mode: 'bug' }),
  messages: [{ type: 'setMode', mode: 'refactor' }],
});

cases.push({
  name: 'setMode moves Default to a concrete mode',
  state: seed({ mode: 'default' }),
  messages: [{ type: 'setMode', mode: 'bug' }],
});

// (54) setMode over a rich state: nothing but the mode moves
cases.push({
  name: 'setMode leaves the rest of the state alone',
  state: seed({
    records: [{ role: 'user', content: 'hi' }],
    busy: true,
    autoMode: true,
    providers: [group()],
    selection: { provider: 'google', model: 'gemini-2.5-pro' },
    empty: { endpoint: null, model: null },
  }),
  messages: [{ type: 'setMode', mode: 'quick' }],
});

// (55) setRunActive both ways
cases.push({
  name: 'setRunActive turns the run flag on',
  messages: [{ type: 'setRunActive', active: true }],
});
cases.push({
  name: 'setRunActive turns the run flag off',
  state: seed({ runActive: true }),
  messages: [{ type: 'setRunActive', active: false }],
});

// (56) the two new fields are independent
cases.push({
  name: 'setRunActive does not disturb the mode',
  state: seed({ mode: 'investigate' }),
  messages: [{ type: 'setRunActive', active: true }],
});

// (57) multi-message fold over both new messages
cases.push({
  name: 'setMode then setRunActive then setRunActive off',
  messages: [
    { type: 'setMode', mode: 'bug' },
    { type: 'setRunActive', active: true },
    { type: 'setRunActive', active: false },
  ],
});

// (58) the new fields and the old flags do not clobber one another
cases.push({
  name: 'setMode interleaved with setBusy and setAutoMode',
  messages: [
    { type: 'setMode', mode: 'bug' },
    { type: 'setBusy', busy: true },
    { type: 'setAutoMode', enabled: true },
    { type: 'setRunActive', active: true },
    { type: 'setMode', mode: 'quick' },
  ],
});

// (59) setContextUsage
cases.push({
  name: 'setContextUsage sets the meter with a known window',
  messages: [{ type: 'setContextUsage', loaded: 256000, window: 1000000, source: 'usage' }],
});
cases.push({
  name: 'setContextUsage with an unknown window',
  messages: [{ type: 'setContextUsage', loaded: 1200, window: null, source: 'estimate' }],
});
cases.push({
  name: 'setContextUsage replaces a previous reading',
  state: seed({ context: { loaded: 5, window: 10, source: 'usage' } }),
  messages: [{ type: 'setContextUsage', loaded: 7, window: null, source: 'estimate' }],
});
cases.push({
  name: 'setContextUsage leaves busy, mode, records and error alone',
  state: seed({ busy: true, mode: 'bug', records: [{ role: 'user', content: 'hi' }] }),
  messages: [{ type: 'setContextUsage', loaded: 10, window: 100, source: 'estimate' }],
});
cases.push({
  name: 'setContextUsage interleaved with renderConversation and setBusy',
  messages: [
    { type: 'setBusy', busy: true },
    { type: 'setContextUsage', loaded: 10, window: 100, source: 'estimate' },
    { type: 'renderConversation', records: [] },
    { type: 'setBusy', busy: false },
  ],
});

const p1Item = { id: 'p1', title: 'Parent', updatedAt: 3, scopeId: 'workspace', depth: 0 };
const treeItems = [
  p1Item,
  { id: 'p1/c1', parentId: 'p1', title: 'Child task', updatedAt: 2, scopeId: 'workspace', depth: 1 },
  {
    id: 'p1/c1/g1',
    parentId: 'p1/c1',
    title: 'Grandchild',
    updatedAt: 1,
    scopeId: 'workspace',
    depth: 2,
  },
  { id: 'p2', title: 'Other', updatedAt: 0, scopeId: 'workspace', depth: 0 },
];

cases.push({
  name: 'setReadOnly turns read-only on',
  messages: [{ type: 'setReadOnly', readOnly: true }],
});

cases.push({
  name: 'setReadOnly turns read-only off',
  state: seed({ readOnly: true }),
  messages: [{ type: 'setReadOnly', readOnly: false }],
});

cases.push({
  name: 'setSessions carries a sub-chat tree',
  messages: [{ type: 'setSessions', items: treeItems }],
});

cases.push({
  name: 'setReadOnly leaves sessions, records, busy alone',
  state: seed({
    sessions: [p1Item],
    activeSessionId: 'p1',
    records: [{ role: 'user', content: 'hi' }],
    busy: true,
  }),
  messages: [{ type: 'setReadOnly', readOnly: true }],
});

cases.push({
  name: 'select a child then back to the parent',
  messages: [
    { type: 'setActiveSession', sessionId: 'p1/c1' },
    { type: 'setReadOnly', readOnly: true },
    { type: 'renderConversation', records: [{ role: 'assistant', content: 'child reply' }] },
    { type: 'setActiveSession', sessionId: 'p1' },
    { type: 'setReadOnly', readOnly: false },
  ],
});

export const PROTOCOL_CASES: readonly ProtocolCase[] = cases;
