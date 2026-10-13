# Plan P03

## Steps

1. Design decision to apply throughout (read first)

   Today `workspaceRoot` means two things at once: (a) the repo whose `.baiton/` holds the plan document, journal, artifacts and the `.baiton/worktrees/<slug>/<phaseId>` directory, and (b) the repo whose git the phase branch and worktree live in. This phase splits only (b). Rules:
   1. The OWNING repo keeps everything Baiton-managed: document, approval, input rev, plan journal, stage artifacts, AND the phase worktree directory `<ownerRoot>/.baiton/worktrees/<slug>/<phaseId>` (unchanged path, so `phaseWorktreeDirFor(ownerRoot, …)` callers such as the View-session command in commands.ts keep working). This directory is already git-ignored by the owner's tracked `.baiton/.gitignore` (`/worktrees/`), and repo discovery skips every `.baiton` directory (`DISCOVERY_SKIP_DIRS`), so a child worktree there is never mistaken for a new repo and the child repo never gains an untracked `.baiton/` in its main checkout.
   2. The TARGET repo owns the git side: the phase branch `baiton-phase/<slug>/<id>`, the worktree registration, the plan branch `baiton/<slug>` the phase forks from and lands into, and the git service. The worktree is a checkout OF the target repo, so the launch cwd (the worktree), the stage's relative `.baiton/runs/<run-id>/` brief/result/asks dir, the result-write confinement and the CLI's own containment all resolve inside the target repo's checkout and never in the parent or the workspace folder.
   3. A phase with no `repo` hint (and every existing plan/legacy spec) resolves to the owner; every function below must behave byte-identically when no target is supplied or the target `isOwner`.
   No `vscode` import or new real-filesystem dependency may be added to model/engine/orchestrator core modules beyond the sync `fs` phaseWorktree.ts already uses.

   Files: (none)

2. Git service: check out an EXISTING branch into a new worktree

   src/git/types.ts: add to `GitWorktreeService` (after `addWorktree`):
   ```ts
   /** Create a worktree at `dir` checked out on the EXISTING branch `branch` (no new branch). Rejects with a GitError when the branch is missing or already checked out elsewhere. */
   addWorktreeOnBranch(dir: string, branch: string): Promise<void>;
   ```
   src/git/gitService.ts `ShellGitService`: implement as `await this.runOrThrow(['worktree', 'add', dir, branch]);` with a one-line comment that unlike `addWorktree` it never creates or resets a branch.
   test/runPipeline.test.ts `FakeGit` (the only class implementing the interface in tests): add a trivial `async addWorktreeOnBranch(): Promise<void> {}` so the suite compiles. (`{} as GitWorktreeService` casts elsewhere need nothing.)
   test/gitService.test.ts: add a case — create branch `b` in a temp repo, `addWorktreeOnBranch(dir, 'b')` produces a worktree listed by `listWorktrees()` with `branch === 'b'`; calling it for the branch currently checked out in the main checkout rejects.

   Files: `src/git/types.ts`, `src/git/gitService.ts`, `test/runPipeline.test.ts`, `test/gitService.test.ts`

