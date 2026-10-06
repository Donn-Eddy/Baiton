/**
 * Host-free sub-agent runner.
 *
 * Owns the live sub-agents of one controller. `spawn` creates a child chat
 * under the calling chat and runs its first turn; `send` re-enters an existing
 * child's loop with a follow-up (rehydrating from disk when it is not live).
 * Every turn's abort signal is chained to the caller's, a depth cap refuses
 * over-deep spawns before anything is written, and `stopDescendants` aborts
 * every running descendant of a chat and declines its pending forwarded asks.
 * An `ask_user` raised inside a sub-agent turn is attributed to that sub-agent
 * (its origin) through AsyncLocalStorage, and view events report progress.
 */
import { AsyncLocalStorage } from 'async_hooks';
import type { ChatMessage, ModelClient, ToolSpec } from './modelClient';
import type { GuardContext, OrchestratorPhase, Tool, ToolCaller, ToolResult, ToolSurface } from './guard';
import type { ToolDescriptionError } from './registry';
import type { Result } from '../model/result';
import { ChatTranscript, TranscriptRecord, forwardedAskNoteRecord, interventionViewOf } from './chatTranscript';
import { readTranscript, toHistory } from './transcriptReader';
import { SessionStore, SessionScope, scopeId, parentIdOf, sessionIdSegments } from './sessionStore';
import { buildSubAgentPrompt } from './systemPrompt';
import { runToolLoop, resolveRoundBound } from './toolLoop';
import {
  MAX_SUBAGENT_DEPTH,
  SubAgentSeam,
  SpawnSubAgentRequest,
  SpawnSubAgentOutcome,
  SendToSubAgentRequest,
  SendToSubAgentOutcome,
  Clock,
  systemClock,
} from './seams';
import { subAgentDepthRefusal } from './controlTools';
import type {
  InterventionSeam,
  InterventionRequest,
  InterventionAnswer,
  InterventionOrigin,
  PendingAskRegistry,
} from './interventions';

/** A chat's session key: `<scopeId>/<sessionId>` — the same shape ChatController uses for runningKey. */
export function chatSessionKey(scope: SessionScope, sessionId: string): string {
  return `${scopeId(scope)}/${sessionId}`;
}

/** The session id inside a key of `scope`, or undefined when the key belongs to another scope. */
export function sessionIdFromKey(scope: SessionScope, key: string): string | undefined {
  const p = `${scopeId(scope)}/`;
  return key.startsWith(p) && key.length > p.length ? key.slice(p.length) : undefined;
}

/** Whether `key` is a strict descendant of `ancestorKey`. */
export function isDescendantKey(key: string, ancestorKey: string): boolean {
  return key.startsWith(`${ancestorKey}/`);
}

/** The slice of the tool registry a sub-agent turn needs (ToolRegistry satisfies it structurally). */
export interface SubAgentToolSurface {
  assembleFor(phase: OrchestratorPhase, surface: ToolSurface): Result<ToolSpec[], ToolDescriptionError>;
  definitionsFor(phase: OrchestratorPhase, surface: ToolSurface): Tool[];
  call(
    name: string,
    args: unknown,
    callId: string | undefined,
    ctx: GuardContext,
    phase: OrchestratorPhase,
    surface: ToolSurface,
    caller?: ToolCaller,
  ): Promise<ToolResult>;
}

export type SubAgentEvent =
  | { type: 'started'; chatId: string; key: string; parentKey: string; rootKey: string; scope: SessionScope; depth: number; task: string }
  | { type: 'delta'; chatId: string; key: string; rootKey: string; text: string }
  | { type: 'appended'; chatId: string; key: string; rootKey: string; record: Omit<TranscriptRecord, 'ts'> }
  | { type: 'finished'; chatId: string; key: string; rootKey: string; outcome: 'replied' | 'stopped' | 'failed'; reply?: string; error?: string };

export interface SubAgentInfo {
  chatId: string;
  key: string;
  parentKey: string;
  rootKey: string;
  depth: number;
  running: boolean;
}

