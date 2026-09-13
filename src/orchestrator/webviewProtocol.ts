/**
 * Webview message protocol (host-free core) — Requirements 9.9, 19.4.
 *
 * The Chat_View is driven by a typed message union: the host sends
 * {@link HostToWebview} messages to the webview, and the webview sends
 * {@link WebviewToHost} messages back. The webview's UI is a projection of a
 * single {@link WebviewState}, and every host→webview message is folded into
 * that state by the pure {@link reduce} function.
 *
 * Because `reduce` is a pure function over plain data — carrying no `vscode`
 * import and touching no host API — the protocol and its state transitions are
 * unit-testable without a running VS Code host. The webview script and the
 * host glue both speak this same contract.
 */

/** The fix action an inline error message can offer (Req 13). */
export type FixAction = 'openSettings' | 'setApiKey';

/** A message the host sends to the webview to update its rendered state. */
export type HostToWebview =
  /** Replace the whole conversation with the given records, in order. */
  | { type: 'renderConversation'; records: RenderRecord[] }
  /** Append one record to the end of the current conversation. */
  | { type: 'appendMessage'; record: RenderRecord }
  /** Set the conversation selector's entries. */
  | { type: 'setConversations'; items: ConversationItem[] }
  /** Set which conversation entry is shown as active. */
  | { type: 'setActive'; conversationId: string }
  /** Set the session list shown for the active conversation scope. */
  | { type: 'setSessions'; items: SessionItem[] }
  /** Set which session is shown as active. */
  | { type: 'setActiveSession'; sessionId: string }
  /** Show an inline error message, optionally with a fix action. */
  | { type: 'showError'; message: string; action?: FixAction }
  /** Toggle the in-flight (busy) indication and send/stop enablement. */
  | { type: 'setBusy'; busy: boolean }
  /** Show the empty state with the configured endpoint and model values. */
  | { type: 'setEmptyState'; endpoint: string | null; model: string | null }
  /**
   * Append a fragment of streamed assistant text. Grows the trailing streaming
   * assistant record, or starts one when the last record is not streaming.
   */
  | { type: 'streamDelta'; text: string }
  /** Mark the trailing streaming assistant record complete, keeping its text. */
  | { type: 'streamEnd' }
  /**
   * Settle a pending tool row, keyed by the model's tool-call id: flips its
   * indicator to `ok`/`error` and attaches the tool's result content. A call id
   * that matches no rendered row leaves the state unchanged.
   */
  | { type: 'updateTool'; callId: string; result: 'ok' | 'error'; content: string };

/** A message the webview sends back to the host in response to user actions. */
export type WebviewToHost =
  /** The user submitted input text to send. */
  | { type: 'sendText'; text: string }
  /** The user activated the stop control. */
  | { type: 'stop' }
  /** The user asked to start a new chat session in the active scope. */
  | { type: 'newChat' }
  /** The user picked a session in the session list. */
  | { type: 'selectSession'; sessionId: string }
  /** The user asked to delete one session. */
  | { type: 'deleteSession'; sessionId: string }
  /** The user picked a conversation in the selector. */
  | { type: 'selectConversation'; conversationId: string }
  /** The user triggered the fix action on an inline error message. */
  | { type: 'triggerFix'; action: FixAction };

/** One entry in the conversation selector: `'workspace'` plus one per slug. */
export interface ConversationItem {
  /** The conversation id (`'workspace'` or a spec slug). */
  id: string;
  /** The human-readable label shown in the selector. */
  label: string;
}

/** One entry in the session list of the active conversation scope. */
export interface SessionItem {
  /** The session id, unique within its scope. */
  id: string;
  /** The derived session title shown in the list. */
  title: string;
  /** When the session was last appended to (ISO-8601 string or epoch ms). */
  updatedAt: string | number;
  /** The scope the session belongs to (`'workspace'` or a spec slug). */
  scopeId: string;
}

/** One renderable record in the conversation view. */
export interface RenderRecord {
  /** The message role. */
  role: 'user' | 'assistant' | 'tool' | 'system';
  /** The message content (assistant markdown, user text, or tool payload). */
  content: string;
  /**
   * Present for a tool-call row: the model's tool-call id (the key
   * `updateTool` settles the row by), the tool name, its argument JSON and the
   * result indicator.
   */
  tool?: { id?: string; name: string; args: string; result: 'ok' | 'error' | 'pending' };
  /** True while this assistant record is still receiving streamed text. */
  streaming?: boolean;
}

