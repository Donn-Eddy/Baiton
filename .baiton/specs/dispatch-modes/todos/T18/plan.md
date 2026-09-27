# Plan T18

## Steps

1. Create test/integration.run-modes.test.ts with the temp-repo + agent-boundary harness

   New file, the only source file this todo adds. Header comment: the single offline, deterministic end-to-end test of the spec-less run pipeline (dispatch modes, T18); real git, real RunStore, real createRunWorktree/mergeRunWorktree, real createRunPipeline, real control-tool registry; only the agent boundary (adapter probe/launch, terminal, result watcher) is stubbed.

   Imports: `assert`, `execFileSync` from 'child_process', `fs`, `os`, `path`; `GITIGNORE_CONTENTS` from '../src/config/gitignore'; `createGitService` from '../src/git/gitService'; `createRunStore` from '../src/engine/runStore'; `createRunPipeline`, and the types `RunPipeline`, `RunPipelineEvent`, `RunPipelineOutcome`, `RunPipelineRequest`, `RunFinding` from '../src/engine/runPipeline'; `createRunWorktree`, `mergeRunWorktree`, `findRunWorktree`, `createRunGitService`, type `RunWorktreeDeps` from '../src/engine/runWorktree'; `createRunPipelineSeam` from '../src/activation/engineFacade'; `createToolRegistry` from '../src/orchestrator/registry'; `GuardContext` from '../src/orchestrator/guard'; type `ToolServices` from '../src/orchestrator/toolServices'; types `StartRunOutcome`, `StartRunRequest` from '../src/orchestrator/seams'; type `InterventionAnswer`/`InterventionRequest`/`InterventionSeam` from '../src/orchestrator/interventions'; type `ResultWatcherFactory` from '../src/engine/runQueue'; types `ResultWatcher`, `Unsubscribe` from '../src/engine/resultWatcher'; types `CreateTerminalOptions`, `HostTerminal`, `TerminalHost` from '../src/engine/terminalHost'; types `Adapter`, `LaunchRequest`, `LaunchSpec`, `ProbeResult` from '../src/adapter'; type `Role` from '../src/model/role'.

   Module-level helpers, copied in shape from test/runPipeline.test.ts and test/runWorktree.test.ts (each test file in this repo is self-contained; do not extract a shared helper module):
   - `function git(cwd, ...args): string` over `execFileSync('git', args, { cwd, encoding: 'utf8' })`.
   - `function writeFile(root, relPath, contents): void` with `fs.mkdirSync(path.dirname(full), { recursive: true })`.
   - `function makeRepo(): string` — `fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-runmodes-'))`, `git init -q`, `config user.name Baiton Test`, `config user.email baiton-test@example.com`, `checkout -q -b main`, write `README.md` ('baseline\n') and `src/a.ts` ('export const bound = 0;\n'), write `.baiton/.gitignore` with `GITIGNORE_CONTENTS` (load-bearing: it carries `/runs/` and `/worktrees/`, without which the worktree and run dir make the main checkout dirty and every merge refuses `dirty-tree`), `git add -A`, `git commit -q -m 'initial commit'`.
   - `class StubAdapter implements Adapter` — `id = 'claude'`, `acceptsSessionId = true`, records `launches: LaunchRequest[]`, `probe()` resolves `{ version: '0.0.0-stub', ok: true }`, `launch()`/`attach()` return `{ shellPath: 'true', shellArgs: [] }`.
   - `class StubTerminal implements HostTerminal` — `disposeCount`, `processId = Promise.resolve(4321)`, inert `sendText`/`show`, `dispose()` bumps the counter.
   - `class StubTerminalHost implements TerminalHost` — collects `created: StubTerminal[]` and `options: CreateTerminalOptions[]`.
   - `class StubResultWatcher implements ResultWatcher` with `onResult`/`onTerminalClose`/`dispose` plus `emitResult(raw)` / `emitClose(exitCode)` the test drives.
   - `class StubWatcherFactory implements ResultWatcherFactory` — pushes each watcher to `watchers` and each `{ slug, runId, resultPath }` to `created`.
   - Result fixtures as string constants, identical in shape to test/runPipeline.test.ts: `PLAN_RESULT` ({ steps:[{title,detail,files:['src/a.ts']}], risks, acceptance }), `EXECUTE_RESULT` ({ summary, files_changed:['src/a.ts'], commands_run, notes }), `REVIEW_PASS` ({ verdict:'pass', findings:[], tests:{ran:true,passed:true,output_tail:'1 passing'} }), `INVESTIGATE_RESULT` ({ finding: 'The bound is computed twice, in src/a.ts and src/b.ts.', files:['src/a.ts','src/b.ts'], next_steps:['unify the two computations'] }).
   - `async function waitUntil(ready: () => boolean, what: string)` — up to 1000 iterations of `await new Promise(r => setTimeout(r, 2))`, then `assert.ok(ready(), `${what} never happened`)`. A real timer, not setImmediate: the stages here await real `git` child processes.
   - `function flush()` — `new Promise(r => setImmediate(r))`.

   Harness builder `function makeHarness(repo: string, options: { runId?: string; execAttempts?: number } = {})` returning `{ repo, service, store, pipeline, adapter, terminalHost, watcherFactory, events, outcomes, findings, reports, waitFor(index), settle(index, json), close(index, exitCode), runDir(runId?), worktreeDir(runId?) }`:
   - `const service = createGitService(repo)` (a `GitService` is a `GitWorktreeService`, so it satisfies `RunPipelineDeps.git` and `RunWorktreeDeps.git`).
   - `const store = createRunStore({ workspaceRoot: repo })` (the real clock; the manifest timestamps are never asserted).
   - `createRunPipeline({ workspaceRoot: repo, git: service, store, terminalHost, watcherFactory, modelForRole: () => ({ model: 'stub-model' }), adapterForRole: () => adapter, execAttempts: () => options.execAttempts ?? 2, verify: () => 'npm test', newRunId: () => options.runId ?? RUN_ID, newSessionId: () => '11111111-1111-4111-8111-111111111111', onComplete: (o) => outcomes.push(o), onFinding: (f) => findings.push(f), report: (m) => reports.push(m) })`. Do NOT pass `createService`: this test must exercise the real `createRunGitService`/`createGitService` path into the worktree. Subscribe `pipeline.onChange((e) => events.push(e))`.
   - `waitFor(index)` = `waitUntil(() => watcherFactory.watchers.length > index, `watcher ${index} appearing (reports: ${JSON.stringify(reports)})`)`; `settle(index, json)` awaits `waitFor(index)`, calls `emitResult(json)`, then `await flush()`.
   - Module constants `const RUN_ID = 'bug-20260101-000000-aaaa'` and request builders `bugRequest(overrides?)` (`mode:'bug'`, `composerMode:'bug'`, `explicitMode:false`, `statement:'the counter is off by one'`, `files:['src/a.ts']`, `reproduction:'Call count() with an empty list.'`) and `investigateRequest()` (`mode:'investigate'`, `composerMode:'investigate'`, `explicitMode:false`, `statement:'Where is the bound computed?'`, `files:['src/a.ts']`).

   Top-level `describe('Integration: spec-less run modes over a temp git repo (T18)', () => { ... })` with a `repos: string[]` array, a `newRepo()` that pushes onto it, and an `afterEach` that `fs.rmSync(repo, { recursive: true, force: true })` each entry (the same cleanup shape as test/runWorktree.test.ts; a forced rm is enough even with a registered worktree).

   Files: `test/integration.run-modes.test.ts`

