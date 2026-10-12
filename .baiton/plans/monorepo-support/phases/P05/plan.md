# Plan P05

## Steps

1. planLister: multi-repo listing helpers (pure, no vscode)

   In src/activation/planLister.ts keep `listPlans(baitonDir)`, `phasePlanPath` and `listPhasePlans` byte-for-byte compatible (the existing deepStrictEqual test on listPlans must still pass, so do NOT add keys to its output). Add:

   1. `export interface PlanListingRepo { repo: string; baitonDir: string; topology?: RepoTopology }` (import `type RepoTopology` from '../model/validator').
   2. `export interface RepoListedPlan extends ListedPlan { repo: string; baitonDir: string }`.
   3. `export async function listPlansAcrossRepos(repos: readonly PlanListingRepo[]): Promise<RepoListedPlan[]>` — for each repo in the given order, `await listPlans(repo.baitonDir)` and tag every entry with `{ repo: repo.repo, baitonDir: repo.baitonDir }`; output order is repo order, then ascending slug inside a repo (whatever listPlans returns). A missing/unreadable `.baiton` simply contributes nothing (listDocumentSlugs already tolerates this; wrap in try/catch to be safe so one bad repo never drops the others).
   4. `export function planListingRepos(set: RepoSet): PlanListingRepo[]` — `reposWithBaiton(set).map((repo) => ({ repo: repo.name, baitonDir: repo.baitonDir as string, topology: repoTopologyFor(set, repo.name) }))` (import `type RepoSet`, `reposWithBaiton`, `repoTopologyFor` from './repoDiscovery'). This is the ready-made source list a later phase's commands.ts wiring will feed to the explorer.

   Files: `src/activation/planLister.ts`