3. phaseWorktree.ts: target-repo types and a pure target resolver

   In src/engine/phaseWorktree.ts add (import `resolvePhaseRepo`, `type RepoTopology` from '../model/validator'):
   ```ts
   /** Where one phase's git work happens: its target repo (the owner when the phase has no repo hint). */
   export interface PhaseTargetRepo {
     /** Stable repo name ('.' for a single-folder root). */
     name: string;
     /** Canonical absolute root of the target repo's main checkout. */
     root: string;
     /** True when the target is the plan's owning repo. */
     isOwner: boolean;
     /** Git service bound to the target repo's MAIN checkout. */
     git: GitWorktreeService;
   }

   /** Resolves phase targets for one owning repo (implemented in activation/planStore.ts). */
   export interface PhaseTargetResolver {
     /** The target of one phase; the owner for a hint-less phase, an unknown phase or an unreadable plan. Err only for a hint that does not resolve to the owner or a repo nested beneath it. */
     forPhase(slug: string, phaseId: string): Promise<Result<PhaseTargetRepo, string>>;
     /** Distinct targets of every phase of the plan, owner first, then in phase order; phases whose hint does not resolve are skipped. Never rejects. */
     forPlan(slug: string): Promise<readonly PhaseTargetRepo[]>;
   }

   /** Pure: resolve a phase's optional repo hint to a target name and root. */
   export function resolvePhaseTargetRoot(
     phase: { id: string; repo?: string },
     topology: RepoTopology | undefined,
     ownerRoot: string,
   ): Result<{ name: string; root: string; isOwner: boolean }, string>
   ```
   `resolvePhaseTargetRoot`: call `resolvePhaseRepo(phase.repo, topology)`. On `ok && isOwner` return `{ name: binding.target, root: ownerRoot, isOwner: true }` (so a hint-less phase never needs a topology). On `ok && !isOwner` look the target up in `topology.repos` by name and return its `path.resolve(root)`; if not found return err. On failure return err with a message of the form `phase "P03" has repo hint "<hint>", which is <invalid|unknown|a sibling of the owning repo|an ancestor of the owning repo>; a phase may only target the owning repo or a repo nested beneath it` (include `binding.target` when present).
   Also add the self-ignore constant:
   ```ts
   /** Written as `.baiton/.gitignore` inside a phase worktree of a repo that tracks none: ignores itself and every run artifact. */
   export const TARGET_WORKTREE_GITIGNORE = '# Baiton run artifacts of a phase owned by another repo. Never committed.\n*\n';
   ```
   and `planLandingWorktreeDirFor(ownerRoot: string, slug: string, targetRoot: string): string` = `path.join(ownerRoot, '.baiton', RUN_WORKTREES_DIR, slug, '_land-' + sha256(path.resolve(targetRoot)).hex.slice(0, 12))` (use `crypto.createHash`). The leading `_` can never collide with a phase id because `isPhaseWorktreeKey` requires an alphanumeric first character.

   Files: `src/engine/phaseWorktree.ts`

