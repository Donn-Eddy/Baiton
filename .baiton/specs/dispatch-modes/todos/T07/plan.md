# Plan T07

## Steps

1. Create src/engine/runPipeline.ts with its module doc and vocabulary

   New host-free module (no `vscode`; sync `fs` only, like `runStore.ts`/`launcher.ts`). Model it on `src/engine/specDraft.ts`: a factory + one class, every host thing injected, every expected failure a returned value.

   Imports: `import { existsSync, readFileSync } from 'fs'`; `import * as path from 'path'` (only if needed); `import { randomUUID } from 'crypto'`; `import type { Adapter } from '../adapter'`; `import type { Role } from '../model/role'`; `import type { RunMode } from '../model/mode'`; `import type { GitWorktreeService } from '../git/types'`; `import type { InvestigateResult, ReviewResult } from '../schema'`; `import { appendCompletion, appendStart } from '../journal'`; `import { launchStage, type LaunchStageInput } from './launcher'`; `import { awaitStageResult, type RunOutcome } from './resultFlow'`; `import { buildRunContext } from './runContext'`; `import { createRunGitService, createRunWorktree, type RunWorktreeError } from './runWorktree'`; `import { launchIdFor, runArtifactPathFor, runArtifactWriter, runJournalPathFor, runWorktreeDirFor, newRunId as defaultNewRunId, type RunManifest, type RunOutcomeRecord, type RunStage, type RunState, type RunStore } from './runStore'`; `import type { AskWatcher, AskWatcherFactory, ResultWatcherFactory } from './runQueue'`; `import type { HostTerminal, TerminalHost } from './terminalHost'`; `import type { Unsubscribe } from './resultWatcher'`.

   Module doc comment must state: this is the spec-less run pipeline (`bug`, `quick`, `refactor` drive plan -> execute -> review in the run's own worktree; `investigate` runs one read-only stage from the main checkout and ends in a finding); the run's manifest/journal/artifacts live in the MAIN checkout under `.baiton/runs/<run-id>/` while each stage LAUNCH resolves under the worktree (`launchStage({ cwd })`) so the role profiles' relative `.baiton/runs/<launch-id>/` grants still point at the directory the launcher wrote; nothing is ever written under `.baiton/specs/`; it holds the one-stage-per-repository lock from both sides (it refuses `busy` while a spec queue or the spec draft runs, and `RunQueueDeps.isExternallyBusy` reports it back).

   Declare, near the top:
   - `export const ROLE_FOR_RUN_STAGE: Record<RunStage, Role> = { plan: 'planner', execute: 'executor', review: 'reviewer', investigate: 'reviewer' };` with a comment that `investigate` deliberately reuses the existing `reviewer` role (read + shell, run-dir writes only), so no new role and no config migration.
   - `export const DEFAULT_EXEC_ATTEMPTS = 3;` (the fallback when no `execAttempts` is injected, matching `defaultConfig`'s `limits.exec_attempts`).
   - `export function runExecuteCommitMessage(mode: RunMode, runId: string, attempt: number): string { return `${mode}(${runId}): execute attempt ${attempt}`; }` — the analogue of the queue's `spec(<slug>): <todoId> execute attempt <n>`.
   - `export const RUN_ID_TRAILER = 'Run-Id';` used as the commit trailer key; the trailer VALUE is the RUN id (not the launch id), because `runMergeMessage` in `runWorktree.ts` documents that the merge carries the same `Run-Id: <run-id>` trailer so `findCommitByRunId(runId)` finds both.

   Files: `src/engine/runPipeline.ts`

2. Declare the pipeline's public types in runPipeline.ts

   Every exported name must avoid the engine barrel's existing exports (`RunRequest`, `DispatchError`, `LiveRun`, `Clock`, `RunIdGenerator`, `RunOutcome`, `SpecStore`, `RunOutcomeRecord`, `RunStoreError`, `RunWorktreeError`, `SpecDraft*` are all taken). Use exactly these:

   ```ts
   /** One confirmed dispatch from the chat's run tool. */
   export interface RunPipelineRequest {
     /** The mode the run executes as; never 'spec'. */
     mode: RunMode;
     /** What the composer's Mode select said when the run was confirmed. */
     composerMode: RunMode;
     /** True when the orchestrator proposed a mode other than composerMode. */
     explicitMode: boolean;
     statement: string;
     files: string[];
     reproduction?: string;
   }

   /** Why a run never started; nothing was written and no worktree exists. */
   export type RunPipelineRefusal =
     | { kind: 'busy'; message: string }
     | { kind: 'invalid-mode'; message: string }
     | { kind: 'detached-head'; message: string }
     | { kind: 'no-base-head'; message: string }
     | { kind: 'manifest'; message: string }
     | { kind: 'worktree'; message: string; error?: RunWorktreeError };

   export type RunPipelineStart =
     | { ok: true; runId: string; manifest: RunManifest; completed: Promise<RunPipelineOutcome> }
     | { ok: false; error: RunPipelineRefusal };

   /** How a run ended, reported to `onComplete` and resolved by `completed`. */
   export interface RunPipelineOutcome {
     runId: string;
     mode: RunMode;
     /** The terminal run state: done | failed | cancelled | answered. */
     state: RunState;
     outcome: RunOutcomeRecord;
     /** The execute commits this run landed in its worktree, oldest first. */
     commits: string[];
     /** A one-line, user-facing description of the ending. */
     message: string;
   }

   /** The stage currently in flight for the active run. */
   export interface LiveRunStage {
     runId: string;
     /** `<run-id>.<stage>.<n>` — the id the stage launched under. */
     launchId: string;
     mode: RunMode;
     stage: RunStage;
     attempt: number;
     sessionId: string;
     terminal: HostTerminal;
   }

   /** What the Runs view and the chat subscribe to. */
   export type RunPipelineEvent =
     | { kind: 'started'; runId: string; manifest: RunManifest }
     | { kind: 'stage-started'; runId: string; stage: RunStage; attempt: number; manifest: RunManifest }
     | { kind: 'stage-completed'; runId: string; stage: RunStage; attempt: number; outcome: RunOutcome; manifest: RunManifest }
     | { kind: 'completed'; runId: string; manifest: RunManifest; outcome: RunPipelineOutcome };

   export interface RunPipeline {
     /** Launch a run; resolves as soon as the first stage is running or the run was refused. */
     start(req: RunPipelineRequest): Promise<RunPipelineStart>;
     /** Cancel the in-flight run; returns false when idle. Leaves the worktree and branch in place. */
     cancel(): boolean;
     /** Whether a run is in flight (the spec queue and the spec draft consult this). */
     isRunning(): boolean;
     /** The stage currently in flight, or undefined when idle. */
     currentStage(): LiveRunStage | undefined;
     /** The id of the run in flight, or undefined when idle. */
     currentRunId(): string | undefined;
     /** Subscribe to change events; the returned function unsubscribes. */
     onChange(listener: (event: RunPipelineEvent) => void): Unsubscribe;
   }

   export interface RunPipelineDeps {
     /** Absolute workspace root: the MAIN checkout. Run dirs resolve under it. */
     workspaceRoot: string;
     /** Service bound to the MAIN checkout; worktree add/branchHead/currentBranch. */
     git: GitWorktreeService;
     /** The manifest store, already bound to `workspaceRoot`. */
     store: RunStore;
     terminalHost: TerminalHost;
     watcherFactory: ResultWatcherFactory;
     /** When wired, launched stages relay harness asks into chat. */
     askWatcherFactory?: AskWatcherFactory;
     modelForRole(role: Role): { model: string; effort?: string };
     adapterForRole(role: Role): Adapter | undefined;
     /** `limits.exec_attempts`, read per run; defaults to DEFAULT_EXEC_ATTEMPTS. */
     execAttempts?: () => number;
     /** `git.verify`, for the refactor brief's behaviour-preservation section. */
     verify?: () => string | undefined;
     /** True while a spec queue or the spec-draft runner has a stage in flight. */
     isSpecBusy?: () => boolean;
     /** Factory for a git service bound to the run's worktree; injected for tests. */
     createService?: (dir: string) => GitWorktreeService;
     newRunId?: (mode: RunMode) => string;
     newSessionId?: () => string;
     onComplete?: (outcome: RunPipelineOutcome) => void;
     /** Surfaces an invalid result.json / a refusal while the run stays open. */
     report?: (message: string) => void;
   }

   export function createRunPipeline(deps: RunPipelineDeps): RunPipeline { return new DefaultRunPipeline(deps); }
   ```

   Files: `src/engine/runPipeline.ts`

3. Implement start(): refusals, manifest, worktree

   In `class DefaultRunPipeline implements RunPipeline`, fields: `private readonly deps`, `private activeRunId: string | undefined`, `private stage: LiveRunStage | undefined`, `private cancelled = false`, `private readonly listeners = new Set<(e: RunPipelineEvent) => void>()`.

   `isRunning()` returns `this.activeRunId !== undefined`. `currentRunId()` returns `this.activeRunId`. `currentStage()` returns `this.stage`. `onChange(l)` adds to the set and returns `() => this.listeners.delete(l)`. A private `emit(event)` iterates a copy and wraps each call in try/catch so a bad listener can never break a run.

   `start(req)` in this exact order:
   1. `if (req.mode === 'spec' || !isSpecless(req.mode))` -> refuse `invalid-mode` with `'mode "spec" has no run pipeline: a spec conversation dispatches draft_spec'`. (Import `isSpecless` from `../model/mode`; the guard is belt-and-braces since `isSpecless` is `mode !== 'spec'`.)
   2. `if (this.activeRunId !== undefined || this.deps.isSpecBusy?.() === true)` -> refuse `busy` with the queue's exact wording: `'a stage is already running for this repository; try again after it finishes'`.
   3. Resolve the base: `const baseBranch = await this.deps.git.currentBranch()` inside try/catch (a throw -> `detached-head` refusal naming the git failure); refuse `detached-head` when it is `''` or `'HEAD'` with wording matching `createRunWorktree`'s ("check out a named branch first, because the run's branch is merged back into the branch it started from"). Then `const baseHead = await this.deps.git.branchHead(baseBranch)`; `undefined` -> refuse `no-base-head`. Investigate needs a base too (the manifest requires non-empty `baseBranch`/`baseHead`).
   4. `const runId = (this.deps.newRunId ?? ((m: RunMode) => defaultNewRunId(m)))(req.mode)`.
   5. `const created = this.deps.store.create({ id: runId, mode: req.mode, composerMode: req.composerMode, explicitMode: req.explicitMode, statement: req.statement, files: req.files, ...(req.reproduction !== undefined ? { reproduction: req.reproduction } : {}), baseBranch, baseHead })` — no `worktreeDir` yet, so the manifest only claims one once git really made it. A `!created.ok` -> refuse `manifest` with `created.error.message`.
   6. For a NON-investigate mode: `const wt = await createRunWorktree({ workspaceRoot, git: this.deps.git, ...(createService ? { createService } : {}) }, { runId, mode: req.mode })`. On failure: `this.deps.store.update(runId, { state: 'failed', outcome: { kind: 'failed', message: wt.error.message } })` (so the Runs view shows the dead run) and refuse `{ kind: 'worktree', message: wt.error.message, error: wt.error }`. On success: `this.deps.store.update(runId, { worktreeDir: wt.value.relativeWorktreeDir })` and keep `wt.value.worktreeDir` (absolute) for the launches. For `investigate`: no worktree at all.
   7. Set `this.activeRunId = runId; this.cancelled = false;`, `emit({ kind: 'started', runId, manifest })`, then `const completed = this.drive(runId, req.mode, manifestAfterUpdate, worktreeDir)` (NOT awaited) and `return { ok: true, runId, manifest, completed }`, exactly like `SpecDraftRunner.start`.

   `drive()` must clear `this.activeRunId`/`this.stage` in a `finally`, call `this.deps.onComplete?.(outcome)` and `emit({ kind: 'completed', ... })`, and never reject (wrap its body in try/catch, turning a throw into a `failed` outcome with `describe(e)`).

   Files: `src/engine/runPipeline.ts`

4. Implement drive(): the plan -> execute -> review loop and the investigate branch

   Two private drivers, both returning `Promise<RunPipelineOutcome>`.

   `driveInvestigate(runId, mode)`:
   - `const result = await this.runStage({ runId, mode, stage: 'investigate', cwd: undefined, runGit: undefined })`.
   - On a non-`completed` outcome: finish `failed` (or `cancelled` when the outcome kind is `cancelled`) per the shared helper below.
   - On `completed`: `const finding = (result.outcome.structured as InvestigateResult).finding;` then `store.update(runId, { state: 'answered', outcome: { kind: 'finding', finding } })` and return `{ state: 'answered', outcome: { kind: 'finding', finding }, commits: [], message: 'investigation answered' }`. No commit, no diff, no worktree: assert this by simply never touching git here.

   `driveBuild(runId, mode, worktreeDir)`:
   - `const runGit = createRunGitService(this.deps.workspaceRoot, runId, this.deps.createService)` — every head/branch/commit call for the run goes through the worktree.
   - Set state `planning` (`store.update(runId, { state: 'planning' })`), run `plan`. Non-completed -> finish. Completed -> state `planned`.
   - Then loop `for (let attempt = 1; ; attempt++)`:
     - state `executing`, run `execute` (the stage runner bumps the attempt counter itself and passes the real attempt into the brief, so use the counter the runner returns rather than the loop index for messages).
     - Non-completed -> finish. Completed -> drift check + commit (next step). state `executed`.
     - state `reviewing`, run `review`. Non-completed -> finish. Completed -> `const verdict = readVerdict(result.outcome.structured)` (a local copy of `runQueue.ts`'s `readVerdict`: `pass` only when `structured.verdict === 'pass'`, everything else `findings`).
     - `verdict === 'pass'` -> `store.update(runId, { state: 'done', outcome: { kind: 'verdict', verdict: 'pass' } })`, return that outcome with `message` naming the commits.
     - `verdict === 'findings'` -> if the execute counter just used is `>= this.execAttemptsLimit()` (read once per run via `const limit = Math.max(1, this.deps.execAttempts?.() ?? DEFAULT_EXEC_ATTEMPTS)`), finish with `state: 'failed'`, `outcome: { kind: 'verdict', verdict: 'findings' }` and a message like `` `review still reports findings after ${limit} execute attempt(s)` ``; otherwise continue the loop (the next execute's brief carries the review because `buildRunContext` includes `# Latest review` from attempt 2 on).

   Shared private `finishNonCompleted(runId, outcome: RunOutcome, stage)`: `cancelled` -> `store.update(runId, { state: 'cancelled', outcome: { kind: 'cancelled' } })` and message `` `run cancelled during ${stage}` ``; `closed` -> `state: 'failed'`, `outcome: { kind: 'failed', message }` where the message is `` `the ${stage} stage closed without a result${exit}` `` (`exit` = `` ` (exit ${code})` `` when known); `invalid_output` -> `failed` with its `detail`. Every state write goes through `store.update`, and every update emits nothing extra — the `stage-completed` event already carries the fresh manifest.

   Files: `src/engine/runPipeline.ts`

5. Implement runStage(): bump, brief, launch, journal, await, cancel

   One private `async runStage(input: { runId; mode; stage: RunStage; cwd?: string; runGit?: GitWorktreeService }): Promise<{ ok: true; outcome: RunOutcome; attempt: number; launchId: string; startHead: string; startBranch: string } | { ok: false; refusal: string }>`.

   1. `const bumped = this.deps.store.bumpAttempt(runId, stage)` -> `{ manifest, attempt, launchId }`; a `!ok` returns `{ ok: false, refusal: bumped.error.message }`.
   2. `const role = ROLE_FOR_RUN_STAGE[stage]`; `const adapter = this.deps.adapterForRole(role)`; `undefined` -> refusal `` `role "${role}" is configured with an unsupported agent; update "roles.${role}.agent" in .baiton/config.json` `` (the queue's wording). `const probe = await adapter.probe()`; `!probe.ok` -> refusal `` `adapter probe failed: ${probe.reason ?? 'unknown reason'}` ``.
   3. Build the brief context with `buildRunContext`:
      - common: `{ stage, mode, statement: manifest.statement, files: manifest.files, attempt, resume: false }`;
      - `reproduction: manifest.reproduction` when present; `branch: manifest.branch` for every stage but `investigate`; `verify: this.deps.verify?.()` (only meaningful for refactor, harmless otherwise);
      - `plan: this.readRunArtifact(runId, 'plan')` for `execute` and `review`;
      - `latestReview: this.readRunArtifact(runId, 'review', manifest.attempts.review)` for `execute` when `manifest.attempts.review >= 1`;
      - `latestExecute: this.readRunArtifact(runId, 'execute', manifest.attempts.execute)` and `executeCommit: this.lastExecuteCommit` for `review`.
      `private readRunArtifact(runId, stage: RunStage, attempt?: number): string | undefined` reads `runArtifactPathFor(this.deps.workspaceRoot, runId, stage, attempt)` with `readFileSync` in try/catch, returning `undefined` when absent or blank.
   4. Record drift anchors BEFORE launching: `const git = input.runGit ?? this.deps.git;` `const startHead = await safeHead(git); const startBranch = await safeBranch(git);` (two module-level helpers that swallow git failures into `''`, copied in spirit from `runQueue.ts`).
   5. `const sessionId = (this.deps.newSessionId ?? randomUUID)();` `const { model, effort } = this.deps.modelForRole(role);` then build `LaunchStageInput`:
      `{ workspaceRoot: this.deps.workspaceRoot, ...(input.cwd !== undefined ? { cwd: input.cwd } : {}), runId: launchId, stage, role, model, ...(effort !== undefined ? { effort } : {}), resume: false, sessionId, briefContext, ...(this.deps.askWatcherFactory !== undefined ? { relayAsks: true } : {}) }`. `launchStage(input, { adapter, terminalHost: this.deps.terminalHost })`; `!ok` -> refusal `` `stage launch failed: ${launched.error.message}` ``. Note in a comment that `cwd` is the worktree for a build run and absent for `investigate`, which runs from the main checkout.
   6. `appendStart(runJournalPathFor(this.deps.workspaceRoot, runId), { runId: launchId, todoId: runId, stage, attempt, startHead, inputRev: '', sessionId, ...(pid !== undefined ? { terminalPid: pid } : {}) })` — the run id stands in for `todoId` exactly as `specDraft.ts` passes the slug, and `inputRev` is `''` because a run has no plan input rev. The run directory already exists (the manifest was written there), so `appendFileSync` has somewhere to go.
   7. Watchers + cancellation: `const watcher = this.deps.watcherFactory.create({ slug: runId, runId: launchId, resultPath, terminal })`. Set `this.stage = { runId, launchId, mode, stage, attempt, sessionId, terminal }` and `emit({ kind: 'stage-started', runId, stage, attempt, manifest })`. Create the ask watcher when `askWatcherFactory` and `relay` are both present, inside try/catch (`{ slug: runId, todoId: runId, runId: launchId, agent: adapter.id, role, asksDir: relay.dir }`), exactly as the queue does.
   8. `const target = runArtifactWriter(this.deps.workspaceRoot, runId, stage, isNumbered ? attempt : undefined)` where `isNumbered = stage === 'execute' || stage === 'review'`. Then
      `let outcome = await awaitStageResult({ workspaceRoot: input.cwd ?? this.deps.workspaceRoot, slug: runId, stage, todoId: runId, ...(isNumbered ? { index: attempt } : {}), terminal, watcher }, { writeArtifact: target.write, reportInvalid: (d) => this.deps.report?.(d) })` in a try/finally that disposes the ask watcher and clears `this.stage`. Comment that `slug`/`workspaceRoot` only feed the ignored spec-relative `artifactPath`, because `target.write` writes into the run directory instead.
   9. `if (this.cancelled) { outcome = { kind: 'cancelled' }; }` — same shape as the queue's cancel flag.
   10. `appendCompletion(journalPath, { runId: launchId, result: outcome.kind === 'completed' ? 'completed' : (outcome.kind as RunResultKind), ...(commit !== undefined ? { commit } : {}) })`. Journal the completion from `runStage` for every stage except the commit, which the execute path adds — simplest correct split: `runStage` journals the completion with no commit for plan/review/investigate, and returns the anchors so `driveBuild` journals execute's completion itself after committing. Implement that by giving `runStage` a `journalCompletion: boolean` flag (false for `execute`) and a small exported-internal helper `this.journalDone(runId, launchId, result, commit?)`.
   11. `emit({ kind: 'stage-completed', runId, stage, attempt, outcome, manifest: freshManifest })` (re-read with `store.read(runId)` and fall back to the bumped manifest when the read fails).

   Files: `src/engine/runPipeline.ts`

6. Implement the execute drift check and the worktree commit

   In `driveBuild`, immediately after a `completed` execute outcome and BEFORE any state write:
   1. `const head = await safeHead(runGit); const branch = await safeBranch(runGit);` If `head !== startHead || branch !== startBranch`, journal the execute completion (`this.journalDone(runId, launchId, 'completed')`) and finish the run with `state: 'failed'`, `outcome: { kind: 'failed', message: 'HEAD or branch changed during execute; run halted (git_state_changed)' }`. This mirrors `runQueue.applyOutcome`'s Req 17.6 check, but against the worktree's own service, so a drift in the MAIN checkout does not abort a run.
   2. Otherwise commit inside the worktree: `const commit = await safeCommit(runGit, runExecuteCommitMessage(mode, runId, attempt), { [RUN_ID_TRAILER]: runId })` (a module helper that returns `undefined` when git throws — a run whose executor changed nothing must not fail). Push the commit onto the run's `commits` array and keep it in `this.lastExecuteCommit` so the next review brief's `# Execute commit` section names it.
   3. `this.journalDone(runId, launchId, 'completed', commit)` and then `store.update(runId, { state: 'executed' })`.
   A comment must record why the trailer value is the RUN id rather than the launch id: `runMergeMessage` in `runWorktree.ts` uses `Run-Id: <run-id>`, so both the execute commits and the eventual merge are found by `findCommitByRunId(runId)`.

   Files: `src/engine/runPipeline.ts`

7. Implement cancel()

   `cancel(): boolean` — mirror `SerialRunQueue.stop()`'s shape but for a single run:
   ```ts
   cancel(): boolean {
     if (this.activeRunId === undefined) { return false; }
     this.cancelled = true;
     this.stage?.terminal.dispose();
     return true;
   }
   ```
   Disposing the terminal drives the watcher's terminal-close path, `awaitStageResult` resolves `closed`, and the `cancelled` flag turns it into `{ kind: 'cancelled' }`, which `finishNonCompleted` records as `state: 'cancelled'`, `outcome: { kind: 'cancelled' }`. Document, in the method's doc comment, that cancel deliberately does NOT call `removeRunWorktree`: the worktree and branch stay on disk for inspection (that is the Runs view's explicit cleanup/merge path). A cancel with no stage in flight (between stages) must still stop the loop — so `driveBuild` checks `if (this.cancelled) { return this.finishNonCompleted(runId, { kind: 'cancelled' }, stage); }` at the top of each loop iteration, before bumping the next attempt.

   Files: `src/engine/runPipeline.ts`

8. Widen the runQueue.isExternallyBusy contract and export the module

   1. `src/engine/runQueue.ts`: in `RunQueueDeps`, extend the `isExternallyBusy` doc comment only — no behaviour change — so it reads that it reports a stage running outside this queue: today the spec-draft runner AND the spec-less run pipeline (`createRunPipeline`), both of which are repository-scoped rather than todo-scoped, and that the queue refuses a dispatch as `busy` while it answers true, keeping the one-stage-per-repository guarantee across all three paths (Req 20.1). Also add the pipeline to the parallel sentence in the `runOne` inline comment at the `isExternallyBusy` check (`a stage running outside the queue (a spec draft or a spec-less run)`). Do not touch any other line of runQueue.ts, and do not change its signature: activation composes the predicate.
   2. `src/engine/index.ts`: add `export * from './runPipeline';` after `export * from './runWorktree';` and extend the module doc sentence to mention the spec-less run pipeline (plan -> execute -> review in the run's worktree, plus the read-only investigate dispatch). Verify with `npm run compile` that no exported name collides in the barrel (`RunPipeline*`, `LiveRunStage`, `ROLE_FOR_RUN_STAGE`, `DEFAULT_EXEC_ATTEMPTS`, `runExecuteCommitMessage`, `RUN_ID_TRAILER`, `createRunPipeline` are all new).

   Files: `src/engine/runQueue.ts`, `src/engine/index.ts`

9. Write test/runPipeline.test.ts — fakes and the happy paths

   New mocha file in the repo's style (plain `assert`, `describe`/`it`, no `vscode` import). Copy the stub shapes from `test/engine.specDraft.test.ts`: `StubAdapter` (probe verdict controllable, records `LaunchRequest`s), `StubTerminal` (counts `dispose`), `StubTerminalHost` (records `CreateTerminalOptions` — assert `cwd` is the worktree for build stages and the workspace root for investigate), `StubResultWatcher` + `StubWatcherFactory` (the test drives `emitResult`/`emitClose`; keep the created watchers so the test can settle each stage in order).

   Add a `FakeGit implements GitWorktreeService` whose `currentBranch`/`branchHead`/`head`/`status`/`isClean`/`commit`/`addWorktree`/`listWorktrees`/`removeWorktree`/`deleteBranch`/`merge` are scriptable and whose every other `GitService` member throws `must not be called on this path` (the `boom` helper in `engine.specDraft.test.ts`). `addWorktree` must `fs.mkdirSync(dir, { recursive: true })` so the launcher can write a brief there. Inject it both as `deps.git` and, through `deps.createService`, as the worktree service, recording which instance received each `commit`.

   Harness `makeHarness()`: `fs.mkdtempSync` workspace, `createRunStore({ workspaceRoot: root, now: () => '2026-01-01T00:00:00.000Z' })`, `createRunPipeline({ ..., newRunId: () => 'bug-20260101-000000-aaaa', newSessionId: () => '11111111-1111-4111-8111-111111111111', execAttempts: () => 2, verify: () => 'npm test', isSpecBusy: () => specBusy })`, plus a helper `settle(index, json)` that emits a result on the n-th created watcher, and schema-conformant result fixtures for `plan`, `execute`, `review` (both verdicts) and `investigate` (reuse the exact field names from `src/schema/schemas.ts`; `review` needs a non-empty `findings` for the findings verdict and `tests`).

   Cases (grouped in describes):
   - **bug run, pass**: start -> `plan` launched with role `planner`, `cwd` = `.baiton/worktrees/<id>` and launch id `<id>.plan.1`; brief at `<worktree>/.baiton/runs/<id>.plan.1/brief.md` exists and its `# Context` carries `# Run`, `- Mode: bug`, `# Defect`, `# Reproduction`; settle each stage in turn; assert artifacts land in the MAIN checkout at `.baiton/runs/<id>/plan.md`, `execute-1.md`, `review-1.md` and that nothing exists under `.baiton/specs/`; the manifest ends `state: 'done'`, `outcome: { kind: 'verdict', verdict: 'pass' }`, `attempts: { plan: 1, execute: 1, review: 1, investigate: 0 }`, `completedAt` set; one commit on the WORKTREE service with message `bug(<id>): execute attempt 1` and trailer `{ 'Run-Id': '<id>' }`; the journal `.baiton/runs/<id>/runs.jsonl` has three start+completion pairs whose `runId`s are the launch ids and whose `todoId` is the run id, with the execute completion carrying the commit.
   - **findings loop**: review 1 returns `findings` -> a second execute is launched as `<id>.execute.2` whose brief context contains `# Latest review`; review 2 returns `pass` -> `done`. With `execAttempts: () => 1`, a `findings` review instead ends `state: 'failed'`, `outcome: { kind: 'verdict', verdict: 'findings' }` and no second execute is launched.
   - **quick / refactor framing**: a `quick` run's plan brief has no `# Defect` and no `# Behaviour preservation`; a `refactor` run's plan brief names `npm test` under `# Behaviour preservation`.
   - **investigate**: no worktree directory is created, `addWorktree` is never called, the terminal `cwd` is the workspace root, the single launch id is `<id>.investigate.1`, the artifact is `.baiton/runs/<id>/finding.md`, the manifest ends `state: 'answered'`, `outcome: { kind: 'finding', finding: ... }`, and the worktree git service's `commit` was never called.

   Files: `test/runPipeline.test.ts`

10. Write test/runPipeline.test.ts — refusals, cancel, drift, events

   Further cases in the same file:
   - **busy both ways**: `isSpecBusy: () => true` refuses `{ kind: 'busy' }` and writes no manifest (assert `.baiton/runs` has no run dir); a second `start()` while a run is in flight refuses `busy`; and `pipeline.isRunning()` is true from `start()` until the last stage settles, which is the value activation passes to `RunQueueDeps.isExternallyBusy`.
   - **invalid mode**: `mode: 'spec'` refuses `invalid-mode` and writes nothing.
   - **detached head / no base head**: `currentBranch` returning `'HEAD'` refuses `detached-head`; `branchHead` returning `undefined` refuses `no-base-head`; both leave `.baiton/runs` empty.
   - **worktree failure**: `addWorktree` throwing leaves the manifest at `state: 'failed'` with a `failed` outcome and returns `{ kind: 'worktree' }`.
   - **unknown agent / probe failure**: `adapterForRole: () => undefined` and a not-ok probe each end the run `failed` with the message naming the role / the probe reason, after the attempt counter was bumped.
   - **closed without a result**: emitting a terminal close on the plan watcher ends the run `state: 'failed'`, `outcome.kind === 'failed'` with a message naming the stage and the exit code, and no execute is launched.
   - **cancel**: during execute, `cancel()` returns true, disposes the stage terminal, and the run ends `state: 'cancelled'`, `outcome: { kind: 'cancelled' }`; assert the worktree directory still exists and `removeWorktree`/`deleteBranch` were never called; `cancel()` when idle returns false.
   - **execute drift**: make the worktree service's `head()` return a different sha after launch -> the run ends `failed` with the `git_state_changed` message, `commit` was never called, and the execute completion is journaled without a commit.
   - **events**: `onChange` receives `started`, then `stage-started`/`stage-completed` pairs in stage order, then `completed` carrying the terminal manifest; the returned unsubscribe stops delivery; a listener that throws does not break the run.
   - **real git end-to-end** (one `describe` modelled on `test/integration.plan-execute-review.test.ts`): a temp `git init` repo with one commit on `main`, `createGitService(repo)` as `deps.git` and the real `createRunWorktree` path, stubbed agent boundary as above. Assert: `.baiton/worktrees/<id>` exists on branch `baiton/bug/<id>`; after the run, `git log` on that branch shows the `bug(<id>): execute attempt 1` commit carrying `Run-Id: <id>`, found by `git.findCommitByRunId(runId)`; `main` is untouched; nothing appears under `.baiton/specs/`. Have the stub 'executor' write a file into the worktree before settling so the commit is non-empty.

   Files: `test/runPipeline.test.ts`

11. Verify

   Run, from the repo root: `npm run compile` (must be clean), `npx mocha test/runPipeline.test.ts` (all new cases pass), `npm run lint` (only the pre-existing warning `'_legacy' is assigned a value but never used` at src/orchestrator/webviewProtocol.ts:591), `npm test` (the whole suite: the 1855-passing baseline plus the new cases, 0 failing), and `git status --porcelain` to confirm the working tree holds exactly `src/engine/runPipeline.ts`, `src/engine/runQueue.ts`, `src/engine/index.ts`, `test/runPipeline.test.ts` — no stray `.baiton/worktrees/` or `.baiton/runs/` residue from the tests, which must all work inside their own temp directories. Do not modify any existing test file.

   Files: `src/engine/runPipeline.ts`, `src/engine/runQueue.ts`, `src/engine/index.ts`, `test/runPipeline.test.ts`

## Risks

- Two different ids are in play per stage and mixing them silently corrupts the layout: the RUN id names `.baiton/runs/<run-id>/` in the MAIN checkout (manifest, journal, artifacts), while the LAUNCH id `<run-id>.<stage>.<n>` from `launchIdFor` names the brief/result/asks directory, which for a build stage resolves under the WORKTREE because `launchStage` is given `cwd`. Journal records are keyed by launch id (`runId`) with the run id in `todoId`; the commit trailer carries the RUN id.
- `awaitStageResult` still composes a spec-relative `artifactPath` from its `workspaceRoot`/`slug`/`todoId` arguments and puts it on the resolved `RunOutcome`. That path is never written because `runArtifactWriter`'s `write` ignores its path argument — but any code that later trusts `outcome.artifactPath` for a run would point inside `.baiton/specs/`. Use `RunArtifactTarget.path` (and assert in a test that no `.baiton/specs/` directory is ever created).
- `runArtifactFileName` throws for `execute`/`review` when no attempt is passed (its `requireIndex`), and ignores the attempt for `plan`/`investigate`. Pass the attempt for exactly the two numbered stages.
- The execute drift check must use the WORKTREE's git service, not `deps.git`: a run works on its own branch, so the main checkout's HEAD moving is not the run's concern, while the worktree's HEAD moving is. `createRunGitService` is the seam (its factory parameter is what the tests override — note that `RunWorktreeDeps.createService` is declared but not consumed inside `runWorktree.ts` today, so pass the factory explicitly).
- `RunState` has no state meaning "investigating": an investigate run stays `confirmed` while its single stage runs and moves to `answered`. The live stage is exposed through `currentStage()` and the `attempts.investigate` counter instead; say so in a comment so a later Runs-view todo does not read `confirmed` as "nothing started".
- Cancel must be observable both during a stage (terminal dispose -> `closed` -> flipped to `cancelled`) and between stages (the loop's own `this.cancelled` check), or a cancel landing in the gap between review and the next execute would launch another stage.
- The engine barrel re-exports everything, so a new exported name can collide with `runQueue.ts` (`RunRequest`, `Clock`, `LiveRun`, `DispatchError`, `SpecStore`), `resultFlow.ts` (`RunOutcome`) or `runStore.ts` (`RunOutcomeRecord`). The names in this plan were checked against the current barrel; `npm run compile` is the guard if any is renamed.
- `exactOptionalPropertyTypes` is on in this repo: build every optional field with the `...(x !== undefined ? { x } : {})` spread form (as `runStore.ts` and the existing launch-input factories do) rather than assigning `undefined`.

## Acceptance

- `src/engine/runPipeline.ts` exists, imports no `vscode` and nothing from `src/activation/`, and is re-exported from `src/engine/index.ts`.
- A `bug`/`quick`/`refactor` run started through `createRunPipeline().start()` writes `.baiton/runs/<run-id>/run.json`, creates `.baiton/worktrees/<run-id>/` on `baiton/<mode>/<run-id>`, and drives plan -> execute -> review, each stage launched under launch id `<run-id>.<stage>.<n>` with `cwd` set to the worktree.
- Stage artifacts land in the main checkout's run directory as `plan.md`, `execute-<n>.md`, `review-<n>.md` (and `finding.md` for investigate); no run ever creates anything under `.baiton/specs/`.
- A `findings` review re-launches `execute` with the review in its brief (`# Latest review`) and stops after `limits.exec_attempts` attempts, ending `state: 'failed'` with `outcome: { kind: 'verdict', verdict: 'findings' }`; a `pass` review ends `state: 'done'` with `outcome: { kind: 'verdict', verdict: 'pass' }`.
- A completed execute commits in the WORKTREE with message `<mode>(<run-id>): execute attempt <n>` and a `Run-Id: <run-id>` trailer, and only after a worktree HEAD/branch drift check; a drift halts the run `failed` with the `git_state_changed` message and no commit.
- An `investigate` run creates no worktree and makes no commit and no diff call, persists `finding.md`, and ends `state: 'answered'` with `outcome: { kind: 'finding', finding }`.
- `start()` refuses `busy` (writing nothing) while another run is in flight or `isSpecBusy()` is true, and `isRunning()` is true for the whole run so activation can feed `RunQueueDeps.isExternallyBusy`; `runQueue.ts`'s `isExternallyBusy` doc names the run pipeline alongside the spec draft.
- `cancel()` disposes the in-flight terminal, records `state: 'cancelled'` with `outcome: { kind: 'cancelled' }`, and leaves the worktree directory and branch on disk (no `removeWorktree`/`deleteBranch` call); it returns false when idle.
- Every stage appends a start and a completion record to `.baiton/runs/<run-id>/runs.jsonl` keyed by launch id with the run id as `todoId`, the execute completion carrying its commit.
- `onChange` subscribers receive `started`, `stage-started`/`stage-completed` per stage and a final `completed` event carrying the terminal manifest, and a throwing listener cannot break a run.
- `test/runPipeline.test.ts` covers all of the above with fakes plus one real-temp-git-repo end-to-end case; `npm run compile` is clean, `npm run lint` shows only the pre-existing webviewProtocol warning, and `npm test` passes with no existing test file modified.
