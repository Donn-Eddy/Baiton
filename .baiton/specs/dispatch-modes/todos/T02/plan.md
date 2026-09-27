# Plan T02

## Steps

1. Create src/engine/runStore.ts with the manifest vocabulary

   New host-free module (no `vscode` import), sync `fs` like its engine neighbours (`launcher.ts`, `resultFlow.ts`, `askRelay.ts`). Module doc comment: one manifest per spec-less run at `.baiton/runs/<run-id>/run.json`; the run id stands in for a todo id; nothing here ever touches `.baiton/specs/`.

   Imports: `mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, existsSync` from 'fs'; `* as path`; `type Stage` and `isStage` from '../model/stage'; `type RunMode`, `isRunMode` from '../model/mode'; `Result, ok, err` from '../model/result'; `persistencePathForStage` from '../schema'; `type ArtifactWriter` from './resultFlow'.

   Export the vocabulary:
   - `export type RunState = 'confirmed' | 'planning' | 'planned' | 'executing' | 'executed' | 'reviewing' | 'done' | 'failed' | 'cancelled' | 'answered' | 'merged';` plus `export const RUN_STATES: readonly RunState[]` in that order, `export function isRunState(value: string): value is RunState`, and `export function isRunComplete(state: RunState): boolean` returning true for `done | failed | cancelled | answered | merged` (the Runs view's Active/Complete split, and the states that stamp `completedAt`).
   - `export type RunStage = Extract<Stage, 'plan' | 'execute' | 'review' | 'investigate'>;` with `export const RUN_STAGES: readonly RunStage[]` and `export function isRunStage(value: string): value is RunStage` (implemented as `isStage(value) && (RUN_STAGES as readonly string[]).includes(value)`).
   - `export interface RunAttempts extends Record<RunStage, number> { plan: number; execute: number; review: number; investigate: number }` — declare it as a plain interface with the four numeric fields; keep the four keys exhaustive over `RunStage` so a later stage addition breaks the build here.
   - `export type RunOutcomeRecord = { kind: 'verdict'; verdict: 'pass' | 'findings' } | { kind: 'finding'; finding: string } | { kind: 'cancelled' } | { kind: 'failed'; message: string };` NOTE the name: `src/engine/resultFlow.ts` already exports `RunOutcome` through the same `src/engine/index.ts` barrel, so this type must NOT be called `RunOutcome`.
   - `export const RUN_MANIFEST_VERSION = 1;`
   - `export interface RunManifest` with exactly: `version: number`; `id: string`; `mode: RunMode`; `composerMode: RunMode`; `explicitMode: boolean`; `statement: string`; `files: string[]`; `reproduction?: string`; `baseBranch: string`; `baseHead: string`; `branch: string`; `worktreeDir?: string`; `state: RunState`; `attempts: RunAttempts`; `outcome?: RunOutcomeRecord`; `createdAt: string`; `updatedAt: string`; `completedAt?: string`. Doc each field: `mode` is the mode the run actually runs as; `composerMode` is what the composer's Mode select said; `explicitMode` is true when the orchestrator proposed a different mode than `composerMode`; `baseBranch`/`baseHead` are the branch checked out when the run started and its head commit at that moment (the merge-time `base-moved` check); `worktreeDir` is repository-relative (`.baiton/worktrees/<run-id>`) and absent for an `investigate` run, which has no worktree.
   - `export type RunStoreError = { kind: 'invalid-id'; runId: string; message: string } | { kind: 'duplicate'; runId: string; path: string; message: string } | { kind: 'absent'; runId: string; path: string; message: string } | { kind: 'unparseable'; runId: string; path: string; message: string } | { kind: 'invalid'; runId: string; path: string; message: string } | { kind: 'io'; runId: string; path: string; message: string };` (mirrors `ConfigDocumentError` in `src/config/configDocument.ts`: every expected failure is a returned `Result`, never a throw).

   Files: `src/engine/runStore.ts`

2. Path, branch and run-id helpers

   All pure, all exported from `runStore.ts`, all taking an absolute `workspaceRoot` (matching `launchStage`, which composes `<root>/.baiton/runs/<runId>` itself):
   - `export const RUN_MANIFEST_FILE = 'run.json';` and `export const RUN_JOURNAL_FILE = 'runs.jsonl';`
   - `runsRootDir(workspaceRoot): string` → `path.join(workspaceRoot, '.baiton', 'runs')`
   - `runDirFor(workspaceRoot, runId): string` → `runsRootDir(...)/<runId>`
   - `runManifestPathFor(workspaceRoot, runId)` → `<runDir>/run.json`
   - `runJournalPathFor(workspaceRoot, runId)` → `<runDir>/runs.jsonl` (the run's own journal; the run id is the journal's subject id, exactly as `specDraft.ts` passes the slug as `todoId`)
   - `runWorktreeDirFor(workspaceRoot, runId)` → `path.join(workspaceRoot, '.baiton', 'worktrees', runId)`
   - `runBranchFor(mode: RunMode, runId: string): string` → `` `baiton/${mode}/${runId}` ``
   - `export function isRunId(value: string): boolean` → `/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(value)`. A run id must contain NO dot: launch directories are siblings named `<run-id>.<stage>.<n>` under the same `.baiton/runs/`, so a dot in a run id would make that name ambiguous. Document this constraint on the function.
   - `export function newRunId(mode: RunMode, now: () => string = () => new Date().toISOString(), random: () => number = Math.random): string` → `<mode>-<stamp>-<suffix4>` where `stamp` is the ISO string reduced the way `SessionStore.create` reduces it (`now.replace(/[-:]/g,'').replace(/\.\d+Z?$/,'').replace('T','-').slice(0,15)`) and `suffix4` is four chars drawn from `'0123456789abcdefghijklmnopqrstuvwxyz'` via `random()`; e.g. `bug-20260926-141501-a1b2`. It must always satisfy `isRunId`.

   Files: `src/engine/runStore.ts`

3. Launch-id composition and parsing

   In `runStore.ts`:
   - `export function launchIdFor(runId: string, stage: RunStage, attempt: number): string` → `` `${runId}.${stage}.${attempt}` ``. Doc: this is the id handed to `launchStage`'s `runId` input, so the stage's brief/result/asks land in `.baiton/runs/<run-id>.<stage>.<n>/` and the role profiles' relative run-dir grants are reused unchanged.
   - `export interface ParsedLaunchId { runId: string; stage: RunStage; attempt: number }`
   - `export function parseLaunchId(value: string): ParsedLaunchId | undefined` — split on `'.'`; require exactly three parts; part 0 must satisfy `isRunId`; part 1 must satisfy `isRunStage`; part 2 must match `/^[1-9][0-9]*$/` and parse to a finite integer. Return `undefined` otherwise. Note in the doc that `plan-review` contains a hyphen, not a dot, so the three-way split is unambiguous.
   - `export function isRunLaunchDirName(name: string): boolean` → `parseLaunchId(name) !== undefined`; `list()` uses it to skip launch directories, and the Runs-view watcher (a later todo) uses it to ignore their file events.

   Files: `src/engine/runStore.ts`

4. Pure manifest parse/validate and serialize

   In `runStore.ts`, exported so the Runs-view watcher and tests can validate without touching the store:
   - `export function parseRunManifest(text: string): Result<RunManifest, string>` — `JSON.parse` in a try/catch (error string `not valid JSON: <message>`), reject a non-object or array, then check every field and return a *freshly constructed* manifest object (so unknown keys are dropped and the returned value is exactly the declared shape):
     * `version` must be the number `RUN_MANIFEST_VERSION` (`unsupported manifest version <v>` otherwise);
     * `id` a string satisfying `isRunId`;
     * `mode` a string satisfying `isRunMode` AND not `'spec'` — a manifest only ever describes a spec-less run; message `mode "spec" has no run manifest`;
     * `composerMode` a string satisfying `isRunMode`;
     * `explicitMode` a boolean; `statement`, `baseBranch`, `baseHead`, `branch` non-empty strings; `files` an array of strings; `reproduction`, `worktreeDir`, `completedAt` absent or strings;
     * `state` a string satisfying `isRunState`;
     * `attempts` an object whose four `RunStage` keys are each a non-negative integer (missing key → error naming the key);
     * `outcome` absent, or an object whose `kind` is one of the four variants with the right payload (`verdict` in `{'pass','findings'}`; `finding` a string; `failed` carrying a string `message`);
     * `createdAt`/`updatedAt` non-empty strings.
     Build optional fields with the repo's `...(x !== undefined ? { x } : {})` spread idiom.
   - `export function serializeRunManifest(manifest: RunManifest): string` → `JSON.stringify(manifest, null, 2) + '\n'`, matching `writeJsonAtomic` in `src/config/loadConfig.ts`.
   Keep both functions free of `fs` so they are unit-testable on strings alone.

   Files: `src/engine/runStore.ts`

5. The RunStore class: atomic create / read / update / bumpAttempt / list

   In `runStore.ts`:
   ```ts
   export interface RunStoreOptions {
     /** Absolute workspace root; `.baiton/runs/` is resolved under it. */
     workspaceRoot: string;
     /** ISO-8601 clock for timestamps; injected for deterministic tests. */
     now?: () => string;
   }
   export class RunStore { constructor(options: RunStoreOptions) {...} }
   export function createRunStore(options: RunStoreOptions): RunStore
   ```
   Do NOT export a type named `Clock` — `src/engine/runQueue.ts` already exports `Clock` through the same barrel; inject plain `() => string` instead.

   Methods (all synchronous, all returning `Result<..., RunStoreError>` except where noted):
   - `manifestPath(runId)`, `dirFor(runId)`, `worktreeDirFor(runId)` — thin wrappers over the helpers, bound to `workspaceRoot`.
   - `exists(runId): boolean` — `existsSync(this.manifestPath(runId))`.
   - `create(input: NewRunInput): Result<RunManifest, RunStoreError>` where
   ```ts
   export interface NewRunInput {
     id: string;
     mode: RunMode;
     composerMode: RunMode;
     explicitMode: boolean;
     statement: string;
     files: string[];
     reproduction?: string;
     baseBranch: string;
     baseHead: string;
     /** Repository-relative worktree dir; omitted for an investigate run. */
     worktreeDir?: string;
   }
   ```
     Refuse `invalid-id` when `!isRunId(input.id)` and when `input.mode === 'spec'` (message: a spec conversation dispatches `draft_spec`, not a run). Refuse `duplicate` when `exists(input.id)`. Otherwise build the manifest with `version: RUN_MANIFEST_VERSION`, `branch: runBranchFor(input.mode, input.id)`, `state: 'confirmed'`, `attempts: { plan: 0, execute: 0, review: 0, investigate: 0 }`, `createdAt = updatedAt = this.now()`, no `outcome`, no `completedAt`; write it atomically (below) and return it.
   - `read(runId): Result<RunManifest, RunStoreError>` — `invalid-id` for a bad id; `readFileSync` in a try/catch mapping `ENOENT` to `absent` and anything else to `io`; then `parseRunManifest`, mapping a JSON failure to `unparseable` and a shape failure to `invalid`, each carrying the manifest path and the parser's message.
   - `update(runId, patch: RunUpdate): Result<RunManifest, RunStoreError>` where
   ```ts
   export interface RunUpdate {
     state?: RunState;
     outcome?: RunOutcomeRecord;
     attempts?: Partial<RunAttempts>;
     worktreeDir?: string;
   }
   ```
     Read-modify-write: `read`, then merge (`attempts` merged key-by-key over the current values, never replaced wholesale), set `updatedAt = this.now()`, and set `completedAt = updatedAt` the first time the resulting `state` satisfies `isRunComplete` (leave an existing `completedAt` untouched; a patch that moves the run back to an active state clears it). Immutable fields (`id`, `version`, `mode`, `composerMode`, `explicitMode`, `statement`, `files`, `reproduction`, `baseBranch`, `baseHead`, `branch`, `createdAt`) are not in `RunUpdate` and must not change. Write atomically and return the new manifest.
   - `bumpAttempt(runId, stage: RunStage): Result<{ manifest: RunManifest; attempt: number; launchId: string }, RunStoreError>` — `update` with `attempts: { [stage]: current + 1 }`, returning the new 1-based attempt and `launchIdFor(runId, stage, attempt)`. This is the one call the pipeline makes per stage launch.
   - `list(): RunManifest[]` — `readdirSync(runsRootDir(...), { withFileTypes: true })`, ENOENT → `[]`; keep directory entries only; skip any whose name `isRunLaunchDirName` or that has no `run.json`; `read` each and silently drop the ones that fail (a half-written or foreign manifest must never break the Runs view); sort newest-first by `createdAt` descending with ties broken by `id` descending, the ordering `SessionStore.list` uses.

   Private `writeManifest(manifest)`: `mkdirSync(dirname, { recursive: true })`, write `serializeRunManifest` to `<dir>/.run.json.<pid>.<Date.now()>.tmp`, `renameSync` it over `run.json`, and on a rename failure remove the temp file best-effort and return an `io` error carrying the original message — the same atomic-by-replace shape as `writeJsonAtomic` in `src/config/loadConfig.ts` and `writeResponseAtomic` in `src/engine/askRelay.ts`, so a crash mid-write never leaves a truncated manifest.

   Files: `src/engine/runStore.ts`

6. The run-dir artifact writer

   Still in `runStore.ts`. `awaitStageResult` composes its own destination with `artifactPathFor(root, slug, ...)` under `.baiton/specs/<slug>/` and hands it to the injected `ArtifactWriter`; a run has no slug, so the run pipeline overrides the writer with one that IGNORES the path it is handed and writes into the run directory instead.
   ```ts
   export function runArtifactFileName(stage: RunStage, attempt?: number): string {
     return path.basename(persistencePathForStage(stage, '', attempt));
   }
   export function runArtifactPathFor(workspaceRoot: string, runId: string, stage: RunStage, attempt?: number): string {
     return path.join(runDirFor(workspaceRoot, runId), runArtifactFileName(stage, attempt));
   }
   export interface RunArtifactTarget {
     /** Absolute path the rendered artifact lands at. */
     path: string;
     /** The writer handed to `awaitStageResult`; its path argument is ignored. */
     write: ArtifactWriter;
   }
   export function runArtifactWriter(workspaceRoot: string, runId: string, stage: RunStage, attempt?: number): RunArtifactTarget
   ```
   `runArtifactFileName` takes the basename of `persistencePathForStage` so the naming rule stays in one place: `plan` → `plan.md`, `execute` → `execute-<n>.md`, `review` → `review-<n>.md`, `investigate` → `finding.md` (`persistencePathForStage` throws through its own `requireIndex` when a numbered stage is given no attempt — let that propagate). `runArtifactWriter`'s `write` is `(_artifactPath, contents) => { mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, contents, 'utf8'); }` — the leading underscore satisfies `noUnusedParameters` and the eslint `argsIgnorePattern`. Doc-comment why the argument is ignored and that `RunArtifactTarget.path` is what the caller journals, since the `RunOutcome.artifactPath` `awaitStageResult` resolves with is the unused spec-relative path.

   Files: `src/engine/runStore.ts`

7. Export the module from the engine barrel

   In `src/engine/index.ts` add `export * from './runStore';` after `export * from './specDraft';` and extend the module doc comment's sentence list with the run manifest store. Verify no export name collides with the existing barrel: `RunOutcome` (resultFlow), `RunRequest`, `RunQueue`, `RunIdGenerator`, `Clock` (runQueue) are already taken — `RunState`, `RunStore`, `RunManifest`, `RunStage`, `RunAttempts`, `RunOutcomeRecord`, `RunUpdate`, `NewRunInput` are free. `npm run compile` is the check: TypeScript reports a duplicate `export *` name as an error at the barrel.

   Files: `src/engine/index.ts`

8. Write test/runStore.test.ts

   New mocha + `assert` test file in the repo's style (see `test/engine.specDraft.test.ts`): plain `import * as assert from 'assert'`, no `vscode` import, a `fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-runstore-'))` root created in `beforeEach` and `fs.rmSync(root, { recursive: true, force: true })` in `afterEach`. Import from `../src/engine/runStore`. Build the store with an injected `now` returning a controllable ISO string so timestamps are deterministic.
   Describes and cases:
   1. `run vocabulary` — `RUN_STATES` has the 11 states in order and `isRunState` accepts each and rejects `'bogus'`; `isRunComplete` is true for exactly `done|failed|cancelled|answered|merged`; `RUN_STAGES` is `['plan','execute','review','investigate']` and `isRunStage` rejects `'spec-draft'` and `'plan-review'`.
   2. `paths and ids` — `runDirFor`/`runManifestPathFor`/`runJournalPathFor` land under `.baiton/runs/<id>/`; `runWorktreeDirFor` under `.baiton/worktrees/<id>/`; `runBranchFor('bug','r1') === 'baiton/bug/r1'`; `isRunId` rejects `''`, `'a.b'`, `'..'`, `'a/b'` and accepts `'bug-20260926-141501-a1b2'`; `newRunId('quick', stubNow, stubRandom)` is deterministic, starts with `quick-`, and satisfies `isRunId`.
   3. `launch ids` — `launchIdFor('r1','execute',2) === 'r1.execute.2'`; `parseLaunchId` round-trips every `RunStage`; rejects `'r1.plan'`, `'r1.plan.0'`, `'r1.plan.x'`, `'r1.plan-review.1'` (not a run stage) and `'a.b.c.d'`; `isRunLaunchDirName` is true for a launch dir and false for a bare run id.
   4. `create` — writes `run.json` on disk, the file parses back equal to the returned manifest (`assert.deepStrictEqual` after `parseRunManifest`), state is `confirmed`, attempts are all `0`, `branch` is derived, `createdAt === updatedAt`, no `outcome`/`completedAt`; a second `create` with the same id returns `duplicate` and leaves the first file byte-identical; `create` with `mode: 'spec'` and with an id containing a dot both return `invalid-id` and write nothing.
   5. `read` — `absent` for an unknown id; `unparseable` for `run.json` containing `'{'`; `invalid` for a manifest with `state: 'nope'`, for one with `mode: 'spec'`, for one missing `attempts.review`, and for `version: 2`; a hand-written manifest with extra unknown keys reads back without them.
   6. `update` — sets state and stamps a later `updatedAt` while `createdAt` is unchanged; `attempts: { execute: 3 }` leaves the other counters alone; moving to `done` stamps `completedAt` once and a further update keeps the same value; `outcome: { kind: 'verdict', verdict: 'findings' }` and `{ kind: 'finding', finding: '...' }` round-trip through disk; updating an unknown id returns `absent`.
   7. `bumpAttempt` — successive calls return 1, 2, 3 with launch ids `r1.execute.1..3` and the manifest's counter follows; bumping `plan` does not move `execute`.
   8. `list` — empty when `.baiton/runs/` does not exist; returns only real runs, skipping a `r1.plan.1/` launch directory (with a `brief.md` in it), a bare directory with no `run.json`, and a directory whose `run.json` is malformed; sorted newest-first by `createdAt` with the `id`-descending tie-break.
   9. `artifact writer` — `runArtifactPathFor` gives `plan.md`, `execute-2.md`, `review-1.md`, `finding.md` inside the run dir; `runArtifactWriter(root, 'r1', 'execute', 2).write('/tmp/some/spec/path.md', 'body')` creates the run dir if needed and writes `body` to `<runDir>/execute-2.md`, and nothing is created at the ignored path; `path` on the returned target equals `runArtifactPathFor(...)`.
   10. `atomic write` — after a `create` and two `update`s, `readdirSync(runDir)` contains only `run.json` (no `.tmp` leftovers).

   Files: `test/runStore.test.ts`

9. Verify

   Run `npm run compile`, `npm run lint` and `npm test` from the repository root. Compile and lint must be clean apart from the one pre-existing warning at `src/orchestrator/webviewProtocol.ts:591` (`'_legacy' is assigned a value but never used`). The full suite must pass with every existing test file untouched — this todo adds one new test file and one new source file and edits only `src/engine/index.ts`.

   Files: `src/engine/runStore.ts`, `src/engine/index.ts`, `test/runStore.test.ts`

## Risks

- Name collision in the `src/engine/index.ts` barrel: `resultFlow.ts` already exports `RunOutcome`, and `runQueue.ts` exports `RunRequest`, `RunQueue`, `RunIdGenerator` and `Clock`. The manifest's outcome type must be `RunOutcomeRecord`, the store must inject a plain `now?: () => string` rather than export a `Clock`, and the creation input must be `NewRunInput`, not `RunRequest`. `npm run compile` catches a slip here, but only after the barrel edit.
- Run ids must contain no `.`: launch directories are siblings of run directories under `.baiton/runs/`, named `<run-id>.<stage>.<n>`. `isRunId` enforces this and `list()` relies on it to tell a run apart from one of its launches. A later todo that invents its own run ids must go through `newRunId`/`isRunId`.
- `persistencePathForStage('plan'|'execute'|'review', ...)` returns a `todos/<todoId>/...` path; only its basename is meaningful for a run. Taking `path.basename` keeps the file-naming rule in one place, but it silently depends on that function never returning a bare name for those stages — the artifact-writer tests pin the four resulting names.
- Rejecting `mode: 'spec'` in both `create` and `parseRunManifest` is a deliberate reading of the OVERVIEW (a spec conversation dispatches `draft_spec`, so no manifest exists for it). If a later todo wants a manifest for a spec run, that check is a one-line relaxation in each place.
- `update` is read-modify-write with no locking, so two concurrent writers could lose an update. This is acceptable because the pipeline enforces one stage per repository and is the only writer; the atomic rename still guarantees no reader ever sees a truncated manifest. Worth a comment in the module rather than a lock.
- `list()` silently drops manifests that fail to parse so the Runs view cannot be broken by a foreign or half-written file. That also hides genuine corruption; if a later todo needs to surface it, `read()` still returns the classified error per run.

## Acceptance

- `npm run compile` is clean (no duplicate-export error from the `src/engine/index.ts` barrel).
- `npm run lint` reports no new errors or warnings beyond the pre-existing `_legacy` warning at src/orchestrator/webviewProtocol.ts:591.
- `npm test` passes in full, with no existing test file modified and `test/runStore.test.ts` added.
- `RunStore.create` writes `.baiton/runs/<run-id>/run.json` atomically and a second create for the same id is refused as `duplicate` without touching the existing file.
- `read` classifies absent / unparseable / invalid (bad state, `mode: 'spec'`, missing attempt counter, wrong `version`) rather than throwing, and a valid manifest round-trips create → disk → read by `deepStrictEqual`.
- `update` merges `attempts` key-by-key, refreshes `updatedAt`, stamps `completedAt` exactly once when the run reaches a complete state, and never alters `id`, `mode`, `branch`, `baseBranch`, `baseHead` or `createdAt`.
- `bumpAttempt(runId, stage)` returns 1-based attempts and the launch id `<run-id>.<stage>.<n>`, and `parseLaunchId` round-trips that id back to its three parts for every `RunStage`.
- `list()` returns runs newest-first and skips launch directories (`<run-id>.<stage>.<n>`), directories with no `run.json`, and unparseable manifests; a missing `.baiton/runs/` lists as no runs.
- `runArtifactWriter` ignores the spec-relative path `awaitStageResult` hands it and writes `plan.md` / `execute-<n>.md` / `review-<n>.md` / `finding.md` into `.baiton/runs/<run-id>/`, creating the directory if needed; nothing is written under `.baiton/specs/`.
- After a create and several updates the run directory contains only `run.json` — no `.tmp` files are left behind.
