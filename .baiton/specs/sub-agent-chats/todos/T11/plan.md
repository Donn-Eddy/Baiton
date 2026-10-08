# Plan T11

## Steps

1. Give interventions an optional origin (interventions.ts)

   In src/orchestrator/interventions.ts add and export:

   ```ts
   /** Where a forwarded sub-agent ask came from: the card is shown on `rootKey`'s chat; `chatId`/`chatKey` name the sub-agent chat that asked. */
   export interface InterventionOrigin {
     rootKey: string;   // session key of the top-level chat (`<scopeId>/<rootSessionId>`)
     chatId: string;    // the sub-agent's session id (`<root>/<leaf>[/<leaf>]`)
     chatKey: string;   // the sub-agent's session key (`<scopeId>/<chatId>`)
     depth: number;     // the sub-agent's depth (1 or 2)
   }
   ```

   - Extend `Intervention` with `origin?: InterventionOrigin` (doc: present only for an ask a sub-agent raised).
   - `PendingAskRegistry.create(request, origin?: InterventionOrigin)`: stamp `origin` on the intervention ONLY when defined (use a conditional spread) so every existing deepEqual test of a created intervention is unchanged.
   - `InterventionSeam.ask(request: InterventionRequest, origin?: InterventionOrigin): Promise<InterventionAnswer>` — optional second parameter, so every existing one-arg implementation and fake still type-checks.
   - `createInterventionSeam(registry, present)`: `ask(request, origin)` forwards `origin` into `registry.create(request, origin)`; nothing else changes. `confirmSeamFrom` unchanged.
   - Update the module header comment with one bullet about origins.

   Files: `src/orchestrator/interventions.ts`

2. Add the forwarded-ask transcript helpers (chatTranscript.ts)

   In src/orchestrator/chatTranscript.ts:

   1. Add to `TranscriptRecord` an optional field `forwarded?: boolean` — doc: 'For an intervention record on a sub-agent transcript: the ask was forwarded to, and answered on, the parent chat.' (optional → old transcripts and readers unaffected).
   2. Add a pure projection `export function interventionViewOf(ask: Intervention): InterventionView` that is exactly the body of the private `toInterventionView` in src/activation/chatController.ts (lines ~1916-1938: base {id, kind, prompt, status:'pending'} plus per-kind optional fields). Import `type Intervention` from './interventions'. Do NOT touch chatController.ts in this todo (it is out of scope); the duplicate is acceptable and can be deduped when the controller is wired.
   3. Add:
   ```ts
   /** The note a sub-agent transcript records for an ask forwarded to its parent chat: the settled card, flagged `forwarded`. It is an intervention record (role 'system') so `toHistory` defers it while the ask_user tool call is still open and replays it as the ask and its decision. */
   export function forwardedAskNoteRecord(view: InterventionView, answer: InterventionAnswer): Omit<TranscriptRecord, 'ts'> {
     return { ...interventionTranscriptRecord(settledInterventionView(view, answer)), content: `Asked the user (on the parent chat): ${view.prompt}`, forwarded: true };
   }
   ```
   Rationale (put in the doc comment): a plain `system` record appended between an assistant `tool_calls` record and its `tool` result would make `toHistory` flush and drop the tool result; an `intervention` record is deferred correctly.

   Files: `src/orchestrator/chatTranscript.ts`

