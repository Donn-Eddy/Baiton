# Plan T03

## Steps

1. Add the document-location resolver module

   Create `src/storage/documentLocation.ts`. It is host-free (node `fs` + `path` only, no `vscode`) and synchronous, so the sync journal code and `artifactPathFor` can use it. Import `DocumentKind` (`'plan' | 'legacy-spec'`) from `../model/parser`.

   Exports:
   - `export const PLANS_SUBDIR = 'plans';`
   - `export const LEGACY_SPECS_SUBDIR = 'specs';` with a comment `// Legacy: pre-phased-plan documents live under .baiton/specs/; read-only compatibility.`
   - `export function documentFileName(kind: DocumentKind): 'plan.md' | 'spec.md'` (legacy-spec → 'spec.md').
   - `export function artifactsSubdirName(kind: DocumentKind): 'phases' | 'todos'` (legacy-spec → 'todos', marked legacy).
   - `export interface DocumentLocation { slug: string; kind: DocumentKind; dir: string /* abs <baitonDir>/<root>/<slug> */; documentPath: string /* dir/plan.md | dir/spec.md */; artifactsDir: string /* dir/phases | dir/todos */; pathspec: string /* repo-relative '.baiton/plans/<slug>' or '.baiton/specs/<slug>', forward slashes */ }`
   - `export function locationFor(baitonDir: string, slug: string, kind: DocumentKind): DocumentLocation` — pure path arithmetic; root is `plans` for kind 'plan', `specs` for 'legacy-spec'.
   - `export function resolveDocument(baitonDir: string, slug: string): DocumentLocation` — the ONE resolution rule, documented in its JSDoc: (1) `plans/<slug>/plan.md` exists → plan; (2) else `specs/<slug>/spec.md` exists → legacy-spec; (3) else `plans/<slug>/` dir exists → plan; (4) else `specs/<slug>/` dir exists → legacy-spec (covers a legacy draft that journaled before its spec.md landed); (5) else → plan (new documents are only ever written under `plans/`). A slug present under both roots therefore always resolves to `plans/` and nothing ever writes to `specs/` for it. Use `existsSync`/`statSync` wrapped in try/catch.
   - `export function phaseArtifactDir(location: DocumentLocation, phaseId: string): string` → `path.join(location.artifactsDir, phaseId)`.
   - `export function listDocumentSlugs(baitonDir: string): string[]` — sync; union of directory names under `plans/` and `specs/` (each readdir in try/catch, missing root → none), deduplicated, sorted ascending.

   Add a header comment describing the two layouts (`.baiton/plans/<slug>/plan.md` + `phases/<id>/`, and legacy `.baiton/specs/<slug>/spec.md` + `todos/<id>/`).

   Files: `src/storage/documentLocation.ts`

2. Make persistencePathForStage kind-aware

   In `src/schema/index.ts` change the signature to `persistencePathForStage(stage: Stage, phaseId?: string, n?: number, kind: DocumentKind = 'plan'): string` (import `type DocumentKind` from `../model/parser`). Cases: `plan-draft` → `kind === 'plan' ? 'plan.md' : 'spec.md'` (remove the 'still persists to spec.md' comment); `plan`/`plan-review`/`execute`/`review` → `${phaseArtifactDir(stage, phaseId, kind)}/…` where the renamed helper (`todoArtifactDir`→`phaseArtifactDir`, `TODO_ID_SEGMENT`→`PHASE_ID_SEGMENT`) returns `phases/<id>` for 'plan' and `todos/<id>` for 'legacy-spec' (comment the legacy branch as legacy). `pr` → 'pr.md', `investigate` → 'finding.md' unchanged. Reword the JSDoc and error text to plan/phase vocabulary ("requires a plain phase id"). Do not import the fs resolver here; schema stays pure — callers pass the kind. Also reword the stage-artifact comments in this file ("per-todo", "spec-scoped") to phase/plan wording. `runStore.ts` calls it with a placeholder id and only takes the basename, so it needs no change (optionally rename `RUN_ARTIFACT_TODO_ID` comment wording only if trivially safe; not required).

   Files: `src/schema/index.ts`

