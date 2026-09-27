# Plan T08

## Steps

1. Read the current investigate path before changing anything

   Everything this todo needs already half-exists in `src/engine/runPipeline.ts` (written by T07). Read these members first: the module header comment (lines ~1-36), `ROLE_FOR_RUN_STAGE` (investigate -> 'reviewer'), `RunPipelineOutcome`, `RunPipelineDeps`, `DefaultRunPipeline.start` (step 5 skips the worktree when `req.mode === 'investigate'`), `drive`, `driveInvestigate`, `runStage`, `finishRun` and `finishNonCompleted`. What is ALREADY done and must not be re-implemented or regressed: no worktree is created for investigate; the launch has no `cwd` so it runs from the main checkout; the stage runs as the `reviewer` role under launch id `<run-id>.investigate.1`; the artifact is written to `.baiton/runs/<run-id>/finding.md` through `runArtifactWriter`; the manifest ends `answered` with `outcome = { kind: 'finding', finding }`; `commits` is empty. What is MISSING and is this todo's work: (a) the finding is handed to no dedicated completion sink — only the one-line `finding` string reaches `onComplete`, while `files` and `next_steps` from the validated `InvestigateResult` are dropped, so the chat cannot build its promote card; (b) `runStage` still calls `git.head()`/`git.currentBranch()` on the MAIN checkout for the drift anchors even on the investigate path, which contradicts the read-only guarantee; (c) there is one investigate test, covering neither the sink nor the failure/cancel paths. Do not touch `src/engine/runStore.ts`, `src/engine/runContext.ts`, `src/engine/runWorktree.ts` or any other file: the manifest schema, the brief and the renderer are already correct.

   Files: `src/engine/runPipeline.ts`, `test/runPipeline.test.ts`

2. Add the RunFinding payload type

   In `src/engine/runPipeline.ts`, directly after the `RunPipelineOutcome` interface, add the exported payload the completion sink receives:

   ```ts
   /**
    * The result of an `investigate` run, handed to the completion sink and
    * carried on the run's outcome. It is deliberately richer than the manifest's
    * `{ kind: 'finding', finding }` record: the chat's promote card (Bug / Quick /
    * dismiss) needs the files and next steps as well as the one-line finding, and
    * re-reading `finding.md` to recover them would parse prose back into data.
    */
   export interface RunFinding {
     runId: string;
     /** Always 'investigate'; carried so a sink can switch on the mode alone. */
     mode: RunMode;
     /** The question the run was dispatched with (`manifest.statement`). */
     question: string;
     /** The files the dispatch named (`manifest.files`). */
     questionFiles: string[];
     /** The investigator's one-line finding. */
     finding: string;
     /** The files the investigator found the answer in. */
     files: string[];
     /** What the investigator suggests doing next. */
     nextSteps: string[];
     /** Repository-relative path of the rendered artifact: `.baiton/runs/<run-id>/finding.md`. */
     findingPath: string;
     /** The manifest as it stands once the run is `answered`. */
     manifest: RunManifest;
   }
   ```

   Note the camelCase `nextSteps`: `InvestigateResult.next_steps` is snake_case because it is a wire schema, and this is a host-facing type. No barrel edit is needed — `src/engine/index.ts` already does `export * from './runPipeline'`.

   Files: `src/engine/runPipeline.ts`

3. Carry the finding on RunPipelineOutcome

   Add one optional field to the existing `RunPipelineOutcome` interface, after `message`:

   ```ts
     /**
      * Present exactly when an `investigate` run completed (`state: 'answered'`).
      * Every other ending, including a cancelled or failed investigate, leaves it
      * undefined.
      */
     finding?: RunFinding;
   ```

   It must stay optional so no existing construction site breaks. `finishRun` keeps its current signature and never sets it; `driveInvestigate` attaches it to the object `finishRun` returns (step 5), which is the same object `drive` hands to `onComplete` and puts on the `completed` event, so the field reaches all three consumers (`completed` promise, `onComplete`, `{ kind: 'completed' }` event) with no further plumbing.

   Files: `src/engine/runPipeline.ts`

4. Add the onFinding dependency

   In `RunPipelineDeps`, immediately after `onComplete`, add:

   ```ts
     /**
      * The finding sink: called exactly once per `investigate` run that completed,
      * after the manifest is `answered` and `finding.md` exists on disk, and
      * BEFORE `onComplete`. A cancelled, failed or non-completed investigate run
      * never calls it. This is what the chat subscribes to in order to post the
      * promote card; a throwing sink is swallowed (and reported through `report`)
      * so a host failure can never turn an answered run into a failed one.
      */
     onFinding?: (finding: RunFinding) => void;
   ```

   The only production construction site is not written yet (a grep for `createRunPipeline` outside the module finds only `test/runPipeline.test.ts` and a doc comment in `src/engine/runQueue.ts`), so an optional dep is a pure addition.

   Files: `src/engine/runPipeline.ts`

