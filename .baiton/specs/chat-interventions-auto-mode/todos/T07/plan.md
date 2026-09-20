# Plan T07

## Steps

1. ToolServices: document `confirm` as the intervention adapter and add the optional `intervention` seam

   In `src/orchestrator/toolServices.ts`:

   1. Add `import type { InterventionSeam } from './interventions';` next to the existing `./seams` import (no runtime import, so the existing import graph is unchanged and there is no cycle: `interventions.ts` already imports from `seams.ts`).
   2. Add a new optional field to `ToolServices`, after `confirm`:
   ```ts
     /**
      * The human-in-the-loop seam every richer ask goes through (question /
      * confirm / permission). Optional so a host that has not wired the chat
      * still builds a registry; `confirm` above is the narrow yes/no adapter
      * over this seam (`confirmSeamFrom`), so a host that supplies only
      * `confirm` keeps working unchanged.
      */
     intervention?: InterventionSeam;
   ```
   3. Update the bullet in the `ToolServices` doc comment for `confirm` to read: "`confirm`   — the yes/no confirmation seam `approve_spec`, `draft_spec` and `submit_pr` gate on (Req 10.1); in the real host it is `confirmSeamFrom(interventionSeam)`, so those confirmations surface as inline chat cards."

   Do not change any tool in `controlTools.ts`: they keep calling `services.confirm.confirm(...)` and now get a card instead of a modal purely through the wiring change in step 3.

   Files: `src/orchestrator/toolServices.ts`