4. phaseWorktree.ts: bind create/find/remove/unlanded to the target repo

   Extend `PhaseWorktreeDeps`:
   ```ts
   export interface PhaseWorktreeDeps {
     /** Absolute OWNING repo root: the document and `.baiton/worktrees/` resolve under it. */
     workspaceRoot: string;
     /** Service bound to the OWNING repo's main checkout. */
     git: GitWorktreeService;
     /** The phase's target repo; absent (or isOwner) keeps the owner-only behaviour byte-identical. */
     target?: PhaseTargetRepo;
     createService?: (dir: string) => GitWorktreeService;
   }
   ```
   Add private helpers `mainGit(deps) = deps.target?.git ?? deps.git` and `isCrossRepo(deps) = deps.target !== undefined && !deps.target.isOwner`. Update the doc comments of `phaseWorktreeDirFor` / `phaseWorktreeRelativeDir` / `documentKindFor` to say the root is the owning repo's (relative dir is relative to the owner root). Do NOT change their signatures.
   - `findPhaseWorktree`: list via `mainGit(deps).listWorktrees()`.
   - `createPhaseWorktree`: every git call (`branchHead`, `addWorktree`) goes through `mainGit(deps)`; worktree dir, kind and relative dir are unchanged (owner-based). Only when `isCrossRepo(deps)` and `planHead === undefined`: create the plan branch in the target with `const head = await git.head(); await git.createPlanBranch(planBranch, head); planHead = head;` (no checkout — the target's main checkout is never switched); wrap failures as `kind: 'git'`. For the owner the existing `no-plan-branch` error is unchanged. When `isCrossRepo(deps)`, after a successful `addWorktree` AND on the reuse path, ensure `<worktreeDir>/.baiton/.gitignore` exists: if it is absent, `mkdirSync(.baiton, {recursive:true})` and write `TARGET_WORKTREE_GITIGNORE`; a write failure returns `kind: 'io'`. Never overwrite an existing (tracked) file. This keeps the brief/result/asks the launcher writes under `<worktree>/.baiton/runs/` out of the target's status and out of executor commits.
   - `removePhaseWorktree`: `removeWorktree`, `branchHead`, `deleteBranch` through `mainGit(deps)`.
   - `unlandedPhases(deps: Pick<PhaseWorktreeDeps, 'git' | 'workspaceRoot' | 'target'>, slug, kind?)`: list through `mainGit(deps)`.
   - New `unlandedPhasesAcross(deps: Pick<PhaseWorktreeDeps, 'git' | 'workspaceRoot'>, slug: string, targets: readonly PhaseTargetRepo[], kind?: DocumentKind): Promise<readonly string[]>`: resolve `kind` once from the owner document, list the prefix in `deps.git` and in each target whose `path.resolve(root)` differs from `path.resolve(deps.workspaceRoot)` (each distinct root once), union, dedupe, same filter and numeric sort as `unlandedPhases`. With `targets` empty or owner-only it returns exactly `unlandedPhases(deps, slug, kind)`.

   Files: `src/engine/phaseWorktree.ts`

5. phaseWorktree.ts: cross-repo land without touching the target's main checkout

   `landPhaseWorktree(deps, input)`: if `!isCrossRepo(deps)`, keep the current body verbatim except that git calls go through `mainGit(deps)` (identical for owner). For a cross-repo target:
   1. `invalid-id` check unchanged.
   2. Read `git.currentBranch()` of the target main checkout (failure → `reason: 'git'`). If it equals `baiton/<slug>`, land in the main checkout exactly like the owner path (dirty-tree → missing-branch → merge → cleanup), except the dirty-tree filter has NO document-folder exemption (the document lives in the owner repo, so every target change counts).
   3. Otherwise land through a temporary landing worktree: `missing-branch` if the phase branch has no head in the target; `missing-branch`-style `reason: 'git'` refusal if `baiton/<slug>` has no head in the target. Compute `landingDir = planLandingWorktreeDirFor(deps.workspaceRoot, slug, deps.target.root)`. If a worktree is already registered at that dir (compare with `safeRealpath` like `findPhaseWorktree`), `removeWorktree(landingDir, true)`; then `rmSync` any leftover directory; `mkdirSync(dirname)`; `git.addWorktreeOnBranch(landingDir, planBranch)` (failure → `reason: 'git'` with the message). Build `landingGit = (deps.createService ?? createGitService)(landingDir)`. Dirty-tree check on `landingGit.status()` (should be clean; refuse `dirty-tree` otherwise), `before = await landingGit.head()`, `merged = await landingGit.merge(branch, input.message ?? phaseLandMessage(slug, phaseId))`.
   4. ALWAYS remove the landing worktree afterwards (`removeWorktree(landingDir, true)` then best-effort `rmSync`), success or conflict, so no worktree keeps `baiton/<slug>` checked out in the target; on success a removal problem is pushed to `cleanup`, on conflict it is ignored. Conflict → the same `conflict` refusal (phase branch and phase worktree untouched). Success → `noop = merged.value === before`, then `removePhaseWorktree(deps, {slug, phaseId, kind, deleteBranch: true})` cleanup exactly as today, and return `{ commit: merged.value, planBranch, branch, noop, cleanup }`.
   Update the function's doc comment to describe the cross-repo path and that the target's main checkout is never switched.

   Files: `src/engine/phaseWorktree.ts`

6. Queue worktree seam resolves each phase's target

   src/engine/runQueue.ts `createQueueWorktreeSeam(deps: PhaseWorktreeDeps & { writer?: …; targets?: PhaseTargetResolver })` (import `PhaseTargetResolver`, `unlandedPhasesAcross`):
   - `ensure(slug, phaseId)`: inside the existing `run` closure (so it stays serialized under `writer.apply(slug, …)`), when `deps.targets` is set call `deps.targets.forPhase(slug, phaseId)`; on err return `err(message)`; otherwise call `createPhaseWorktree({ ...deps, target }, { slug, phaseId })`. Without `targets` the call is unchanged. The returned `PhaseStageWorkspace` is still `{ dir: worktreeDir, git: factory(worktreeDir) }`, so the queue's launch `cwd`, tree guards, drift check and Execute commit all run in the target repo's checkout with no further queue change. Do NOT touch the queue's lock/busy logic (a later phase owns it).
   - `unlanded(slug)`: with `targets`, `unlandedPhasesAcross(deps, slug, await deps.targets.forPlan(slug))`; otherwise unchanged.
   src/activation/engineFacade.ts: add `targets?: PhaseTargetResolver` to `PhaseQueuesDeps`, destructure it out of `rest` in `createPhaseQueues` (it must not be spread into `createRunQueue`) and pass it to `createQueueWorktreeSeam({ workspaceRoot, git, writer: planWriter, ...(targets ? { targets } : {}) })`. Leave `phaseQueueKey`, `isRunning(slug)` and the stage lock as they are.

   Files: `src/engine/runQueue.ts`, `src/activation/engineFacade.ts`

7. planStore.ts: the owner-bound phase target resolver; repoDiscovery topology helper

   src/activation/repoDiscovery.ts: add pure `repoTopologyFor(set: RepoSet, ownerName: string): RepoTopology` (import the type from '../model/validator') returning `{ owner: ownerName, repos: set.repos.map(r => ({ name: r.name, root: r.root, ...(r.parent ? { parent: r.parent } : {}) })) }`.
   src/activation/planStore.ts: add
   ```ts
   export interface PhaseTargetResolverDeps {
     /** The OWNING repo's `.baiton/`; the plan document is read from here. */
     baitonDir: string;
     /** The owning repo's canonical root. */
     ownerRoot: string;
     /** Live topology for the owner; undefined when discovery has not run (hint-less phases still resolve). */
     topology: () => RepoTopology | undefined;
     /** One git service per repo root (the activation GitServiceRegistry). */
     gitFor: (repoRoot: string) => GitWorktreeService;
   }
   export function createPhaseTargetResolver(deps: PhaseTargetResolverDeps): PhaseTargetResolver
   ```
   It reads/parses the document via `resolveDocument(baitonDir, slug).documentPath` + `parsePlan` (same tolerant read as `readPlan`). `forPhase`: plan unreadable or phase missing → owner target; otherwise `resolvePhaseTargetRoot(phase, deps.topology(), deps.ownerRoot)`; err passes through; ok → `{ name, root, isOwner, git: isOwner ? deps.gitFor(deps.ownerRoot) : deps.gitFor(root) }`. The owner target's `name` is `deps.topology()?.owner ?? '.'`. `forPlan`: owner first, then each phase's ok target whose root is not yet listed. No journal, approval or input-rev path changes: every journal read/write keeps using the owner `baitonDir` (add one sentence saying so to the `createPlanStore` doc comment).
   src/journal/journal.ts: doc-only — on `planJournalPathFor`/`phaseJournalPathFor`/`planJournalPaths` state that `baitonDir` is always the OWNING repo's `.baiton/`, even for a phase whose target is a child repo; a child repo's `.baiton/` never receives a parent plan's entries. No code change.

   Files: `src/activation/repoDiscovery.ts`, `src/activation/planStore.ts`, `src/journal/journal.ts`

8. Wire the resolver into commands.ts (dispatch, land, unlanded)

   src/activation/commands.ts in `registerCommands`, right after `const git = createGitService(repoRoot);` build the resolver LAZILY (tests construct partial activation states, so nothing may touch `activation.repos` at construction):
   ```ts
   const ownerRepoName = (): string | undefined =>
     activation.repos?.repos.find((r) => path.resolve(r.root) === path.resolve(repoRoot))?.name;
   const phaseTargets = createPhaseTargetResolver({
     baitonDir,
     ownerRoot: repoRoot,
     topology: () => { const owner = ownerRepoName(); return owner === undefined ? undefined : repoTopologyFor(activation.repos, owner); },
     gitFor: (root) => (path.resolve(root) === path.resolve(repoRoot) ? git : activation.git.forRepo(root)),
   });
   ```
   (If lint rejects `?.` on the non-optional `repos`, guard with an explicit `activation.repos === undefined` check cast through `Partial`.) Then:
   - pass `targets: phaseTargets` to `createPhaseQueues({...})`;
   - submitPr's `unlandedPhases: async (s) => unlandedPhasesAcross({ workspaceRoot: repoRoot, git }, s, await phaseTargets.forPlan(s))` (so a PR is refused while a child-repo phase is unlanded; per-repo PR submission itself is a later phase);
   - `landPhaseSeam.land`: inside `planWriter.apply`, first `const target = await phaseTargets.forPhase(slug, phaseId); if (!target.ok) return { kind: 'refused' as const, reason: target.error };` then use `target.value.git.branchHead(phaseBranchFor(...))` for the already-landed check and call `landPhaseWorktree({ workspaceRoot: repoRoot, git, target: target.value }, { slug, phaseId })`.
   Import `createPhaseTargetResolver` from './planStore', `repoTopologyFor` from './repoDiscovery', `unlandedPhasesAcross` from '../engine'. Leave the View-session command's `phaseWorktreeDirFor(repoRoot, …)` unchanged (the worktree still lives under the owner). No other commands.ts changes.

   Files: `src/activation/commands.ts`

9. Guard and read tools: containment comes from the guard bound to the stage's repo

   src/orchestrator/guard.ts:
   - add `public get baitonDir(): string { return this.workspace.baitonDir; }` to `GuardContext`;
   - add pure `export function guardWorkspaceForRepo(repo: { root: string; baitonDir?: string }, restricted: boolean): GuardWorkspace` returning `{ repoRoot: repo.root, baitonDir: repo.baitonDir ?? path.join(repo.root, '.baiton'), restricted }`, documented as the only way to build a guard for a stage's target repo and as never widening to a workspace folder or parent repo (read containment = that repo root; mutating containment = that repo's own `.baiton/plans|specs`). Update the module/interface comments: `repoRoot` is the target repo of the stage being run, not the workspace folder. No change to the containment algorithms themselves.
   src/orchestrator/readTools.ts: `list_files` and `search` walk `tc.ctx.repoRoot` (the guard's canonical root) instead of `services.repoRoot`, and `search` joins candidates onto that same root, so enumeration and containment always agree and a guard bound to a child repo never lists parent or sibling files. `list_plans`/`read_plan` keep `services.baitonDir` (the owning repo's plans).
   src/orchestrator/toolServices.ts: doc-only — `repoRoot`/`baitonDir` are the conversation's OWNING repo; read containment and file enumeration come from `ToolContext.ctx` (a `GuardContext` built with `guardWorkspaceForRepo` for the target repo).

   Files: `src/orchestrator/guard.ts`, `src/orchestrator/readTools.ts`, `src/orchestrator/toolServices.ts`

