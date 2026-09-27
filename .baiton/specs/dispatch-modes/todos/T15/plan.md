# Plan T15

## Steps

1. Add createRunPipelineSeam to the engine facade

   In `src/activation/engineFacade.ts`, beside the existing `createRunQueueSeam`, export a new adapter that turns the host's `RunPipeline` into the orchestrator's `RunPipelineSeam`.

   Imports to add at the top of the file (keep them type-only where possible, since the facade must stay host-free and must not pull runtime code it does not use):
   ```ts
   import type { RunMode } from '../model/mode';
   import type { RunPipeline, RunPipelineRequest } from '../engine';
   import type { RunPipelineSeam, StartRunOutcome, StartRunRequest } from '../orchestrator';
   ```
   (`RunPipeline`, `RunPipelineRequest` are exported from `src/engine/runPipeline.ts` through the `src/engine` barrel; `RunPipelineSeam`, `StartRunRequest`, `StartRunOutcome` from `src/orchestrator/seams.ts` through the `src/orchestrator` barrel. Add the names to the existing `import type { ... } from '../engine'` / `'../orchestrator'` clauses rather than writing new ones if that reads better with the surrounding style.)

   Then:
   ```ts
   /**
    * A {@link RunPipelineSeam} for the `start_run` / `investigate` dispatch tools,
    * backed by the real run pipeline.
    *
    * The seam is narrower than {@link RunPipelineRequest} on purpose: a tool knows
    * the mode it was called with, but only the host knows what the composer's Mode
    * select said, so this adapter fills `composerMode` from the host and derives
    * `explicitMode` — true exactly when the orchestrator dispatched a mode other
    * than the one the user selected (an Investigate dispatched from a Bug
    * conversation, say).
    *
    * It resolves as soon as the run is launched: the pipeline's `completed`
    * promise is deliberately not awaited here (the chat mirrors completion through
    * `RunPipeline.onChange`), only guarded, so a rejection can never surface as an
    * unhandled rejection in the extension host.
    */
   export function createRunPipelineSeam(
     pipeline: Pick<RunPipeline, 'start'>,
     composerMode: () => RunMode,
     report?: (message: string) => void,
   ): RunPipelineSeam {
     return {
       async start(req: StartRunRequest): Promise<StartRunOutcome> {
         const composer = composerMode();
         const request: RunPipelineRequest = {
           mode: req.mode,
           composerMode: composer,
           explicitMode: req.mode !== composer,
           statement: req.statement,
           files: [...req.files],
           ...(req.reproduction !== undefined ? { reproduction: req.reproduction } : {}),
         };
         const result = await pipeline.start(request);
         if (result.ok) {
           void result.completed.catch((e: unknown) => {
             report?.(`run ${result.runId} failed: ${e instanceof Error ? e.message : String(e)}`);
           });
           return { kind: 'started', runId: result.runId, branch: result.manifest.branch };
         }
         return result.error.kind === 'busy'
           ? { kind: 'busy' }
           : { kind: 'refused', reason: result.error.message };
       },
     };
   }
   ```
   Also extend the module header comment: it currently says it binds "a stage/action trigger to the run queue"; add a sentence that it now also binds the spec-less dispatch tools to the run pipeline. Do not change `dispatchTrigger`, `STAGE_ROLE`, `createRunQueueSeam` or `actionForStage`.

   Files: `src/activation/engineFacade.ts`

2. Import the run-pipeline pieces into commands.ts

   In `src/activation/commands.ts`:

   - Add `createRunPipeline` and `createRunStore` to the value import from `'../engine'` (the list that already holds `createRunQueue`, `createSpecDraftRunner`, …), keeping it alphabetical as it is today.
   - Add `RunPipeline` to the `import type { ... } from '../engine'` clause.
   - Add `RunPipelineSeam` to the `import type { ... } from '../orchestrator'` clause.
   - Add `import { DEFAULT_MODE, isRunMode } from '../model/mode';` and `import type { RunMode } from '../model/mode';` (or a single combined import) beside the other `../model/*` imports near `import type { Role } from '../model/role';`.
   - Add `createRunPipelineSeam` to the existing named import from `'./engineFacade'`.

   Do not import `runWorktree` helpers here: `createRunWorktree` / `mergeRunWorktree` / `removeRunWorktree` are called by the pipeline and (later) by the Runs view commands, not by this wiring. The pipeline composes the worktree helper itself from `workspaceRoot` + `git`; the only thing this todo owes it is a `git` service bound to the main checkout, which `createGitService(repoRoot)` already returns as a `GitWorktreeService`.

   Files: `src/activation/commands.ts`