2. Case 1: a confirmed Bug run creates the branch and worktree, plans, executes with a Run-Id commit, reviews, and touches nothing under .baiton/specs/

   `describe('a confirmed bug run', ...)` with one `it('creates the branch and worktree, plans, executes with a Run-Id commit and reviews', ...)`.

   Body: `const repo = newRepo(); const h = makeHarness(repo);` record `const mainHeadBefore = (await h.service.branchHead('main'))!`. `const started = await h.pipeline.start(bugRequest()); assert.ok(started.ok)` and early-return on `!started.ok` so TypeScript narrows.

   Assert immediately after start (before any stage settles):
   - `started.manifest.branch === `baiton/bug/${RUN_ID}`` and `started.manifest.worktreeDir === `.baiton/worktrees/${RUN_ID}``, `started.manifest.mode === 'bug'`, `started.manifest.baseBranch === 'main'`, `started.manifest.baseHead === mainHeadBefore`, `started.manifest.reproduction` is the request's reproduction.
   - The worktree is really checked out: `fs.existsSync(path.join(h.worktreeDir(), 'README.md'))`, and `git(h.worktreeDir(), 'rev-parse', '--abbrev-ref', 'HEAD').trim() === `baiton/bug/${RUN_ID}``.
   - `await h.service.branchHead(`baiton/bug/${RUN_ID}`)` is defined and equals `mainHeadBefore` at this point.
   - `findRunWorktree({ workspaceRoot: repo, git: h.service }, RUN_ID)` resolves a worktree whose `dir` realpath-matches `h.worktreeDir()`.

   Drive the three stages: `await h.settle(0, PLAN_RESULT)`; then `await h.waitFor(1)`, write real work into the worktree with `writeFile(h.worktreeDir(), 'src/a.ts', 'export const bound = 1;\n')` so the execute commit is non-empty, `h.watcherFactory.watchers[1].emitResult(EXECUTE_RESULT)`; then `await h.settle(2, REVIEW_PASS)`. `const outcome = await started.completed`.

   Assert the outcome and layout:
   - `outcome.state === 'done'`, `outcome.outcome` deep-equals `{ kind: 'verdict', verdict: 'pass' }`, `outcome.commits.length === 1`.
   - The manifest on disk (`h.store.read(RUN_ID)`, `assert.ok(read.ok)`) has `state === 'done'`, `attempts.plan === 1`, `attempts.execute === 1`, `attempts.review === 1`, `attempts.investigate === 0`, and a defined `completedAt`.
   - Launch ids and briefs: `h.watcherFactory.created.map(c => c.runId)` deep-equals `[`${RUN_ID}.plan.1`, `${RUN_ID}.execute.1`, `${RUN_ID}.review.1`]`, every entry's `slug === RUN_ID`, and each brief exists at `path.join(h.worktreeDir(), '.baiton', 'runs', `${RUN_ID}.<stage>.1`, 'brief.md')` — i.e. the launch directories resolve under the WORKTREE (the `cwd` override), not the main checkout. Assert the plan brief text contains `the counter is off by one`, `# Defect`, `# Reproduction` and `baiton/bug/${RUN_ID}`, and that `fs.existsSync(path.join(repo, '.baiton', 'runs', `${RUN_ID}.plan.1`))` is false.
   - Run-owned artifacts land in the MAIN checkout's run dir: `plan.md`, `execute-1.md`, `review-1.md` and `run.json` all exist under `h.runDir()`; `runs.jsonl` exists there too and `parseJournal(path.join(h.runDir(), 'runs.jsonl'))` (import `parseJournal` from '../src/journal') yields three completed entries whose `todoId` is `RUN_ID`, whose `runId`s are the three launch ids, and whose execute entry carries `commit === outcome.commits[0]`.
   - The commit: `git(repo, 'log', '-1', '--format=%B', `baiton/bug/${RUN_ID}`)` contains both `bug(${RUN_ID}): execute attempt 1` and `Run-Id: ${RUN_ID}`; `await h.service.findCommitByRunId(RUN_ID) === outcome.commits[0]`.
   - Isolation: `await h.service.branchHead('main') === mainHeadBefore`, `(await h.service.status()).clean === true`, `fs.readFileSync(path.join(repo, 'src/a.ts'), 'utf8')` still reads `export const bound = 0;`, and `fs.existsSync(path.join(repo, '.baiton', 'specs')) === false` — the headline `.baiton/specs/` assertion. Also assert `h.events.map(e => e.kind)` starts with `'started'` and ends with `'completed'`.

   Files: `test/integration.run-modes.test.ts`

