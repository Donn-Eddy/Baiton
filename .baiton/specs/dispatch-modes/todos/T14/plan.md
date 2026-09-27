# Plan T14

## Steps

1. Add the new imports and the mode/run-activity state to ChatController

   In src/activation/chatController.ts:

   1. Extend the value import from '../orchestrator' (the existing `import { MissingConfigError, ... } from '../orchestrator';` block) with nothing new, and add two NEW import statements after it:
      - `import { DEFAULT_MODE, isRunMode, type RunMode } from '../model/mode';`
      - `import type { RunFinding, RunManifest, RunPipelineEvent, RunPipelineOutcome, Unsubscribe } from '../engine';` (type-only, so no vscode/engine runtime coupling; `RunFinding`, `RunPipelineEvent`, `RunPipelineOutcome` come from src/engine/runPipeline.ts, `RunManifest` from src/engine/runStore.ts, `Unsubscribe` from src/engine/resultWatcher.ts, all re-exported by src/engine/index.ts).
      - Add `ConfirmRequest`, `QuestionRequest`, `StartRunOutcome`, `RunPipelineSeam` to the existing `import type { ... } from '../orchestrator';` block (all are exported through src/orchestrator/index.ts via ./interventions and ./seams).

   2. Add private fields to the class, next to the existing `private autoMode = false;`:
      - `/** The Workspace conversation's mode; seeded from `modeMemory`, echoed to the view. */ private mode: RunMode = DEFAULT_MODE;`
      - `/** Whether a spec-less run is in flight; mirrored to the view as `setRunActive`. */ private runActive = false;`
      - `/** The run-pipeline change subscription taken in `start()`. */ private runsSub: Unsubscribe | undefined;`
      - `/** Run ids whose finding already produced a promote card, so it is posted once. */ private readonly promoted = new Set<string>();`

   3. In the constructor, after `this.autoMode = deps.autoModeMemory?.get() ?? false;` add:
      `const stored = deps.modeMemory?.get(); this.mode = stored !== undefined && isRunMode(stored) ? stored : DEFAULT_MODE;`
      (validating host-side means an unknown/stale `workspaceState` value silently falls back to Spec rather than poisoning the phase.)

   4. Extend the file's header doc-comment responsibility list with two bullets: owning the conversation mode (host-authoritative, `workspaceState`-backed, pinned to Spec on a spec conversation, and the source of the phase/prompt per send) and mirroring run activity plus posting a run's completion note and an Investigate promote card.

   Files: `src/activation/chatController.ts`

2. Add the three new deps: ModeMemory, RunActivitySource and the run-pipeline seam

   Still in src/activation/chatController.ts, beside `AutoModeMemory`:

   1. `export interface ModeMemory { /** The remembered mode value, or `undefined` when nothing was stored. */ get(): string | undefined; /** Remember the new mode. */ set(mode: RunMode): Promise<void>; }` — `get()` returns the raw `string | undefined` (not `RunMode`) exactly as `SessionMemory.get` does, so the host binds it straight to `context.workspaceState.get<string>('baiton.chat.mode')` and the controller owns validation.

   2. `export interface RunActivitySource { /** Whether a run is in flight right now (seeds the first paint). */ isRunning(): boolean; /** Subscribe to the pipeline's change events; the returned function unsubscribes. */ onChange(listener: (event: RunPipelineEvent) => void): Unsubscribe; }` — structurally satisfied by the `RunPipeline` created by `createRunPipeline`, so the host passes the pipeline itself.

   3. Add to `ChatControllerDeps` (all optional, so every existing construction site and test keeps compiling):
      - `/** Persists the composer's Mode select across windows (`baiton.chat.mode`). Absent, the mode still works for the life of the controller but starts at Spec on every reload. */ modeMemory?: ModeMemory;`
      - `/** The spec-less run pipeline's activity/events. Absent, `runActive` stays false, no completion note is posted and no promote card appears. */ runs?: RunActivitySource;`
      - `/** Dispatches a run confirmed from an Investigate promote card. Absent, no promote card is posted (there would be nothing to act on). */ runPipeline?: RunPipelineSeam;`
      Document on `runs` that the controller subscribes in `start()` and unsubscribes in `dispose()`, and that a host that also binds `RunPipelineDeps.onFinding` to `promoteFinding` gets no duplicate card because `promoted` dedupes per run id.

   Files: `src/activation/chatController.ts`

