import type {
  HostToWebview,
  InterventionView,
  ProviderGroup,
  WebviewState,
} from '../../src/orchestrator/webviewProtocol';

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
    records: [],
    busy: false,
    autoMode: false,
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
      items: [{ id: 's1', title: 'Session', updatedAt: 1234, scopeId: 'workspace' }],
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

export const PROTOCOL_CASES: readonly ProtocolCase[] = cases;
