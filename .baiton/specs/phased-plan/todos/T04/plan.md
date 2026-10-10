# Plan T04

## Steps

1. Create src/engine/phaseWorktree.ts from todoWorktree.ts (git mv) with kind-aware branch namespaces

   Rename the file with `git mv src/engine/todoWorktree.ts src/engine/phaseWorktree.ts` and rewrite its identifiers. Logic stays the same apart from the two kind-aware points below.

   Renames (old -> new):
   - TODO_BRANCH_NAMESPACE -> PHASE_BRANCH_NAMESPACE = 'baiton-phase'. Add `LEGACY_TODO_BRANCH_NAMESPACE = 'baiton-todo'` with the comment `// Legacy: phases of a legacy .baiton/specs/ document keep the baiton-todo/ namespace so in-flight branches still resolve.`
   - specBranchFor -> planBranchFor (still returns `baiton/${slug}`).
   - todoBranchPrefix(slug) -> phaseBranchPrefix(slug, kind: DocumentKind). It returns `${phaseBranchNamespace(kind)}/${slug}/`.
   - New export `phaseBranchNamespace(kind: DocumentKind)`: returns 'baiton-phase' for 'plan' and 'baiton-todo' for 'legacy-spec'.
   - todoBranchFor(slug, todoId) -> phaseBranchFor(slug, phaseId, kind: DocumentKind). Make `kind` a required parameter so every caller chooses deliberately.
   - New export `documentKindFor(workspaceRoot: string, slug: string): DocumentKind`. It returns `resolveDocument(path.join(workspaceRoot, '.baiton'), slug).kind`. Import resolveDocument from '../storage/documentLocation' and DocumentKind as a type from '../model/parser'.
   - todoWorktreeDirFor -> phaseWorktreeDirFor; todoWorktreeRelativeDir -> phaseWorktreeRelativeDir. The paths stay `.baiton/worktrees/<slug>/<id>`.
   - todoLandMessage -> phaseLandMessage. It returns `plan(${slug}): land ${phaseId}` for both kinds.
   - isTodoWorktreeKey -> isPhaseWorktreeKey; createTodoGitService -> createPhaseGitService.
   - TodoWorktreeDeps -> PhaseWorktreeDeps; TodoWorktreeInfo -> PhaseWorktreeInfo, with fields `todoId` -> `phaseId` and `specBranch` -> `planBranch`. Add a `kind: DocumentKind` field.
   - TodoWorktreeError -> PhaseWorktreeError. Every variant's `todoId` becomes `phaseId`. Variant 'no-spec-branch' becomes 'no-plan-branch', and its `specBranch` field becomes `planBranch`.
   - TodoLandOutcome -> PhaseLandOutcome, with `specBranch` -> `planBranch`; TodoLandRefusal -> PhaseLandRefusal.
   - TodoWorktreeRemoval -> PhaseWorktreeRemoval.
   - findTodoWorktree -> findPhaseWorktree; createTodoWorktree -> createPhaseWorktree; removeTodoWorktree -> removePhaseWorktree; landTodoWorktree -> landPhaseWorktree; unlandedTodos -> unlandedPhases.
   - Rename every input object key from `{ slug, todoId }` to `{ slug, phaseId }`.

   Kind resolution:
   - createPhaseWorktree, removePhaseWorktree and landPhaseWorktree accept an optional `kind?: DocumentKind` in `input`. They compute `const kind = input.kind ?? documentKindFor(deps.workspaceRoot, slug)` after the id check and use `phaseBranchFor(slug, phaseId, kind)`. landPhaseWorktree must pass that `kind` on to its removePhaseWorktree cleanup call.
   - The land dirty-tree filter currently uses the hard-coded `.baiton/specs/${slug}/`. Replace it with `${resolveDocument(path.join(deps.workspaceRoot, '.baiton'), slug).pathspec}/`. Legacy documents keep their current behaviour, and plan documents ignore `.baiton/plans/<slug>/`.
   - unlandedPhases(deps: Pick<PhaseWorktreeDeps, 'git' | 'workspaceRoot'>, slug, kind?: DocumentKind) lists `phaseBranchPrefix(slug, kind ?? documentKindFor(deps.workspaceRoot, slug))`. Filtering and sorting stay the same.

   Strings:
   - Reword every user-facing message and doc comment from todo/spec to phase/plan. Examples: 'is not a valid slug and phase id', `The plan branch ${planBranch} does not exist, so ${phaseId} has nothing to branch from.`, 'outside the plan folder', 'the phase branch and worktree are untouched', 'Remove it with removePhaseWorktree'.
   - Keep the check order `invalid-id -> wrong-branch -> dirty-tree -> missing-branch -> merge` and all refusal `reason` strings except 'no-spec-branch'.

   Files: `src/engine/todoWorktree.ts`, `src/engine/phaseWorktree.ts`

