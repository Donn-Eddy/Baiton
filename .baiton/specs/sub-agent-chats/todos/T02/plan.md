# Plan T02

## Steps

1. Create src/engine/specBranchWriter.ts: the per-slug serialized writer

   New host-free module (no `vscode`; only `path` + the git types). Header doc comment in the style of the neighbours explaining: spec.md state, persisted stage artifacts and per-todo journals are written only in the main checkout on the spec branch, through one writer per slug; `apply` runs its callback under an async FIFO lock keyed by slug so concurrent writers for two todos of one spec are applied one after another on freshly re-read content; commits are path-scoped via `commitPaths` so they never sweep unrelated changes.

   Exports:

   ```ts
   import * as path from 'path';
   import type { GitWorktreeService } from '../git';

   export interface SpecBranchWriterDeps {
     /** Absolute `.baiton/specs/` directory of the MAIN checkout. */
     specsDir: string;
     /** Git bound to the main checkout; only `commitPaths` is used. */
     git: Pick<GitWorktreeService, 'commitPaths'>;
   }

   /** What a callback running under the slug's lock may do. */
   export interface SpecWriteScope {
     readonly slug: string;
     /** Absolute spec folder `<specsDir>/<slug>`. */
     readonly dir: string;
     /** Commit ONLY the spec folder: `commitPaths([specFolderPathspec(slug)], message, trailers)`. Rejects like commitPaths (nothing to commit, git failure). */
     commit(message: string, trailers?: Record<string, string>): Promise<string>;
   }

   export interface SpecBranchWriter {
     /** Run `fn` under the slug's lock; resolves/rejects with `fn`'s own result. A rejection releases the lock and never poisons later calls. Different slugs never wait on each other. */
     apply<T>(slug: string, fn: (scope: SpecWriteScope) => Promise<T> | T): Promise<T>;
   }

   /** `.baiton/specs/<slug>` — the repo-relative pathspec of a spec folder (forward slashes). */
   export function specFolderPathspec(slug: string): string { return `.baiton/specs/${slug}`; }

   export function createSpecBranchWriter(deps: SpecBranchWriterDeps): SpecBranchWriter
   ```

   Implementation of the lock: `const tails = new Map<string, Promise<void>>()`. In `apply`: `const prev = tails.get(slug) ?? Promise.resolve();` `const run = prev.then(() => fn(scope));` `const tail = run.then(() => undefined, () => undefined);` `tails.set(slug, tail);` `void tail.then(() => { if (tails.get(slug) === tail) { tails.delete(slug); } });` `return run;`. Build `scope` per call: `dir = path.join(deps.specsDir, slug)`, `commit = (m, t) => deps.git.commitPaths([specFolderPathspec(slug)], m, t)`. The pathspec is repo-relative, which is correct because the git service is constructed on the repo root (`createGitService(repoRoot)`), and specsDir is always `<repoRoot>/.baiton/specs`. Do not throw literals anywhere (lint `no-throw-literal`); the module itself never throws, it only propagates `fn`'s rejection.

   Files: `src/engine/specBranchWriter.ts`

2. Export the writer from the engine barrel

   In src/engine/index.ts add `export * from './specBranchWriter';` (place it after `./runQueue` or next to `./todoWorktree`) and extend the barrel's doc comment with a clause like `the per-slug serialized spec-branch writer (state, artifact and journal writes to `.baiton/specs/<slug>/` in the main checkout, committed path-scoped)`. Check no name collision with existing exports (`SpecWriteScope`, `SpecBranchWriter`, `SpecBranchWriterDeps`, `specFolderPathspec`, `createSpecBranchWriter` are all new).

   Files: `src/engine/index.ts`

3. Add an optional artifact-persistence method to the SpecStore seam

   In src/engine/runQueue.ts, extend `interface SpecStore` with an OPTIONAL method (optional so the many test fakes that build SpecStore literals keep compiling):

   ```ts
   /**
    * Persist a validated stage artifact (absolute path under the spec folder) through the
    * spec-branch writer, so it is serialized with state writes for the same spec. It is not
    * committed on its own: the next state write (or the Execute commit) records it. Absent
    * → the queue writes the file directly, as before.
    */
   persistArtifact?(slug: string, artifactPath: string, contents: string): Promise<void>;
   ```

   Update the `writeState` doc to say the write is applied through the per-slug spec-branch writer on freshly re-read content and committed path-scoped (`spec(<slug>): <id> <what>`, only `.baiton/specs/<slug>`).

   Files: `src/engine/runQueue.ts`

