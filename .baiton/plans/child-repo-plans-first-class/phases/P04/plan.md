# Plan P04

## Steps

1. guard.ts: add a plan-repo write guard that inherits Restricted Mode from the conversation

   In src/orchestrator/guard.ts, next to `guardWorkspaceForRepo`, export:

   ```ts
   /** A guard for reading/writing one plan repo's documents. Containment is that repo's root for reads and only its own .baiton/plans and .baiton/specs for mutations; Restricted Mode is inherited from the calling conversation's guard (either flag disables writes). */
   export function planRepoGuard(conversation: GuardContext, target: { root: string; baitonDir: string; guard?: GuardContext }): GuardContext {
     return new GuardContext(guardWorkspaceForRepo({ root: target.root, baitonDir: target.baitonDir }, conversation.restricted || (target.guard?.restricted ?? false)));
   }
   ```

   Nothing else in guard.ts changes: `guardTool`, `resolveMutatingPath` and `resolveReadPath` keep their behaviour. The plan tools must not use the seam's `target.guard` directly. They use `planRepoGuard(tc.ctx, target)`, so a restricted conversation can never write to another repo even when the seam's `restricted()` callback says otherwise.

   Files: `src/orchestrator/guard.ts`

2. toolServices.ts: make planRepos mandatory, add plan-repo-aware seams, and add the shared plan resolver

   In src/orchestrator/toolServices.ts:

   1. Change `planRepos?: PlanRepoSeam` to `planRepos: PlanRepoSeam`. Update its doc comment to say it addresses plans in every discovered `.baiton/` repo, and that a single-repo host passes the degenerate seam (see item 5).
   2. Change `submitPr?: (slug: string) => Promise<SubmitPrOutcome>` to `submitPr?: (slug: string, planRepoRoot?: string) => Promise<SubmitPrOutcome>`. `planRepoRoot` is the absolute root of the plan's owning repo. Pass it only when that repo is not the conversation's repo.
   3. Add `export interface PlanLandPhaseRequest extends LandPhaseRequest { /** Absolute owning-repo root; omitted for the conversation's own repo. */ repoRoot?: string }` and `export interface PlanLandPhaseSeam { land(req: PlanLandPhaseRequest): Promise<LandPhaseOutcome> }`. Type `landPhase?: PlanLandPhaseSeam`. Import `LandPhaseRequest` and `LandPhaseOutcome` from './seams'. An existing `LandPhaseSeam` value stays assignable.
   4. Add `gitSettingsFor?: (repoRoot: string) => ToolGitSettings`, the remote and base for a non-owner plan repo. When it is absent, callers use `gitSettings`.
   5. Export `singleRepoPlanRepos(repoRoot: string, git: GitService, restricted: () => boolean = () => false): PlanRepoSeam`. It returns `createPlanRepoSeam({ repos: () => undefined, ownerRoot: repoRoot, restricted, gitFor: () => git, exists: (p) => fs.promises.access(p).then(() => true, () => false) })` and is the degenerate seam for tests and single-repo hosts. Import `createPlanRepoSeam` from './planRepos' (this creates no import cycle: planRepos imports guard and seams, not toolServices).
   6. Export the resolver every plan tool uses:

   ```ts
   export interface ResolvedPlan {
     slug: string;            // bare slug
     repoPath: string;        // PlanRepoInfo.path, '.' for the conversation's repo
     isOwner: boolean;        // repoPath === '.'
     root: string; baitonDir: string; git: GitService;
     topology: RepoTopology | undefined; // undefined when the topology has <= 1 repo (keeps single-repo hint errors byte-identical)
     guard: GuardContext;     // tc.ctx for the owner, planRepoGuard(tc.ctx, target) otherwise
     label: string;           // slug for the owner, formatPlanRef(repoPath, slug) otherwise
   }
   export async function resolvePlanAddress(services: ToolServices, rawSlug: string, planRepo: string | undefined, tc: ToolContext, opts: { mutating: boolean }): Promise<{ ok: true; plan: ResolvedPlan } | { ok: false; error: string }>
   ```

   The resolver's algorithm:

   (a) Run `parsePlanRef(rawSlug)`. On failure return `invalid slug: ${rawSlug}`. If the ref has a repo and `planRepo` is also given, and `normalizeRepoPath` of the two differ, return `plan_repo "${planRepo}" conflicts with qualified slug "${rawSlug}"`. Set `repo = planRepo ?? ref.repo`.

   (b) Check the slug with the existing `isSlug` regex (`/^[A-Za-z0-9._-]+$/`, not '.' or '..'). On failure return `invalid slug: ${rawSlug}`, so the message for a bare slug is the same as today.

   (c) Call `services.planRepos.locate(ref.slug, repo)` and branch on the result:
   - `invalid`: return its error.
   - `ambiguous`: return `plan "${slug}" exists in more than one repo; pass "plan_repo" or use a qualified slug: ${repos.map((r) => formatPlanRef(r, slug)).join(', ')}`.
   - `missing` with no repo: fall back to the owner context (`services.baitonDir`, `services.git`, `tc.ctx`, repoPath '.'). Each tool then hits its own existing not-found or path error, and today's messages are kept.
   - `missing` with a repo: run `services.planRepos.target(repo)`. If it fails, return its error. Otherwise continue with that target, and the tool reports its own not-found.
   - `found`: use `located.target`.

   (d) Owner detection is `target.info.path === '.'`. For the owner, use `services.baitonDir`, `services.git` and `tc.ctx`. Otherwise use `target.baitonDir`, `target.git` and `planRepoGuard(tc.ctx, target)`.

   (e) Only for a non-owner with `opts.mutating`: if `tc.ctx.restricted || resolved guard.restricted`, return `plan writes are disabled in Restricted Mode` (this is the existing message).

   Also export a small `isSingleRepo(services)` helper, true when `services.planRepos.owners().length <= 1 && services.planRepos.list().length <= 1`. Imports stay vscode-free.

   Files: `src/orchestrator/toolServices.ts`

