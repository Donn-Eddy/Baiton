# Plan T11

## Steps

1. Add the escalation shape and its pure view helper to the protocol core

   In `src/orchestrator/webviewProtocol.ts`:

   1. Add one optional field to `interface InterventionView`, declared directly after `rationale` and before `auto`:
   ```ts
     /**
      * Present when Auto mode declined to decide the ask and escalated it: what
      * the user would be approving, and why the gate flagged it. The card's
      * `detail` carries the same text in rendered form, so the webview needs no
      * change to show it; this field keeps the two parts separately readable in
      * the persisted transcript record.
      */
     escalation?: { what: string; why: string };
   ```
   Do NOT touch `reduce`, `WebviewState`, `HostToWebview`, `WebviewToHost` — `showIntervention` / `resolveIntervention` / `setAutoMode` and `WebviewState.autoMode` already exist and carry the new field through opaquely, so `media/protocol.js` and the mirror fixtures stay untouched.

   2. Add two exported constants and one pure helper at the end of the file, next to `interventionUpdate`:
   ```ts
   /** Label of the 'what you are approving' line of an escalated card. */
   export const ESCALATION_WHAT_LABEL = 'What you are approving:';

   /** Label of the 'why it was flagged' line of an escalated card. */
   export const ESCALATION_WHY_LABEL = 'Why it was flagged:';

   /**
    * The card an escalated ask renders as: the pending view with the escalation
    * recorded structurally and appended to `detail` as two labelled lines. The
    * view's own `detail` (the harness's description, when it supplied one) is
    * kept as the first paragraph. Pure: it allocates a fresh view.
    */
   export function escalatedInterventionView(
     view: InterventionView,
     escalation: { what: string; why: string },
   ): InterventionView {
     const parts: string[] = [];
     if (view.detail !== undefined && view.detail.trim().length > 0) {
       parts.push(view.detail);
     }
     parts.push(`${ESCALATION_WHAT_LABEL} ${escalation.what}`);
     parts.push(`${ESCALATION_WHY_LABEL} ${escalation.why}`);
     return { ...view, escalation: { ...escalation }, detail: parts.join('\n') };
   }
   ```
   The `\n` join is safe to render: `.intervention-detail` in `media/chat.html` is `white-space: pre-wrap`, and `media/chat.js` assigns `detail` with `textContent`.

   3. Extend the `showIntervention` bullet of the `reduce` JSDoc list with one sentence noting that an Auto-mode escalation arrives as an ordinary pending card whose `detail`/`escalation` carry the what/why.

   Files: `src/orchestrator/webviewProtocol.ts`

2. Give the controller Auto-mode state, its persistence seam and the gate seam

   In `src/activation/chatController.ts`:

   1. Imports. Add `escalatedInterventionView` to the existing value import list from `'../orchestrator'` (keep alphabetical position near `interventionTranscriptRecord`). Add `AutoModeOutcome` and `PermissionRequest` to the existing `import type { ... } from '../orchestrator'` block.

   2. New exported seam types, declared next to `SessionMemory` (after the `ChatControllerDeps` interface):
   ```ts
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
   ```

   3. Two new optional fields on `ChatControllerDeps`, documented in the same voice as `sessionMemory`:
   ```ts
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
   ```

   4. Controller state: add a private field next to `busy`:
   ```ts
     /** Whether Auto mode is on; seeded from `autoModeMemory` and echoed to the view. */
     private autoMode = false;
   ```
   and seed it in the constructor after the `this.asks = ...` assignment: `this.autoMode = deps.autoModeMemory?.get() ?? false;`.

   5. `handle(msg)`: add the missing case (the switch currently handles every other `WebviewToHost` variant):
   ```ts
         case 'setAutoMode':
           await this.onSetAutoMode(msg.enabled);
           return;
   ```

   6. New private method, placed immediately before `presentIntervention`:
   ```ts
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
   ```

   7. `refresh()`: post the toggle state so a reopened/reloaded webview (which restarts from `initialWebviewState`) shows the persisted value. Add as the first post of the method, immediately before the `setConversations` post:
   ```ts
       this.deps.webview.post({ type: 'setAutoMode', enabled: this.autoMode });
   ```

   Files: `src/activation/chatController.ts`

