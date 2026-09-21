/**
 * The Chat_View controller (task 12.1; design "ChatController"; Requirements 7,
 * 8, 11.6, 13, 14, 15).
 *
 * This is the `vscode`-aware glue that binds the {@link ChatWebview} surface to
 * the host-free cores: the {@link readTranscript} reader and {@link ChatTranscript}
 * writer, the {@link runToolLoop} tool loop, the {@link buildSystemPrompt}
 * builder, and the reused {@link ToolRegistry} and its pending-ask seams. It carries
 * no rendering logic of its own — the webview is a pure projection of the
 * protocol state — and no lifecycle state beyond the current conversation and
 * active spec, everything else being re-derived from disk each round.
 *
 * Responsibilities:
 *  - own the chat sessions of each conversation scope through the host-free
 *    {@link SessionStore}: workspace sessions live at `.baiton/chat/<id>.jsonl`
 *    and each spec's at `.baiton/specs/<slug>/chat/<id>.jsonl` (Req 8.1), with
 *    the pre-sessions `chat.jsonl` migrated into that layout on start;
 *  - load it through {@link readTranscript} on open/reopen/window-reload and
 *    render its records in order (Req 8.6, 8.8);
 *  - own the conversation selector (Workspace first, then spec entries in
 *    ascending slug order) and active-spec tracking that follows explorer
 *    selection and the active editor when it is a `spec.md`, reflecting the
 *    active spec in the selector (Req 7.1–7.7);
 *  - on send, derive the conversation's orchestrator phase from `spec.md` and
 *    advertise only that phase's tools, passing the phase into every registry
 *    call so an out-of-phase tool cannot run (Req 11.1);
 *  - on send, re-read `spec.md` each round and build the fresh system prompt
 *    (Req 11.6), enforce the non-whitespace / ≤100,000-character send guard
 *    (Req 14.4, 14.5) and send/stop enablement (Req 14.2, 14.3), and run the
 *    tool loop (Req 9, 14.4);
 *  - abort through an {@link AbortController} on stop and surface a stopped
 *    indication (Req 14.6, 14.7);
 *  - present every human-in-the-loop ask raised through the shared
 *    `PendingAskRegistry` as an inline card, settle it in place on
 *    `answerIntervention` (which resumes the paused tool call), persist the
 *    settled card to the transcript, and decline every pending ask on stop;
 *    while Auto mode is on a harness permission ask is first put through the
 *    gate — an approval settles it with no round-trip and an escalation asks
 *    the user — and both outcomes are persisted, so the transcript is the
 *    audit trail;
 *  - map {@link MissingConfigError} (by `.missing`) and
 *    {@link UnreachableEndpointError} to inline messages with the correct fix
 *    action, leaving the transcript unchanged on a fix action (Req 13.1–13.4);
 *  - show the empty state with the configured endpoint and model (indicating
 *    "not configured" for each unset one) and a Set API Key action (Req 13.5).
 */
import * as path from 'path';
import { mkdir, readFile } from 'fs/promises';
import type { GuardContext, ToolRegistry } from '../orchestrator';
import {
  MissingConfigError,
  UnreachableEndpointError,
  buildSystemPrompt,
  escalatedInterventionView,
  interventionTranscriptRecord,
  interventionUpdate,
  phaseFor,
  readTranscript,
  pendingToolRecord,
  PendingAskRegistry,
  SessionStore,
  resolveRoundBound,
  runToolLoop,
  settledInterventionView,
  toRenderRecords,
  toolUpdate,
} from '../orchestrator';
import type {
  AutoModeOutcome,
  ChatMessage,
  SessionItem,
  SessionMeta,
  SessionScope,
  ConversationItem,
  ConversationKind,
  FixAction,
  HostToWebview,
  Intervention,
  InterventionAnswer,
  InterventionView,
  ModelClient,
  OrchestratorPhase,
  PermissionRequest,
  RenderRecord,
  ToolResult,
  ToolSpec,
  TranscriptRecord,
  WebviewToHost,
} from '../orchestrator';
import { ChatTranscript, scopeId } from '../orchestrator';
import { listSpecs } from './specLister';

/** The conversation-selector id of the Workspace_Conversation. */
export const WORKSPACE_CONVERSATION_ID = 'workspace';

/** The maximum input length a send is allowed to carry (Req 14.4, 14.5). */
export const MAX_INPUT_CHARS = 100_000;

/** The reason every still-pending ask is declined with when the user stops a run. */
export const STOP_DECLINE_REASON = 'the run was stopped';

/**
 * The webview surface the controller drives. The {@link ChatWebview} provider
 * implements it; keeping it an interface lets the controller be unit-tested
 * against a fake surface without a VS Code host.
 */
export interface ChatWebview {
  /** Send one host→webview message to the view. */
  post(msg: HostToWebview): void;
  /** Register a handler for messages coming back from the view. */
  onMessage(handler: (msg: WebviewToHost) => void): void;
}

/** How the controller reads the configured endpoint and model for the empty state (Req 13.5). */
export interface OrchestratorConfig {
  /** The configured endpoint value, or `null`/`undefined` when unset. */
  getEndpoint(): string | null | undefined;
  /** The configured model value, or `null`/`undefined` when unset. */
  getModel(): string | null | undefined;
}

/**
 * The fix-action sink the controller invokes when the user triggers an inline
 * error's fix. `openSettings` opens the relevant Baiton settings; `setApiKey`
 * invokes the Set Orchestrator API Key command (Req 13.1–13.4).
 */