3. planWriteTools.ts: route update_overview/add_phase/edit_phase/remove_phase through resolvePlanAddress

   In src/orchestrator/planWriteTools.ts:

   - Add `plan_repo: { type: 'string' }` to the schema of all four tools. Do not reuse `repo`, because on add_phase and edit_phase `repo` remains the phase target hint. Append one sentence to each description: "`slug` may be qualified as `<repoPath>:<slug>`, or pass `plan_repo` (a repo path relative to this repo) to address a plan owned by another repo." Read it with `readString(args, 'plan_repo')`.
   - Rewrite `loadPlanForWrite(services, slug, planRepo, tc)` on top of `resolvePlanAddress(services, slug, planRepo, tc, { mutating: true })`. Delete the old `services.planRepos !== undefined` branch and the 'exists in more than one nested repo' message. Resolve with `location = resolveDocument(plan.baitonDir, plan.slug)` and `await plan.guard.resolveMutatingPath(location.documentPath)`, then read the file, keeping the existing `plan "${slug}" was not found` message. Return `{ ok, absolute, content, kind, plan }`, where `plan` is the ResolvedPlan.
   - Each tool then uses `loaded.plan.slug` (the bare slug) for the commit message: `writeAndCommit(services, loaded.absolute, ..., loaded.plan.slug, ..., loaded.plan.git)`. The commit subject therefore stays `plan(<bareSlug>): ...`. In error messages, use `loaded.plan.label` in place of `slug`. Since label === slug for the owner, single-repo text is unchanged. In the success data, return `slug: loaded.plan.slug` and add `repo: loaded.plan.repoPath` only when `!loaded.plan.isOwner`.
   - `checkRepoHint(hint, loaded.plan.topology, id, tool)` keeps its message text. The topology is now the plan repo's own `repoTopologyFor(set, repo.name)`, or undefined for a single repo. This keeps the single-repo `repo hints need a workspace with nested repos; omit "repo"` refusal byte-identical, and no conversation-subtree rule remains. Make `checkRepoHint` relative to the plan owner: hints are paths relative to the plan's repo.
   - Delete the local `isSlug` if it moved to toolServices (or keep one shared exported copy), and remove the now-unused imports.

   Files: `src/orchestrator/planWriteTools.ts`