10. Run-root wording in launcher, result validation, ask relay, result flow, run store/worktree

   These modules already take the root they resolve against as a parameter; make the binding explicit without changing behaviour:
   - src/engine/launcher.ts: export `stageRunRoot(input: Pick<LaunchStageInput, 'workspaceRoot' | 'cwd'>): string` returning `input.cwd ?? input.workspaceRoot`, use it for the existing `base` computation (after both roots have been validated by `resolveRoot`, keeping the validation order and error kinds), and update the `workspaceRoot`/`cwd` doc: `workspaceRoot` is the owning repo root; `cwd` is the phase worktree, a checkout of the phase's TARGET repo, and the brief/result/asks dir lives under it.
   - src/engine/resultValidation.ts: rename the first parameter of `allowedResultPath`/`isAllowedSubAgentWrite` to `runRoot` and document it as the stage's run root (`stageRunRoot`: the target-repo worktree for a phase stage); a result path under the owner root or any parent repo is denied.
   - src/engine/askRelay.ts: rename the `workspaceRoot` parameter of `asksDirFor`/`askRelayDescriptor`/`ensureAsksDir` to `runRoot` with the same doc.
   - src/engine/resultFlow.ts: doc-only — `AwaitStageResultInput.workspaceRoot` and `artifactPathFor(workspaceRoot…)` are the OWNING repo root; artifacts never land in the target repo.
   - src/engine/runStore.ts and src/engine/runWorktree.ts: doc-only — `workspaceRoot` (options/deps/path helpers) is the root of the repo the run belongs to; one RunStore / one RunWorktreeDeps per repo; change the runWorktree error text `Could not read the current branch of ${root}` only if needed for clarity (no behaviour change). Do not rename exported fields (callers outside this phase use them).

   Files: `src/engine/launcher.ts`, `src/engine/resultValidation.ts`, `src/engine/askRelay.ts`, `src/engine/resultFlow.ts`, `src/engine/runStore.ts`, `src/engine/runWorktree.ts`