export type TriggerFix = (action: FixAction) => void | Promise<void>;

/**
 * The seams the controller depends on, all injected so the controller stays
 * host-free and testable. The {@link ChatWebview} provider supplies the real
 * ones from `vscode` state.
 */
export interface ChatControllerDeps {
  /** The webview surface (post / onMessage). */
  webview: ChatWebview;
  /** The reused model client; streamed text fragments are forwarded to the view. */
  client: ModelClient;
  /** The reused, guard-wrapped tool registry. */
  registry: ToolRegistry;
  /**
   * The assembled tool definitions to advertise to the model for one
   * orchestrator phase (Req 10.3, 11.1). The controller derives the phase from
   * the conversation on every send, so a conversation gathering requirements
   * and one driving an approved spec see different tools.
   */
  toolsFor(phase: OrchestratorPhase): ToolSpec[];
  /** Builds the guard context for a tool call (repo/specs/restricted). */
  guardContext(): GuardContext;
  /**
   * The pending-ask registry shared with the tool registry's seams. The host
   * creates one registry, wraps it in an `InterventionSeam` whose `present`
   * forwards to {@link ChatController.presentIntervention}, and adapts that
   * seam into the `ConfirmSeam` the tools gate on, so every ask raised by a
   * tool settles through this controller. Defaults to a private registry (no
   * tool can reach it) so a test can construct the controller without one.
   */
  askRegistry?: PendingAskRegistry;
  /** Absolute `.baiton/` directory: `<baitonDir>/chat/` holds workspace sessions. */
  baitonDir: string;
  /** Absolute `.baiton/specs/` directory: `<specsDir>/<slug>/chat/` holds a spec's sessions. */
  specsDir: string;
  /** Reads the configured Round_Bound; resolved through {@link resolveRoundBound}. */
  roundBound(): unknown;
  /** Reads the configured endpoint/model for the empty state (Req 13.5). */
  config: OrchestratorConfig;
  /** Invoked on an inline-error fix action (Req 13.4). */
  triggerFix: TriggerFix;
  /** Surfaces a contained failure (e.g. a transcript-write error) to the log. */
  log(message: string): void;
  /**
   * Confirm deleting a chat session; resolves true to proceed. Absent, the
   * deletion proceeds without a prompt.
   */
  confirmDelete?(message: string): Promise<boolean>;
  /**
   * Remembers the last active session per conversation scope, so a window
   * reload reopens the session the user was in. Wired to `workspaceState`.
   */
  sessionMemory?: SessionMemory;
  /** Overrides the session store; defaults to one over `baitonDir`/`specsDir`. */
  sessionStore?: SessionStore;
  /**
   * Persists the Auto-mode toggle across windows. Absent, the toggle still
   * works for the life of the controller but starts off on every reload.
   */
  autoModeMemory?: AutoModeMemory;
  /**
   * Decides a harness permission ask while Auto mode is on. Absent, Auto mode
   * gates nothing and every ask is presented to the user as usual.
   */
  autoGate?: AutoModeGate;
}

/** Remembers the Auto-mode toggle across windows (backed by `workspaceState`). */
export interface AutoModeMemory {
  /** The remembered state; `false` when nothing was ever stored. */
  get(): boolean;
  /** Remember the new state. */
  set(enabled: boolean): Promise<void>;
}

/**
 * The Auto-mode gate over one harness permission ask: the host binds it to the
 * two-stage `decideAsk` (deterministic allow-list, then the model risk
 * evaluation). It must never throw — the controller treats a thrown value as
 * an escalation, so a broken gate can only ever ask the user.
 */
export type AutoModeGate = (
  ask: PermissionRequest,
  opts: { signal?: AbortSignal },
) => Promise<AutoModeOutcome>;

/** Per-scope memory of the last active session (backed by `workspaceState`). */
export interface SessionMemory {
  /** The remembered session id for a scope, or `undefined` when there is none. */
  get(scope: string): string | undefined;
  /** Remember `sessionId` as the scope's active session. */
  set(scope: string, sessionId: string): Promise<void>;
}

/**
 * Binds the Chat_View to the tool loop, transcripts, conversation selector,
 * and active-spec tracking. Construct it once per workspace, wire the webview's
 * message handler through {@link start}, and update the active spec from the
 * explorer or the active editor through {@link setActiveSpec}.
 */
export class ChatController {
  private readonly deps: ChatControllerDeps;

  /** The active spec slug, or `undefined` for the Workspace_Conversation (Req 7.2). */
  private activeSpec: string | undefined;

  /** The conversation-selector entries, refreshed from disk (Req 7.1). */
  private conversations: ConversationItem[] = [];

  /** Whether a request or the tool loop is in flight (Req 14.2, 14.3). */
  private busy = false;

  /** Whether Auto mode is on; seeded from `autoModeMemory` and echoed to the view. */
  private autoMode = false;

  /** Aborts the in-flight run; created per send, triggered on stop (Req 14.6). */
  private abort: AbortController | undefined;

  /** Lists/creates/deletes the per-scope chat sessions on disk. */
  private readonly sessions: SessionStore;

  /**
   * The active session id per scope key ({@link scopeId}). An entry may name a
   * session that has no file yet: a fresh chat persists on its first append.
   */
  private readonly activeSessions = new Map<string, string>();

  /** `<scopeKey>/<sessionId>` of the session a run is in flight on, if any. */
  private runningKey: string | undefined;

  /** The pending-ask registry every inline card settles through. */
  private readonly asks: PendingAskRegistry;