4. Route the queue's artifact persistence through the store

   In `SerialRunQueue.launchAndComplete` (src/engine/runQueue.ts), when `this.deps.specStore.persistArtifact` is defined, pass a capturing writer to `awaitStageResult` instead of letting it write to disk:

   ```ts
   let captured: { path: string; contents: string } | undefined;
   const persistArtifact = this.deps.specStore.persistArtifact?.bind(this.deps.specStore);
   ...
   outcome = await awaitStageResult(
     { ...same input... },
     {
       reportInvalid: ...unchanged...,
       ...(persistArtifact !== undefined
         ? { writeArtifact: (p: string, c: string) => { captured = { path: p, contents: c }; } }
         : {}),
     },
   );
   ```

   (`writeArtifact` is the existing `AwaitStageResultDeps.writeArtifact` seam in resultFlow.ts — do not change resultFlow.ts.) Immediately after the `try/finally` around `awaitStageResult` (before the `if (cancelled)` override and before `discoverSessionId`/`applyOutcome`), persist it:

   ```ts
   if (captured !== undefined && persistArtifact !== undefined) {
     try {
       await persistArtifact(req.slug, captured.path, captured.contents);
     } catch (e) {
       // treat like the old sync writer failing: surface and halt
       journal nothing new here; fall through to a spec-write-failed refusal
     }
   }
   ```

   Concretely on failure: `return this.refuse({ kind: 'spec-write-failed', message: `could not persist the ${stage} artifact for "${req.todoId}"` })` after appending a completion record via `appendCompletion(this.deps.journalPath, { runId, result: 'completed' })` so the journal start is closed. The artifact is persisted BEFORE the Execute commit and the terminal `writeState`, so ordering is identical to today: the Execute commit (`git.commit`, still `add -A` in the main checkout for now) and the state commit (now path-scoped to the spec folder) both pick it up. Leave every other queue behaviour (guards, drift check, reset, journal) unchanged; no worktree or per-todo changes in this todo.

   Files: `src/engine/runQueue.ts`

5. Route SpecStore.writeState and persistArtifact through the writer with path-scoped commits

   In src/activation/specStore.ts:

   - Change the signature to `createSpecStore(specsDir: string, git: GitWorktreeService, writer: SpecBranchWriter = createSpecBranchWriter({ specsDir, git })): SpecStore` (import `GitWorktreeService` from '../git' and `createSpecBranchWriter, type SpecBranchWriter` from '../engine'). `commands.ts` already passes `createGitService(repoRoot)`, which returns `GitWorktreeService`, so it compiles unchanged; the default writer means one writer per store, and the store is a singleton in commands.ts. Update the header comment: writeState applies the state-box edit under the per-slug spec-branch writer and commits only `.baiton/specs/<slug>` via `commitPaths`.

   - Rewrite `writeState` so the whole read→edit→write→commit happens inside the lock:

   ```ts
   async writeState(slug, todoId, state, note): Promise<boolean> {
     return writer.apply(slug, async (scope) => {
       let current: string;
       try { current = await fsp.readFile(specPath(slug), 'utf8'); } catch { return false; }
       const written = writeTodoState(current, todoId, state);
       if (isErr(written) || written.value === current) { return false; }
       try {
         await fsp.writeFile(specPath(slug), written.value, 'utf8');
         await scope.commit(`spec(${slug}): ${todoId} ${what(state, note)}`);
         return true;
       } catch { return false; }
     });
   }
   ```

   (Preserve the existing comments about the unchanged-file case.) The fresh re-read inside the lock is what makes two concurrent writes for different todos compose: the second sees the first's edit.

   - Add `persistArtifact(slug, artifactPath, contents)`: `await writer.apply(slug, async () => { await fsp.mkdir(path.dirname(artifactPath), { recursive: true }); await fsp.writeFile(artifactPath, contents, 'utf8'); });` — no commit (the following state write commits the spec folder, which contains it). Let errors reject (the queue catches them).

   - Leave every read method untouched.

   Files: `src/activation/specStore.ts`

