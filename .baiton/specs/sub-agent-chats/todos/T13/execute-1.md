# Execute T13

## Summary

Added test/integration.sub-agent-chats.test.ts with two cases over a real temp git repo. The main case has a parent tool loop spawn two sub-agents in one completion, which drive T01 and T02 through plan, execute and review concurrently (per-stage barrier: maxInFlight 2, nothing released alone, six stage launches). It also covers submit_pr refusing before landing, land_todo landing both, a repeated land reporting 'already landed', and submit_pr then failing only at the stub pr-writer probe with nothing pushed. It asserts state commits touch only the spec folder, worktrees and branches are removed, and each todo's journal holds its own three completed entries. The alongside case runs a spec-less bug run and starts a spec draft while a T01 plan is held in flight, and the draft and run still exclude each other. Also pinned the stage-lock contract in integration.run-modes.test.ts (new 'the repository lock' case, isSpecBusy option on makeHarness) and in engine.specDraft.test.ts (stale lock case renamed, new 'not blocked by per-todo stages' case, isQueueRunning harness option). No src/ file changed. compile, lint and the full npm test (2624 passing) are green.

## Files changed

- `test/integration.sub-agent-chats.test.ts`
- `test/integration.run-modes.test.ts`
- `test/engine.specDraft.test.ts`

## Commands run

- `npx mocha test/integration.sub-agent-chats.test.ts (.mocharc spec list means this runs the whole suite)`
- `npm run compile`
- `npm run lint`
- `npm test`

## Notes

- Possible defect, not fixed because no src/ changes were allowed: after both todos reach done and are landed, the main checkout is not git-clean. The tracked per-todo journals .baiton/specs/twin-todos/todos/T01/runs.jsonl and T02/runs.jsonl are modified, because the queue appends each stage's final completion record after the state commit that ends it, and the canonical .baiton/.gitignore pattern 'specs/*/runs.jsonl' does not match todos/<id>/runs.jsonl. land_todo and submit_pr tolerate this since they only reject changes outside the spec folder. The plan asked for status.clean to be true, so both new cases instead assert via assertOnlyJournalsDirty that the only dirty paths are those per-todo journals; any other dirty path still fails. A fix would be to commit the journal after the final completion append, or to ignore todos/*/runs.jsonl.
- An earlier full-suite run had one failure in test/todoWorktree.test.ts ('lists unlanded todos of exactly one slug', 60s timeout). It passed in the two later full runs, so it looks load-related and not caused by these changes.
- The two new tests pass on the first run of the final code. The BarrierFactory fallback (3s, unref'd) did not fire, so releasedAlone is empty.
- mocharc spec is test/**/*.test.ts, so passing a file path to mocha adds to rather than replaces the spec list; every mocha invocation ran the whole suite.
- Three prefer-const eslint-disable comments were needed in the new tests (and one in each of run-modes and specDraft) for late-bound `let x!:` declarations that break construction cycles.