2. ChatController: own the pending-ask registry, present cards, and drop the duplicate approve modal

   All edits in `src/activation/chatController.ts`.

   **Imports.** Add to the value import from `../orchestrator`: `PendingAskRegistry`, `interventionRecord` is NOT needed (the controller posts `showIntervention` directly), `interventionUpdate`, `interventionTranscriptRecord`, `settledInterventionView`. Add to the type-only import from `../orchestrator`: `Intervention`, `InterventionAnswer`, `InterventionView`. Remove `ConfirmSeam` from the type-only import (it becomes unused). Delete the `APPROVE_TOOL_NAME` constant.

   **New exported constant** next to `MAX_INPUT_CHARS`:
   ```ts
   /** The reason every still-pending ask is declined with when the user stops a run. */
   export const STOP_DECLINE_REASON = 'the run was stopped';
   ```

   **Deps.** In `ChatControllerDeps`, delete `confirm: ConfirmSeam;` and its doc comment, and add:
   ```ts
     /**
      * The pending-ask registry shared with the tool registry's seams. The host
      * creates one registry, wraps it in an `InterventionSeam` whose `present`
      * forwards to {@link ChatController.presentIntervention}, and adapts that
      * seam into the `ConfirmSeam` the tools gate on, so every ask raised by a
      * tool settles through this controller. Defaults to a private registry (no
      * tool can reach it) so a test can construct the controller without one.
      */
     askRegistry?: PendingAskRegistry;
   ```

   **State.** Add fields next to `runningKey`:
   ```ts
     /** The pending-ask registry every inline card settles through. */
     private readonly asks: PendingAskRegistry;

     /** Cards currently on screen, by ask id: the view plus where its settled record is written. */
     private readonly cards = new Map<string, PendingCard>();
   ```
   and a module-private interface near the bottom helpers:
   ```ts
   /** One card the view is showing, and the transcript its settled record belongs to. */
   interface PendingCard {
     view: InterventionView;
     transcript: ChatTranscript;
   }
   ```
   In the constructor: `this.asks = deps.askRegistry ?? new PendingAskRegistry({ ids: { next: () => `ask-${Date.now()}-${Math.random().toString(36).slice(2)}` } });`

   **Presentation.** Add a public method (this is the `PresentIntervention` the host binds):
   ```ts
     /**
      * Show one pending ask as an inline card on the conversation currently in
      * view, and remember which transcript its settled record belongs to. Bound
      * by the host as the `present` of the shared `InterventionSeam`; the seam
      * declines the ask automatically if this throws.
      */
     public presentIntervention(ask: Intervention): void {
       const scope = this.activeScope();
       const key = scopeId(scope);
       const sessionId = this.activeSessions.get(key) ?? this.newSessionId(scope);
       const view = toInterventionView(ask);
       this.cards.set(ask.id, { view, transcript: this.transcriptFor(scope, sessionId) });
       this.deps.webview.post({ type: 'showIntervention', intervention: view });
     }
   ```
   And the module-private mapper (place beside `toRenderRecord`):
   ```ts
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
   ```

   **Answering.** Extend the `handle` switch with:
   ```ts
         case 'answerIntervention':
           await this.onAnswerIntervention(msg.id, msg.answer);
           return;
   ```
   (do not add a `setAutoMode` case — Auto mode is a later todo; the switch is already non-exhaustive over `WebviewToHost` and compiles), then:
   ```ts
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
   ```

   **Stop.** Replace `onStop`:
   ```ts
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
       const answer: InterventionAnswer = { kind: 'declined', reason };
       for (const ask of this.asks.pending()) {
         if (this.asks.resolve(ask.id, answer).kind === 'resolved') {
           await this.settleCard(ask.id, answer, { rationale: reason });
         }
       }
       // Safety net for asks raised before any card was shown.
       this.asks.rejectAll(reason);
     }
   ```

   **Approve gate.** In `callTool`, delete the whole `if (name === APPROVE_TOOL_NAME) { ... }` block (and the `slug`/`phase` doc lines referring to the Confirm_Seam in the method comment; rewrite the comment to say the approve/draft/submit tools gate themselves through `services.confirm`, which the host wires to the same intervention seam, so the confirmation appears as an inline card). The `slug` parameter of `callTool` becomes unused only for the approve branch — it is still used by `buildPrompt`? No: `callTool` passes `slug` nowhere else, so remove the `slug` parameter from `callTool` and from its call site in `onSend` (`call: (name, args, callId, signal) => this.callTool(name, args, callId, signal, phase)`), and delete the now-unused module function `approveSlugFromArgs`. Keep `parseArgs`.

   **History.** In `toChatMessage`, before the existing role mapping, add:
   ```ts
     if (record.intervention !== undefined) {
       // A persisted card re-enters the model history as the ask and its outcome,
       // never as a bare prompt that would read like a fresh question.
       return { role: 'assistant', content: interventionHistoryText(record.intervention) };
     }
   ```
   plus module helpers:
   ```ts
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
   ```

   **Module doc.** Add a responsibility bullet: "present every human-in-the-loop ask raised through the shared `PendingAskRegistry` as an inline card, settle it in place on `answerIntervention` (which resumes the paused tool call), persist the settled card to the transcript, and decline every pending ask on stop."

   Files: `src/activation/chatController.ts`

