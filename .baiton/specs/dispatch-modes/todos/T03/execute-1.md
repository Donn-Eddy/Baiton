# Execute T03

## Summary

Added the worktree and merge primitives to the git service seam. src/git/types.ts gains GitWorktree (one parsed `git worktree list --porcelain` entry) and GitWorktreeService extends GitService declaring addWorktree, listWorktrees, removeWorktree, deleteBranch, branchHead, merge and isClean, with the reads-reject / mutators-reject / merge-returns-Result convention stated in the interface doc comment; every pre-existing type and the whole GitService interface are byte-for-byte unchanged, so the seven-plus test files that build full GitService literals keep compiling. src/git/gitService.ts implements all seven on ShellGitService (now `implements GitWorktreeService`) through the existing runOrThrow/run helpers, widens createGitService's return type to GitWorktreeService, and adds a module-level parseWorktreeList that reads the porcelain records (worktree/HEAD/branch/bare/detached/locked/prunable) preserving git's order. test/gitService.test.ts gains an additive 15-test suite driving real temp repos with worktrees created in sibling scratch dirs.

## Files changed

- `src/git/types.ts`
- `src/git/gitService.ts`
- `test/gitService.test.ts`

## Commands run

- `npm run compile`
- `npm run lint`
- `npm test`
- `git status --porcelain`

## Notes

- npm run compile passes clean. npm run lint reports 0 errors and the single pre-existing warning in src/orchestrator/webviewProtocol.ts:591 ('_legacy' unused), untouched by this todo.
- npm test: 1786 passing, 1 pending, 0 failing — up from 1771 passing, which is exactly the 15 new tests. No existing test file was modified; the only change to test/gitService.test.ts is the new describe block appended inside the existing top-level describe plus the new bullets in the file's top doc comment.
- git status shows exactly the three files of this todo as modified.
- GitService was dropped from gitService.ts's named type imports because nothing in the file refers to it any more (noUnusedLocals is on); the two doc comments that named it now name GitWorktreeService, or drop the link where the sentence reads better without it.
- addWorktree uses `-b` rather than `-B` so a run-id collision fails loudly instead of silently resetting an existing branch; merge uses `--no-ff --no-edit -m <message>` so the message is always recorded, and on a non-zero exit runs `git merge --abort` (ignoring the abort's own exit code, which is non-zero when the merge failed before any merge state existed, e.g. an unknown branch) before returning err(GitError).
- The conflict test asserts the aborted state directly: no .git/MERGE_HEAD remains, README.md still holds main's content, and isClean() is true afterwards.
- listWorktrees reports whatever absolute path git prints, which is the realpath; this is documented on GitWorktree.dir and on parseWorktreeList, and the tests compare against fs.realpathSync(...) rather than the raw input path.
- Tests create worktrees in sibling os.tmpdir() scratch dirs (removed by the suite's own afterEach), never inside the repo, so a worktree's files cannot perturb the repo's own status or isClean(). Gitignoring `.baiton/worktrees/` for the production layout remains another todo's work.
- The unmerged-branch delete test removes the worktree before attempting the delete, since git refuses to delete a branch that is checked out in any worktree — the force path is exercised on the deregistered but unmerged branch.
