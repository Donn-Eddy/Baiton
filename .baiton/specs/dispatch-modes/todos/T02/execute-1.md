# Execute T02

## Summary

Added the run manifest store for spec-less runs: src/engine/runStore.ts holds the manifest vocabulary (RunState/RUN_STATES/isRunState/isRunComplete, RunStage/RUN_STAGES/isRunStage, RunAttempts, RunOutcomeRecord, RUN_MANIFEST_VERSION, RunManifest, RunStoreError), the path/branch/run-id helpers (runsRootDir, runDirFor, runManifestPathFor, runJournalPathFor, runWorktreeDirFor, runBranchFor, isRunId, newRunId), launch-id composition and parsing (launchIdFor, ParsedLaunchId, parseLaunchId, isRunLaunchDirName), the fs-free parseRunManifest/serializeRunManifest pair, the RunStore class (manifestPath/dirFor/worktreeDirFor/exists/create/read/update/bumpAttempt/list with a private atomic writeManifest) plus createRunStore, and the run-dir artifact writer (runArtifactFileName, runArtifactPathFor, RunArtifactTarget, runArtifactWriter). The module is exported from the src/engine/index.ts barrel and covered by a new test/runStore.test.ts (35 cases). compile, lint and the full test suite are clean.

## Files changed

- `src/engine/runStore.ts`
- `src/engine/index.ts`
- `test/runStore.test.ts`

## Commands run

- `npm run compile`
- `npm run lint`
- `npm test`
- `npx mocha test/runStore.test.ts`
- `git status --porcelain`

## Notes

- Deviation from the plan, step 6: the plan specified path.basename(persistencePathForStage(stage, '', attempt)), but an empty todo id makes that function THROW for plan/execute/review (todoArtifactDir rejects a todoId that fails /^[A-Za-z0-9._-]+$/, and '' does). runArtifactFileName therefore passes a private placeholder segment RUN_ARTIFACT_TODO_ID = '_' instead; only the basename is used, so the naming rule still lives solely in persistencePathForStage, and a numbered stage given no attempt still throws through its own requireIndex (pinned by a test).
- Deviation from the plan, step 5: list() also skips any directory whose name fails isRunId (e.g. a dotted foreign directory that is not a launch id), in addition to launch dirs, missing run.json and unparseable manifests. Same intent — the Runs view cannot be broken by a foreign directory.
- writeManifest imports rmSync for the best-effort temp cleanup after a failed rename (the plan said 'remove the temp file best-effort' without naming the call); the import list otherwise matches the plan, plus `type Dirent` because `ReturnType<typeof readdirSync>` resolves to the Buffer overload under this @types/node and fails to compile.
- update() clears completedAt when a patch moves the run back to an active state, as the plan's step 5 specifies, and keeps the first stamp on every later complete-state update.
- No export name collides in the engine barrel: the outcome type is RunOutcomeRecord (resultFlow owns RunOutcome), the creation input is NewRunInput (runQueue owns RunRequest), and the clock is injected as a plain `now?: () => string` (runQueue owns Clock). npm run compile confirms.
- Verification: npm run compile clean; npm run lint reports only the pre-existing warning at src/orchestrator/webviewProtocol.ts:591 ('_legacy' assigned but never used); npm test 1771 passing / 1 pending / 0 failing, confirmed over five full runs. One intermediate full run earlier in the session reported 1770 passing / 1 failing; the failing test's name was not captured and it did not reproduce in any of the five subsequent runs, so it looks like a pre-existing timing flake unrelated to this todo (nothing in runStore.ts is used by any existing code path yet).
- No existing test file was modified; the working tree shows exactly `M src/engine/index.ts`, `?? src/engine/runStore.ts`, `?? test/runStore.test.ts`.