4. readTools.ts: list_plans across repos and read_plan by qualified slug

   In src/orchestrator/readTools.ts:

   **list_plans.** Add an optional `plan_repo: { type: 'string' }` property to the schema. Behaviour:
   - If `owners()` is exactly one entry with path '.' (the single-repo case), run today's loop over `listDocumentSlugs(services.baitonDir)` and return exactly `{ plans }`.
   - If `plan_repo` is given, resolve `services.planRepos.target(plan_repo)` and list only that repo's slugs as bare names. Return `{ plans, repo }`, or the target's error.
   - Otherwise, for each `info` of `services.planRepos.owners()`, take `baitonDir` from `info.path === '.' ? services.baitonDir : target(info.path)` (skip a `!ok`). Collect `{ repo: info.path, slug }` for every slug whose document exists, keeping owner-first discovery order. Count slugs. Return `{ plans: entries.map((e) => count(e.slug) > 1 ? formatPlanRef(e.repo, e.slug) : e.slug), entries: entries.map((e) => ({ repo: e.repo, slug: e.slug, ref: formatPlanRef(e.repo, e.slug) })) }`.
   - Update the description to say plans from other repos are listed, and colliding slugs appear as `<repoPath>:<slug>`.

   **read_plan.** Add `plan_repo` to the schema and the same sentence to the description. Run `resolvePlanAddress(services, slug, planRepo, tc, { mutating: false })`. Read through `resolveDocument(plan.baitonDir, plan.slug)` with `plan.guard.resolveReadPath`, then bound the result with `tc.ctx.boundRead`. Return the data `{ slug, kind, text, truncated }` and add `repo: plan.repoPath` only for a non-owner. The not-found message uses `plan.label`.

   list_files, read_file, search and git_* are NOT changed: they stay bound to `tc.ctx` and `services.git` (the source-read constraint).

   Files: `src/orchestrator/readTools.ts`

5. controlTools.ts: approve_plan, land_phase, submit_pr act on the plan's repo; draft_plan drops optional-seam branches

   In src/orchestrator/controlTools.ts:

   **approve_plan.** Add `plan_repo` to the schema. Resolve with `resolvePlanAddress(..., { mutating: true })`. Use `location = resolveDocument(plan.baitonDir, plan.slug)` and `plan.guard.resolveMutatingPath`. Thread `plan` into `freshApprove` and `reapprove`, replacing every `services.git` with `plan.git`, both for `isCleanExceptPlanFolder`, fetch, `resolveBaseCommit`, `createPlanBranch`, `checkout` and `commit`. Settings are `const settings = plan.isOwner ? services.gitSettings : services.gitSettingsFor?.(plan.root) ?? services.gitSettings`, and they replace `services.gitSettings.remote/base`. The confirmation text uses `plan.label`, which is identical for the owner. Commit messages keep the bare slug. The branch stays `baiton/${plan.slug}`. Data adds `repo` only for a non-owner.

   **land_phase.** Add `plan_repo`. Resolve with `{ mutating: true }`, then read through `plan.guard.resolveMutatingPath`. Call `services.landPhase.land(plan.isOwner ? { slug: plan.slug, phaseId: phase } : { slug: plan.slug, phaseId: phase, repoRoot: plan.root })`. The owner request object stays byte-identical. Messages use `plan.label`.

   **submit_pr.** Add `plan_repo`. Resolve with `{ mutating: true }` and check containment with `plan.guard.resolveMutatingPath(resolveDocument(plan.baitonDir, plan.slug).documentPath)`. The confirmation uses `plan.label`. Call `plan.isOwner ? services.submitPr(plan.slug) : services.submitPr(plan.slug, plan.root)`; for the owner it is still one argument. Data adds `repo` for a non-owner.

   **Removals.** Delete `documentFor` if it becomes unused. `run` keeps using it, so keep it for `run` only, and leave `run` unchanged (per-repo dispatch belongs to the engine-facade phase).

   **draft_plan.**
   - Remove the `services.planRepos === undefined` checks. When a non-'.' `repo` is given and `isSingleRepo(services)` is true, return the existing `draft_plan: this workspace has no nested repos; omit "repo"`.
   - Keep `services.planRepos.target(repoHint)` as is.
   - Simplify the repo-context block to `const repoContextTarget = target ?? (ownerTarget.ok ? ownerTarget.target : undefined)`, and keep the `repos.length > 1` guard so single-repo DraftPlanRequests are unchanged.

   Add `plan_repo` descriptions consistently. Every other control tool (ask_user, start_run, investigate, spawn/send sub-agent) is untouched.

   Files: `src/orchestrator/controlTools.ts`

