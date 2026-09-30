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
 *    a missing API key of the active provider names that provider and its fix
 *    opens that provider's key prompt directly;
 *  - post the Provider & Model dropdown (`setProviders`) on refresh and on
 *    every router selection change — carrying only the configured providers,
 *    each group's stale markers, each model's `(custom)`/effort markers and
 *    the catalog refresh time — and show the active provider + model in
 *    the empty state ("not configured" when nothing is selected);
 *  - switch the active provider/model on `selectModel` for the next turn only,
 *    leaving the transcript and the rendered conversation untouched;
 *  - show the empty state with the configured endpoint and model (indicating
 *    "not configured" for each unset one) and a Set API Key action (Req 13.5);
 *  - own the conversation's mode: host-authoritative and `workspaceState`-backed,
 *    pinned to Spec while a spec conversation is in view, refused while the chat
 *    is busy or a run is in flight, echoed back on every path so the composer's
 *    Mode select is a pure projection, and the source of the phase, the tool
 *    surface and the system prompt of every send;
 *  - mirror spec-less run activity to the view (`setRunActive`), record a
 *    finished run's outcome as a system note on the Workspace_Conversation, and
 *    offer an Investigate run's finding as a promote card whose Bug/Quick choice
 *    raises the ordinary run confirm card before anything is dispatched;
 *  - after trimming, summarise the messages older than the last two turns at
 *    `contextSummarizeAt` into a compaction record; the view keeps rendering
 *    the full transcript;
 *  - post the context meter (`setContextUsage`) after every completion,
 *    compaction and render; compact on demand (`compactContext` /
 *    `baiton.compactContext`), refused while busy.
 */
import * as path from 'path';
import { mkdir, readFile } from 'fs/promises';
import type { GuardContext, ToolRegistry } from '../orchestrator';
import {
  MissingConfigError,
  UnreachableEndpointError,
  askCommandText,
  askFromPermission,
  buildSystemPrompt,
  compactionCut,
  compactionTranscriptRecord,
  defaultSummary,
  escalatedInterventionView,
  interventionTranscriptRecord,
  interventionUpdate,
  phaseFor,
  providerInfo,
  readTranscript,
  pendingToolRecord,
  PendingAskRegistry,
  SessionStore,
  resolveRoundBound,
  runToolLoop,
  settledInterventionView,
  toHistory,
  toRenderRecords,
  toolUpdate,
} from '../orchestrator';
import { DEFAULT_MODE, isRunMode, type RunMode } from '../model/mode';
import type {
  RunFinding,
  RunManifest,
  RunPipelineEvent,
  RunPipelineOutcome,
  Unsubscribe,
} from '../engine';
import type {
  AutoModeOutcome,
  AutoModeRunContext,
  ChatMessage,
  ConfirmRequest,
  QuestionRequest,
  RunPipelineSeam,
  StartRunOutcome,
  SessionItem,
  SessionMeta,
  SessionScope,
  ConversationItem,
  ConversationKind,
  FixAction,
  HostToWebview,
  Intervention,
  InterventionAnswer,
  InterventionEscalation,
  InterventionView,
  ModelClient,
  ModelSelection,
  OrchestratorPhase,
  ProviderGroup,
  ProviderId,
  PermissionRequest,
  RenderRecord,
  ToolResult,
  ToolSpec,
  TranscriptRecord,
  WebviewToHost,
} from '../orchestrator';
import { ChatTranscript, scopeId } from '../orchestrator';
import { ContextTracker, estimateMessages, estimateTokens, fitToWindow, resolveOutputReserve } from '../orchestrator/contextBudget';
import { autoApprovedInterventionLines, resolveContextTrimAt, trimHistory } from '../orchestrator/contextTrim';
import { CONTEXT_SUMMARY_PREFIX } from '../orchestrator/transcriptReader';
import type { CompactionMarker } from '../orchestrator/chatTranscript';
import type { ContextBudget } from '../orchestrator/toolLoop';
import { listSpecs } from './specLister';

/** The conversation-selector id of the Workspace_Conversation. */
export const WORKSPACE_CONVERSATION_ID = 'workspace';

/** The maximum input length a send is allowed to carry (Req 14.4, 14.5). */
export const MAX_INPUT_CHARS = 100_000;

/** Default fraction of the context window at which the chat summarises older turns. */
export const DEFAULT_CONTEXT_SUMMARIZE_AT = 0.8;

/** How many trailing user turns stay verbatim when summarising. */
export const SUMMARY_KEEP_TURNS = 2;

/** Byte caps applied to a tool result / any other message in the summary request. */
export const SUMMARY_TOOL_RESULT_BYTES = 2048;
export const SUMMARY_MESSAGE_BYTES = 8192;

/** A finite `contextSummarizeAt` in (0, 1], else the default. */
export function resolveContextSummarizeAt(configured: unknown): number {
  return typeof configured === 'number' && Number.isFinite(configured) && configured > 0 && configured <= 1
    ? configured
    : DEFAULT_CONTEXT_SUMMARIZE_AT;
}

/** The system prompt of the text-only summarising completion. */
export const SUMMARY_SYSTEM_PROMPT =
  'You compact a coding-assistant conversation so it can continue with less context. Summarise the conversation you are given under exactly these headings: Goals, Decisions taken, Files touched, Open questions. Keep file paths, identifiers, commands and decisions verbatim; be concise; omit pleasantries. Reply with the summary only.';