3. Case 2: a declined confirm creates nothing, through the real control tool and the real pipeline seam

   `describe('a declined confirm', ...)`. This is the only case that goes through the orchestrator, and it wires the REAL seam to the REAL pipeline so a decline is proven against the filesystem rather than against a spy.

   Local helpers in this describe:
   - `function servicesFor(repo: string, h: Harness, answer: InterventionAnswer, calls: InterventionRequest[]): ToolServices` returning `{ repoRoot: repo, baitonDir: path.join(repo, '.baiton'), git: h.service, confirm: { confirm: async () => false }, intervention: { ask: async (req) => { calls.push(req); return answer; } }, runQueue: { dispatch: async () => ({ kind: 'busy' as const }) }, runPipeline: createRunPipelineSeam(h.pipeline, () => 'bug'), clock: { now: () => '2026-01-01T00:00:00.000Z' }, ids: { next: () => 'id-1' }, gitSettings: { remote: 'origin', base: 'main' } }` (the `confirm` seam answers false and must never be consulted while the intervention seam is wired).
   - `const guard = new GuardContext({ repoRoot: repo, specsDir: path.join(repo, '.baiton', 'specs'), restricted: false })`.

   `it('writes nothing and starts nothing when the run card is declined', ...)`: build the harness, `const registry = createToolRegistry(servicesFor(repo, h, { kind: 'declined' }, calls))`, then call both dispatch tools in the `run` phase:
   - `await registry.call('start_run', { mode: 'bug', statement: 'the counter is off by one', files: ['src/a.ts'], reproduction: 'Call count() with an empty list.' }, 'call-1', guard, 'run')`
   - `await registry.call('investigate', { question: 'Where is the bound computed?', files: ['src/a.ts'] }, 'call-2', guard, 'run')`
   Assert each result is `ok === false` with `/declined/i` in `result.error`; `calls.length === 2` and each request's `kind === 'confirm'`; then the filesystem/git proof: `fs.existsSync(path.join(repo, '.baiton', 'runs')) === false`, `fs.existsSync(path.join(repo, '.baiton', 'worktrees')) === false`, `h.pipeline.isRunning() === false`, `h.pipeline.currentRunId() === undefined`, `h.watcherFactory.watchers.length === 0`, `h.terminalHost.created.length === 0`, `h.events.length === 0`, `git(repo, 'branch', '--list', `baiton/bug/${RUN_ID}`).trim() === ''`, `await h.service.branchHead('main')` unchanged and `(await h.service.status()).clean === true`.

   `it('starts the real run when the card is approved', ...)` (the positive control that proves the decline assertions are not vacuous): same wiring with `{ kind: 'approved' }`, call `start_run`, assert `result.ok === true` and that `result.data` carries `{ runId: RUN_ID, mode: 'bug', branch: `baiton/bug/${RUN_ID}` }`, and that the manifest now exists (`h.store.exists(RUN_ID)`). Then tear the run down deterministically so the test does not leak a pending stage: `h.pipeline.cancel()`, `await waitUntil(() => !h.pipeline.isRunning(), 'the run settling after cancel')`.

   Files: `test/integration.run-modes.test.ts`