6. submitPr.ts: take the plan's repo as the base of per-repo grouping

   In src/engine/submitPr.ts, add an optional field to `SubmitPrDeps`:

   ```ts
   /** The plan's owning repo name (RepoSet name); the owner target of grouping. Absent = '.' (today). */
   planRepoName?: string;
   ```

   - In `submitPr`, the fallback owner target (when `deps.phaseTarget` is undefined) becomes `{ name: deps.planRepoName ?? '.', root: deps.workspaceRoot, isOwner: true, git: deps.git }`.
   - Document in the header comment and on `workspaceRoot`, `baitonDir`, `git`, `remote` and `pr` that they describe the PLAN's repo, which need not be the conversation's repo.
   - Change `runDir` to `path.join(deps.baitonDir, 'runs', runId)` in both `submitOwnerPr` and `submitGroupedPr`. This value equals today's `path.join(workspaceRoot, '.baiton', 'runs', runId)` whenever baitonDir is `<root>/.baiton`, so the brief and diff land under the plan repo's own `.baiton/runs`. Check that `launchStage` derives its run dir the same way. If `launchStage` itself builds `<workspaceRoot>/.baiton/runs/<runId>`, leave runDir as is, because workspaceRoot is already the plan repo.
   - Nothing else changes. Verify, the clean-tree check, push and record still run in `deps.workspaceRoot`/`deps.git`, which is now the plan repo.

   Files: `src/engine/submitPr.ts`

