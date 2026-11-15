# Plan P07

## Steps

1. Wire per-repo phase-queue owners into the facade and share them with land/submit

   In registerCommands (src/activation/commands.ts, around lines 489-544):
   1. Import `createPhaseQueueOwners` (and type `GitWorktreeService` if needed) from './engineFacade'.
   2. Build `const queueOwners = createPhaseQueueOwners({ sourceAt: (root) => { const t = planRepos.targetAt(root); return t === undefined ? undefined : { root: t.root, baitonDir: t.baitonDir, git: t.git as <same cast used for planWriter today>, topology: t.topology }; }, gitFor });` and pass `owners: (root) => queueOwners.ownerFor(root)` into the existing `createPhaseQueues({...})` call. The default owner (repoRoot/baitonDir/git/planWriter/planStore/phaseTargets) stays exactly as it is, so single-repo behaviour is unchanged.
   3. Rework `planRepoRuntimeFor(root)` so it no longer builds its own `createPlanBranchWriter`/`createPhaseTargetResolver` for child repos: resolve `const owner = phaseQueues.owner(root)` (closure is called lazily, after phaseQueues exists) and return `{ target, phaseTargets: owner.targets!, planWriter: owner.planWriter }` (keep the cache map or drop it; the owner registry already caches). This guarantees one writer per child repo shared by queue state commits, land_phase and submit_pr. If `owner` or `owner.targets` is undefined return undefined (existing callers already report 'not a discovered repo').
   4. Change `queueFor` to `const queueFor: QueueFor = (slug, phaseId, root = repoRoot) => phaseQueues.queueFor(slug, phaseId, root);` and update the type aliases near line 1538: `type QueueFor = (slug: string, phaseId: string, repoRoot?: string) => RunQueue;` and `type FindQueue = (slug: string, phaseId: string, repoRoot?: string) => RunQueue | undefined;`. `createRunQueueSeam(queueFor, ...)` in buildToolServices still type-checks (extra optional param). Replace the child branch of landPhaseSeam's `phaseQueues.find(slug, phaseId, runtime.target.root)` usage as-is (already repo-keyed).

   Files: `src/activation/commands.ts`

