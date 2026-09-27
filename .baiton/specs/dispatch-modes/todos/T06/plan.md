# Plan T06

## Steps

1. Add `/worktrees/` to the .baiton/.gitignore contents

   In `src/config/gitignore.ts`, insert the line `'/worktrees/',` into the `GITIGNORE_CONTENTS` array immediately after `'/runs/',` (so the final text is: header comment, `/.lock`, `/chat.jsonl`, `/chat/`, `/runs/`, `/worktrees/`, `specs/*/chat.jsonl`, `specs/*/chat/`, `specs/*/runs.jsonl`, trailing empty string). Add a matching bullet to the module doc comment's exclusion list: `- /worktrees/               — all per-run git worktrees (`.baiton/worktrees/<run-id>/`).` and mention `worktrees/` alongside `runs/` in the sentence explaining why patterns are anchored with a leading `/`. Change nothing else in the file: `refreshGitignore` already rewrites any file whose text differs, so an older workspace picks the new line up on activation. This line is load-bearing, not cosmetic: run worktrees live inside the repository at `.baiton/worktrees/<run-id>/`, so without it every created worktree would make `git status` dirty and the pipeline's own `dirty-tree` merge check would always refuse.

   Files: `src/config/gitignore.ts`

2. Create src/engine/runWorktree.ts: module doc comment, imports and path helpers

   New host-free module (no `vscode` import; sync `fs` like its engine neighbours `launcher.ts`/`runStore.ts`). Module doc comment: it composes the worktree/merge primitives of `GitWorktreeService` into the three lifecycle operations a spec-less run needs — create a linked worktree at `.baiton/worktrees/<run-id>/` on `baiton/<mode>/<run-id>` from the head of the branch checked out when the run started; merge that branch back into the base branch, refusing with a named reason instead of faulting; and remove the worktree (and optionally the branch) on demand. State that every expected failure is a returned `Result`, never a throw, mirroring `runStore.ts`.

   Imports: `import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync } from 'fs';`, `import * as path from 'path';`, `import { Result, err, ok } from '../model/result';`, `import type { RunMode } from '../model/mode';`, `import { createGitService } from '../git/gitService';`, `import type { GitError, GitWorktree, GitWorktreeService } from '../git/types';`, `import { isRunId, runBranchFor, runWorktreeDirFor } from './runStore';`.

   Export the path helpers that pair with `runStore`'s absolute `runWorktreeDirFor`:
   - `export const RUN_WORKTREES_DIR = 'worktrees';` (the segment under `.baiton/`).
   - `export function runWorktreesRootDir(workspaceRoot: string): string` → `path.join(workspaceRoot, '.baiton', RUN_WORKTREES_DIR)`.
   - `export function runWorktreeRelativeDir(runId: string): string` → `` `.baiton/${RUN_WORKTREES_DIR}/${runId}` `` — always forward slashes, because this is the value stored in `RunManifest.worktreeDir` (documented there as repository-relative) while `runWorktreeDirFor` yields the absolute path used with git.

   Also export a module-private-free helper `export function createRunGitService(workspaceRoot: string, runId: string, factory: (dir: string) => GitWorktreeService = createGitService): GitWorktreeService` returning a service bound to the run's worktree directory, so the pipeline's head/branch/commit/diff calls for a run go through the worktree rather than the main checkout.

   Files: `src/engine/runWorktree.ts`