export interface SubAgentRunnerDeps {
  sessions: SessionStore;
  client: ModelClient;
  /** Lazy: the registry is built from services that include this runner (spawn seam + wrapped intervention seam). */
  tools(): SubAgentToolSurface;
  guardContext(): GuardContext;
  /** Resolved with resolveRoundBound per turn. */
  roundBound(): unknown;
  /** Re-read every round for a spec scope. */
  readSpec(slug: string): Promise<string | undefined>;
  /** To decline a stopped sub-agent's pending forwarded asks. */
  asks?: PendingAskRegistry;
  /** For ChatTranscript timestamps; default systemClock. */
  clock?: Clock;
  /** Must not throw; calls are wrapped in try/catch and logged. */
  onEvent?(event: SubAgentEvent): void;
  log?(message: string): void;
}

interface LiveSubAgent {
  chatId: string;
  key: string;
  parentKey: string;
  rootKey: string;
  scope: SessionScope;
  depth: number;
  phase: OrchestratorPhase;
  transcript: ChatTranscript;
  history: ChatMessage[];
  /** Set while a turn runs; undefined when idle. */
  turn: AbortController | undefined;
  /** Counter for forwarded-ask note ids. */
  noteSeq: number;
}

type TurnOutcome = { ok: true; reply: string } | { ok: false; reason: string };

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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class SubAgentRunner implements SubAgentSeam {
  private readonly live = new Map<string, LiveSubAgent>();
  private readonly turnContext = new AsyncLocalStorage<LiveSubAgent>();

  constructor(private readonly deps: SubAgentRunnerDeps) {}

  public async spawn(req: SpawnSubAgentRequest): Promise<SpawnSubAgentOutcome> {
    const caller = req.caller;
    if (caller.depth >= MAX_SUBAGENT_DEPTH) {
      return { kind: 'refused', reason: subAgentDepthRefusal(caller.depth) };
    }
    if (caller.signal.aborted) {
      return { kind: 'refused', reason: 'the calling chat was stopped' };
    }
    const scope = caller.kind;
    const parentId = sessionIdFromKey(scope, caller.sessionKey);
    if (parentId === undefined) {
      return { kind: 'refused', reason: `unknown calling chat "${caller.sessionKey}"` };
    }
    const chatId = await this.deps.sessions.createChild(scope, parentId);
    const entry = this.newEntry(scope, chatId, caller.depth + 1, caller.phase, []);
    this.live.set(entry.key, entry);
    this.emit({
      type: 'started',
      chatId,
      key: entry.key,
      parentKey: entry.parentKey,
      rootKey: entry.rootKey,
      scope,
      depth: entry.depth,
      task: req.task,
    });
    const r = await this.runTurn(entry, req.task, caller.signal);
    return r.ok ? { kind: 'replied', chatId, reply: r.reply } : { kind: 'refused', reason: r.reason };
  }

  public async send(req: SendToSubAgentRequest): Promise<SendToSubAgentOutcome> {
    const caller = req.caller;
    const scope = caller.kind;
    const callerId = sessionIdFromKey(scope, caller.sessionKey);
    try {
      sessionIdSegments(req.chatId);
    } catch {
      return { kind: 'refused', reason: 'invalid chat id' };
    }
    if (callerId === undefined || parentIdOf(req.chatId) !== callerId) {
      return { kind: 'refused', reason: `chat "${req.chatId}" is not a sub-agent of this chat` };
    }
    let entry = this.live.get(chatSessionKey(scope, req.chatId));
    if (entry === undefined) {
      const meta = await this.deps.sessions.meta(scope, req.chatId);
      if (meta === undefined) {
        return { kind: 'refused', reason: `no sub-agent chat "${req.chatId}"` };
      }
      const history = toHistory(await readTranscript(this.deps.sessions.pathFor(scope, req.chatId)));
      entry = this.newEntry(scope, req.chatId, caller.depth + 1, caller.phase, history);
      this.live.set(entry.key, entry);
    }
    if (entry.turn !== undefined) {
      return { kind: 'refused', reason: `sub-agent "${req.chatId}" is still working on its previous turn` };
    }
    const r = await this.runTurn(entry, req.message, caller.signal);
    return r.ok ? { kind: 'replied', reply: r.reply } : { kind: 'refused', reason: r.reason };
  }

  /** Stop on the parent aborts every descendant's running turn and declines their pending asks; returns how many turns were aborted. */
  public stopDescendants(parentKey: string, reason = 'the run was stopped'): number {
    let count = 0;
    for (const entry of this.live.values()) {
      if (!isDescendantKey(entry.key, parentKey)) {
        continue;
      }
      if (entry.turn !== undefined) {
        entry.turn.abort();
        count += 1;
      }
      this.declineAsksOf(entry.key, reason);
    }
    return count;
  }

  public isRunning(key: string): boolean {
    return this.live.get(key)?.turn !== undefined;
  }

  /** The live sub-agents, optionally only those under `rootKey`. */
  public list(rootKey?: string): SubAgentInfo[] {
    return [...this.live.values()]
      .filter((e) => rootKey === undefined || isDescendantKey(e.key, rootKey))
      .map((e) => ({
        chatId: e.chatId,
        key: e.key,
        parentKey: e.parentKey,
        rootKey: e.rootKey,
        depth: e.depth,
        running: e.turn !== undefined,
      }));
  }

  /** Abort every running turn. */
  public dispose(): void {
    for (const entry of this.live.values()) {
      entry.turn?.abort();
    }
  }

  /**
   * Wrap the host's intervention seam so an ask raised inside a sub-agent turn
   * carries that sub-agent as its origin, and the sub-agent's transcript notes
   * the forwarded ask. Showing the parent's card (on `origin.rootKey`'s chat,
   * persisted to the parent transcript) is the controller's job; the runner
   * only stamps the origin and records the child-side note.
   */
  public interventionSeam(base: InterventionSeam): InterventionSeam {
    return {
      ask: async (request, origin) => {
        const entry = this.turnContext.getStore();
        if (entry === undefined) {
          return base.ask(request, origin);
        }
        const own: InterventionOrigin = { rootKey: entry.rootKey, chatId: entry.chatId, chatKey: entry.key, depth: entry.depth };
        const answer = await base.ask(request, own);
        await this.noteForwardedAsk(entry, request, answer);
        return answer;
      },
    };
  }

  private newEntry(
    scope: SessionScope,
    chatId: string,
    depth: number,
    phase: OrchestratorPhase,
    history: ChatMessage[],
  ): LiveSubAgent {
    const parentId = parentIdOf(chatId) as string;
    return {
      chatId,
      key: chatSessionKey(scope, chatId),
      parentKey: chatSessionKey(scope, parentId),
      rootKey: chatSessionKey(scope, sessionIdSegments(chatId)[0]),
      scope,
      depth,
      phase,
      transcript: new ChatTranscript(this.deps.sessions.pathFor(scope, chatId), this.deps.clock ?? systemClock),
      history,
      turn: undefined,
      noteSeq: 0,
    };
  }

  private async runTurn(entry: LiveSubAgent, text: string, parentSignal: AbortSignal): Promise<TurnOutcome> {
    const turn = new AbortController();
    const onParentAbort = (): void => turn.abort();
    if (parentSignal.aborted) {
      turn.abort();
    } else {
      parentSignal.addEventListener('abort', onParentAbort, { once: true });
    }
    turn.signal.addEventListener('abort', () => this.declineAsksOf(entry.key), { once: true });
    entry.turn = turn;
    const base = { chatId: entry.chatId, key: entry.key, rootKey: entry.rootKey };
    try {
      const userRecord = { role: 'user' as const, content: text };
      await entry.transcript.append(userRecord);
      entry.history.push({ ...userRecord });
      this.emit({ type: 'appended', ...base, record: userRecord });

      const assembled = this.deps.tools().assembleFor(entry.phase, 'subagent');
      if (!assembled.ok) {
        const reason = `the sub-agent's tools are invalid: ${assembled.error.tool}: ${assembled.error.reason}`;
        this.emit({ type: 'finished', ...base, outcome: 'failed', error: reason });
        return { ok: false, reason };
      }
      const concurrent = new Set(
        this.deps
          .tools()
          .definitionsFor(entry.phase, 'subagent')
          .filter((t) => t.concurrent === true)
          .map((t) => t.name),
      );

      await this.turnContext.run(entry, () =>
        runToolLoop(entry.history, {
          client: this.deps.client,
          tools: assembled.value,
          call: (name, args, callId, signal) =>
            signal.aborted
              ? Promise.resolve({ ok: false, error: 'the run was stopped before the tool call' })
              : this.deps.tools().call(name, parseArgs(args), callId, this.deps.guardContext(), entry.phase, 'subagent', {
                  sessionKey: entry.key,
                  depth: entry.depth,
                  phase: entry.phase,
                  kind: entry.scope,
                  signal,
                }),
          isConcurrent: (name) => concurrent.has(name),
          systemPrompt: async () =>
            buildSubAgentPrompt(
              entry.scope,
              entry.phase,
              entry.depth,
              entry.scope.kind === 'spec' ? await this.deps.readSpec(entry.scope.slug) : undefined,
            ),
          append: async (m) => {
            await entry.transcript.append(m);
            this.emit({ type: 'appended', ...base, record: m });
          },
          roundBound: resolveRoundBound(this.deps.roundBound()),
          signal: turn.signal,
          onDelta: (t) => this.emit({ type: 'delta', ...base, text: t }),
          sessionId: entry.chatId,
        }),
      );

      if (turn.signal.aborted) {
        this.emit({ type: 'finished', ...base, outcome: 'stopped' });
        return { ok: false, reason: 'the sub-agent was stopped' };
      }
      let reply = '';
      for (let i = entry.history.length - 1; i >= 0; i -= 1) {
        if (entry.history[i].role === 'assistant') {
          reply = entry.history[i].content;
          break;
        }
      }
      this.emit({ type: 'finished', ...base, outcome: 'replied', reply });
      return { ok: true, reply };
    } catch (err) {
      const message = errorMessage(err);
      this.emit({ type: 'finished', ...base, outcome: 'failed', error: message });
      return { ok: false, reason: message };
    } finally {
      parentSignal.removeEventListener('abort', onParentAbort);
      entry.turn = undefined;
    }
  }

  private async noteForwardedAsk(
    entry: LiveSubAgent,
    request: InterventionRequest,
    answer: InterventionAnswer,
  ): Promise<void> {
    try {
      entry.noteSeq += 1;
      const view = interventionViewOf({
        ...request,
        id: `${entry.chatId}#ask-${entry.noteSeq}`,
        createdAt: (this.deps.clock ?? systemClock).now(),
      });
      const record = forwardedAskNoteRecord(view, answer);
      await entry.transcript.append(record);
      this.emit({ type: 'appended', chatId: entry.chatId, key: entry.key, rootKey: entry.rootKey, record });
    } catch (err) {
      this.deps.log?.(`sub-agent ${entry.chatId}: could not record forwarded ask: ${errorMessage(err)}`);
    }
  }

  private declineAsksOf(chatKey: string, reason = 'the run was stopped'): void {
    const asks = this.deps.asks;
    if (asks === undefined) {
      return;
    }
    for (const i of asks.pending()) {
      if (i.origin?.chatKey === chatKey) {
        asks.reject(i.id, reason);
      }
    }
  }

  private emit(event: SubAgentEvent): void {
    try {
      this.deps.onEvent?.(event);
    } catch (err) {
      this.deps.log?.(`sub-agent event listener failed: ${errorMessage(err)}`);
    }
  }
}

export function createSubAgentRunner(deps: SubAgentRunnerDeps): SubAgentRunner {
  return new SubAgentRunner(deps);
}