3. Handle the inbound setMode message and echo it host-authoritatively

   1. In `handle(msg)`, add a case beside `case 'setAutoMode':`:
   ```ts
   case 'setMode':
     await this.onSetMode(msg.mode);
     return;
   ```
   (the `WebviewToHost` union already carries `{ type: 'setMode'; mode: RunMode }` from T11, so the switch stays exhaustive-by-construction.)

   2. Add `onSetMode` next to `onSetAutoMode`:
   ```ts
   private async onSetMode(mode: RunMode): Promise<void> {
     // The view is a pure projection: every one of these paths ends in an echo,
     // so the control can never hold a value the host did not choose.
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
   ```
   Doc-comment it: a spec conversation is always Spec (the mode is a property of the Workspace conversation), a mode change is refused while the chat is busy or a run is in flight, an off-union value is refused, and every refusal repaints the control from the host's own state. A memory write that fails is logged and does not undo the in-memory change.

   3. Add the two small posters used everywhere:
   ```ts
   /** The mode that actually governs the conversation in view: Spec on a spec conversation. */
   private effectiveMode(): RunMode {
     return this.activeSpec === undefined ? this.mode : DEFAULT_MODE;
   }

   /** Repaint the composer's Mode select from the host's state. */
   private postMode(): void {
     this.deps.webview.post({ type: 'setMode', mode: this.effectiveMode() });
   }

   /** Mirror run activity to the view (the Mode select and nothing else gate on it today). */
   private postRunActive(): void {
     this.deps.webview.post({ type: 'setRunActive', active: this.runActive });
   }
   ```

   Files: `src/activation/chatController.ts`

4. Post mode and run activity on every refresh

   In `refresh()`, immediately after the existing `this.deps.webview.post({ type: 'setAutoMode', enabled: this.autoMode });` add:
   ```ts
   this.postMode();
   this.postRunActive();
   ```
   This is what pins a spec conversation: `onSelectConversation`/`setActiveSpec` already call `refresh()`, so selecting a spec repaints the select as Spec (disabled by the view, which knows the conversation id) and selecting Workspace again repaints it with the remembered mode. It also means the first `start()` paints the seeded mode, so a window reload comes back in the mode the user left the Workspace conversation in.

   Files: `src/activation/chatController.ts`