11. Tests: cross-repo phase worktree lifecycle against real temp repos

   New test/phaseWorktree.crossRepo.test.ts, modelled on test/phaseWorktree.test.ts helpers. Fixture: owner repo (main, committed README, `.baiton/.gitignore` = GITIGNORE_CONTENTS, a committed `.gitignore` containing `packages/api/`, then `baiton/s` checked out) and a nested child repo at `<owner>/packages/api` (own `git init`, committed file on `main`, stays on `main`, no `.baiton/`). Target = `{ name: 'packages/api', root: child, isOwner: false, git: createGitService(child) }`, deps = `{ workspaceRoot: owner, git: createGitService(owner), target }`. Cases:
   1. createPhaseWorktree: ok; `worktreeDir === phaseWorktreeDirFor(owner, 's', 'P03')`; child now has `baiton/s` at its previous HEAD and `baiton-phase/s/P03`; child main checkout still on `main` with an unchanged HEAD; owner has neither phase branch; `git -C child worktree list` contains the dir and the owner's does not; `<worktree>/.baiton/.gitignore` equals TARGET_WORKTREE_GITIGNORE; after writing `<worktree>/.baiton/runs/r1/result.json`, `git -C worktree status --porcelain` is empty and `<child>/.baiton` does not exist.
   2. Second create → `reused: true`, nothing reset.
   3. Land with child on `main`: commit a file in the worktree, land → ok, `noop: false`; `baiton/s` in child contains the commit (merge commit message `plan(s): land P03`); child main checkout still `main` and clean; phase branch deleted; phase worktree and the `_land-*` landing dir both gone; `git -C child worktree list` has only the main worktree; owner `baiton/s` head unchanged.
   4. Land when the child main checkout has `baiton/s` checked out → merges there (child HEAD advances), no landing worktree created.
   5. Conflict: conflicting commits on `baiton/s` and the phase branch → `reason: 'conflict'`, phase branch and worktree preserved, landing worktree removed, `baiton/s` unchanged.
   6. `unlandedPhasesAcross` returns the union of an owner phase branch (`baiton-phase/s/P01` created in owner) and the child `P03`, sorted; with `[]` targets it equals `unlandedPhases`.
   7. Owner target (`isOwner: true`, git = owner service) produces the same result shape/paths as no target for create + land.
   8. `resolvePhaseTargetRoot`: hint-less → owner root even with `topology` undefined; `packages/api` → child root; sibling, ancestor (`..` from a child owner) and unknown hints → err mentioning the hint.
   9. `createQueueWorktreeSeam({ workspaceRoot: owner, git: ownerGit, targets: stub })` where `stub.forPhase` returns the child target: `ensure('s','P03')` returns dir under owner `.baiton/worktrees/s/P03` whose git `currentBranch()` is `baiton-phase/s/P03` and whose `git rev-parse --git-common-dir` resolves inside `<child>/.git`; a stub returning err makes `ensure` return that error and create nothing.

   Files: `test/phaseWorktree.crossRepo.test.ts`