3. Add the workspaceState mode-memory key and a composer-mode reader

   Still in `src/activation/commands.ts`, add a module-level constant beside the other key/namespace constants near the top (`SETTINGS_NS` and friends):
   ```ts
   /** The `workspaceState` key the composer's Mode select is remembered under. */
   const CHAT_MODE_KEY = 'baiton.chat.mode';
   ```
   Inside `registerCommands`, after `const cfg = ...` / the `repoRoot`/`baitonDir`/`specsDir` block, add:
   ```ts
   /**
    * The mode the composer's Mode select currently holds. The ChatController
    * persists it under the same `workspaceState` key (see its `modeMemory` dep
    * below), so reading the key is how the run-pipeline seam learns the composer
    * mode without reaching into the controller. A stale or off-union stored value
    * falls back to Spec, exactly as the controller's own seeding does.
    */
   const composerMode = (): RunMode => {
     const stored = context.workspaceState.get<string>(CHAT_MODE_KEY);
     return stored !== undefined && isRunMode(stored) ? stored : DEFAULT_MODE;
   };
   ```

   Files: `src/activation/commands.ts`

4. Construct the run store, the run pipeline and its seam

   In `registerCommands`, immediately after `const watcherFactory = createVscodeResultWatcherFactory();` (so the pipeline exists before `queueForSlug`, whose `isExternallyBusy` closes over it) insert:

   ```ts
   // The spec-less run pipeline (design "dispatch modes"): Bug/Quick/Refactor
   // drive plan -> execute -> review in a per-run worktree, Investigate answers a
   // question read-only. It is run-scoped, so it sits beside the todo-scoped
   // queues rather than inside one, and the two exclude each other so only one
   // stage runs per repository. Manifests, journals and rendered artifacts live
   // under `.baiton/runs/<run-id>/`; nothing is written under `.baiton/specs/`.
   const runStore = createRunStore({ workspaceRoot: repoRoot });
   const runPipeline: RunPipeline = createRunPipeline({
     workspaceRoot: repoRoot,
     git,
     store: runStore,
     terminalHost,
     watcherFactory,
     askWatcherFactory,
     modelForRole: (role) => modelForRole(cfg(), role),
     adapterForRole: adapterFor,
     // Read per run off the live config, like every other config read here.
     execAttempts: () => cfg().limits.exec_attempts,
     verify: () => cfg().git.verify,
     // The other half of the one-stage-per-repository lock: a run refuses while
     // any spec queue or the spec draft has a stage in flight, and
     // `RunQueueDeps.isExternallyBusy` / `SpecDraftDeps.isQueueRunning` refuse
     // while a run does.
     isSpecBusy: () => [...queues.values()].some((q) => q.isRunning()) || specDraftRunner.isRunning(),
     onComplete: (outcome) => surface.log(`Baiton: run ${outcome.runId} ${outcome.state}: ${outcome.message}`),
     report: (detail) => surface.warn(`Baiton: ${detail}`),
   });
   const runPipelineSeam: RunPipelineSeam = createRunPipelineSeam(
     runPipeline,
     composerMode,
     (detail) => surface.warn(`Baiton: ${detail}`),
   );
   ```

   Notes for the executor:
   - `queues` and `specDraftRunner` are `const`s declared further down; the `isSpecBusy` arrow only runs when a run is started, so the reference is fine — this is the same pattern the existing `isExternallyBusy: () => specDraftRunner.isRunning()` already uses at the queue site. Do NOT move the pipeline construction below `specDraftRunner`: `buildToolServices` (which needs `runPipelineSeam`) is called to build `draftServices` before the runner exists.
   - `git` here is `createGitService(repoRoot)`, which returns a `GitWorktreeService`, so it satisfies `RunPipelineDeps.git` with no cast. Move the pipeline block after `const git = ...`/`const terminalHost = ...`/`const adapterFor = ...` if the current order puts any of them later.
   - Do NOT bind `onFinding`: the ChatController mirrors findings through its `runs` subscription (`{ kind: 'completed' }` carrying `outcome.finding`) and dedupes the promote card per run id, so binding both sinks would only add a second path to the same card.
   - Do not register a disposable that cancels the run on deactivate: the todo-scoped queues are not torn down that way either, and a cancelled run would lose its in-flight stage on a window reload.

   Files: `src/activation/commands.ts`