6. Unit-test the writer: test/specBranchWriter.test.ts

   Mocha, `import * as assert from 'assert'`, fakes only (no git needed except one case). Cases:
   1. Same-slug serialization: start `apply('s', fnA)` where fnA awaits a manually-resolved deferred and pushes 'A-start'/'A-end' into a log; synchronously start `apply('s', fnB)` pushing 'B-start'/'B-end'. Assert B has not started while A is pending (flush microtasks with `await new Promise(r => setImmediate(r))`), then resolve A and assert log `['A-start','A-end','B-start','B-end']`.
   2. FIFO for 3+ callers: fire 5 applies on one slug with randomised `setTimeout` delays inside each fn; assert the recorded execution order equals the call order and no two overlap (track an `active` counter, assert it never exceeds 1).
   3. Different slugs don't block each other: `apply('a', blocked-forever-until-released)` and `apply('b', quick)` → 'b' resolves while 'a' is still pending.
   4. Rejection isolation: first fn rejects with an Error; the returned promise rejects with that error; a subsequent apply on the same slug still runs and resolves.
   5. Return value passthrough: `await apply('s', () => 42) === 42` (sync fn allowed).
   6. `scope.commit` delegates to `git.commitPaths` with `['.baiton/specs/s']`, the message and trailers (fake git recording calls; returns 'sha1'), and `scope.dir === path.join(specsDir, 's')`; `specFolderPathspec('x') === '.baiton/specs/x'`.
   7. Real-repo path scoping: temp repo (same helpers as test/todoWorktree.test.ts: `git init`, user config, commit README + `.baiton/.gitignore` from GITIGNORE_CONTENTS), write `.baiton/specs/s/spec.md` and an unrelated dirty `src/other.ts`, `apply('s', scope => scope.commit('spec(s): T01 planning'))`; assert `git show --name-only --format= HEAD` lists only the spec file and `git status --porcelain` still shows `src/other.ts` modified/untracked. Clean temp dirs in `afterEach`.

   Files: `test/specBranchWriter.test.ts`

7. Test the store against a real temp repo: test/specStore.test.ts (new)

   Temp git repo helper as above (`makeRepo()` with `baiton/s` checked out). Seed `.baiton/specs/s/spec.md` with a spec like test/writer.test.ts's SPEC but with `- [pending] T01 First todo` and `- [pending] T02 Second todo` (no `after` so both are independent), commit it. Build `const git = createGitService(repo); const store = createSpecStore(path.join(repo, '.baiton', 'specs'), git);` (import from '../src/activation/specStore' — check it has no `vscode` import; it doesn't today).
   Cases:
   1. Interleaved concurrent writes don't clobber: `await Promise.all([store.writeState('s','T01','planning'), store.writeState('s','T02','planning')])` → both resolve true; re-read spec.md: `store.currentState('s','T01') === 'planning'` AND `store.currentState('s','T02') === 'planning'`; `git log --format=%s` shows both `spec(s): T01 planning` and `spec(s): T02 planning` as two separate commits; `git status --porcelain` for the spec folder is clean.
   2. A larger interleaving: fire, without awaiting between them, T01 planning, T02 planning, T01 planned, T02 planned (order preserved by the per-slug FIFO), await all, assert final states are `planned`/`planned` and 4 new commits exist in call order.
   3. Path-scoped commits: create an unrelated untracked file `src/unrelated.ts` and a modified README before a writeState; assert the new commit's `--name-only` list is exactly `.baiton/specs/s/spec.md`, and README/src/unrelated.ts remain uncommitted.
   4. Note in commit message: `writeState('s','T01','failed','cancelled')` → subject `spec(s): T01 failed (cancelled)`.
   5. Unchanged / unknown target returns false and makes no commit: writing T01's current state again, and writing `T99`, both resolve false with HEAD unchanged.
   6. persistArtifact serializes with state and is swept by the next state commit: `await Promise.all([store.persistArtifact!('s', path.join(specsDir,'s','todos','T01','plan.md'), '# Plan T01\n'), store.writeState('s','T02','planning')])` then `await store.writeState('s','T01','planning')`; assert `todos/T01/plan.md` exists with that content and `git ls-files` includes it after the final commit (i.e. it was committed by a spec-folder commit), and `store.readArtifact('s','T01','plan')` returns it.
   Clean temp repos in `afterEach`.

   Files: `test/specStore.test.ts`