3. Create the SubAgentRunner core (subAgent.ts) — types and keys

   New file src/orchestrator/subAgent.ts, no `vscode` import. Header comment summarising: host-free runner owning the live sub-agents of one controller; spawn/send over child sessions; chained abort; depth cap; stopDescendants; forwarded asks carry their origin via AsyncLocalStorage; view events.

   Imports: `AsyncLocalStorage` from 'async_hooks'; `ChatMessage, ModelClient, ToolSpec` from './modelClient'; `GuardContext, OrchestratorPhase, Tool, ToolCaller, ToolResult, ToolSurface` from './guard'; `ToolDescriptionError` type from './registry' (type-only import to avoid a runtime cycle); `Result` from '../model/result'; `ChatTranscript, TranscriptRecord, forwardedAskNoteRecord, interventionViewOf` from './chatTranscript'; `readTranscript, toHistory` from './transcriptReader'; `SessionStore, SessionScope, scopeId, parentIdOf, sessionIdSegments` from './sessionStore'; `buildSubAgentPrompt, ConversationKind` from './systemPrompt'; `runToolLoop, resolveRoundBound` from './toolLoop'; `MAX_SUBAGENT_DEPTH, SubAgentSeam, SpawnSubAgentRequest, SpawnSubAgentOutcome, SendToSubAgentRequest, SendToSubAgentOutcome, Clock, systemClock` from './seams'; `subAgentDepthRefusal` from './controlTools'; `InterventionSeam, InterventionRequest, InterventionAnswer, InterventionOrigin, PendingAskRegistry` from './interventions'.

   Exported helpers (grep src/ first to make sure these names are not already exported from src/orchestrator/index.ts; rename with a `subAgent` prefix if they collide):
   ```ts
   /** A chat's session key: `<scopeId>/<sessionId>` — the same shape ChatController uses for runningKey. */
   export function chatSessionKey(scope: SessionScope, sessionId: string): string { return `${scopeId(scope)}/${sessionId}`; }
   /** The session id inside a key of `scope`, or undefined when the key belongs to another scope. */
   export function sessionIdFromKey(scope: SessionScope, key: string): string | undefined { const p = `${scopeId(scope)}/`; return key.startsWith(p) && key.length > p.length ? key.slice(p.length) : undefined; }
   /** Whether `key` is a strict descendant of `ancestorKey`. */
   export function isDescendantKey(key: string, ancestorKey: string): boolean { return key.startsWith(`${ancestorKey}/`); }
   ```

   Narrow tool surface (ToolRegistry satisfies it structurally):
   ```ts
   export interface SubAgentToolSurface {
     assembleFor(phase: OrchestratorPhase, surface: ToolSurface): Result<ToolSpec[], ToolDescriptionError>;
     definitionsFor(phase: OrchestratorPhase, surface: ToolSurface): Tool[];
     call(name: string, args: unknown, callId: string | undefined, ctx: GuardContext, phase: OrchestratorPhase, surface: ToolSurface, caller?: ToolCaller): Promise<ToolResult>;
   }
   ```

   Events:
   ```ts
   export type SubAgentEvent =
     | { type: 'started'; chatId: string; key: string; parentKey: string; rootKey: string; scope: SessionScope; depth: number; task: string }
     | { type: 'delta'; chatId: string; key: string; rootKey: string; text: string }
     | { type: 'appended'; chatId: string; key: string; rootKey: string; record: Omit<TranscriptRecord, 'ts'> }
     | { type: 'finished'; chatId: string; key: string; rootKey: string; outcome: 'replied' | 'stopped' | 'failed'; reply?: string; error?: string };
   export interface SubAgentInfo { chatId: string; key: string; parentKey: string; rootKey: string; depth: number; running: boolean; }
   ```

   Deps:
   ```ts
   export interface SubAgentRunnerDeps {
     sessions: SessionStore;
     client: ModelClient;
     /** Lazy: the registry is built from services that include this runner (spawn seam + wrapped intervention seam). */
     tools(): SubAgentToolSurface;
     guardContext(): GuardContext;
     roundBound(): unknown;          // resolved with resolveRoundBound per turn
     readSpec(slug: string): Promise<string | undefined>; // re-read every round for a spec scope
     asks?: PendingAskRegistry;      // to decline a stopped sub-agent's pending forwarded asks
     clock?: Clock;                  // for ChatTranscript timestamps; default systemClock
     onEvent?(event: SubAgentEvent): void; // must not throw; wrap calls in try/catch + log
     log?(message: string): void;
   }
   ```

   Files: `src/orchestrator/subAgent.ts`