12. Tests: resolver, topology, guard binding, write confinement

   - test/planStore.phaseTargets.test.ts: temp owner dir with `.baiton/plans/s/plan.md` whose phases are `- [pending] P01 Owner work` and `- [pending] P02 Child work (after P01; repo: packages/api)`; topology from a hand-built `RepoTopology` (owner '.', child 'packages/api' with parent '.'); `gitFor` is a recording stub returning distinct sentinel objects. Assert `forPhase('s','P01')` → owner (isOwner, git = gitFor(ownerRoot)); `forPhase('s','P02')` → child root, `gitFor` called with the child root; unknown phase / missing document → owner; a `repo: ../elsewhere` hint → err; `forPlan('s')` → [owner, child] and skips an invalid-hint phase; topology `undefined` → P01 still resolves, P02 errs.
   - test/repoDiscovery.test.ts (existing file; add a case): `repoTopologyFor` maps names/roots/parents of a discovered set and sets `owner`.
   - test/guard.repoBinding.test.ts: temp tree `<parent>/src/a.ts`, `<parent>/packages/api/src/b.ts`, `<parent>/packages/web/c.ts`. A GuardContext from `guardWorkspaceForRepo({ root: child }, false)` accepts `src/b.ts` and rejects `<parent>/src/a.ts`, `../web/c.ts` and the parent root; `resolveMutatingPath` rejects `<parent>/.baiton/plans/x/plan.md` and accepts `<child>/.baiton/plans/x/plan.md`; `baitonDir` getter equals `<child>/.baiton` (realpath). `createReadTools` with services.repoRoot = parent but `tc.ctx` bound to the child: `list_files('**/*')` returns only `src/b.ts`, `search('.')` reports only child files.
   - test/resultValidation.writeConfinement.property.test.ts (extend) or a new example test: with `runRoot = <owner>/.baiton/worktrees/s/P03`, `isAllowedSubAgentWrite(runRoot, id, <runRoot>/.baiton/runs/<id>/result.json)` is true and `<owner>/.baiton/runs/<id>/result.json` and `<owner>/packages/api/.baiton/runs/<id>/result.json` are false; `stageRunRoot({workspaceRoot: owner, cwd: wt})` is `wt` and without `cwd` is `owner`.
   Existing suites (phaseWorktree.test.ts, planStore.test.ts, guard.*.property tests, engine.launcher, engine.askRelay, runStore, runWorktree, resultFlow.artifacts, integration.*) must pass unmodified apart from the FakeGit method addition.

   Files: `test/planStore.phaseTargets.test.ts`, `test/repoDiscovery.test.ts`, `test/guard.repoBinding.test.ts`, `test/resultValidation.writeConfinement.property.test.ts`

