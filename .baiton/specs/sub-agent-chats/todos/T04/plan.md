# Plan T04

## Steps

1. Add the worktree seam, per-todo identity and spec-branch writer to RunQueueDeps

   In src/engine/runQueue.ts add (all OPTIONAL so today's per-slug wiring in src/activation/commands.ts and every existing test rig keep compiling and behaving identically when they are absent):

   ```ts
   /** Where one todo's stages run: its worktree dir and a git service bound to it. */
   export interface TodoStageWorkspace { dir: string; git: GitService }
   /** The per-todo worktree seam the queue dispatches through. */
   export interface QueueWorktreeSeam {
     /** Create (first dispatch) or reuse the todo's worktree. Never resets an existing one. */
     ensure(slug: string, todoId: string): Promise<Result<TodoStageWorkspace, string>>;
     /** Todo ids of `slug` whose todo branch still exists (not landed). */
     unlanded(slug: string): Promise<readonly string[]>;
   }
   ```
   RunQueueDeps gains:
   - `slug?: string` and `todoId?: string` — the (slug, todo) this queue serves; when set, a request for any other slug/todo is refused (see step 3).
   - `worktrees?: QueueWorktreeSeam` — when set, every todo-level stage runs in the todo's worktree; absent → main checkout exactly as today.
   - `specWriter?: Pick<SpecBranchWriter, 'apply'>` — when set, journal appends (start + completion records) run under `specWriter.apply(slug, ...)` so they serialize with state/artifact/land commits of the same spec (no commit is made by the append itself; the next state commit records it).

   Also export a real-implementation factory in the same file (import from './todoWorktree', '../git/gitService', './specBranchWriter', '../model/result'):
   ```ts
   export function createQueueWorktreeSeam(deps: TodoWorktreeDeps & { writer?: Pick<SpecBranchWriter, 'apply'> }): QueueWorktreeSeam
   ```
   - `ensure`: `const run = async () => { const r = await createTodoWorktree(deps, { slug, todoId }); if (!r.ok) return err(r.error.message); const factory = deps.createService ?? createGitService; return ok({ dir: r.value.worktreeDir, git: factory(r.value.worktreeDir) }); }` — executed as `deps.writer ? deps.writer.apply(slug, run) : run()` so creating a worktree from the spec-branch head never interleaves with a spec-branch commit. Wrap in try/catch → `err(message)`; never throws.
   - `unlanded`: `unlandedTodos(deps, slug)`; a rejection propagates to the queue, which treats it as a refusal (step 4).
   Update the module doc comment: the queue is now one per (slug, todo) when wired that way; FIFO + `busy` are per queue, i.e. per todo; there is no repo-wide serialization between todo queues; `isExternallyBusy` doc: optional, wiring decides whether spec-draft/run-pipeline still block (the per-todo wiring will not pass it). Keep `isExternallyBusy` behaviour unchanged when provided. Add `worktreeDir?: string` to `LiveRun` and `RunningState` (set from the stage workspace) so View/Stop can later show where the run is.

   Files: `src/engine/runQueue.ts`

2. Add the `deps-unlanded` DispatchError and the Plan guard

   Add `| { kind: 'deps-unlanded'; message: string }` to `DispatchError` (doc it in the list: "a Plan whose `after` dependencies are done but not yet landed — their todo branches still exist"). It is a recoverable guard refusal, so src/activation/surface.ts `isHardHalt` needs no change (its default branch returns false); no other switch over DispatchError['kind'] is exhaustive (verified: controlTools/chatController switch on other unions).

   In `checkGuards`, inside `if (transition.guards.approvedAndUnblocked)` AFTER the existing `isApproved` and `isBlocked` checks (isBlocked already covers "not done"), and only when `this.deps.worktrees !== undefined`:
   ```ts
   const spec = await this.deps.specStore.readSpec(req.slug);
   const after = spec?.todos.find((t) => t.id === req.todoId)?.after ?? [];
   if (after.length > 0) {
     let unlanded: readonly string[];
     try { unlanded = await this.deps.worktrees.unlanded(req.slug); }
     catch (e) { return { ok: false, error: { kind: 'launch-failed', message: `could not list unlanded todos of "${req.slug}": ${describe(e)}` } }; }
     const pending = after.filter((id) => unlanded.includes(id));
     if (pending.length > 0) {
       return { ok: false, error: { kind: 'deps-unlanded', message: `todo "${req.todoId}" depends on ${pending.join(', ')}, which ${pending.length === 1 ? 'is' : 'are'} done but not landed; land ${pending.length === 1 ? 'it' : 'them'} (land_todo) before planning` } };
     }
   }
   ```
   This guard runs BEFORE any worktree is created, so a refused Plan never creates a worktree from a spec head that lacks its dependencies' work.

   Files: `src/engine/runQueue.ts`

3. Restructure runOne: identity check, plan guards, ensure worktree, then tree guards against the worktree git

   Introduce a private type `StageWorkspace = { git: GitService; cwd?: string }` (cwd undefined = main checkout) and a helper:
   ```ts
   private async stageWorkspace(req): Promise<{ ok: true; ws: StageWorkspace } | { ok: false; error: DispatchError }> {
     if (this.deps.worktrees === undefined) return { ok: true, ws: { git: this.deps.git } };
     const r = await this.deps.worktrees.ensure(req.slug, req.todoId);
     return r.ok ? { ok: true, ws: { git: r.value.git, cwd: r.value.dir } }
                 : { ok: false, error: { kind: 'launch-failed', message: `could not prepare the worktree for "${req.todoId}": ${r.error}` } };
   }
   ```
   New order in `runOne`:
   1. isExternallyBusy (unchanged).
   2. NEW identity check: if `deps.slug`/`deps.todoId` are set and the request's slug/todoId differ → `refuse({ kind: 'illegal-transition', message: `this run queue serves ${deps.slug}/${deps.todoId}, not ${req.slug}/${req.todoId}` })`.
   3. currentState / resolveTransition / control actions (unchanged — control actions `replan`/`stop` never create a worktree).
   4. Split `checkGuards` into `checkSpecGuards(req, transition)` (approval + blocked + the new deps-unlanded; also the approval half of the execute guard) and `checkTreeGuards(req, transition, ws.git)` (clean tree via `ws.git.isCleanExceptSpecFolder(req.slug)` + input-rev revert). Call `checkSpecGuards`, then `stageWorkspace(req)` (refuse on error, state untouched), then `checkTreeGuards` with the worktree git. Keep the refusal messages/kinds of the existing guards byte-identical so existing assertions hold.
   5. adapter lookup + probe (unchanged).
   6. `launchAndComplete(req, transition, stage, adapter, ws)`.
   A failed/refused/stopped stage never removes the worktree or branch (the queue has no removal call at all).

   Files: `src/engine/runQueue.ts`

4. Run the stage in the worktree: launch cwd, HEAD/branch, drift, execute commit, reset, session ids

   Thread `ws: StageWorkspace` through `launchAndComplete` → `applyOutcome` → helpers:
   - `safeHead(git)`, `safeBranch(git)`, `safeCommit(git, message, trailers)`, `headOrBranchDrifted(git, startHead, startBranch)`, `workingTreeChanged(git, startHead)` take the git service as a parameter instead of reading `this.deps.git`; call them with `ws.git`.
   - `LaunchStageInput`: add `...(ws.cwd !== undefined ? { cwd: ws.cwd } : {})` so brief.md, result.json and asks/ land under `<worktree>/.baiton/runs/<run-id>/` and the terminal cwd is the worktree (launcher already supports `cwd`). `resultPath` returned by the launcher is therefore inside the worktree; `resultFileExists(resultPath)` keeps working.
   - `resolveResumeSessionId(adapter, req, ws.cwd ?? this.deps.workspaceRoot)` and `discoverSessionId(adapter, runId, launchedAt, ws.cwd ?? this.deps.workspaceRoot)` — the CLI's session cwd is the worktree.
   - `awaitStageResult` keeps `workspaceRoot: this.deps.workspaceRoot` (MAIN checkout): artifacts (`todos/<id>/plan.md`, `execute-<n>.md`, `review-<n>.md`) are rendered into the main checkout's spec folder and persisted through `specStore.persistArtifact` (the spec-branch writer) when available, else the default fs writer — unchanged logic.
   - Execute commit: `commit = await this.safeCommit(ws.git, `spec(${req.slug}): ${req.todoId} execute attempt ${req.attempt}`, { 'Run-Id': runId })` — lands on the todo branch in the worktree (message and trailer unchanged). Drift check uses `ws.git`.
   - Post-run reset for non-executor stages: `ws.git.resetWorkingTree()` (the worktree), never the main checkout when a worktree is in use.
   - `startHead` journaled on the start record is the worktree HEAD.
   - Set `worktreeDir: ws.cwd` on `this.running`.
   State writes (`writeState` for running/terminal/revert) stay on `this.deps.specStore` (main checkout, spec-branch writer); nothing run inside the worktree touches spec.md.

   Files: `src/engine/runQueue.ts`

5. Serialize journal appends through the spec-branch writer

   Add a private `private async journal(slug: string, write: () => void): Promise<void> { if (this.deps.specWriter) { await this.deps.specWriter.apply(slug, () => write()); } else { write(); } }` (swallow nothing: appendRecord failures currently throw synchronously out of runOne — keep that behaviour; if the writer path rejects, let it propagate the same way). Replace the direct `appendStart(...)` call and every `appendCompletion(...)` call (including the one on the persistArtifact failure path and `journalDone` in `applyOutcome`) with `await this.journal(req.slug, () => appendX(this.journalFor(req.todoId), {...}))`; `journalDone` becomes `async` and every call site awaits it. Record contents, file paths (`journalPathFor` per todo) and ordering relative to state writes are unchanged.

   Files: `src/engine/runQueue.ts`

6. Doc-only touch-ups in launcher.ts and resultFlow.ts

   No behaviour change. launcher.ts: extend the `cwd` doc on `LaunchStageInput` and the module header to say it is set by the spec-less run pipeline (run worktree) AND by the run queue (the todo worktree `.baiton/worktrees/<slug>/<todoId>/`). resultFlow.ts: in the `AwaitStageResultInput.workspaceRoot` doc note that the run queue passes the MAIN checkout root even when the stage ran in a todo worktree, so artifacts always land in the main checkout's spec folder; the watcher's result path may be inside a worktree. If the executor prefers, these edits may be skipped — they are not required for correctness.

   Files: `src/engine/launcher.ts`, `src/engine/resultFlow.ts`

7. Update the existing queue suites with worktree-mode coverage

   Keep every existing case passing unchanged (no worktree seam → main checkout). Add, per suite, a small fake seam: `const wtGit = makeGit(); const worktrees: QueueWorktreeSeam = { ensure: async () => ok({ dir: path.join(tmp, '.baiton', 'worktrees', 'demo', todoId), git: wtGit }), unlanded: async () => unlandedList }` and make the MAIN git's commit/resetWorkingTree/isCleanExceptSpecFolder/diffAgainstWorkingTree record calls so tests can assert the main checkout is not touched.
   - test/runQueue.serialization.property.test.ts: rewrite the header comment from "per-repo" to "per-queue (per todo)". Keep the FIFO + stop properties (they still hold within one queue; change `executeRequest` so all requests in a single-queue property use the same todoId when the queue is built with `todoId`, or leave the queue without `todoId` as today). ADD a property: for 2..4 distinct todos, build one queue per todo (`todoId` set, fake worktree seam), dispatch one execute on each before completing any → `peakInFlight() === n` (stages run concurrently), each completes independently in any random completion order, and each queue's `isRunning()` is independent. ADD a case: a queue with `slug:'demo', todoId:'T01'` refuses a request for `T02` as `illegal-transition` without launching.
   - test/runQueue.approvalGate.property.test.ts: ADD (a) worktree-mode execute refuses `dirty-tree` when the worktree git reports dirty while main git is clean, and proceeds when main is dirty but the worktree is clean; (b) property over random `after` sets ⊆ {T01..T05} and random unlanded sets: Plan with `readSpec` returning the target's `after` is refused `deps-unlanded` iff `after ∩ unlanded ≠ ∅`, with no launch, no writeState and `ensure` never called; otherwise it launches. (c) Without a worktree seam the deps-unlanded guard never fires.
   - test/runQueue.attemptCount.property.test.ts: ADD a worktree-mode run of the existing property: counted attempts equal completed executes, the commits are recorded on the WORKTREE git with message `spec(demo): <id> execute attempt <n>` and a `Run-Id` trailer, and the main git's `commit` is never called.
   - test/runQueue.revert.property.test.ts: ADD worktree-mode cases: a closed/cancelled stage reverts state exactly as today, the seam has no removal so the worktree dir is untouched (assert `ensure` result dir still referenced and nothing removed), PRESERVED_CHANGES_HINT is decided from the worktree git's `diffAgainstWorkingTree`, and a completed non-execute stage calls `resetWorkingTree` on the worktree git and not on main.
   - test/runQueue.briefContext.test.ts: ADD a worktree-mode case asserting the terminal was created with `cwd === <worktree dir>`, the brief was written at `<worktree>/.baiton/runs/<run-id>/brief.md` and contains the same Context section (plan/after summaries still read through the spec store, i.e. from the main checkout).

   Files: `test/runQueue.serialization.property.test.ts`, `test/runQueue.approvalGate.property.test.ts`, `test/runQueue.attemptCount.property.test.ts`, `test/runQueue.revert.property.test.ts`, `test/runQueue.briefContext.test.ts`

8. New temp-repo suite test/runQueue.worktree.test.ts with the two-todo concurrency test

   Model the repo helper on test/todoWorktree.test.ts (`execFileSync('git', ...)`, `makeRepo`): init on `main`, write and commit `.baiton/.gitignore` containing `/runs/\n/worktrees/\n` (so linked worktrees under `.baiton/worktrees/` and run dirs do not dirty the main checkout), commit `.baiton/specs/demo/spec.md` and a `src/base.txt`, then `git checkout -b baiton/demo`. Wire REAL pieces: `const git = createGitService(repo)`, `const writer = createSpecBranchWriter({ specsDir, git })`, `worktrees: createQueueWorktreeSeam({ workspaceRoot: repo, git, writer })`, `specWriter: writer`, `journalPathFor: (id) => todoJournalPathFor(specsDir, 'demo', id)`, `readJournal: () => readSpecJournal(specsDir, 'demo')`. Use an in-memory SpecStore (Map of todo states; `readSpec` returns a ParsedSpec-shaped object with todos T01, T02 (and T03 after T01 for the land test); `writeState` records + runs `writer.apply('demo', s => s.commit(...))` only if something changed, or simply records in memory — keep it simple and deterministic), a fake adapter (probe ok), a fake TerminalHost that records `options.cwd`, and the controllable watcher factory from the serialization rig.
   Cases:
   1. Two-todo concurrency: build queue A (`todoId:'T01'`) and queue B (`todoId:'T02'`), both todos `planned` with a plan artifact; dispatch execute on both before completing either; assert both are running simultaneously (`A.isRunning() && B.isRunning()`, two terminals created) with cwd `.baiton/worktrees/demo/T01` and `.../T02` (both exist and are registered worktrees on `baiton-todo/demo/T0x`); from each recorded cwd write a distinct source file (`src/t01.txt`, `src/t02.txt`), then complete B first, then A. Assert: both resolve `completed`; `git log -1 --format=%B baiton-todo/demo/T0x` is `spec(demo): T0x execute attempt 1` with a `Run-Id: <runId>` trailer and contains only its own file; the main checkout is still on `baiton/demo`, its working tree has neither `src/t01.txt` nor `src/t02.txt`, and HEAD did not get either execute commit; `todos/T01/execute-1.md` and `todos/T02/execute-1.md` exist in the MAIN checkout; each todo's `todos/<id>/runs.jsonl` has its start+completion records with `commit` equal to the todo-branch commit; states ended `executed` for both.
   2. Reuse: a second dispatch (review) on T01 reuses the same worktree (no new `git worktree add`; same dir; HEAD is the execute commit), and after a completed review the worktree tree is reset (an untracked scratch file written by the fake reviewer is gone) while the main checkout is untouched.
   3. Clean-tree guard on the worktree: dirty the T01 worktree with an uncommitted change to a tracked file → execute refused `dirty-tree`; a dirty main checkout (untracked file outside `.baiton/`) with a clean worktree → execute proceeds.
   4. deps-unlanded: T01 `done` with its branch still present, T03 `after: [T01]` pending → Plan refused `deps-unlanded`, no `.baiton/worktrees/demo/T03` created; then `landTodoWorktree({ workspaceRoot: repo, git }, { slug:'demo', todoId:'T01' })` succeeds and Plan on T03 launches in a new worktree whose HEAD contains T01's file.
   5. A cancelled (stop) or closed stage leaves the worktree dir and the `baiton-todo/demo/<id>` branch in place.
   Clean the temp dir in afterEach (remove worktrees via `git worktree prune` after rmSync is fine).

   Files: `test/runQueue.worktree.test.ts`

9. Verify

   Run `npm run compile`, `npm run lint`, `npm test`. The only acceptable lint warning is the pre-existing unused `_legacy` in src/orchestrator/webviewProtocol.ts. Do NOT change src/activation/commands.ts wiring in this todo (per-(slug,todo) queue caching, Stop/View/runningSlugs and dropping isExternallyBusy belong to the wiring todo); because every new dep is optional, the extension keeps its current behaviour and all other suites (engineFacade.resume, integration.plan-execute-review, askWatcher.routing) stay green untouched.

   Files: (none)

## Risks

- Git concurrency: two todos' stages commit in separate worktrees at once (separate indexes, separate branch refs — safe), but `git worktree add` from the main checkout and main-checkout commits share `.git` locks; creating worktrees under the spec-branch writer's per-slug lock mitigates same-spec races, while cross-spec races could still hit a transient index/config lock error, which surfaces as a `launch-failed` refusal rather than corruption.
- The main checkout must ignore `.baiton/worktrees/` (the real `.baiton/.gitignore` from src/config/gitignore.ts does); a repo/test without it sees linked worktrees as untracked dirs and the main-tree `isCleanExceptSpecFolder`/land dirty checks fail. The new temp-repo suite must commit that .gitignore.
- The worktree contains a checked-out (and quickly stale) copy of `.baiton/specs/<slug>/`; `git commit -a` style `add -A` in the worktree will commit anything the executor writes there, which could conflict at land time. The executor brief already forbids spec edits; worth noting, not fixing here.
- Journal appends becoming async (awaited through the writer) changes microtask timing inside launchAndComplete/applyOutcome; property tests that count flushes (serialization/stop) may need an extra `flush()` — adjust the tests, not the semantics.
- Crash recovery (src/engine/recovery.ts) still resets/inspects the main checkout using a journaled `startHead`, which in worktree mode is a todo-branch commit; recovery for in-worktree runs is out of this todo's file scope and should be handled by the wiring/recovery todo.
- Existing callers pass one queue per slug; until commands.ts is rewired (later todo) the identity check and worktree mode are inactive, so no runtime behaviour changes in the extension from this todo alone.
- Adapters' `discoverSessionId`/`resolveSessionId` now receive the worktree dir as the session cwd; an adapter that indexes sessions by the workspace root only would stop resuming across a pre-change session — acceptable since worktree mode is new.

## Acceptance

- `npm run compile`, `npm run lint` (no new warnings) and `npm test` pass.
- RunQueueDeps has optional `slug`, `todoId`, `worktrees: QueueWorktreeSeam` and `specWriter`; `createQueueWorktreeSeam` and `QueueWorktreeSeam`/`TodoStageWorkspace` are exported from src/engine/runQueue.ts (and thus the engine barrel).
- With a worktree seam: the stage terminal cwd and the brief/result/asks paths are under `.baiton/worktrees/<slug>/<todoId>/`; the drift check, Execute commit (`spec(<slug>): <id> execute attempt <n>` + `Run-Id:` trailer), post-run reset and clean-tree guard all use the worktree's git service and never the main checkout's.
- Artifacts (`plan.md`, `execute-<n>.md`, `review-<n>.md`) and per-todo journals are written in the main checkout's `.baiton/specs/<slug>/todos/<id>/`; state writes go through `specStore.writeState`; journal appends go through `specWriter.apply` when provided.
- The worktree is created on the first dispatched stage for a todo and reused (not reset) by later stages; a failed, closed or stopped stage leaves the worktree and its branch in place.
- Plan is refused with `deps-unlanded` (no launch, no state write, no worktree created) when any `after` dependency's todo branch still exists, and allowed once it has been landed.
- Two queues for two todos of the same spec run their stages concurrently (both in flight at once) in the new test/runQueue.worktree.test.ts against a real temp repo, each committing only on its own todo branch; a queue built for one todo refuses requests for another.
- Without the new deps every pre-existing queue suite, engineFacade.resume, integration.plan-execute-review and askWatcher.routing pass unchanged in behaviour; src/activation/commands.ts is not modified.