7. commands.ts: always pass planRepos; plan-repo-aware submitPr and landPhase seams

   In src/activation/commands.ts:

   **buildToolServices.** Make `planRepos: PlanRepoSeam` a required parameter. Change the signature tail to `subAgents: SubAgentSeam | undefined, planRepos: PlanRepoSeam`, and always set `planRepos` in the returned object. Both call sites (draftServices around line 770, which already passes `undefined, planRepos`, and the registry around line 800) already pass it. Add `gitSettingsFor: (root) => repoGitSettingsFor(root)`. That helper finds the repo name via `activation.repos?.repos.find((r) => path.resolve(r.root) === path.resolve(root))?.name`, then returns `{ remote: activation.repoConfigs?.get(name)?.git?.remote ?? readGitSettings().remote, base: activation.repoConfigs?.get(name)?.git?.base ?? cfg().git.base }`. Since buildToolServices is a module function, pass this helper in as an extra parameter or merge it at the call site.

   **Per-repo runtime cache.** Add `const planRepoRuntimes = new Map<string, { target: PlanRepoTarget; phaseTargets: PhaseTargetResolver; planWriter: PlanBranchWriter }>()` and `planRepoRuntimeFor(root)`. It resolves `planRepos.targetAt(root)` and returns undefined when that is undefined. It builds `createPhaseTargetResolver({ baitonDir: target.baitonDir, ownerRoot: target.root, topology: () => target.topology, gitFor })`, using the same `gitFor` lambda as phaseTargets, and `createPlanBranchWriter({ baitonDir: target.baitonDir, git: target.git })`. Key it by `repoLockKey(root)`. For the owner root, never use this; keep the existing `phaseTargets` and `planWriter`.

   **submitPrForSlug(slug, planRepoRoot?).** If `planRepoRoot` is undefined or resolves to `repoRoot`, run exactly today's body. Otherwise get the runtime (if missing, return `{ ok: false, error: 'repo "<root>" is not a discovered repo with a .baiton/ directory' }`). Extract today's body into `submitPrIn(slug, ctx)`, where `ctx = { root, baitonDir, git, phaseTargets, repoName?, defaultRemote }`, and call it with the owner values for the owner path. For a child, pass the following:
   - `ctx.root = target.root`, `baitonDir = target.baitonDir`, `git = target.git`.
   - `remote` comes from `repoGitSettingsFor(target.root).remote`, and `remoteUrl` from `target.git`.
   - `createPrTool({ kind, executable, repoRoot: target.root })`.
   - `unlandedPhases` uses `unlandedPhasesAcross({ workspaceRoot: target.root, git: target.git }, s, await runtime.phaseTargets.forPlan(s))`, and `phaseTarget` uses `runtime.phaseTargets.forPhase`.
   - `planRepoName: target.info.name`.
   - `prKeyFor(slug, root)` becomes `${root}\u0000${slug}`; the owner key is unchanged. The busy check is `phaseQueues.isRunning(slug, target.root)`.

   **landPhaseSeam.land({ slug, phaseId, repoRoot }).** Type the seam as `PlanLandPhaseSeam`. When `repoRoot` is undefined or equals `repoRoot`, run today's body unchanged. Otherwise use the runtime for that root:
   - Refuse if `prInFlight.has(prKeyFor(slug, root))` or `phaseQueues.find(slug, phaseId, root)?.isRunning()`. Use `find`, not `queueFor`, because no owner entry exists for child repos yet.
   - Run `runtime.planWriter.apply(slug, ...)` with `runtime.phaseTargets.forPhase`, `documentKindFor(target.root, slug)` and `landPhaseWorktree({ workspaceRoot: target.root, git: target.git, target: target.value }, ...)`, mapping outcomes the same way.

   Leave the existing command call `runSubmitPr(..., submitPrForSlug, slugArg(arg))` unchanged (still one argument), and leave every other command untouched. Those belong to the commands/CodeLens phase.

   Files: `src/activation/commands.ts`

8. Update every ToolServices literal in tests for the mandatory seam

   Add `planRepos: singleRepoPlanRepos(repoRoot, git)` from '../src/orchestrator/toolServices' to each fully typed ToolServices literal or builder:
   - test/guard.restrictedMode.property.test.ts:174. Pass `() => true` for restricted if the test's guard is restricted.
   - test/integration.plan-execute-review.test.ts:973
   - test/integration.sub-agent-chats.test.ts:562
   - the `makeServices` builders in test/registry.controlTools.test.ts:253, test/controlTools.invalidBlocks.property.test.ts:232, test/planWriteTools.protectedState.property.test.ts:48, test/registry.toolAssembly.test.ts:373 and test/integration.run-modes.test.ts:608.

   Use the literal's own `repoRoot` and `git`. Check that each builder's `baitonDir` is `path.join(repoRoot, '.baiton')`, which the degenerate seam assumes. If one differs, build the seam with `createPlanRepoSeam` and a matching root.

   The casts in test/engine.planDraft.test.ts:182 and test/engineFacade.resume.test.ts:427 compile already. Add the seam only if those tests reach a plan tool at runtime (draft_plan now calls `services.planRepos.list/owners/target` unconditionally, so engine.planDraft likely needs it).

   In test/registry.controlTools.test.ts, the 'refuses child targets without a seam' assertion keeps its exact message because `isSingleRepo` reproduces it. Rename the case to 'in a single-repo workspace'.

   Files: `test/guard.restrictedMode.property.test.ts`, `test/integration.plan-execute-review.test.ts`, `test/integration.sub-agent-chats.test.ts`, `test/registry.controlTools.test.ts`, `test/controlTools.invalidBlocks.property.test.ts`, `test/planWriteTools.protectedState.property.test.ts`, `test/registry.toolAssembly.test.ts`, `test/integration.run-modes.test.ts`, `test/engine.planDraft.test.ts`

