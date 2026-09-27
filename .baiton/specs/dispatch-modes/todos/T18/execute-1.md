# Execute T18

## Summary

Added test/integration.run-modes.test.ts, the single offline end-to-end test of the spec-less run pipeline over real temporary git repositories with only the agent boundary (adapter, terminal, result watcher) stubbed: a confirmed Bug run creates baiton/bug/<run-id> and .baiton/worktrees/<run-id>/, plans/executes/reviews under <run-id>.<stage>.1 launch ids whose briefs live in the worktree, lands one commit with a Run-Id trailer findable by findCommitByRunId, writes run.json/runs.jsonl/plan.md/execute-1.md/review-1.md in the main checkout and never creates .baiton/specs/; a declined confirm card driven through the real tool registry over the real createRunPipelineSeam writes and dispatches nothing (with an approved positive control); mergeRunWorktree lands a real merge commit and removes the worktree and branch, and refuses base-moved and dirty-tree leaving everything in place; cancel keeps the worktree and branch; an investigate run commits nothing and yields a finding. No other file was touched.

## Files changed

- `test/integration.run-modes.test.ts`

## Commands run

- `npx tsc -p . --noEmit`
- `npm run compile`
- `npx mocha`
- `npm run lint`
- `git status --porcelain`
- `git diff -- test/integration.plan-execute-review.test.ts`

## Notes

- npx tsc -p . --noEmit and npm run compile are silent; npm run lint reports 0 errors and only the pre-existing _legacy warning in src/orchestrator/webviewProtocol.ts.
- Full suite: 2028 passing, 1 pending, 0 failing — the post-T17 baseline of 2020 grown by exactly the 8 new cases. The .mocharc spec glob means a single-file invocation runs the whole suite, so test/integration.plan-execute-review.test.ts was exercised too and is byte-for-byte unchanged (empty git diff).
- git status --porcelain lists only '?? test/integration.run-modes.test.ts' — no .baiton/runs/ or .baiton/worktrees/ residue, since every case works inside its own fs.mkdtempSync repo that afterEach removes.
- createService is deliberately NOT injected into createRunPipeline, so the real createRunGitService/createGitService path into the worktree is exercised.
- The approved half of the confirm case waits for the plan watcher, cancels, drives the watcher's close path and waits for isRunning() to go false, so no pending stage or live terminal leaks into the next test.
- finishedBugRun takes only the harness (the repo is reachable through it) and returns the manifest's own baseBranch/baseHead/statement, so no merge call uses a hard-coded sha.
