# Plan T05

## Steps

1. Add a host-free per-todo queue registry to the engine facade

   In src/activation/engineFacade.ts (no vscode import; keep it host-free so tests can use it), add and export:

   1. `export function todoQueueKey(slug: string, todoId: string): string` returning `${slug}/${todoId}`.

   2. `export type TodoQueuesDeps = Omit<RunQueueDeps, 'slug' | 'todoId' | 'journalPath' | 'journalPathFor' | 'readJournal' | 'worktrees' | 'specWriter' | 'isExternallyBusy' | 'git'> & { specsDir: string; git: GitWorktreeService /* main checkout */; specWriter: SpecBranchWriter; worktrees?: QueueWorktreeSeam }`. Import the types `RunQueueDeps`, `LiveRun`, `QueueWorktreeSeam` and `SpecBranchWriter` from '../engine', `GitWorktreeService` from '../git', and the values `createRunQueue` and `createQueueWorktreeSeam` from '../engine'. Also import `specJournalPathFor` and `todoJournalPathFor` from '../journal'; `readSpecJournal` is already imported.

   3. `export interface TodoQueues { queueFor(slug: string, todoId: string): RunQueue; find(slug: string, todoId: string): RunQueue | undefined; running(): LiveRun[]; isRunning(slug?: string): boolean; }`

   4. `export function createTodoQueues(deps: TodoQueuesDeps): TodoQueues`. Build one worktree seam: `deps.worktrees ?? createQueueWorktreeSeam({ workspaceRoot: deps.workspaceRoot, git: deps.git, writer: deps.specWriter })`. Keep a `Map<string, RunQueue>` keyed by `todoQueueKey`. `queueFor` returns the cached queue for the key. On a miss it calls `createRunQueue({ ...rest, git: deps.git, slug, todoId, worktrees: seam, specWriter: deps.specWriter, journalPath: specJournalPathFor(deps.specsDir, slug), journalPathFor: (id) => todoJournalPathFor(deps.specsDir, slug, id), readJournal: () => readSpecJournal(deps.specsDir, slug) })`, caches it and returns it. Pass NO `isExternallyBusy`: todo stages are outside the repository lock. Strip `specsDir`/`specWriter`/`worktrees` out of `rest` before spreading. `find` reads the map only and never creates a queue. `running()` returns `[...map.values()].map(q => q.currentRun()).filter(defined)`. `isRunning(slug?)` is true when any cached queue is running, restricted to keys starting with `${slug}/` when a slug is given (compare against each LiveRun's slug, or keep the slug alongside each queue in the map).

   5. Change `createRunQueueSeam(queueFor: (slug: string, todoId: string) => RunQueue, specsDir, adapterForRole)`. Keep a closure `inFlight = new Set<string>()`. In `dispatch(req)`: compute `key = todoQueueKey(req.slug, req.todoId)` and `queue = queueFor(req.slug, req.todoId)`. If `inFlight.has(key) || queue.isRunning()`, return `{ kind: 'busy' }` without dispatching. Otherwise add the key, `try { await dispatchTrigger(queue, ...) } finally { inFlight.delete(key) }`, and map the result exactly as today (ok → dispatched, error kind busy → busy, else → illegal with the queue's message, e.g. `deps-unlanded`). This gives the orchestrator's `run` tool the documented meaning, 'busy = a stage is already running for THIS todo', even though the FIFO queue itself would otherwise enqueue behind the running stage. Two different todos never see busy from each other.

   6. Add `export function createStageLock(holders: { specDraftRunning: () => boolean; runRunning: () => boolean }): { runPipelineBusy(): boolean; specDraftBusy(): boolean }`. It returns `runPipelineBusy: () => holders.specDraftRunning()` and `specDraftBusy: () => holders.runRunning()`. Document it as the repository lock after per-todo worktrees: the spec draft and spec-less runs still exclude each other, and per-todo queues neither hold nor wait on it. Update the module doc comment to describe per-todo queues, the busy semantics and the lock. Leave `dispatchTrigger`, `STAGE_ROLE` and `createRunPipelineSeam` unchanged.

   Files: `src/activation/engineFacade.ts`

2. Rewire commands.ts onto per-todo queues, one shared spec-branch writer, and the relaxed lock

   In src/activation/commands.ts:

   - Build one writer right after `const git = createGitService(repoRoot)`: `const specWriter = createSpecBranchWriter({ specsDir, git });`, then `const specStore = createSpecStore(specsDir, git, specWriter);`. The store, the queues and the worktree seam must share the SAME writer so state commits, artifact writes, journal appends and worktree creation serialize per slug. Import `createSpecBranchWriter` from '../engine', and `createTodoQueues`, `createStageLock` and `type TodoQueues` from './engineFacade'.

   - Replace the `queues` Map and `queueForSlug` with `const todoQueues: TodoQueues = createTodoQueues({ workspaceRoot: repoRoot, specsDir, git, specWriter, terminalHost, watcherFactory, askWatcherFactory, specStore, modelForRole: (role) => modelForRole(cfg(), role), adapterForRole: adapterFor, report: (error) => surface.reportDispatchError(error) });` and `const queueFor = (slug: string, todoId: string): RunQueue => todoQueues.queueFor(slug, todoId);`. Declare these BEFORE `runPipeline` and `specDraftRunner`. Neither of those references the queues any more, but keep the declaration order clear anyway. Remove the now-unused imports `specJournalPathFor` and `todoJournalPathFor` from the '../journal' import if nothing else uses them. `readSpecJournal`, `latestStart`, `resumableSessionId` and `JournalEntry` are still used.

   - Add `const stageLock = createStageLock({ specDraftRunning: () => specDraftRunner.isRunning(), runRunning: () => runPipeline.isRunning() });` (both are lazy closures). Set the run pipeline's `isSpecBusy: () => stageLock.runPipelineBusy()` and the spec draft runner's `isQueueRunning: () => stageLock.specDraftBusy()`. Rewrite the comments at both sites and at the run-pipeline construction: spec draft and spec-less runs exclude each other; per-todo stages run concurrently in their own worktrees and neither block nor are blocked by them.

   - `submitPrForSlug`: replace `queueForSlug(slug).isRunning()` with `todoQueues.isRunning(slug)`. The message stays 'spec "<slug>" already has a run in progress'.

   - Change `type QueueForSlug = (slug: string) => RunQueue` to `type QueueFor = (slug: string, todoId: string) => RunQueue`. Thread it through `registerStageCommand`, `registerActionCommand`, `registerViewCommand`, `runView`, `runStage` and `buildToolServices` (rename the parameters to `queueFor`). Update both `buildToolServices(...)` call sites to pass `queueFor`. In `buildToolServices` the seam becomes `createRunQueueSeam(queueFor, specsDir, adapterForRole)`.

   - `runStage`: `dispatchAndReport(queueFor(target.slug, target.todoId), ...)`.

   - `registerActionCommand`: for Stop, use `const queue = queueFor(target.slug, target.todoId); if (queue.currentRun() !== undefined) { queue.stop(); surface.log(...); return; }`. The queue now serves only this todo, so there is no todoId comparison, and Stop never cancels another todo's stage. Otherwise keep the fallback dispatch of the `stop` action (and its 'nothing to stop' warning) through that same queue. Replan dispatches through `queueFor(target.slug, target.todoId)`.

   - `runView`: `const live = todoQueues.find(slug, todoId)?.currentRun()` (use `find` so View never creates a queue; pass a `find` accessor or the `TodoQueues` object instead of `queueFor`). If it is live, `live.terminal.show()`. Otherwise, after resolving the session, attach in the directory the session was created in: `const worktreeDir = todoWorktreeDirFor(repoRoot, slug, todoId); const cwd = fs.existsSync(worktreeDir) ? worktreeDir : repoRoot;` (import `todoWorktreeDirFor` from '../engine'). Use `cwd` for both `adapter.resolveSessionId(sessionId, cwd)` and `terminalHost.createTerminal({ ..., cwd })`. Update the JSDoc to match.

   - `runningSlugs()`: `const running = todoQueues.running().map((r) => `${r.slug}/${r.todoId}`);`, then append '(spec draft)' and '(run <id>)' as today. Update the `CommandSurface.runningSlugs` doc: 'Slug/todo pairs (and the spec draft / spec-less run) with a stage in flight'.

   - Update the file-header doc paragraph that says 'holds the one-stage-per-repository lock jointly across the todo-scoped queues...'. It should say instead that it caches one run queue per (slug, todo), each running its stages in the todo's worktree, and that only the spec draft and the spec-less run pipeline still exclude each other. Also update the comment above the old queue cache ('One serialized queue is built per slug and cached') to per slug+todo.

   Nothing else in commands.ts changes. Do not touch extension.ts or recovery. Crash recovery still reads the main checkout; the recovery todo handles it.

   Files: `src/activation/commands.ts`

3. Update the run seam contract and the run tool's busy wording

   src/orchestrator/seams.ts:

   - Update the header bullet for `RunQueueSeam` to say it is backed by per-todo run queues, one per (slug, todo). Each todo's stages run in its own worktree, and different todos run concurrently.
   - Update the `RunDispatchOutcome` doc so `busy` means 'a stage is already running (or being dispatched) for this todo'. Note that `illegal` carries the queue's reason, for example deps-unlanded.
   - Update the `RunQueueSeam` doc and its `dispatch` doc from 'per-repository serialized' to 'per-todo'.
   - In `StartRunOutcome`, the `busy` doc should now say 'the spec draft or another spec-less run is in flight'. Spec queues no longer block a run.
   - `DraftSpecOutcome.busy` becomes 'a spec-less run (or another draft) is in flight'.
   - Type shapes do not change.

   src/orchestrator/controlTools.ts:

   - In `runTool`'s `busy` case (around line 751), return `a stage is already running for todo "${todo}" of spec "${slug}"; wait for it to finish before dispatching another stage for this todo (other todos can run meanwhile)`.
   - Update the runTool JSDoc sentence 'Refuses when a stage is already running (Req 10.4)' to 'Refuses when a stage is already running for that todo (Req 10.4)'.
   - Leave the `draft_spec` / `start_run` / `investigate` busy messages alone. They still say 'already running for this repository', which stays true for that lock, and test/registry.controlTools.test.ts matches them with /already running/i.
   - Do not add `land_todo`, `concurrent` or surface changes here. Those belong to other todos.

   Files: `src/orchestrator/seams.ts`, `src/orchestrator/controlTools.ts`

4. Tests for the run tool's per-todo busy answer and the real seam

   In test/registry.controlTools.test.ts, inside the existing `describe('run stage rejection (Req 11.1)')` block or a new sibling `describe('run over per-todo queues')`:

   (a) With a seam stub returning `{ kind: 'busy' }`, `registry.call('run', { slug, todo: 'T01', stage: 'plan' }, undefined, makeGuard(repo), 'drive')` fails. Its error matches /todo "T01"/ and /other todos can run/.

   (b) Build the REAL seam: `createRunQueueSeam((slug, todoId) => fakeQueues.get(`${slug}/${todoId}`)!, specsDir, () => undefined)`, imported from '../src/activation/engineFacade'. The fake RunQueue objects have a controllable `isRunning()`/`currentRun()` and a `dispatch` that records requests and returns a deferred promise. Assert:
     - Dispatching T01 while T01's dispatch is still pending answers `busy` without calling T01's `dispatch` a second time.
     - Dispatching T02 at the same moment reaches T02's queue and resolves `dispatched`.
     - After T01's first dispatch resolves, a new T01 dispatch reaches the queue again, because the in-flight set is cleared in `finally`.
     - A queue whose `isRunning()` is true (for example a UI-triggered stage) answers `busy`.
     - A queue dispatch resolving `{ ok: false, error: { kind: 'deps-unlanded', message: 'm' } }` maps to `{ kind: 'illegal', reason: 'm' }`.

   The spec folder must exist for `dispatchTrigger` to read the journal, and `readSpecJournal` tolerates a missing file. Use a temp specsDir.

   The existing positive-control test (`queue.calls` deep-equals `[{ slug, todoId: 'T01', stage: 'plan' }]`) must keep passing unchanged.

   Files: `test/registry.controlTools.test.ts`

5. Move the Plan → Execute → Review integration test onto the per-todo worktree path

   Rewrite the harness in test/integration.plan-execute-review.test.ts to use the same wiring commands.ts uses.

   - makeRepo: also write and commit `.baiton/.gitignore` with `GITIGNORE_CONTENTS` (from '../src/config/gitignore'). Without it the `/worktrees/` directory dirties the main tree. Keep the root `.gitignore` (`.baiton/runs/`, `scratch.local`).
   - Delete `FileSpecStore`. Use the real `createSpecStore(specsDir, git, writer)` from '../src/activation/specStore' (host-free), with `const specsDir = path.join(repo, '.baiton', 'specs'); const git = createGitService(repo); const writer = createSpecBranchWriter({ specsDir, git });`.
   - Build `const queues = createTodoQueues({ workspaceRoot: repo, specsDir, git, specWriter: writer, specStore: store, terminalHost, watcherFactory: factory, adapterForRole: () => new StubAdapter(), modelForRole })` from '../src/activation/engineFacade'. Set `h.queue = queues.queueFor(SLUG, TODO_ID)` and add `queues` to Harness. Set `journalPath` to `specJournalPathFor(specsDir, SLUG)` for the crash test.
   - Remove the `h.store.recordInputRev` call. The real store reads the plan's Input_Rev from the journal the queue writes at plan start.
   - StubSubAgentFactory: the executor must edit the WORKTREE, not the main checkout. Derive the stage's root from `input.resultPath` (`<worktree>/.baiton/runs/<run-id>/result.json` → `path.resolve(path.dirname(input.resultPath), '..', '..', '..')`), or record `options.cwd` in StubTerminalHost.createTerminal. Write `src/greeting.ts` there.

   New assertions in the full-flow test:
   - After Plan: the state is planned, `todos/T01/plan.md` exists in the MAIN checkout, and the 'planning'/'planned' commits are on the spec branch (`commitSubjects(h.repo)`). The worktree `todoWorktreeDirFor(repo, SLUG, TODO_ID)` exists on branch `todoBranchFor(SLUG, TODO_ID)`, i.e. `baiton-todo/demo-spec/T01`; check with `git -C <wt> rev-parse --abbrev-ref HEAD`.
   - Dirty tree: write the dirty change into `<wt>/src/greeting.ts`. Execute is refused `dirty-tree` and the state stays planned. Reset with `createGitService(wt).resetWorkingTree()` and assert the worktree is clean.
   - After Execute: the state is executed and `execute-1.md` is in the main checkout's todo folder. Exactly one `spec(demo-spec): T01 execute attempt 1` commit appears in `git log --format=%s <todo branch>` and NONE in the spec branch's log. `createGitService(wt).findCommitByRunId(executeRunId)` finds it with the `Run-Id:` trailer. `<wt>/src/greeting.ts` contains 'hello' while the MAIN checkout's `src/greeting.ts` is still `version = 0`.
   - Review: create `scratch.local` inside the WORKTREE. After Review → done it survives, and `review-1.md` is in the main checkout.
   - Close by landing through `landTodoWorktree({ workspaceRoot: repo, git }, { slug: SLUG, todoId: TODO_ID })` inside `writer.apply(SLUG, ...)`. Commit any uncommitted spec-folder files first if the land refuses dirty-tree; it only refuses on dirt outside the spec folder. Assert `ok`, that the main checkout's `src/greeting.ts` now contains 'hello', that the todo branch and worktree are gone, and that the last subject on the spec branch is `spec(demo-spec): land T01`.

   Retry test: build it through `createTodoQueues` with CloseThenSucceedFactory. After the closed first Plan, the state is pending, the revert commit exists, and the worktree still exists (a failed stage never removes it). The second Plan reuses it and reaches planned.

   Crash-replay test: keep it on the main checkout as today (recovery rewiring is a later todo). It uses `h.store` (now the real store), `h.git` and the spec-level `h.journalPath`. Just make sure it still passes with the real store: `writeState('executing')` from pending commits path-scoped, and the Run-Id commit is made by `h.git.commit` in the main checkout.

   Add a two-todo concurrency case to this file only if it is cheap. test/runQueue.worktree.test.ts already covers queue-level concurrency, so it is optional. The model-endpoint test stays untouched.

   Files: `test/integration.plan-execute-review.test.ts`

6. Test the relaxed repository lock against the real run pipeline

   In test/runCommands.test.ts:

   - Give the `realPipeline(repo, store, runId, isSpecBusy?)` helper an optional `isSpecBusy` and pass it through to `createRunPipeline`.
   - Add `describe('repository lock after per-todo queues (sub-agent-chats T05)')` with a lock built by `createStageLock` from '../src/activation/engineFacade'. The module is host-free, so import it statically or with the same dynamic import pattern.
   - Case 1: `let draftRunning = true; const lock = createStageLock({ specDraftRunning: () => draftRunning, runRunning: () => pipeline.isRunning() })`. Wire `isSpecBusy: () => lock.runPipelineBusy()`. `pipeline.start(...)` resolves `{ ok: false, error.kind === 'busy' }` and creates no worktree. After `draftRunning = false`, the start succeeds. Clean up by cancelling and emitting close, as the existing cancel test does.
   - Case 2: a running spec-less run makes `lock.specDraftBusy()` true, and it is false again once the run settles.
   - Case 3: the lock has no input for todo queues, so a spec-less run starts while a per-todo queue would be busy. This is structural; assert it by constructing the lock with only the two holders and showing `runPipelineBusy()` is false when the spec draft is idle.

   Keep every existing test unchanged.

   Files: `test/runCommands.test.ts`

7. Verify

   Run `npm run compile`, `npm run lint` and `npm test`. The known `_legacy` lint warning is acceptable. Grep src/activation/commands.ts for `queueForSlug`, `queues.` and `isExternallyBusy`: none should remain. Also confirm that no file under src/orchestrator/, src/engine/, src/journal/ or src/git/ gained a `vscode` import (engineFacade.ts is in src/activation/ but must also stay vscode-free because tests import it).

   Files: (none)

## Risks

- The queue itself is FIFO and never answers `busy` once `isExternallyBusy` is gone, so without the seam's in-flight set a second `run` for the same todo would silently queue behind the first. The in-flight set plus `queue.isRunning()` in createRunQueueSeam is what gives `busy` its per-todo meaning. UI stage commands intentionally keep the FIFO behaviour.
- All queues, the spec store and the worktree seam must share ONE SpecBranchWriter. createSpecStore defaults to its own writer when none is passed, so a missed argument would silently split the per-slug lock and let a state commit interleave with a journal append or worktree creation.
- Spec-write tools (`writeAndCommit`) and the approve path still use `git.commit` (`add -A`) in the main checkout. While todo stages now run concurrently, such a commit can sweep another todo's persisted-but-uncommitted artifact or journal file into its own commit. This does not corrupt anything, but the history is less tidy. It is out of scope for this todo (files not listed) and worth noting for a follow-up.
- The View command attaches in the todo's worktree when it exists and falls back to the repo root. A session created in a worktree that has since been landed and removed may not be resumable by CLIs that key sessions by cwd (claude). This is acceptable because the todo is done by then.
- Crash recovery (extension.ts → recoverJournal) still inspects the main checkout, and the execute Run-Id commit now lands on the todo branch. Recovery of an in-flight Execute after a crash is therefore not correct until the recovery todo rewires it. Do not try to fix it here.
- The integration test now depends on committing `.baiton/.gitignore` with `/worktrees/` and `/runs/`. If it is missing, the worktree dir dirties the main checkout and landing refuses dirty-tree.
- Spec-level `runs.jsonl` is gitignored while per-todo journals under todos/<id>/ are not. Uncommitted per-todo journal lines sit in the spec folder between state commits. That is fine for land (spec-folder dirt is allowed), but test assertions of `git status --porcelain` on the main checkout must tolerate spec-folder changes.

## Acceptance

- `npm run compile`, `npm run lint` (only the known `_legacy` warning) and `npm test` all pass.
- commands.ts caches run queues per `<slug>/<todoId>` via `createTodoQueues`. Each queue is built with slug, todoId, the per-todo worktree seam and the one shared SpecBranchWriter (also passed to `createSpecStore`), and none is built with `isExternallyBusy`.
- The `run` tool seam, Stage commands, Replan, Stop and View all address the per-todo queue. Stop on T01 never cancels T02's live stage. View shows the live terminal of that todo's queue, or attaches in the todo's worktree when it exists.
- `runningSlugs()` lists every in-flight `<slug>/<todoId>` plus '(spec draft)' / '(run <id>)'. `submit_pr` refuses while any todo queue of that slug is running.
- The run pipeline refuses `busy` only while the spec draft runs, and the spec draft refuses only while a spec-less run runs. Neither consults todo queues, and todo queues consult neither. This is covered by test/runCommands.test.ts.
- `createRunQueueSeam` answers `busy` for a second dispatch to the same todo while one is in flight or running, dispatches a different todo concurrently, and maps queue refusals (for example deps-unlanded) to `illegal` with the queue's message. The run tool's busy error names the todo. This is covered by test/registry.controlTools.test.ts.
- test/integration.plan-execute-review.test.ts drives Plan → Execute → Review through `createTodoQueues` and the real spec store against a temp repo, and asserts that the stages ran in `.baiton/worktrees/demo-spec/T01` on `baiton-todo/demo-spec/T01`. The execute commit carries a Run-Id trailer on the todo branch and not on the spec branch. State commits and artifacts are in the main checkout. The dirty-tree guard checks the worktree. The worktree survives a failed stage. A final land merges the work into the spec branch.