3. Route resultFlow's artifact path through the resolver

   In `src/engine/resultFlow.ts`, `artifactPathFor(workspaceRoot, slug, stage, phaseId?, index?)` keeps its parameters but becomes: `const location = resolveDocument(path.join(workspaceRoot, '.baiton'), slug); return path.join(location.dir, persistencePathForStage(stage, phaseId, index, location.kind));`. Rename the `todoId` field/param to `phaseId` only inside `artifactPathFor`'s signature docs if it does not ripple; keep `AwaitStageResultInput.todoId` as is (the engine phase renames queue fields) — but reword its JSDoc to `phases/<id>/` (or legacy `todos/<id>/`). Update the default writer comment. specDraft passes a no-op writer, so its behaviour is unchanged.

   Files: `src/engine/resultFlow.ts`

4. Rename and re-root the journal path helpers

   In `src/journal/journal.ts` replace the specsDir-based helpers with baitonDir-based ones that go through `resolveDocument`:
   - `specJournalPathFor(specsDir, slug)` → `planJournalPathFor(baitonDir, slug)` = `join(resolveDocument(baitonDir, slug).dir, JOURNAL_FILE)`.
   - `todoJournalPathFor(specsDir, slug, todoId)` → `phaseJournalPathFor(baitonDir, slug, phaseId)` = `join(phaseArtifactDir(resolveDocument(baitonDir, slug), phaseId), JOURNAL_FILE)`.
   - `specJournalPaths` → `planJournalPaths(baitonDir, slug)` (reads `location.artifactsDir` instead of a hard-coded `todos`).
   - `readSpecJournal` → `readPlanJournal(baitonDir, slug)`.
   Keep `JOURNAL_FILE`, `parseJournal`, `appendStart`, `appendCompletion`, `latestStart`, `resumableSessionId` and the on-disk record format (the `todoId` record field stays — journal key names do not change). Reword comments to plan/phase vocabulary. Update `src/journal/index.ts`'s header comment (`readPlanJournal`, `phases/<id>/runs.jsonl`, legacy `todos/<id>/`).

   Files: `src/journal/journal.ts`, `src/journal/index.ts`

5. Rename specBranchWriter → planBranchWriter and resolve the folder per call

   `git mv src/engine/specBranchWriter.ts src/engine/planBranchWriter.ts`. Renames: `SpecBranchWriterDeps`→`PlanBranchWriterDeps` with `{ baitonDir: string /* abs .baiton of MAIN checkout */; git: Pick<GitWorktreeService,'commitPaths'> }`; `SpecWriteScope`→`PlanWriteScope` gaining `readonly location: DocumentLocation` (keep `slug`, `dir` = `location.dir`); `SpecBranchWriter`→`PlanBranchWriter`; `createSpecBranchWriter`→`createPlanBranchWriter`; `specFolderPathspec(slug)` → `planFolderPathspec(location: DocumentLocation): string` returning `location.pathspec`. Inside `apply`, build the scope lazily inside the lock (`prev.then(() => fn(scopeFor(slug)))`) where `scopeFor` calls `resolveDocument(deps.baitonDir, slug)`, so a document created by an earlier queued callback is seen; `commit` stages only `[location.pathspec]` via `commitPaths`. Lock keying by slug is unchanged. Update `src/engine/index.ts` to `export * from './planBranchWriter';`. In `src/engine/runQueue.ts` change the import to `import type { PlanBranchWriter } from './planBranchWriter'` and the two `Pick<SpecBranchWriter,'apply'>` uses; also rename the `SpecStore` interface to `PlanStore` (type name only — keep the `specStore`/`specWriter` deps property names for the engine phase) and update every `SpecStore` type reference in src (`recovery.ts`, `stageContext.ts` comment, `specExplorer.ts`, `engineFacade.ts`) and test fakes that import the type (grep `\bSpecStore\b`). In `todoWorktree.ts`, update any `SpecBranchWriter` type import if present.

   Files: `src/engine/planBranchWriter.ts`, `src/engine/index.ts`, `src/engine/runQueue.ts`, `src/engine/recovery.ts`, `src/engine/stageContext.ts`, `src/activation/engineFacade.ts`