/** Clip `text` to `max` bytes on a UTF-8 boundary, marking the cut. */
function clipBytes(text: string, max: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= max) {
    return text;
  }
  const clipped = buf.subarray(0, max).toString('utf8').replace(/\uFFFD$/, '');
  return `${clipped} …[clipped]`;
}

/**
 * Flatten `older` into one user message for the summarising completion: no
 * tool_calls / tool roles, so strict endpoints never see unpaired tool
 * messages. Oldest blocks are dropped when the estimate exceeds `maxTokens`.
 */
export function summaryRequestMessages(older: readonly ChatMessage[], maxTokens: number): ChatMessage[] {
  const blocks: string[] = [];
  for (const m of older) {
    if (m.role === 'tool') {
      blocks.push(`tool result (${m.tool_call_id ?? ''}):\n${clipBytes(m.content, SUMMARY_TOOL_RESULT_BYTES)}`);
      continue;
    }
    blocks.push(`${m.role}:\n${clipBytes(m.content, SUMMARY_MESSAGE_BYTES)}`);
    for (const call of m.tool_calls ?? []) {
      blocks.push(`assistant called ${call.name}(${clipBytes(call.arguments, 512)})`);
    }
  }
  let joined = blocks.join('\n\n');
  if (estimateTokens(joined) > maxTokens) {
    let start = 0;
    while (start < blocks.length - 1 && estimateTokens(`[earlier messages omitted]\n\n${blocks.slice(start).join('\n\n')}`) > maxTokens) {
      start++;
    }
    joined = `[earlier messages omitted]\n\n${blocks.slice(start).join('\n\n')}`;
  }
  return [
    { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
    { role: 'user', content: `Conversation to summarise:\n\n${joined}` },
  ];
}

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
 * invokes the Set Orchestrator API Key command (Req 13.1–13.4). `setApiKey`
 * with a provider opens that provider's key prompt directly; without one it
 * opens the provider quick-pick. `setEndpoint` does the same for the Set
 * Provider Endpoint prompt.
 */
export type TriggerFix = (action: FixAction, provider?: ProviderId) => void | Promise<void>;

/** One provider's availability as the router reports it (see ProviderRouter.availability). */
export interface ProviderAvailabilityView {
  id: ProviderId;
  label: string;
  enabled: boolean;
  reason?: string;
  models: readonly string[];
  /** True when the catalog snapshot backing `models` is no longer known current. */
  stale?: boolean;
  /** Why the snapshot is stale; present only with `stale: true`. */
  staleReason?: string;
  /** ISO-8601 time of the last successful catalog fetch backing `models`. */
  fetchedAt?: string;
  /** Ids inside `models` that came from a preserved selection, not the catalog. */
  customModels?: readonly string[];
  /** Per-model reasoning-effort levels, keyed by model id, when the source reports them. */
  efforts?: Readonly<Record<string, readonly string[]>>;
}

/** The provider selection seam: the host binds it to the ProviderRouter. */
export interface ProviderSource {
  availability(): Promise<ProviderAvailabilityView[]>;
  getSelection(): ModelSelection | undefined;
  select(value: unknown): Promise<boolean>;
  onDidChangeSelection(listener: (s: ModelSelection | undefined) => void): { dispose(): void };
}

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
  /**
   * The selected model's context window in tokens (already resolved through
   * `resolveContextWindow`), or undefined when unknown. Absent → unknown.
   */
  contextWindow?(): number | undefined;
  /** The raw `baiton.orchestrator.maxTokens` value; with maxOutput it sizes the pre-flight output reserve. */
  maxTokens?(): unknown;
  /** The selected model's catalog `maxOutput`, or undefined. */
  maxOutput?(): number | undefined;
  /** The raw `baiton.orchestrator.contextTrimAt` value, resolved through `resolveContextTrimAt`. Absent → 0.5. */
  contextTrimAt?(): unknown;
  /** The raw `baiton.orchestrator.contextSummarizeAt` value, resolved through `resolveContextSummarizeAt`. Absent → 0.8. */
  contextSummarizeAt?(): unknown;
  /** Reads the configured endpoint/model for the empty state (Req 13.5). */
  config: OrchestratorConfig;
  /** Invoked on an inline-error fix action (Req 13.4). */
  triggerFix: TriggerFix;
  /**
   * The provider selection seam the host binds to the ProviderRouter. Absent,
   * the controller posts no `setProviders`, `selectModel` is a no-op, and a
   * missing API key surfaces with the generic wording as before.
   */
  providers?: ProviderSource;
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
  /**
   * Persists the composer's Mode select across windows (`baiton.chat.mode`).
   * Absent, the mode still works for the life of the controller but starts at
   * Spec on every reload.
   */
  modeMemory?: ModeMemory;
  /**
   * The spec-less run pipeline's activity and events. The controller subscribes
   * in {@link ChatController.start} and unsubscribes in
   * {@link ChatController.dispose}. Absent, `runActive` stays false, no
   * completion note is posted and no promote card appears. A host that also
   * binds `RunPipelineDeps.onFinding` to
   * {@link ChatController.promoteFinding} gets no duplicate card: the promote
   * card is deduped per run id.
   */
  runs?: RunActivitySource;
  /**
   * Dispatches a run confirmed from an Investigate promote card. Absent, no
   * promote card is posted (there would be nothing to act on).
   */
  runPipeline?: RunPipelineSeam;
}