4. Case 3: merge removes the worktree and branch, and refuses on a moved base or a dirty tree

   `describe('merging a finished run', ...)`. Extract a local helper `async function finishedBugRun(repo: string, h: Harness)` that runs the whole three-stage happy path exactly as case 1 does (start, settle plan, write `src/a.ts` in the worktree, settle execute, settle review, `await started.completed`) and returns `{ started, outcome, manifest }` read back through `h.store.read(RUN_ID)`. Use `const deps: RunWorktreeDeps = { workspaceRoot: repo, git: h.service }` for every merge call, and pass the manifest's own `baseBranch`/`baseHead`/`statement` — never hard-coded shas.

   `it('merges the run branch into the base, then removes the worktree and branch', ...)`: after `finishedBugRun`, `const merged = await mergeRunWorktree(deps, { runId: RUN_ID, mode: 'bug', baseBranch: manifest.baseBranch, baseHead: manifest.baseHead, statement: manifest.statement })`. Assert `merged.ok`, `merged.value.cleanup` deep-equals `[]`, `merged.value.commit === await h.service.branchHead('main')`, the merge is a real merge commit (`git(repo, 'rev-list', '--parents', '-n', '1', merged.value.commit).trim().split(/\s+/).length === 3`), its message contains `Run-Id: ${RUN_ID}`, the executor's change reached the main checkout (`fs.readFileSync(path.join(repo, 'src/a.ts'), 'utf8')` now reads `export const bound = 1;`), the worktree is gone (`fs.existsSync(h.worktreeDir()) === false` and `await findRunWorktree(deps, RUN_ID) === undefined`), the branch is gone (`await h.service.branchHead(`baiton/bug/${RUN_ID}`) === undefined`), and the run dir with its artifacts survives (`fs.existsSync(path.join(h.runDir(), 'run.json'))`).

   `it('refuses with base-moved when the base branch advanced, leaving the worktree and branch in place', ...)`: after `finishedBugRun`, advance main in the checkout (`writeFile(repo, 'other.txt', 'moved on\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'move the base')`), record `const newHead = (await h.service.branchHead('main'))!`, then merge. Assert `!merged.ok`, `merged.error.reason === 'base-moved'`, and inside the narrowing `if` that `expected === manifest.baseHead` and `actual === newHead`; then that `fs.existsSync(h.worktreeDir())` and `await h.service.branchHead(`baiton/bug/${RUN_ID}`) !== undefined`, and that `await h.service.branchHead('main') === newHead` (the merge changed nothing).

   `it('refuses with dirty-tree when the main checkout has uncommitted changes', ...)`: after `finishedBugRun`, dirty the main checkout WITHOUT moving the base (`writeFile(repo, 'README.md', 'edited in the main checkout\n')`; the base-moved check runs first, so the base must stay put), then merge. Assert `merged.error.reason === 'dirty-tree'` and, inside the narrowing `if`, that `[...merged.error.changes]` includes `'README.md'`; then that the worktree directory and the run branch both still exist and `await h.service.branchHead('main')` is unchanged.

   Files: `test/integration.run-modes.test.ts`