6. Rename specStore → planStore and resolve paths from the document kind

   `git mv src/activation/specStore.ts src/activation/planStore.ts`. `createSpecStore(specsDir, git, writer)` → `createPlanStore(baitonDir: string, git: GitWorktreeService, writer: PlanBranchWriter = createPlanBranchWriter({ baitonDir, git })): PlanStore`. Replace `specPath`/`todoDir` with `const locate = (slug) => resolveDocument(baitonDir, slug)`; document reads use `locate(slug).documentPath`; `readArtifact` uses `phaseArtifactDir(location, phaseId)` and `baseName(persistencePathForStage(stage, phaseId, undefined, location.kind))`; journal reads use `readPlanJournal(baitonDir, slug)`. `writeState` inside `writer.apply(slug, async (scope) => …)` reads/writes `scope.location.documentPath` and commits `plan(${slug}): ${phaseId} ${what(state, note)}`. Rename locals (`readSpec`→keep the `readSpec` METHOD name only if it is part of the PlanStore interface in runQueue.ts — check; if it is, leave the method name for the engine phase and just rename the local helper `readPlan`). Rename `todoId` params to `phaseId`. Rewrite the header comment in plan/phase terms (commits only the document's folder via `commitPaths`, `plan(<slug>): <id> <what>`).

   Files: `src/activation/planStore.ts`

7. Rename specLister → planLister listing both roots

   `git mv src/activation/specLister.ts src/activation/planLister.ts`. `ListedSpec`→`ListedPlan { slug: string; kind: DocumentKind; raw?: string; readError?: string }`. `listSpecs(specsDir)` → `listPlans(baitonDir: string): Promise<ListedPlan[]>`: for each slug from `listDocumentSlugs(baitonDir)`, take `resolveDocument(baitonDir, slug)`, read `documentPath`; ENOENT → skip (a dir without a document is not a plan); other errors → `{ slug, kind, readError }`. Result stays ascending by slug, one entry per slug (plans/ wins). `describeError` fallback text: `'the plan document could not be read'`. `planPath(specsDir, slug, todoId)` → `phasePlanPath(baitonDir, slug, phaseId)` = `path.join(phaseArtifactDir(resolveDocument(baitonDir, slug), phaseId), 'plan.md')` (this is the planner's per-phase output, distinct from the slug-root document). `listTodoPlans` → `listPhasePlans(baitonDir, slug)` reading `location.artifactsDir`. Rewrite comments in plan/phase terms.

   Files: `src/activation/planLister.ts`

8. Route submitPr through the resolver

   In `src/engine/submitPr.ts`: `SubmitPrDeps.specsDir` → `baitonDir: string` (`/** The `.baiton` directory. */`). At the top of `submitPr`, `const location = resolveDocument(deps.baitonDir, slug); const documentPath = location.documentPath; const journalPath = planJournalPathFor(deps.baitonDir, slug);`. `checkReady(slug, documentPath, deps)`; reword its messages to `plan "${slug}" was not found` / `is already done` / `is not approved or its approval is stale; re-approve first` / `has no phases` / `could not list the unlanded phases of plan …`. `countPrStarts(baitonDir, slug)` uses `readPlanJournal`. `prContext` takes `{ location: DocumentLocation; diffPath; base; branch }` and emits: for 'plan' — ``The plan is `<documentPath>`; its Endstate, What needs changing and Limitations & constraints sections and its phase list describe the work.`` and ``Each phase's plan and execution summaries live in its own folder: `<artifactsDir>/<phase-id>/plan.md` and `execute-<n>.md` beside it.``; for 'legacy-spec' (marked `// Legacy:`) the same sentences naming the `spec.md` file, its OVERVIEW/todo list and `todos/<todo-id>/`. Commit messages → `plan(${slug}): pr draft` and `plan(${slug}): pr`. Rename `ReadySpec`→`ReadyPlan`. Update the caller in `src/activation/commands.ts` (`submitPr(slug, { …, baitonDir, … })`).

   Files: `src/engine/submitPr.ts`, `src/activation/commands.ts`

9. Scope the git clean check to the resolved document folder

   In `src/git/gitService.ts` `isCleanExceptSpecFolder(slug)`: replace the `SPEC_ROOT` constant prefix with `const prefix = `${resolveDocument(path.join(this.repoRoot, '.baiton'), slug).pathspec}/`;` so a plan under `.baiton/plans/<slug>/` and a legacy spec under `.baiton/specs/<slug>/` are each treated as the slug's own folder. Keep the method name (the engine phase renames it); update its JSDoc in `src/git/types.ts` to say it is the resolved document folder (plans/ or legacy specs/). Update the porcelain comment wording. Add a gitService test case: changes confined to `.baiton/plans/my-slug/` with a `plan.md` present → true; existing legacy cases keep passing.

   Files: `src/git/gitService.ts`, `src/git/types.ts`, `test/gitService.test.ts`

10. Initialize and gitignore for the plans root

   `src/config/initialize.ts`: create `runs/` and `plans/` (replace `specsDir`/`specs/` with `plansDir = path.join(baitonDir, PLANS_SUBDIR)`); new layouts never get a `specs/` dir. Update the header and step-1 comments. `src/config/gitignore.ts`: add `'plans/*/chat/'` and `'plans/*/runs.jsonl'` after `/worktrees/`, keep the three `specs/*/…` lines under a `# Legacy specs/ documents.` comment line (a comment line inside the array is fine since it is literal file text), and update the doc comment listing. `refreshGitignore` will rewrite older files automatically. Update `test/config.test.ts` (~line 338–340) to assert `plans/` exists (and that `specs/` is not created).

   Files: `src/config/initialize.ts`, `src/config/gitignore.ts`, `test/config.test.ts`

11. Update every caller of the renamed storage APIs

   Mechanical rewiring, no logic change:
   - `src/activation/commands.ts`: `createPlanBranchWriter({ baitonDir, git })`, `createPlanStore(baitonDir, git, specWriter)` (local var names may stay `specWriter`/`specStore` or become `planWriter`/`planStore`; keep consistent within the file); `readSpecJournal(specsDir, …)` → `readPlanJournal(baitonDir, …)` (runView ~1401, `SpecCodeLensProvider` ~1804 — give it `baitonDir` in its constructor); `planPath(specsDir,…)` → `phasePlanPath(baitonDir,…)` (runViewPlan ~1717, plannedTodoIds ~1762, CodeLens ~1809); `plannedTodoIds` reads `resolveDocument(baitonDir, slug).artifactsDir`; the raw read at ~1672 uses `resolveDocument(baitonDir, slug).documentPath`; `pickSpecSlug` lists `listDocumentSlugs(baitonDir)` filtered to slugs whose resolved `documentPath` exists. `createTodoQueues({ … baitonDir … })`, `createRunQueueSeam(queueFor, baitonDir, adapterFor)`, `registerStageCommand/registerActionCommand/runShowPr/runSubmitPr/dispatchAndReport` pass `baitonDir` where they previously forwarded `specsDir` to journal/lister/store functions. Leave `specsDir` in place where it still feeds guard, `buildToolServices`, `createSpecDraftRunner`, `ChatController` deps and the spec.md file-watcher pattern (those belong to the orchestrator/drafting/UI phases).
   - `src/activation/engineFacade.ts`: `dispatchTrigger(queue, baitonDir, …)` uses `readPlanJournal`; `TodoQueuesDeps.specsDir`→`baitonDir`; `specWriter: PlanBranchWriter`; queue wiring uses `planJournalPathFor(baitonDir, slug)`, `phaseJournalPathFor(baitonDir, slug, id)`, `readPlanJournal(baitonDir, slug)`; `createRunQueueSeam(queueFor, baitonDir, adapterForRole)`.
   - `src/engine/recovery.ts`: union member `specsDir: string` → `baitonDir: string` (and `specsDir?: never` → `baitonDir?: never`), reads `readPlanJournal(deps.baitonDir, deps.slug)`.
   - `src/extension.ts` `runCrashRecovery`: slugs from `listDocumentSlugs(baitonDir)`, skip when `!planJournalPaths(baitonDir, slug).some(existsSync)`, pass `baitonDir` to `recoverJournal`; `makeRecoveryWriteState` reads/writes `resolveDocument(path.join(repoRoot,'.baiton'), slug).documentPath` (resolved per call) and commits `plan(${slug}): ${phaseId} recover ${state}`.
   - `src/activation/specExplorer.ts` (file rename is the UI phase's job): constructor keeps its slot but receives `baitonDir`; `listPlans(this.baitonDir)`, `readPlanJournal`, `listPhasePlans`; watcher `new vscode.RelativePattern(this.baitonDir, '{plans,specs}/**')`; open-on-click uses `resolveDocument(this.baitonDir, slug).documentPath`. Update the construction in commands.ts to pass `baitonDir`.
   - `src/activation/chatController.ts`: `listSpecs(this.deps.specsDir)` → `listPlans(this.deps.baitonDir)`; the document re-read at ~1895 uses `resolveDocument(this.deps.baitonDir, slug).documentPath`.
   - Any other import of `./specStore`, `./specLister`, `../engine/specBranchWriter` (grep) is repointed.
   Run `grep -rn "specStore'\|specLister'\|specBranchWriter'\|readSpecJournal\|specJournalPath\|todoJournalPathFor\|createSpecStore\|createSpecBranchWriter\|listSpecs\|listTodoPlans\|specFolderPathspec\|\bplanPath(" src test` until empty.

   Files: `src/activation/commands.ts`, `src/activation/engineFacade.ts`, `src/engine/recovery.ts`, `src/extension.ts`, `src/activation/specExplorer.ts`, `src/activation/chatController.ts`

12. Rename and extend the tests

   - `git mv test/specStore.test.ts test/planStore.test.ts`: suite `createPlanStore (real repo)`; keep the existing scenarios against a legacy fixture (`.baiton/specs/s/spec.md`, `# OVERVIEW`/`# TODOS`/`T##`) but expect commit subjects `plan(s): T02 planning` etc., and add a parallel block with a plan fixture at `.baiton/plans/s/plan.md` (preamble sections + `# PHASES`, `P01`/`P02`) asserting: writes commit only `.baiton/plans/s`, `persistArtifact`+state commit tracks `.baiton/plans/s/phases/P01/plan.md`, `readArtifact`/`latestExecuteCommit`/`inputRevMatches` read `phases/<id>/` journals; and a both-roots case (same slug in plans/ and specs/) where writes touch only `plans/` and `specs/` stays byte-identical.
   - `git mv test/specBranchWriter.test.ts test/planBranchWriter.test.ts`: `createPlanBranchWriter({ baitonDir, git })`; `planFolderPathspec(locationFor('/x/.baiton','x','plan'))` → `.baiton/plans/x` and legacy → `.baiton/specs/x`; real-repo commit test asserts only the resolved folder is committed for both kinds.
   - New `test/documentLocation.test.ts`: resolution rule cases (plan only, legacy only, both → plans, dir-only plan, dir-only legacy, nothing → plan under plans/), `artifactsDir` = `phases` vs `todos`, `pathspec` forms, `listDocumentSlugs` union/dedupe/sort/missing roots.
   - `test/journal.roundtrip.property.test.ts`: `describe('readPlanJournal')`; existing cases use a legacy fixture under `specs/<slug>/todos/<id>/`; add plan-kind cases under `plans/<slug>/phases/<id>/runs.jsonl` and `phaseJournalPathFor` creating `phases/<id>/`.
   - `test/schema.persistencePath.property.test.ts`: property ranges over `kind ∈ {'plan','legacy-spec'}`; expect `phases/<id>/…` for plan and `todos/<id>/…` for legacy; `plan-draft` → `plan.md` / `spec.md`; isolation and refusal properties for both kinds.
   - `test/mode.test.ts` (~lines 181–196): update to the new default kind (`plan.md`, `phases/P01/…`) and add one legacy assertion each.
   - `test/resultFlow.artifacts.test.ts`: `artifactPathFor` now touches the filesystem — use a temp dir as `workspaceRoot`; with no document it resolves to `.baiton/plans/demo/phases/P06/plan.md` etc. (and `plan-draft` → `.baiton/plans/demo/plan.md`); with a legacy `.baiton/specs/demo/spec.md` present → `.baiton/specs/demo/todos/T06/…`. Rename suite titles to per-phase wording. Also fix `test/engine.briefWatcher.test.ts:355` expectation (now `/repo/.baiton/plans/my-spec/phases/T01/execute-1.md` unless the test creates a legacy fixture — prefer computing via `artifactPathFor` on both sides or creating the fixture).
   - `test/submitPr.test.ts`: harness field `specsDir` → `baitonDir` (`path.join(root,'.baiton')`), keep the legacy fixture under `specs/` and update file reads to `path.join(baitonDir,'specs',SLUG,…)`; expected commit subject `plan(${SLUG}): pr`; update message expectations to plan wording; add one test running the readiness/pr path against a `plans/<slug>/plan.md` fixture asserting `pr.md` lands in `.baiton/plans/<slug>/` and `prContext` mentions `phases/`.
   - Fix every other test broken by the signature changes: `test/engineFacade.resume.test.ts`, `test/recovery.revert.test.ts`, `test/integration.plan-execute-review.test.ts`, `test/integration.sub-agent-chats.test.ts`, `test/runQueue.*.test.ts`, `test/askWatcher.routing.test.ts`, `test/treeModel.property.test.ts`, `test/chatController.*.test.ts`, `test/registry.controlTools.test.ts`, `test/config.gitignore.test.ts` (add an assertion that `GITIGNORE_CONTENTS` includes `plans/*/chat/` and `plans/*/runs.jsonl`). Where a test builds `.baiton/specs/<slug>/spec.md` fixtures and passes a `specsDir` into a renamed API, pass the `.baiton` dir instead; the legacy fixture still resolves correctly.

   Files: `test/planStore.test.ts`, `test/planBranchWriter.test.ts`, `test/documentLocation.test.ts`, `test/journal.roundtrip.property.test.ts`, `test/schema.persistencePath.property.test.ts`, `test/mode.test.ts`, `test/resultFlow.artifacts.test.ts`, `test/engine.briefWatcher.test.ts`, `test/submitPr.test.ts`, `test/engineFacade.resume.test.ts`, `test/recovery.revert.test.ts`, `test/integration.plan-execute-review.test.ts`, `test/integration.sub-agent-chats.test.ts`, `test/config.gitignore.test.ts`, `test/gitService.test.ts`

13. Verify

   Run `npm run compile`, `npm run lint`, `npm test` (git-spawning tests may need to run outside a sandbox). Then sweep the touched modules for stale vocabulary with word matches: `grep -rnwE 'spec|specs|todo|todos|Spec|Todo' src/storage src/activation/planStore.ts src/activation/planLister.ts src/engine/planBranchWriter.ts src/journal src/schema/index.ts src/engine/resultFlow.ts src/engine/submitPr.ts src/config/initialize.ts src/config/gitignore.ts` — remaining hits must be legacy-compat branches explicitly marked `Legacy`, or on-disk key names (`todoId` journal field). `git diff --check`.

   Files: (none)

## Risks

- `artifactPathFor`, the journal path helpers and the branch writer now hit the filesystem to resolve the kind; a slug with no document resolves to `plans/`. The plan-draft runner (`specDraft.ts`, drafting phase) still writes `.baiton/specs/<slug>/` until a later phase — the resolver's dir-exists fallback (rule 4) keeps its pre-spec.md journal and committed spec.md resolving as legacy, but do not change specDraft here.
- The branch writer must resolve the location inside the lock (lazily) — resolving at `apply` call time could pick `plans/` before an earlier queued callback created a legacy file, or vice versa.
- Renaming `SpecStore`→`PlanStore` type while leaving the `specStore`/`specWriter` deps property names is intentionally partial; the engine phase renames the properties. Do not rename `readSpec` or other interface methods if many test fakes implement them — keep the change compile-safe and minimal.
- Commit prefixes become mixed during the transition: store/branch writer/submitPr/recovery use `plan(<slug>):`, while runQueue's execute commit, todoWorktree's land commit and controlTools' approve commits still use `spec(` until the engine/orchestrator phases. Tests asserting subjects must be updated only for the commits this phase changes.
- `specsDir` stays alive in guard, sessionStore, readTools, buildToolServices, specDraft and some commands.ts UI paths; do not remove it there or the orchestrator/drafting/UI phases will conflict. Only replace it where it fed the APIs renamed in this phase.
- Changing `persistencePathForStage`'s default kind to 'plan' changes outputs for callers that omit the kind (mode.test.ts, persistencePath tests); runStore only uses the basename so it is unaffected — verify no other caller relies on the `todos/` prefix.
- Gitignore content change makes `refreshGitignore` rewrite `.baiton/.gitignore` on next activation in existing workspaces (including this repo); that is expected.
- Tests that spawn git may fail inside a sandbox with EPERM; rerun outside it before concluding a failure.

## Acceptance

- `src/storage/documentLocation.ts` exists with `resolveDocument`, `locationFor`, `phaseArtifactDir`, `listDocumentSlugs`, and its tests cover: plans-only, legacy-only, both roots (plans wins), dir-only fallbacks, and no document (→ plans/).
- `src/activation/specStore.ts`, `src/activation/specLister.ts`, `src/engine/specBranchWriter.ts`, `test/specStore.test.ts`, `test/specBranchWriter.test.ts` no longer exist; `planStore.ts`, `planLister.ts`, `planBranchWriter.ts` and their tests do.
- `grep -rn "createSpecStore\|createSpecBranchWriter\|readSpecJournal\|specJournalPathFor\|todoJournalPathFor\|specJournalPaths\|listSpecs\|listTodoPlans\|specFolderPathspec\|SpecBranchWriter\|\bSpecStore\b" src test` returns nothing.
- A state write on a plan document commits only `.baiton/plans/<slug>` with subject `plan(<slug>): P01 <state>`; on a legacy document it commits only `.baiton/specs/<slug>` with subject `plan(<slug>): T01 <state>`; with both roots present, `specs/` is never modified.
- Per-phase artifacts and journals land under `phases/<id>/` for plan documents and `todos/<id>/` for legacy specs; `persistencePathForStage('plan-draft', …, 'plan')` is `plan.md` and `'legacy-spec'` is `spec.md`.
- submitPr reads the resolved document, writes `pr.md` and `runs.jsonl` in the resolved folder, and commits `plan(<slug>): pr draft` / `plan(<slug>): pr`.
- `initialize` creates `.baiton/plans/` (not `specs/`); `GITIGNORE_CONTENTS` contains `plans/*/chat/` and `plans/*/runs.jsonl` and still the legacy `specs/*/…` lines.
- Crash recovery on activation reconciles journals for slugs under both `plans/` and `specs/`.
- `npm run compile` succeeds, `npm run lint` reports 0 errors, and `npm test` passes in full.