4. SubAgentRunner — live registry, spawn, send, turn loop

   In subAgent.ts implement `export class SubAgentRunner implements SubAgentSeam` and `export function createSubAgentRunner(deps): SubAgentRunner`.

   Private state: `private readonly live = new Map<string, LiveSubAgent>()` keyed by session KEY (scope-qualified, so the same id in two scopes never collides), and a module- or instance-level `private readonly turnContext = new AsyncLocalStorage<LiveSubAgent>()`.

   ```ts
   interface LiveSubAgent {
     chatId: string; key: string; parentKey: string; rootKey: string;
     scope: SessionScope; depth: number; phase: OrchestratorPhase;
     transcript: ChatTranscript; history: ChatMessage[];
     turn: AbortController | undefined;  // set while a turn runs; undefined when idle
     noteSeq: number;                     // counter for forwarded-ask note ids
   }
   ```

   `spawn(req: SpawnSubAgentRequest): Promise<SpawnSubAgentOutcome>`:
   1. `if (req.caller.depth >= MAX_SUBAGENT_DEPTH) return { kind: 'refused', reason: subAgentDepthRefusal(req.caller.depth) }` — before any filesystem write.
   2. `if (req.caller.signal.aborted)` → refused 'the calling chat was stopped'.
   3. `scope = req.caller.kind`; `parentId = sessionIdFromKey(scope, req.caller.sessionKey)`; undefined → refused `unknown calling chat "<key>"`.
   4. `chatId = await deps.sessions.createChild(scope, parentId)`; `key = chatSessionKey(scope, chatId)`; `depth = req.caller.depth + 1`; `rootKey = chatSessionKey(scope, sessionIdSegments(chatId)[0])`; `transcript = new ChatTranscript(deps.sessions.pathFor(scope, chatId), deps.clock ?? systemClock)`; `history = []`; `phase = req.caller.phase`. Register in `live`. Emit `started` (task = req.task).
   5. `const r = await this.runTurn(entry, req.task, req.caller.signal)`; map to `{kind:'replied', chatId, reply}` or `{kind:'refused', reason}`.

   `send(req: SendToSubAgentRequest)`:
   1. `scope = req.caller.kind`; `callerId = sessionIdFromKey(scope, req.caller.sessionKey)`; validate `req.chatId` with `sessionIdSegments` in try/catch (invalid → refused 'invalid chat id').
   2. Ownership: `parentIdOf(req.chatId) !== callerId` → refused `chat "<id>" is not a sub-agent of this chat` (only the direct parent may follow up).
   3. `entry = live.get(chatSessionKey(scope, req.chatId))`. If absent, rehydrate from disk: `meta = await deps.sessions.meta(scope, req.chatId)`; missing → refused `no sub-agent chat "<id>"`; else build an entry with `history = toHistory(await readTranscript(path))`, depth = caller.depth + 1, phase = caller.phase, and register it (a window reload must not lose the child).
   4. `entry.turn !== undefined` → refused `sub-agent "<id>" is still working on its previous turn`.
   5. `runTurn(entry, req.message, req.caller.signal)` and map as above.

   `private async runTurn(entry, text, parentSignal): Promise<{ok:true; reply:string} | {ok:false; reason:string}>`:
   - Create `turn = new AbortController()`; chain: if `parentSignal.aborted` abort immediately, else `parentSignal.addEventListener('abort', onParentAbort, { once: true })` and REMOVE the listener in `finally`. Also `turn.signal.addEventListener('abort', () => this.declineAsksOf(entry.key), { once: true })`. Set `entry.turn = turn`.
   - Append `{ role: 'user', content: text }` to transcript + `entry.history`, emit `appended`.
   - `assembled = deps.tools().assembleFor(entry.phase, 'subagent')`; on `!ok` → finish 'failed' and return reason `the sub-agent's tools are invalid: <tool>: <reason>` (check the `Result` shape in src/model/result.ts for the ok/err field names).
   - Concurrency lookup: `const concurrent = new Set(deps.tools().definitionsFor(entry.phase, 'subagent').filter(t => t.concurrent === true).map(t => t.name))`.
   - Inside `await this.turnContext.run(entry, () => runToolLoop(entry.history, {...}))` with deps:
     - `client: deps.client`, `tools: assembled.value`,
     - `call: (name, args, callId, signal) => signal.aborted ? Promise.resolve({ ok:false, error:'the run was stopped before the tool call' }) : deps.tools().call(name, parseArgs(args), callId, deps.guardContext(), entry.phase, 'subagent', { sessionKey: entry.key, depth: entry.depth, phase: entry.phase, kind: entry.scope, signal })` — the child's caller.signal is the turn signal, so a grandchild's turn chains to it automatically,
     - `isConcurrent: (name) => concurrent.has(name)`,
     - `systemPrompt: async () => buildSubAgentPrompt(entry.scope, entry.phase, entry.depth, entry.scope.kind === 'spec' ? await deps.readSpec(entry.scope.slug) : undefined)`,
     - `append: async (m) => { await entry.transcript.append(m); this.emit({ type:'appended', ... record: m }); }`,
     - `roundBound: resolveRoundBound(deps.roundBound())`, `signal: turn.signal`,
     - `onDelta: (t) => this.emit({ type:'delta', ..., text: t })`, `sessionId: entry.chatId`.
     (No context budget in this todo.)
   - After the loop: if `turn.signal.aborted` → emit finished 'stopped', return `{ok:false, reason:'the sub-agent was stopped'}`. Else reply = content of the last `assistant` message in `entry.history` (the loop always ends with one: the reply, or the round-bound notice) → emit finished 'replied' and return it.
   - catch(err) → emit finished 'failed' with the message; return `{ok:false, reason: message}` (never throw out of spawn/send).
   - finally: remove parent listener, `entry.turn = undefined`.

   `parseArgs(args: string): unknown` — private copy of chatController's: empty string → `{}`, JSON.parse, parse error → `{}`.

   `private emit(e)` calls `deps.onEvent?.(e)` inside try/catch (log on throw).

   Public queries/controls:
   - `stopDescendants(parentKey: string, reason = 'the run was stopped'): number` — for every live entry with `isDescendantKey(entry.key, parentKey)` and `entry.turn !== undefined`: `entry.turn.abort()`; also call `this.declineAsksOf(entry.key, reason)`; return how many turns were aborted. Doc: Stop on the parent aborts every descendant and declines their pending asks.
   - `isRunning(key: string): boolean`; `list(rootKey?: string): SubAgentInfo[]` (optionally filtered to that root's descendants); `running(rootKey)` not needed.
   - `dispose(): void` — abort every running turn.
   - `private declineAsksOf(chatKey, reason = 'the run was stopped')`: if `deps.asks` is set, for each `i of deps.asks.pending()` with `i.origin?.chatKey === chatKey` → `deps.asks.reject(i.id, reason)`.

   Files: `src/orchestrator/subAgent.ts`

5. SubAgentRunner — origin-carrying intervention seam

   Add `interventionSeam(base: InterventionSeam): InterventionSeam` on SubAgentRunner. The host (a later todo, commands.ts) passes the result as `ToolServices.intervention` so `ask_user` (which is unchanged and calls `services.intervention.ask(request)`) is transparently attributed:

   ```ts
   public interventionSeam(base: InterventionSeam): InterventionSeam {
     return {
       ask: async (request, origin) => {
         const entry = this.turnContext.getStore();
         if (entry === undefined) return base.ask(request, origin);   // a top-level chat's ask: unchanged
         const own: InterventionOrigin = { rootKey: entry.rootKey, chatId: entry.chatId, chatKey: entry.key, depth: entry.depth };
         const answer = await base.ask(request, own);
         await this.noteForwardedAsk(entry, request, answer);
         return answer;
       },
     };
   }
   ```
   AsyncLocalStorage propagates through the awaits of `runToolLoop` → `deps.tools().call` → guard → `ask_user.run` → `services.intervention.ask`, so concurrent sub-agents each see their own entry and a grandchild's `turnContext.run` overrides its parent's.

   `private async noteForwardedAsk(entry, request, answer)`: build a view with `interventionViewOf({ ...request, id: `${entry.chatId}#ask-${++entry.noteSeq}`, createdAt: (deps.clock ?? systemClock).now() })`, record = `forwardedAskNoteRecord(view, answer)`; `await entry.transcript.append(record)` and emit `appended`; catch and `deps.log?.(...)` on failure (a failed note must never fail the ask). Do NOT push it into `entry.history` (the tool result already carries the answer to the model).

   Doc comment: the parent's card (shown on `origin.rootKey`'s chat and persisted to the parent transcript) is the controller's job; the runner only stamps the origin and records the child-side note.

   Files: `src/orchestrator/subAgent.ts`

