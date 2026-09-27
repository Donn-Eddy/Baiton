# Execute T08

## Summary

Completed T08 by extending the investigate path already laid down by T07 rather than rewriting it. Added the host-facing `RunFinding` payload (runId, mode, question, questionFiles, finding, files, nextSteps, findingPath, answered manifest) and an optional `finding` field on `RunPipelineOutcome`; added the optional `RunPipelineDeps.onFinding` sink. `driveInvestigate` now builds the full payload after `finishRun` marks the manifest `answered`, calls the sink inside a try/catch that reports a throw through `deps.report` and returns `{ ...outcome, finding }`, so the same object reaches the `completed` promise, `onComplete` and the `{ kind: 'completed' }` event. `runStage` no longer calls `head()`/`currentBranch()` on the main checkout for an investigate stage: the journal's drift anchors come from `manifest.baseHead`/`manifest.baseBranch`, so a read-only run touches git only in `start()`; every build stage is byte-for-byte unchanged. Tests: FakeGit gained `headCalls`/`currentBranchCalls` counters, the harness gained `findings` and `createServiceCalls()`, the existing investigate case was extended (no git service, no git calls after start, no worktree cleanup, rendered finding.md shape, no .baiton/specs, the journal pair with startHead == baseHead), and five new cases cover the sink payload and its three delivery points, the sink-before-onComplete ordering observed from inside the sink, cancel, close-without-result, and a throwing sink.

## Files changed

- `src/engine/runPipeline.ts`
- `test/runPipeline.test.ts`

## Commands run

- `grep -n 'baseHead\|baseBranch' src/engine/runStore.ts`
- `grep -rn '# Finding' src/`
- `npm run compile`
- `npx mocha test/runPipeline.test.ts`
- `npm run lint`
- `git status --porcelain`

## Notes

- Deviation from plan step 5, taking the alternative the plan's own Risks section sanctions: the manifest is read with `this.deps.store.read(runId)` instead of `this.freshManifest(runId)`. `freshManifest` throws when the manifest cannot be read, and that throw would land in `drive`'s try/catch and turn an answered run into a failed one. On a failed read the sink is now skipped with a `report` line and the outcome is returned unchanged.
- Deviation from plan step 8: the journal is read with `parseJournal(path.join(...))` — `parseJournal` takes a path, not file contents, which is also how every existing case in this file calls it.
- The ordering assertion is not vacuous: besides `h.outcomes[0].finding === h.findings[0]`, a bespoke-pipeline case pushes markers from both callbacks (asserting `['onFinding', 'onComplete']`) and, from inside the sink, records that `finding.md` already existed and `f.manifest.state === 'answered'`.
- The investigate journal's `startHead` is now the manifest's recorded base head rather than a live HEAD read; the new journal assertion pins it explicitly, as the plan's risk note asked.
- npx mocha on the single test path picks up the project's mocha config and runs the whole suite: 1879 passing / 1 pending / 0 failing, i.e. the T07 baseline of 1874 plus the 5 new cases, with no existing assertion weakened or removed.
- `npm run lint` reports only the pre-existing `_legacy` warning at src/orchestrator/webviewProtocol.ts:591; `git status --porcelain` lists exactly the two modified files with no .baiton/runs or .baiton/worktrees residue.
- No barrel edit was needed — `src/engine/index.ts` already re-exports `./runPipeline` — and no file outside the two named was touched.
