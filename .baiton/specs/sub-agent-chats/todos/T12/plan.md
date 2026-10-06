# Plan T12

## Steps

1. ChatController owns a SubAgentRunner and exposes it

   In src/activation/chatController.ts import from '../orchestrator' (the barrel already re-exports subAgent.ts): createSubAgentRunner, SubAgentRunner, SubAgentEvent, SubAgentToolSurface, isDescendantKey, parentIdOf, and the types InterventionSeam, SessionScope. Add a field `public readonly subAgents: SubAgentRunner;` and build it at the end of the constructor, after `this.sessions` and `this.asks` exist:

   ```ts
   this.subAgents = createSubAgentRunner({
     sessions: this.sessions,
     client: deps.client,
     tools: () => deps.registry as unknown as SubAgentToolSurface,
     guardContext: () => deps.guardContext(),
     roundBound: () => deps.roundBound(),
     readSpec: (slug) => this.readSpec(slug),
     asks: this.asks,
     onEvent: (e) => this.onSubAgentEvent(e),
     log: (m) => deps.log(`Baiton chat: ${m}`),
   });
   ```
   (ToolRegistry already has assembleFor/definitionsFor/call with surface+caller, so the cast is only for test fakes.) Add `public subAgentInterventionSeam(base: InterventionSeam): InterventionSeam { return this.subAgents.interventionSeam(base); }` as a thin convenience for the host. In `dispose()` also call `this.subAgents.dispose()`. Update the file-header responsibilities list with one bullet describing sub-agent chats (runner ownership, forwarded asks on the parent, live posts only for the session in view, read-only children).

   Files: `src/activation/chatController.ts`

2. Track the running session and pass surface + caller on top-level tool calls

   Keep `runningKey` but add `private runningSession: { scope: SessionScope; sessionId: string } | undefined;` set beside `runningKey` in onSend (and compactContext) and cleared in the same finally blocks. Add a private helper `sessionOfKey(key: string): { scope: SessionScope; sessionId: string } | undefined` that splits at the FIRST '/' (scopeId is 'workspace' or a slug, which has no '/'), mapping 'workspace' to {kind:'workspace'} and anything else to {kind:'spec', slug}.

   Change `callTool(name, args, callId, signal, phase)` to also take `scope: SessionScope` and `key: string`, and call
   `this.deps.registry.call(name, parsed, callId, this.deps.guardContext(), phase, 'top', { sessionKey: key, depth: 0, phase, kind: scope, signal })`.
   In onSend pass `scope` and `key` (key is already computed as `${scopeId(scope)}/${sessionId}`; move its computation above the runToolLoop call if needed).

   Files: `src/activation/chatController.ts`