5. Case 4: cancel keeps the worktree and the branch

   `describe('cancelling a run', ...)`, one `it('records cancelled and leaves the worktree and branch in place', ...)`.

   Start a bug run, `await h.waitFor(0)` so the plan stage is live, assert `h.pipeline.currentStage()?.stage === 'plan'`, then `assert.strictEqual(h.pipeline.cancel(), true)`. The cancel disposes the stage terminal; drive the watcher's close path with `h.watcherFactory.watchers[0].emitClose(undefined)` so `awaitStageResult` resolves (the stub watcher does not wire dispose→close by itself; mirror whatever test/runPipeline.test.ts's cancel describe does — if it relies on `dispose` alone, do the same and drop the explicit `emitClose`). `const outcome = await started.completed`.

   Assert `outcome.state === 'cancelled'`, `outcome.outcome` deep-equals `{ kind: 'cancelled' }`, `outcome.commits` is empty, `h.terminalHost.created[0].disposeCount >= 1`, and the manifest read back has `state === 'cancelled'`. Then the survival assertions that are the point of the case: `fs.existsSync(h.worktreeDir()) === true`, `fs.existsSync(path.join(h.worktreeDir(), 'README.md')) === true`, `await findRunWorktree({ workspaceRoot: repo, git: h.service }, RUN_ID) !== undefined`, `await h.service.branchHead(`baiton/bug/${RUN_ID}`) !== undefined`, plus `h.pipeline.isRunning() === false` and `(await h.service.status()).clean === true`.

   Files: `test/integration.run-modes.test.ts`