/** Remembers the composer's Mode select across windows (backed by `workspaceState`). */
export interface ModeMemory {
  /** The remembered mode value, or `undefined` when nothing was stored. */
  get(): string | undefined;
  /** Remember the new mode. */
  set(mode: RunMode): Promise<void>;
}

/**
 * The run-activity seam: whether a spec-less run is in flight and the pipeline's
 * change events. Structurally satisfied by the `RunPipeline` that
 * `createRunPipeline` returns, so the host passes the pipeline itself.
 */
export interface RunActivitySource {
  /** Whether a run is in flight right now (seeds the first paint). */
  isRunning(): boolean;
  /** Subscribe to the pipeline's change events; the returned function unsubscribes. */
  onChange(listener: (event: RunPipelineEvent) => void): Unsubscribe;
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
 *
 * `context` is present exactly for relayed harness asks — the launching run's
 * agent, role and run id, which the gate keys its allow-list on — and absent
 * for an orchestrator-raised permission ask, in which case the host falls back
 * to its most restrictive profile.
 */
export type AutoModeGate = (
  ask: PermissionRequest,
  opts: { signal?: AbortSignal; context?: AutoModeRunContext },
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

  /** The Workspace conversation's mode; seeded from `modeMemory`, echoed to the view. */
  private mode: RunMode = DEFAULT_MODE;

  /** Whether a spec-less run is in flight; mirrored to the view as `setRunActive`. */
  private runActive = false;

  /** The run-pipeline change subscription taken in {@link start}. */
  private runsSub: Unsubscribe | undefined;

  /** Run ids whose finding already produced a promote card, so it is posted once. */
  private readonly promoted = new Set<string>();

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

  /** One context tracker per conversation, keyed `<scopeKey>/<sessionId>`. */
  private readonly trackers = new Map<string, ContextTracker>();

  /** The pending-ask registry every inline card settles through. */
  private readonly asks: PendingAskRegistry;

  /** Cards currently on screen, by ask id: the view plus where its settled record is written. */
  private readonly cards = new Map<string, PendingCard>();

  /** Scope keys whose legacy `chat.jsonl` migration has already been attempted. */
  private readonly migrated = new Set<string>();

  /** The selection-change subscription from the last `start()`, disposed on `dispose()`/restart. */
  private selectionSub: { dispose(): void } | undefined;

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
    // Validating host-side means an unknown or stale `workspaceState` value
    // silently falls back to DEFAULT_MODE (the Default a fresh Workspace
    // conversation starts in) rather than poisoning the phase.
    const stored = deps.modeMemory?.get();
    this.mode = stored !== undefined && isRunMode(stored) ? stored : DEFAULT_MODE;
  }

  /**
   * Wire the webview's message handler and render the initial conversation.
   * Call once after the view is bound (on first resolve and again on reopen /
   * window reload, since the webview restarts from empty state).
   */
  public start(): void {
    this.deps.webview.onMessage((msg) => void this.handle(msg));
    this.selectionSub?.dispose();
    this.selectionSub = this.deps.providers?.onDidChangeSelection(() => { void this.postProviders(); });
    // `start()` runs again on every fresh webview resolve, hence unsubscribe-first.
    this.runsSub?.();
    this.runActive = this.deps.runs?.isRunning() ?? false;
    this.runsSub = this.deps.runs?.onChange((event) => { void this.onRunEvent(event); });
    void this.refresh();
  }

  /**
   * Unwire the provider-selection and run-pipeline subscriptions the last
   * `start()` registered, so the host can release the view without leaving
   * duplicate posts behind.
   */
  public dispose(): void {
    this.selectionSub?.dispose();
    this.selectionSub = undefined;
    this.runsSub?.();
    this.runsSub = undefined;
  }