3. commands.ts: build one shared registry + intervention seam, adapt it to ConfirmSeam, and wire it into the tools and the controller

   All edits in `src/activation/commands.ts`.

   1. **Imports.** Add to the existing `../orchestrator` value import: `PendingAskRegistry`, `createInterventionSeam`, `confirmSeamFrom`. Add to the type import: `Intervention`, `PresentIntervention` (and keep `ConfirmSeam`).

   2. **Create the shared ask plumbing** immediately before `const draftServices = buildToolServices(...)` (~line 290), i.e. before the first `buildToolServices` call:
   ```ts
     // Every human-in-the-loop ask — the approve/draft/submit confirmations today —
     // goes through one registry and one seam. `present` is bound late: until the
     // Chat_View has resolved, an ask falls back to the modal so a confirmation
     // triggered from the tree is never silently declined.
     const askRegistry = new PendingAskRegistry({
       ids: { next: () => `ask-${Date.now()}-${Math.random().toString(36).slice(2)}` },
       clock: systemClock,
     });
     const modalConfirm = buildConfirmSeam();
     let presentAsk: PresentIntervention = (ask) => presentThroughModal(askRegistry, modalConfirm, ask);
     const interventionSeam = createInterventionSeam(askRegistry, (ask) => presentAsk(ask));
     const confirm = confirmSeamFrom(interventionSeam);
   ```

   3. **Thread `confirm` into the tools.** Change `buildToolServices` to take the seam instead of building its own: add a final parameter `confirm: ConfirmSeam` and use it in the returned object (`confirm,` replacing `confirm: buildConfirmSeam(),`); update its doc comment to say the confirmation seam is injected by the caller and is the inline-card adapter. Pass `confirm` at both call sites (`draftServices` and the `createToolRegistry({ ...buildToolServices(...) })` spread).

   4. **Controller wiring.** In the `new ChatController({...})` literal, delete `confirm,` and add `askRegistry,`. Delete the now-unused `const confirm = buildConfirmSeam();` line that sits just above it (the shared `confirm` from step 2 is already in scope and is what the tools use).

   5. **Bind the presenter once the chat view is live.** Replace `chatWebview.onResolve(() => chatController.start());` with:
   ```ts
     // Once the Chat_View has resolved, asks are presented as inline cards on the
     // conversation in view; before that the modal fallback stands in.
     presentAsk = (ask) => chatController.presentIntervention(ask);
     chatWebview.onResolve(() => chatController.start());
   ```
   Place it where the current `onResolve` call is (after `reportDraftOutcome` is bound).

   6. **Modal fallback helper** next to `buildConfirmSeam`:
   ```ts
   /**
    * Present an ask while the Chat_View has not resolved yet: a confirmation or a
    * permission ask falls back to the modal and is settled from its answer; a
    * question has no modal form, so it is declined with a reason naming why.
    */
   async function presentThroughModal(
     registry: PendingAskRegistry,
     confirm: ConfirmSeam,
     ask: Intervention,
   ): Promise<void> {
     if (ask.kind === 'question') {
       registry.reject(ask.id, 'the Baiton chat view is not open');
       return;
     }
     const message = ask.detail === undefined ? ask.prompt : `${ask.prompt}\n\n${ask.detail}`;
     const approved = await confirm.confirm(message);
     registry.resolve(
       ask.id,
       approved ? { kind: 'approved' } : { kind: 'declined', reason: 'the confirmation was declined' },
     );
   }
   ```
   Keep `buildConfirmSeam` itself, and update its doc comment: it is no longer the seam the tools hold, only the modal fallback used before the chat view exists.

   Files: `src/activation/commands.ts`

