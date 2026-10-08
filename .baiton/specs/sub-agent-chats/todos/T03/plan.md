# Plan T03

## Steps

1. Journal path helpers, directory-creating append, and the merged readSpecJournal reader

   In src/journal/journal.ts (node `fs` + `path` only, no vscode):
   1. Import `mkdirSync`, `readdirSync` from 'fs' and `dirname`, `join` from 'path'.
   2. Export `export const JOURNAL_FILE = 'runs.jsonl';`.
   3. Export `specJournalPathFor(specsDir: string, slug: string): string` → `join(specsDir, slug, JOURNAL_FILE)` (the spec-level journal: spec-draft, pr, and legacy todo entries).
   4. Export `todoJournalPathFor(specsDir: string, slug: string, todoId: string): string` → `join(specsDir, slug, 'todos', todoId, JOURNAL_FILE)`.
   5. Export `specJournalPaths(specsDir: string, slug: string): string[]` → the spec-level path first, then for every directory entry under `join(specsDir, slug, 'todos')` (readdirSync withFileTypes, directories only, names sorted with plain `.sort()`), its `todoJournalPathFor(...)` when `existsSync`. A missing/unreadable `todos/` dir yields just the spec-level path. The spec-level path is always included (parse tolerates a missing file).
   6. Refactor `parseJournal`: extract the per-line merge loop into a private `mergeRecords(raw: string, byRunId: Map<string, JournalEntry>, order: string[]): void` (identical semantics: start sets/overwrites the entry and records first appearance order; completion without a known start is ignored). `parseJournal(path)` becomes: missing file → []; else create map+order, `mergeRecords(readFileSync(path,'utf8'), ...)`, return ordered entries. Behaviour of parseJournal must be byte-for-byte unchanged.
   7. Export `readSpecJournal(specsDir: string, slug: string): JournalEntry[]` which runs `mergeRecords` over each file of `specJournalPaths(specsDir, slug)` in that order into ONE shared map/order, so (a) legacy spec-level entries for a todo precede that todo's per-todo entries (chronological per todo, which is all latestStart/countStageStarts/latestExecuteCommit/recordedPlanInputRev need), and (b) a completion in a later file still attaches to a start recorded in an earlier file (a run started before the upgrade and completed after). Wrap each file read in try/catch (skip unreadable). Doc-comment the ordering guarantee: spec-level file first, then per-todo files in sorted todo-id order; cross-todo interleaving is not preserved.
   8. In `appendRecord`, call `mkdirSync(dirname(path), { recursive: true })` before `appendFileSync`, because `todos/<id>/` does not exist before a todo's first plan start.
   9. src/journal/index.ts already re-exports `./journal`; update its header comment to mention the spec-level journal plus per-todo `todos/<id>/runs.jsonl` files and `readSpecJournal`.

   Files: `src/journal/journal.ts`, `src/journal/index.ts`

2. Route the run queue's todo-level journal writes to per-todo files

   src/engine/runQueue.ts is the only writer of todo-level journal records, so it must be touched (small, backward-compatible change):
   1. In `RunQueueDeps`, keep `journalPath: string` (still the default/fallback — existing tests pass a single flat file) and add:
      - `journalPathFor?: (todoId: string) => string;` — doc: 'Per-todo journal file for a todo's stage records (`.baiton/specs/<slug>/todos/<id>/runs.jsonl`); absent → every record goes to `journalPath`.'
      - `readJournal?: () => JournalEntry[];` — doc: 'The merged journal the queue reads (spec-level + per-todo files, see readSpecJournal); absent → `parseJournal(journalPath)`.'
      Import `type JournalEntry` from '../journal'.
   2. Add private helpers on SerialRunQueue: `private journalFor(todoId: string): string { return this.deps.journalPathFor?.(todoId) ?? this.deps.journalPath; }` and `private readJournal(): JournalEntry[] { return this.deps.readJournal?.() ?? parseJournal(this.deps.journalPath); }`.
   3. Replace the four uses: line ~489 `parseJournal(this.deps.journalPath)` → `this.readJournal()`; line ~718 `appendStart(this.deps.journalPath, …)` → `appendStart(this.journalFor(req.todoId), …)`; line ~803 `appendCompletion(this.deps.journalPath, …)` → `this.journalFor(req.todoId)`; line ~988 inside `applyOutcome`'s `journalDone` → `this.journalFor(req.todoId)` (`req` is a parameter of applyOutcome). Verify with grep that no other `this.deps.journalPath` remains outside the two helpers. Start and completion of one run must land in the SAME file (both keyed by req.todoId).

   Files: `src/engine/runQueue.ts`