  /** Cards currently on screen, by ask id: the view plus where its settled record is written. */
  private readonly cards = new Map<string, PendingCard>();

  /** Scope keys whose legacy `chat.jsonl` migration has already been attempted. */
  private readonly migrated = new Set<string>();

  constructor(deps: ChatControllerDeps) {
    this.deps = deps;
    this.sessions =
      deps.sessionStore ??
      new SessionStore({ baitonDir: deps.baitonDir, specsDir: deps.specsDir });
    this.asks =
      deps.askRegistry ??
      new PendingAskRegistry({
        ids: { next: () => `ask-${Date.now()}-${Math.random().toString(36).slice(2)}` },
      });
    this.autoMode = deps.autoModeMemory?.get() ?? false;
  }

  /**
   * Wire the webview's message handler and render the initial conversation.
   * Call once after the view is bound (on first resolve and again on reopen /
   * window reload, since the webview restarts from empty state).
   */
  public start(): void {
    this.deps.webview.onMessage((msg) => void this.handle(msg));
    void this.refresh();
  }

  /**
   * Set the active spec from the explorer selection or the active editor
   * (Req 7.4, 7.5). `undefined` selects the Workspace_Conversation (Req 7.2). A
   * no-op when the spec is already active, so an editor-activation storm does
   * not reload the transcript repeatedly.
   */
  public setActiveSpec(slug: string | undefined): void {
    if (slug === this.activeSpec) {
      return;
    }
    this.activeSpec = slug;
    void this.refresh();
  }

  /**
   * Record a system note on the Workspace_Conversation and refresh the view.
   *
   * Used by out-of-band work the user started from the chat but that finishes
   * after the turn ended — today the spec draft, which reports its outcome here
   * once the harness has written the spec. The refresh also re-reads the spec
   * list, so a newly drafted spec appears in the conversation selector.
   */
  public async noteSystem(message: string): Promise<void> {
    const scope: SessionScope = { kind: 'workspace' };
    const listed = await this.sessions.list(scope);
    const target = listed[0]?.id ?? this.newSessionId(scope);
    await this.append(this.transcriptFor(scope, target), { role: 'system', content: message });
    await this.refresh();
  }

  // --- webview messages ----------------------------------------------------

  /** Dispatch one webview→host message. */
  private async handle(msg: WebviewToHost): Promise<void> {
    switch (msg.type) {
      case 'sendText':
        await this.onSend(msg.text);
        return;
      case 'stop':
        this.onStop();
        return;
      case 'newChat':
        await this.onNewChat();
        return;
      case 'selectSession':
        await this.onSelectSession(msg.sessionId);
        return;
      case 'deleteSession':
        await this.onDeleteSession(msg.sessionId);
        return;
      case 'selectConversation':
        this.onSelectConversation(msg.conversationId);
        return;
      case 'triggerFix':
        await this.deps.triggerFix(msg.action);
        return;
      case 'answerIntervention':
        await this.onAnswerIntervention(msg.id, msg.answer);
        return;
      case 'setAutoMode':
        await this.onSetAutoMode(msg.enabled);
        return;
    }
  }

  /**
   * Show one pending ask as an inline card on the conversation currently in
   * view, and remember which transcript its settled record belongs to. Bound
   * by the host as the `present` of the shared `InterventionSeam`; the seam
   * declines the ask automatically if this throws.
   */
  /**
   * The user flipped the Auto toggle. The webview is a pure projection, so the
   * host is the one that flips the state and echoes it back; the new state is
   * remembered for the next window. Only asks presented after this point are
   * gated: a card already on screen stays the user's to answer.
   */
  private async onSetAutoMode(enabled: boolean): Promise<void> {
    this.autoMode = enabled;
    this.deps.webview.post({ type: 'setAutoMode', enabled });
    try {
      await this.deps.autoModeMemory?.set(enabled);
    } catch (err) {
      this.deps.log(`Baiton chat: could not remember the Auto-mode setting: ${describe(err)}`);
    }
  }

  /**
   * Show one pending ask as an inline card on the conversation currently in
   * view, and remember which transcript its settled record belongs to.
   *
   * While Auto mode is on, a harness `permission` ask is first put through the
   * gate: an approval settles the ask with no round-trip and posts the card
   * already resolved and flagged `auto`, and an escalation is shown as an
   * ordinary pending card carrying the 'what you are approving / why it was
   * flagged' description. Confirmations and questions are never gated — they
   * carry human intent, not a harness capability. Both outcomes are persisted,
   * so the transcript is the audit trail.
   */
  public async presentIntervention(ask: Intervention): Promise<void> {
    const scope = await this.scopeForAsk(ask);
    const key = scopeId(scope);
    const sessionId = this.activeSessions.get(key) ?? this.newSessionId(scope);
    const transcript = this.transcriptFor(scope, sessionId);
    const view = toInterventionView(ask);
    const outcome = await this.autoDecision(ask);
    if (outcome !== undefined && outcome.kind === 'approve') {
      await this.autoApprove(ask.id, view, transcript, outcome);
      return;
    }
    const card = outcome === undefined ? view : escalatedInterventionView(view, outcome);
    this.cards.set(ask.id, { view: card, transcript, scopeKey: key });
    this.deps.webview.post({ type: 'showIntervention', intervention: card });
    if (outcome !== undefined) {
      // Audit the escalation now, while it happens: the same id is appended
      // again, settled, once the user answers, and `toRenderRecords` renders
      // the pair as the one card in its original position.
      await this.append(transcript, interventionTranscriptRecord(card));
    }
  }