5. Widen the queue's one-stage lock to include a run

   In `queueForSlug`'s `createRunQueue({ ... })` call, replace
   ```ts
         // A spec draft holds the same one-stage-per-repository lock (Req 20.1).
         isExternallyBusy: () => specDraftRunner.isRunning(),
   ```
   with
   ```ts
         // A spec draft and a spec-less run hold the same one-stage-per-repository
         // lock (Req 20.1); the run pipeline's `isSpecBusy` is the mirror of this.
         isExternallyBusy: () => specDraftRunner.isRunning() || runPipeline.isRunning(),
   ```
   Leave `specDraftRunner`'s own `isQueueRunning` reading the queues only if it already also excludes runs; it does not today, so also widen it at the `createSpecDraftRunner({ ... })` call:
   ```ts
       isQueueRunning: () => [...queues.values()].some((q) => q.isRunning()) || runPipeline.isRunning(),
   ```
   with a one-line comment naming the run pipeline as the third holder of the lock. Nothing else in either construction changes.

   Files: `src/activation/commands.ts`

6. Supply the RunPipelineSeam through buildToolServices

   `ToolServices.runPipeline` is optional today and nothing fills it, so `start_run` / `investigate` refuse for want of a seam. Fill it at the single place both tool-services bundles are built.

   In the `buildToolServices(...)` declaration near the bottom of `src/activation/commands.ts`, add one trailing parameter after `intervention: InterventionSeam`:
   ```ts
     runPipeline: RunPipelineSeam,
   ```
   and add `runPipeline,` to the returned object literal (beside `runQueue: createRunQueueSeam(...)`). Extend its doc comment to mention the run-pipeline seam alongside the run-queue seam.

   Then pass `runPipelineSeam` as the new last argument at BOTH call sites inside `registerCommands`:
   - the `const draftServices = buildToolServices(repoRoot, baitonDir, git, queueForSlug, specsDir, adapterFor, submitPrForSlug, confirm, interventionSeam)` call, and
   - the `createToolRegistry({ ...buildToolServices(repoRoot, baitonDir, git, queueForSlug, specsDir, adapterFor, submitPrForSlug, confirm, interventionSeam), draftSpec: { ... } })` call.

   Do not add a separate `runPipeline:` key to the `createToolRegistry` object literal — it now arrives through the spread.

   Files: `src/activation/commands.ts`

7. Advertise the run phase's tool set

   In `registerCommands`, extend the per-phase map so a run-mode send is not handed an empty tool list (T14 left this as the known gap):
   ```ts
     const toolsByPhase = new Map<OrchestratorPhase, ToolSpec[]>([
       ['gather', specsForPhase(registry, specsByName, 'gather')],
       ['drive', specsForPhase(registry, specsByName, 'drive')],
       ['run', specsForPhase(registry, specsByName, 'run')],
     ]);
   ```
   Update the comment above it: the orchestrator now has three jobs — gathering requirements for a spec, driving an approved one, and dispatching a spec-less run (the read tools, `ask_user`, `start_run` and `investigate`). `specsForPhase` is already phase-generic and `registry.definitionsFor('run')` already returns the run-phase tools, so no other change is needed here.

   Files: `src/activation/commands.ts`