6. Export from the orchestrator barrel

   Add `export * from './subAgent';` to src/orchestrator/index.ts after `export * from './registry';`. Run `npm run compile` to confirm no duplicate-export error (TS2308); if one appears, rename the colliding helper in subAgent.ts.

   Files: `src/orchestrator/index.ts`

7. Tests: test/subAgent.test.ts (mocha, temp dirs, fake model client)

   Pattern after test/sessionStore.test.ts (temp dir via fs.mkdtemp under os.tmpdir(), removed in afterEach) and test/toolLoop.test.ts (scripted client). Build a real `SessionStore({ baitonDir, specsDir, clock: fixed-incrementing clock, random: seeded })` so ids are deterministic.

   Fakes:
   - `RoutedClient implements ModelClient`: `complete(req)` routes on `req.sessionId` (the child id) to a per-session script: a queue of `CompletionResult`s or functions `(req) => Promise<CompletionResult>`; records every request. Provide a `hang` script entry that rejects when `req.signal` aborts (to test stop).
   - `FakeSurface implements SubAgentToolSurface`: `assembleFor` returns ok([...specs]) and records (phase, surface); `definitionsFor` returns tools with `concurrent: true` for 'spawn_subagent'/'read_file'; `call` records (name, args, phase, surface, caller) and dispatches: 'spawn_subagent' → `runner.spawn({ task: args.task, caller })` mapped like controlTools (or ok with {chatId, reply} / error); 'ask_user' → `services.intervention.ask({ kind:'question', prompt: args.question, allowFreeText: true })` where the intervention seam is `runner.interventionSeam(createInterventionSeam(asks, capturePresent))`.
   - Parent caller helper: `{ sessionKey: 'workspace/P1', depth: 0, phase: 'gather', kind: { kind: 'workspace' }, signal: new AbortController().signal }`.

   Cases:
   1. spawn: returns `{kind:'replied', chatId:'P1/<leaf>', reply}`; transcript exists at `<baitonDir>/chat/P1.children/<leaf>.jsonl` with records [user=task, assistant=reply]; `sessions.listChildren(scope,'P1')` lists it with title = task; events in order started → appended(user) → appended(assistant) → finished('replied'); the first request's first message is the system prompt equal to `buildSubAgentPrompt({kind:'workspace'}, 'gather', 1)`; `assembleFor` called with ('gather','subagent'); request.sessionId === chatId.
   2. tool calls use the sub-agent surface: script a tool call then a final reply; assert FakeSurface.call got surface 'subagent', phase 'gather', caller.depth 1, caller.sessionKey `workspace/P1/<leaf>`, caller.kind workspace.
   3. follow-up: `send({chatId, message, caller})` → reply; the second request's messages contain task, first reply and the follow-up in order; transcript has 4 records. Refusals: unknown chat id; a chat id whose parent is not the caller (e.g. caller 'workspace/P2'); send while the first turn is still running → 'still working'.
   4. rehydrate: a new runner instance (same store) can `send` to a child spawned by a previous one, and the request history includes the earlier turn.
   5. depth cap: `spawn` with caller.depth 2 → refused, reason includes `MAX_SUBAGENT_DEPTH = 2`, and no `.children` folder is created. Nested: child's script calls spawn_subagent → grandchild created at `P1.children/<c>.children/<g>.jsonl` with depth 2; grandchild's own spawn_subagent call is refused (tool result in grandchild transcript contains 'MAX_SUBAGENT_DEPTH = 2').
   6. concurrent: two spawns from the same parent started together (Promise.all); each child's first completion awaits a shared barrier that resolves only after BOTH children have issued a request (proves they overlap; with sequential execution the test would time out — use a short mocha timeout like 2000ms); both replies correct; two separate transcripts, no cross-talk; `list()` shows two entries.
   7. stop: child script `hang`; start spawn (don't await), wait until the client saw its request, call `runner.stopDescendants('workspace/P1')` → returns 1; spawn resolves refused 'the sub-agent was stopped'; transcript ends with assistant 'The run was stopped.'; finished event outcome 'stopped'. Chained abort: aborting the parent caller's AbortController instead also stops it. Nested stop: stopping 'workspace/P1' also aborts a running grandchild.
   8. forwarded ask: child calls ask_user; capturePresent receives an Intervention with `origin` deepEqual `{ rootKey:'workspace/P1', chatId, chatKey:'workspace/'+chatId, depth:1 }`; `asks.resolve(id, {kind:'text', text:'blue'})`; the child's tool result carries the answer and the child transcript contains a record with role 'system', `forwarded: true`, `intervention.status === 'resolved'`, `intervention.answer` = the text answer; `toHistory(readTranscript(...))` keeps the tool result paired (the tool message for the ask_user call is present). A top-level ask through the same wrapped seam (outside any turn) has no `origin` key.
   9. stop declines pending forwarded asks: child blocks in ask_user; `stopDescendants` → `asks.size === 0`, spawn resolves refused/stopped, and the note records a declined answer.
   10. interventions origin: `new PendingAskRegistry(...).create(req)` has no `origin` property (`'origin' in i === false`); `create(req, origin)` carries it.

   Files: `test/subAgent.test.ts`

8. Verify

   Run `npm run compile`, `npm run lint`, `npm test`. Run `grep -n "vscode" src/orchestrator/subAgent.ts` (expect no import). Confirm existing interventions/chatController/toolLoop tests still pass unchanged (the optional `origin` must not change created interventions when absent).

   Files: (none)

## Risks

- Circular construction: the registry is built from ToolServices that must contain the runner (subAgents seam) and the runner's wrapped intervention seam, while the runner needs the registry — hence `tools()` is a lazy getter. Wiring in commands.ts/chatController is a later todo; until then nothing in the host uses the runner.
- AsyncLocalStorage attribution only works if the ask happens in the async continuation of the sub-agent's runToolLoop. Anything that schedules the ask from a detached context (e.g. a queued callback created outside the turn) would lose the origin and look like a top-level ask. ask_user calls the seam directly, so it is fine.
- Appending a plain `system` record in the middle of a tool round would break toHistory's tool-call pairing; the child-side note is therefore an intervention-shaped record (`forwarded: true`). The later webview todo should render it as a read-only settled card.
- subAgent.ts imports `subAgentDepthRefusal` from controlTools.ts and a type from registry.ts; keep the registry import type-only to avoid a runtime import cycle through index.ts.
- Abort listeners added to a long-lived parent signal must be removed in `finally`, or repeated follow-ups leak listeners (Node warns past 10).
- Possible export-name collisions in the orchestrator barrel (e.g. a helper like `chatSessionKey`); compile catches TS2308 — rename if hit.
- Duplicating chatController's `toInterventionView` as `interventionViewOf` creates two copies until the controller is switched over in its own todo.

## Acceptance

- src/orchestrator/subAgent.ts exists, has no `vscode` import, and exports SubAgentRunner (implements SubAgentSeam), createSubAgentRunner, SubAgentRunnerDeps, SubAgentToolSurface, SubAgentEvent, SubAgentInfo and the session-key helpers; src/orchestrator/index.ts re-exports it.
- spawn creates the child via SessionStore.createChild, runs runToolLoop over the child's own history/transcript with the 'subagent' surface, the caller's phase, buildSubAgentPrompt(kind, phase, depth, spec?) and caller depth+1, and resolves with the final assistant text and the child chat id.
- send re-enters the same child's loop (rehydrating from disk when not live), refuses an unknown chat, a chat not owned by the caller, and a chat whose turn is still running.
- A spawn from a depth-2 caller is refused with subAgentDepthRefusal (mentions MAX_SUBAGENT_DEPTH = 2) and writes nothing.
- Each turn's AbortSignal is chained to the caller's signal; stopDescendants(parentKey) aborts every running descendant (grandchildren included) and declines their pending forwarded asks.
- Intervention has optional `origin`; PendingAskRegistry.create and InterventionSeam.ask accept an optional origin; runner.interventionSeam(base) stamps { rootKey, chatId, chatKey, depth } on asks raised inside a sub-agent turn and appends a `forwarded: true` settled intervention note to the child transcript; asks outside a sub-agent are unchanged (no origin key).
- Runner emits started, delta, appended and finished events carrying chatId, key and rootKey.
- test/subAgent.test.ts covers spawn, follow-up, depth-2 refusal (direct and nested), concurrent sub-agents overlapping, stop (direct, chained via parent signal, nested), and forwarded ask origin/notes, using a fake model client and a fake tool surface.
- `npm run compile`, `npm run lint` (0 errors) and `npm test` are green.