  /**
   * Post the Provider & Model dropdown state; a no-op without the seam.
   */
  private async postProviders(): Promise<void> {
    const source = this.deps.providers;
    if (source === undefined) {
      return;
    }
    try {
      const entries = await source.availability();
      const groups: ProviderGroup[] = entries.map((e) => {
        const custom = new Set(e.customModels ?? []);
        return {
          id: e.id,
          label: e.label,
          enabled: e.enabled,
          ...(e.reason !== undefined ? { reason: e.reason } : {}),
          ...(e.stale === true ? { stale: true } : {}),
          ...(e.stale === true && e.staleReason !== undefined ? { staleReason: e.staleReason } : {}),
          models: e.models.map((id) => {
            const efforts = e.efforts?.[id];
            return {
              id,
              ...(custom.has(id) ? { custom: true } : {}),
              ...(efforts !== undefined && efforts.length > 0 ? { efforts: [...efforts] } : {}),
            };
          }),
        };
      });
      const refreshedAt = latestFetchedAt(entries);
      this.deps.webview.post({
        type: 'setProviders',
        groups,
        selection: source.getSelection() ?? null,
        ...(refreshedAt !== undefined ? { refreshedAt } : {}),
      });
    } catch (err) {
      this.deps.log(`Baiton chat: could not list the providers: ${describe(err)}`);
    }
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

  /**
   * One run-pipeline event. Every non-terminal event means a run is in flight,
   * which the view reflects by disabling the Mode select; `completed` clears the
   * flag, records a system note on the Workspace conversation, and — for an
   * Investigate run that produced a finding — offers to promote it.
   */
  private async onRunEvent(event: RunPipelineEvent): Promise<void> {
    const active = event.kind !== 'completed';
    if (active !== this.runActive) {
      this.runActive = active;
      this.postRunActive();
    }
    if (event.kind !== 'completed') {
      return;
    }
    const note = runCompletionNote(event.outcome, event.manifest);
    if (event.outcome.state === 'failed') {
      this.deps.log(`Baiton chat: ${note}`);
    }
    // `noteSystem` refreshes, which re-posts `setMode`/`setRunActive`, so the
    // composer repaints with the run finished.
    await this.noteSystem(note);
    if (event.outcome.finding !== undefined) {
      await this.promoteFinding(event.outcome.finding);
    }
  }

  /**
   * Offer to promote an Investigate finding into a Bug or Quick run. The promote
   * card is posted once per run id; choosing a mode raises the ordinary run
   * confirm card, and only an approval dispatches — a dismissal, a decline or a
   * typed answer writes nothing and dispatches nothing. A no-op without the
   * dispatch seam, and in Restricted Mode a note stands in for the card.
   */
  public async promoteFinding(finding: RunFinding): Promise<void> {
    if (this.promoted.has(finding.runId)) {
      return;
    }
    this.promoted.add(finding.runId);
    if (this.deps.runPipeline === undefined) {
      return;
    }
    if (this.deps.guardContext().restricted) {
      await this.noteSystem(`Restricted Mode: the finding of \`${finding.runId}\` was not offered as a run.`);
      return;
    }
    const chosen = await this.askCard(promoteCardRequest(finding));
    if (chosen.kind !== 'option' || !PROMOTE_MODES.includes(chosen.optionId as RunMode)) {
      return;
    }
    const mode = chosen.optionId as RunMode;
    const files = finding.files.length > 0 ? finding.files : finding.questionFiles;
    const confirmed = await this.askCard(
      promoteRunConfirm(mode, finding.finding, files, finding.manifest.baseBranch),
    );
    if (confirmed.kind !== 'approved') {
      return;
    }
    let outcome: StartRunOutcome;
    try {
      outcome = await this.deps.runPipeline.start({ mode, statement: finding.finding, files: [...files] });
    } catch (err) {
      await this.noteSystem(`Starting the ${mode} run failed: ${describe(err)}.`);
      return;
    }
    await this.noteSystem(startedRunNote(mode, outcome));
  }

  /**
   * Raise one ask through this controller's own registry and card machinery.
   * `scopeId` is deliberately left unset, so `scopeForAsk` keeps the card on the
   * conversation in view rather than treating `'workspace'` as a spec slug.
   */
  private async askCard(request: QuestionRequest | ConfirmRequest): Promise<InterventionAnswer> {
    const { intervention, answer } = this.asks.create(request);
    try {
      await this.presentIntervention(intervention);
    } catch (err) {
      this.asks.reject(intervention.id, `the ask could not be shown: ${describe(err)}`);
    }
    return answer;
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
      case 'selectModel':
        await this.onSelectModel(msg.provider, msg.model);
        return;
      case 'triggerFix':
        await this.deps.triggerFix(msg.action, msg.provider);
        return;
      case 'answerIntervention':
        await this.onAnswerIntervention(msg.id, msg.answer);
        return;
      case 'setAutoMode':
        await this.onSetAutoMode(msg.enabled);
        return;
      case 'setMode':
        await this.onSetMode(msg.mode);
        return;
      case 'compactContext':
        await this.compactContext();
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
   * The user picked a mode in the composer. The mode is a property of the
   * Workspace_Conversation: a spec conversation is always Spec, so a `setMode`
   * there changes nothing. A change is also refused while the chat is busy or a
   * spec-less run is in flight, and an off-union value is refused outright.
   * Every one of those paths still echoes, so the control can never hold a
   * value the host did not choose. A memory write that fails is logged only:
   * undoing the in-memory change would desync the already-posted echo.
   */
  private async onSetMode(mode: RunMode): Promise<void> {
    if (this.busy || this.runActive || this.activeSpec !== undefined || !isRunMode(mode)) {
      this.postMode();
      return;
    }
    if (mode === this.mode) {
      this.postMode();
      return;
    }
    this.mode = mode;
    this.postMode();
    try {
      await this.deps.modeMemory?.set(mode);
    } catch (err) {
      this.deps.log(`Baiton chat: could not remember the conversation mode: ${describe(err)}`);
    }
  }

  /**
   * The mode that actually governs the conversation in view. A spec conversation
   * is always the literal Spec, deliberately not DEFAULT_MODE: the Workspace
   * default no longer means Spec.
   */
  private effectiveMode(): RunMode {
    return this.activeSpec === undefined ? this.mode : 'spec';
  }

  /** Repaint the composer's Mode select from the host's state (a spec conversation always paints Spec). */
  private postMode(): void {
    this.deps.webview.post({ type: 'setMode', mode: this.effectiveMode() });
  }

  /** Mirror run activity to the view (the Mode select and nothing else gate on it today). */
  private postRunActive(): void {
    this.deps.webview.post({ type: 'setRunActive', active: this.runActive });
  }

  /**
   * The user picked a provider/model pair in the dropdown. The switch applies
   * to the next completion only: the router resolves the provider per
   * `complete()` call, so nothing is re-wired, no transcript is read, written
   * or re-rendered, and no session is created.
   */
  private async onSelectModel(provider: ProviderId, model: string): Promise<void> {
    const source = this.deps.providers;
    if (source === undefined) {
      return;
    }
    let ok = false;
    try {
      ok = await source.select({ provider, model });
    } catch (err) {
      this.deps.log(`Baiton chat: could not switch the model: ${describe(err)}`);
    }
    if (!ok) {
      // Rejected or threw: repaint the dropdown from the unchanged selection so
      // the view cannot drift from the host.
      await this.postProviders();
    }
  }

  /**
   * Show one pending ask as an inline card on the conversation currently in
   * view, and remember which transcript its settled record belongs to.
   *
   * While Auto mode is on, a harness `permission` ask is first put through the
   * gate: an approval settles the ask with no round-trip and posts the card
   * already resolved and flagged `auto`, and an escalation is shown as an
   * ordinary pending card led by one plain sentence saying what the user is
   * approving, with the raw command under it; the rule that tripped is kept
   * in the persisted record for the audit trail only. Confirmations and questions are never gated — they
   * carry human intent, not a harness capability. Both outcomes are persisted,
   * so the transcript is the audit trail.
   *
   * A relayed harness ask carries its run context (`AutoModeRunContext`), so
   * the deterministic stage is evaluated against the launching run's own
   * agent/role/run directory rather than a fallback profile.
   */
  public async presentIntervention(ask: Intervention, context?: AutoModeRunContext): Promise<void> {
    const scope = await this.scopeForAsk(ask);
    const key = scopeId(scope);
    const sessionId = this.activeSessions.get(key) ?? this.newSessionId(scope);
    const transcript = this.transcriptFor(scope, sessionId);
    const view = toInterventionView(ask);
    const outcome = await this.autoDecision(ask, context);
    if (outcome !== undefined && outcome.kind === 'approve') {
      await this.autoApprove(ask.id, view, transcript, outcome);
      return;
    }
    const card =
      outcome === undefined || ask.kind !== 'permission'
        ? view
        : escalatedInterventionView(view, cardEscalation(ask, outcome));
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
  private async autoDecision(ask: Intervention, context?: AutoModeRunContext): Promise<AutoModeOutcome | undefined> {
    if (!this.autoMode || this.deps.autoGate === undefined || ask.kind !== 'permission') {
      return undefined;
    }
    try {
      return await this.deps.autoGate(ask, { signal: this.abort?.signal, context });
    } catch (err) {
      this.deps.log(`Baiton chat: the Auto-mode gate failed: ${describe(err)}`);
      return {
        kind: 'escalate',
        summary: defaultSummary(askFromPermission(ask), context?.role),
        detail: `Auto mode could not decide: ${describe(err)}`,
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
    // The mode and the phase are both fixed for this send: the phase decides
    // the tools advertised to the model and the tools the registry will
    // actually run (Req 11.1), and the mode decides the prompt. The Mode select
    // is refused while busy, so capturing the mode here only documents that
    // invariant. The prompt re-reads `spec.md` every round (Req 11.6), so a
    // status that changes mid-run is picked up by the next send, not mid-loop.
    const mode = this.effectiveMode();
    const phase = await this.phaseForConversation(slug);
    // A fresh chat has no id until its first message: allocate one now so the
    // transcript file is created by this very append (Req 9.9).
    const sessionId =
      this.activeSessions.get(scopeId(scope)) ?? this.newSessionId(scope);
    await this.setActiveSession(scope, sessionId);
    const transcript = this.transcriptFor(scope, sessionId);
    const records = await readTranscript(transcript.path);
    let history = toHistory(records);
    const autoApprovedLines = autoApprovedInterventionLines(records);

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
    const key = `${scopeId(scope)}/${sessionId}`;
    this.runningKey = key;
    const tools = this.deps.toolsFor(phase);
    this.abort = new AbortController();
    try {
      if (this.shouldSummarize(history, tools, await this.buildPrompt(slug, mode), autoApprovedLines)) {
        const compacted = await this.compact(transcript, key, this.abort.signal, sessionId);
        if (compacted !== undefined) {
          history = compacted;
          await this.seedContextEstimate(key, slug, history);
          this.postContextUsage(key);
        }
      }
      await runToolLoop(history, {
        client: this.deps.client,
        tools,
        call: (name, args, callId, signal) =>
          this.callTool(name, args, callId, signal, phase),
        systemPrompt: () => this.buildPrompt(slug, mode),
        append: async (m) => {
          await this.append(transcript, m);
          this.postAppended(m);
        },
        roundBound: resolveRoundBound(this.deps.roundBound()),
        signal: this.abort.signal,
        onDelta: (text) => this.deps.webview.post({ type: 'streamDelta', text }),
        sessionId,
        budget: this.contextBudget(key, tools, autoApprovedLines, transcript, sessionId),
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
  private async buildPrompt(slug: string | undefined, mode: RunMode): Promise<string> {
    const kind: ConversationKind =
      slug === undefined ? { kind: 'workspace' } : { kind: 'spec', slug };
    if (slug === undefined) {
      return buildSystemPrompt(kind, undefined, mode);
    }
    const specContent = await this.readSpec(slug);
    return buildSystemPrompt(kind, specContent);
  }

  /**
   * The orchestrator phase of the conversation being sent to (Req 11.1),
   * derived from the same `spec.md` the prompt is built from: a workspace
   * conversation in Spec mode, or a spec that is missing, unreadable or still
   * `draft`, is `gather`; an approved spec is `drive`; a spec-less mode on the
   * Workspace conversation is `run`. The spec branch deliberately passes no
   * mode, so a spec conversation maps exactly as it does today.
   */
  private async phaseForConversation(slug: string | undefined): Promise<OrchestratorPhase> {
    if (slug === undefined) {
      return phaseFor({ kind: 'workspace' }, undefined, this.effectiveMode());
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
    // Selecting a spec repaints the select as Spec and selecting Workspace again
    // repaints the remembered mode, because both go through `refresh()`.
    this.postMode();
    this.postRunActive();
    await this.postProviders();
    this.deps.webview.post({ type: 'setConversations', items: this.conversations });
    this.deps.webview.post({ type: 'setActive', conversationId: this.activeConversationId() });
    const listed = await this.postSessions(scope);
    const active = await this.resolveActiveSession(scope, listed);
    if (active === undefined) {
      // A fresh chat with no transcript yet: show the empty state.
      await this.renderConversation(undefined);
      const window = this.deps.contextWindow?.();
      this.deps.webview.post({
        type: 'setContextUsage',
        loaded: 0,
        window: window !== undefined && Number.isInteger(window) && window > 0 ? window : null,
        source: 'estimate',
      });
      this.repostPendingCards(scopeId(scope));
      return;
    }
    await this.renderConversation(this.sessions.pathFor(scope, active));
    const viewKey = `${scopeId(scope)}/${active}`;
    if (!this.trackers.has(viewKey)) {
      // Not measured in this window yet (e.g. after a reload): estimate it.
      try {
        const history = toHistory(await readTranscript(this.sessions.pathFor(scope, active)));
        await this.seedContextEstimate(viewKey, this.activeSpec, history);
      } catch (err) {
        this.deps.log(`Baiton chat: could not estimate context: ${describe(err)}`);
      }
    }
    this.postContextUsage(viewKey);
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

  /** The key of the session in view, or undefined when none is active. */
  private viewKey(): string | undefined {
    const scope = this.activeScope();
    const id = this.activeSessions.get(scopeId(scope));
    return id === undefined ? undefined : `${scopeId(scope)}/${id}`;
  }

  /** Post the tracker's reading, only when `key` is the conversation in view. */
  private postContextUsage(key: string): void {
    if (key !== this.viewKey()) {
      return;
    }
    const s = this.trackerFor(key).status();
    this.deps.webview.post({
      type: 'setContextUsage',
      loaded: s.loaded,
      window: s.window ?? null,
      source: s.source,
    });
  }

  /** Record a local estimate of what the next request would carry on the tracker. */
  private async seedContextEstimate(
    key: string,
    slug: string | undefined,
    history: readonly ChatMessage[],
  ): Promise<void> {
    const tools = this.deps.toolsFor(await this.phaseForConversation(slug));
    const prompt = await this.buildPrompt(slug, this.effectiveMode());
    this.trackerFor(key).record({ messages: [{ role: 'system', content: prompt }, ...history], tools }, {});
  }

  /**
   * Trim-then-summarise the conversation in view on demand (the Compact button
   * and `baiton.compactContext`). Refused while busy; the transcript keeps
   * every record. Trim is round-local (it only shapes one request's payload and
   * is re-applied by the loop's budget seam on every round), and the summary
   * replaces every turn older than the last two — exactly the turns trim would
   * stub — so the 'trim' here is realised by the next send's budget over the
   * compacted history. Runs whether or not the window is known.
   */
  public async compactContext(): Promise<void> {
    if (this.busy) {
      this.deps.webview.post({ type: 'showError', message: 'Wait for the current run to finish before compacting.' });
      return;
    }
    const slug = this.activeSpec;
    const scope = this.activeScope();
    const sessionId = this.activeSessions.get(scopeId(scope));
    if (sessionId === undefined || (await this.sessions.meta(scope, sessionId)) === undefined) {
      this.deps.webview.post({ type: 'showError', message: 'There is nothing to compact in this conversation yet.' });
      return;
    }
    const transcript = this.transcriptFor(scope, sessionId);
    const records = await readTranscript(transcript.path);
    if (compactionCut(records, SUMMARY_KEEP_TURNS) === undefined) {
      this.deps.webview.post({
        type: 'showError',
        message: `Nothing to compact: only the last ${SUMMARY_KEEP_TURNS} turns are in the conversation.`,
      });
      return;
    }
    const key = `${scopeId(scope)}/${sessionId}`;
    this.setBusy(true);
    this.runningKey = key;
    this.abort = new AbortController();
    try {
      const compacted = await this.compact(transcript, key, this.abort.signal, sessionId);
      const history = compacted ?? toHistory(await readTranscript(transcript.path));
      await this.seedContextEstimate(key, slug, history);
      this.postContextUsage(key);
    } catch (err) {
      this.surfaceError(err);
    } finally {
      this.abort = undefined;
      this.runningKey = undefined;
      this.setBusy(false);
    }
  }

  /** The conversation's context tracker, created on first use. */
  private trackerFor(key: string): ContextTracker {
    let tracker = this.trackers.get(key);
    if (tracker === undefined) {
      tracker = new ContextTracker(() => this.deps.contextWindow?.());
      this.trackers.set(key, tracker);
    }
    return tracker;
  }

  /**
   * The per-send context budget: trims the round's payload once the local
   * estimate passes `contextTrimAt` of a known window, and records each
   * completion on the conversation's tracker. Unknown window → sends everything.
   * Its pre-flight then re-checks the payload against window minus the output
   * reserve (trim, summarise, re-estimate) and stops with a sized notice on overflow.
   */
  private contextBudget(
    key: string,
    tools: ToolSpec[],
    autoApprovedLines: ReadonlySet<string>,
    transcript: ChatTranscript,
    sessionId: string,
  ): ContextBudget {
    const tracker = this.trackerFor(key);
    let systemTokens = 0; // last system prompt's estimate, learned in observe
    const estimate = (h: readonly ChatMessage[]): number => systemTokens + estimateMessages(h, tools);
    return {
      prepare: (history) => {
        const window = this.deps.contextWindow?.();
        if (window === undefined || !Number.isInteger(window) || window <= 0) {
          return [...history];
        }
        const trimAt = resolveContextTrimAt(this.deps.contextTrimAt?.());
        if (estimate(history) / window <= trimAt) {
          return [...history];
        }
        return trimHistory(history, { targetTokens: Math.floor(window * trimAt), estimate, autoApprovedLines });
      },
      observe: (sent, completion) => {
        const system = sent.messages[0];
        systemTokens = system?.role === 'system' ? estimateMessages([system]) : 0;
        tracker.record(sent, completion);
        this.postContextUsage(key);
      },
      preflight: (req) =>
        fitToWindow({
          messages: req.messages,
          history: req.history,
          tools: req.tools,
          window: this.deps.contextWindow?.(),
          reserve: resolveOutputReserve(this.deps.maxTokens?.(), this.deps.maxOutput?.()),
          trim: (h, targetTokens, estimate) => trimHistory(h, { targetTokens, estimate, autoApprovedLines }),
          summarise: async () => {
            const compacted = await this.compact(transcript, key, req.signal, sessionId);
            if (compacted !== undefined) {
              this.postContextUsage(key);
            }
            return compacted;
          },
        }),
    };
  }

  /** Whether the history, after trimming, still passes `contextSummarizeAt` of a known window. */
  private shouldSummarize(
    history: readonly ChatMessage[],
    tools: ToolSpec[],
    systemPrompt: string,
    autoApprovedLines: ReadonlySet<string>,
  ): boolean {
    const window = this.deps.contextWindow?.();
    if (window === undefined || !Number.isInteger(window) || window <= 0) {
      return false;
    }
    const estimate = (h: readonly ChatMessage[]): number =>
      estimateMessages([{ role: 'system', content: systemPrompt }]) + estimateMessages(h, tools);
    const trimAt = resolveContextTrimAt(this.deps.contextTrimAt?.());
    const sendable =
      estimate(history) / window > trimAt
        ? trimHistory(history, { targetTokens: Math.floor(window * trimAt), estimate, autoApprovedLines })
        : history;
    return estimate(sendable) / window > resolveContextSummarizeAt(this.deps.contextSummarizeAt?.());
  }

  /**
   * Summarise every message older than the last {@link SUMMARY_KEEP_TURNS}
   * turns with one text-only completion and append the compaction record.
   * Returns the new history, or `undefined` when nothing was compacted (a
   * failure is posted inline and never thrown).
   */
  private async compact(
    transcript: ChatTranscript,
    key: string,
    signal: AbortSignal,
    sessionId: string,
  ): Promise<ChatMessage[] | undefined> {
    const records = await readTranscript(transcript.path);
    const cut = compactionCut(records, SUMMARY_KEEP_TURNS);
    if (cut === undefined) {
      return undefined;
    }
    const older = toHistory(records.slice(0, cut));
    if (older.length === 0 || (older.length === 1 && older[0].content.startsWith(CONTEXT_SUMMARY_PREFIX))) {
      return undefined;
    }
    const window = this.deps.contextWindow?.();
    const budget = window !== undefined ? Math.floor(window / 2) : 32_000;
    const messages = summaryRequestMessages(older, budget);
    let summary: string;
    try {
      const result = await this.deps.client.complete({ messages, signal, sessionId });
      summary = (result.content ?? '').trim();
      if (summary.length === 0) {
        throw new Error('the model returned an empty summary');
      }
    } catch (err) {
      if (signal.aborted) {
        return undefined;
      }
      this.deps.log(`Baiton chat: context summary failed: ${describe(err)}`);
      if (err instanceof UnreachableEndpointError) {
        this.deps.log(err.message);
      }
      this.deps.webview.post({
        type: 'showError',
        message: `Compacting the conversation failed: ${describe(err)}. The conversation was left as it was.`,
      });
      return undefined;
    }
    const marker: CompactionMarker = {
      id: `compaction-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      fromTs: records[0].ts,
      toTs: records[cut - 1].ts,
      messages: older.length,
    };
    const rec = compactionTranscriptRecord(summary, marker);
    await this.append(transcript, rec);
    this.deps.webview.post({ type: 'appendMessage', record: toRenderRecord(rec) });
    this.trackerFor(key).reset();
    return toHistory(await readTranscript(transcript.path));
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
      const active = this.deps.providers?.getSelection()?.provider;
      if (err.missing === 'endpoint' && active !== undefined && active !== 'openai') {
        // A non-settings provider with no base URL: its fix is the per-provider
        // endpoint prompt, not the OpenAI / Custom `orchestrator.endpoint`
        // setting that `openSettings` would land on.
        this.deps.webview.post({
          type: 'showError',
          message: missingProviderEndpointMessage(active),
          action: 'setEndpoint',
          provider: active,
        });
        return;
      }
      const action: FixAction = err.missing === 'apiKey' ? 'setApiKey' : 'openSettings';
      const provider = err.missing === 'apiKey' ? active : undefined;
      this.deps.webview.post({
        type: 'showError',
        message: provider !== undefined ? missingProviderKeyMessage(provider) : missingConfigMessage(err.missing),
        action,
        ...(provider !== undefined ? { provider } : {}),
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

/** The system note one finished run records on the Workspace conversation. */
export function runCompletionNote(outcome: RunPipelineOutcome, manifest: RunManifest): string {
  const id = `\`${outcome.runId}\``;
  switch (outcome.state) {
    case 'done':
      return `Run ${id} (${outcome.mode}) finished on branch \`${manifest.branch}\`: ${outcome.message}. Review the diff and merge it from the Runs view.`;
    case 'answered':
      return `Investigation ${id} finished: ${outcome.message}.`;
    case 'failed':
      return `Run ${id} (${outcome.mode}) failed: ${outcome.message}.`;
    case 'cancelled':
      return `Run ${id} (${outcome.mode}) was cancelled: ${outcome.message}.`;
    default:
      return `Run ${id} (${outcome.mode}) ended (${outcome.state}): ${outcome.message}.`;
  }
}

/** The modes an Investigate finding can be promoted into. */
export const PROMOTE_MODES: readonly RunMode[] = ['bug', 'quick'] as const;

/** The promote card offered once an Investigate run has written its finding. */
export function promoteCardRequest(finding: RunFinding): QuestionRequest {
  const files = finding.files.length > 0 ? finding.files : finding.questionFiles;
  return {
    kind: 'question',
    prompt: [
      `Investigation \`${finding.runId}\` found: ${finding.finding}`,
      files.length > 0 ? `Files: ${files.join(', ')}` : 'Files: (none named)',
      ...(finding.nextSteps.length > 0 ? [`Next steps: ${finding.nextSteps.join('; ')}`] : []),
      '',
      'Start a run from this finding?',
    ].join('\n'),
    options: [
      { id: 'bug', label: 'Start a Bug run', detail: 'Plan, fix and review the defect on its own branch.' },
      { id: 'quick', label: 'Start a Quick run', detail: 'Plan, make and review the small change on its own branch.' },
      { id: 'dismiss', label: 'Dismiss', detail: 'Keep the finding only.' },
    ],
    allowFreeText: false,
  };
}

/**
 * The run confirm card a promoted finding raises; the same shape `start_run`
 * shows, so a promoted run reads identically to a model-dispatched one. The
 * branch is the one that was checked out when the investigation started, so no
 * git call is needed here.
 */
export function promoteRunConfirm(
  mode: RunMode,
  statement: string,
  files: readonly string[],
  branch: string,
): ConfirmRequest {
  return {
    kind: 'confirm',
    prompt: `Start a ${mode} run?`,
    detail: [
      `Mode: ${mode}`,
      `Work: ${statement}`,
      `Files: ${files.length > 0 ? files.join(', ') : '(none guessed)'}`,
      `Target branch: ${branch}`,
      'The run works on its own branch and worktree; nothing outside .baiton/runs/ and .baiton/worktrees/ changes until you merge it.',
    ].join('\n'),
  };
}

/** The system note a promoted dispatch records. */
export function startedRunNote(mode: RunMode, outcome: StartRunOutcome): string {
  switch (outcome.kind) {
    case 'started':
      return `Started a ${mode} run \`${outcome.runId}\`${outcome.branch !== undefined ? ` on branch \`${outcome.branch}\`` : ''}.`;
    case 'busy':
      return `The ${mode} run did not start: a stage is already running for this repository.`;
    case 'refused':
      return `The ${mode} run did not start: ${outcome.reason}.`;
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

/**
 * The inline message naming the provider whose API key is missing.
 */
function missingProviderKeyMessage(provider: ProviderId): string {
  return `The ${providerInfo(provider).label} API key is not configured.`;
}

/** The inline message for a non-settings provider that has no endpoint to call. */
function missingProviderEndpointMessage(provider: ProviderId): string {
  return `The ${providerInfo(provider).label} endpoint is not configured.`;
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

/**
 * The escalation an escalated permission card carries: the gate's one-sentence
 * summary and optional detail line, the raw command (or args) to show under
 * it, and the stage-(a) reason for the audit record only.
 */
function cardEscalation(
  ask: PermissionRequest,
  outcome: Extract<AutoModeOutcome, { kind: 'escalate' }>,
): InterventionEscalation {
  const command = askCommandText(askFromPermission(ask));
  return {
    summary: outcome.summary,
    ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
    ...(command !== undefined ? { command } : {}),
    ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
  };
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

/**
 * The most recent `fetchedAt` among the given availability entries, as the
 * host reported it. Entries with no `fetchedAt` (copilot, openai, and any
 * builtin-backed provider) are ignored, and an unparseable value is ignored
 * rather than allowed to win. Returns undefined when nothing is catalog-backed.
 */
function latestFetchedAt(entries: readonly ProviderAvailabilityView[]): string | undefined {
  let best: string | undefined;
  let bestMs = -Infinity;
  for (const e of entries) {
    if (e.fetchedAt === undefined) continue;
    const ms = Date.parse(e.fetchedAt);
    if (!Number.isFinite(ms) || ms <= bestMs) continue;
    bestMs = ms;
    best = e.fetchedAt;
  }
  return best;
}

/** The one-line audit rationale of an Auto-mode approval, naming the stage that decided. */
function autoApprovalRationale(outcome: Extract<AutoModeOutcome, { kind: 'approve' }>): string {
  const stage = outcome.stage === 'allow-list' ? 'allow-list' : 'model review';
  return `Auto mode (${stage}): ${outcome.rationale}`;
}