8. Queue regression check for artifact routing

   Add one case to test/specStore.test.ts or (preferably, if a rig is easy to reuse) a small `describe` in test/specBranchWriter.test.ts is NOT needed; instead confirm existing queue tests still pass: they build SpecStore fakes without `persistArtifact`, so the queue keeps the direct-fs path for them. If an existing rig (e.g. test/runQueue.briefContext.test.ts) makes it cheap, optionally add a case where the fake store implements `persistArtifact` recording calls and assert a completed plan dispatch called it once with the plan artifact path (`artifactPathFor(root,'s','plan','T01')`) BEFORE the terminal writeState('planned') call (record both into one ordered log). Only do this if it fits in an existing test file listed or the new ones; otherwise skip.

   Files: `test/specStore.test.ts`

9. Compile, lint, test

   Run `npm run compile`, `npm run lint` (no new warnings; the pre-existing webviewProtocol.ts warning is known) and `npm test`. Grep that src/engine/specBranchWriter.ts has no `vscode` import. Do NOT touch src/activation/commands.ts unless compile fails (it should not: `createSpecStore(specsDir, git)` still type-checks because `git` is a GitWorktreeService and the writer defaults).

   Files: (none)

## Risks

- The writer's commit pathspec `.baiton/specs/<slug>` is repo-relative; it is only correct because the injected git service runs in the repo root (true for createGitService(repoRoot) in commands.ts). A git service bound elsewhere would commit nothing / fail.
- Other spec.md writers (src/orchestrator/specWriteTools.ts, controlTools.ts approve/re-approve, extension.ts recovery, submitPr.ts) still use `git.commit` (add -A) outside the lock; they are out of this todo's file list and can still race or sweep. Later todos should route them through the same writer.
- Execute's commit in the queue still uses `git.commit` (add -A) in the main checkout, which sweeps the spec folder too; this is intentional until the worktree todo moves execution into per-todo worktrees.
- `commitPaths` rejects when there is nothing to commit; writeState only commits when spec.md actually changed, so that path returns false exactly as before, but a caller using `scope.commit` directly must expect the rejection.
- Deferring the artifact disk write from inside awaitStageResult to right after it returns means a failure to persist is now reported as `spec-write-failed` after the run completed; previously a sync write throw would have escaped the watcher callback. Keep the capture only when `persistArtifact` exists so existing fakes/tests are unaffected.
- The lock map must delete its tail when idle, or it leaks one resolved promise per slug (harmless but untidy); and a rejected fn must not break the chain (tail swallows the rejection, returned promise does not).
- Real-repo tests depend on `git` being on PATH and configured per-repo user.name/email, like test/todoWorktree.test.ts.

## Acceptance

- src/engine/specBranchWriter.ts exists, exports createSpecBranchWriter, SpecBranchWriter, SpecBranchWriterDeps, SpecWriteScope and specFolderPathspec, has no `vscode` import, and is re-exported from src/engine/index.ts.
- `apply(slug, fn)` runs callbacks for the same slug strictly one at a time in call order, never blocks a different slug, propagates fn's result/rejection, and a rejection does not block later calls (covered by test/specBranchWriter.test.ts).
- `scope.commit` calls `git.commitPaths(['.baiton/specs/<slug>'], message, trailers)`; in a real temp repo the resulting commit contains only spec-folder paths and unrelated dirty files remain uncommitted.
- `createSpecStore(specsDir, git, writer?)` routes writeState through the writer: two concurrent `writeState` calls for T01 and T02 of one spec both land (both state boxes updated in spec.md) as two separate `spec(<slug>): <id> <state>` commits, with no clobbering (test/specStore.test.ts).
- SpecStore has an optional `persistArtifact`; the real store implements it under the same per-slug lock, and the run queue uses it (when present) to persist the validated artifact before the Execute commit and the terminal state write, falling back to the direct fs write when absent.
- src/activation/commands.ts needs no change and still compiles.
- `npm run compile`, `npm run lint` (no new warnings) and `npm test` all pass.