3. Declare the deps seam and the result/refusal types

   In `src/engine/runWorktree.ts`:

   ```ts
   export interface RunWorktreeDeps {
     /** Absolute workspace root; `.baiton/worktrees/` resolves under it. */
     workspaceRoot: string;
     /** Service bound to the MAIN checkout (`createGitService(workspaceRoot)`). */
     git: GitWorktreeService;
     /** Factory for a service bound to another directory; injected for tests. */
     createService?: (dir: string) => GitWorktreeService;
   }

   export interface RunWorktreeInfo {
     runId: string;
     mode: RunMode;
     /** `baiton/<mode>/<run-id>`. */
     branch: string;
     /** Absolute worktree directory. */
     worktreeDir: string;
     /** Repository-relative worktree directory, for `RunManifest.worktreeDir`. */
     relativeWorktreeDir: string;
     /** The branch that was checked out when the worktree was created. */
     baseBranch: string;
     /** That branch's head commit at that moment. */
     baseHead: string;
   }

   export type RunWorktreeError =
     | { kind: 'invalid-id'; runId: string; message: string }
     | { kind: 'exists'; runId: string; path: string; message: string }
     | { kind: 'detached-head'; runId: string; message: string }
     | { kind: 'no-base-head'; runId: string; baseBranch: string; message: string }
     | { kind: 'git'; runId: string; message: string; error?: GitError }
     | { kind: 'io'; runId: string; path: string; message: string };

   export interface RunMergeOutcome {
     /** The merge commit's sha on the base branch. */
     commit: string;
     baseBranch: string;
     branch: string;
     /** Non-fatal cleanup problems after a successful merge (worktree/branch removal). */
     cleanup: readonly string[];
   }

   export type RunMergeRefusal =
     | { reason: 'wrong-branch'; expected: string; actual: string; message: string }
     | { reason: 'base-moved'; baseBranch: string; expected: string; actual: string | undefined; message: string }
     | { reason: 'dirty-tree'; changes: readonly string[]; message: string }
     | { reason: 'missing-branch'; branch: string; message: string }
     | { reason: 'conflict'; branch: string; error: GitError; message: string }
     | { reason: 'git'; message: string };

   export interface RunWorktreeRemoval {
     /** True when a registered worktree was deregistered by git. */
     worktreeRemoved: boolean;
     /** True when a leftover directory was deleted directly. */
     dirRemoved: boolean;
     /** True when the run branch was deleted. */
     branchDeleted: boolean;
     /** Non-fatal problems, e.g. a directory that could not be removed. */
     warnings: readonly string[];
   }
   ```

   Each message must be a complete user-facing sentence naming the paths/branches involved (the Runs view shows them verbatim), e.g. `` `Cannot merge: the working tree has 3 uncommitted change(s). Commit or stash them, then merge again.` ``. Add a module-private `function describe(e: unknown): string` returning `e instanceof Error ? e.message : String(e)` and `function asGitError(e: unknown): GitError | undefined` narrowing a thrown value that has string `command`/`stderr` fields (the shape `runOrThrow` throws), used to attach `error` to a `kind: 'git'` failure.

   Files: `src/engine/runWorktree.ts`

4. Implement createRunWorktree

   ```ts
   export async function createRunWorktree(
     deps: RunWorktreeDeps,
     input: { runId: string; mode: RunMode },
   ): Promise<Result<RunWorktreeInfo, RunWorktreeError>>
   ```
   Steps, in this order (each failure returns immediately, and nothing is created before every check has passed):
   1. `if (!isRunId(input.runId))` → `err({ kind: 'invalid-id', ... })` with the same wording shape as `RunStore.create` (letters, digits and hyphens only; a dot would collide with a launch directory name).
   2. `const worktreeDir = runWorktreeDirFor(deps.workspaceRoot, input.runId);` and `const branch = runBranchFor(input.mode, input.runId);`.
   3. If `existsSync(worktreeDir)` and the directory is not empty (`readdirSync(worktreeDir).length > 0`) → `err({ kind: 'exists', path: worktreeDir, ... })`. An existing empty directory is tolerated (git accepts it).
   4. `const baseBranch = await deps.git.currentBranch();` wrapped in try/catch → `kind: 'git'`. If `baseBranch === 'HEAD'` or it is empty → `err({ kind: 'detached-head', ... })` explaining a run needs a named base branch to merge back into.
   5. `const baseHead = await deps.git.branchHead(baseBranch);` (non-throwing). `undefined` → `err({ kind: 'no-base-head', baseBranch, ... })` (an unborn branch, i.e. a repository with no commits).
   6. `mkdirSync(path.dirname(worktreeDir), { recursive: true })` inside try/catch → `kind: 'io'`, so `.baiton/worktrees/` exists before git is asked for the leaf.
   7. `await deps.git.addWorktree(worktreeDir, branch, baseHead)` inside try/catch → `kind: 'git'` with `error: asGitError(e)` and a message naming the branch and directory. `addWorktree` uses `-b`, so a colliding run branch fails loudly here rather than resetting an existing branch — say so in a comment.
   8. `return ok({ runId, mode, branch, worktreeDir, relativeWorktreeDir: runWorktreeRelativeDir(runId), baseBranch, baseHead });`

   Also export `export async function findRunWorktree(deps: RunWorktreeDeps, runId: string): Promise<GitWorktree | undefined>`: `await deps.git.listWorktrees()` and return the entry whose `dir` matches the run's worktree dir after resolving both with a `safeRealpath(p)` module-private helper (`try { return realpathSync(p); } catch { return path.resolve(p); }`). Document that git prints realpaths, so raw string comparison is wrong (as `GitWorktree.dir` already warns).

   Files: `src/engine/runWorktree.ts`

