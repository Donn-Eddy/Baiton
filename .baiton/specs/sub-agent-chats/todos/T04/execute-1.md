# Execute T04

## Summary

The run queue now supports per-(slug, todo) operation with every stage running in the todo's worktree. Compile, lint and the full suite pass (2515 passing, 1 pending). Lint shows only the known `_legacy` warning. Every new dep is optional, so existing wiring in src/activation/commands.ts is untouched and behaves as before. New RunQueueDeps: slug, todoId, worktrees (QueueWorktreeSeam) and specWriter. Also exported: TodoStageWorkspace, QueueWorktreeSeam and createQueueWorktreeSeam. runOne now checks identity, then spec guards (including the new deps-unlanded Plan refusal), then ensures the worktree, then tree guards against the worktree git. The launch cwd, HEAD/branch, drift check, execute commit, post-run reset and session-id discovery all use the worktree. Artifacts and state stay central. Journal appends go through specWriter.apply when provided. LiveRun gains worktreeDir. I extended the existing queue suites with worktree-mode cases and added test/runQueue.worktree.test.ts, a real temp-repo suite with the two-todo concurrency test.

## Files changed

- `src/engine/runQueue.ts`
- `src/engine/launcher.ts`
- `src/engine/resultFlow.ts`
- `test/runQueue.worktree.test.ts`
- `test/runQueue.serialization.property.test.ts`
- `test/runQueue.approvalGate.property.test.ts`
- `test/runQueue.attemptCount.property.test.ts`
- `test/runQueue.revert.property.test.ts`
- `test/runQueue.briefContext.test.ts`

## Commands run

- `npm run compile`
- `npm run lint`
- `npm test`
- `npx tsc --noEmit -p .`
- `npx mocha --spec test/runQueue.worktree.test.ts -g "per-todo worktrees"`

## Notes

- The mocha config runs the whole suite on every invocation, so single-file runs still take about a minute.
- In the approvalGate deps-unlanded property, the launch branch calls queue.stop() and leaves the dispatch promise pending. The fake terminal there has no close path, so awaiting it would hang.
- The mid-run identity check, the deps-unlanded guard and worktree creation are all inactive until src/activation/commands.ts is rewired in a later todo. Crash recovery still inspects the main checkout with a journaled startHead, which in worktree mode is a todo-branch commit. That is left for the wiring/recovery todo.
- Real-repo tests require .baiton/.gitignore (with /runs/ and /worktrees/) to be committed on the spec branch. The new suite does this.
- The new suite's tick() and until() polling helpers wait on real git calls (about 2s total for the 5 cases).