5. Build the finding and hand it to the sink in driveInvestigate

   Replace the tail of `driveInvestigate` (everything from `const finding = (result.outcome.structured as InvestigateResult).finding;`) with the full payload build. The cast is safe: `awaitStageResult` resolves `completed` only for a `result.json` that validated against `investigateSchema`, so `finding` is a non-empty string and `files`/`next_steps` are string arrays.

   ```ts
       const investigated = result.outcome.structured as InvestigateResult;
       const outcome = this.finishRun(
         runId,
         mode,
         'answered',
         { kind: 'finding', finding: investigated.finding },
         'investigation answered',
       );

       // The manifest is read back AFTER finishRun, so the sink sees the run in
       // its terminal `answered` state with its outcome and completedAt stamped.
       const manifest = this.freshManifest(runId);
       const finding: RunFinding = {
         runId,
         mode,
         question: manifest.statement,
         questionFiles: [...manifest.files],
         finding: investigated.finding,
         files: [...investigated.files],
         nextSteps: [...investigated.next_steps],
         findingPath: `.baiton/runs/${runId}/finding.md`,
         manifest,
       };
       try {
         this.deps.onFinding?.(finding);
       } catch (e) {
         // A host sink's failure is not the run's failure: the finding is on disk
         // and the manifest is answered either way.
         this.deps.report?.(`the finding sink threw: ${describe(e)}`);
       }
       return { ...outcome, finding };
   ```

   Keep the two earlier guards in `driveInvestigate` exactly as they are — `!result.ok` -> `finishRun(..., 'failed', ...)`, and `result.outcome.kind !== 'completed'` -> `this.finishNonCompleted(runId, mode, result.outcome, 'investigate')` — so a cancelled investigate still ends `cancelled` with the message `run cancelled during investigate` and a closed one `failed` with `the investigate stage closed without a result`, neither of them reaching the sink. Do not derive `findingPath` with `path.join`: it is a repository-RELATIVE, forward-slash path for the host to show and open, matching how `manifest.worktreeDir` stores `.baiton/worktrees/<run-id>`. (`runArtifactPathFor(workspaceRoot, runId, 'investigate')` is the absolute twin and stays in use by `readRunArtifact` only.)

   Files: `src/engine/runPipeline.ts`

6. Make the investigate stage touch git zero times after start()

   In `runStage`, step 4 currently reads:

   ```ts
       const git = input.runGit ?? this.deps.git;
       const startHead = await safeHead(git);
       const startBranch = await safeBranch(git);
   ```

   For `investigate` there is no `runGit`, so this calls `head()`/`currentBranch()` on the MAIN checkout — a git call on a path that is meant never to touch git, and anchors that are never used, because `driveInvestigate` performs no drift check. Replace with:

   ```ts
       // A read-only investigate run touches git exactly once, in `start()`, to
       // record the base branch and head in the manifest. It has no worktree, no
       // commit and no drift check, so the journal's anchors come from the
       // manifest rather than from a fresh git call.
       let startHead: string;
       let startBranch: string;
       if (stage === 'investigate') {
         startHead = manifest.baseHead;
         startBranch = manifest.baseBranch;
       } else {
         const git = input.runGit ?? this.deps.git;
         startHead = await safeHead(git);
         startBranch = await safeBranch(git);
       }
   ```

   (`manifest` is already destructured from `bumped.value` at the top of `runStage`; confirm `RunManifest` really names the fields `baseHead` and `baseBranch` before writing this — `grep -n 'baseHead\|baseBranch' src/engine/runStore.ts`.) Every build stage keeps its current behaviour byte for byte, so the T07 drift tests are unaffected. Also extend the module header comment: in the bullet that already says an `investigate` launch has no `cwd`, add that such a run touches git only in `start()` and reports its finding through the `onFinding` sink.

   Files: `src/engine/runPipeline.ts`

