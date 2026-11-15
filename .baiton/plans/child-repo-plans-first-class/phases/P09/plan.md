# Plan P09

## Steps

1. planLister: pure per-repo explorer source specs and (repo, slug) de-duplication

   In src/activation/planLister.ts (stays vscode-free):

   1. Add an exported pure builder that projects the discovered RepoSet into explorer source specs, one per `.baiton/` repo, built on the existing `planListingRepos(set)`:

   ```ts
   export interface PlanExplorerSourceSpec extends PlanListingRepo {
     /** Absolute repo root. */
     root: string;
     /** True for the conversation/workspace owner repo. */
     isOwner: boolean;
     /** False in Restricted Mode for non-owner repos, and for a repo whose .baiton/ config could not be loaded. */
     actionable: boolean;
   }
   export interface PlanExplorerSourceSpecDeps {
     ownerRoot: string;
     ownerBaitonDir: string;
     restricted: boolean;
     /** True when the repo (by RepoSet name) has a loaded .baiton/ configuration. */
     loaded(name: string): boolean;
   }
   export function planExplorerSourceSpecs(set: RepoSet | undefined, deps: PlanExplorerSourceSpecDeps): PlanExplorerSourceSpec[]
   ```

   Behaviour: `set === undefined` -> return `[]` (the explorer then falls back to its legacy single owner source, exactly as today). Otherwise iterate `planListingRepos(set)`; for each entry find the Repo by name in `set.repos` to get `root`; `isOwner = repoLockKey(root) === repoLockKey(deps.ownerRoot)` (import `repoLockKey` from '../engine' or the module that exports it — check it is vscode-free; if not, compare `path.resolve` of both); for the owner use `baitonDir: deps.ownerBaitonDir` (same convention as resolveLensTarget/resolvePlanTarget) and `actionable: true` (owner behaviour unchanged even in Restricted Mode: actions are hidden there via the `baiton.restricted` context key, and the click must still set the active plan); for every other repo `actionable: !deps.restricted && deps.loaded(entry.repo)`. Skip a second entry whose root has the same repoLockKey as one already emitted. Preserve planListingRepos order.

   2. Make `listPlansAcrossRepos` de-duplicate on (repo, baitonDir-key, slug): keep a `Set<string>` of `${repo}\u0000${slug}` and skip a pair already emitted; also skip a source whose baitonDir (path.resolve) was already listed. Order and failure isolation stay as today.

   Nothing else in planLister changes; `listPlans` stays exported (chatController still uses it).

   Files: `src/activation/planLister.ts`