2. Introduce a repo-qualified command target type and resolver

   Add (module-level, near the shared helpers section) in src/activation/commands.ts:

   ```ts
   /** A plan addressed by its owning repo, with the repo's .baiton/ and git resolved. */
   export interface PlanCommandTarget {
     slug: string;
     /** Absolute owning-repo root (repoLockKey-comparable). */
     root: string;
     baitonDir: string;
     git: GitService;            // the type PlanRepoTarget.git carries
     /** Repo path relative to the conversation owner ('.' for the owner). */
     repoPath: string;
     /** True when the plan lives in the workspace owner repo. */
     isOwner: boolean;
     /** Display label: bare slug for owner plans, `formatPlanRef(repoPath, slug)` otherwise. */
     label: string;
   }
   /** Unresolved command arguments: a slug (bare or `<repoPath>:<slug>`) plus an optional owning repo by name (tree nodes) or path (CodeLens/palette). */
   export interface PlanArg { slug?: string; repoName?: string; repoPath?: string }

   export interface PlanTargetDeps {
     planRepos: PlanRepoSeam;
     repos: () => RepoSet | undefined;
     ownerRoot: string;
     ownerBaitonDir: string;
     ownerGit: GitService;
     /** Chooser used on ambiguity; returns the chosen qualified ref or undefined. */
     choose: (items: string[], placeHolder: string) => Promise<string | undefined>;
   }
   ```

   Implement `export async function resolvePlanTarget(deps, arg: PlanArg & { slug: string }): Promise<{ ok: true; target: PlanCommandTarget } | { ok: false; error: string } | { ok: false; cancelled: true }>`:
   - `parsePlanRef(arg.slug)` (from '../orchestrator/planRepos'); on parse error return `{ ok:false, error }`. Qualified repo wins only if no explicit repo arg; if both given and they disagree, error.
   - repoName given: `repoByName(deps.repos(), name)` → `deps.planRepos.targetAt(repo.root)`; if repos() undefined and the name is '.' / the owner name, use the owner fallback (`planRepos.target('.')`). Unknown → error `repo "<name>" is not a discovered repo with a .baiton/ directory`.
   - repoPath given (from parsed ref or arg): `deps.planRepos.target(repoPath)`; `!ok` → its error.
   - Neither: `await deps.planRepos.locate(slug)`: `found` → its target; `ambiguous` → candidates `repos.map(p => formatPlanRef(p, slug))`, call `deps.choose(candidates, 'Plan "<slug>" exists in more than one repo')`; a pick is re-parsed and resolved by path; dismissal returns error `plan "<slug>" exists in more than one repo: <candidates joined ', '>; pick one as <repoPath>:<slug>`; `missing` → fall back to the owner target (today's behaviour: the queue/reader reports the missing plan); `invalid` → error.
   - Build the PlanCommandTarget from the PlanRepoTarget. Set `isOwner = repoLockKey(t.root) === repoLockKey(deps.ownerRoot)`; when isOwner, substitute `deps.ownerBaitonDir`/`deps.ownerGit` so owner-plan paths and git instances are byte-identical to today; `label = isOwner ? slug : formatPlanRef(t.info.path, slug)`.

   Keep this function free of direct `vscode` calls (the chooser is injected) so it is unit-testable.

   Files: `src/activation/commands.ts`

3. Qualified plan picker across all discovered repos

   Replace `pickPlanSlug(baitonDir)` and `promptForSlug(workspace, prompt)` with `export async function pickPlanTarget(deps: PlanTargetDeps & { quickPick: (items: string[], placeHolder: string) => Promise<string | undefined>; input: (prompt: string) => Promise<string | undefined> }): Promise<PlanCommandTarget | undefined>`:
   - `const infos = deps.planRepos.owners();` For each info resolve `deps.planRepos.target(info.path)` (skip !ok), list `listDocumentSlugs(t.baitonDir).filter(s => fs.existsSync(resolveDocument(t.baitonDir, s).documentPath))`. For the owner repo use ownerBaitonDir (same as today).
   - If `infos.length <= 1`: items are the bare slugs, exactly as today (`showQuickPick(slugs, { placeHolder: 'Select a plan' })`; empty → `showInputBox({ prompt: 'Plan slug' })`). The picked string is resolved through `resolvePlanTarget` (a typed qualified slug still works).
   - If more than one repo: items are `formatPlanRef(info.path, slug)` for every (repo, slug) pair in owners() order (the repo label is the qualified prefix, so same-slug plans appear twice), placeHolder 'Select a plan'; resolve the pick via `resolvePlanTarget({ slug: pick })` (which now has an explicit repo, so no ambiguity).
   - Wire real vscode: `quickPick: (items, placeHolder) => vscode.window.showQuickPick(items, { placeHolder })`, `input: (prompt) => vscode.window.showInputBox({ prompt })`, `choose` same as quickPick.
   - In registerCommands, build one `const planTargets: PlanTargetDeps & {...} = { planRepos, repos: () => activation.repos, ownerRoot: repoRoot, ownerBaitonDir: baitonDir, ownerGit: git, choose, quickPick, input }` and pass it to every command helper below instead of `baitonDir`. Delete `promptForSlug` (runApprove uses pickPlanTarget too; the unused `_prompt` parameter goes away).

   Files: `src/activation/commands.ts`

4. Argument normalisers carry the owning repo

   Rewrite `slugArg` and `phaseArgs` (bottom of commands.ts):
   - `export function planArg(arg: TreeNode | string | undefined, repo?: string): PlanArg` — string → `{ slug: arg, ...(repo ? { repoPath: repo } : {}) }`; undefined → `{}`; tree node of kind 'plan'/'phase'/'error' → `{ slug: node.node.slug, ...(node.node.ownerRepo !== undefined ? { repoName: node.node.ownerRepo } : {}) }` (use `treeNodeTarget` for the slug as today; read `ownerRepo` from the node; never use the PhaseNode `repo` field, which is the phase *target* repo).
   - `export function phaseArgs(a, b?: string, c?: string): PlanArg & { phaseId?: string }` — tree node → planArg(node) + phaseId from treeNodeTarget; strings → `{ slug: a, phaseId: b, ...(c ? { repoPath: c } : {}) }` so a CodeLens/palette caller can pass `(slug, phaseId, repoPath)` or a qualified slug.
   - Every registerCommand callback accepts the extra trailing optional argument (`(a?, b?, c?)` for phase commands, `(arg?, repo?)` for plan commands) and forwards it.

   Replace `resolveTarget(baitonDir, slugArg, phaseArg, surface)` with `resolvePhaseTarget(deps, arg: PlanArg & { phaseId?: string }, surface): Promise<(PlanCommandTarget & { phaseId: string }) | undefined>`: no slug → `pickPlanTarget`; else `resolvePlanTarget`; on `{ok:false,error}` → `surface.warn(`Baiton: ${error}`)`; on cancel / nothing picked → `surface.warn('Baiton: no plan selected.')` (unchanged text); then phase id input box exactly as today.

   Files: `src/activation/commands.ts`

5. Stage, action and view commands dispatch per (repo, slug, phase)

   - `registerStageCommand` / `registerActionCommand` / `registerViewCommand` / `runStage` take `planTargets` instead of `baitonDir` (and the view command no longer needs `repoRoot`). Update the five call sites at ~lines 1093-1106; the view's findQueue becomes `(slug, phaseId, root) => phaseQueues.find(slug, phaseId, root ?? repoRoot)`.
   - runStage: after `ensureCanDispatch`, `const target = await resolvePhaseTarget(...)`; `dispatchAndReport(queueFor(target.slug, target.phaseId, target.root), target.baitonDir, trigger, ...)`. dispatchTrigger reads the journal from `target.baitonDir`, so child plans count attempts/resume from their own journal.
   - registerActionCommand: same, for both `stop` (`queueFor(slug, phaseId, target.root)`) and replan.
   - `runView(activation, target, findQueue, adapterForRole, terminalHost, surface)`: `findQueue(target.slug, target.phaseId, target.root)`, `readPlanJournal(target.baitonDir, slug)`, `phaseWorktreeDirFor(target.root, slug, phaseId)`, cwd fallback `target.root`.
   - Trigger and log text: `describeTrigger` keeps `slug/phaseId`; for non-owner targets prefix with the qualified label (e.g. use `target.label` in place of `slug` in warnings like `no session recorded for <label>/<phase>` and `nothing to stop for <label>/<phase>`). For owner targets `label === slug`, so text is byte-identical.

   Files: `src/activation/commands.ts`

6. Approve, Submit PR, Show PR and View plan resolve the plan's repo

   - `runApprove(registry, workspace, surface, planTargets, arg: PlanArg)`: target = arg.slug ? resolvePlanTarget : pickPlanTarget; call `registry.call('approve_plan', target.isOwner ? { slug } : { slug, plan_repo: target.repoPath }, ...)` (the tool binds its own guard to the plan repo; Restricted Mode is still enforced by the tool's guard). callId and info/warn text use `target.label`.
   - `runSubmitPr(activation, planTargets, surface, submit: (slug, root?) => Promise<SubmitPrOutcome>, arg)`: keep `ensureCanDispatch(..., 'pr-writer')` first; resolve target; modal/log/info text use `target.label`; call `submit(target.slug, target.isOwner ? undefined : target.root)` so the owner path is the same call as today and child plans go through `submitPrForSlug`'s planRepoRuntimeFor branch (base/remote/PR tool from that repo via repoGitSettingsFor).
   - `runShowPr(planTargets, surface, arg)`: read `resolveDocument(target.baitonDir, target.slug).documentPath`.
   - `runViewPlan(planTargets, surface, a, b, c)`: resolve target (picker when no slug, warn 'Baiton: no plan selected.' on none); `pickPlannedPhaseId(target.baitonDir, ...)`, `phasePlanPath(target.baitonDir, slug, phaseId)`; `plannedPhaseIds(baitonDir, slug)` unchanged signature, just fed target.baitonDir.
   - Update the registerCommand callbacks for approve/submitPr/showPr/viewPlan to build `planArg(arg, repo)` / `phaseArgs(a, b, c)`.
   - Do NOT touch PlanCodeLensProvider, the PlanExplorer construction, the editor-follow handler or ChatController wiring (later phases); they keep compiling because the old `slug`-only call shapes remain valid inputs (a bare string resolves through locate).

   Files: `src/activation/commands.ts`

7. Unit tests for target resolution, picker and argument normalisation

   Add a new `describe('plan command targets (repo, slug)', ...)` block to test/runCommands.test.ts. In `before`, register the vscode loader exactly like the existing block and `await import('../src/activation/commands')` (set `globalThis.__vscodeFake` with the minimal `window/commands/workspace/languages/env/Uri/Disposable` members module load needs; if importing commands.ts at module load touches more host APIs, add them to the fake rather than changing production code). Build a real temp layout: an owner dir `ws/` with `.baiton/plans/alpha/plan.md` and `.baiton/plans/shared/plan.md`, and a child `ws/child/` with `.baiton/plans/beta/plan.md` and `.baiton/plans/shared/plan.md` (plain files are enough; `git init` each if PlanRepoTarget creation needs it — gitFor can return a stub object). Use `createPlanRepoSeam` with a hand-built RepoSet (owner name '.', child name 'child', baitonDirs set, parent/children links) and `exists` via fs.
   Cases:
   1. Single repo (repos: () => undefined): `pickPlanTarget` offers exactly the bare slugs `['alpha','shared']` and resolves `alpha` to `{ root: ws, baitonDir: ws/.baiton, isOwner: true, label: 'alpha' }` with the ownerBaitonDir/ownerGit instances (strictEqual).
   2. Multi repo picker items are `['.:alpha', '.:shared', 'child:beta', 'child:shared']` (owners() order) and picking `child:beta` yields root ws/child, baitonDir ws/child/.baiton, isOwner false, label 'child:beta'.
   3. `resolvePlanTarget({ slug: 'beta' })` resolves uniquely to the child; `{ slug: 'child:shared' }` resolves to the child; `{ slug: 'shared' }` calls `choose` with `['.:shared','child:shared']`, a dismissed chooser returns an error naming both candidates and no target; choosing `child:shared` resolves the child.
   4. `{ slug: 'shared', repoName: 'child' }` (tree-node form) and `{ slug: 'shared', repoPath: 'child' }` (CodeLens form) both resolve to the child without calling choose; an unknown repoName errors.
   5. `{ slug: 'nope' }` (missing everywhere) falls back to the owner target.
   6. `planArg`/`phaseArgs`: a phase TreeNode with `ownerRepo: 'child'` and a phase-target `repo: 'other'` yields `{ slug, phaseId, repoName: 'child' }` (never 'other'); a node without ownerRepo yields no repo field; `phaseArgs('s','P01','child')` yields repoPath 'child'.
   7. Facade wiring: `createPhaseQueues` with an `owners` function returning a child owner gives distinct queues for `queueFor('shared','P01', ws)` vs `queueFor('shared','P01', ws/child)` (can reuse helpers pattern from test/engineFacade.resume.test.ts if simple; otherwise skip — P06 already covers the facade).

   Files: `test/runCommands.test.ts`

8. Verify

   Run `npm run compile`, `npm run lint`, `npm test` (rerun unsandboxed if git subprocesses fail with EPERM, as earlier phases did) and `git diff --check`. Confirm only src/activation/commands.ts and test/runCommands.test.ts changed.

   Files: `src/activation/commands.ts`, `test/runCommands.test.ts`

## Risks

- Importing src/activation/commands.ts under the vscode fake may touch host APIs at module load (it pulls in chatController, webviews, explorers); the test fake may need extra stub members. Do not alter production code just to make the import succeed beyond exporting the new helpers.
- planRepoRuntimeFor currently builds its own PlanBranchWriter for child repos; if it is not switched to phaseQueues.owner(root), a child plan would have two writers and land_phase could interleave with queue state commits. Reference phaseQueues lazily inside the closure to avoid a TDZ error.
- Owner targets must use the existing workspace `baitonDir`/`git` instances and the default queue (root = repoRoot) so single-repo journals, queue keys, log text and submit_pr calls stay byte-identical; compare roots with repoLockKey, not raw strings (symlinked/canonicalized roots).
- TreeNode.ownerRepo is a repo *name* (planLister uses repo.name) while string arguments carry repo *paths*; keep the two lookups separate (repoByName vs planRepos.target) and never read PhaseNode.repo, which is the phase target repo.
- A bare slug that is missing everywhere falls back to the owner (today's behaviour); a bare slug present in 2+ repos must never pick silently — it goes through the chooser and errors on dismissal with `<repoPath>:<slug>` candidates.
- Slugs containing ':' are not valid plan slugs, but parsePlanRef splits on the last colon; absolute repo roots on Windows (C:/...) still parse because the split is on the last colon.
- CodeLens, Plan Explorer sources and ChatController activePlan are out of scope for this phase; leave their call sites compiling with bare slugs.

## Acceptance

- npm run compile succeeds with no type errors.
- npm run lint reports no new errors.
- npm test passes in full, including the new 'plan command targets (repo, slug)' tests.
- In a single-repo workspace the palette picker shows the same bare slug list and every command (plan/execute/review/replan/stop/view/approve/submit PR/show PR/view plan) uses the workspace baitonDir, git and default queue exactly as before.
- With more than one discovered .baiton repo the picker lists every repo's plans as `<repoPath>:<slug>`, and a child pick dispatches through phaseQueues.queueFor(slug, phase, childRoot), reads the child journal/phase plans/plan document, approves via approve_plan with plan_repo, and submits via submitPrForSlug(slug, childRoot).
- A bare slug present in two repos is never resolved silently: the chooser offers the qualified candidates and dismissal reports them as `<repoPath>:<slug>`.
- Tree-node arguments use the node's ownerRepo (not the phase target repo) to select the owning repo.
- Child-repo land_phase/submit_pr share the per-repo PlanBranchWriter owned by the phase-queue owner registry.
- git diff --check is clean and only src/activation/commands.ts and test/runCommands.test.ts are modified.
