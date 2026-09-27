# Plan T03

## Steps

1. Add worktree/merge vocabulary and a widened service interface to src/git/types.ts

   Append to `src/git/types.ts`, leaving every existing type and the whole `GitService` interface byte-for-byte unchanged (this is load-bearing: several existing tests build full `GitService` object literals — `test/askWatcher.routing.test.ts:231`, `test/engine.specDraft.test.ts:131`, `test/engineFacade.resume.test.ts:106`, `test/registry.controlTools.test.ts:75,100`, `test/registry.assembleToolSpecs.test.ts:289`, `test/controlTools.invalidBlocks.property.test.ts:192`, and the runQueue property tests — and tsconfig type-checks `test/**` under ts-node, so adding a required member to `GitService` would break them all).

   1. `export interface GitWorktree` — one entry of `git worktree list --porcelain`: `readonly dir: string` (absolute path as git reports it), `readonly head: string | undefined` (sha; undefined for a bare entry), `readonly branch: string | undefined` (short name with `refs/heads/` stripped; undefined when detached or bare), `readonly locked: boolean`, `readonly prunable: boolean`.

   2. `export interface GitWorktreeService extends GitService` with the new members (doc-comment each, in the file's existing voice, citing design "Git service" / the run worktree design):
      - `addWorktree(dir: string, branch: string, fromCommit: string): Promise<void>` — create a new worktree at `dir` checked out on a NEW branch `branch` starting at `fromCommit`.
      - `listWorktrees(): Promise<readonly GitWorktree[]>` — every worktree of this repository, main worktree first (git's own order).
      - `removeWorktree(dir: string, force?: boolean): Promise<void>` — remove the worktree registration and its directory; `force` also removes one with local modifications.
      - `deleteBranch(branch: string, force?: boolean): Promise<void>` — delete a local branch; without `force` git refuses an unmerged branch.
      - `branchHead(ref: string): Promise<string | undefined>` — the commit sha `ref` resolves to, or `undefined` when the ref does not exist (deliberately not a rejection: callers compare a base branch's head to a remembered sha and must tolerate a deleted branch).
      - `merge(branch: string, message: string): Promise<Result<string, GitError>>` — merge `branch` into the currently checked-out branch as a real merge commit; the success value is the new merge commit sha. Returns a `Result` rather than rejecting because a conflict is an ordinary outcome the caller reports as a named reason (same rationale as `resetWorkingTree`, Req 15.6). Document that a failed merge is aborted so the tree is left as it was.
      - `isClean(): Promise<boolean>` — true when the WHOLE working tree has no changes of any kind; the run pipeline's `dirty-tree` check, as opposed to the spec-scoped `isCleanExceptSpecFolder`.

   State the convention in the interface doc comment: reads reject on an unexpected non-zero exit, mutators (`addWorktree`, `removeWorktree`, `deleteBranch`) reject with a `GitError` like `createSpecBranch`/`checkout`/`commit`, and only `merge` returns a `Result`.

   No change is needed in `src/git/index.ts` (it already re-exports `./types` and `./gitService` with `export *`).

   Files: `src/git/types.ts`

2. Implement the new primitives in ShellGitService and widen createGitService's return type

   In `src/git/gitService.ts`:

   1. Import `GitWorktree, GitWorktreeService` alongside the existing type imports; change the class to `class ShellGitService implements GitWorktreeService` and the factory signature to `export function createGitService(repoRoot: string): GitWorktreeService`. Widening the return type is backwards compatible: every existing caller stores it as `GitService` (`src/extension.ts`, `src/engine/runQueue.ts`, `src/engine/submitPr.ts`, `src/orchestrator/toolServices.ts`, `test/integration.plan-execute-review.test.ts`) and keeps compiling untouched. Keep the existing methods exactly as they are.

   2. New methods on the class, all going through the existing private `runOrThrow` / `run` helpers (argv arrays, no shell):
      - `async addWorktree(dir, branch, fromCommit)`: `await this.runOrThrow(['worktree', 'add', '-b', branch, dir, fromCommit])`. Comment that `-b` (not `-B`) is deliberate so an id collision fails loudly instead of silently resetting an existing branch.
      - `async listWorktrees()`: `const out = await this.runOrThrow(['worktree', 'list', '--porcelain']); return parseWorktreeList(out);`
      - `async removeWorktree(dir, force = false)`: argv `['worktree', 'remove', ...(force ? ['--force'] : []), dir]`, via `runOrThrow`.
      - `async deleteBranch(branch, force = false)`: `['branch', force ? '-D' : '-d', branch]`, via `runOrThrow`.
      - `async branchHead(ref)`: `const r = await this.run(['rev-parse', '--verify', `${ref}^{commit}`]); if (r.exitCode !== 0) return undefined; const sha = r.stdout.trim(); return sha ? sha : undefined;` — uses the non-throwing `run` so a missing ref is `undefined`, not a rejection.
      - `async merge(branch, message)`: argv `['merge', '--no-ff', '--no-edit', '-m', message, branch]` (`--no-ff` guarantees a merge commit so `message` is always recorded even when the base could fast-forward). On `exitCode !== 0`, first attempt `await this.run(['merge', '--abort'])` to leave the tree as it was (ignore the abort's own exit code — it is non-zero when the failure happened before any merge state existed) and return `err(toGitError(args, result))`. On success return `ok(await this.head())`.
      - `async isClean()`: `return (await this.status()).clean;`

   3. Module-level helper `function parseWorktreeList(output: string): GitWorktree[]` beside the existing `parsePorcelain`: split the porcelain output into records on blank lines and read one key per line — `worktree <path>` starts a record (`dir`), `HEAD <sha>` sets `head`, `branch refs/heads/<name>` sets `branch` (strip the `refs/heads/` prefix), `bare` and `detached` leave `head`/`branch` as they are, `locked` (optionally followed by a reason) sets `locked: true`, `prunable <reason>` sets `prunable: true`. Skip records with no `worktree` line. Preserve git's order. Document that the `dir` is whatever absolute path git prints (git reports the realpath, which can differ from a symlinked input such as `/tmp` on macOS) so callers compare with `fs.realpathSync` rather than raw equality.

   Files: `src/git/gitService.ts`

3. Extend test/gitService.test.ts with a worktree/merge suite against temp repos

   APPEND to `test/gitService.test.ts`; do not edit any existing helper, `describe`, `it` or the file's existing `afterEach`. Extend only the file's top doc comment with the new bullets (worktree add/list/remove, branch delete, `branchHead`, `merge`, whole-tree `isClean`). Reuse the existing `git()`, `writeFile()`, `makeRepo()`/`newRepo()` helpers.

   Add a new top-level (or nested inside the existing describe, after the last block) `describe('run worktrees, branch delete, branchHead, merge and isClean', ...)` with its own local `const scratch: string[] = []` plus `newScratch()` (`fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-wt-'))`, pushed) and an `afterEach` that `fs.rmSync`s each scratch dir — worktrees are created in sibling scratch dirs, NOT inside the repo, so they cannot perturb the repo's own status. Use `const wt = path.join(newScratch(), 'run-1')` as the worktree path (git creates the leaf dir itself). Compare paths git reports against `fs.realpathSync(...)` of the expected path.

   Tests:
   - addWorktree + listWorktrees: `addWorktree(wt, 'baiton/bug/run-1', base)` where `base = await git$.resolveBaseCommit('main')`; assert the dir exists, `createGitService(wt).currentBranch()` === `'baiton/bug/run-1'` and its `head()` === base; `listWorktrees()` has length 2, entry 0's `dir` is the main repo realpath with `branch === 'main'`, and the added entry has `branch === 'baiton/bug/run-1'`, `head === base`, `locked === false`, `prunable === false`.
   - addWorktree rejects when the branch already exists: `createSpecBranch('taken', base)` then `assert.rejects(() => git$.addWorktree(wt, 'taken', base))`.
   - locked parsing: after `git(repo, 'worktree', 'lock', wt)`, the added entry reports `locked === true`; unlock afterwards (`git(repo, 'worktree', 'unlock', wt)`) so cleanup is unaffected.
   - removeWorktree: after add, `removeWorktree(wt)` leaves `listWorktrees()` length 1 and `fs.existsSync(wt) === false`.
   - removeWorktree rejects on a dirty worktree without force and succeeds with it: write an untracked/modified file under `wt`, `assert.rejects(() => git$.removeWorktree(wt))`, then `await git$.removeWorktree(wt, true)` and assert the dir is gone.
   - branchHead: equals `git(repo,'rev-parse','main').trim()` for `'main'`, resolves `'HEAD'`, and returns `undefined` for `'no-such-branch'` (never rejects).
   - merge happy path: add the worktree, commit a new file inside it through `createGitService(wt).commit('run work', { 'Run-Id': 'run-1' })`, then from the repo (on `main`) `const merged = await git$.merge('baiton/bug/run-1', 'baiton: merge run-1')`; assert `isOk(merged)`, the value matches `/^[0-9a-f]{40}$/` and equals `await git$.head()`, the merge commit has two parents (`git(repo,'rev-list','--parents','-n','1','HEAD')` has 3 shas — `--no-ff`), `git(repo,'log','-1','--format=%s')` contains the message, the branch's file now exists in the repo working tree, and `await git$.isClean() === true`.
   - merge cleanup composition: after that merge, `await git$.removeWorktree(wt)` then `await git$.deleteBranch('baiton/bug/run-1')` (plain `-d`, allowed because it is merged) and assert `await git$.branchHead('baiton/bug/run-1') === undefined`.
   - deleteBranch on an unmerged branch: rejects without force, succeeds with `force = true`, after which `branchHead` is `undefined`.
   - merge conflict: create the conflicting edit on both sides (edit `README.md` differently in the worktree commit and on `main`), `merge(...)` returns `isErr`, `result.error.command.startsWith('git ')`, `result.error.exitCode !== 0`, AND the repo is left out of merge state — `fs.existsSync(path.join(repo, '.git', 'MERGE_HEAD')) === false` and `README.md` still holds main's content (the `--merge --abort` path).
   - merge of a non-existent branch returns `isErr` (no throw).
   - isClean: `true` on a fresh repo; `false` with an untracked file; `false` with a modified tracked file; `false` when the only change is `.baiton/specs/my-slug/spec.md` while `isCleanExceptSpecFolder('my-slug')` is `true` in the same state (pins that the two checks are different).

   Files: `test/gitService.test.ts`

4. Verify the whole suite and lint

   Run `npm run compile` (type-checks `src/**` and `test/**` under the repo's strict tsconfig — `noUnusedLocals`/`noUnusedParameters` are on, so no stray imports or unused params), `npm run lint`, and `npm test`. The pass count must be the previous total plus the new tests, with zero failures and no existing test file touched other than the additive block in `test/gitService.test.ts`. Confirm `git status` shows only `src/git/types.ts`, `src/git/gitService.ts` and `test/gitService.test.ts` as modified.

   Files: `src/git/types.ts`, `src/git/gitService.ts`, `test/gitService.test.ts`

## Risks

- Adding a required member to the existing `GitService` interface would break at least seven existing test files that construct full `GitService` object literals (tsconfig includes `test/**` and ts-node type-checks), violating the "every existing test passes unchanged" constraint. The plan therefore puts every new member on a new `GitWorktreeService extends GitService` and only widens `createGitService`'s return type.
- Path identity: `git worktree list --porcelain` prints realpaths, so on macOS a worktree created under `/tmp/...` is reported under `/private/var/...`. Tests and any later caller must compare with `fs.realpathSync`, not raw string equality.
- A failed `merge` must not leave the repository in a conflicted state, or the run pipeline's later `dirty-tree` check would misfire on every subsequent run. The implementation runs `git merge --abort` on failure and ignores that abort's own exit code (it is non-zero when the merge failed before any merge state was created, e.g. an unknown branch).
- `--no-ff` is chosen so the merge message is always recorded; it means merging a branch whose base has not moved still creates a merge commit. If a future todo wants fast-forward merges, that is a change to this argv, not to the seam.
- `git worktree remove` refuses a worktree with local modifications; without the `force` parameter the merge-cleanup path in a later todo could not finish after a stage left scratch files behind.
- Creating a worktree inside the repository working tree (as production does at `.baiton/worktrees/<run-id>/`) makes it show up in `status --porcelain --untracked-files=all` and hence in `isClean()` unless it is gitignored. `GITIGNORE_CONTENTS` gaining `/worktrees/` belongs to another todo; this todo's tests avoid the coupling by creating worktrees in sibling temp dirs.
- `branchHead` returning `undefined` instead of rejecting is a deliberate asymmetry with `resolveBaseCommit`; both stay, since callers of the latter want a hard failure on a bad base ref.

## Acceptance

- `src/git/types.ts` exports `GitWorktree` and `GitWorktreeService extends GitService` declaring `addWorktree`, `listWorktrees`, `removeWorktree`, `deleteBranch`, `branchHead`, `merge` and `isClean`; the pre-existing `GitService`, `GitStatus`, `GitChange` and `GitError` declarations are unchanged.
- `createGitService(repoRoot)` returns `GitWorktreeService` and `ShellGitService implements GitWorktreeService`; no existing method's behaviour or argv changed.
- `merge` returns `Result<string, GitError>` — `ok(<merge commit sha>)` on success, `err(GitError)` on conflict or unknown branch — and leaves no `.git/MERGE_HEAD` behind after a failure.
- `branchHead` resolves an existing ref to a 40-char sha and returns `undefined` for a missing ref without rejecting.
- `isClean()` is true only when the whole working tree has no changes, including untracked files, and is false in the state where `isCleanExceptSpecFolder(slug)` is true.
- `test/gitService.test.ts` contains a new suite covering worktree add/list/remove (including the dirty-worktree force path and locked parsing), branch delete merged/unmerged/force, `branchHead` present/absent, `merge` success (two-parent commit, message, merged file, clean tree), `merge` conflict (err + aborted) and unknown branch, and `isClean` true/false cases — all driving real temporary repositories and cleaning up their directories.
- `npm run compile`, `npm run lint` and `npm test` all pass; the suite's passing count is strictly greater than before and no test file other than `test/gitService.test.ts` is modified.
- `git status` shows exactly the three files of this todo as changed.