/**
 * The webview's UI state. The rendered view is a pure projection of this
 * value, and {@link reduce} is the only way it changes.
 */
export interface WebviewState {
  /** The conversation selector entries. */
  conversations: ConversationItem[];
  /** The id of the active conversation. */
  activeId: string;
  /** The sessions of the active conversation scope, newest first. */
  sessions: SessionItem[];
  /** The id of the active session, or `''` when a fresh chat has no id yet. */
  activeSessionId: string;
  /** The records rendered in the conversation view, in order. */
  records: RenderRecord[];
  /** Whether a request or the tool loop is in flight. */
  busy: boolean;
  /** The inline error currently shown, if any. */
  error?: { message: string; action?: FixAction };
  /** The empty-state descriptor, if the conversation has no messages. */
  empty?: { endpoint: string | null; model: string | null };
}

/** Compile-time exhaustiveness check for a union switch's default branch. */
function assertNever(value: never): never {
  throw new Error(`unhandled webview message: ${JSON.stringify(value)}`);
}

/** A fresh, empty webview state, useful as a reducer seed. */
export function initialWebviewState(): WebviewState {
  return {
    conversations: [],
    activeId: '',
    sessions: [],
    activeSessionId: '',
    records: [],
    busy: false,
  };
}

/**
 * Apply one {@link HostToWebview} message to the state and return the next
 * state. Pure: it never mutates its input and never touches a host API.
 *
 * - `renderConversation` replaces the records and clears the empty state.
 * - `appendMessage` appends one record and clears the empty state; an
 *   appended assistant record replaces a trailing streaming record (the
 *   complete message is authoritative), any other role first finalizes it.
 * - `streamDelta` grows the trailing streaming assistant record, or starts one.
 * - `streamEnd` marks the trailing streaming record complete, keeping its text.
 * - `updateTool` settles the pending tool row carrying the given call id.
 * - `setConversations` sets the selector entries.
 * - `setActive` sets the active conversation id.
 * - `setSessions` sets the session list; `setActiveSession` sets the active
 *   session id.
 * - `showError` sets the inline error; `setBusy` toggles the busy flag.
 * - `setEmptyState` sets the empty-state descriptor.
 */
export function reduce(state: WebviewState, msg: HostToWebview): WebviewState {
  switch (msg.type) {
    case 'renderConversation':
      return { ...state, records: [...msg.records], empty: undefined };
    case 'appendMessage': {
      const last = state.records[state.records.length - 1];
      if (last !== undefined && last.streaming === true) {
        const head = state.records.slice(0, -1);
        const records =
          msg.record.role === 'assistant'
            ? [...head, msg.record]
            : [...head, { ...last, streaming: false }, msg.record];
        return { ...state, records, empty: undefined };
      }
      return { ...state, records: [...state.records, msg.record], empty: undefined };
    }
    case 'streamDelta': {
      const last = state.records[state.records.length - 1];
      if (last !== undefined && last.streaming === true) {
        const grown: RenderRecord = { ...last, content: last.content + msg.text };
        return { ...state, records: [...state.records.slice(0, -1), grown], empty: undefined };
      }
      const started: RenderRecord = { role: 'assistant', content: msg.text, streaming: true };
      return { ...state, records: [...state.records, started], empty: undefined };
    }
    case 'streamEnd': {
      const last = state.records[state.records.length - 1];
      if (last === undefined || last.streaming !== true) {
        return state;
      }
      const done: RenderRecord = { ...last, streaming: false };
      return { ...state, records: [...state.records.slice(0, -1), done] };
    }
    case 'updateTool': {
      let found = false;
      const records = state.records.map((record) => {
        if (found || record.tool === undefined || record.tool.id !== msg.callId) {
          return record;
        }
        found = true;
        return { ...record, content: msg.content, tool: { ...record.tool, result: msg.result } };
      });
      return found ? { ...state, records } : state;
    }
    case 'setConversations':
      return { ...state, conversations: [...msg.items] };
    case 'setActive':
      return { ...state, activeId: msg.conversationId };
    case 'setSessions':
      return { ...state, sessions: [...msg.items] };
    case 'setActiveSession':
      return { ...state, activeSessionId: msg.sessionId };
    case 'showError':
      return { ...state, error: { message: msg.message, action: msg.action } };
    case 'setBusy':
      return { ...state, busy: msg.busy };
    case 'setEmptyState':
      return { ...state, empty: { endpoint: msg.endpoint, model: msg.model } };
    default:
      // Exhaustiveness guard: every HostToWebview variant is handled above, so
      // `msg` is `never` here. Assigning it proves the switch is exhaustive.
      return assertNever(msg);
  }
}