2. planExplorer: single listing path, owning repo on every node, repo-aware openPlan

   In src/activation/planExplorer.ts:

   1. Widen the sink: `export type SetActivePlan = (slug: string | undefined, repo?: string) => void;` — `repo` is the owning source's `repo` (RepoSet name), undefined for the legacy fallback source. Update the PlanRepoSource.actionable doc comment to: "False in Restricted Mode for non-owner repos and for a repo whose .baiton/ cannot be loaded."

   2. refresh(): drop the `multiSource ? listPlansAcrossRepos : listPlans` branch. Always call `listPlansAcrossRepos(sources.map((s) => ({ repo: s.repo ?? '', baitonDir: s.baitonDir, topology: s.topology })))` and map each listed entry back to its source by `baitonDir` (`sources.find((c) => c.baitonDir === entry.baitonDir) ?? sources[0]`), not by repo name. Use `entry.baitonDir` for journals/phase plans. Remove the `listPlans` and `RepoListedPlan` imports if unused. Each PlanInput gets `...(source.repo !== undefined ? { ownerRepo: source.repo } : {})` always, while the label `repo` stays gated on `showRepoLabels` exactly as today (so single-source tree item labels/descriptions/ids are unchanged; nodes merely gain ownerRepo when the source is named). Pass `source.repo` (unchanged) to prsMergedFor/branchMergedFor.

   3. planItem(): build command arguments and id from the owning repo, still only when labels are shown so single-source output is byte-identical:
   ```ts
   const owner = node.repo === undefined ? undefined : node.ownerRepo ?? node.repo;
   item.command = { command: OPEN_PLAN_COMMAND, title: 'Open Plan', arguments: owner === undefined ? [node.slug] : [node.slug, owner] };
   if (owner !== undefined) item.id = `${owner}:${node.slug}`;
   ```
   Also give phase items a stable id in multi-source mode: `if (node.ownerRepo !== undefined && this.showRepoLabels) item.id = `${node.ownerRepo}:${node.slug}/${node.id}`;` (leave undefined otherwise, as today).

   4. treeNodeTarget(): unchanged return shape (`[slug]`, `[slug, phaseId]`); the owning repo travels on the node's `ownerRepo` which commands.ts `planArg` already reads. Update its doc comment to say so.

   5. openPlan(slug, repo?): resolve the source strictly: if `repo !== undefined`, `source = sources.find((c) => c.repo === repo)`; when none matches, `this.surface.error(`Baiton: could not open plan "${slug}" in ${repo}: that repo is not a discovered .baiton/ repo.`)` and return without opening anything (today it silently falls back to the owner's document). If `repo === undefined`, keep today's lookup (`sources.find(c => c.baitonDir === this.baitonDir)` then the synthetic owner fallback). After a successful open, `if (source.actionable) this.setActivePlan?.(slug, source.repo);`.

   6. Update the file header comment: one source per discovered `.baiton/` repo; plan clicks pass the owning repo to the sink; de-duplication is by (repo, slug).

   Files: `src/activation/planExplorer.ts`

3. commands.ts: construct PlanExplorer with options.sources and repo-aware sink

   In src/activation/commands.ts near the `const explorer = new PlanExplorer(` block (~line 1344):

   1. Import `planExplorerSourceSpecs` from './planLister' (extend the existing `import { phasePlanPath } from './planLister'`) and the `PlanRepoSource` type from './planExplorer'.

   2. Build the sources callback (re-evaluated on each refresh, so it reads live `activation.repos` / `activation.repoConfigs` / `workspace.restricted`):
   ```ts
   const explorerSources = (): PlanRepoSource[] =>
     planExplorerSourceSpecs(activation.repos, {
       ownerRoot: repoRoot,
       ownerBaitonDir: baitonDir,
       restricted: workspace.restricted,
       loaded: (name) => activation.repoConfigs === undefined || activation.repoConfigs.has(name),
     }).map((spec) => ({
       repo: spec.repo,
       baitonDir: spec.baitonDir,
       topology: spec.topology,
       actionable: spec.actionable,
       isApproved: spec.isOwner
         ? (slug) => planStore.isApproved(slug)
         : async (slug) => (await phaseQueues.owner(spec.root)?.planStore.isApproved(slug)) ?? false,
     }));
   ```
   (`phaseQueues.owner(root)` lazily creates the per-repo owner entry via `queueOwners.ownerFor`; it never creates a queue. If `owner(...)` returns undefined the approval reads false.)

   3. Pass it: `new PlanExplorer(baitonDir, planStore, surface, workspace.restricted, (slug, repo) => { if (repo === undefined || repo === ownerRepoName()) chatController.setActivePlan(slug); }, { sources: explorerSources, prsMerged: prsMergedForPlan, branchMerged: branchMergedForPlan })`. The chat controller is not yet repo-qualified (a later phase changes `activePlan` to `{ repo, slug }`); until then a child-repo click opens that repo's document but must not retarget the chat to a same-named owner plan. Add a short comment saying so.

   4. Inline actions already flow through `planArg`/`phaseArgs`, which read `node.ownerRepo` into `repoName`, and `resolvePlanTarget` resolves `repoName` via `repoByName` -> `planRepos.targetAt`. Verify `prsMergedForPlan` / `branchMergedForPlan` accept `query.repo` as a RepoSet name (they already receive `source.repo`, unchanged). No other command signature changes.

   No change to CodeLens, chat controller, or engine facade in this phase.

   Files: `src/activation/commands.ts`

4. Tests: planLister source specs and de-duplication

   In test/planLister.test.ts add:
   - `planExplorerSourceSpecs(undefined, deps)` returns `[]`.
   - With a RepoSet of root '.' (baitonDir), 'packages/api' (baitonDir) and 'packages/web' (no .baiton): returns two specs in order; owner has `isOwner: true`, `baitonDir === deps.ownerBaitonDir`, `actionable: true`; api has `isOwner: false`, `root` = its root, topology owner 'packages/api', `actionable: true` when `restricted: false` and `loaded` true.
   - `restricted: true` -> api `actionable: false`, owner still `actionable: true`.
   - `loaded: (n) => n !== 'packages/api'` -> api `actionable: false`.
   - A single-repo set yields exactly one owner spec.
   - `listPlansAcrossRepos` given the same source twice lists each (repo, slug) once; two repos with the same slug ('alpha') still yield two entries (existing test already covers this — keep it).

   Files: `test/planLister.test.ts`

5. Tests: Plan Explorer per-repo sources, owning repo and openPlan

   In test/planExplorer.test.ts (reuse the existing fake vscode harness, `repoTopologies`, `validPlan`):
   - Keep 'lists plan and legacy roots…' unchanged (legacy fallback single source: args `['alpha']`, id undefined, plan node has no ownerRepo).
   - New: a single named source `[{ repo: '.', baitonDir, actionable: true, … }]` -> descriptions have no repo prefix, command args `['alpha']`, id undefined, but `node.ownerRepo === '.'` on plan and phase nodes; one watcher.
   - New: two sources both actionable where owner and 'packages/api' each have plan 'alpha' -> two distinct 'alpha' rows; ids `'.:alpha'` and `'packages/api:alpha'`; api row contextValue is `planContextValue(...)` with its legal actions (not `planContextValue([])`), its phase contextValue non-empty; phase nodes carry `ownerRepo: 'packages/api'` and `repo` (target) stays undefined; `treeNodeTarget` still `['alpha', 'P01']`; phase item ids distinct; approval read from the api source's isApproved (make it return true for 'alpha' and assert the api row is in Active, the owner row in Pending).
   - New: `openPlan('alpha', 'packages/api')` opens the child document and calls the sink with `('alpha', 'packages/api')` (record both args); `openPlan('alpha', '.')` calls it with `('alpha', '.')`.
   - New: `openPlan('alpha', 'nope')` opens nothing, calls `surface.error` once, and does not call the sink.
   - Update the existing 'lists and labels multiple repos while keeping non-primary rows action-free' test only as needed for the sink now receiving `(slug, repo)` (it should still pass: non-actionable child click never calls the sink).

   Files: `test/planExplorer.test.ts`

6. Build and verify

   Run `npm run compile`, `npm run lint`, `npx mocha --grep "PlanExplorer|plan lister"`, then the full `npm test` (use `--timeout 60000` if the known tree-model property test times out; sandboxed runs may hit spawnSync git EPERM and need an unsandboxed rerun). Run `git diff --check`. Confirm only the five listed files changed.

   Files: (none)

## Risks

- Single-repo byte-identity: the owner source must stay `actionable: true` even in Restricted Mode (today's behaviour — actions are hidden by the `baiton.restricted` when-clauses and the click still sets the active plan); making it false would empty the owner's contextValues and stop click-to-activate. Only non-owner sources go non-actionable in Restricted Mode.
- Command args / ids must stay `[slug]` / undefined when only one source exists; gate them on `showRepoLabels` (node.repo present), not on ownerRepo presence, because with discovery the single owner source is now named and nodes carry ownerRepo.
- ChatController.setActivePlan is still slug-only; forwarding a child-repo click would make the chat target a same-named owner plan. The sink wiring must drop non-owner repos until the chat-controller phase widens it. Comparing `repo` to `ownerRepoName()` relies on source.repo being the RepoSet name — keep it that way.
- `activation.repoConfigs` undefined in lightweight fixtures: treating that as 'loaded' keeps fixtures working; a repo absent from a present map is the only signal of a failed child config load.
- Mapping listed entries back to sources by repo name breaks for the legacy fallback source (repo undefined); map by baitonDir instead. Owner baitonDir must be the activation `baitonDir`, not discovery's, so the owner source and `this.baitonDir` compare equal in openPlan's fallback.
- Non-owner approval reads go through `phaseQueues.owner(root)`, which lazily creates that repo's plan store/writer; it must not create queues or write. If owner() is undefined (root not a discovered target), approvals read false rather than throwing (approvalFor already swallows rejections).
- openPlan previously fell back to the owner document for an unknown repo; the new strict refusal could surface errors for stale tree rows after a repo disappears — acceptable and safer than opening the wrong plan.

## Acceptance

- `npm run compile` and `npm run lint` succeed with no new errors or warnings.
- Full `npm test` passes (existing plus new planLister/planExplorer tests).
- commands.ts constructs PlanExplorer with `options.sources` built from `planListingRepos` (via `planExplorerSourceSpecs`), one source per discovered `.baiton/` repo, each with its own isApproved, topology and actionable.
- PlanExplorer.refresh uses `listPlansAcrossRepos` as its only listing path, including the single-source case; `listPlans` is no longer imported by planExplorer.ts.
- Plan, phase and error nodes from a named source carry `ownerRepo` equal to the source repo; the phase `repo` target field is unaffected.
- With one source, tree labels, descriptions, contextValues, command arguments (`[slug]`) and ids (undefined) are identical to today.
- With several sources, plans with the same slug in two repos appear as two rows with ids `<repo>:<slug>`, command arguments `[slug, ownerRepo]`, and actionable child rows expose their legal inline actions; inline actions resolve through planArg's `repoName` to the child repo.
- Non-owner sources are not actionable in Restricted Mode or when their `.baiton/` config failed to load; the owner source's behaviour is unchanged.
- openPlan(slug, repo) opens that repo's document and calls the sink with (slug, repo) for actionable sources; an unknown repo surfaces an error and opens nothing; commands.ts forwards only owner-repo (or repo-less) clicks to chatController.setActivePlan.
- Only src/activation/planExplorer.ts, src/activation/planLister.ts, src/activation/commands.ts, test/planExplorer.test.ts and test/planLister.test.ts are modified.
