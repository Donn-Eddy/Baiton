# Plan T01

## Steps

1. Extend the widened git interface with commitPaths and listBranches

   In src/git/types.ts add two members to `GitWorktreeService` (NOT to the narrower `GitService`: ~13 test files build `GitService` object literals that would all stop compiling, while only one test class implements `GitWorktreeService`; `createGitService` already returns `GitWorktreeService`, so every production caller gets the methods). Doc-comment both in the file's style:

   ```ts
   /**
    * Stage ONLY `paths` (additions, modifications and deletions beneath them) and
    * commit exactly those paths, appending each trailer as a `Key: value` line like
    * {@link GitService.commit}. Changes elsewhere in the tree — unstaged or already
    * staged — are left out of the commit and stay as they were. Rejects with a
    * {@link GitError} when `paths` is empty-handed or there is nothing to commit.
    */
   commitPaths(paths: readonly string[], message: string, trailers?: Record<string, string>): Promise<string>;
   /**
    * Every local branch whose short name starts with `prefix` (e.g.
    * `baiton-todo/<slug>/`), as short names (no `refs/heads/`), sorted.
    */
   listBranches(prefix: string): Promise<readonly string[]>;
   ```

   Files: `src/git/types.ts`

2. Implement commitPaths and listBranches in ShellGitService

   In src/git/gitService.ts, inside `ShellGitService`:

   ```ts
   async commitPaths(paths: readonly string[], message: string, trailers?: Record<string, string>): Promise<string> {
     if (paths.length === 0) {
       throw { command: 'git commit', exitCode: undefined, stderr: 'commitPaths needs at least one path' } satisfies GitError;
     }
     // `add -A -- <paths>` stages new files and deletions under the paths only.
     await this.runOrThrow(['add', '-A', '--', ...paths]);
     // A pathspec on `commit` means `--only`: the commit records exactly these
     // paths and ignores anything else already staged, so a central spec-folder
     // commit can never sweep unrelated changes.
     await this.runOrThrow(['commit', '-m', withTrailers(message, trailers), '--only', '--', ...paths]);
     return this.head();
   }

   async listBranches(prefix: string): Promise<readonly string[]> {
     // List every head and filter in JS: for-each-ref's own pattern matching is
     // prefix-up-to-a-slash / fnmatch, which does not express an arbitrary prefix.
     const out = await this.runOrThrow(['for-each-ref', '--format=%(refname)', 'refs/heads/']);
     const full = `${HEADS_PREFIX}${prefix}`;
     return out.split('\n').map((l) => l.trim()).filter((l) => l.startsWith(full))
       .map((l) => l.slice(HEADS_PREFIX.length)).sort();
   }
   ```
   (Place them after `isClean`; `HEADS_PREFIX` is already defined at module level — it is a `const` declared below the class, which is fine at call time. Keep the rejection for empty paths a plain GitError-shaped object like `runOrThrow` throws.) Update the header doc of the file only if it enumerates methods (it does not need to).

   Files: `src/git/gitService.ts`

3. Keep the one GitWorktreeService fake compiling

   test/runPipeline.test.ts `class FakeGit implements GitWorktreeService` must gain the two members or `npm run compile` fails. Add, next to the other `boom` stubs: `commitPaths = boom('commitPaths');` and `listBranches = boom('listBranches');`. (runsExplorer.test.ts casts a Partial and integration.run-modes.test.ts uses the real service, so neither needs changes.) This file is outside the todo's listed files but the edit is mechanical and required for the build to stay green.

   Files: `test/runPipeline.test.ts`