/**
 * One persisted conversation record, as the transcript stores it. Declared
 * structurally here so this core stays free of any host-facing import.
 */
export interface ConversationRecord {
  /** The message role on the conversation. */
  role: RenderRecord['role'];
  /** The message content. */
  content: string;
  /** For a `tool` record, the tool-call id it answers. */
  tool_call_id?: string;
  /** For an `assistant` record, the tool calls it requested. */
  tool_calls?: { id: string; name: string; arguments: string }[];
}

/** The prefix `toolResultContent` gives a failed tool result (see `toolLoop`). */
const TOOL_ERROR_PREFIX = 'Error: ';

/**
 * Project a persisted conversation into the records the view renders.
 *
 * Each assistant `tool_calls` entry is paired with the later `tool` record
 * carrying the same `tool_call_id`, collapsing the pair into a single tool row
 * whose `content` is the tool's result and whose indicator is derived from that
 * result (`Error: …` → `error`, anything else → `ok`). A call with no answering
 * record renders as `pending`. An assistant record whose content is empty and
 * that only requests tool calls emits no text bubble. A `tool` record that
 * answers no preceding call (an orphan) still renders, as a plain tool message,
 * so nothing recorded is silently dropped.
 *
 * Pure: it reads the given records and allocates fresh output.
 */
export function toRenderRecords(records: readonly ConversationRecord[]): RenderRecord[] {
  // First occurrence of each answering `tool` record, by call id.
  const answers = new Map<string, { index: number; content: string }>();
  records.forEach((record, index) => {
    if (record.role === 'tool' && record.tool_call_id !== undefined) {
      if (!answers.has(record.tool_call_id)) {
        answers.set(record.tool_call_id, { index, content: record.content });
      }
    }
  });

  const paired = new Set<number>();
  const out: RenderRecord[] = [];
  records.forEach((record, index) => {
    if (paired.has(index)) {
      return;
    }
    const calls = record.role === 'assistant' ? record.tool_calls : undefined;
    if (calls === undefined || calls.length === 0) {
      out.push({ role: record.role, content: record.content });
      return;
    }
    if (record.content.trim().length > 0) {
      out.push({ role: 'assistant', content: record.content });
    }
    for (const call of calls) {
      const found = answers.get(call.id);
      const answer = found !== undefined && found.index > index ? found : undefined;
      if (answer !== undefined) {
        paired.add(answer.index);
      }
      const result: NonNullable<RenderRecord['tool']>['result'] =
        answer === undefined ? 'pending' : answer.content.startsWith(TOOL_ERROR_PREFIX) ? 'error' : 'ok';
      out.push({
        role: 'tool',
        content: answer === undefined ? '' : answer.content,
        tool: { id: call.id, name: call.name, args: call.arguments, result },
      });
    }
  });
  return out;
}

/** The pending tool row posted when an assistant turn requests `call`. */
export function pendingToolRecord(call: {
  id: string;
  name: string;
  arguments: string;
}): RenderRecord {
  return {
    role: 'tool',
    content: '',
    tool: { id: call.id, name: call.name, args: call.arguments, result: 'pending' },
  };
}

/** The `updateTool` message settling `callId` with a tool result's content. */
export function toolUpdate(callId: string, content: string): HostToWebview {
  return {
    type: 'updateTool',
    callId,
    result: content.startsWith(TOOL_ERROR_PREFIX) ? 'error' : 'ok',
    content,
  };
}