2. Update engine/index.ts and the git types comment

   In src/engine/index.ts, replace `export * from './todoWorktree';` with `export * from './phaseWorktree';`. Rewrite the module doc comment in phase/plan vocabulary: per-phase worktree lifecycle `.baiton/worktrees/<slug>/<phase-id>/` on `baiton-phase/<slug>/<phase-id>` (legacy specs: `baiton-todo/`), land into the plan branch, the per-slug plan-branch writer, and the plan-less run pipeline. Use 'plan-less' in place of 'spec-less' throughout.

   In src/git/types.ts around line 207, change the listBranches doc example from `baiton-todo/<slug>/` to `baiton-phase/<slug>/`, adding '(or legacy `baiton-todo/<slug>/`)'.

   Files: `src/engine/index.ts`, `src/git/types.ts`

3. Rename runQueue identifiers to phase/plan vocabulary

   Edit src/engine/runQueue.ts.

   Imports:
   - Import `createPhaseWorktree, unlandedPhases, type PhaseWorktreeDeps` from './phaseWorktree'.

   Public names (old -> new):
   - RunRequest.todoId -> phaseId; LiveRun.todoId -> phaseId.
   - RunQueueDeps.todoId -> phaseId; RunQueueDeps.specStore -> planStore; RunQueueDeps.specWriter -> planWriter.
   - RunQueueDeps.journalPathFor(todoId) -> journalPathFor(phaseId). Keep the name and update the parameter and doc.
   - PlanStore interface methods: readSpec -> readPlan. Rename the `todoId` parameters of currentState, readArtifact, latestExecuteCommit, isBlocked, inputRevMatches, inputRev and writeState to `phaseId`.
   - TodoStageWorkspace -> PhaseStageWorkspace.
   - QueueWorktreeSeam.ensure(slug, phaseId).
   - createQueueWorktreeSeam(deps: PhaseWorktreeDeps & { writer?: ... }) calls `createPhaseWorktree(deps, { slug, phaseId })` and `unlanded: (slug) => unlandedPhases(deps, slug)`.
   - DispatchError kind 'spec-write-failed' -> 'plan-write-failed'.
   - The private method checkSpecGuards -> checkPlanGuards. Rename local variables such as `spec` to `plan` or `parsed`.

   The execute commit message at about line 1276 becomes `plan(${req.slug}): ${req.phaseId} execute attempt ${req.attempt}`.

   The journal appends (appendStart, appendCompletion) must keep the persisted property key `todoId:`, assigned from `req.phaseId`. That is the journal's on-disk format and must not change.

   The buildStageContext call sites must pass the new StageContextInput keys from the next step.

   The default run-id generator keeps its `${slug}-${id}-${stage}-${attempt}-${clock()}` shape, using req.phaseId.

   Reword every message and comment from todo/spec to phase/plan. Examples: `phase "${req.phaseId}" could not be read`, 'plan is not approved; planning is not allowed', 'plan approval is stale; re-approve before executing', `phase "X" is blocked by unmet dependencies`, `could not list unlanded phases of`, 'land them (land_todo) before planning'. Keep the tool name `land_todo` for now, because the orchestrator tool rename belongs to a later phase.

   The guard call `git.isCleanExceptSpecFolder` is a GitService method and stays as is.

   Files: `src/engine/runQueue.ts`