  /** Return the conversation an ask belongs on, switching to a scoped run when needed. */
  private async scopeForAsk(ask: Intervention): Promise<SessionScope> {
    const slug = ask.scopeId;
    if (slug === undefined || slug === this.activeSpec) {
      return this.activeScope();
    }
    this.activeSpec = slug;
    await this.refresh();
    return this.activeScope();
  }

  /**
   * Run the Auto-mode gate over one ask, or `undefined` when the ask is not
   * gated (Auto mode off, no gate wired, or an ask that is not a harness
   * permission). A gate that throws escalates: Auto mode may only ever fail
   * towards asking the user.
   */
  private async autoDecision(ask: Intervention): Promise<AutoModeOutcome | undefined> {
    if (!this.autoMode || this.deps.autoGate === undefined || ask.kind !== 'permission') {
      return undefined;
    }
    try {
      return await this.deps.autoGate(ask, { signal: this.abort?.signal });
    } catch (err) {
      this.deps.log(`Baiton chat: the Auto-mode gate failed: ${describe(err)}`);
      return {
        kind: 'escalate',
        what: `${ask.agent} wants to run ${ask.tool}`,
        why: `Auto mode could not decide: ${describe(err)}`,
      };
    }
  }

  /**
   * Settle an auto-approved ask: resolve the registry entry (resuming the
   * paused harness), post the card already resolved — no card is ever shown
   * pending for it — and persist it as the auditable record of the approval.
   * A stop that declined the ask while the gate ran wins: the resolve fails
   * and nothing further is posted or written.
   */
  private async autoApprove(
    id: string,
    view: InterventionView,
    transcript: ChatTranscript,
    outcome: Extract<AutoModeOutcome, { kind: 'approve' }>,
  ): Promise<void> {
    const answer: InterventionAnswer = { kind: 'approved' };
    if (this.asks.resolve(id, answer).kind !== 'resolved') {
      return;
    }
    const rationale = autoApprovalRationale(outcome);
    const settled = settledInterventionView(view, answer, { rationale, auto: true });
    this.deps.webview.post({ type: 'showIntervention', intervention: settled });
    await this.append(transcript, interventionTranscriptRecord(settled));
  }

  /**
   * The user answered an inline card. A valid answer settles the originating
   * ask — resuming whichever flow is awaiting it — settles the card in the
   * view and appends the settled card to the transcript. An answer the request
   * does not accept leaves the card pending and reports why; an id that is no
   * longer active (a card left over from a previous window) is settled in the
   * view as declined so it never stays stuck.
   */
  private async onAnswerIntervention(id: string, answer: InterventionAnswer): Promise<void> {
    const outcome = this.asks.resolve(id, answer);
    if (outcome.kind === 'invalid') {
      this.deps.webview.post({ type: 'showError', message: `That answer was not accepted: ${outcome.reason}` });
      return;
    }
    if (outcome.kind === 'unknown') {
      this.deps.log(`Baiton chat: an answer arrived for an ask that is no longer active (${id})`);
      const stale: InterventionAnswer = { kind: 'declined', reason: 'this ask is no longer active' };
      await this.settleCard(id, stale, { rationale: 'This ask is no longer active.' });
      return;
    }
    await this.settleCard(id, answer);
  }

  /**
   * Settle one card in the view and persist it. The registry has already been
   * resolved by the caller; this only does the view/transcript bookkeeping, so
   * it is safe to call for an ask that has no card (nothing is posted twice).
   */
  private async settleCard(
    id: string,
    answer: InterventionAnswer,
    opts: { rationale?: string; auto?: boolean } = {},
  ): Promise<void> {
    this.deps.webview.post(interventionUpdate(id, answer, opts));
    const card = this.cards.get(id);
    if (card === undefined) {
      return;
    }
    this.cards.delete(id);
    await this.append(card.transcript, interventionTranscriptRecord(settledInterventionView(card.view, answer, opts)));
  }

  /**
   * The user picked a conversation in the selector (Req 7.2, 7.3): the Workspace
   * entry clears the active spec, a spec entry sets it. Reloads the shown
   * conversation.
   */
  private onSelectConversation(conversationId: string): void {
    const slug =
      conversationId === WORKSPACE_CONVERSATION_ID ? undefined : conversationId;
    this.setActiveSpec(slug);
  }

  /**
   * The user activated stop: abort the in-flight run (Req 14.6) and decline
   * every ask still waiting for an answer, so any flow paused on a card gets
   * control back instead of hanging.
   */
  private onStop(): void {
    this.abort?.abort();
    void this.declinePendingAsks(STOP_DECLINE_REASON);
  }

  /** Decline every pending ask, settling each card it is showing. */
  private async declinePendingAsks(reason: string): Promise<void> {
    for (const ask of this.asks.pending()) {
      await this.declineAsk(ask.id, reason);
    }
    // Safety net for asks raised before any card was shown.
    this.asks.rejectAll(reason);
  }

  /** Decline one pending ask, settling its card and transcript. */
  public async declineAsk(id: string, reason: string): Promise<void> {
    const answer: InterventionAnswer = { kind: 'declined', reason };
    if (this.asks.resolve(id, answer).kind === 'resolved') {
      await this.settleCard(id, answer, { rationale: reason });
    }
  }