9. New and updated tests for addressing, ambiguity, guard binding and plan-repo submit

   **test/planWriteTools.repo.test.ts**
   - Change the first case from `planRepos: undefined` to `planRepos: singleRepoPlanRepos(ownerRoot, ownerGit)` and keep its exact assertions.
   - Update the ambiguous case to expect `plan "ambiguous" exists in more than one repo; pass "plan_repo" or use a qualified slug: packages/api:ambiguous, packages/other:ambiguous`.
   - Add these cases:
     - The same slug in the owner and in packages/api, written via `edit_phase` with a bare slug, is refused with both candidates (`.:dup` and `packages/api:dup`, formatted by `formatPlanRef`). No file changes and no commits.
     - `plan_repo: 'packages/api'` and `slug: 'packages/api:dup'` each edit only the child file and commit only in childGit. The data carries `repo: 'packages/api'`.
     - A conflicting `plan_repo` plus a qualified slug is refused.
     - A sibling-owned plan (`../sibling:s`) is written and committed in the sibling git. Extend `gitFor` with a siblingGit stub.
     - A restricted `tc.ctx` (GuardContext restricted: true) with a non-restricted seam refuses a child write with `plan writes are disabled in Restricted Mode`, and nothing changes.
     - The add_phase `repo` hint on a child plan is validated against the child's topology: a repo nested under the child is accepted, and the owner as an ancestor is refused.

   **test/registry.controlTools.test.ts**
   - list_plans over a two-repo seam with a colliding slug and a unique one returns `plans: ['.:dup', 'unique-owner', 'packages/api:dup']` in owner-first order, with entries.
   - read_plan with `packages/api:dup` returns the child text and `repo`.
   - approve_plan on a child plan commits via the child git stub and uses `gitSettingsFor`.
   - land_phase on a child plan passes `{ slug, phaseId, repoRoot: childRoot }`, and on an owner plan passes exactly `{ slug, phaseId }`.
   - submit_pr records the call arguments `[slug, childRoot]` for a child and `[slug]` for the owner.
   - The single-repo list_plans and read_plan outputs are deepStrictEqual to today's.

   **test/guard.repoBinding.test.ts**
   - `planRepoGuard(conversationCtx, { root: child, baitonDir: child/.baiton })` allows mutations only under `child/.baiton/plans` and `child/.baiton/specs`, and rejects `parent/.baiton/plans/x/plan.md`, `child/src/b.ts` and a sibling path.
   - It inherits `restricted: true` from a restricted conversation guard.

   **test/submitPr.multiRepo.test.ts**
   - Add a case where the plan lives in the child repo. Use `workspaceRoot`, `baitonDir`, `git`, `remote` and `pr` of the child, no `phaseTarget`, and `planRepoName: 'api'` (or the world's child name).
   - Assert that it succeeds, that `result.prs` is `[{ repo: 'api', isOwner: true, ... }]`, that the child remote has the plan branch with the `pr` record, and that the owner repo's log and remote are untouched.

   Files: `test/planWriteTools.repo.test.ts`, `test/registry.controlTools.test.ts`, `test/guard.repoBinding.test.ts`, `test/submitPr.multiRepo.test.ts`

## Risks

- Making `ToolServices.planRepos` mandatory breaks type-checking (tsc and ts-node include test/) in every test that builds a typed ToolServices literal, beyond the four test files the phase names. Those builders must be updated in this phase, or `npm run compile`/`npm test` fail.
- Owner-plan byte-identity: owner plans must keep using `services.baitonDir`, `services.git`, `tc.ctx` and the bare slug in messages, commit subjects, confirm text, land/submit seam arguments and data shapes. Adding `repo`/`entries` fields or a second submitPr argument for owner plans would change tests and single-repo behaviour.
- The degenerate seam's fallback topology `{owner:'.', repos:[.]}` would change the single-repo `repo hints need a workspace with nested repos` refusal into an 'unknown repo' message. ResolvedPlan.topology must be undefined when the topology has <= 1 repo.
- `add_phase`/`edit_phase` already use `repo` for the phase target hint, so the owning-repo argument must be a distinct name (`plan_repo`). Overloading `repo` would silently retarget phases.
- `parsePlanRef` splits on the last colon. Windows absolute repo paths (`C:/x:slug`) still parse because a slug cannot contain ':', but an invalid slug containing ':' now reports the qualified parse rather than the old raw-string error. Keep `invalid slug: ${rawSlug}` with the raw input.
- commands.ts creates a per-repo PlanBranchWriter/phase-target resolver for child-repo land and submit. The later engine-facade phase also creates per-repo writers, so it must reuse or replace this cache, not add a second writer for the same repo (two writers would not serialize commits).
- `run` (stage dispatch) is intentionally left owner-addressed. RunDispatchRequest lives in seams.ts and the per-repo queues/owners are the engine-facade phase's work, so a child plan cannot be dispatched through the `run` tool until then.
- `phaseQueues.queueFor(slug, phase, childRoot)` throws without an owners() entry, so the child land path must use `phaseQueues.find(...)`.
- If `launchStage` derives the run directory from workspaceRoot itself, changing submitPr's runDir to `deps.baitonDir/runs` could desynchronize brief and diff paths. Verify before changing it, or leave it as is.

## Acceptance

- `npm run compile` succeeds with `ToolServices.planRepos` non-optional and `buildToolServices` always setting it.
- `npm run lint` reports no new errors.
- `npm test` passes in full, including the new and updated cases in test/planWriteTools.repo.test.ts, test/registry.controlTools.test.ts, test/guard.repoBinding.test.ts and test/submitPr.multiRepo.test.ts.
- With a single repo (degenerate seam), list_plans, read_plan, update_overview, add_phase, edit_phase, remove_phase, approve_plan, land_phase and submit_pr produce exactly today's data, errors, commit messages, confirmation text and seam arguments. The existing assertions pass unchanged, except the deliberately rewritten ambiguity message.
- A bare slug present in two repos is refused by every plan tool with candidates formatted `<repoPath>:<slug>` via formatPlanRef. It writes nothing and commits nothing, and there is no owner-wins resolution anywhere in the tools.
- `plan_repo` or a qualified slug addresses a plan in a child or sibling `.baiton/` repo. Writes land only under that repo's `.baiton/plans` or `.baiton/specs` (guard bound via planRepoGuard) and commit with that repo's git service.
- A restricted conversation guard refuses every write to a non-owner plan, even when the seam's restricted callback is false.
- The `repo:` hint on add_phase and edit_phase is validated against the plan repo's own topology.
- land_phase and submit_pr pass the plan repo root to their seams for non-owner plans. The commands.ts submit path resolves remote, base, PR tool, unlanded phases and phase targets from the plan's repo. submitPr reports the plan repo's name as the owner group.
- read_file, list_files, search and git_* are unchanged and still bound to the conversation guard and git.
- `git diff --name-only` shows changes only in the source files named by this phase plus the test builders that had to gain the mandatory seam.