5. Implement mergeRunWorktree with the three named refusals

   ```ts
   export async function mergeRunWorktree(
     deps: RunWorktreeDeps,
     input: {
       runId: string;
       mode: RunMode;
       baseBranch: string;
       baseHead: string;
       /** Defaults to `runBranchFor(mode, runId)`. */
       branch?: string;
       /** Defaults to `runMergeMessage(...)`. */
       message?: string;
       /** The run's one-line statement, folded into the default message. */
       statement?: string;
     },
   ): Promise<Result<RunMergeOutcome, RunMergeRefusal>>
   ```
   The merge runs in the MAIN checkout (`deps.git`), never in the worktree. Check order, pinned and documented in a comment because tests assert it: **wrong-branch → base-moved → dirty-tree → missing-branch → merge**. Rationale to write down: the other checks only mean anything while the base branch is the one checked out; a base that has moved makes the run stale regardless of local edits; a dirty tree would be swept into the merge commit by `commit -a`-style behaviour and must be reported before git is touched.
   1. `const actual = await deps.git.currentBranch()` (try/catch → `reason: 'git'`); `if (actual !== input.baseBranch)` → refuse `wrong-branch` with `expected: input.baseBranch, actual`.
   2. `const head = await deps.git.branchHead(input.baseBranch)`; `if (head !== input.baseHead)` → refuse `base-moved` with `expected: input.baseHead, actual: head`. `head === undefined` (the base branch was deleted or renamed) takes this same branch; the message distinguishes the two cases (`no longer exists` vs `has moved to <sha>`).
   3. `const status = await deps.git.status(); if (!status.clean)` → refuse `dirty-tree` with `changes: status.changes.map((c) => c.path)`. Use `status()` rather than `isClean()` so the refusal can name the paths; note in a comment that `isClean()` is the same predicate.
   4. `const branch = input.branch ?? runBranchFor(input.mode, input.runId); if ((await deps.git.branchHead(branch)) === undefined)` → refuse `missing-branch`.
   5. `const merged = await deps.git.merge(branch, input.message ?? runMergeMessage({ runId, branch, statement }));` On `!merged.ok` → refuse `conflict` carrying `merged.error` (the service already ran `merge --abort`, so the tree is left as it was — say so in the message: the run's branch and worktree are untouched and the merge can be retried after the conflict is resolved).
   6. On success, clean up and never let cleanup turn a landed merge into a failure: call `removeRunWorktree(deps, { runId, mode, branch, deleteBranch: true })` and fold its `warnings` (plus, on an `err`, the error's `message`) into `cleanup`. The worktree must be deregistered before the branch is deleted, which `removeRunWorktree` already does — git refuses to delete a branch checked out in any worktree. Return `ok({ commit: merged.value, baseBranch, branch, cleanup })`.

   Also export the default message builder:
   ```ts
   export function runMergeMessage(input: { runId: string; branch: string; statement?: string }): string
   ```
   Subject `Merge ${branch}` — or `` `Merge ${branch}: ${firstLine}` `` when `statement` is a non-blank string, where `firstLine` is its first line trimmed and truncated to 60 characters with an ellipsis — then a blank line and the trailer `Run-Id: ${runId}`, ending with a newline. This mirrors the `Run-Id:` trailer the execute commit carries, so `findCommitByRunId` also finds the merge.

   Files: `src/engine/runWorktree.ts`

6. Implement removeRunWorktree (remove on demand, idempotent)

   ```ts
   export async function removeRunWorktree(
     deps: RunWorktreeDeps,
     input: {
       runId: string;
       mode: RunMode;
       branch?: string;
       /** Delete the run branch too; default false. */
       deleteBranch?: boolean;
       /** Force removal over local modifications in the worktree; default true. */
       force?: boolean;
     },
   ): Promise<Result<RunWorktreeRemoval, RunWorktreeError>>
   ```
   Behaviour, tolerant of every partial state so cancel/cleanup can be retried:
   1. Validate `runId` with `isRunId` → `kind: 'invalid-id'`.
   2. `const registered = await findRunWorktree(deps, input.runId);` If present, `await deps.git.removeWorktree(worktreeDir, input.force ?? true)` in try/catch; a failure returns `err({ kind: 'git', ... })` (nothing else has been destroyed yet). Set `worktreeRemoved = true` on success.
   3. If `existsSync(worktreeDir)` still, `rmSync(worktreeDir, { recursive: true, force: true })` in try/catch — success sets `dirRemoved = true`, a failure appends a warning rather than failing (the registration is already gone, which is what matters).
   4. When `input.deleteBranch` is true and `await deps.git.branchHead(branch) !== undefined`, `await deps.git.deleteBranch(branch, true)` (force: a cancelled run's branch is legitimately unmerged) in try/catch; on failure append a warning and leave `branchDeleted` false. An absent branch is simply `branchDeleted: false` with no warning.
   5. Return `ok({ worktreeRemoved, dirRemoved, branchDeleted, warnings })`. Calling it for a run that has nothing on disk returns all-false with no warnings.
   Document that this is what the pipeline's `cancel()` deliberately does NOT call (a cancelled run keeps its worktree and branch for inspection) and that it is the Runs view's explicit cleanup path plus the post-merge step.

   Files: `src/engine/runWorktree.ts`

7. Export the module from the engine barrel

   In `src/engine/index.ts` add `export * from './runWorktree';` immediately after `export * from './runStore';` and extend the file's leading doc comment with a clause: `... the run manifest store for spec-less runs (.baiton/runs/<run-id>/run.json) and the run worktree lifecycle (.baiton/worktrees/<run-id>/ create, merge and remove).` Verify with `npm run compile` that no exported name collides with an existing barrel export (checked against the current tree: `RunWorktreeDeps`, `RunWorktreeInfo`, `RunWorktreeError`, `RunWorktreeRemoval`, `RunMergeOutcome`, `RunMergeRefusal`, `createRunWorktree`, `mergeRunWorktree`, `removeRunWorktree`, `findRunWorktree`, `runMergeMessage`, `createRunGitService`, `runWorktreeRelativeDir`, `runWorktreesRootDir`, `RUN_WORKTREES_DIR` are all free; note `runWorktreeDirFor` already lives in `runStore.ts` and must NOT be redeclared here).

   Files: `src/engine/index.ts`

8. Write test/runWorktree.test.ts against real temp repositories

   New mocha file in the repo's existing style (`import * as assert from 'assert'`, `execFileSync` git helper, `fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-runworktree-'))`, cleanup in `afterEach`). Copy the `git(cwd, ...args)`, `writeFile(repo, rel, contents)` and `makeRepo()` helpers from `test/gitService.test.ts` (init, local `user.name`/`user.email`, `checkout -b main`, one committed `README.md`) and extend `makeRepo` to also write `.baiton/.gitignore` with `GITIGNORE_CONTENTS` (imported from `../src/config/gitignore`) and commit it — without that commit the created worktree inside `.baiton/worktrees/` makes the tree dirty and the `dirty-tree` path fires everywhere. Build deps as `{ workspaceRoot: repo, git: createGitService(repo) }`.

   Cases to cover:
   1. `createRunWorktree` creates `.baiton/worktrees/<id>/` on `baiton/quick/<id>` at the base head: the directory exists and holds `README.md`, `listWorktrees()` contains it (compare with `fs.realpathSync`), `branchHead('baiton/quick/<id>')` equals the base head, and the returned info carries `baseBranch: 'main'`, `baseHead`, `relativeWorktreeDir === '.baiton/worktrees/<id>'`.
   2. After creation the main checkout is still clean (`isClean()` true) — pins the `/worktrees/` gitignore line end to end.
   3. Refusals of create: invalid run id (`'a.b'`) → `kind: 'invalid-id'` and nothing on disk; a pre-existing non-empty directory → `kind: 'exists'`; a detached HEAD (`git checkout --detach`) → `kind: 'detached-head'`; a second create for the same run id → `kind: 'git'` (the `-b` collision) with the first worktree untouched.
   4. `createRunGitService(repo, runId).currentBranch()` returns the run branch and `head()` the worktree's head.
   5. Merge happy path: commit a new file inside the worktree (via the worktree-bound service's `commit`), then `mergeRunWorktree`; assert the returned `commit` is `main`'s head, that it has two parents (`git rev-list --parents -n 1 <sha>` yields three shas, i.e. `--no-ff` took effect), that `main` now contains the file, that the commit message carries `Run-Id: <runId>`, that `listWorktrees()` no longer lists the run, the directory is gone, `branchHead(runBranch)` is `undefined`, and `cleanup` is empty.
   6. `wrong-branch`: check out another branch in the main checkout → `reason: 'wrong-branch'` with `expected`/`actual`, and the worktree and branch still exist.
   7. `base-moved`: commit on `main` after creating the worktree → `reason: 'base-moved'` with `actual` equal to the new head; and a second case where `main` is deleted/renamed → same reason with `actual: undefined`.
   8. `dirty-tree`: write an untracked tracked-path change in the main checkout → `reason: 'dirty-tree'` whose `changes` names the path; the worktree and branch survive.
   9. Order pinning: with BOTH a moved base and a dirty tree the refusal is `base-moved`; with a wrong branch AND a dirty tree it is `wrong-branch`.
   10. `missing-branch`: merge for a run id that was never created → `reason: 'missing-branch'`.
   11. `conflict`: edit the same line of `README.md` in the worktree (committed) and on `main` (committed, then reset `baseHead` in the call to the current head so the base-moved check passes) → `reason: 'conflict'` carrying a `GitError`; assert no `.git/MERGE_HEAD`, `isClean()` true, and that the worktree directory and run branch are still present so the merge can be retried.
   12. `removeRunWorktree`: with `deleteBranch: true` it deregisters, deletes the directory and deletes the unmerged branch (`worktreeRemoved`/`dirRemoved` or `worktreeRemoved` true, `branchDeleted` true, `warnings` empty); with `deleteBranch` omitted the branch survives; called twice, the second call returns all-false with no warnings; called for an unknown-but-valid run id it is a no-op `ok`; an invalid id returns `kind: 'invalid-id'`.
   13. `runMergeMessage`: subject without a statement, subject with a statement's first line truncated, and the `Run-Id:` trailer on its own line after a blank line.
   Keep every worktree inside the repo's own `.baiton/worktrees/` (that is the production layout these tests exist to pin) and remove each temp repo in `afterEach`.

   Files: `test/runWorktree.test.ts`

9. Extend test/config.gitignore.test.ts for the new pattern

   Append a `describe('GITIGNORE_CONTENTS')` block inside the file (leaving the four existing `refreshGitignore` tests byte-for-byte unchanged) asserting: the text's lines include exactly `'/worktrees/'` (anchored form, as its own line); `/worktrees/` appears after `/runs/`; the pattern list has no duplicates; and the text ends with a single trailing newline. Also add one `refreshGitignore` case: a `.gitignore` holding the previous build's text WITHOUT the `/worktrees/` line is reported `rewritten` and ends up equal to `GITIGNORE_CONTENTS` — construct the stale text by filtering that line out of `GITIGNORE_CONTENTS.split('\n')` so the test cannot drift from the constant. Update the file's leading doc comment to mention the worktrees pattern.

   Files: `test/config.gitignore.test.ts`

10. Verify

   Run `npm run compile`, `npm run lint`, `npx mocha test/runWorktree.test.ts test/config.gitignore.test.ts` and finally `npm test`. Expect: compile clean; lint reporting only the pre-existing warning at `src/orchestrator/webviewProtocol.ts:591` (`'_legacy' assigned but never used`); the full suite at 1786 passing / 1 pending / 0 failing plus the new cases, with no existing test file other than `test/config.gitignore.test.ts` modified. Finish with `git status --porcelain` and confirm the only entries are `M src/config/gitignore.ts`, `M src/engine/index.ts`, `M test/config.gitignore.test.ts`, `?? src/engine/runWorktree.ts`, `?? test/runWorktree.test.ts` — in particular no stray `.baiton/worktrees/` left behind by a test (tests must only ever create worktrees inside their own temp repos).

   Files: `src/config/gitignore.ts`, `src/engine/runWorktree.ts`, `src/engine/index.ts`, `test/runWorktree.test.ts`, `test/config.gitignore.test.ts`

## Risks

- A worktree created inside the repository makes `git status` dirty until `/worktrees/` is ignored, and the merge path's own `dirty-tree` check reads that status. The gitignore step and the run-worktree step are therefore coupled: any test repo that does not commit `.baiton/.gitignore` will see spurious `dirty-tree` refusals. Commit the ignore file in the test `makeRepo` helper.
- `git worktree list --porcelain` prints realpaths, so on macOS (and any host where the temp dir or workspace root is a symlink) a raw string comparison against the constructed path fails. Always compare through `realpathSync` with a `path.resolve` fallback, both in `findRunWorktree` and in the tests.
- Git refuses `git branch -d/-D` for a branch checked out in any worktree, so the post-merge cleanup must deregister the worktree before deleting the branch. Getting the order wrong yields a landed merge with a leftover branch.
- The refusal check order is observable behaviour (the Runs view shows one reason). Pin it in code comments and in a test, otherwise a later reorder silently changes which reason the user sees when several conditions hold at once.
- Cleanup failures after a successful merge must not be reported as a failed merge — the commit is already on the base branch and re-running the merge would then refuse with `base-moved`. Hence `RunMergeOutcome.cleanup` as warnings rather than an error.
- `branchHead` returns `undefined` for a missing ref rather than rejecting, so a deleted or renamed base branch must be routed deliberately into `base-moved` instead of being compared as a string and silently passing or throwing.
- `currentBranch()` is `rev-parse --abbrev-ref HEAD`, which returns the literal `HEAD` on a detached checkout; without the explicit `detached-head` refusal a run would remember `HEAD` as its base branch and could never merge back.
- The engine barrel re-exports everything, so a new exported name that collides with `runStore.ts`, `runQueue.ts` or `resultFlow.ts` breaks the build; `runWorktreeDirFor` in particular already lives in `runStore.ts` and must be imported, not redeclared.

## Acceptance

- `GITIGNORE_CONTENTS` contains `/worktrees/` as its own anchored line directly after `/runs/`, and `refreshGitignore` rewrites a file that lacks it; `test/config.test.ts` (which compares Initialize's output to the constant) still passes unchanged.
- `src/engine/runWorktree.ts` exports `createRunWorktree`, `mergeRunWorktree`, `removeRunWorktree`, `findRunWorktree`, `createRunGitService`, `runMergeMessage`, `runWorktreeRelativeDir`, `runWorktreesRootDir` and their types, imports no `vscode`, and returns `Result` values for every expected failure instead of throwing.
- `createRunWorktree` creates `.baiton/worktrees/<run-id>/` checked out on `baiton/<mode>/<run-id>` at the head of the branch that was checked out at the time, records that branch and sha in the returned info, and leaves the main checkout clean; it refuses an invalid run id, a non-empty existing directory, a detached HEAD, an unborn base branch and a run-id/branch collision, each with its own `kind`.
- `mergeRunWorktree` refuses `wrong-branch`, `base-moved` and `dirty-tree` with the documented precedence and without touching git state, refuses `missing-branch` for an unknown run branch, and reports a conflicting merge as `conflict` with the tree left clean (no `.git/MERGE_HEAD`) and the run's worktree and branch intact.
- A successful `mergeRunWorktree` produces a real merge commit (two parents) on the base branch carrying a `Run-Id: <run-id>` trailer, then removes the worktree registration, its directory and the run branch, reporting any cleanup problem as a warning rather than a failure.
- `removeRunWorktree` deregisters the worktree, deletes any leftover directory, optionally force-deletes the run branch, and is idempotent — a second call and a call for a run with nothing on disk both return `ok` with all flags false and no warnings.
- `src/engine/index.ts` re-exports the module and `npm run compile` is clean (no export-name collision).
- `test/runWorktree.test.ts` covers create (success plus each refusal), the worktree-bound git service, the merge happy path, all four merge refusals, the precedence cases, remove/idempotence and `runMergeMessage`, driving real temporary git repositories.
- `npm run compile` clean, `npm run lint` clean apart from the pre-existing `webviewProtocol.ts:591` warning, and `npm test` green with zero failures and no previously passing test modified other than the additive edits to `test/config.gitignore.test.ts`.
- `git status --porcelain` shows only the five files of this todo, with no `.baiton/worktrees/` residue from the test run.