3. Gate presented permission asks through Auto mode and record the audit

   Still in `src/activation/chatController.ts`, rewrite `presentIntervention` (currently `public presentIntervention(ask: Intervention): void`) as an async method and add two private helpers. `PresentIntervention` already allows `Promise<void>` and `createInterventionSeam` awaits it, so no seam change is needed.

   ```ts
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
       const scope = this.activeScope();
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
       this.cards.set(ask.id, { view: card, transcript });
       this.deps.webview.post({ type: 'showIntervention', intervention: card });
       if (outcome !== undefined) {
         // Audit the escalation now, while it happens: the same id is appended
         // again, settled, once the user answers, and `toRenderRecords` renders
         // the pair as the one card in its original position.
         await this.append(transcript, interventionTranscriptRecord(card));
       }
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
   ```

   Add the module-level helper next to `describeAnswer`:
   ```ts
   /** The one-line audit rationale of an Auto-mode approval, naming the stage that decided. */
   function autoApprovalRationale(outcome: Extract<AutoModeOutcome, { kind: 'approve' }>): string {
     const stage = outcome.stage === 'allow-list' ? 'allow-list' : 'model review';
     return `Auto mode (${stage}): ${outcome.rationale}`;
   }
   ```

   Notes for the executor:
   - `this.cards` is deliberately NOT populated on the auto-approved path: the card never becomes answerable, and `settleCard` is a no-op for an id with no card, so a later stray `answerIntervention` for that id still settles safely as a stale declined card.
   - Leave `onAnswerIntervention`, `settleCard`, `onStop` and `declinePendingAsks` unchanged — an escalated card settles through exactly the existing path.
   - Update the class-level JSDoc responsibility bullet about interventions (currently duplicated twice in the header comment — collapse the duplicate while you are there) to mention the Auto-mode gate and that both outcomes are persisted.

   Files: `src/activation/chatController.ts`

