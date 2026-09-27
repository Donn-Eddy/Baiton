# Execute T07

## Summary

Implemented the spec-less run pipeline: new host-free src/engine/runPipeline.ts exporting createRunPipeline, ROLE_FOR_RUN_STAGE, DEFAULT_EXEC_ATTEMPTS, runExecuteCommitMessage, RUN_ID_TRAILER and the RunPipeline* / LiveRunStage types. start() refuses invalid-mode, busy (own run or isSpecBusy), detached-head, no-base-head, manifest and worktree in that order, writes the manifest through the injected RunStore before creating .baiton/worktrees/<run-id>/ (no worktree for investigate), then drives plan -> execute -> review in the worktree with findings looping back to execute up to execAttempts, or one read-only investigate stage from the main checkout ending in a finding. Each stage bumps the attempt counter, probes the role's adapter, builds its brief with buildRunContext, launches under launch id <run-id>.<stage>.<n> with cwd set to the worktree, journals start/completion to .baiton/runs/<run-id>/runs.jsonl keyed by launch id with the run id as todoId, and persists its artifact into the main checkout's run directory via runArtifactWriter (nothing under .baiton/specs/). A completed execute is drift-checked against the worktree's own git service and then committed there with message <mode>(<run-id>): execute attempt <n> and a Run-Id: <run-id> trailer; a drift halts the run failed with the git_state_changed message and no commit. cancel() disposes the in-flight terminal and leaves the worktree and branch on disk, and is also observed between stages. Change events (started, stage-started/stage-completed, completed) are emitted through onChange with a throwing listener isolated. runQueue.ts's isExternallyBusy doc and the runOne comment now name the run pipeline alongside the spec draft (no behaviour change), and the engine barrel re-exports the module.

## Files changed

- `src/engine/runPipeline.ts`
- `src/engine/runQueue.ts`
- `src/engine/index.ts`
- `test/runPipeline.test.ts`

## Commands run

- `npm run compile`
- `npx tsc -p . --noEmit`
- `npx mocha test/runPipeline.test.ts`
- `npm run lint`
- `npm test`
- `git status --porcelain`

## Notes

- npm run compile and npx tsc -p . --noEmit are clean; npm run lint reports only the pre-existing warning '_legacy' is assigned a value but never used at src/orchestrator/webviewProtocol.ts:591; npm test passes with 1874 passing, 1 pending, 0 failing (the 1855 baseline plus the 19 new cases). No existing test file was modified.
- git status --porcelain shows exactly the four files of this todo; the tests work in their own fs.mkdtempSync directories, so no .baiton/runs or .baiton/worktrees residue is left in the repo.
- test/runPipeline.test.ts covers the bug happy path (launch ids, worktree cwd, brief sections, artifacts in the main checkout, no .baiton/specs, manifest/attempts/completedAt, the worktree-service commit with its trailer, and the journal pairs), the findings loop plus the exec_attempts ceiling, the quick/refactor framing, investigate (no worktree, no commit, finding.md, answered), every refusal, unknown agent / probe failure, a stage closing without a result, cancel, the execute drift check, the change events, and one real-temp-git-repo end-to-end case asserting the run branch, the Run-Id commit found by findCommitByRunId, and an untouched main.
- Two deviations from the plan's letter, both to keep the code compiling and the tests reliable: (1) the module imports only what it uses (no `existsSync`, `path`, `launchIdFor`, `runWorktreeDirFor` or `ReviewResult`), since unused imports fail lint and the plan's import list was written before the bodies; (2) instead of the plan's bare `journalCompletion` flag alone, runStage returns its launch id and drift anchors and driveBuild journals the execute completion itself with its commit — as the plan's step 10 describes.
- The polling helper in the test waits on a real 2ms timer rather than setImmediate: a setImmediate spin outran the real `git` child processes in the end-to-end case and reported a missing watcher.
- Nothing outside the four files was touched; no commit, stash or branch change was made.