6. Case 5: an investigate run commits nothing and yields a finding

   `describe('an investigate run', ...)`, one `it('answers with a finding, creating no branch, worktree or commit', ...)`.

   Use a harness with an investigate-shaped id: `makeHarness(repo, { runId: 'investigate-20260101-000000-aaaa' })` and a local `const RUN = 'investigate-20260101-000000-aaaa'`. Record `const mainHeadBefore = (await h.service.branchHead('main'))!`, then `const started = await h.pipeline.start(investigateRequest())`.

   Assert immediately: `started.manifest.mode === 'investigate'`, `started.manifest.worktreeDir === undefined`, `fs.existsSync(path.join(repo, '.baiton', 'worktrees')) === false`.

   Settle the single stage with `await h.settle(0, INVESTIGATE_RESULT)` and `const outcome = await started.completed`. Assert:
   - `outcome.state === 'answered'`, `outcome.outcome` deep-equals `{ kind: 'finding', finding: 'The bound is computed twice, in src/a.ts and src/b.ts.' }`, `outcome.commits` is empty.
   - `outcome.finding` is defined and carries `runId === RUN`, `mode === 'investigate'`, `question === 'Where is the bound computed?'`, `questionFiles` deep-equals `['src/a.ts']`, `files` deep-equals `['src/a.ts','src/b.ts']`, `nextSteps` deep-equals `['unify the two computations']`, and `findingPath === `.baiton/runs/${RUN}/finding.md``; `h.findings.length === 1` and `h.findings[0].runId === RUN` (the sink fired exactly once).
   - `finding.md` exists at `path.join(h.runDir(RUN), 'finding.md')` and its text contains the finding sentence; no `plan.md`, `execute-1.md` or `review-1.md` exists in that directory.
   - The single launch id is `${RUN}.investigate.1`, its brief lives under the MAIN checkout (`path.join(repo, '.baiton', 'runs', `${RUN}.investigate.1`, 'brief.md')`, not under any worktree), and the brief text contains the question but no `Target branch:`-style run-branch mention of `baiton/investigate/` — assert only what `buildRunContext` actually emits, so read the brief and assert it contains the question and `src/a.ts` and does NOT contain `baiton/investigate/${RUN}`.
   - Git is untouched: `await h.service.branchHead('main') === mainHeadBefore`, `git(repo, 'branch', '--list', `baiton/investigate/${RUN}`).trim() === ''`, `(await h.service.status()).clean === true`, `await h.service.findCommitByRunId(RUN) === undefined`, and `fs.existsSync(path.join(repo, '.baiton', 'specs')) === false`.
   - The manifest read back has `state === 'answered'` and `attempts.investigate === 1` with `plan`/`execute`/`review` all `0`.

   Files: `test/integration.run-modes.test.ts`