  /**
   * Start a new chat in the active scope. When the active session is still
   * empty — no id, or an id whose transcript does not exist yet — this only
   * re-posts the state so the webview focuses the input; nothing is discarded
   * and no stray session is created. Otherwise a fresh session id is allocated
   * (in memory: its file appears on the first append) and the empty state is
   * shown.
   */
  private async onNewChat(): Promise<void> {
    if (this.busy) {
      return;
    }
    const scope = this.activeScope();
    const current = this.activeSessions.get(scopeId(scope));
    if (current === undefined || (await this.sessions.meta(scope, current)) === undefined) {
      await this.refresh();
      return;
    }
    this.newSessionId(scope);
    await this.refresh();
  }

  /**
   * Show one session of the active scope. Refused while a run is in flight so
   * a running loop keeps writing to the session the user can see.
   */
  private async onSelectSession(sessionId: string): Promise<void> {
    if (this.busy) {
      this.deps.webview.post({
        type: 'showError',
        message: 'Wait for the current run to finish',
      });
      return;
    }
    const scope = this.activeScope();
    await this.setActiveSession(scope, sessionId);
    await this.refresh();
  }

  /**
   * Delete one session of the active scope: refused while a run is in flight on
   * that very session, confirmed through the {@link ChatControllerDeps.confirmDelete}
   * seam, then the transcript file is removed. Deleting the active session
   * falls back to the newest remaining one, or to a fresh new chat.
   */
  private async onDeleteSession(sessionId: string): Promise<void> {
    const scope = this.activeScope();
    const key = `${scopeId(scope)}/${sessionId}`;
    if (this.busy && this.runningKey === key) {
      this.deps.webview.post({
        type: 'showError',
        message: 'Wait for the current run to finish',
      });
      return;
    }
    const meta = await this.sessions.meta(scope, sessionId);
    const title = meta?.title ?? 'New chat';
    const confirmed =
      this.deps.confirmDelete === undefined
        ? true
        : await this.deps.confirmDelete(
            `Delete "${title}"? Its transcript cannot be recovered.`,
          );
    if (!confirmed) {
      return;
    }
    try {
      await this.sessions.delete(scope, sessionId);
    } catch (err) {
      this.deps.webview.post({
        type: 'showError',
        message: `Could not delete the session: ${describe(err)}`,
      });
      return;
    }
    if (this.activeSessions.get(scopeId(scope)) === sessionId) {
      const remaining = await this.sessions.list(scope);
      const next = remaining[0]?.id;
      if (next === undefined) {
        this.newSessionId(scope);
      } else {
        await this.setActiveSession(scope, next);
      }
    }
    await this.refresh();
  }

  // --- send / tool loop ----------------------------------------------------

  /**
   * Handle a send. Ignores a whitespace-only or over-limit input (Req 14.5),
   * otherwise appends the user message, marks the view busy, and runs the tool
   * loop (Req 14.4). A configuration or unreachable-endpoint error surfaces as
   * an inline message with the correct fix action and leaves the persisted
   * transcript unchanged (Req 13.1–13.3).
   */
  private async onSend(text: string): Promise<void> {
    if (this.busy) {
      return;
    }
    const trimmed = text.trim();
    if (trimmed.length === 0 || text.length > MAX_INPUT_CHARS) {
      // No user message added, no loop started (Req 14.5).
      return;
    }

    const slug = this.activeSpec;
    const scope = this.activeScope();
    // The phase is fixed for this send: it decides both the tools advertised to
    // the model and the tools the registry will actually run (Req 11.1). The
    // prompt re-reads `spec.md` every round (Req 11.6), so a status that
    // changes mid-run is picked up by the next send, not mid-loop.
    const phase = await this.phaseForConversation(slug);
    // A fresh chat has no id until its first message: allocate one now so the
    // transcript file is created by this very append (Req 9.9).
    const sessionId =
      this.activeSessions.get(scopeId(scope)) ?? this.newSessionId(scope);
    await this.setActiveSession(scope, sessionId);
    const transcript = this.transcriptFor(scope, sessionId);
    const history = await this.loadHistory(transcript.path);

    // Append and render the user's message before the loop runs (Req 14.4).
    const userRecord: Omit<TranscriptRecord, 'ts'> = { role: 'user', content: text };
    await this.append(transcript, userRecord);
    history.push({ role: 'user', content: text });
    this.deps.webview.post({ type: 'appendMessage', record: toRenderRecord(userRecord) });

    // While the loop runs, streamed assistant text is pushed to the view as it
    // arrives and every appended message (assistant, tool, notice) is posted
    // live; the whole conversation is re-rendered from the persisted transcript
    // once the loop ends so the view matches what was recorded (Req 8.6).
    this.setBusy(true);
    this.runningKey = `${scopeId(scope)}/${sessionId}`;
    this.abort = new AbortController();
    try {
      await runToolLoop(history, {
        client: this.deps.client,
        tools: this.deps.toolsFor(phase),
        call: (name, args, callId, signal) =>
          this.callTool(name, args, callId, signal, phase),
        systemPrompt: () => this.buildPrompt(slug),
        append: async (m) => {
          await this.append(transcript, m);
          this.postAppended(m);
        },
        roundBound: resolveRoundBound(this.deps.roundBound()),
        signal: this.abort.signal,
        onDelta: (text) => this.deps.webview.post({ type: 'streamDelta', text }),
      });
      await this.renderConversation(transcript.path);
    } catch (err) {
      // Keep any partially streamed text on screen next to the error.
      this.deps.webview.post({ type: 'streamEnd' });
      this.surfaceError(err);
    } finally {
      this.abort = undefined;
      this.runningKey = undefined;
      this.setBusy(false);
      // The session's title and updated time are derived from the transcript,
      // so the list is re-posted once the run has written to it.
      await this.postSessions(scope);
    }
  }

