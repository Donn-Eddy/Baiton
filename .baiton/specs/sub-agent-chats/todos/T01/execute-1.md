# Execute T01

## Summary

Added per-todo worktree primitives in new src/engine/todoWorktree.ts (naming, idempotent create from the spec branch head, find, land with named refusals and preserved branch on conflict, remove, unlandedTodos), plus GitWorktreeService.commitPaths and listBranches implemented in ShellGitService. Exported asGitError/safeRealpath from runWorktree.ts and the new module from the engine barrel. Added temp-repo tests (test/todoWorktree.test.ts, new cases in test/gitService.test.ts). Compile, lint (no new warnings) and all 2479 tests pass.

## Files changed

- `src/engine/todoWorktree.ts`
- `src/engine/runWorktree.ts`
- `src/engine/index.ts`
- `src/git/types.ts`
- `src/git/gitService.ts`
- `test/todoWorktree.test.ts`
- `test/gitService.test.ts`
- `test/runPipeline.test.ts`

## Commands run

- `npm run compile`
- `npm run lint`
- `npm test`

## Notes

- Todo branches use the namespace baiton-todo/<slug>/<todoId> because baiton/<slug>/<id> cannot coexist with the spec branch baiton/<slug> as a git ref.
- commitPaths/listBranches were added to GitWorktreeService (not GitService) to avoid breaking ~13 test files building GitService literals.
- test/runPipeline.test.ts (outside the listed files) got two boom stubs so FakeGit still implements GitWorktreeService.
- commitPaths throws a GitError via a local const to satisfy the no-throw-literal lint rule.
- The remaining lint warning in webviewProtocol.ts is pre-existing.