4. New test suite: test/chatController.interventions.test.ts

   Create `test/chatController.interventions.test.ts` — the first suite over `ChatController`, so it also establishes the fake-host harness. It must import `ChatController` statically with no `vscode` loader hook (proving the controller stays host-free), mirroring `test/configPanel.controller.test.ts`'s style and file-doc conventions.

   **Harness (top of file).**
   - `class FakeWebview implements ChatWebview`: `posts: HostToWebview[] = []`, `post(m) { this.posts.push(m); }`, `onMessage(h) { this.handler = h; }`, plus `async send(msg: WebviewToHost) { await this.handler?.(msg); }` and helpers `last<T>(type)` / `all(type)` filtering `posts` by `type`.
   - A temp workspace per test: `fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-chat-'))`, with `baitonDir = <tmp>/.baiton` and `specsDir = <tmp>/.baiton/specs`; remove it in `afterEach`.
   - A fake registry: a plain object `{ call: async (name, _args, _callId, _ctx, _phase) => calls[name]() }` cast `as unknown as ToolRegistry`; the test's tool implementations close over the shared `InterventionSeam`.
   - A fake `ModelClient`: a scripted queue of `CompletionResult`s — round 1 returns `{ tool_calls: [{ id: 'c1', name: 'confirm_tool', arguments: '{}' }] }`, round 2 returns `{ content: 'done', tool_calls: [] }` — and records the `messages` of each `complete` call for the history assertion.
   - Build the controller with: `webview`, `client`, `registry`, `toolsFor: () => []`, `guardContext: () => ({} as GuardContext)`, `baitonDir`, `specsDir`, `roundBound: () => 4`, `config: { getEndpoint: () => 'http://x', getModel: () => 'm' }`, `triggerFix: () => {}`, `log: () => {}`, and `askRegistry` — the same `PendingAskRegistry` the test wraps in `createInterventionSeam(registry, (ask) => controller.presentIntervention(ask))` (bind the presenter lazily through a mutable local, since the seam is needed before the controller exists, exactly as `commands.ts` does).
   - Drive a send with `controller.start()` then `await webview.send({ type: 'sendText', text: 'go' })`, keeping the returned promise so the test can await the loop after answering.

   **Cases to cover.**
   1. *Card raised and the loop pauses.* The fake tool calls `seam.ask({ kind: 'confirm', prompt: 'Approve spec "x"?', detail: 'This creates its branch.' })`. Assert exactly one `showIntervention` is posted with `intervention.id` non-empty, `kind: 'confirm'`, `status: 'pending'`, `prompt`/`detail` carried through; assert the tool has not returned and no `renderConversation` for the finished loop has been posted yet (the loop is blocked on the ask).
   2. *Approve settles in place and resumes.* Send `{ type: 'answerIntervention', id, answer: { kind: 'approved' } }`; assert a `resolveIntervention` for that id with `answer.kind === 'approved'`, that the tool observed `{ kind: 'approved' }`, and that the send promise then completes with `setBusy false` posted last.
   3. *Decline.* Same shape with `{ kind: 'declined', reason: 'no' }`; the tool observes a declined answer and returns its refusal result; assert the `resolveIntervention` carries the declined answer.
   4. *Persistence.* After case 2, read the session transcript file under `<baitonDir>/chat/<id>.jsonl` (locate it with `fs.readdirSync`), parse the JSONL, and assert exactly one record with `role === 'system'`, `content === '<the prompt>'` and `intervention.status === 'resolved'`, `intervention.answer.kind === 'approved'`. Also assert `readTranscript` + `toRenderRecords` over that file yields one record carrying the settled `intervention`, i.e. the card survives a re-render.
   5. *Invalid answer.* Answer a `confirm` card with `{ kind: 'text', text: 'maybe' }`; assert a `showError` is posted, no `resolveIntervention` is posted, and the ask is still pending (`askRegistry.size === 1`); a following `{ kind: 'approved' }` then settles it.
   6. *Unknown id.* Send `answerIntervention` with `id: 'nope'`; assert a `resolveIntervention` for `'nope'` with a declined answer is posted (so a stale card never sticks) and nothing throws.
   7. *Stop declines pending asks.* With a card pending, send `{ type: 'stop' }`; assert a `resolveIntervention` with `answer.kind === 'declined'` and `rationale === STOP_DECLINE_REASON`, that the tool's `await seam.ask(...)` resolved declined, that `askRegistry.size === 0`, and that the send promise completes.
   8. *History projection.* After a settled card, start a second send and inspect the messages captured by the fake client: assert one message with `role === 'assistant'` whose content starts with `'[intervention] '` and contains `'Decision: approved'` (and that the bare prompt alone does not appear as a message).

   Follow the repo's test conventions: mocha `describe`/`it`, node `assert` (strict helpers), a file-level doc comment enumerating the cases, no `vscode` import anywhere in the suite.

   Files: `test/chatController.interventions.test.ts`