2. treeModel: carry owning repo on plans and target repo on phases

   In src/model/treeModel.ts:

   - Extend `PlanInput` with optional `repo?: string` (owning repo name), `topology?: RepoTopology` and `actionable?: boolean` (default true).
   - Extend `PlanNode` with optional `repo?: string` and `PhaseNode` with optional `repo?: string` (the TARGET repo name, set ONLY when it differs from the owning repo).
   - In `buildPlanNode`: spread `...(input.repo !== undefined ? { repo: input.repo } : {})` onto every returned PlanNode (unreadable, invalid and valid branches) so an absent repo leaves the key absent (keeps existing deepStrictEqual/property tests green). Call `validatePlan(parsed, input.raw, input.topology)` (third arg is already supported by P02; undefined keeps today's behaviour). When `input.actionable === false`, the valid branch uses `actions: []` instead of `legalPlanActions(...)`, and phase nodes get `actions: []`.
   - `buildPhaseNode` gains params `topology: RepoTopology | undefined` and `actionable: boolean`; compute `const binding = resolvePhaseRepo(phase.repo, topology)` (import `resolvePhaseRepo`, `type RepoTopology` from './validator'); when `binding.ok && !binding.isOwner` spread `{ repo: binding.target }`. A hint-less phase (every existing document) resolves to the owner and therefore gets no `repo` key — tree output is unchanged. Actions: `actionable ? legalActions(phase.state, hasSession, hasPlan) : []`.
   - Update the module doc comment with one sentence describing repo identity and the non-actionable flag.

   Files: `src/model/treeModel.ts`

3. runTreeModel: optional repo label and actionable flag per run

   In src/model/runTreeModel.ts:

   - Add `export interface RunTreeEntry { manifest: RunManifest; repo?: string; actionable?: boolean }`.
   - Add `repo?: string` to `RunNode` (doc: the repo whose `.baiton/runs` holds the manifest; present only when the caller supplies it).
   - Change `buildRunNode(manifest, live?, opts?: { repo?: string; actionable?: boolean })`: when `opts.actionable === false` force `actions = []` (contextValue then becomes `baiton.run.<group>` with no tokens). When `opts.repo` is defined: spread `{ repo }` onto the node, prefix description with `${repo} · ` (e.g. `packages/api · bug · executing`), and insert a `Repo: ${repo}` line into the tooltip right after the first `<mode> run <id>` line (pass repo into `buildTooltip`). Without opts the node is byte-identical to today.
   - Change `buildRunTree(entries: readonly (RunManifest | RunTreeEntry)[], live?)`: normalise each element with a small `isRunTreeEntry(x): x is RunTreeEntry` guard (`'manifest' in x && typeof x.manifest === 'object'` — RunManifest has no `manifest` key) and call `buildRunNode(entry.manifest, live, { repo: entry.repo, actionable: entry.actionable })`. Passing plain manifests (all existing callers and tests in test/runTreeModel.test.ts and test/runsExplorer.test.ts) must still work unchanged. Keep the module's 'never throws' guarantee.

   Files: `src/model/runTreeModel.ts`

4. PlanExplorer: list across repo sources and render repo labels

   In src/activation/planExplorer.ts:

   - Export `interface PlanRepoSource { repo: string; baitonDir: string; topology?: RepoTopology; isApproved(slug: string): Promise<boolean>; /** false for repos whose commands are not yet repo-aware */ actionable: boolean }` and `interface PlanExplorerOptions { sources?: () => readonly PlanRepoSource[] }`.
   - Add an optional 6th constructor parameter `options: PlanExplorerOptions = {}`. Private `sources(): readonly PlanRepoSource[]` returns `options.sources?.()` when it yields a non-empty list, else the implicit single source `[{ repo: undefined-equivalent, baitonDir: this.baitonDir, isApproved: (s) => this.planStore.isApproved(s), actionable: true }]` (model this as an internal type where `repo` may be undefined). `private get showRepoLabels(): boolean` is true only when more than one source is in play — a single-repo workspace renders exactly as today.
   - `start()`: create one FileSystemWatcher per source baitonDir (`new vscode.RelativePattern(source.baitonDir, '{plans,specs}/**')`), all scheduling the same debounced refresh. Register OPEN_PLAN_COMMAND with handler `(slug: string, repo?: string) => this.openPlan(slug, repo)`.
   - `refresh()`: use `listPlansAcrossRepos(sources.map(s => ({ repo: s.repo, baitonDir: s.baitonDir, topology: s.topology })))` when multi-source, else `listPlans(this.baitonDir)` (keep the single-source path textually equivalent). For each entry build PlanInput with `approved` from that source's `isApproved` (probe failure → false, as `approvalFor` does today), `sessions: sessionSet(readPlanJournal(entry baitonDir, slug))`, `plans: await listPhasePlans(entry baitonDir, slug)`, `kind: entry.kind`? (keep what is passed today — do not add kind if not passed now), plus `repo` (only when showRepoLabels), `topology: source.topology`, `actionable: source.actionable`. Journals and phase plans are always read from the OWNING repo's baitonDir.
   - `planItem`: `item.command.arguments` stays `[node.slug]` when `node.repo === undefined`, else `[node.slug, node.repo]`. `planDescription` prepends `node.repo` as the first ` · ` part when defined (e.g. `packages/api · no status · approved`). `planTooltip` adds `Repo: ${node.repo}` after the `Plan:` line when defined. Set `item.id = \`${node.repo}:${node.slug}\`` only when repo is defined (two repos may share a slug); leave id unset otherwise.
   - `phaseItem`: when `node.repo` is defined append ` · ${node.repo}` to the description (after state/blocked) and a `\nRepo: ${node.repo}` tooltip line. No change otherwise.
   - `openPlan(slug, repo?)`: find the source whose `repo === repo` (fallback: the implicit/primary source = this.baitonDir) and open `resolveDocument(source.baitonDir, slug).documentPath`; error text unchanged but include the repo when given (`could not open plan "${slug}" in ${repo}`). Call `this.setActivePlan?.(slug)` only when that source is actionable (the chat's active plan still resolves against the primary repo until a later phase).
   - Leave `treeNodeTarget` returning `[slug]` / `[slug, phaseId]` (commands are converted in a later phase; non-primary rows carry no action tokens so they cannot dispatch against the wrong repo). Update the file doc comment.

   Files: `src/activation/planExplorer.ts`

5. RunsExplorer: list runs across repo sources with repo labels

   In src/activation/runsExplorer.ts:

   - Export `interface RunRepoSource { repo: string; store: RunStore; runsDir: string; actionable: boolean }`.
   - Add optional 5th constructor param `sources?: readonly RunRepoSource[]`. Multi-repo mode is on only when `sources` has more than one entry; otherwise behaviour and output are exactly today's (single store, single watcher on `this.runsDir`, plain manifests into buildRunTree).
   - `start()`: in multi mode create one watcher per `source.runsDir` (`'*/run.json'`), all calling `scheduleRefresh`.
   - `refreshNow()`: in multi mode build `RunTreeEntry[]` by listing every source's store through a per-source safe list (log `could not list runs in ${repo}` on failure, continue), tag `{ manifest, repo: source.repo, actionable: source.actionable }`, then stable-sort the merged list by `manifest.createdAt` descending (string compare of ISO timestamps) so the view stays newest-first across repos; pass to `buildRunTree(entries, live)`.
   - `runItem`: `item.id = node.repo !== undefined ? \`${node.repo}:${node.runId}\` : node.runId`.
   - `runNodeTarget` and the three command handlers stay unchanged (non-primary runs carry no action tokens, so cancel/viewDiff/merge can only target the primary store the commands are bound to).

   Files: `src/activation/runsExplorer.ts`

6. Tests: lister and explorer coverage

   test/planLister.test.ts — add:
   (a) `listPlansAcrossRepos` over two baitonDirs (`<root>/.baiton` with plans/alpha and specs/zeta; `<root>/packages/api/.baiton` with plans/alpha and plans/beta) returns repo order then slug order, each entry tagged with `repo` and `baitonDir`, and a non-existent third baitonDir contributes nothing without throwing;
   (b) `planListingRepos` on a literal RepoSet (repos: '.' with baitonDir, 'packages/api' with baitonDir and parent '.', 'packages/web' without baitonDir) returns only the two `.baiton` repos in order, with `topology.owner` equal to each repo's name and topology listing all three repos;
   (c) existing tests stay unchanged and passing.

   test/planExplorer.test.ts — keep both existing tests and add assertions to the first: plan item descriptions have no repo label (`'no status'`), `item.command.arguments` deep-equals `['alpha']`, `item.id` undefined, phase description is exactly the state. Add new tests:
   (1) multi-repo: write `<root>/packages/api/.baiton/plans/api-plan/plan.md` (valid plan), construct the explorer with options.sources returning two sources (repo '.', baitonDir root/.baiton, actionable true, topology with repos '.'@root and 'packages/api'@root/packages/api parent '.'; repo 'packages/api', actionable false, topology owner 'packages/api'). Assert all three plans (alpha, beta, api-plan) appear in Pending in repo-then-slug order; alpha's description starts with '. · ' and api-plan's with 'packages/api · '; tooltip contains 'Repo: packages/api'; api-plan's plan item contextValue equals planContextValue([]) and its phase contextValue equals phaseContextValue([]) (no action tokens); command arguments are ['api-plan', 'packages/api']; the fake recorded two watchers.
   (2) phase target label: a root plan whose phase line is `- [pending] P01 Implement the plan (repo: packages/api)` with the topology above renders the phase description `pending · packages/api` and is valid; the same plan with `(repo: ../elsewhere)`-style unknown target renders as invalid with an error child.
   Use the existing vscode fake/loader setup; extend the fake's watcher record to count created watchers if needed.

   If the scope guard permits touching test/runTreeModel.test.ts, add a focused case for `buildRunTree([{ manifest, repo: 'packages/api', actionable: false }])` (description prefix, 'Repo:' tooltip line, empty actions) and one asserting plain-manifest input is unchanged; otherwise cover it by asserting via the RunsExplorer is out of scope and rely on the existing runTreeModel/runsExplorer suites for regression.

   Files: `test/planLister.test.ts`, `test/planExplorer.test.ts`

7. Verify

   Run `npm run compile`, `npm run lint`, focused `npx mocha --no-config --require ts-node/register --extension ts test/planLister.test.ts test/planExplorer.test.ts test/runTreeModel.test.ts test/runsExplorer.test.ts test/treeModel.property.test.ts`, then `npm test` (git subprocess tests may need host permissions as in P01/P02). Run `git diff --check`. Confirm no file outside the listed set (plus the optional runTreeModel test) changed, and that src/activation/commands.ts and src/extension.ts compile unchanged against the new optional constructor parameters.

   Files: (none)

## Risks

- src/activation/commands.ts and src/extension.ts are outside this phase's file list, so the explorers' new multi-repo `sources` parameters are not wired at activation in this phase; production still shows only the primary repo until the commands phase passes `planListingRepos(activation.repos)` (with per-repo isApproved) and RunRepoSource lists. Keep all new parameters optional so existing call sites compile unchanged.
- Plan/phase/run rows from non-primary repos must be action-free (actionable: false): today's commands resolve slugs and run ids against the single primary baitonDir/RunStore, so an Approve/Execute/Merge on a child-repo row could act on a same-slug plan or missing run in the primary repo.
- Single-repo output must stay byte-identical: never add `repo` keys, ids, description prefixes or command arguments unless more than one source is in play; existing deepStrictEqual and property tests (treeModel.property, runTreeModel, runsExplorer, planLister) pin this.
- Passing topology to validatePlan in the tree model changes validity only for phases with a `repo` hint; hint-less documents validate exactly as before. Without topology (default single-source path) a child-target hint still reports 'unknown', matching current behaviour.
- buildRunTree's union input relies on RunManifest never having a `manifest` key; keep the guard narrow.
- Watchers are created per source at start(); repos whose `.baiton/` appears after activation are not watched until reload (acceptable for this phase, note in a comment).
- Merged run ordering across repos sorts by createdAt; manifests with malformed timestamps should sort stably rather than throw.

## Acceptance

- `npm run compile` and `npm run lint` pass (only the pre-existing webviewProtocol.ts warning).
- `npm test` passes, including unchanged existing suites for planLister, planExplorer, treeModel.property, runTreeModel and runsExplorer.
- listPlans(baitonDir) output is unchanged; listPlansAcrossRepos returns plans from every given `.baiton/` tagged with repo and baitonDir, ordered by repo then slug, tolerating a missing directory.
- planListingRepos(RepoSet) returns exactly the repos with a `.baiton/` in discovery pre-order with a topology owned by each.
- With a single source the Plan Explorer renders exactly as before (no repo label, no item id, command arguments [slug], one watcher).
- With multiple sources the Plan Explorer lists plans from every repo, prefixes plan descriptions and tooltips with the owning repo, passes [slug, repo] to the open command, opens the document from the owning repo's `.baiton/`, and gives non-primary rows no action tokens.
- A phase whose `repo` hint resolves to a child repo shows that target repo in its description and tooltip; hint-less phases show no repo label; an unknown/sibling/ancestor hint renders the plan invalid with an error child.
- RunNode carries an optional repo label (description prefix and 'Repo:' tooltip line) and RunsExplorer lists runs from every supplied source newest-first; with zero or one source its output is unchanged.
- No files outside the phase's listed files (plus optionally test/runTreeModel.test.ts) are modified.
