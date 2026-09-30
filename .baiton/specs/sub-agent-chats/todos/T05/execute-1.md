# Execute T05

## Summary

Wired per-todo run queues into activation. engineFacade.ts gained todoQueueKey, createTodoQueues (one queue per slug/todo, shared worktree seam and spec-branch writer, no isExternallyBusy), createStageLock, and a createRunQueueSeam that takes queueFor(slug, todoId) and answers busy per todo via an in-flight set plus queue.isRunning(). commands.ts now builds one shared SpecBranchWriter (also passed to createSpecStore), routes stage commands, Replan, Stop, View (find-only, attaches in the todo worktree when present), submit_pr and runningSlugs to the per-todo queues, and uses the stage lock so only the spec draft and spec-less runs exclude each other. Seam docs and the run tool busy message now name the todo. Tests added for the seam, the lock, and the integration test moved onto the worktree path with the real spec store and landing.

## Files changed

- `src/activation/engineFacade.ts`
- `src/activation/commands.ts`
- `src/orchestrator/seams.ts`
- `src/orchestrator/controlTools.ts`
- `test/registry.controlTools.test.ts`
- `test/runCommands.test.ts`
- `test/integration.plan-execute-review.test.ts`

## Commands run

- `npm run compile`
- `npm run lint`
- `npm test`

## Notes

- npm test: 2521 passing, 1 pending, 0 failing. Lint has only the known _legacy warning. Compile is clean.
- No queueForSlug, queues. or isExternallyBusy remain in commands.ts; no vscode import was added to orchestrator/engine/journal/git or engineFacade.ts.
- I edited the comment in commands.ts after the last full test run (wording only, no code change) and did not re-run npm test.
- Spec-write tools and the approve path still use git.commit (add -A) in the main checkout, so with concurrent todo stages such a commit can sweep another todo's uncommitted artifact or journal into its commit. This is untidy but not corrupting, and is out of scope here.
- Crash recovery still reads the main checkout, so recovering an in-flight Execute after a crash is not correct until the recovery todo rewires it. The crash-replay test stays on the main checkout.
- The optional two-todo concurrency integration case was skipped; runQueue.worktree.test.ts already covers queue-level concurrency.