3. Engine facade reads the merged journal

   In src/activation/engineFacade.ts `dispatchTrigger`: replace `const journalPath = path.join(specsDir, trigger.slug, 'runs.jsonl'); const entries = parseJournal(journalPath);` with `const entries = readSpecJournal(specsDir, trigger.slug);` (import `readSpecJournal` from '../journal'; drop `parseJournal` import and `path` import if now unused — check the rest of the file first). Attempt count (`countStageStarts`), `latestStart` for resume and `resumableSessionId` stay the same; they now see legacy spec-level entries followed by per-todo entries. Update the header/doc comments that say 'per-spec journal' to 'merged spec journal (spec-level + per-todo files)'.

   Files: `src/activation/engineFacade.ts`

4. Spec store: latestExecuteCommit and plan Input_Rev via readSpecJournal

   In src/activation/specStore.ts: remove the `journalPath` closure; `latestExecuteCommit` iterates `readSpecJournal(specsDir, slug)` instead of `parseJournal(journalPath(slug))`; change `recordedPlanInputRev(journalFile, todoId)` to `recordedPlanInputRev(entries: JournalEntry[], todoId)` and call it with `readSpecJournal(specsDir, slug)` in `inputRevMatches`. Import `readSpecJournal, type JournalEntry` from '../journal' and drop `parseJournal`. Update the module/doc comments (line ~24, ~226) to say the plan start is looked up in the merged spec journal. No change to writeState/persistArtifact (the per-todo journal file sits inside `.baiton/specs/<slug>/` so the writer's existing spec-folder-scoped commit picks it up with the next state commit).

   Files: `src/activation/specStore.ts`

5. Wire per-todo journals and the merged reader in commands.ts; update View, CodeLens and spec explorer readers

   src/activation/commands.ts:
   1. `queueForSlug` (~line 456-490): keep `journalPath` (spec-level, now computed with `specJournalPathFor(specsDir, slug)` or the existing Uri join) and add `journalPathFor: (todoId) => todoJournalPathFor(specsDir, slug, todoId)` and `readJournal: () => readSpecJournal(specsDir, slug)` to the `createRunQueue` deps. Use the same `specsDir` string already in scope for this function (the one passed to runView / derived from `workspace.baitonDir` + 'specs'; if not in scope at that point compute `path.join(workspace.baitonDir.fsPath, 'specs')`). Rewrite the comment above it: spec-scoped stages keep the spec-level `runs.jsonl`; todo stages journal to `todos/<id>/runs.jsonl`.
   2. `runView` (~1339): `latestStart(readSpecJournal(specsDir, slug), todoId)`.
   3. `SpecCodeLensProvider.provideCodeLenses` (~1740): `sessionSet(readSpecJournal(this.specsDir, slug))`; update its doc comment ('one merged read of the spec's journals'). Change `sessionSet`'s parameter type to `JournalEntry[]`.
   4. Imports: `latestStart, readSpecJournal, resumableSessionId, specJournalPathFor?, todoJournalPathFor, type JournalEntry` from '../journal'; drop `parseJournal` if unused.
   src/activation/specExplorer.ts (~244): `sessions: sessionSet(readSpecJournal(this.specsDir, spec.slug))`, swap the import and update the comment. (Not in the todo's file list but it is a journal reader that must see per-todo session ids, else the tree's View action disappears for new runs.)

   Files: `src/activation/commands.ts`, `src/activation/specExplorer.ts`

6. Crash recovery over the merged journal

   src/engine/recovery.ts:
   1. Change `RecoveryDeps` so the journal source is either the whole spec or a single file: keep `slug`, `git`, `process`, `specStore`, and replace `journalPath: string` with two optional fields `specsDir?: string` (doc: 'Absolute `.baiton/specs/` dir; recovery reads the merged spec journal — spec-level plus every `todos/<id>/runs.jsonl` — via readSpecJournal') and `journalPath?: string` (doc: 'A single journal file to reconcile instead; used when specsDir is absent'). Prefer expressing it as `RecoveryDeps = RecoveryBaseDeps & ({ specsDir: string; journalPath?: never } | { journalPath: string; specsDir?: never })` so one of them is required at compile time; if that makes call sites awkward, use two optionals and treat neither as an empty journal.
   2. `recoverJournal`: `const all = deps.specsDir !== undefined ? readSpecJournal(deps.specsDir, deps.slug) : parseJournal(deps.journalPath)`; then `.filter(isResultLess)` as today. Update the module header comment (line ~11) to mention readSpecJournal.
   src/extension.ts `runCrashRecovery` (~480-520): drop the `existsSync(journalPath)` skip (or replace it with `specJournalPaths(specsDir, slug).some(fs.existsSync)`), and call `recoverJournal({ slug, specsDir, git, process: hostProcessControl, specStore: … })`. Update the doc comment ('each spec owns a spec-level journal plus per-todo journals'). Leave test/integration.plan-execute-review.test.ts using `journalPath` unchanged (still supported).

   Files: `src/engine/recovery.ts`, `src/extension.ts`

7. Submit PR counts attempts through the merged reader, still writes spec-level

   src/engine/submitPr.ts: PR start/completion records stay in the spec-level journal (`path.join(deps.specsDir, slug, 'runs.jsonl')`, optionally via `specJournalPathFor`) — the PR is spec-scoped. Change `countPrStarts(journalPath)` to `countPrStarts(specsDir, slug)` iterating `readSpecJournal(specsDir, slug)` and counting `entry.stage === 'pr'`; call it as `countPrStarts(deps.specsDir, slug) + 1`. Import `readSpecJournal` and drop `parseJournal` if unused. Do not touch specDraft.ts (spec-draft stays spec-level) or runPipeline.ts (spec-less runs keep their own run-dir journal).

   Files: `src/engine/submitPr.ts`

8. Tests: journal reader, facade over per-todo files, recovery over merged journal

   test/journal.roundtrip.property.test.ts — add a `describe('readSpecJournal')` block (keep the existing property untouched):
     (a) property: for generated runs each assigned to either the spec-level file or one of a few todo ids (write via `todoJournalPathFor`/`specJournalPathFor` with appendStart/appendCompletion into a fresh temp specsDir/slug), `readSpecJournal` returns exactly the union of entries (compare as a set keyed by runId, equal to what parseJournal gives per file), and for each todo id the relative order of that todo's entries is preserved with spec-level entries before per-todo ones;
     (b) a start in the spec-level file whose completion is appended to `todos/T01/runs.jsonl` merges into one entry with the completion's result;
     (c) missing `todos/` dir and missing spec-level file both yield [] / only the other file's entries; a `todos/<id>/` folder with only plan.md (no runs.jsonl) is ignored;
     (d) appendStart into a not-yet-existing `todos/T09/` directory creates it.
   test/engineFacade.resume.test.ts — add cases where the queue deps set `journalPathFor: (id) => todoJournalPathFor(specsDir, 'demo', id)` and `readJournal: () => readSpecJournal(specsDir, 'demo')`: (1) two execute dispatches for t1 resume `session-0` on the second launch and the records are in `specs/demo/todos/t1/runs.jsonl`, not the spec-level file (assert spec-level file absent or lacks t1); (2) legacy fixture: a prior execute start with sessionId for t6 written to the spec-level `runs.jsonl`, then one dispatch through the per-todo-wired queue resumes that id (attempt 2) — proves legacy specs keep resuming. Existing cases stay as they are (they use only `journalPath`, which the merged reader still reads).
   test/recovery.revert.test.ts — keep existing cases (they pass `journalPath`); add a case with `specsDir` where one result-less entry is in the spec-level file (T01, fromState planned) and another in `todos/T02/runs.jsonl` (fromState executed) and a completed entry in `todos/T03/runs.jsonl`; assert two outcomes/two writeState calls (T01 → planned, T02 → executed, both with HOST_EXITED_NOTE) and none for T03.
   Also grep test/ for other `recoverJournal(`, `countPrStarts`, `latestExecuteCommit` or specStore journal assertions (e.g. test/specStore.test.ts, test/submitPr.test.ts) and add/adjust a per-todo case where cheap: specStore.latestExecuteCommit returns a commit recorded only in `todos/<id>/runs.jsonl`.

   Files: `test/journal.roundtrip.property.test.ts`, `test/engineFacade.resume.test.ts`, `test/recovery.revert.test.ts`, `test/specStore.test.ts`

9. Verify

   Run `npm run compile`, `npm run lint`, `npm test`. Grep `src/` for `'runs.jsonl'` path joins under specs: remaining ones should be only the spec-level writers (specDraft.ts, submitPr.ts append path, commands.ts spec-level journalPath) and the journal helpers; every READ of a spec journal (engineFacade, specStore, commands runView/CodeLens, specExplorer, recovery/extension, submitPr count) goes through readSpecJournal. Do not change src/config/gitignore.ts: the spec-level `specs/*/runs.jsonl` stays ignored, per-todo journals are deliberately committed with the spec folder.

   Files: (none)

## Risks

- src/engine/runQueue.ts, src/activation/specExplorer.ts, src/extension.ts and test/specStore.test.ts are not in the todo's declared file list but must change: runQueue is the only writer of todo-level records, and specExplorer/extension are journal readers. The runQueue change is additive (optional `journalPathFor`/`readJournal`) so all existing queue tests that pass a flat `journalPath` keep working and later per-todo-queue work can simply pass a per-todo `journalPath`.
- Per-todo `todos/<id>/runs.jsonl` is NOT covered by `.baiton/.gitignore` (only `specs/*/runs.jsonl` is), so these files become tracked content of the spec folder. Appends happen outside the spec-branch writer, so the file is dirty until the next spec-folder commit sweeps it; `isCleanExceptSpecFolder` and the land dirty-tree check both ignore the spec folder, so no guard should trip — but verify no test asserts a fully clean tree right after a stage completion.
- readSpecJournal loses cross-todo chronological order (spec-level first, then per-todo files by sorted id). All consumers are per-todo (latestStart, attempt counts, Input_Rev, latestExecuteCommit, sessions) or order-independent (recovery reconciles entries independently, PR count), so this is safe; document it so no future caller relies on global order.
- A run started under the old code (start in spec-level file) and completed after the upgrade will have its completion written to the per-todo file; the shared-map merge in readSpecJournal attaches it, but plain parseJournal on either file alone would not — every reader must use readSpecJournal.
- `appendRecord` now creates parent directories; specDraft already mkdirs its folder, so this is benign, but a typo'd path now silently creates directories instead of throwing ENOENT.
- Making RecoveryDeps a union type may produce awkward TS narrowing in recoverJournal; falling back to two optional fields is acceptable if an absent pair is treated as an empty journal.

## Acceptance

- `readSpecJournal`, `specJournalPathFor`, `todoJournalPathFor`, `specJournalPaths` and `JOURNAL_FILE` are exported from src/journal (via index.ts); `parseJournal` behaviour is unchanged (existing roundtrip property still passes).
- With commands.ts wiring, a todo's plan/execute/review start and completion records are appended to `.baiton/specs/<slug>/todos/<todoId>/runs.jsonl` (directory created on demand), while spec-draft and PR records still go to `.baiton/specs/<slug>/runs.jsonl`.
- engineFacade.dispatchTrigger, specStore.latestExecuteCommit/inputRevMatches, runView, the CodeLens provider, specExplorer, submitPr's attempt count and crash recovery (extension.ts → recoverJournal with specsDir) all read via readSpecJournal; no remaining `parseJournal(path.join(specsDir, slug, 'runs.jsonl'))` reader in src/.
- A legacy spec whose todo entries exist only in the spec-level journal still derives the correct attempt number and resumes the recorded executor session (engineFacade.resume test).
- Recovery reconciles result-less entries from both the spec-level and per-todo files and ignores completed ones (recovery.revert test); recoverJournal still accepts a single `journalPath` (integration test unchanged).
- No `vscode` import added under src/journal/ or src/engine/.
- `npm run compile`, `npm run lint` and `npm test` all pass.