8. Wire the ChatController's mode memory, run activity and dispatch seam

   In the `new ChatController({ ... })` call, after the existing `autoModeMemory: { ... }` entry, add the three deps T14 introduced as optional:
   ```ts
         // The composer's Mode select is remembered per workspace, so a window
         // reload comes back in the mode the user left it in. Same key the
         // `composerMode` reader above uses, never `settings.json`.
         modeMemory: {
           get: () => context.workspaceState.get<string>(CHAT_MODE_KEY),
           set: async (mode) => {
             await context.workspaceState.update(CHAT_MODE_KEY, mode);
           },
         },
         // Run activity: the controller mirrors it to the view (the Mode select is
         // disabled while a run is in flight), posts a system note when a run
         // completes, and posts the Investigate promote card.
         runs: runPipeline,
         // A Bug/Quick choice on that promote card dispatches through the same
         // seam the `start_run` tool uses.
         runPipeline: runPipelineSeam,
   ```
   `RunPipeline` structurally satisfies `RunActivitySource` (`isRunning()` + `onChange()`), so pass the pipeline itself with no adapter. The controller takes and releases the `onChange` subscription in its own `start()`/`dispose()`, both of which are already wired here (`chatWebview.onResolve(() => chatController.start())` and the `new vscode.Disposable(() => chatController.dispose())` push), so no new disposable is needed.

   Files: `src/activation/commands.ts`

9. Include an in-flight run in runningSlugs

   In the object `registerCommands` returns, extend `runningSlugs` so a config save made while a run is in flight reports it in the in-flight note, exactly as a spec draft already is:
   ```ts
       runningSlugs: () => {
         const running = [...queues.entries()]
           .filter(([, q]) => q.isRunning())
           .map(([slug]) => slug);
         if (specDraftRunner.isRunning()) {
           running.push('(spec draft)');
         }
         const runId = runPipeline.currentRunId();
         if (runId !== undefined) {
           running.push(`(run ${runId})`);
         }
         return running;
       },
   ```
   These entries are joined into `IN_FLIGHT_NOTE`'s prose (`src/activation/configRefresh.ts`), so the parenthesised label matches the existing `'(spec draft)'` convention. Use `currentRunId()` rather than `isRunning()` so the note names which run. Also add `baiton.runsView`-free: nothing else in this todo touches `package.json`.

   Files: `src/activation/commands.ts`

10. Update the commands.ts module header

   The file header enumerates what the module registers. Add one bullet (or extend the chat bullet) recording that the module now also constructs the run store and the spec-less run pipeline, supplies the `RunPipelineSeam` to the tool registry and the chat's promote flow, remembers the composer mode in `workspaceState`, and holds the one-stage-per-repository lock jointly across the todo queues, the spec draft and the run pipeline. Keep the existing wording of every other bullet untouched.

   Files: `src/activation/commands.ts`