3. Post live loop output only for the session in view

   In onSend the user's own appendMessage post stays (the session is in view at send time) but every later live post must be gated on `key === this.viewKey()`:
   - `onDelta: (t) => { if (key === this.viewKey()) this.deps.webview.post({ type: 'streamDelta', text: t }); }`
   - `append: async (m) => { await this.append(transcript, m); if (key === this.viewKey()) this.postAppended(m); }`
   - after the loop: `if (key === this.viewKey()) await this.renderConversation(transcript.path);`
   - in the catch: post `streamEnd` only when in view; surfaceError still posts unconditionally.
   - in `compact(...)`: post the compaction `appendMessage` only when `key === this.viewKey()`.
   setBusy is still posted unconditionally (the view's busy flag covers the whole tree).

   Add `private async onSubAgentEvent(e: SubAgentEvent): Promise<void>` (call it with `void`; wrap the body in try/catch → deps.log):
   - `delta`: if `e.key === this.viewKey()` post `{ type: 'streamDelta', text: e.text }`.
   - `appended`: if `e.key === this.viewKey()`: when `e.record.intervention !== undefined` re-render the child from disk (`renderConversation(this.sessions.pathFor(scope, e.chatId))`), else `this.postAppended(e.record)`. Then, when `e.record.role === 'user'` (the child's file now exists / its title is now known) and the event's scope (from `sessionOfKey(e.key)`) equals the active scope, `await this.postSessions(this.activeScope())` so the new child row appears under its parent.
   - `finished`: if `e.key === this.viewKey()` post `streamEnd` then re-render the child transcript from disk; then re-post sessions for the active scope (updatedAt changed).
   - `started`: nothing (the transcript has no file yet).

   Files: `src/activation/chatController.ts`

4. Route a sub-agent's question card to the parent chat and persist it there

   Extend `PendingCard` with `sessionKey?: string` (the session the card belongs to; undefined keeps today's scope-wide behaviour).

   In `presentIntervention(ask, context)`:
   - If `ask.origin !== undefined` (raised inside a sub-agent; origin = { rootKey, chatId, chatKey, depth }): do NOT call scopeForAsk. Resolve the root session: if `this.runningKey === ask.origin.rootKey` use `this.runningSession`, else `sessionOfKey(ask.origin.rootKey)`; if that fails, log and fall back to the existing path. transcript = `this.transcriptFor(root.scope, root.sessionId)`, scopeKey = `scopeId(root.scope)`, sessionKey = `ask.origin.rootKey`. Build the view with `toInterventionView(ask)` and prefix its prompt so the user knows who is asking: `prompt: \`Sub-agent \\`${leafOf(ask.origin.chatId)}\\` asks: ${view.prompt}\`` where leafOf takes the last '/' segment (keep this a small private helper).
   - Else, if a session is running (`this.runningSession !== undefined`) and `scopeId(scope) === scopeId(this.runningSession.scope)`, bind the card to the running session rather than to whatever session is in view: transcript of runningSession, sessionKey = this.runningKey. (This stops a top-level ask from being written into a child transcript the user happens to be viewing.) Otherwise keep today's behaviour (sessionKey undefined, active session of the scope).
   - Auto-mode gating is unchanged (only permission asks are gated). For both the pending post and the auto-approved settled post, post `showIntervention` only when the card is visible: `const visible = card.sessionKey === undefined ? card.scopeKey === scopeId(this.activeScope()) : card.sessionKey === this.viewKey();` (factor as `private cardVisible(card)`). Store the card in `this.cards` regardless, and persist exactly as today (escalation audit + settled record go to the card's transcript, i.e. the PARENT transcript for a forwarded ask).

   Change `repostPendingCards` to use `cardVisible(card)` instead of `card.scopeKey === key` (drop its parameter or keep and ignore it; update both call sites in refresh). The runner itself writes the child-side forwarded note (forwardedAskNoteRecord) after the answer — the controller must not write anything to the child transcript.

   Files: `src/activation/chatController.ts`

5. Stop aborts descendants and settles every declined card

   The runner's chained abort rejects a sub-agent's pending asks via `asks.reject` (no card bookkeeping), so the controller must settle cards itself regardless of who declined the ask. Rewrite onStop:

   ```ts
   private onStop(): void {
     const ids = new Set([...this.asks.pending().map((a) => a.id), ...this.cards.keys()]);
     const answer: InterventionAnswer = { kind: 'declined', reason: STOP_DECLINE_REASON };
     for (const id of ids) this.asks.resolve(id, answer); // resolve before abort so the controller wins the race
     this.abort?.abort();
     if (this.runningKey !== undefined) this.subAgents.stopDescendants(this.runningKey, STOP_DECLINE_REASON);
     void (async () => {
       for (const id of ids) { if (this.cards.has(id)) await this.settleCard(id, answer, { rationale: STOP_DECLINE_REASON }); }
       this.asks.rejectAll(STOP_DECLINE_REASON);
     })();
   }
   ```
   Keep `declinePendingAsks` (used elsewhere? if unused after this change, delete it) and the public `declineAsk` unchanged. Existing intervention test 7 (stop declines pending asks, empties the registry, the send completes) must still pass; adjust only if it asserted post ordering that this changes.

   Files: `src/activation/chatController.ts`

6. Session tree, read-only children, selection while busy, delete/send guards

   - `postSessions(scope)`: list with `this.sessions.listTree(scope)` instead of `list` (toSessionItems already projects depth/parentId). `resolveActiveSession` then naturally keeps a child active (its id is in the tree listing), so a reload with sessionMemory pointing at a child reopens it.
   - `refresh()`: after resolving `active`, post `{ type: 'setReadOnly', readOnly: active !== undefined && parentIdOf(active) !== undefined }` (post `readOnly: false` in the empty-state branch too). For a child (read-only) skip `seedContextEstimate` (it would call toolsFor and price the top-level prompt); still call postContextUsage/repostPendingCards.
   - `onSelectSession(sessionId)`: when busy, allow the switch iff the target key `${scopeId(this.activeScope())}/${sessionId}` equals `this.runningKey` or `isDescendantKey(targetKey, this.runningKey)`; otherwise keep the existing showError 'Wait for the current run to finish'. Then setActiveSession + refresh as today (refresh re-renders from the transcript, so switching back to the parent shows its persisted progress; live posts resume via the viewKey gating).
   - `onSend`: before anything else, if the active session id of the scope has a parent (`parentIdOf(id) !== undefined`) return without doing anything (a child is read-only; the webview hides the composer but the host must enforce it). Same guard in `compactContext` with a showError 'Sub-agent chats are read-only.'.
   - `onNewChat`: unchanged except it is allowed from a child view (creates a fresh top-level session) — verify no child id is reused.
   - `onDeleteSession(sessionId)`: refuse a child (`parentIdOf(sessionId) !== undefined`) with showError 'Sub-agent chats are deleted with their parent.'; keep the running-session refusal. When the deleted session is the active one OR the active session is its descendant (`isDescendantKey(activeKey, deletedKey)`), fall back to the newest remaining top-level session (`this.sessions.list(scope)`) or a fresh one, as today. SessionStore.delete already removes the `.children` folder.
   - `noteSystem` keeps `this.sessions.list(scope)` (top-level only) so system notes never land in a child.

   Files: `src/activation/chatController.ts`

7. Wire the SubAgentSeam and origin-stamping intervention seam in commands.ts

   In src/activation/commands.ts, both the registry and the controller need each other, so bind late through forwarders (same pattern as presentAsk):
   1. Rename the existing `const interventionSeam = createInterventionSeam(askRegistry, (ask) => presentAsk(ask));` to `baseInterventionSeam`, and add
   ```ts
   let originSeam: InterventionSeam = baseInterventionSeam;
   const interventionSeam: InterventionSeam = { ask: (req, origin) => originSeam.ask(req, origin) };
   const subAgentsUnavailable = async () => ({ kind: 'refused' as const, reason: 'sub-agents are not available until the Chat view has started' });
   let subAgentTarget: SubAgentSeam = { spawn: subAgentsUnavailable, send: subAgentsUnavailable };
   const subAgents: SubAgentSeam = { spawn: (r) => subAgentTarget.spawn(r), send: (r) => subAgentTarget.send(r) };
   ```
   `confirm = confirmSeamFrom(interventionSeam)` keeps using the forwarder. Import `SubAgentSeam` and `InterventionSeam` types from '../orchestrator' if not already imported.
   2. `buildToolServices(...)` gains a trailing optional parameter `subAgents?: SubAgentSeam` and spreads `...(subAgents !== undefined ? { subAgents } : {})` into the returned ToolServices. Pass `subAgents` only in the `createToolRegistry({...buildToolServices(..., landTodoSeam, subAgents), draftSpec})` call; the spec-draft `draftServices` stays without it.
   3. After `const chatController = new ChatController({...})` (next to `presentAsk = ...`): `subAgentTarget = chatController.subAgents; originSeam = chatController.subAgentInterventionSeam(baseInterventionSeam);`. The AsyncLocalStorage context in the runner survives the forwarders, so an ask_user inside a sub-agent turn carries its origin into presentIntervention.
   4. Update the chat comment block to say the controller owns the sub-agent runner and that the registry reaches it through the late-bound seam. No other call sites change (Stop/View/runningSlugs are todo-queue concerns already done in T05).

   Files: `src/activation/commands.ts`

8. New suite test/chatController.subAgents.test.ts

   Host-free (static import of ChatController, no vscode loader), temp dir with real SessionStore paths (baitonDir/specsDir), FakeWebview as in chatController.interventions.test.ts, a model client that routes completions by `req.sessionId` (top session id is unknown up front: route sessionIds containing '/' to a child script queue, others to a parent queue; support a 'hang until aborted' script), a real PendingAskRegistry + `createInterventionSeam(askRegistry, ask => controller.presentIntervention(ask))` as base, and `seam = controller.subAgentInterventionSeam(base)` bound after construction. Fake registry object (cast to ToolRegistry) implementing `definitions()`, `definitionsFor()`, `assembleFor()` (return ok([]) / ok(spec list)), and `call(name, args, callId, ctx, phase, surface, caller)` which records (name, surface, caller) and dispatches: 'spawn_subagent' → `controller.subAgents.spawn({ task: args.task, caller })`, 'send_to_subagent' → `controller.subAgents.send({ chatId: args.chat_id, message: args.message, caller })`, 'ask_user' → `seam.ask({ kind: 'question', prompt: args.question, allowFreeText: true })`, returning `{ ok: true, data: JSON.stringify(outcome) }`; mark spawn as concurrent in definitions.
   Cases:
   1. A top-level tool call receives surface 'top' and caller { sessionKey: 'workspace/<id>', depth: 0, phase, kind: {kind:'workspace'} }.
   2. Spawn: parent calls spawn_subagent, child replies; the parent's tool result carries the reply; `<baitonDir>/chat/<id>.children/<leaf>.jsonl` exists with the task as first user record; the final setSessions lists the parent then the child with parentId=<id>, depth 1.
   3. Live posts: with the parent in view, the child's task text and child deltas are never posted as appendMessage/streamDelta. While the child hangs (busy), `selectSession` of the child is accepted → setReadOnly true + renderConversation with the child's records; a child delta/append is now posted; selecting an unrelated existing session while busy posts showError 'Wait for the current run to finish'; selecting the parent again posts setReadOnly false and renderConversation from the parent transcript.
   4. Forwarded ask: the child calls ask_user → one showIntervention (pending, prompt starts 'Sub-agent') posted while the parent is in view; answering via `answerIntervention` resumes the child; the parent transcript has one settled intervention record; the child transcript has an intervention record with `forwarded: true`. With the child in view when the ask is raised, no showIntervention is posted until switching back to the parent (repost).
   5. Stop: child hangs with a forwarded ask pending → `stop` → resolveIntervention declined with STOP_DECLINE_REASON posted, settled record in the parent transcript, askRegistry.size === 0, busy ends false, `controller.subAgents.list()` shows nothing running.
   6. Reload: a second controller over the same dirs with sessionMemory returning the child id → start() posts setSessions with the tree, setActiveSession = child id, setReadOnly true; sendText then produces no completion request; deleteSession of the child posts showError and leaves the file; deleteSession of the parent removes its `.children` folder.
   Use a `waitFor` poller like the other suites.

   Files: `test/chatController.subAgents.test.ts`

9. Keep the existing controller suites green and pin the new contract

   Run test/chatController.interventions.test.ts and test/chatController.mode.test.ts (and autoMode/compaction) after the changes. Expected touch points: posts now include `setReadOnly` from refresh, setSessions comes from listTree, and the stop path settles cards before aborting — fix any assertion that pinned an exact post sequence without weakening its intent. Add to chatController.interventions.test.ts one case: an ask raised while a send is running is persisted to the running session's transcript even after the user selected a different allowed view (or, minimally, that a card raised with an `origin` whose rootKey is the running session lands in that session's transcript and is shown when it is in view). Add to chatController.mode.test.ts an assertion in 'derives the phase, tool surface and prompt from the mode' (or a new small case) that the fake registry's `call` received surface 'top' and a caller whose `phase` equals the derived phase and whose depth is 0 (the fake registry must emit one tool call for this; keep `phases` deep-equal assertions unchanged — no extra toolsFor calls may be introduced for top-level sessions).

   Files: `test/chatController.interventions.test.ts`, `test/chatController.mode.test.ts`

## Risks

- The runner's abort listener rejects a sub-agent's pending asks through asks.reject without touching the controller's card map, so a stop that aborts before resolving would leave a pending card on screen and an unsettled record; onStop must resolve/settle by id snapshot before aborting.
- presentIntervention for a non-forwarded ask previously wrote to the active session of the scope; while busy the active session may now be a child, so asks raised during a run must be bound to the running session or they would be written into a read-only child transcript.
- Changing repostPendingCards/visibility from scope-wide to per-session could hide promote/draft cards that tests expect after switching sessions; only cards with an explicit sessionKey (forwarded or raised during a run) should use per-session visibility.
- Gating live posts on viewKey() changes behaviour only when the view differs from the running session; any existing test that switches spec/session mid-run and expected posts may need adjustment.
- Late binding in commands.ts: if the registry is called before the controller exists, spawn/send refuse with a clear reason and asks go to the base seam without origin stamping; make sure the forwarder variable is reassigned after controller construction, not inside chatWebview.onResolve.
- SessionStore.listTree skips children of a parent with no transcript; a spawn always follows the parent's user append, but a child row only appears after the child's first append, hence posting sessions on the child's first 'user' appended event.
- seedContextEstimate on a child would call toolsFor and could break the mode suite's exact `phases` assertions; skip it for read-only children.

## Acceptance

- npm run compile passes with no errors.
- npm run lint reports no new errors (the pre-existing `_legacy` warning in webviewProtocol.ts is allowed).
- npm test passes, including the new test/chatController.subAgents.test.ts and the updated chatController.interventions/mode suites.
- Top-level tool calls from the controller pass surface 'top' and a caller { sessionKey: '<scopeId>/<sessionId>', depth: 0, phase, kind, signal }.
- commands.ts passes a SubAgentSeam (forwarding to chatController.subAgents) into the chat registry's ToolServices and wraps the intervention seam with the runner's origin-stamping seam after the controller is built.
- A sub-agent's ask_user card is shown on and persisted to the parent (root) transcript; the child transcript gets only the runner's forwarded note.
- Stop on a running parent aborts every descendant, settles every pending card as declined with STOP_DECLINE_REASON, and leaves the ask registry empty.
- streamDelta/appendMessage/updateTool are posted only for the session in view; switching sessions re-renders from the transcript.
- While busy, selecting the running session or its descendants is accepted and anything else is refused with 'Wait for the current run to finish'.
- The session list is the tree (listTree); selecting or reloading into a child posts setReadOnly true, and the host refuses send, compact and delete on a child.
- No `vscode` import is added to src/orchestrator/, src/engine/, src/journal/ or src/git/; chatController.ts remains vscode-free.