7. Leave the Spec-mode acceptance test byte-for-byte unchanged and verify it

   test/integration.plan-execute-review.test.ts is named by this todo only as the test that must keep passing untouched: make NO edit to it (not even a comment or an import reorder). After writing the new file, prove it: `git status --porcelain` must list `test/integration.run-modes.test.ts` as the only change (`?? test/integration.run-modes.test.ts`), and `git diff -- test/integration.plan-execute-review.test.ts` must be empty. Run the spec-mode file explicitly as well (`npx mocha test/integration.plan-execute-review.test.ts`; note this repo's .mocharc `spec` glob makes a single-file invocation run the whole suite, which is fine — the whole suite is the check either way).

   Files: `test/integration.plan-execute-review.test.ts`

8. Typecheck, lint and run the suite

   Run, in order: `npx tsc -p . --noEmit` (must be silent), `npm run compile` (must be silent), `npx mocha` for the full suite, and `npm run lint`. The expected lint result is 0 errors and exactly 1 pre-existing warning (the `_legacy` unused variable in src/orchestrator/webviewProtocol.ts — do not chase its line number, it drifts). The suite baseline after T17 is 2020 passing / 1 pending / 0 failing; the new file adds its own cases on top and nothing else may change. Finally re-check `git status --porcelain` for residue: no `.baiton/runs/` or `.baiton/worktrees/` entries in THIS repository, because every case works inside its own `fs.mkdtempSync` repo and the `afterEach` removes it.

   Files: `test/integration.run-modes.test.ts`

## Risks

- Forgetting the committed `.baiton/.gitignore` with GITIGNORE_CONTENTS in makeRepo() makes the main checkout dirty as soon as a run dir or worktree appears, so every mergeRunWorktree call refuses `dirty-tree` and the happy-path merge case fails for the wrong reason.
- The merge refusal order is pinned (wrong-branch → base-moved → dirty-tree): the dirty-tree case must NOT also advance the base branch, or it refuses with `base-moved` instead. Conversely the base-moved case must leave the tree clean (commit the file), which the `git add -A` + `git commit` sequence does.
- An execute commit over an unchanged worktree is empty and `safeCommit` swallows the git failure, leaving `outcome.commits` empty and no Run-Id commit to assert. The stub executor must write a real file into the WORKTREE (not the main checkout) between `waitFor(1)` and `emitResult(EXECUTE_RESULT)`.
- Timing: the pipeline awaits real `git` child processes, so a `setImmediate`-only spin can outrun it. Every wait must go through `waitUntil` with a real 2 ms timer, and results must only be emitted after the corresponding watcher exists — emitting before `awaitStageResult` subscribes loses the result and hangs the case to the 60 s mocha timeout.
- Passing `createService` into `createRunPipeline` would replace the real worktree-bound git service with a fake and quietly gut the end-to-end value of the test; it must be omitted here even though test/runPipeline.test.ts injects one.
- The approved half of the decline case starts a real run whose stages never settle; leaving it running leaks a pending promise and a live terminal into the next test. It must be cancelled and awaited (`waitUntil(() => !pipeline.isRunning())`) before the case ends.
- `findRunWorktree` compares realpaths (git prints realpaths, and /tmp is a symlink on macOS), so any direct comparison of `git worktree list` output against a constructed path must go through `fs.realpathSync` or use `findRunWorktree` itself.
- If a brief assertion is written against prose that `buildRunContext` does not actually emit (e.g. a guessed heading), the case fails on wording rather than behaviour. Assert on the statement, the file paths, the branch and the section headings the run-context module really writes; when in doubt, read the brief in the failing output and assert the substring that is there.

## Acceptance

- test/integration.run-modes.test.ts exists and is the only file added or changed; `git diff -- test/integration.plan-execute-review.test.ts` is empty.
- A confirmed Bug run against a real temp repo creates `baiton/bug/<run-id>` and `.baiton/worktrees/<run-id>/`, runs plan → execute → review under launch ids `<run-id>.plan.1`/`.execute.1`/`.review.1` whose briefs live inside the worktree, lands exactly one commit carrying `bug(<run-id>): execute attempt 1` and a `Run-Id: <run-id>` trailer findable by `findCommitByRunId`, ends `state: 'done'` with `{ kind: 'verdict', verdict: 'pass' }`, writes `run.json`/`runs.jsonl`/`plan.md`/`execute-1.md`/`review-1.md` under `.baiton/runs/<run-id>/` in the main checkout, and leaves `main`, the main working tree and `.baiton/specs/` (which never comes into existence) untouched.
- A declined confirm card on both `start_run` and `investigate`, driven through the real tool registry over `createRunPipelineSeam` and the real pipeline, returns an error matching /declined/i and leaves no `.baiton/runs/`, no `.baiton/worktrees/`, no run branch, no terminal, no watcher and no pipeline event; the approved control case does start the real run.
- `mergeRunWorktree` on a finished run lands a real merge commit carrying `Run-Id: <run-id>` on the base branch, brings the executor's change into the main checkout, deregisters the worktree and deletes the run branch with an empty `cleanup`; it refuses `base-moved` (with `expected`/`actual` naming the manifest's baseHead and the new head) when the base advanced, and `dirty-tree` (naming `README.md`) when the main checkout is dirty, and in both refusals the worktree, the branch and the base head are left exactly as they were.
- `pipeline.cancel()` during the plan stage ends the run `state: 'cancelled'` with no commits and KEEPS both `.baiton/worktrees/<run-id>/` (still registered with git) and `baiton/bug/<run-id>`.
- An investigate run creates no branch, no worktree and no commit (`findCommitByRunId` is undefined, `main`'s head and the working tree are unchanged), launches one `<run-id>.investigate.1` stage from the main checkout, writes `.baiton/runs/<run-id>/finding.md` and no plan/execute/review artifact, ends `state: 'answered'` with `{ kind: 'finding', finding }`, and fires `onFinding` exactly once with the question, question files, finding, files, next steps and `findingPath`.
- `npx tsc -p . --noEmit` and `npm run compile` are silent; `npm run lint` reports 0 errors and only the pre-existing `_legacy` warning; the full `npx mocha` suite passes with 0 failing and the post-T17 baseline of 2020 passing grown only by the new cases.
- `git status --porcelain` in the repository shows no `.baiton/runs/` or `.baiton/worktrees/` residue after the suite runs.