## Risks

- Placement choice: phase worktrees for child targets live under the OWNING repo's `.baiton/worktrees/<slug>/<id>` rather than under the child. This keeps the child's main checkout free of an untracked `.baiton/` (which would dirty it and make discovery treat it as a Baiton repo) and keeps existing owner-root callers (View session, crash-recovery paths) valid, while the worktree itself is a checkout of the target repo so cwd/containment are still target-bound. A reviewer reading the OVERVIEW's 'worktree resolves against that repo' literally may expect `<child>/.baiton/worktrees`; the rationale should be stated in the phaseWorktree.ts doc comment.
- The child's plan branch `baiton/<slug>` is forked from the child's current HEAD on the first child-target dispatch, not from a configured base branch (a child may have no config). Per-repo PR submission (a later phase) must diff against that repo's configured base; if the child HEAD was not on its base at first dispatch, the PR may include extra commits.
- Cross-repo land creates and removes a temporary landing worktree checked out on `baiton/<slug>` in the child. If the user has `baiton/<slug>` checked out in a different linked worktree of the child, `addWorktreeOnBranch` fails and land refuses with git's message; the main-checkout case is handled explicitly. A crash between create and remove leaves a registered landing worktree, which the next land removes before re-adding.
- Adding `addWorktreeOnBranch` to `GitWorktreeService` breaks any test fake implementing the interface; only test/runPipeline.test.ts's FakeGit does today, but a grep for `implements GitWorktreeService` must be rerun before finishing.
- commands.ts wiring must stay lazy: activation-state fakes in tests may lack `repos`/`git`; touching them at `registerCommands` time would throw. ESLint may flag optional chaining on the non-optional `repos` field; use an explicit guard instead if so.
- readTools now enumerate from `tc.ctx.repoRoot` (realpath'd). Output paths are root-relative so they are unchanged, but any test that built a GuardContext over a different root than services.repoRoot and relied on enumeration of services.repoRoot would change; the scan above found none.
- The full suite spawns git; in a sandbox it previously failed with EPERM and needed escalation (see P02 notes). Treat sandbox-only git EPERM failures as environmental, not regressions.
- Locking is intentionally untouched (phase queues remain outside the repo lock; plan-draft/run-pipeline exclusion stays as is) — a later phase converts it to a per-repo lock map; do not partially change it here.

## Acceptance

- `npm run compile` succeeds.
- `npm run lint` exits 0 with no new warnings (the pre-existing unused-variable warning in src/orchestrator/webviewProtocol.ts may remain).
- `npx mocha --no-config --require ts-node/register --extension ts test/phaseWorktree*.test.ts test/planStore*.test.ts test/repoDiscovery*.test.ts test/guard*.test.ts test/gitService.test.ts test/resultValidation*.test.ts test/engine.launcher.test.ts test/engine.askRelay.test.ts test/runStore.test.ts test/runWorktree.test.ts test/resultFlow*.test.ts test/runPipeline.test.ts` passes, including the new cross-repo, resolver, guard-binding and confinement tests.
- `npm test` passes in full (escalated if the sandbox blocks git subprocesses).
- A child-target phase's worktree is registered in the child repo only, its branch and `baiton/<slug>` exist only in the child, the child's main checkout branch/HEAD/status are unchanged by create and by land, and run artifacts written under the worktree's `.baiton/runs/` leave `git status` clean.
- Landing a child-target phase merges into the child's `baiton/<slug>` and leaves no landing or phase worktree registered; a conflict preserves the phase branch and worktree and leaves `baiton/<slug>` unchanged.
- Journals, stage artifacts, approval and input-rev reads for a child-target phase are written/read only under the owning repo's `.baiton/` (no file appears under `<child>/.baiton/`).
- With no `repo` hint (or no resolver/target supplied) every existing phaseWorktree, planStore, guard, launcher and integration test passes unchanged, demonstrating byte-identical single-repo behaviour.
- A GuardContext built with `guardWorkspaceForRepo` for a child repo rejects reads of parent and sibling paths, and read tools under it enumerate only the child's files.
- `git diff --check` reports nothing.