  /**
   * Invoke one tool through the guarded registry. The approve/draft/submit
   * tools gate themselves through `services.confirm`, which the host wires to
   * the same intervention seam, so the confirmation appears as an inline card
   * and a decline returns a result the loop records rather than performing
   * anything (Req 15.1, 15.2). `callId` is the model's tool-call id, used as
   * the idempotency key (Req 9.2).
   */
  private async callTool(
    name: string,
    args: string,
    callId: string,
    signal: AbortSignal,
    phase: OrchestratorPhase,
  ): Promise<ToolResult> {
    if (signal.aborted) {
      return { ok: false, error: 'the run was stopped before the tool call' };
    }
    const parsed = parseArgs(args);
    return this.deps.registry.call(name, parsed, callId, this.deps.guardContext(), phase);
  }

  /**
   * Build the system prompt for the current conversation, re-reading the spec's
   * `spec.md` each call so a spec conversation never reuses cached content
   * (Req 11.6). A missing/unreadable `spec.md` builds without it (Req 11.7).
   */
  private async buildPrompt(slug: string | undefined): Promise<string> {
    const kind: ConversationKind =
      slug === undefined ? { kind: 'workspace' } : { kind: 'spec', slug };
    if (slug === undefined) {
      return buildSystemPrompt(kind);
    }
    const specContent = await this.readSpec(slug);
    return buildSystemPrompt(kind, specContent);
  }

  /**
   * The orchestrator phase of the conversation being sent to (Req 11.1),
   * derived from the same `spec.md` the prompt is built from: a workspace
   * conversation, or a spec that is missing, unreadable or still `draft`, is
   * `gather`; an approved spec is `drive`.
   */
  private async phaseForConversation(slug: string | undefined): Promise<OrchestratorPhase> {
    if (slug === undefined) {
      return phaseFor({ kind: 'workspace' });
    }
    return phaseFor({ kind: 'spec', slug }, await this.readSpec(slug));
  }

  // --- transcript / rendering ----------------------------------------------

  /**
   * Refresh the conversation selector from disk and render the active
   * conversation. Called on start, on active-spec changes, and on conversation
   * selection, so the selector always lists the Workspace entry first then the
   * present specs in ascending slug order (Req 7.1) and reflects the active
   * spec (Req 7.7).
   */
  private async refresh(): Promise<void> {
    const scope = this.activeScope();
    await this.migrate(scope);
    this.conversations = await this.buildConversationItems();
    this.deps.webview.post({ type: 'setAutoMode', enabled: this.autoMode });
    this.deps.webview.post({ type: 'setConversations', items: this.conversations });
    this.deps.webview.post({ type: 'setActive', conversationId: this.activeConversationId() });
    const listed = await this.postSessions(scope);
    const active = await this.resolveActiveSession(scope, listed);
    if (active === undefined) {
      // A fresh chat with no transcript yet: show the empty state.
      await this.renderConversation(undefined);
      this.repostPendingCards(scopeId(scope));
      return;
    }
    await this.renderConversation(this.sessions.pathFor(scope, active));
    this.repostPendingCards(scopeId(scope));
  }

  /** Re-post the pending cards belonging to the rendered conversation. */
  private repostPendingCards(key: string): void {
    for (const card of this.cards.values()) {
      if (card.scopeKey === key) {
        this.deps.webview.post({ type: 'showIntervention', intervention: card.view });
      }
    }
  }

  /**
   * Migrate a scope's pre-sessions `chat.jsonl` into its session folder, once
   * per scope and idempotently. A migrated transcript becomes the scope's
   * active session when none is remembered yet.
   */
  private async migrate(scope: SessionScope): Promise<void> {
    const key = scopeId(scope);
    if (this.migrated.has(key)) {
      return;
    }
    this.migrated.add(key);
    try {
      const id = await this.sessions.migrateLegacy(scope);
      if (id !== undefined && this.activeSessions.get(key) === undefined) {
        this.activeSessions.set(key, id);
      }
    } catch (err) {
      this.deps.log(`Baiton chat: could not migrate the legacy transcript: ${describe(err)}`);
    }
  }

  /** List the scope's sessions and post them to the view, newest first. */
  private async postSessions(scope: SessionScope): Promise<SessionMeta[]> {
    let listed: SessionMeta[] = [];
    try {
      listed = await this.sessions.list(scope);
    } catch (err) {
      this.deps.log(`Baiton chat: could not list chat sessions: ${describe(err)}`);
    }
    this.deps.webview.post({ type: 'setSessions', items: toSessionItems(scope, listed) });
    this.deps.webview.post({
      type: 'setActiveSession',
      sessionId: this.activeSessions.get(scopeId(scope)) ?? '',
    });
    return listed;
  }

  /**
   * The session to show for a scope: the one already active, else the one
   * remembered for the scope when it still exists, else the newest listed one.
   * `undefined` means "a fresh chat with no transcript yet".
   */
  private async resolveActiveSession(
    scope: SessionScope,
    listed: SessionMeta[],
  ): Promise<string | undefined> {
    const key = scopeId(scope);
    const current = this.activeSessions.get(key);
    if (current !== undefined) {
      return listed.some((m) => m.id === current) ? current : undefined;
    }
    const remembered = this.deps.sessionMemory?.get(key);
    const chosen =
      remembered !== undefined && listed.some((m) => m.id === remembered)
        ? remembered
        : listed[0]?.id;
    if (chosen === undefined) {
      return undefined;
    }
    this.activeSessions.set(key, chosen);
    this.deps.webview.post({ type: 'setActiveSession', sessionId: chosen });
    return chosen;
  }