4. Wire the memory and the real two-stage gate in activation

   In `src/activation/commands.ts`:

   1. Imports: add `decideAsk` and `askFromPermission` to the value import list from `'../orchestrator'`; add `agentAllowList` to the `import { createAdapterRegistry } from '../adapter';` line; add `Role` to the `import type { Adapter, AdapterRegistry } from '../adapter';` block.

   2. Module-level constants, declared next to the other chat constants:
   ```ts
   /**
    * The role the Auto-mode gate evaluates a harness ask against until the ask
    * relay carries the originating run's role and id. `planner` is the most
    * restrictive profile (read-only, no shell, writes confined to its run dir),
    * so the deterministic stage can only ever clear reads and searches on its
    * own and everything else goes to the model stage.
    */
   const AUTO_MODE_FALLBACK_ROLE: Role = 'planner';

   /** Run id used for the same reason: it matches no real run directory, so no write rule can fire. */
   const AUTO_MODE_UNKNOWN_RUN = 'unknown-run';
   ```

   3. Build the gate immediately before `const chatController = new ChatController({`:
   ```ts
     // Auto mode's two-stage gate: the per-agent allow-list first, then the
     // orchestrator model. It is only consulted for harness permission asks that
     // arrive while the toggle is on; see ChatController.presentIntervention.
     const autoGate: AutoModeGate = (ask, opts) =>
       decideAsk(
         askFromPermission(ask),
         agentAllowList(ask.agent, AUTO_MODE_FALLBACK_ROLE, AUTO_MODE_UNKNOWN_RUN),
         modelClient,
         { role: AUTO_MODE_FALLBACK_ROLE, signal: opts.signal },
       );
   ```
   Import `AutoModeGate` as a type from `'./chatController'` (the file already imports `ChatController` from there; add a sibling `import type { AutoModeGate } from './chatController';` or extend the existing type import if one is present).

   4. Pass two new deps into the `new ChatController({ ... })` call, after `sessionMemory`:
   ```ts
       autoGate,
       // The Auto-mode toggle is remembered per workspace, so a window reload
       // comes back in the mode the user left it in.
       autoModeMemory: {
         get: () => context.workspaceState.get<boolean>('baiton.chat.autoMode') === true,
         set: async (enabled: boolean) => {
           await context.workspaceState.update('baiton.chat.autoMode', enabled);
         },
       },
   ```

   5. `presentAsk = (ask) => chatController.presentIntervention(ask);` now returns a promise — the `PresentIntervention` type already allows it, so leave the line as-is (do not add `void`, the seam awaits it so a gate in flight keeps the seam's `present` honest).

   Files: `src/activation/commands.ts`

5. Add the host-free controller suite test/chatController.autoMode.test.ts

   Create `test/chatController.autoMode.test.ts`, modelled closely on `test/chatController.interventions.test.ts` (copy its `FakeWebview`, `FakeModelClient`, `waitFor`, `startSend`, `awaitRunEnd`, `transcriptFile` helpers and the tmp-dir `buildHarness`/`afterEach` shape; import `ChatController`, `STOP_DECLINE_REASON` statically with no vscode loader hook so the host-free property is proven again).

   Harness differences:
   - The fake `ToolRegistry.call` asks a permission ask: `await seam.ask({ kind: 'permission', prompt: 'Allow Read of src/a.ts?', agent: 'claude', tool: 'Read', args: '{"file_path":"src/a.ts"}', detail: 'Reads one file.' })`, pushing the answer onto `observed` and returning `{ ok: true, data: 'ok' }` / `{ ok: false, error: 'declined' }`.
   - A `gateCalls: PermissionRequest[]` array plus a mutable `gateResult: AutoModeOutcome | (() => Promise<AutoModeOutcome>)`; the injected `autoGate` records the ask and yields it.
   - A fake `autoModeMemory` over a mutable `let remembered = false;` recording every `set` call in `memorySets: boolean[]`.
   - Let `buildHarness` take options so a test can build a second controller whose memory already reads `true`.

   Cases (one `it` each):
   1. **Toggle echo and persistence** — `webview.send({ type: 'setAutoMode', enabled: true })` posts exactly one `setAutoMode` with `enabled === true` after start's initial post, and `memorySets` ends `[true]`; sending `false` echoes and persists `false`.
   2. **Persisted state is restored** — a controller built with `autoModeMemory.get()` returning `true`, then `start()`, posts `setAutoMode { enabled: true }` before/with its first `renderConversation`.
   3. **Off: nothing is gated** — with Auto off, a permission ask posts one pending `showIntervention` (`status === 'pending'`, no `auto`, no `escalation`), `gateCalls.length === 0`, and answering approves as before.
   4. **On: allow-list approval settles with no card to answer** — gate returns `{ kind: 'approve', stage: 'allow-list', rationale: 'claude/planner may read any file' }`; assert exactly one `showIntervention` whose view has `status === 'resolved'`, `auto === true`, `rationale` containing both `Auto mode (allow-list)` and the gate's text; no `resolveIntervention` is posted; `observed` is `[{ kind: 'approved' }]`; `askRegistry.size === 0`; the transcript holds exactly one intervention record, resolved, `auto === true`, with that rationale; `toRenderRecords(await readTranscript(file))` renders it once, settled.
   5. **On: model-stage approval** — same with `stage: 'model'`; assert the rationale reads `Auto mode (model review): …`.
   6. **On: escalation renders on the card and is audited** — gate returns `{ kind: 'escalate', what: 'claude wants to run Bash: rm -rf build', why: 'a destructive shell command' }`; assert the posted card is `status === 'pending'`, `escalation` deep-equals the gate's what/why, `detail` contains the original `Reads one file.` plus `What you are approving: …` and `Why it was flagged: …`; the transcript already holds a pending intervention record for that id BEFORE any answer; then answer `{ kind: 'approved' }`, assert one `resolveIntervention`, the transcript now holds two records for the id (pending then resolved) and `toRenderRecords` collapses them to one resolved card that still carries `escalation`.
   7. **Confirms and questions are never gated** — with Auto on, a fake tool asking `{ kind: 'confirm', … }` posts a pending card and leaves `gateCalls` empty.
   8. **Only asks presented while on are gated** — raise an ask with Auto off (pending card), then send `setAutoMode true`: the pending card is untouched (no new `showIntervention`, still pending, `gateCalls.length === 0`) and answering it still settles normally.
   9. **A throwing gate escalates** — `gateResult` throws; assert a pending card whose `detail`/`escalation.why` names the failure, `askRegistry.size === 1`, and no unhandled rejection (the send still completes after answering).
   10. **Stop during a slow gate wins** — gate resolves `approve` only after a deferred promise the test releases; send `stop` first, assert `observed[0]` is `{ kind: 'declined', reason: STOP_DECLINE_REASON }`; then release the gate and assert no extra `showIntervention` carrying `auto === true` was posted and the transcript holds exactly one intervention record for the id.

   Header JSDoc: mirror the interventions suite's numbered coverage list and state that the suite is host-free.

   Files: `test/chatController.autoMode.test.ts`

6. Verify

   Run, from the repo root, in order: `npm run compile` (no TypeScript errors), `npx mocha --timeout 15000 test/chatController.autoMode.test.ts` (new suite green in isolation), `npm run lint` (no problems) and `npm test` (full suite: the recorded baseline is 1043 passing / 1 pending / 0 failing, so expect 1043 + the new cases passing and 0 failures; the pre-existing `test/chatController.interventions.test.ts` must stay green unchanged). Also confirm with `git status --porcelain` that only `src/orchestrator/webviewProtocol.ts`, `src/activation/chatController.ts`, `src/activation/commands.ts` and the new `test/chatController.autoMode.test.ts` are modified — `media/chat.js`, `media/chat.html`, `media/protocol.js`, `test/fixtures/protocolCases.ts` and `src/orchestrator/autoMode.ts` must be untouched.

   Files: (none)

## Risks

- `presentIntervention` becomes async and now awaits a model round-trip on the escalation path. `createInterventionSeam` awaits `present` and declines the ask if it throws, so the gate must never throw — `autoDecision` wraps the call in try/catch and returns an escalation instead. Keep it that way.
- A stop (or any `rejectAll`) can settle the ask while the gate is in flight. `autoApprove` must check the `this.asks.resolve(...)` outcome and return without posting or persisting when it is not `resolved`, otherwise the transcript gets two records and the view shows a card that the harness already saw declined.
- No production code raises a `permission` ask yet (the ask relay is a later todo), so the `commands.ts` gate wiring is exercised only by the new controller suite. The fallback role/run id (`planner` / `unknown-run`) is deliberately conservative: stage (a) can only clear reads and searches, everything else costs a model call. Do not widen it here.
- The gate calls the orchestrator model. With Auto on, a stream of harness asks means a stream of completions; the signal from the in-flight run is forwarded so Stop cancels them, but an ask raised outside a run has no signal.
- `media/*` is out of scope for this todo. The escalation must therefore ride on fields the webview already renders (`detail`, with `white-space: pre-wrap`); adding a field the renderer reads would silently render nothing until a later todo.
- `toRenderRecords` collapses a pending-then-resolved pair for one ask id into a single row at the first occurrence. The escalation audit record relies on that behaviour — if it regresses, an escalated ask renders twice.

## Acceptance

- `npm run compile`, `npm run lint` and `npm test` all pass, with the new suite green and no pre-existing test regressed.
- Flipping the toggle in the webview posts `setAutoMode` to the host, which sets its own state, echoes `setAutoMode` back, and writes the value to `workspaceState` under `baiton.chat.autoMode`; the webview never flips itself.
- A controller constructed over an `autoModeMemory` that reads `true` posts `setAutoMode { enabled: true }` on `start()`/`refresh()`, so a reopened or reloaded view comes back in Auto mode.
- With Auto mode off, or for a `confirm` / `question` ask in any mode, or with no gate wired, the gate is not called and the ask is presented exactly as before this todo.
- An ask already pending when the toggle is switched on stays pending and unchanged: only asks presented while Auto mode is on are gated.
- With Auto mode on, a `permission` ask the gate approves is resolved with `{ kind: 'approved' }` with no user round-trip; the conversation shows one already-resolved card carrying `auto: true` and a rationale naming the deciding stage, and no `resolveIntervention` is needed to settle it.
- Every auto-approval is persisted as exactly one settled `system` intervention record (`status: 'resolved'`, `auto: true`, the rationale) in the active conversation's transcript, and re-renders through `readTranscript` + `toRenderRecords` as one settled card.
- An escalation is presented as a normal pending card whose `escalation` field holds the gate's what/why and whose `detail` shows them as labelled lines below any harness-supplied detail; the escalation is appended to the transcript when it happens, and the settled record follows when the user answers, the pair rendering as one card.
- A gate that throws or rejects escalates to the user and is logged; no failure path in Auto mode can approve an ask.
- Stop still declines every pending ask, and a gate approval that arrives after the stop neither posts a card nor writes a transcript record.
- `media/chat.js`, `media/chat.html`, `media/protocol.js` and the protocol mirror fixtures are unmodified, and `reduce` / `WebviewState` are unchanged.