11. Test the seam adapter in test/activation.gating.test.ts

   `commands.ts` imports `vscode` and cannot be unit-tested, so the host-free half of this todo — the seam adapter — is what the tests pin. Append a new `describe` block to `test/activation.gating.test.ts` (do not touch any existing block, assertion or the file's header coverage list beyond adding the new bullets to it).

   Add the import:
   ```ts
   import { createRunPipelineSeam } from '../src/activation/engineFacade';
   import type { RunPipelineRequest, RunPipelineStart } from '../src/engine/runPipeline';
   ```
   A local fake pipeline, in the style of the doubles in `test/engineFacade.resume.test.ts`:
   ```ts
   /** A `RunPipeline.start` double that records its request and answers a scripted result. */
   function fakePipeline(answer: RunPipelineStart) {
     const requests: RunPipelineRequest[] = [];
     return {
       requests,
       start: async (req: RunPipelineRequest): Promise<RunPipelineStart> => {
         requests.push(req);
         return answer;
       },
     };
   }
   ```
   plus a tiny `startedResult(runId, branch, completed)` helper building `{ ok: true, runId, manifest: { ... } as RunManifest, completed }` — only `manifest.branch` is read, so cast a minimal literal rather than hand-building a whole manifest (or import `RunManifest` and fill it; either is fine as long as `tsc --noEmit` is clean).

   Cases (`describe('createRunPipelineSeam', ...)`):
   1. A started run maps to `{ kind: 'started', runId, branch }` taking the branch from the manifest.
   2. `composerMode` is read per call and copied onto the request; `explicitMode` is `false` when `req.mode === composerMode()` (e.g. both `'bug'`).
   3. `explicitMode` is `true` when they differ — `investigate` dispatched while the composer says `bug` — and `composerMode` still records `'bug'`.
   4. `files` is copied, not aliased: mutating the caller's array after `start` resolves does not change the array the pipeline received.
   5. `reproduction` is omitted from the request when the caller omits it (assert `'reproduction' in request === false`, so an explicit `undefined` never reaches `exactOptionalPropertyTypes`-checked code) and forwarded when present.
   6. `{ ok: false, error: { kind: 'busy', message } }` maps to `{ kind: 'busy' }` with no reason leaked.
   7. Each other refusal kind (`invalid-mode`, `detached-head`, `no-base-head`, `manifest`, `worktree`) maps to `{ kind: 'refused', reason: <the error message> }`.
   8. A rejecting `completed` promise is swallowed: the seam still resolves `started`, and the injected `report` receives a message naming the run id. Await a macrotask (`await new Promise((r) => setTimeout(r, 0))`) before asserting, and assert no unhandled rejection by virtue of the test completing.
   9. `report` being absent is safe: same rejecting `completed`, no `report` passed, the seam still resolves `started`.

   Then extend the file's top-of-file coverage comment with a `createRunPipelineSeam:` bullet summarising the above.

   Files: `test/activation.gating.test.ts`

12. Verify

   Run, from the repository root:
   - `npm run compile` and `npx tsc -p . --noEmit` — both clean. Expect tsc to be the thing that catches a missed `buildToolServices` call site and a missed `toolsByPhase` entry type.
   - `npx mocha test/activation.gating.test.ts` (it picks up the project's mocha config and runs the whole suite).
   - `npm run lint` — 0 errors; the only acceptable warning is the pre-existing `'_legacy' is assigned a value but never used` at `src/orchestrator/webviewProtocol.ts:591`.
   - `npm test` — the T14 baseline of 1994 passing / 1 pending / 0 failing plus the new cases; 0 failing.
   - `git status --porcelain` — exactly the three files of this todo, and no `.baiton/runs/` or `.baiton/worktrees/` residue.
   - `grep -n "runPipeline\|runStore\|CHAT_MODE_KEY\|'run'" src/activation/commands.ts` to eyeball that every wiring point landed.

   Files: `src/activation/commands.ts`, `src/activation/engineFacade.ts`, `test/activation.gating.test.ts`

## Risks

- Declaration order inside `registerCommands`: the pipeline must be constructed before `queueForSlug` (whose `isExternallyBusy` names it) and before the first `buildToolServices` call (which needs its seam), while its own `isSpecBusy` names `queues` and `specDraftRunner`, which are declared later. That mutual reference is only safe because every one of these is a lazily-invoked arrow. If the executor instead evaluates any of them at construction time — e.g. by capturing `[...queues.values()]` eagerly — the result is a TDZ `ReferenceError` at activation. The existing `isExternallyBusy: () => specDraftRunner.isRunning()` is the precedent to follow.
- `composerMode` reads the same `workspaceState` key the ChatController writes through `modeMemory`. Both must use the one `CHAT_MODE_KEY` constant; a literal typed twice would silently give every run `composerMode: 'spec'` and `explicitMode: true`. Note also that the key reflects the *remembered* mode, which is the composer's value for the Workspace conversation; on a spec conversation the controller pins the effective mode to Spec without changing the stored value, but a spec conversation cannot reach `start_run` at all (the tools are run-phase only), so the discrepancy is unobservable.
- `RunPipelineDeps.execAttempts`/`verify` must be read per call off `cfg()`, never destructured at wiring time — the config object is replaced wholesale on save, and a captured copy would pin a run to a stale `limits.exec_attempts`.
- Binding both `RunPipelineDeps.onFinding` and the ChatController's `runs` subscription would route one finding to the promote flow twice. The controller dedupes per run id so the card would still appear once, but the plan deliberately binds only `runs`; if the executor adds `onFinding` too, it must point at `chatController.promoteFinding` and nothing else, and must be bound late (the controller does not exist yet at pipeline construction).
- `ToolServices.runPipeline` is optional, so forgetting either `buildToolServices` call site compiles fine and only shows up as `start_run` refusing at runtime. The plan's fix is to make the parameter required on `buildToolServices` so tsc names both sites.
- `test/activation.gating.test.ts` is an existing acceptance-style file; only appending a new `describe` (and new bullets to its header comment) is permitted. Do not touch the packaging assertions — `package.json` is out of scope for this todo, so a Runs-view contribution assertion added here would fail.
- The pipeline's `completed` promise is not awaited anywhere in the host. `drive` catches stage failures, but `finishRun` itself can throw (a failed manifest write), which would reject `completed`; the seam's `.catch` is what keeps that from becoming an unhandled rejection in the extension host. Do not drop it as dead code.

## Acceptance

- `src/activation/engineFacade.ts` exports `createRunPipelineSeam(pipeline, composerMode, report?)` returning a `RunPipelineSeam`; it fills `composerMode` from the injected reader, sets `explicitMode` to `req.mode !== composerMode()`, copies `files`, forwards `reproduction` only when present, maps `ok` to `{ kind: 'started', runId, branch: manifest.branch }`, `busy` to `{ kind: 'busy' }` and every other refusal to `{ kind: 'refused', reason: error.message }`, and guards the `completed` promise against rejection.
- `registerCommands` constructs a `RunStore` over `repoRoot` and a `RunPipeline` over the shared `git`, `terminalHost`, `watcherFactory`, `askWatcherFactory`, `modelForRole` and `adapterFor`, with `execAttempts` and `verify` read per call from `cfg()`.
- The one-stage-per-repository lock holds in both directions: the run queue's `isExternallyBusy` returns true while the run pipeline is running, the spec-draft runner's `isQueueRunning` does too, and the pipeline's `isSpecBusy` returns true while any spec queue or the spec draft is running.
- `toolsByPhase` has a `'run'` entry built with `specsForPhase(registry, specsByName, 'run')`, so a run-mode send advertises the read tools, `ask_user`, `start_run` and `investigate` instead of an empty list.
- Both `buildToolServices` call sites pass the run-pipeline seam, so `ToolServices.runPipeline` is populated for the registry and for the spec-draft sub-agent's services.
- The `ChatController` is constructed with `modeMemory` over the `baiton.chat.mode` workspaceState key, `runs: runPipeline` and `runPipeline: runPipelineSeam`; no `settings.json` key is introduced.
- `runningSlugs()` includes a `(run <run-id>)` entry while a run is in flight, alongside the existing slugs and `(spec draft)`.
- `test/activation.gating.test.ts` gains a `createRunPipelineSeam` describe block covering: started mapping with the manifest branch, `composerMode` copy, `explicitMode` false when equal and true when differing, `files` copied not aliased, `reproduction` omitted vs forwarded, busy mapping, every other refusal kind mapping to `refused` with the error's message, and a rejecting `completed` reaching `report` without an unhandled rejection (and being safe with no `report`).
- `npm run compile` and `npx tsc -p . --noEmit` are clean; `npm run lint` reports 0 errors and only the pre-existing `_legacy` warning; `npm test` passes with 0 failing and no existing test file modified.
- `git status --porcelain` lists only `src/activation/commands.ts`, `src/activation/engineFacade.ts` and `test/activation.gating.test.ts`; no `.baiton/specs/`, `.baiton/runs/` or `.baiton/worktrees/` residue, and no commit, stash or branch change is made.