  /** Make `sessionId` the scope's active session and remember it across reloads. */
  private async setActiveSession(scope: SessionScope, sessionId: string): Promise<void> {
    this.activeSessions.set(scopeId(scope), sessionId);
    try {
      await this.deps.sessionMemory?.set(scopeId(scope), sessionId);
    } catch (err) {
      this.deps.log(`Baiton chat: could not remember the active session: ${describe(err)}`);
    }
  }

  /** Allocate and activate a fresh (unpersisted) session id for a scope. */
  private newSessionId(scope: SessionScope): string {
    const id = this.sessions.create(scope);
    this.activeSessions.set(scopeId(scope), id);
    void this.deps.sessionMemory?.set(scopeId(scope), id);
    return id;
  }

  /**
   * Load and render a conversation's persisted transcript in order, or show the
   * empty state with the configured endpoint/model when it has no messages
   * (Req 8.6, 13.5).
   */
  private async renderConversation(file: string | undefined): Promise<void> {
    const records = file === undefined ? [] : await readTranscript(file);
    if (records.length === 0) {
      this.deps.webview.post({
        type: 'setEmptyState',
        endpoint: normalizeConfig(this.deps.config.getEndpoint()),
        model: normalizeConfig(this.deps.config.getModel()),
      });
      this.deps.webview.post({ type: 'renderConversation', records: [] });
      return;
    }
    this.deps.webview.post({
      type: 'renderConversation',
      records: toRenderRecords(records),
    });
  }

  /**
   * Post one message the loop just appended to the view, projected the same way
   * {@link toRenderRecords} projects a persisted conversation: an assistant
   * turn that requests tool calls posts a text bubble only when it carries text,
   * then one pending row per call; each answering `tool` message settles its row
   * through `updateTool` rather than adding a raw JSON bubble.
   */
  private postAppended(message: Omit<TranscriptRecord, 'ts'>): void {
    if (message.role === 'assistant' && message.tool_calls !== undefined) {
      if (message.content.trim().length > 0) {
        this.deps.webview.post({
          type: 'appendMessage',
          record: { role: 'assistant', content: message.content },
        });
      }
      for (const call of message.tool_calls) {
        this.deps.webview.post({ type: 'appendMessage', record: pendingToolRecord(call) });
      }
      return;
    }
    if (message.role === 'tool' && message.tool_call_id !== undefined) {
      this.deps.webview.post(toolUpdate(message.tool_call_id, message.content));
      return;
    }
    this.deps.webview.post({ type: 'appendMessage', record: toRenderRecord(message) });
  }

  /** Read a conversation's persisted history as tool-loop {@link ChatMessage}s. */
  private async loadHistory(file: string): Promise<ChatMessage[]> {
    const records = await readTranscript(file);
    return records.map(toChatMessage);
  }

  /** Append one message to the transcript, containing any write failure (Req 8.7). */
  private async append(
    transcript: ChatTranscript,
    message: Omit<TranscriptRecord, 'ts'>,
  ): Promise<void> {
    try {
      await mkdir(path.dirname(transcript.path), { recursive: true });
      await transcript.append(message);
    } catch (err) {
      // A transcript-write failure must not derail the loop; log and continue.
      this.deps.log(`Baiton chat: could not persist transcript: ${describe(err)}`);
    }
  }

  // --- conversation identity -----------------------------------------------

  /** The `ChatTranscript` of one session in a scope (Req 8.1). */
  private transcriptFor(scope: SessionScope, sessionId: string): ChatTranscript {
    return new ChatTranscript(this.sessions.pathFor(scope, sessionId));
  }

  /** The active conversation scope: the workspace, or the active spec. */
  private activeScope(): SessionScope {
    return this.activeSpec === undefined
      ? { kind: 'workspace' }
      : { kind: 'spec', slug: this.activeSpec };
  }

  /** The selector id for the active conversation (Req 7.7). */
  private activeConversationId(): string {
    return this.activeSpec ?? WORKSPACE_CONVERSATION_ID;
  }

  /**
   * The conversation-selector entries: the Workspace entry first, then one per
   * present `.baiton/specs/<slug>/spec.md` in ascending slug order (Req 7.1).
   */
  private async buildConversationItems(): Promise<ConversationItem[]> {
    const listed = await listSpecs(this.deps.specsDir);
    const items: ConversationItem[] = [
      { id: WORKSPACE_CONVERSATION_ID, label: 'Workspace' },
    ];
    for (const spec of listed) {
      items.push({ id: spec.slug, label: spec.slug });
    }
    return items;
  }

  /** Re-read a spec's `spec.md`, or `undefined` when it is missing/unreadable (Req 11.7). */
  private async readSpec(slug: string): Promise<string | undefined> {
    const specFile = path.join(this.deps.specsDir, slug, 'spec.md');
    try {
      return await readFile(specFile, 'utf8');
    } catch {
      return undefined;
    }
  }

  // --- busy / error surfacing ----------------------------------------------

