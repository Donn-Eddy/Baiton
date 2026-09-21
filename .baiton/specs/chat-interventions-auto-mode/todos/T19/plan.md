# Plan T19

## Steps

1. Add the run-context type and the run directory to the risk prompt (autoMode core)

   In `src/orchestrator/autoMode.ts`:

   1. Add a type-only import of the role type: `import type { Role } from '../model/role';` (keeps the module host-free — `roleProfile` already uses the same type).
   2. Export a new interface near `AutoModeAsk`:
   ```ts
   /**
    * The launched run a relayed harness ask came from. It is host-supplied and
    * trusted (the queue's adapter id, the run's role and its run id), unlike the
    * `agent` field inside the ask file, which is written by the sub-agent. The
    * caller keys the allow-list on this context; an ask whose own `agent` does
    * not match `context.agent` is escalated by `allowListDecision`'s first check.
    */
   export interface AutoModeRunContext {
     /** Adapter id the run launched with (`adapter.id`), e.g. `'claude'`. */
     agent: string;
     /** The role the run is executing (`planner` | `executor` | `reviewer` | …). */
     role: Role;
     /** The run id whose `.baiton/runs/<run-id>/` directory is the agent's own. */
     runId: string;
   }
   ```
   3. Extend `EvaluateOptions` with an optional `runId?: string` documented as "The originating run id; shown to the evaluator so it can tell the agent's own run directory from everything else."
   4. In `buildEvaluationMessages`, insert one line into the `user` array directly after the `Role: …` line, only when `options.runId` is defined, so the builder stays deterministic and the existing evaluator assertions (which use `includes`) keep passing:
   ```ts
   ...(options.runId !== undefined
     ? [`The agent's own run directory: .baiton/runs/${options.runId}/`]
     : []),
   ```
      (Build the array with a spread rather than a push so the function stays a single pure expression list.)
   5. `decideAsk` needs no change beyond documentation: it already spreads `options` into `evaluateAsk`, so `runId` flows through. Update its doc comment to say the caller passes the run context (allow-list built for `context.agent`/`context.role`/`context.runId`, `runId` also forwarded to stage (b)).

   Files: `src/orchestrator/autoMode.ts`

2. Carry the run's role to the ask-watcher factory

   In `src/engine/runQueue.ts`:

   1. `AskWatcherFactory.create`'s input object gains a required field, next to `agent`:
   ```ts
   /** The role the run is executing; keys the Auto-mode allow-list for its asks. */
   role: Role;
   ```
      (`Role` is already imported in this file — it is used by `modelForRole`/`adapterForRole`.)
   2. At the single construction site (`this.deps.askWatcherFactory.create({ slug: req.slug, todoId: req.todoId, runId, agent: adapter.id, asksDir: relay.dir })`, ~line 740), add `role: req.role,`.

   No other runQueue behaviour changes; the watcher is still created inside the existing try/catch so a host failure cannot stop a launched run.

   Files: `src/engine/runQueue.ts`

3. Pass the run context with every relayed ask (vscode ask watcher)

   In `src/activation/vscodeAskWatcher.ts`:

   1. Import the new type: add `AutoModeRunContext` to the existing `import type { Intervention, InterventionAnswer } from '../orchestrator';` line, and add `import type { Role } from '../model/role';` (or import `Role` from wherever `src/model` is re-exported by this folder's neighbours — match `commands.ts`).
   2. `interface AskWatcherInput` gains `role: Role;` after `agent`.
   3. Widen the route seam:
   ```ts
   present(ask: Intervention, context: AutoModeRunContext): void | Promise<void>;
   ```
      with a doc line saying the context is the run's trusted identity and is what the Auto-mode gate keys its allow-list on.
   4. In the class, compute the context once in the constructor and reuse it:
   ```ts
   private readonly context: AutoModeRunContext;
   …
   this.context = { agent: input.agent, role: input.role, runId: input.runId };
   ```
   5. In `onAsk`, call `await this.route.present(card, this.context);` (the surrounding try/catch that rejects the registry entry on a throw is unchanged).

   Deliberately do NOT overwrite the card's `agent` with `input.agent`: the card keeps what the ask file said, and a disagreement between the two is what makes `allowListDecision` escalate (its first check compares `ask.agent` with `allowList.agent`).

   Files: `src/activation/vscodeAskWatcher.ts`

4. Thread the context through the controller into the Auto-mode gate

   In `src/activation/chatController.ts`:

   1. Add `AutoModeRunContext` to the `import type { … } from '../orchestrator'` block.
   2. Widen the gate type:
   ```ts
   export type AutoModeGate = (
     ask: PermissionRequest,
     opts: { signal?: AbortSignal; context?: AutoModeRunContext },
   ) => Promise<AutoModeOutcome>;
   ```
      Document that `context` is present exactly for relayed harness asks (the run's agent, role and run id) and absent for an orchestrator-raised permission ask, in which case the host falls back to its most restrictive profile.
   3. `presentIntervention` gains an optional second parameter and forwards it:
   ```ts
   public async presentIntervention(ask: Intervention, context?: AutoModeRunContext): Promise<void> {
     …
     const outcome = await this.autoDecision(ask, context);
   ```
      Extend its doc comment: a relayed ask carries its run context, so the deterministic stage is evaluated against the launching run's own agent/role/run directory rather than a fallback profile.
   4. `autoDecision(ask: Intervention, context?: AutoModeRunContext)` passes it on: `return await this.deps.autoGate(ask, { signal: this.abort?.signal, context });`. The existing throw→escalate path, the `ask.kind !== 'permission'` guard and the `!this.autoMode` guard are unchanged.
   5. Nothing else changes: `autoApprove`, `settleCard`, `interventionTranscriptRecord` and `escalatedInterventionView` already produce the audit records and escalation cards; this todo only makes the decision behind them correctly keyed.

   Files: `src/activation/chatController.ts`

5. Wire the real allow-list per run in commands.ts

   In `src/activation/commands.ts`:

   1. Replace the doc comments on `AUTO_MODE_FALLBACK_ROLE` / `AUTO_MODE_UNKNOWN_RUN` (~lines 143–153): they are no longer "until the relay carries the role" placeholders but the fallback used only when an ask arrives with no run context (an orchestrator-raised permission ask). Keep the values (`'planner'`, `'unknown-run'`) and the reasoning that `planner` is the most restrictive profile and `unknown-run` matches no run directory.
   2. Rewrite the gate (~line 480) to key on the context:
   ```ts
   const autoGate: AutoModeGate = (ask, opts) => {
     const agent = opts.context?.agent ?? ask.agent;
     const role = opts.context?.role ?? AUTO_MODE_FALLBACK_ROLE;
     const runId = opts.context?.runId ?? AUTO_MODE_UNKNOWN_RUN;
     return decideAsk(
       askFromPermission(ask),
       agentAllowList(agent, role, runId),
       modelClient,
       { role, runId, signal: opts.signal },
     );
   };
   ```
      (`agentAllowList`'s fourth `mode` argument stays defaulted — permission mode is out of this todo's scope.)
   3. Add a second mutable relay binding beside `presentAsk` (~line 212), so the modal still stands in before the Chat_View resolves:
   ```ts
   let presentRelayAsk: (ask: Intervention, context: AutoModeRunContext) => void | Promise<void> =
     (ask) => presentAsk(ask);
   ```
      and change the factory's seam to `present: (ask, context) => presentRelayAsk(ask, context),`.
   4. After the controller is constructed (~line 538), bind it alongside the existing assignment:
   ```ts
   presentAsk = (ask) => chatController.presentIntervention(ask);
   presentRelayAsk = (ask, context) => chatController.presentIntervention(ask, context);
   ```
   5. Add `AutoModeRunContext` to the type imports from `../orchestrator`.

   Files: `src/activation/commands.ts`

6. Extend the controller Auto-mode tests

   In `test/chatController.autoMode.test.ts`:

   1. Change the gate fake to record the opts too:
   ```ts
   let gateCalls: Array<{ ask: PermissionRequest; context?: AutoModeRunContext }> = [];
   …
   const autoGate: AutoModeGate = async (ask, opts) => {
     gateCalls.push({ ask, context: opts.context });
     …
   };
   ```
      Update the existing `gateCalls.length` assertions (cases 3, 7, 8) — they only read `.length`, so they keep working; any place that reads a recorded ask must now read `gateCalls[i].ask`.
   2. Add a helper that presents a relayed ask directly, the way the watcher does, without going through the tool loop:
   ```ts
   const RUN_CONTEXT: AutoModeRunContext = { agent: 'claude', role: 'executor', runId: 'run-a' };
   async function presentRelayed(ask: PermissionRequest = PERMISSION_ASK): Promise<void> {
     const { intervention } = askRegistry.create(ask);
     await controller.presentIntervention({ ...intervention }, RUN_CONTEXT);
   }
   ```
      (Turn Auto mode on with `await webview.send({ type: 'setAutoMode', enabled: true })` after `controller.start()` first.)
   3. New cases to add (keeping the file's numbered header comment in sync):
      - **11. A relayed ask reaches the gate with its run context** — after `presentRelayed()`, assert `gateCalls.length === 1` and `deepStrictEqual(gateCalls[0].context, RUN_CONTEXT)`, and that `gateCalls[0].ask.tool === 'Read'`.
      - **12. An orchestrator-raised ask reaches the gate with no context** — drive the ordinary `startSendWithAutoOn()` path and assert `gateCalls[0].context === undefined`, proving the host falls back to its restrictive profile.
      - **13. A relayed allow-list approval is audited** — `gateResult = { kind: 'approve', stage: 'allow-list', rationale: 'claude/executor may write inside its run dir' }`; after `presentRelayed()` assert exactly one `showIntervention` with `status === 'resolved'`, `auto === true`, a rationale containing `'Auto mode (allow-list)'`, zero `resolveIntervention` posts, `askRegistry.size === 0`, and exactly one persisted intervention record whose `status` is `'resolved'` and `auto` is `true`.
      - **14. A relayed escalation posts a pending card and is audited** — `gateResult = { kind: 'escalate', what, why }`; after `presentRelayed()` assert the posted card is `pending`, carries `escalation.what`/`escalation.why`, its `detail` contains both `What you are approving:` and `Why it was flagged:` lines, and one `pending` intervention record exists; then answer it with `{ kind: 'declined', reason: 'no' }` through `answerIntervention` and assert a second, `resolved` record and that `toRenderRecords(await readTranscript(transcriptFile()))` collapses the pair into one settled card.
      Note: the relayed-ask cases do not run the tool loop, so use `waitFor` on the posted messages / record counts rather than `awaitRunEnd()`. `transcriptFile()`/`interventionRecords()` work unchanged because a relayed ask with no `scopeId` lands on the workspace conversation; pass no `scopeId` on `PERMISSION_ASK` to keep it there.

   Files: `test/chatController.autoMode.test.ts`

7. Keep the neighbouring suites compiling and cover the new plumbing

   1. `test/askWatcher.routing.test.ts`: the factory input now requires `role`, so add `role: 'executor'` to the `create({ slug: 'spec-a', todoId: 'T17', runId: 'run-a', agent: 'claude', asksDir })` call in `make()`. Record the context the route receives — change `present: (card) => { cards.push(card); }` to `present: (card, context) => { cards.push(card); contexts.push(context); }` with a `contexts` array reset in `beforeEach` — and add one case asserting `deepStrictEqual(contexts[0], { agent: 'claude', role: 'executor', runId: 'run-a' })` for a routed ask.
   2. `test/autoMode.evaluator.test.ts`: add one case asserting `buildEvaluationMessages(ASK, { role: 'executor', runId: 'run-a' })[1].content` includes `.baiton/runs/run-a/`, and one asserting the line is absent when `runId` is omitted (so the builder stays deterministic for callers without a run).
   3. Check any other implementer of `AskWatcherFactory` or `AskRoute` in `test/` (`grep -rn "askWatcherFactory\|AskRoute" test/`) and add the `role`/second `present` parameter where the compiler asks for it.
   4. Verify: `npm run compile`, `npm run lint`, then `npx mocha --no-config --require ts-node/register test/chatController.autoMode.test.ts test/askWatcher.routing.test.ts test/autoMode.evaluator.test.ts test/autoMode.allowList.test.ts test/engine.launcher.test.ts test/chatController.interventions.test.ts`, then the full `npm test` (baseline 1053 passing / 1 pending before the new cases).

   Files: `test/askWatcher.routing.test.ts`, `test/autoMode.evaluator.test.ts`

## Risks

- `AskWatcherFactory.create` gaining a required `role` field is a breaking type change for every fake in the test suite; the compile step will name them, but missing one only shows up at `npm run compile`, not at runtime.
- The run context is trusted host data while the relayed ask file's `agent` field is written by the sub-agent. Keying the allow-list on `context.agent` while leaving the card's `agent` as the file supplied it means a mismatched ask escalates rather than approving — that is the intended conservative outcome, but it must not be 'fixed' by overwriting the card's agent with the context's.
- A wrong role would now widen rather than narrow the deterministic gate (an `executor` allow-list permits writes inside `.baiton/runs/<run-id>/` that the old `planner` fallback never cleared). The run id must come from the same launch as the role, or a write rule could match another run's directory; both come from the single `create()` call site in `runQueue.ts`, so they cannot drift apart.
- Adding a line to `buildEvaluationMessages` changes the evaluator prompt text; existing assertions use `includes` so they pass, but any future snapshot-style assertion on the whole user message would need updating.
- `presentIntervention` gaining an optional parameter is source-compatible with the existing seam binding, so an orchestrator-raised permission ask silently keeps the fallback profile. If that path ever needs the real context it must be threaded separately — it is deliberately out of scope here.
- The new relayed-ask tests bypass the tool loop, so `awaitRunEnd()` does not apply; polling on posted messages/record counts is required or the suite will hang on the 5s `waitFor` deadline.

## Acceptance

- A relayed harness ask routed by `VscodeAskWatcher` reaches `ChatController.presentIntervention` with an `AutoModeRunContext` of `{ agent: <adapter id>, role: <the run's role>, runId: <the run id> }`, and the controller forwards it to the Auto-mode gate as `opts.context`.
- With Auto mode on, the gate in `commands.ts` builds its allow-list with `agentAllowList(context.agent, context.role, context.runId)` and passes the same `role` and `runId` into `decideAsk`'s options; with no context it falls back to `AUTO_MODE_FALLBACK_ROLE` / `AUTO_MODE_UNKNOWN_RUN`.
- The stage-(b) evaluation prompt names the run's own directory (`.baiton/runs/<run-id>/`) when a run id is supplied, and is byte-identical to today's prompt when it is not.
- A relayed ask the allow-list (or the model stage) approves settles with no pending card: exactly one `showIntervention` post, already `resolved` with `auto: true` and a rationale naming the deciding stage, zero `resolveIntervention` posts, the registry entry gone, and exactly one persisted intervention record carrying the same resolved state.
- A relayed ask that escalates posts one pending card carrying `escalation.what`/`escalation.why` and the two labelled `detail` lines, writes a `pending` audit record at escalation time, and — once answered — writes a second `resolved` record that `toRenderRecords` collapses with the first into one settled card.
- Auto mode still gates only `permission` asks presented while the toggle is on; confirms and questions, and cards already pending when the toggle flips, are untouched, and a gate that throws still escalates.
- `npm run compile` and `npm run lint` are clean, and `npm test` passes with no pre-existing test removed (baseline 1053 passing / 1 pending, plus the new cases).