5. Verify

   Run, in order, from the repo root:
   - `npm run compile` — must be clean; watch for the removed `ConfirmSeam` import in `chatController.ts` and the removed `confirm` dep at the `new ChatController({...})` site in `commands.ts`.
   - `npm run lint` — must be clean; `approveSlugFromArgs`, `APPROVE_TOOL_NAME` and the `slug` parameter of `callTool` must all be gone rather than left unused.
   - `npm test` — the whole suite must pass; the post-T05 baseline is 912 passing / 1 pending / 0 failing, so expect 912 + the new cases passing and 0 failing.
   No change to `media/chat.js` or `media/protocol.js` is in scope for this todo.

   Files: (none)

## Risks

- Removing the controller's own `approve_spec` gate is deliberate: the tool already confirms through `services.confirm`, so keeping both would show two cards. The user-visible decline message therefore changes from 'approval did not proceed: the confirmation was declined' to the tool's own 'approval of spec "<slug>" was declined; the spec is unchanged'. If any test or doc pins the old string, update the reference rather than re-adding the gate.
- Ordering in `commands.ts`: the ask registry and seam must be created before the first `buildToolServices` call (the `draftServices` block, ~line 290) because both tool-services bundles now take the shared `confirm`. The presenter is bound after `chatController` exists; until then the modal fallback stands in, so an approval triggered from the tree view with the chat closed still works.
- `presentIntervention` is called on whichever conversation is in view at that moment, and it allocates a session id if the active scope has none. A card raised while the user has switched conversations is still shown and persisted against the newly active session; scope-aware routing (`Intervention.scopeId`) is deferred to the harness-relay todo.
- Cards are persisted only when they settle (the append-once policy documented on `interventionTranscriptRecord`). A window reload with a card pending loses both the card and the promise; the ask cannot be re-offered. The unknown-id branch of `onAnswerIntervention` exists precisely so a card restored in a stale webview settles instead of hanging.
- `onStop` declines asks asynchronously (`void this.declinePendingAsks(...)`) because `onStop` is synchronous; a test must await the send promise (or a microtask) rather than asserting immediately after posting `stop`.
- `ToolRegistry` is a class, not an interface, so a test fake must be cast (`as unknown as ToolRegistry`); do not widen the `ChatControllerDeps.registry` type to make faking easier.
- The `handle` switch stays non-exhaustive over `WebviewToHost` (`setAutoMode` is unhandled until the Auto-mode todo). Do not add a `default:` branch that would mask the missing case.

## Acceptance

- `npm run compile`, `npm run lint` and `npm test` are all clean, with no failing tests and the new `test/chatController.interventions.test.ts` cases passing.
- An ask raised through the shared `InterventionSeam` while a tool call is running posts exactly one `showIntervention` with a pending `InterventionView` and the awaiting tool call does not return until the ask is settled.
- `answerIntervention` with a valid answer resolves the originating ask (resuming the paused flow), posts `resolveIntervention` carrying that answer, and appends exactly one settled `system` record with `intervention.status === 'resolved'` to the session transcript.
- `answerIntervention` with an answer the request rejects posts `showError` with the validator's reason, posts no `resolveIntervention`, and leaves the ask pending; an unknown id settles the card as declined without throwing.
- `stop` declines every pending ask: each card is posted as resolved-declined with the stop reason as its rationale, the registry is empty afterwards, and the in-flight send completes rather than hanging.
- `ChatControllerDeps` no longer carries `confirm`; `commands.ts` builds one `PendingAskRegistry` + `InterventionSeam`, passes `confirmSeamFrom(seam)` into both `buildToolServices` call sites, passes `askRegistry` to the controller, and calls `vscode.window.showWarningMessage` for an ask only through the pre-chat-view modal fallback.
- `ToolServices` exposes the optional `intervention?: InterventionSeam` field and documents `confirm` as its yes/no adapter.
- A reloaded conversation containing a settled card renders it through `toRenderRecords` and feeds the model a single assistant message of the form `[intervention] <prompt>\nDecision: <outcome>` rather than the bare prompt.