5. Pick the phase, the tools and the prompt per mode

   1. `phaseForConversation` — pass the mode for a workspace conversation:
   ```ts
   private async phaseForConversation(slug: string | undefined): Promise<OrchestratorPhase> {
     if (slug === undefined) {
       return phaseFor({ kind: 'workspace' }, undefined, this.effectiveMode());
     }
     return phaseFor({ kind: 'spec', slug }, await this.readSpec(slug));
   }
   ```
   The spec branch deliberately passes no mode, so an approved spec still maps to `drive` and a draft to `gather` exactly as today.

   2. `buildPrompt` — take the mode as a parameter rather than re-reading the field, so a send's prompt is fixed for the whole loop the way its phase already is:
   ```ts
   private async buildPrompt(slug: string | undefined, mode: RunMode): Promise<string> {
     const kind: ConversationKind = slug === undefined ? { kind: 'workspace' } : { kind: 'spec', slug };
     if (slug === undefined) {
       return buildSystemPrompt(kind, undefined, mode);
     }
     const specContent = await this.readSpec(slug);
     return buildSystemPrompt(kind, specContent);
   }
   ```
   (For `mode === 'spec'` on a workspace conversation `buildSystemPrompt(kind, undefined, 'spec')` is byte-identical to today's `buildSystemPrompt(kind)` — the third argument defaults to `DEFAULT_MODE`.)

   3. In `onSend`, capture the mode next to the phase, before anything is appended:
   ```ts
   const mode = this.effectiveMode();
   const phase = await this.phaseForConversation(slug);
   ```
   and change the tool-loop option to `systemPrompt: () => this.buildPrompt(slug, mode),`. Update the surrounding comment to say the mode, like the phase, is fixed for this send: the Mode select is refused while busy, so this only documents the invariant.

   The already-correct `tools: this.deps.toolsFor(phase)` and `call: (...) => this.callTool(..., phase)` now carry `'run'` for a spec-less Workspace conversation, so the run-phase tool surface (read tools, `ask_user`, `start_run`, `investigate`) is both advertised and the only thing the registry will run.

   Files: `src/activation/chatController.ts`

6. Subscribe to the run pipeline: mirror activity, note completion, promote a finding

   1. In `start()`, after the provider-selection subscription, add:
   ```ts
   this.runsSub?.();
   this.runActive = this.deps.runs?.isRunning() ?? false;
   this.runsSub = this.deps.runs?.onChange((event) => { void this.onRunEvent(event); });
   ```
   (`start()` is called again on every fresh webview resolve, hence the unsubscribe-first.)

   2. In `dispose()`, add `this.runsSub?.(); this.runsSub = undefined;` beside the provider unsubscribe.

   3. Add the event handler:
   ```ts
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
     await this.noteSystem(note);
     if (event.outcome.finding !== undefined) {
       await this.promoteFinding(event.outcome.finding);
     }
   }
   ```
   `noteSystem` already refreshes, which re-posts `setMode`/`setRunActive`, so the composer repaints with the run finished.

   4. Add the exported pure note builder at module scope beside the other helpers, so the wording is assertable without a controller:
   ```ts
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
   ```

   Files: `src/activation/chatController.ts`

7. The Investigate promote card and the run confirm card it raises

   Add a public method (public so a host may instead bind it to `RunPipelineDeps.onFinding`; `promoted` makes both paths safe) plus two exported pure request builders.

   1. Builders at module scope:
   ```ts
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

   /** The run confirm card a promoted finding raises; the same shape `start_run` shows. */
   export function promoteRunConfirm(mode: RunMode, statement: string, files: readonly string[], branch: string): ConfirmRequest {
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
   ```
   The detail lines intentionally mirror `startRunTool`'s card text in src/orchestrator/controlTools.ts (Mode / Work / Files / Target branch + the same closing sentence) so a promoted run reads identically to a model-dispatched one. The branch comes from `finding.manifest.baseBranch` — the branch that was checked out when the investigation started — so no git call is needed here.

   2. The method:
   ```ts
   /**
    * Offer to promote an Investigate finding into a Bug or Quick run. The promote
    * card is posted once per run id; choosing a mode raises the ordinary run
    * confirm card, and only an approval dispatches — a dismissal, a decline or a
    * typed answer writes nothing and dispatches nothing. A no-op without the
    * dispatch seam or in Restricted Mode, where a note stands in for the card.
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
     const confirmed = await this.askCard(promoteRunConfirm(mode, finding.finding, files, finding.manifest.baseBranch));
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

   /** Raise one ask through this controller's own registry and card machinery. */
   private async askCard(request: QuestionRequest | ConfirmRequest): Promise<InterventionAnswer> {
     const { intervention, answer } = this.asks.create(request);
     try {
       await this.presentIntervention(intervention);
     } catch (err) {
       this.asks.reject(intervention.id, `the ask could not be shown: ${describe(err)}`);
     }
     return answer;
   }
   ```
   Note `intervention.scopeId` is deliberately left unset, so `scopeForAsk` keeps the card on the conversation in view rather than treating `'workspace'` as a spec slug. `this.asks.create` + `presentIntervention` reuses the existing card/transcript/settle path verbatim (a stop declines the card like any other), so nothing new is needed in the view.

   3. The dispatch note helper at module scope:
   ```ts
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
   ```
   `InterventionAnswer` is already imported in the type block; add `QuestionRequest`/`ConfirmRequest`/`StartRunOutcome` there per step 2.

   Files: `src/activation/chatController.ts`

8. Write test/chatController.mode.test.ts

   New file, modelled on test/chatController.autoMode.test.ts: a static `import { ChatController } from '../src/activation/chatController';` with no vscode loader hook (proving the controller stays host-free), a `FakeWebview` (copy the `post`/`onMessage`/`send`/`last`/`all` class verbatim — the repo keeps such harnesses file-local), a `FakeModelClient` capturing `requests` so the system prompt can be asserted, a temp `.baiton`/`.baiton/specs` per test via `fs.mkdtempSync` + `rmSync` cleanup, and a `buildHarness({ storedMode?, restricted?, withRuns?, withPipeline? })` that records `toolsFor` phases into `phases: OrchestratorPhase[]`, `modeMemory.set` calls into `modeSets: RunMode[]`, and pipeline `start` calls into `startCalls: StartRunRequest[]`. Add a `FakeRuns implements RunActivitySource` with `running = false`, `emit(event: RunPipelineEvent)` fanning out to its listeners, and an `onChange` returning an unsubscriber that records disposal. Build manifests/outcomes with small factories (`manifest(overrides)` returning a `RunManifest` with `version: 1`, `id`, `mode`, `composerMode`, `explicitMode: false`, `statement`, `files: []`, `baseBranch: 'main'`, `baseHead: 'abc1234'`, `branch: 'baiton/bug/<id>'`, `state`, zeroed `attempts`, timestamps; `finding(overrides)` returning a `RunFinding`). Use the `waitFor(condition, what)` poller from the auto-mode suite for the fire-and-forget paths, and `readTranscript(path.join(baitonDir, 'chat', '<id>.jsonl'))` — resolve the file by listing `.baiton/chat` — to assert appended `system` records.

   Cases (one `it` each, in a `describe('ChatController conversation mode (dispatch-modes T14)')`):
   1. Seeds from memory: `storedMode: 'bug'` → the first `start()` posts `setMode { mode: 'bug' }` and `setRunActive { active: false }`.
   2. An absent value and an off-union value (`'nonsense'`) both seed Spec, and neither writes to the memory.
   3. `setMode` from the view is echoed and persisted: `send({ type: 'setMode', mode: 'refactor' })` → last `setMode` is `refactor`, `modeSets` is `['refactor']`.
   4. A repeated `setMode` for the current mode echoes but does not persist again.
   5. An off-union `setMode` (cast through `as never`) is refused: the echo carries the unchanged mode and `modeSets` stays empty.
   6. A spec conversation is pinned: `setActiveSpec('alpha')` → the refresh posts `setMode { mode: 'spec' }`; a `setMode 'bug'` there echoes `spec` and persists nothing; `setActiveSpec(undefined)` repaints the remembered mode.
   7. Refused while busy: with a slow `FakeModelClient` in flight, `setMode` echoes the unchanged mode and persists nothing.
   8. Refused while a run is in flight: emit a `started` event, then `setMode` → unchanged echo, no persist.
   9. Phase and prompt per mode: with mode `bug`, a send records phase `'run'` in `phases` and the request's system message equals `buildSystemPrompt({ kind: 'workspace' }, undefined, 'bug')`; with mode `spec` it records `'gather'` and the prompt equals `buildSystemPrompt({ kind: 'workspace' })` byte for byte.
   10. A spec conversation ignores a non-spec mode: `storedMode: 'quick'` + `setActiveSpec('alpha')` (with a `spec.md` written on disk) → phase `'gather'`/`'drive'` per the spec's status and the prompt equals `buildSystemPrompt({ kind: 'spec', slug: 'alpha' }, content)`.
   11. Run activity: `started`/`stage-started`/`stage-completed` post `setRunActive { active: true }` once (no duplicate posts for consecutive active events), `completed` posts `{ active: false }`.
   12. Completion note: a `completed` event with `state: 'done'` appends one `system` record equal to `runCompletionNote(outcome, manifest)` on the Workspace transcript; a `failed` one also reaches `log`.
   13. Promote card: a `completed` investigate whose outcome carries a `finding` posts a `showIntervention` question card whose options are `bug`, `quick`, `dismiss`; answering the option `bug` posts the confirm card with `promoteRunConfirm('bug', finding.finding, files, 'main')`'s prompt/detail; approving it calls `runPipeline.start` exactly once with `{ mode: 'bug', statement: <finding>, files: <finding.files> }` and appends the `startedRunNote` system record.
   14. `dismiss` dispatches nothing; declining the confirm card dispatches nothing; a `busy` outcome appends the busy note and nothing else.
   15. The promote card is posted once per run id (emit the same `completed` event twice) and is skipped entirely when `runPipeline` is absent.
   16. Restricted Mode (`guardContext: () => ({ restricted: true }) as GuardContext`) posts no promote card and appends the Restricted-Mode note.
   17. `dispose()` unsubscribes: a later emitted event posts no further `setRunActive`, and a second `start()` leaves exactly one live subscription (assert the fake's listener count).

   Files: `test/chatController.mode.test.ts`

9. Verify

   Run, from the repo root, in order: `npm run compile`, `npm run lint`, `npm test`. Compile must be clean; lint must report 0 errors (the single pre-existing `'_legacy' is assigned a value but never used` warning in src/orchestrator/webviewProtocol.ts stays, untouched); the full suite must pass with no previously passing test failing and no existing test file edited except the new one. Expect ~1959 passing plus the new cases. Do not modify src/activation/commands.ts, media/*, src/orchestrator/* or any existing test — the host wiring of `modeMemory`, `runs`, `runPipeline` and the `run`-phase entry of `toolsByPhase` is a later todo.

   Files: (none)

## Risks

- src/activation/commands.ts builds `toolsByPhase` with only the `gather` and `drive` entries (commands.ts:618) and reads it through `?? []`, so until the host wiring todo lands a run-mode send advertises an empty tool list. That is expected and must not be fixed here: this todo must not touch commands.ts.
- The three new deps are optional, so no existing ChatController construction site or test needs changing. Making any of them required would break commands.ts and both existing chatController suites.
- `Intervention.scopeId` is 'workspace' or a spec slug, and `scopeForAsk` treats any value other than `undefined`/the active spec as a spec slug to switch to. The promote and confirm cards must therefore leave `scopeId` unset, or answering one would try to activate a spec named 'workspace'.
- `presentIntervention` runs the Auto-mode gate only for `kind: 'permission'`, so the promote question and the run confirm are never auto-approved. Do not reshape them as permission asks.
- `promoteFinding` awaits two user answers; a stop declines pending asks, which resolves them as `declined`, so the method returns without dispatching. Nothing should be dispatched on a `text` or `declined` answer — assert this in the tests.
- `noteSystem` appends to the newest Workspace session (`listed[0]`), not necessarily the one in view. That is existing behaviour shared with the spec-draft note; do not change it in this todo.
- The mode must be captured once per send (into a local, alongside the phase) rather than re-read from the field inside the `systemPrompt` thunk, so a mode change could never shift the prompt mid-loop.
- A `modeMemory.set` rejection must be caught and logged only: undoing the in-memory mode would desync the already-posted echo.

## Acceptance

- A controller constructed with a `modeMemory` reading 'bug' posts `setMode { mode: 'bug' }` and `setRunActive { active: false }` on its first refresh; an absent or off-union stored value posts 'spec'.
- An inbound `setMode` on the Workspace conversation with no run in flight and the chat idle is echoed as `setMode` with that mode and persisted through `modeMemory.set`; a repeated, off-union, busy-time or run-time `setMode` echoes the unchanged effective mode and persists nothing.
- While a spec conversation is active the controller posts and enforces `spec`: `setMode` there changes and persists nothing, and returning to the Workspace conversation repaints the remembered mode.
- A send on a spec-less Workspace conversation resolves phase `'run'`, advertises `toolsFor('run')`, passes `'run'` into every registry call, and builds `buildSystemPrompt({ kind: 'workspace' }, undefined, mode)`; a Spec-mode workspace send and every spec-conversation send produce byte-identical phases, tools and prompts to today's.
- Non-terminal run-pipeline events post `setRunActive { active: true }` and a `completed` event posts `{ active: false }`, with no duplicate post for consecutive events of the same activity.
- A `completed` event appends exactly one `system` transcript record equal to `runCompletionNote(outcome, manifest)` on the Workspace conversation, and a `failed` run also reaches `log`.
- A completed Investigate run whose outcome carries a finding posts one promote card offering Bug, Quick and Dismiss; choosing Bug or Quick raises a run confirm card whose prompt is `Start a <mode> run?` and whose detail carries the Mode/Work/Files/Target-branch lines, and only an approval calls `RunPipelineSeam.start` with `{ mode, statement: <the finding>, files }`.
- Dismissing the promote card, declining the confirm card, a missing `runPipeline` seam and Restricted Mode all dispatch nothing; Restricted Mode appends the explanatory system note instead, and a promote card is posted at most once per run id.
- `dispose()` unsubscribes from the run pipeline, and a repeated `start()` leaves exactly one live subscription.
- `npm run compile` is clean, `npm run lint` reports 0 errors (only the pre-existing `_legacy` warning), and `npm test` passes with every previously passing test green and only src/activation/chatController.ts and the new test/chatController.mode.test.ts changed.
