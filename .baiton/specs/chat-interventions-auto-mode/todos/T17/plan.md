# Plan T17

## Steps

1. Add the ask-watcher seam to the run queue and enable the relay per launch

   In `src/engine/runQueue.ts`:

   1. Export a new seam next to `ResultWatcherFactory` (which sits just above `QueueReporter`):
   ```ts
   /** A live watcher over one launched run's `asks/` directory. */
   export interface AskWatcher {
     /** Tear down the directory watch and settle anything still pending. Idempotent. */
     dispose(): void;
   }

   /** Constructs an {@link AskWatcher} for one launched run's relayed harness asks. */
   export interface AskWatcherFactory {
     create(input: {
       slug: string;
       todoId: string;
       runId: string;
       /** The adapter id the run launched with (`adapter.id`), for the card's agent line. */
       agent: string;
       /** Absolute path of `.baiton/runs/<run-id>/asks/`, from the launch's relay descriptor. */
       asksDir: string;
     }): AskWatcher;
   }
   ```
   2. Add `askWatcherFactory?: AskWatcherFactory;` to `RunQueueDeps`, documented as: when wired, every launched stage relays its harness asks through `.baiton/runs/<run-id>/asks/` and the host routes them into the chat; when absent the launch is byte-identical to today's (no `asks/` dir, no adapter relay flags).
   3. In `launchAndComplete`, set `relayAsks: this.deps.askWatcherFactory !== undefined` on the `LaunchStageInput` object literal (add it as a plain field, NOT a conditional spread, but only when the factory exists — i.e. `...(this.deps.askWatcherFactory !== undefined ? { relayAsks: true } : {})` so an unwired queue produces the exact same input object as today and `test/engine.launcher.test.ts`'s byte-identity pins keep holding).
   4. Destructure the relay out of the launch result: `const { terminal, resultPath, relay } = launched.value;`.
   5. Right after the existing `this.running = {...}` assignment (step 5 of the method), create the ask watcher:
   ```ts
   const askWatcher =
     this.deps.askWatcherFactory !== undefined && relay !== undefined
       ? this.deps.askWatcherFactory.create({
           slug: req.slug,
           todoId: req.todoId,
           runId,
           agent: adapter.id,
           asksDir: relay.dir,
         })
       : undefined;
   ```
      Wrap the `create` call in a try/catch that reports nothing and leaves `askWatcher` undefined on a throw — a watcher failure must never abort a launched run (report through `this.report` is NOT appropriate here; simply swallow, the host watcher logs its own failures).
   6. Dispose it in the existing `finally` block around `awaitStageResult`, beside `this.running = undefined;`: `askWatcher?.dispose();`. This is the single disposal point and covers every outcome kind (completed, closed, cancelled, invalid_output) and the `stop()` path, because `stop()` disposes the terminal which resolves `awaitStageResult`.
   7. Extend the module JSDoc's numbered lifecycle list to mention the ask watcher created at launch and disposed when the run settles.

   Files: `src/engine/runQueue.ts`

2. Write the vscode-backed ask watcher

   New file `src/activation/vscodeAskWatcher.ts`, modelled on `src/activation/vscodeResultWatcher.ts` (same JSDoc voice, same `vscode.RelativePattern(vscode.Uri.file(dir), '<glob>')` rationale about symlinked workspace roots — copy that comment's substance, it applies verbatim here).

   Imports: `* as vscode`, `readFileSync` from `fs`, and from `../engine`: `askIdFromFileName`, `askFilePath`, `listPendingAskIds`, `parseAsk`, `responseFromAnswer`, `writeResponse`, `describeAskRelayError`, `nodeAskRelayIo`, types `RelayAsk`, `AskRelayIo`, `AskWatcher`, `AskWatcherFactory`; and from `../orchestrator`: `toInterventionView` is NOT needed here, but `PendingAskRegistry`, types `Intervention`, `InterventionAnswer`, `InterventionRequest` are (plus `toInterventionRequest` from `../engine`).

   Exports:
   ```ts
   /** The reason a still-pending relayed ask is declined with when its run settles. */
   export const RUN_SETTLED_DECLINE_REASON = 'the run ended before this ask was answered';

   /** The seams the ask watcher routes through; all host-free so the routing is unit-testable. */
   export interface AskRoute {
     /** The shared pending-ask registry every inline card settles through. */
     registry: PendingAskRegistry;
     /** Raise one ask as a card (ChatController.presentIntervention). */
     present(ask: Intervention): void | Promise<void>;
     /** Settle a still-pending ask as declined, in the registry and in the view. */
     decline(id: string, reason: string): void | Promise<void>;
     /** Records a contained failure (unparseable ask, unwritable response). */
     log(message: string): void;
     /** ISO-8601 stamp for a written response; defaults to `new Date().toISOString()`. */
     now?(): string;
     /** Filesystem seam for reading asks and writing responses; defaults to `nodeAskRelayIo`. */
     io?: AskRelayIo;
   }

   export function createVscodeAskWatcherFactory(route: AskRoute): AskWatcherFactory;
   ```

   Internal `class VscodeAskWatcher implements AskWatcher` constructed with `(input: {slug; todoId; runId; agent; asksDir}, route: AskRoute)`:
   - fields: `private readonly fileWatcher: vscode.FileSystemWatcher`, `private readonly seen = new Set<string>()` (ask ids already routed), `private readonly inFlight = new Map<string, RelayAsk>()` (registry ask id -> the relay ask it answers), `private disposed = false`.
   - constructor: build `new vscode.RelativePattern(vscode.Uri.file(input.asksDir), '*.json')`, `vscode.workspace.createFileSystemWatcher(pattern)`, subscribe `onDidCreate` and `onDidChange` to `(uri) => void this.onFile(path.basename(uri.fsPath))`. Then do the catch-up scan for asks written before the watch attached: `for (const id of listPendingAskIds(input.asksDir, this.io)) { void this.onAsk(id); }` (wrapped in try/catch; `listPendingAskIds` already swallows ENOENT).
   - `private onFile(fileName: string)`: `const askId = askIdFromFileName(fileName); if (askId === undefined) return;` — this is what keeps `<id>.response.json` and `<id>.response.json.tmp` from being read back as asks. Then `this.onAsk(askId)`.
   - `private async onAsk(askId: string)`: return early when `this.disposed` or `this.seen.has(askId)`; add to `seen` BEFORE any await so duplicate create/change events raise exactly one card. Read the file with `this.io.readFile(askFilePath(this.asksDir, askId))` in try/catch (a create event can race the write — on a read failure remove the id from `seen` and return, so the next event retries). `parseAsk(raw)`; on `!result.ok` log `Baiton ask relay: ignoring ${fileName}: ${describeAskRelayError(result.error)}` and return, leaving the file alone (never write a response for an unparseable ask). Reject a mismatch: `if (ask.runId !== this.input.runId) { log(...); return; }` and `if (ask.id !== askId) { log(...); return; }` (the file name is the authority).
   - Raise the card through the registry directly (not through `createInterventionSeam`, because the watcher needs the ask id to decline on dispose):
   ```ts
   const { intervention, answer } = route.registry.create(toInterventionRequest(ask));
   const card: Intervention = { ...intervention, scopeId: this.input.slug };
   this.inFlight.set(intervention.id, ask);
   try {
     await route.present(card);
   } catch (err) {
     route.registry.reject(intervention.id, `the ask could not be shown: ${describe(err)}`);
   }
   const given = await answer;
   this.inFlight.delete(intervention.id);
   this.respond(ask, given);
   ```
     `scopeId: this.input.slug` is what routes the card onto the run's spec conversation (step 3).
   - `private respond(ask: RelayAsk, answer: InterventionAnswer)`: `writeResponse(this.asksDir, responseFromAnswer(ask, answer, this.now()), this.io)` inside try/catch; log on failure. Write the response even when disposed — a late `deny` is harmless and a lost one would hang a harness that is still reading.
   - `dispose()`: guard on `this.disposed`, set it, `this.fileWatcher.dispose()`, then for every `[id] of this.inFlight` call `void route.decline(id, RUN_SETTLED_DECLINE_REASON)` (iterate a copied array of keys; `decline` settles the registry entry, which resolves the `await answer` above, which writes the deny response and clears `inFlight`).
   - a local `function describe(err: unknown): string` helper, same as chatController's.

   `createVscodeAskWatcherFactory(route)` returns `{ create: (input) => new VscodeAskWatcher(input, route) }`.

   Files: `src/activation/vscodeAskWatcher.ts`

3. Route scoped cards onto the run's spec conversation in ChatController

   In `src/activation/chatController.ts`:

   1. `presentIntervention(ask: Intervention)` currently opens with `const scope = this.activeScope();`. Replace that with a scope derived from the ask:
   ```ts
   const scope = await this.scopeForAsk(ask);
   ```
   and add:
   ```ts
   /**
    * The conversation an ask belongs on. An ask carrying a `scopeId` (today the
    * relayed harness asks of a launched run) is shown on that spec's
    * conversation, switching the view to it when it is not the one in view, so a
    * run paused on a permission ask is never waiting behind a conversation the
    * user cannot see. An ask with no scope stays on the conversation in view.
    */
   private async scopeForAsk(ask: Intervention): Promise<SessionScope> {
     const slug = ask.scopeId;
     if (slug === undefined || slug === this.activeSpec) {
       return this.activeScope();
     }
     this.activeSpec = slug;
     await this.refresh();
     return this.activeScope();
   }
   ```
   (`refresh()` is already `private async` and re-renders the persisted transcript; posting the card after it returns keeps the card last in the view.)
   2. Add `scopeKey: string` to the `PendingCard` interface at the bottom of the file and set it (`scopeKey: key`) where `this.cards.set(ask.id, { view: card, transcript })` is built in `presentIntervention`.
   3. Re-post still-pending cards after a re-render so switching conversations (or a spec switch forced by step 1) does not lose a pending card and strand a paused run. At the end of `refresh()` — after the `renderConversation(...)` calls — add:
   ```ts
   this.repostPendingCards(scopeId(scope));
   ```
   and:
   ```ts
   /** Re-post the pending cards belonging to the rendered conversation. */
   private repostPendingCards(key: string): void {
     for (const card of this.cards.values()) {
       if (card.scopeKey === key) {
         this.deps.webview.post({ type: 'showIntervention', intervention: card.view });
       }
     }
   }
   ```
      `refresh()` has two return paths (the empty-state early return and the normal one); call it on both.
   4. Expose the decline the ask watcher needs on dispose, and make the stop path use it:
   ```ts
   /**
    * Decline one still-pending ask, settling its card in the view and the
    * transcript. Used by the host when the flow behind an ask ends without an
    * answer (a launched run settling while its permission card is up).
    */
   public async declineAsk(id: string, reason: string): Promise<void> {
     const answer: InterventionAnswer = { kind: 'declined', reason };
     if (this.asks.resolve(id, answer).kind === 'resolved') {
       await this.settleCard(id, answer, { rationale: reason });
     }
   }
   ```
      Rewrite the loop body of `declinePendingAsks` to `await this.declineAsk(ask.id, reason);` and keep the `this.asks.rejectAll(reason)` safety net.
   5. Import `SessionScope` if it is not already imported (it is used by `activeScope`; confirm the import list).

   Do NOT change the Auto-mode path: a relayed `permission` ask flows through the existing `autoDecision`/`autoApprove` branch unchanged, so Auto mode gates relayed harness asks for free.

   Files: `src/activation/chatController.ts`

4. Wire the factory in commands.ts

   In `src/activation/commands.ts`:

   1. Import `createVscodeAskWatcherFactory` from `./vscodeAskWatcher`.
   2. The queue is built (`queueForSlug`, ~line 223) before `askRegistry` (~line 314) and before the `ChatController` (~line 474), so the factory must be built from late-bound holders exactly as `presentAsk` already is. Move nothing: instead, declare the holders above `queueForSlug`:
   ```ts
   // Relayed harness asks are routed into the chat as inline permission cards.
   // Both hooks are bound late (the registry and the controller are created
   // after the queues), exactly like `presentAsk`.
   let routeAsk: PresentIntervention = () => {};
   let declineAsk: (id: string, reason: string) => void = () => {};
   let askRegistryRef: PendingAskRegistry | undefined;
   ```
      ...then build the factory just above `queueForSlug` with a `registry` getter that reads `askRegistryRef`. If a getter is awkward against the `AskRoute.registry` field type, prefer the simpler alternative: construct `askRegistry` (the `new PendingAskRegistry({...})` block currently at ~line 314, with its `systemClock`) EARLIER — immediately after `const specsDir = ...` in the shared-seams block — and leave only `modalConfirm`/`presentAsk`/`interventionSeam` where they are. That removes the need for `askRegistryRef` entirely and is the preferred edit.
   3. Build the factory and pass it into `createRunQueue`:
   ```ts
   const askWatcherFactory = createVscodeAskWatcherFactory({
     registry: askRegistry,
     present: (ask) => presentAsk(ask),
     decline: (id, reason) => void declineAsk(id, reason),
     log: (message) => surface.log(message),
   });
   ```
      and add `askWatcherFactory,` to the `createRunQueue({...})` deps inside `queueForSlug`.
   4. After the `ChatController` is constructed, next to the existing `presentAsk = (ask) => chatController.presentIntervention(ask);`, add `declineAsk = (id, reason) => void chatController.declineAsk(id, reason);`.
   5. Leave the spec-draft runner (`createSpecDraftRunner`) alone: it launches outside the queue and gets no relay in this todo. Say so in a one-line comment beside `askWatcherFactory` so the omission reads as deliberate.

   Files: `src/activation/commands.ts`

5. engineFacade.ts: documentation only

   `src/activation/engineFacade.ts` needs NO functional change: it derives role/attempt/resume and dispatches a `RunRequest`; the relay is enabled by the queue's deps, not per request. Do not add relay plumbing here. Make one documentation edit only: extend the module JSDoc's closing paragraph with a sentence noting that harness ask relaying is a queue-level dependency (`RunQueueDeps.askWatcherFactory`) wired in `commands.ts`, so every trigger that reaches the queue — the `run` tool through `createRunQueueSeam` and the VS Code stage commands alike — relays its asks identically. If the compile/lint passes are clean with no other change in this file, that is the expected outcome.

   Files: `src/activation/engineFacade.ts`

6. Add test/askWatcher.routing.test.ts

   New host-free suite, run under mocha + ts-node like the rest. Because `vscodeAskWatcher.ts` imports `vscode`, use the `test/fixtures/vscodeLoader.mjs` pattern copied from `test/setApiKey.test.ts`: `register(pathToFileURL(join(process.cwd(), 'test/fixtures/vscodeLoader.mjs')))` in a `before()`, install a mutable fake on `globalThis.__vscodeFake`, then `await import('../src/activation/vscodeAskWatcher')` and keep the module handle in a module-level `let`.

   The fake's `workspace.createFileSystemWatcher(pattern)` records the pattern and returns a controllable object: `{ onDidCreate(cb), onDidChange(cb), onDidDelete(cb), dispose() }` storing the callbacks on the fake and flipping a `disposed` flag; also provide `Uri.file` (the default fake's is fine) and a `RelativePattern` capture. Expose a helper `emitCreate(fileName)` calling the stored `onDidCreate` with `{ fsPath: join(asksDir, fileName) }`.

   Use a real temp directory (`mkdtempSync(join(tmpdir(), 'baiton-asks-'))` + `mkdirSync(asksDir, {recursive:true})`) and real `fs` writes so `writeResponse`'s tmp+rename path is exercised; `rmSync(..., {recursive:true, force:true})` in `after`. Build asks with `serializeAsk` from `../src/engine`. Use a real `PendingAskRegistry` with a deterministic id generator, a `present` that records the `Intervention` it was handed and resolves, a `decline` bound to `registry.reject` plus a recorder, a `log` collector, and `now: () => '2026-01-01T00:00:00.000Z'`.

   Cases (each polls with a small `waitFor(predicate)` helper, as `test/chatController.interventions.test.ts` does, because routing is fire-and-forget):
   1. Ask files already on disk when the watcher is created are routed (catch-up scan via `listPendingAskIds`).
   2. An `onDidCreate` event for a new `<id>.json` raises exactly one `permission` card whose `prompt`/`agent`/`tool`/`args`/`detail` come from the file, and whose `scopeId` equals the run's slug.
   3. Answering `{kind:'approved'}` through `registry.resolve` writes `<id>.response.json`; `parseResponse` of its contents yields `{version:1, id, decision:'approve', respondedAt:'2026-01-01T00:00:00.000Z'}`.
   4. Answering `{kind:'declined', reason:'no'}` writes `decision:'deny'` with `reason:'no'`.
   5. A `kind:'question'` ask with options raises a `question` card; an `{kind:'option', optionId:'b'}` answer writes `decision:'approve', answer:'b'`.
   6. An `onDidCreate` for `<id>.response.json` (and for `<id>.response.json.tmp`) raises no card — the watcher never answers its own responses.
   7. Two events for the same ask id raise exactly one card and write exactly one response.
   8. A malformed-JSON ask and a schema-invalid ask (e.g. missing `tool` on a permission) raise no card, write no response file, leave the ask file on disk, and log a message containing the ask file name.
   9. An ask whose `runId` names a different run is ignored (no card, no response).
   10. `dispose()` disposes the underlying vscode watcher, declines every still-pending routed ask with `RUN_SETTLED_DECLINE_REASON` (a `deny` response carrying that reason lands on disk), and makes subsequent events no-ops.

   Add two `RunQueue` integration cases in the same file, using the rig from `test/runQueue.briefContext.test.ts` (copy the `FakeTerminal`/`TerminalHost`/`ResultWatcherFactory`/`Adapter`/`GitService`/`SpecStore`/`RunQueueDeps` scaffolding into this file as that suite's siblings already do — do not export it from the other test):
   11. With an `askWatcherFactory` wired, dispatching a stage calls `create` exactly once with `{slug, todoId, runId, agent:'claude', asksDir}` where `asksDir` ends in `.baiton/runs/<runId>/asks`, and `dispose()` is called once the dispatch resolves.
   12. With no `askWatcherFactory`, the adapter's `launch` receives a `LaunchRequest` whose `relay` is `undefined` and no `asks/` directory is created.

   Files: `test/askWatcher.routing.test.ts`

## Risks

- Conversation switching: `presentIntervention` currently always targets the conversation in view. Forcing a spec switch when a relayed ask arrives (step 3) is deliberate — a paused run must be answerable — but it moves the user's view mid-typing. Keep the switch to the `scopeId !== activeSpec` case only, and do not touch the no-scope path used by `approve_spec`/`draft_spec`.
- A pending relayed card is only persisted to the transcript when Auto mode escalated it; a plain pending card lives in memory. The `repostPendingCards` step covers re-render within the window, but a window reload still drops the card while the run stays paused. That is pre-existing behaviour for every intervention (the run is recoverable through Stop); do not widen the todo to persist pending cards.
- `vscodeAskWatcher.ts` imports `vscode`, so the routing test must load it through `test/fixtures/vscodeLoader.mjs`. Adding the import to any module that today loads host-free (chatController in particular) would break `test/chatController.autoMode.test.ts`'s host-free pin — keep the vscode import confined to the new file.
- The Auto-mode gate still evaluates relayed asks against `AUTO_MODE_FALLBACK_ROLE`/`AUTO_MODE_UNKNOWN_RUN` in `commands.ts`, because `PermissionRequest` carries no run id or role. Plumbing the run's real role/runId through to the allow-list would touch `src/orchestrator/interventions.ts` and `autoMode.ts`, which are outside this todo's file list — leave the constants as they are and do not loosen them.
- Turning the relay on for every launched run changes real CLI argv (claude gains `--settings <hook JSON>`; see `claudeRelayFlags`). `test/adapter.launch.property.test.ts` and the per-adapter suites pin the no-relay argv, so the `relayAsks` flag must stay strictly conditional on `askWatcherFactory` being wired, and the launcher's byte-identity pins in `test/engine.launcher.test.ts` must stay green.
- Races: a create event can fire before the hook's write is complete. The watcher must remove the ask id from `seen` when the read throws so a later change event retries, otherwise a real ask is silently dropped and the harness hangs.
- The spec-draft runner launches outside the queue and gets no relay in this todo; a draft run's harness asks keep using the adapter's own permission configuration. State this in a comment rather than half-wiring it.

## Acceptance

- `npm run compile` is clean.
- `npm run lint` is clean.
- `npx mocha --no-config test/askWatcher.routing.test.ts --require ts-node/register` passes with every case above.
- `npm test` passes with no new failing or pending test; the total equals the previous baseline plus the new cases, and `test/engine.launcher.test.ts`, `test/adapter.launch.property.test.ts`, `test/adapter.claude.test.ts`, `test/chatController.interventions.test.ts` and `test/chatController.autoMode.test.ts` are all still green.
- A queue built without `askWatcherFactory` produces an identical `LaunchStageInput` (no `relayAsks` key) and an identical `LaunchRequest` (no `relay`) to today's, proven by a test assertion rather than by inspection.
- With the factory wired, a dispatched stage creates exactly one ask watcher over `.baiton/runs/<run-id>/asks/` and disposes it exactly once when the run settles — for a completed, a closed and a stopped run alike.
- A valid ask file becomes exactly one inline card carrying the ask's agent/tool/args/detail and scoped to the run's spec conversation; answering it writes a schema-valid `<ask-id>.response.json` that `parseResponse` accepts, and never re-raises the ask.
- Response files, `.tmp` siblings, malformed asks, schema-invalid asks and asks for another run never raise a card and never produce a response file; each rejection is logged with the file name.
- Disposing the watcher declines every still-pending routed ask, settles its card in the view, and writes a `deny` response, so no conversation is left showing a card whose run has ended.
- `git status --short` shows only the six files named in this plan as changed or added.