4. Export the shared helpers from runWorktree.ts

   In src/engine/runWorktree.ts change `function asGitError` and `function safeRealpath` to `export function` (no behaviour change; keep their doc comments) so todoWorktree.ts reuses them instead of duplicating. Leave the private `describe` helper private (exporting a symbol named `describe` through `src/engine/index.ts` would shadow mocha's global in any test that star-imports the engine); todoWorktree.ts gets its own private `describeError`. Nothing else in runWorktree.ts changes.

   Files: `src/engine/runWorktree.ts`

5. Create src/engine/todoWorktree.ts — naming and ids

   New host-free module, header doc modelled on runWorktree.ts's (lifecycle: create/reuse, find, land, remove, unlandedTodos; Result-not-throw; no vscode; sync fs). Imports: `existsSync, mkdirSync, readdirSync, rmSync` from 'fs', `path`, `Result, err, ok` from '../model/result', `createGitService` from '../git/gitService', types `GitError, GitWorktree, GitWorktreeService` from '../git/types', `RUN_WORKTREES_DIR, asGitError, safeRealpath` from './runWorktree'.

   IMPORTANT naming deviation: the spec branch is `baiton/<slug>` (see `src/orchestrator/controlTools.ts:593`). Git stores refs as files, so a branch `baiton/<slug>/<todoId>` cannot coexist with the branch `baiton/<slug>` ("cannot lock ref ... exists"). The todo branch therefore lives in its own namespace. Exports:

   ```ts
   /** The ref namespace every todo branch lives under; NOT `baiton/`, whose `baiton/<slug>` spec branch would make `baiton/<slug>/<id>` an impossible ref. */
   export const TODO_BRANCH_NAMESPACE = 'baiton-todo';
   export function specBranchFor(slug: string): string { return `baiton/${slug}`; }
   export function todoBranchPrefix(slug: string): string { return `${TODO_BRANCH_NAMESPACE}/${slug}/`; }
   export function todoBranchFor(slug: string, todoId: string): string { return `${todoBranchPrefix(slug)}${todoId}`; }
   export function todoWorktreeDirFor(workspaceRoot: string, slug: string, todoId: string): string { return path.join(workspaceRoot, '.baiton', RUN_WORKTREES_DIR, slug, todoId); }
   export function todoWorktreeRelativeDir(slug: string, todoId: string): string { return `.baiton/${RUN_WORKTREES_DIR}/${slug}/${todoId}`; }
   export function todoLandMessage(slug: string, todoId: string): string { return `spec(${slug}): land ${todoId}`; }
   /** A slug or todo id usable as both a path segment and a ref component. */
   export function isTodoWorktreeKey(value: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && !value.includes('..') && !value.endsWith('.lock') && !value.endsWith('.'); }
   ```
   Also `createTodoGitService(workspaceRoot, slug, todoId, factory = createGitService)` returning `factory(todoWorktreeDirFor(...))` (mirror of `createRunGitService`; later todos bind the queue's drift/commit/reset git to it).

   Types:
   ```ts
   export interface TodoWorktreeDeps { workspaceRoot: string; git: GitWorktreeService /* MAIN checkout */; createService?: (dir: string) => GitWorktreeService; }
   export interface TodoWorktreeInfo { slug: string; todoId: string; branch: string; specBranch: string; worktreeDir: string; relativeWorktreeDir: string; /** head of the todo branch as found/created */ head: string; /** true when an existing registered worktree was reused */ reused: boolean; }
   export type TodoWorktreeError =
     | { kind: 'invalid-id'; slug: string; todoId: string; message: string }
     | { kind: 'no-spec-branch'; slug: string; todoId: string; specBranch: string; message: string }
     | { kind: 'exists'; slug: string; todoId: string; path: string; message: string }          // non-empty unregistered dir
     | { kind: 'wrong-branch'; slug: string; todoId: string; path: string; expected: string; actual: string | undefined; message: string } // registered worktree on another branch/detached
     | { kind: 'stale'; slug: string; todoId: string; path: string; message: string }           // registered but prunable / dir missing
     | { kind: 'orphan-branch'; slug: string; todoId: string; branch: string; message: string } // branch exists, no worktree
     | { kind: 'git'; slug: string; todoId: string; message: string; error?: GitError }
     | { kind: 'io'; slug: string; todoId: string; path: string; message: string };
   export interface TodoLandOutcome { commit: string; specBranch: string; branch: string; /** true when the branch was already contained in the spec branch: no merge commit was made */ noop: boolean; cleanup: readonly string[]; }
   export type TodoLandRefusal =
     | { reason: 'invalid-id'; message: string }
     | { reason: 'wrong-branch'; expected: string; actual: string; message: string }
     | { reason: 'dirty-tree'; changes: readonly string[]; message: string }
     | { reason: 'missing-branch'; branch: string; message: string }
     | { reason: 'conflict'; branch: string; error: GitError; message: string }
     | { reason: 'git'; message: string };
   export interface TodoWorktreeRemoval { worktreeRemoved: boolean; dirRemoved: boolean; branchDeleted: boolean; warnings: readonly string[]; }
   ```

   Files: `src/engine/todoWorktree.ts`

6. todoWorktree.ts — findTodoWorktree and idempotent createTodoWorktree

   `export async function findTodoWorktree(deps, slug, todoId): Promise<GitWorktree | undefined>` — `safeRealpath(todoWorktreeDirFor(...))` compared with `safeRealpath(w.dir)` over `deps.git.listWorktrees()`, exactly like `findRunWorktree`.

   `export async function createTodoWorktree(deps, input: { slug; todoId }): Promise<Result<TodoWorktreeInfo, TodoWorktreeError>>`, checks in this order, returning on the first failure and creating nothing before all pass:
   1. both ids pass `isTodoWorktreeKey` else `invalid-id`.
   2. `registered = await findTodoWorktree(...)` (catch → `git`). If registered: if `registered.prunable || !existsSync(worktreeDir)` → `stale` (message: remove it with removeTodoWorktree, then dispatch again); if `registered.branch !== branch` → `wrong-branch`; else return `ok({... head: registered.head ?? await deps.git.branchHead(branch), reused: true })`. Reuse deliberately does NOT look at the spec branch head: a worktree is created from the spec head the first time only and then keeps its own history.
   3. `if ((await deps.git.branchHead(branch)) !== undefined)` → `orphan-branch` (the branch survives without a worktree — e.g. someone removed the directory by hand; message says to land or remove it via removeTodoWorktree with deleteBranch). `addWorktree` uses `-b` and would fail anyway; a named reason is clearer.
   4. `specHead = await deps.git.branchHead(specBranchFor(slug))`; undefined → `no-spec-branch`. Base on the spec BRANCH's head, not `currentBranch()`, so creation works whatever the main checkout has checked out.
   5. existing non-empty directory at worktreeDir → `exists` (empty dir tolerated, `readdirSync` failure → `io`), same code as createRunWorktree.
   6. `mkdirSync(path.dirname(worktreeDir), { recursive: true })` (→ `io`), then `deps.git.addWorktree(worktreeDir, branch, specHead)` (catch → `git` with `asGitError`).
   7. `ok({ slug, todoId, branch, specBranch, worktreeDir, relativeWorktreeDir, head: specHead, reused: false })`.

   Files: `src/engine/todoWorktree.ts`

7. todoWorktree.ts — removeTodoWorktree

   `export async function removeTodoWorktree(deps, input: { slug; todoId; deleteBranch?: boolean; force?: boolean }): Promise<Result<TodoWorktreeRemoval, TodoWorktreeError>>` — a copy of `removeRunWorktree`'s tolerant sequence keyed by slug+todo: invalid ids → `invalid-id`; `findTodoWorktree` (catch → `git`); if registered, `deps.git.removeWorktree(dir, input.force ?? true)` (catch → `git`, nothing destroyed yet); then `rmSync` any leftover dir (failure → warning); then if `deleteBranch === true` and `branchHead(branch) !== undefined`, `deps.git.deleteBranch(branch, true)` (failure → warning). After removing the leaf dir, also try to `rmdirSync`-style remove the now-empty `.baiton/worktrees/<slug>/` parent only if `readdirSync` shows it empty (ignore errors), so a fully landed spec leaves no empty folder. Nothing-on-disk is an all-false ok. Doc comment: this is never called for a failed or stopped stage — those keep worktree and branch for inspection; it is the post-land step and an explicit cleanup path.

   Files: `src/engine/todoWorktree.ts`

8. todoWorktree.ts — landTodoWorktree

   `export async function landTodoWorktree(deps, input: { slug; todoId; message?: string }): Promise<Result<TodoLandOutcome, TodoLandRefusal>>`. Runs entirely in the MAIN checkout (`deps.git`). Pinned check order (document it in the doc comment, tests assert precedence): invalid-id → wrong-branch → dirty-tree → missing-branch → merge. There is deliberately NO base-moved check (the spec branch advances with state commits while a todo is in flight) — say so in the doc.
   1. ids invalid → `invalid-id`.
   2. `actual = await deps.git.currentBranch()` (catch → `git`); `actual !== specBranchFor(slug)` → `wrong-branch` ("check out baiton/<slug>, then land again").
   3. `status = await deps.git.status()` (catch → `git`); `outside = status.changes.map(c => c.path).filter(p => !p.startsWith(`.baiton/specs/${slug}/`))`; non-empty → `dirty-tree` with `changes: outside` (same predicate as `isCleanExceptSpecFolder`, but `status()` so the refusal can name the paths).
   4. `branch = todoBranchFor(slug, todoId)`; `todoHead = await deps.git.branchHead(branch)`; undefined → `missing-branch` (message: may already have been landed).
   5. `before = await deps.git.head()`; `merged = await deps.git.merge(branch, input.message ?? todoLandMessage(slug, todoId))`; `!merged.ok` → `conflict` (message: merge aborted, spec branch unchanged, todo branch and worktree untouched) — return WITHOUT any cleanup.
   6. `noop = merged.value === before` (git exits 0 with "Already up to date" and makes no commit when the todo branch is already contained, even with --no-ff).
   7. Cleanup via `removeTodoWorktree(deps, { slug, todoId, deleteBranch: true })`; its warnings/error message go into `cleanup` and never turn the land into a failure (the merge is already on the spec branch). Cleanup also runs on a no-op land, because `unlandedTodos` is defined by branch existence and an up-to-date branch IS landed.
   8. `ok({ commit: merged.value, specBranch, branch, noop, cleanup })`.
   Do not add any locking here — serialization with state commits is the later spec-branch writer's job (its `apply(slug, fn)` will wrap this call).

   Files: `src/engine/todoWorktree.ts`

9. todoWorktree.ts — unlandedTodos

   `export async function unlandedTodos(deps: Pick<TodoWorktreeDeps, 'git'>, slug: string): Promise<readonly string[]>` — `(await deps.git.listBranches(todoBranchPrefix(slug))).map(b => b.slice(prefix.length)).filter(id => id.length > 0 && !id.includes('/'))`, sorted ascending (T01 < T02 lexically works for the `T\d{2,}` ids; use `localeCompare` with `{ numeric: true }` to be safe). Because the prefix ends in `/`, slug `foo` never matches branches of slug `foo-bar`. Lets errors from listBranches propagate (it is a read; matches `findRunWorktree`'s style) — document that it rejects on a git failure.

   Files: `src/engine/todoWorktree.ts`

10. Export from the engine barrel

   In src/engine/index.ts add `export * from './todoWorktree';` right after `export * from './runWorktree';` and extend the header comment with one clause: "the per-todo worktree lifecycle (`.baiton/worktrees/<slug>/<todo-id>/` on `baiton-todo/<slug>/<todo-id>`: create/reuse, land into the spec branch, remove, unlanded listing)". Check no name collides with existing engine exports (`specBranchFor`, `todoBranchFor`, `TODO_BRANCH_NAMESPACE`, `isTodoWorktreeKey` etc. are new; grep src/engine before finishing — `asGitError`/`safeRealpath` are now exported from runWorktree and must not be re-declared as exports in todoWorktree.ts).

   Files: `src/engine/index.ts`

11. gitService tests for commitPaths and listBranches

   In test/gitService.test.ts add two `describe` blocks inside the existing suite, using its `newRepo()`, `writeFile`, `git` helpers and `createGitService(repo)`:
   - commitPaths: (a) modify README.md, add untracked `.baiton/specs/s/spec.md` and delete a previously committed `.baiton/specs/s/old.md`; `commitPaths(['.baiton/specs/s'], 'spec(s): T01 state', { 'Run-Id': 'r1' })` returns `git rev-parse HEAD`; `git show --name-status HEAD` lists only the two spec paths (A spec.md, D old.md); README.md is still reported modified by `status()`; `git log -1 --format=%B` ends with `Run-Id: r1`. (b) a file under another path that was already `git add`-ed before the call is NOT in the commit and is still staged afterwards (`git diff --cached --name-only` still lists it). (c) nothing to commit under the path → rejects (assert.rejects). (d) `commitPaths([], 'x')` rejects.
   - listBranches: create `baiton-todo/s/T01`, `baiton-todo/s/T02`, `baiton-todo/s-other/T01`, `baiton/s` via `git branch`; `listBranches('baiton-todo/s/')` deep-equals `['baiton-todo/s/T01','baiton-todo/s/T02']`; `listBranches('nope/')` is `[]`. Update the file's header bullet list with the two new behaviours.

   Files: `test/gitService.test.ts`

12. New temp-repo suite test/todoWorktree.test.ts

   Copy the setup pattern of test/runWorktree.test.ts: `git()`/`writeFile()` helpers, `makeRepo()` that inits on `main`, sets local identity, commits README.md and `.baiton/.gitignore` = `GITIGNORE_CONTENTS` (load-bearing: without it the nested worktree dir makes the main tree dirty), then `git checkout -q -b baiton/s` so the spec branch `baiton/s` is checked out; repos removed in `afterEach` (remove with `fs.rmSync(..., {recursive, force})`). `deps = { workspaceRoot: repo, git: createGitService(repo) }`. Cases:
   1. naming: `todoBranchFor('s','T01') === 'baiton-todo/s/T01'`, `todoWorktreeDirFor(repo,'s','T01') === path.join(repo,'.baiton','worktrees','s','T01')`, `todoWorktreeRelativeDir`, `todoLandMessage('s','T01') === 'spec(s): land T01'`, and a regression proof that `baiton/s` and the todo branch coexist (create succeeds while `baiton/s` exists).
   2. create: ok, `reused === false`, dir exists, `git -C <dir> rev-parse --abbrev-ref HEAD` is the todo branch, its HEAD equals `baiton/s`'s head, main checkout `status()` clean and still on `baiton/s`. Also create while `main` is checked out in the main tree still bases on `baiton/s`'s head.
   3. idempotent: second create returns `reused: true`, same dir/branch, and after committing inside the worktree and advancing `baiton/s` with a spec-folder commit, a third create still reuses (head = the worktree's commit, not the new spec head).
   4. refusals: invalid ids (`'../x'`, `'a b'`) → `invalid-id`; no `baiton/<slug>` branch → `no-spec-branch`; non-empty unregistered dir → `exists`; branch exists with no worktree (`git branch baiton-todo/s/T09`) → `orphan-branch`; nothing created in any refusal (`listWorktrees().length === 1`).
   5. find: undefined before create, the entry after (branch field equals the todo branch).
   6. land happy path: commit `src/a.txt` in the worktree (`git -C wt add/commit`), then add an unrelated spec-folder commit on `baiton/s` in main (proves no base-moved check), land → ok, `noop === false`, `git log -1 --format=%s` is `spec(s): land T01`, `git rev-list --parents -n1 HEAD` has two parents, `src/a.txt` exists in main, worktree dir gone, branch gone (`branchHead` undefined), `unlandedTodos` is `[]`, `cleanup` empty.
   7. no-op land: create without committing anything in the worktree, land → ok, `noop === true`, spec head unchanged, branch + worktree removed.
   8. land refusals and precedence: main on `main` → `wrong-branch`; untracked `README2.md` in main → `dirty-tree` listing it, while an uncommitted `.baiton/specs/s/spec.md` alone does NOT refuse; missing todo branch → `missing-branch`; wrong-branch beats dirty-tree; dirty-tree beats missing-branch.
   9. conflict: commit a change to README.md in the worktree and a different change to README.md on `baiton/s`; land → `conflict`; spec head unchanged, `status()` clean (merge aborted), todo branch still at its commit, worktree dir still exists and still registered.
   10. remove: `removeTodoWorktree({deleteBranch:false})` removes the worktree but keeps the branch (so `unlandedTodos` still lists it); with `deleteBranch:true` both go; a second call is an all-false ok; empty `.baiton/worktrees/s/` parent removed.
   11. unlandedTodos: with worktrees for T01 and T02 and a branch `baiton-todo/s-other/T01`, `unlandedTodos(deps,'s')` deep-equals `['T01','T02']`; after landing T01 it is `['T02']`.
   12. `createTodoGitService(repo,'s','T01').currentBranch()` resolves to the todo branch after create.

   Files: `test/todoWorktree.test.ts`

13. Verify

   Run `npm run compile`, `npm run lint`, `npm test` (all must be green). Grep to confirm no `vscode` import in src/engine/todoWorktree.ts or src/git/. Confirm `git status` shows only the intended files changed.

   Files: (none)

## Risks

- Branch naming deviates from the OVERVIEW: `baiton/<slug>/<todoId>` is impossible while the spec branch `baiton/<slug>` exists (git ref directory/file conflict: 'cannot lock ref ... exists'). The plan uses `baiton-todo/<slug>/<todoId>` via the single helper `todoBranchFor`/`todoBranchPrefix`, so later todos (land_todo, submit_pr gate, plan `deps-unlanded` guard) must call those helpers rather than hard-coding a string; the spec text should be amended to match.
- The OVERVIEW says `GitService` gains `commitPaths`; the plan puts `commitPaths` and `listBranches` on `GitWorktreeService` instead, because ~13 test files construct `GitService` object literals that would stop compiling (and they are outside this todo's file list). `createGitService` returns `GitWorktreeService`, so production callers are unaffected, but the later spec-branch writer / SpecStore must type its git dependency as `GitWorktreeService` (or a `Pick`).
- test/runPipeline.test.ts (outside the listed files) needs two one-line `boom` stubs because its FakeGit `implements GitWorktreeService`; without them compile fails.
- `git commit --only -- <paths>` semantics: if a path under the pathspec has never existed and is absent, `git add -A -- <path>` fails with 'pathspec did not match' and commitPaths rejects; callers must only pass paths that exist or were tracked. Also relies on git's --only behaviour to leave other staged entries staged — covered by a test.
- No-op land detection compares HEAD before and after `merge --no-ff`; if a future git version created an empty merge commit for an already-contained branch, `noop` would read false but behaviour would still be correct.
- Landing merges into the main checkout while the spec folder may hold uncommitted state (allowed by the dirty check). If the todo branch ever touched `.baiton/specs/<slug>/` files that are locally modified, git would refuse the merge and it would surface as `conflict`; the later spec-branch writer serializes land with state commits to make this rare.
- Worktree dirs `.baiton/worktrees/<slug>/<todoId>` share the parent with run worktrees `.baiton/worktrees/<run-id>`; a run id equal to a slug would collide. Run ids carry a random suffix, so this is theoretical.
- `orphan-branch` and `stale` are refusals rather than auto-repairs; if later todos need automatic re-attachment of a surviving branch, a `git worktree add <dir> <existing-branch>` primitive would have to be added.

## Acceptance

- `src/engine/todoWorktree.ts` exists, has no `vscode` import, and exports `TODO_BRANCH_NAMESPACE`, `specBranchFor`, `todoBranchPrefix`, `todoBranchFor`, `todoWorktreeDirFor`, `todoWorktreeRelativeDir`, `todoLandMessage`, `isTodoWorktreeKey`, `createTodoGitService`, `findTodoWorktree`, `createTodoWorktree`, `landTodoWorktree`, `removeTodoWorktree`, `unlandedTodos` and the types `TodoWorktreeDeps`, `TodoWorktreeInfo`, `TodoWorktreeError`, `TodoLandOutcome`, `TodoLandRefusal`, `TodoWorktreeRemoval`; all are re-exported from `src/engine/index.ts`.
- Every expected failure of create/land/remove is a returned `Result` error with a named `kind`/`reason`, never a throw.
- `createTodoWorktree` creates `.baiton/worktrees/<slug>/<todoId>/` on `baiton-todo/<slug>/<todoId>` from `baiton/<slug>`'s head, and a repeated call reuses the registered worktree (`reused: true`) without resetting it.
- `landTodoWorktree` refuses in the order wrong-branch → dirty-tree (outside `.baiton/specs/<slug>/` only) → missing-branch, has no base-moved check, aborts a conflicting merge leaving spec head, todo branch and worktree untouched, lands an up-to-date branch as `noop: true`, and after success commits `spec(<slug>): land <todoId>` as a merge commit and removes worktree and branch.
- `unlandedTodos(deps, slug)` returns exactly the todo ids whose `baiton-todo/<slug>/<id>` branch exists, excluding other slugs sharing a prefix.
- `GitWorktreeService` declares and `ShellGitService` implements `commitPaths(paths, message, trailers?)` (commits only the named paths, leaves other staged/unstaged changes alone, appends trailers) and `listBranches(prefix)`; covered by new cases in `test/gitService.test.ts`.
- `asGitError` and `safeRealpath` are exported from `src/engine/runWorktree.ts` with unchanged behaviour; existing `test/runWorktree.test.ts` still passes.
- `test/todoWorktree.test.ts` covers naming, create/reuse, every create and land refusal with precedence, happy-path land, no-op land, conflict, remove idempotence and unlandedTodos against real temp repos.
- `npm run compile`, `npm run lint` and `npm test` all pass.