7. Extend the test harness with the new observation points

   In `test/runPipeline.test.ts`, three small additive changes to existing scaffolding (do not weaken or remove any existing assertion):

   1. `FakeGit`: add `public headCalls = 0;` and `public currentBranchCalls = 0;` and increment them at the top of `head()` and `currentBranch()` respectively (in `currentBranch`, increment BEFORE the `currentBranchThrows` check so a throwing call is still counted).
   2. `makeHarness`: add `const findings: RunFinding[] = [];` and `let createServiceCalls = 0;`, pass `onFinding: (f) => findings.push(f)` into `createRunPipeline`, and change `createService` to `() => { createServiceCalls += 1; return worktreeGit; }`. Expose `findings` and `createServiceCalls: () => createServiceCalls` on the returned harness and add both to the `Harness` interface (`findings: RunFinding[]; createServiceCalls(): number;`).
   3. Import `type RunFinding` from `../src/engine/runPipeline` in the existing import block.

   Files: `test/runPipeline.test.ts`

8. Extend the investigate test case and add the new ones

   Work inside the existing `describe('an investigate run', ...)` block; keep its current `it` and its assertions intact, adding to it and adding siblings.

   In the existing `it('runs one read-only stage from the main checkout and ends answered')`, append:
   - `assert.strictEqual(h.createServiceCalls(), 0, 'no run-scoped git service is created')`.
   - Capture `const headCallsAtStart = h.mainGit.headCalls; const branchCallsAtStart = h.mainGit.currentBranchCalls;` right after `await h.pipeline.start(...)` resolves, and after `await started.completed` assert both counters are unchanged — the run touches git only in `start()`.
   - `assert.deepStrictEqual(h.mainGit.removeWorktreeCalls, []); assert.deepStrictEqual(h.mainGit.deleteBranchCalls, []);` (`diff` and `findCommitByRunId` already throw through `boom`, so the absence of a diff is enforced by the fake).
   - Read `finding.md` and assert its rendered shape: it contains `'# Finding '`, the finding sentence, `'## Files'`, `` '`src/b.ts`' `` and `'## Next steps'`.
   - Assert `!fs.existsSync(path.join(h.root, '.baiton', 'specs'))`.
   - Assert the journal: `parseJournal(fs.readFileSync(path.join(h.runDir(runId), 'runs.jsonl'), 'utf8'))` yields exactly one start/one completion for `runId: `${runId}.investigate.1``, `todoId: runId`, `stage: 'investigate'`, `attempt: 1`, `result: 'completed'` (mirror how the bug happy-path case in this file reads the journal).

   New sibling cases:
   - `it('hands the whole finding to the completion sink')`: after settling `INVESTIGATE_RESULT`, assert `h.findings.length === 1` and deep-equal its `runId`, `mode: 'investigate'`, `question: 'where is the bound computed?'`, `questionFiles: ['src/a.ts']`, `finding`, `files: ['src/a.ts','src/b.ts']`, `nextSteps: ['unify the two computations']`, `findingPath: `.baiton/runs/${runId}/finding.md``, and `manifest.state === 'answered'`. Assert the same payload is on `(await started.completed).finding` and on the `{ kind: 'completed' }` event in `h.events`. Assert ordering: the sink ran before `onComplete` — push a marker into a shared array from both callbacks, or simply assert `h.outcomes[0].finding === h.findings[0]` plus that `finding.md` already existed when the sink fired (capture `fs.existsSync` inside the `onFinding` callback via a local harness built with `createRunPipeline` directly, as the file's last describe already does for the real-git case; the simpler identity assertion is enough if a bespoke harness feels heavy).
   - `it('never calls the sink when the investigate stage is cancelled')`: start an investigate run, `await h.waitForWatcher(0)`, `h.pipeline.cancel()`, `await h.close(0, undefined)`, then assert the outcome is `{ state: 'cancelled', outcome: { kind: 'cancelled' } }`, `outcome.finding === undefined`, `h.findings.length === 0`, the manifest state is `cancelled`, and `finding.md` does not exist.
   - `it('fails the run when the investigate stage closes without a result')`: `await h.close(0, 3)`, assert `state === 'failed'`, the message matches `/investigate stage closed without a result \(exit 3\)/`, `h.findings.length === 0`.
   - `it('keeps the run answered when the finding sink throws')`: build the pipeline with an `onFinding` that throws, settle `INVESTIGATE_RESULT`, assert the outcome is still `answered` with its `finding` attached, the manifest is `answered`, and the throw surfaced through `report` (`assert.match(h.reports.join('\n'), /finding sink threw/)`). Build this one with `createRunPipeline` directly, in the style of the file's existing bespoke-pipeline case, rather than adding an option to `makeHarness`.

   Every new case must `track(...)` its harness so the `afterEach` removes the temp root.

   Files: `test/runPipeline.test.ts`

9. Verify

   Run, in order: `npm run compile`, `npx mocha test/runPipeline.test.ts`, `npm run lint`, `npm test`, `git status --porcelain`. Expectations: compile clean; lint reports only the one pre-existing warning (`'_legacy' is assigned a value but never used` at `src/orchestrator/webviewProtocol.ts:591`); `npm test` shows the T07 baseline of 1874 passing / 1 pending / 0 failing plus the new cases, with 0 failing and no pre-existing assertion modified; `git status --porcelain` shows exactly `M src/engine/runPipeline.ts` and `M test/runPipeline.test.ts` and no stray `.baiton/runs` or `.baiton/worktrees` residue in the repository (the tests work in `fs.mkdtempSync` roots).

   Files: `src/engine/runPipeline.ts`, `test/runPipeline.test.ts`

## Risks

- Most of this todo's surface was already delivered by T07; the real work is the completion sink, the git-free investigate stage and the test coverage. Re-writing the investigate path from scratch would churn passing code and risk regressing the existing `an investigate run` case — extend, do not rewrite.
- `RunPipelineOutcome.finding` must be optional. Making it required, or adding it to `finishRun`'s signature, breaks every build-path construction site and several T07 assertions that deep-compare outcomes.
- Naming: `RunFinding.finding` (the string) sits inside `RunFinding` (the payload), and `RunOutcomeRecord` already has a `{ kind: 'finding'; finding: string }` arm. Keep the manifest record exactly as it is — `src/engine/runStore.ts`'s `parseOutcome` validates that shape and its tests pin it; the richer payload is host-facing only and is never persisted.
- The `structured as InvestigateResult` cast is only sound because `awaitStageResult` validated the result against `investigateSchema` before resolving `completed`. Do not move the payload build to a path that can see an unvalidated result, and do not add a redundant runtime re-validation.
- Reading the manifest with `freshManifest(runId)` after `finishRun` is deliberate — the sink must see `state: 'answered'`. Note `freshManifest` THROWS when the manifest cannot be read; that throw lands inside `drive`'s try/catch and would turn an answered run into a failed one. Passing the fallback (`this.freshManifest(runId, /* fallback */ manifestFromEarlier)`) is not available here because `driveInvestigate` holds no manifest copy; if that worries the executor, read the manifest through `this.deps.store.read(runId)` and skip the sink (reporting through `report`) when it is not ok, rather than letting the throw escape.
- Swapping the investigate drift anchors to `manifest.baseHead`/`manifest.baseBranch` changes the journal's `startHead` for investigate runs from the live HEAD to the recorded base head. For a read-only run these are the same commit unless the user commits mid-investigation; the recorded base is the more honest anchor, but assert it explicitly in the journal test so the change is visible.
- The ordering assertion (sink before `onComplete`) is easy to write in a way that passes vacuously. Prefer the identity check `h.outcomes[0].finding === h.findings[0]` plus an explicit `fs.existsSync(finding.md)` observed from inside the sink over a comment claiming the order.

## Acceptance

- `src/engine/runPipeline.ts` exports a `RunFinding` interface carrying runId, mode, question, questionFiles, finding, files, nextSteps, findingPath (`.baiton/runs/<run-id>/finding.md`) and the answered manifest, reachable from the `src/engine` barrel without editing it.
- `RunPipelineDeps.onFinding` is called exactly once for an investigate run that completes, after the manifest is `answered` and `finding.md` is on disk, before `onComplete`, and never for a cancelled, closed, invalid-output or refused investigate run, nor for any bug/quick/refactor run.
- A sink that throws is swallowed, reported through `deps.report`, and leaves the run `answered` with its outcome intact.
- `RunPipelineOutcome.finding` carries the same payload on the resolved `completed` promise, on the `onComplete` call and on the `{ kind: 'completed' }` change event; it is `undefined` for every non-answered ending and for every build-mode run.
- An investigate run creates no worktree, makes no commit, requests no diff, creates no worktree-bound git service, and makes no git call at all after `start()` — provable by the FakeGit call counters and by `diff`/`findCommitByRunId` remaining the throwing `boom` stubs.
- The investigate run writes `.baiton/runs/<run-id>/finding.md` with the `# Finding`/`## Files`/`## Next steps` shape, writes its journal pair for `<run-id>.investigate.1` with `todoId` equal to the run id and `result: 'completed'`, marks the manifest `answered` with `attempts.investigate === 1`, and writes nothing under `.baiton/specs/`.
- `npm run compile` is clean, `npm run lint` reports only the pre-existing `_legacy` warning, and `npm test` passes with 0 failing and no existing assertion in any test file weakened or removed.
- `git status --porcelain` lists only `src/engine/runPipeline.ts` and `test/runPipeline.test.ts`.
