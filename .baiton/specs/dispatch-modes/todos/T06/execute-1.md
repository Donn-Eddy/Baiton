# Execute T06

## Summary

Implemented T06, the run worktree lifecycle. Added `/worktrees/` to GITIGNORE_CONTENTS (anchored, directly after `/runs/`) with matching doc-comment updates. Created src/engine/runWorktree.ts, a host-free module (no vscode, sync fs) that composes GitWorktreeService's worktree/merge primitives into createRunWorktree, mergeRunWorktree and removeRunWorktree, plus findRunWorktree, createRunGitService, runMergeMessage, runWorktreeRelativeDir, runWorktreesRootDir and RUN_WORKTREES_DIR — every expected failure a returned Result, never a throw. createRunWorktree creates .baiton/worktrees/<run-id>/ on baiton/<mode>/<run-id> at the current branch's head and refuses invalid-id, exists, detached-head, no-base-head, git and io. mergeRunWorktree runs in the main checkout with the pinned refusal order wrong-branch -> base-moved -> dirty-tree -> missing-branch -> merge, reports a conflicting merge as `conflict` with the tree left clean, and on success makes a --no-ff merge commit carrying a `Run-Id:` trailer then cleans up, folding cleanup problems into `cleanup` warnings rather than failing. removeRunWorktree deregisters, deletes a leftover directory, optionally force-deletes the branch, and is idempotent. Exported the module from the engine barrel. Added test/runWorktree.test.ts (25 cases against real temp repos) and an additive GITIGNORE_CONTENTS block plus one refreshGitignore case in test/config.gitignore.test.ts.

## Files changed

- `src/config/gitignore.ts`
- `src/engine/runWorktree.ts`
- `src/engine/index.ts`
- `test/runWorktree.test.ts`
- `test/config.gitignore.test.ts`

## Commands run

- `npm run compile`
- `npx mocha test/runWorktree.test.ts test/config.gitignore.test.ts`
- `npx mocha test/runWorktree.test.ts`
- `npm run lint`
- `npm test`
- `git status --porcelain`

## Notes

- npm run compile is clean. npm run lint reports only the pre-existing warning at src/orchestrator/webviewProtocol.ts:591 ('_legacy' assigned but never used). npm test is 1855 passing / 1 pending / 0 failing.
- Plan step 10 predicted a 1786-passing baseline plus the new cases; the actual tree's baseline is 1825, so 1855 = 1825 + 25 new runWorktree cases + 5 new gitignore cases. No previously passing test was modified other than the additive edits to test/config.gitignore.test.ts (its four original refreshGitignore tests are byte-for-byte unchanged).
- git status --porcelain shows exactly the five files of this todo and no .baiton/worktrees/ residue: every test worktree is created inside its own temp repo.
- Deviation from plan step 8 case 7: the `base-moved` refusal with `actual: undefined` cannot be reached from a real repository, because the check only runs once the base branch is the checked-out one, and a checked-out branch always resolves — an unborn/orphan branch makes `currentBranch()` (rev-parse --abbrev-ref HEAD) exit non-zero, which lands in `reason: 'git'` instead. That case is therefore covered with a stubbed GitWorktreeService (currentBranch/branchHead/status only), while the advanced-base case uses a real repo. The `base-moved` wording branch for a deleted base is asserted through it.
- createRunWorktree tolerates a pre-existing empty worktree directory (git accepts one); that is covered by its own test. The run-id/branch collision test removes the populated directory first so the failure is genuinely git's `worktree add -b` branch collision rather than the earlier `exists` check.
- RunWorktreeDeps.createService is declared per the plan but not yet consumed inside the module; createRunGitService takes its factory as a defaulted parameter instead, which is what the tests exercise.