  /** Toggle the busy flag and mirror send/stop enablement to the view (Req 14.2, 14.3). */
  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.deps.webview.post({ type: 'setBusy', busy });
  }

  /**
   * Map a model-client error to an inline message with the correct fix action
   * (Req 13.1–13.3); rethrow-free for any other error, which is logged and
   * shown as a generic inline message.
   */
  private surfaceError(err: unknown): void {
    if (err instanceof MissingConfigError) {
      const action: FixAction = err.missing === 'apiKey' ? 'setApiKey' : 'openSettings';
      this.deps.webview.post({
        type: 'showError',
        message: missingConfigMessage(err.missing),
        action,
      });
      return;
    }
    if (err instanceof UnreachableEndpointError) {
      // The message carries the endpoint's status and a body excerpt, which the
      // inline notice deliberately omits; log it so the failure is diagnosable
      // from the Baiton output channel (Req 13.3).
      this.deps.log(`Baiton chat: ${err.message}`);
      this.deps.webview.post({
        type: 'showError',
        message: 'The orchestrator endpoint was unreachable.',
        action: 'openSettings',
      });
      return;
    }
    this.deps.log(`Baiton chat: ${describe(err)}`);
    this.deps.webview.post({
      type: 'showError',
      message: `The orchestrator failed: ${describe(err)}`,
    });
  }
}

/** Project a scope's session metadata into the view's session list entries. */
function toSessionItems(scope: SessionScope, metas: readonly SessionMeta[]): SessionItem[] {
  return metas.map((meta) => ({
    id: meta.id,
    title: meta.title,
    updatedAt: meta.updatedAt,
    scopeId: scopeId(scope),
  }));
}

/** Turn a persisted transcript record into a renderable webview record. */
function toRenderRecord(
  record: Pick<TranscriptRecord, 'role' | 'content' | 'tool_call_id'>,
): RenderRecord {
  return { role: record.role, content: record.content };
}

/** Turn a persisted transcript record into a tool-loop chat message. */
function toChatMessage(record: TranscriptRecord): ChatMessage {
  if (record.intervention !== undefined) {
    // A persisted card re-enters the model history as the ask and its outcome,
    // never as a bare prompt that would read like a fresh question.
    return { role: 'assistant', content: interventionHistoryText(record.intervention) };
  }
  // Transcript records use the same role set the completions path expects,
  // except that a persisted `system` role is not part of the history the loop
  // sends (the loop prepends a fresh system prompt each round). Preserve the
  // role and any tool-call id so a resumed conversation keeps its tool turns.
  const role: ChatMessage['role'] = record.role === 'system' ? 'assistant' : record.role;
  return {
    role,
    content: record.content,
    ...(record.tool_call_id !== undefined ? { tool_call_id: record.tool_call_id } : {}),
    ...(record.tool_calls !== undefined ? { tool_calls: record.tool_calls } : {}),
  };
}

/** How a persisted card reads in the model history: the ask and what was decided. */
function interventionHistoryText(view: InterventionView): string {
  return `[intervention] ${view.prompt}\nDecision: ${describeAnswer(view.answer)}`;
}

/** A one-line description of an intervention answer. */
function describeAnswer(answer: InterventionAnswer | undefined): string {
  if (answer === undefined) {
    return 'no answer was recorded';
  }
  switch (answer.kind) {
    case 'approved':
      return 'approved';
    case 'declined':
      return answer.reason === undefined ? 'declined' : `declined (${answer.reason})`;
    case 'option':
      return `chose "${answer.label ?? answer.optionId}"`;
    case 'text':
      return `answered: ${answer.text}`;
  }
}

/** The inline message naming the missing configuration value (Req 13.1, 13.2). */
function missingConfigMessage(missing: MissingConfigError['missing']): string {
  switch (missing) {
    case 'endpoint':
      return 'The orchestrator endpoint is not configured.';
    case 'model':
      return 'The orchestrator model is not configured.';
    case 'apiKey':
      return 'The orchestrator API key is not configured.';
  }
}

/** Normalize a configured value to `string | null` for the empty state (Req 13.5). */
function normalizeConfig(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** Parse a tool call's JSON argument string, defaulting to `{}` on failure. */
function parseArgs(args: string): unknown {
  if (args.length === 0) {
    return {};
  }
  try {
    return JSON.parse(args);
  } catch {
    return {};
  }
}

/** Project a registry `Intervention` into the pending card the view renders. */
function toInterventionView(ask: Intervention): InterventionView {
  const base = { id: ask.id, kind: ask.kind, prompt: ask.prompt, status: 'pending' as const };
  switch (ask.kind) {
    case 'question':
      return {
        ...base,
        ...(ask.options !== undefined ? { options: ask.options.map((o) => ({ ...o })) } : {}),
        ...(ask.allowFreeText !== undefined ? { allowFreeText: ask.allowFreeText } : {}),
        ...(ask.placeholder !== undefined ? { placeholder: ask.placeholder } : {}),
      };
    case 'confirm':
      return { ...base, ...(ask.detail !== undefined ? { detail: ask.detail } : {}) };
    case 'permission':
      return {
        ...base,
        agent: ask.agent,
        tool: ask.tool,
        ...(ask.args !== undefined ? { args: ask.args } : {}),
        ...(ask.detail !== undefined ? { detail: ask.detail } : {}),
      };
  }
}

/** One card the view is showing, and the transcript its settled record belongs to. */
interface PendingCard {
  view: InterventionView;
  transcript: ChatTranscript;
  scopeKey: string;
}

/** A short, safe description of a thrown value for a user-facing message. */
function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The one-line audit rationale of an Auto-mode approval, naming the stage that decided. */
function autoApprovalRationale(outcome: Extract<AutoModeOutcome, { kind: 'approve' }>): string {
  const stage = outcome.stage === 'allow-list' ? 'allow-list' : 'model review';
  return `Auto mode (${stage}): ${outcome.rationale}`;
}
