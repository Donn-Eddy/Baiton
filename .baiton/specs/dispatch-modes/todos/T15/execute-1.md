# Execute T15

## Summary

Wired the spec-less run pipeline into activation. Added createRunPipelineSeam to the engine facade (fills composerMode from the host, derives explicitMode, copies files, forwards reproduction only when present, maps ok -> started with the manifest branch, busy -> busy, every other refusal -> refused with its message, and guards the completed promise against rejection). In commands.ts: constructed the RunStore and RunPipeline over repoRoot/git/terminalHost/watcherFactory/askWatcherFactory/modelForRole/adapterFor with execAttempts and verify read per call off cfg(); widened the one-stage-per-repository lock in all three directions (the queue's isExternallyBusy, the spec draft's isQueueRunning, and the pipeline's isSpecBusy); made buildToolServices take the seam as a required trailing parameter and passed it at both call sites; added the 'run' entry to toolsByPhase; wired the ChatController's modeMemory (baiton.chat.mode workspaceState key), runs: runPipeline and runPipeline: runPipelineSeam; and added a (run <id>) entry to runningSlugs. Added a createRunPipelineSeam describe block (9 cases) to test/activation.gating.test.ts.

## Files changed

- `src/activation/engineFacade.ts`
- `src/activation/commands.ts`
- `test/activation.gating.test.ts`

## Commands run

- `npx tsc -p . --noEmit`
- `npm run compile`
- `npx mocha test/activation.gating.test.ts`
- `npm run lint`
- `git status --porcelain`
- `grep -n "runPipeline\|runStore\|CHAT_MODE_KEY\|'run'" src/activation/commands.ts`

## Notes

- npx tsc -p . --noEmit and npm run compile: both clean.
- Test suite: 2003 passing / 1 pending / 0 failing (the T14 baseline of 1994 plus the 9 new createRunPipelineSeam cases). The project's mocha config makes the single-file invocation run the whole suite, so no separate npm test run was needed.
- npm run lint: 0 errors, 1 warning — the pre-existing '_legacy' unused variable, now reported at src/orchestrator/webviewProtocol.ts:622 rather than :591 (the plan's line number was stale; same single warning).
- git status --porcelain lists exactly the three files of this todo; no .baiton/runs/ or .baiton/worktrees/ residue, and no commit, stash or branch change.
- RunPipelineDeps.onFinding is deliberately left unbound, as the plan specifies: the ChatController mirrors findings through its runs subscription.
- The pipeline block sits immediately after createVscodeResultWatcherFactory() — after git, terminalHost and adapterFor, and before queueForSlug and the first buildToolServices call. Its isSpecBusy references queues and specDraftRunner only inside a lazily-invoked arrow, matching the existing isExternallyBusy precedent, so there is no TDZ hazard at activation.
- Both composerMode and the ChatController's modeMemory read/write the single CHAT_MODE_KEY constant; no settings.json key was introduced and package.json was not touched.