4. Rename stageContext, transitions, recovery, runPipeline, launcher, runContext and runStore vocabulary

   stageContext.ts:
   - StageContextInput.spec -> plan (type ParsedPlan).
   - StageContextInput.todoId -> phaseId.
   - The existing `plan?: string` field (the phase's planner artifact) would collide with the new `plan` key, so rename it to `phasePlan`.
   - Rename the helpers: todoSection -> phaseSection, findTodo -> findPhase.
   - Change the strings: 'The phase "X" is not present in the plan.', 'No plan is on file for this phase.', 'No execution summary is on file for this phase.'
   - Keep the section headings `# OVERVIEW`, `# Phase`, `# Plan`, `# Latest review`, `# Execution`, `# Execute commit` and `## After target <id>` byte-identical. The planner/role instruction text refers to them, so they are behaviour.
   - Reword the doc comments to phase/plan vocabulary.

   transitions.ts:
   - Comments only: 'todo' -> 'phase' and 'spec' -> 'plan'. No logic or type changes; it already uses PhaseState.

   recovery.ts:
   - RecoveryOutcome.todoId -> phaseId, assigned from `entry.todoId`, the persisted journal key.
   - RecoveryBaseDeps.specStore -> planStore. Use `deps.planStore.writeState(deps.slug, entry.todoId, ...)`.
   - Reword the comments: `.baiton/specs/` -> 'document root', and 'todo' -> 'phase'.

   runPipeline.ts:
   - RunPipelineDeps.isSpecBusy -> isPlanBusy.
   - Reword the comments ('plan-less run', 'phase id') and the runExecuteCommitMessage doc to reference `plan(<slug>): <phaseId> execute attempt <n>`.
   - Keep the journal `todoId: runId` keys and awaitStageResult's `todoId` input key; both are owned by the journal and resultFlow.
   - Leave the `draft_spec` tool name in the refusal messages unchanged, because the orchestrator tool rename is a later phase.

   launcher.ts, runContext.ts, runStore.ts:
   - Comment rewording only: 'spec-less' -> 'plan-less', 'todo' -> 'phase', `.baiton/specs/` -> 'a plan document folder'.
   - In runStore, RUN_ARTIFACT_TODO_ID -> RUN_ARTIFACT_PHASE_ID.
   - Keep the user-visible `draft_spec` wording in the runStore mode messages for now.

   submitPr.ts:
   - SubmitPrDeps.unlandedTodos -> unlandedPhases.
   - PR_TODO_ID -> PR_PHASE_ID; the value stays 'PR'.

   Files: `src/engine/stageContext.ts`, `src/engine/transitions.ts`, `src/engine/recovery.ts`, `src/engine/runPipeline.ts`, `src/engine/launcher.ts`, `src/engine/runContext.ts`, `src/engine/runStore.ts`, `src/engine/submitPr.ts`

5. Fix every caller outside the engine (minimal, mechanical)

   Run `npm run compile` and fix every error caused by the renames. Change only the engine-facing names at these call sites; caller-local names such as LandTodoSeam, todoQueueKey, trigger.todoId and controlTools' `todo` arguments are renamed by the later activation and orchestrator phases.

   src/activation/commands.ts:
   - Import landPhaseWorktree, phaseBranchFor, phaseWorktreeDirFor, unlandedPhases and documentKindFor.
   - submitPr deps: `unlandedPhases: (s) => unlandedPhases({ workspaceRoot: repoRoot, git }, s)`.
   - In the land seam: `git.branchHead(phaseBranchFor(slug, todoId, documentKindFor(repoRoot, slug)))` and `landPhaseWorktree({ workspaceRoot: repoRoot, git }, { slug, phaseId: todoId })`.
   - Attach: `phaseWorktreeDirFor(repoRoot, slug, todoId)`.
   - Rename the queue deps keys passed to createRunQueue and recoverJournal: specStore -> planStore, specWriter -> planWriter, todoId -> phaseId, isSpecBusy -> isPlanBusy.
   - Rename RunRequest literals to `{ slug, phaseId: ..., stage }`.

   src/activation/engineFacade.ts:
   - RunRequest and LiveRun construction and reads: `todoId:` -> `phaseId:`, and `req.todoId` -> `req.phaseId`. Keep the Trigger type's own `todoId` field.

   src/orchestrator/controlTools.ts:764:
   - `services.runQueue.dispatch({ slug, phaseId: todo, stage })`.

   src/activation/surface.ts:117:
   - `case 'plan-write-failed':`.

   src/extension.ts:
   - Update any engine dep keys it passes, if compile flags them.

   src/engine/specDraft.ts:
   - Update only if it consumes a renamed engine dep, for example isSpecBusy. Do not rename specDraft itself; that is the drafting phase.

   src/orchestrator/subAgent.ts:
   - Update only if it reads `LiveRun.todoId`. If it does, change `.todoId` to `.phaseId`.

   Use `rg -n "todoWorktree|TodoWorktree|todoBranchFor|todoLandMessage|unlandedTodos|createTodoGitService|isTodoWorktreeKey|TodoLand|findTodoWorktree|TodoStageWorkspace|spec-write-failed|isSpecBusy|PR_TODO_ID|checkSpecGuards" src test` to confirm that nothing remains.

   Files: `src/activation/commands.ts`, `src/activation/engineFacade.ts`, `src/activation/surface.ts`, `src/orchestrator/controlTools.ts`, `src/extension.ts`, `src/engine/specDraft.ts`, `src/orchestrator/subAgent.ts`

6. Rename and extend test/todoWorktree.test.ts -> test/phaseWorktree.test.ts

   Rename the file with `git mv test/todoWorktree.test.ts test/phaseWorktree.test.ts`. Change the describe to 'phase worktree lifecycle' and import the new names from '../src/engine/phaseWorktree'.

   The default repo from makeRepo has no document, so resolveDocument yields 'plan'. Existing cases therefore now cover the plan kind. Update them as follows:
   - Ids T01/T02/T09 -> P01/P02/P09.
   - Expected branch strings 'baiton-todo/s/X' -> 'baiton-phase/s/X'.
   - Land subject 'spec(s): land T01' -> 'plan(s): land P01'.
   - `phaseBranchFor('s', 'P01', 'plan')` === 'baiton-phase/s/P01'.
   - `phaseLandMessage('s','P01')` === 'plan(s): land P01'.
   - The no-plan-branch kind becomes 'no-plan-branch'.
   - Every mid-test 'spec state' commit of `.baiton/specs/s/spec.md` becomes `.baiton/plans/s/plan.md`. Otherwise the slug flips to legacy kind mid-test and the reuse checks break.
   - In 'refuses in the pinned order', the 'dirty plan folder alone does not refuse' write goes to `.baiton/plans/s/plan.md`.
   - The orphan-branch case creates 'baiton-phase/s/P09'.
   - 'lists unlanded phases of exactly one slug' creates the decoy 'baiton-phase/s-other/P01'.

   Add a `describe('legacy spec documents')` block. Its repo helper commits `.baiton/specs/s/spec.md` on baiton/s before any operation. It asserts that:
   1. `phaseBranchFor('s','T01','legacy-spec')` === 'baiton-todo/s/T01' and `documentKindFor(repo,'s')` === 'legacy-spec'.
   2. createPhaseWorktree checks out 'baiton-todo/s/T01'.
   3. landPhaseWorktree merges with subject 'plan(s): land T01' and deletes 'baiton-todo/s/T01'.
   4. unlandedPhases lists legacy baiton-todo branches only, ignoring a 'baiton-phase/s/P01' decoy.
   5. A dirty `.baiton/specs/s/spec.md` does not cause dirty-tree.

   Add one plan-kind case where a slug exists under both `.baiton/plans/s/plan.md` and `.baiton/specs/s/spec.md`. It asserts that documentKindFor returns 'plan' and that creation uses 'baiton-phase/s/P01'.

   Files: `test/todoWorktree.test.ts`, `test/phaseWorktree.test.ts`

7. Update the remaining engine tests for renamed identifiers and messages

   Fix every test compile error from the renames. Expected-string changes:

   test/runQueue.worktree.test.ts:
   - The fixture is a legacy spec, so branches stay baiton-todo/.
   - Use `phaseBranchFor(SLUG, id, 'legacy-spec')`.
   - The execute commit body starts with `plan(${SLUG}): ${id} execute attempt 1`.
   - Rename the suite to say 'per-phase worktrees'.
   - Request objects use `phaseId`, and deps use `planStore` and `planWriter`.

   test/runQueue.approvalGate.property.test.ts:
   - specStore -> planStore, todoId -> phaseId, readSpec -> readPlan.
   - Any message assertion becomes the new 'plan is not approved' wording.

   test/transitions.dispatch.property.test.ts:
   - Rename the identifier or description that says todo.

   test/stageContext.test.ts and test/stageContext.confinement.property.test.ts:
   - Input keys become `plan`, `phaseId` and `phasePlan`.
   - Assert the new strings 'The phase "X" is not present in the plan.' and 'No plan is on file for this phase.'
   - Rename the describe/it titles from todo to phase.

   test/integration.plan-execute-review.test.ts and test/integration.sub-agent-chats.test.ts:
   - These use legacy specs. Use `phaseBranchFor(SLUG, ID, 'legacy-spec')`; the 'baiton-todo/demo-spec/T01' assertion stays.
   - The land subject becomes `plan(${SLUG}): land ${id}`.
   - The execute subject becomes `plan(${SLUG}): ${id} execute attempt 1`, including the crash-recovery commit at about line 777.
   - Use landPhaseWorktree with `{ slug, phaseId }`, phaseWorktreeDirFor, and unlandedPhases with `{ workspaceRoot, git }`.
   - Rename TODO_ID to PHASE_ID.
   - Leave the `spec(${SLUG}): approve` subject alone. Approval belongs to the orchestrator's approve flow, which these tests commit themselves; change it only if the source now emits something else.

   test/submitPr.test.ts:
   - `unlandedPhases` dep key and import.
   - The lookup passes `{ workspaceRoot: repo.root, git: createGitService(repo.root) }`. Its fixture is a legacy spec, so the 'baiton-todo/greeting/T01' branch is still correct.

   test/recovery.revert.test.ts, test/runQueue.*.test.ts, test/engineFacade.resume.test.ts, test/askWatcher.routing.test.ts and any other file tsc flags:
   - specStore -> planStore, specWriter -> planWriter.
   - RunRequest/RecoveryOutcome `todoId` -> `phaseId`.
   - 'spec-write-failed' -> 'plan-write-failed'.
   - isSpecBusy -> isPlanBusy.
   - Journal entry literals keep `todoId`.

   Only update test/gitService.test.ts if its literal 'baiton-todo' names fail. They are generic listBranches data, so they may stay.

   Files: `test/runQueue.worktree.test.ts`, `test/runQueue.approvalGate.property.test.ts`, `test/transitions.dispatch.property.test.ts`, `test/stageContext.test.ts`, `test/stageContext.confinement.property.test.ts`, `test/integration.plan-execute-review.test.ts`, `test/integration.sub-agent-chats.test.ts`, `test/submitPr.test.ts`, `test/recovery.revert.test.ts`, `test/runQueue.attemptCount.property.test.ts`, `test/runQueue.briefContext.test.ts`, `test/runQueue.revert.property.test.ts`, `test/runQueue.serialization.property.test.ts`, `test/engineFacade.resume.test.ts`, `test/askWatcher.routing.test.ts`

8. Verify

   Run `npm run compile`, `npm run lint` and `npm test`. The Git-backed suites need to run outside the sandbox, because Git subprocesses fail with EPERM inside it.

   Then run `rg -nw "todo|todos|Todo|spec|Spec" src/engine/phaseWorktree.ts src/engine/runQueue.ts src/engine/stageContext.ts src/engine/recovery.ts src/engine/transitions.ts src/engine/launcher.ts src/engine/runContext.ts src/engine/runStore.ts src/engine/runPipeline.ts src/engine/index.ts`. The only remaining hits should be:
   - legacy-marked branches (LEGACY_TODO_BRANCH_NAMESPACE, 'legacy-spec');
   - the persisted journal key `todoId`;
   - the not-yet-renamed tool names `land_todo` and `draft_spec`;
   - the GitService method isCleanExceptSpecFolder.

   Files: (none)

## Risks

- Kind is resolved from disk with resolveDocument, so a test that writes `.baiton/specs/<slug>/spec.md` after creating a phase worktree switches the slug to legacy kind. Later create, land or remove calls then target baiton-todo/ and fail with wrong-branch or missing-branch. Plan-kind tests must write their state files under `.baiton/plans/<slug>/`, or pass an explicit `kind`.
- The journal's persisted `todoId` key must not be renamed in appendStart, appendCompletion or journal literals. Renaming it would break recovery of existing journals and the planStore and engineFacade readers.
- StageContextInput already has a `plan?: string` field (the planner artifact), so renaming `spec` to `plan` collides with it. Rename the artifact field to `phasePlan` first, then `spec` to `plan`, and check every call site in runQueue.ts. A missed site compiles silently if the types happen to line up as strings, so re-read the briefContext test expectations.
- Changing the execute-commit subject to `plan(<slug>): ...` is safe for recovery, which matches the Run-Id trailer and not the subject. Any test or code that greps for the `spec(` subject still has to be updated.
- The rename ripples into activation and orchestrator files: commands.ts, engineFacade.ts, controlTools.ts, surface.ts and extension.ts. Keep those edits to the engine-facing names, so the later activation and orchestrator phases do not hit conflicting half-renames.
- Git-backed tests fail with EPERM inside the sandbox. Run the full suite outside it, as T03 did.

## Acceptance

- src/engine/todoWorktree.ts and test/todoWorktree.test.ts no longer exist; src/engine/phaseWorktree.ts and test/phaseWorktree.test.ts exist, and src/engine/index.ts re-exports './phaseWorktree'.
- `phaseBranchFor('s','P01','plan')` returns 'baiton-phase/s/P01', `phaseBranchFor('s','T01','legacy-spec')` returns 'baiton-todo/s/T01', and createPhaseWorktree picks the namespace from the slug's resolved document kind, with plans/ preferred when the slug exists in both roots.
- Landing a phase of either kind produces a merge commit with subject `plan(<slug>): land <id>`, and the land dirty-tree check ignores the resolved document folder (`.baiton/plans/<slug>/` or legacy `.baiton/specs/<slug>/`).
- unlandedPhases lists only the branches in the resolved kind's namespace for exactly that slug.
- The run queue's execute commit subject is `plan(<slug>): <id> execute attempt <n>`, and the DispatchError kind is 'plan-write-failed'. RunRequest, LiveRun, RecoveryOutcome and StageContextInput use `phaseId`; RunQueueDeps and RecoveryBaseDeps use `planStore`/`planWriter`; PlanStore exposes `readPlan`.
- Journal entries on disk still use the `todoId` key, and legacy-spec integration tests still create and land `baiton-todo/<slug>/T##` branches.
- `rg -n "todoWorktree|TodoWorktree|todoBranchFor|todoLandMessage|unlandedTodos|createTodoGitService|isTodoWorktreeKey|TodoLand|findTodoWorktree|TodoStageWorkspace|spec-write-failed|isSpecBusy|PR_TODO_ID|checkSpecGuards" src test` returns no matches.
- `npm run compile` succeeds, `npm run lint` reports zero errors, and `npm test` passes in full, including the new legacy and plan-kind cases in test/phaseWorktree.test.ts.
