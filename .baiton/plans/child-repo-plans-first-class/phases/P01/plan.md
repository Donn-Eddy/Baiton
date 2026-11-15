# Plan P01

## Steps

1. Add small pure lookup helpers to repo discovery

   In src/activation/repoDiscovery.ts add, next to repoByName/repoFor/reposWithBaiton (no behaviour change to discoverRepos, DISCOVERY_SKIP_DIRS or any existing export):

   1. `export function repoByRoot(set: RepoSet, root: string): Repo | undefined` — returns `set.repos.find((r) => path.resolve(r.root) === path.resolve(root))`.
   2. `export function planOwnerRepoFor(set: RepoSet, absPath: string): Repo | undefined` — the deepest repo (reuse `repoFor`) containing `absPath`, returned only when it has a `baitonDir` AND `absPath` lies inside that `baitonDir` (path.relative check, same style as repoFor). This is what later phases (CodeLens, engine facade) use to map a plan document path back to its owning repo.

   Keep the module pure (only `path` and the RepoTopology type import). `reposWithBaiton` already exists and is reused by planRepos.ts; do not change it. Phase worktrees live under `.baiton/worktrees`, which discovery skips because `.baiton` is in DISCOVERY_SKIP_DIRS — leave that untouched.

   Files: `src/activation/repoDiscovery.ts`

2. Widen and document the seam types in seams.ts

   In src/orchestrator/seams.ts:

   - Update the `PlanRepoInfo` doc: `path` is relative to the conversation's owning repo ('.' for the owner, `packages/api` for a descendant). For a repo outside the owner's subtree it is the POSIX `path.relative(ownerRoot, repoRoot)` (e.g. `../sibling`); if that relative path is absolute (different drive on Windows), it is the repo root with forward slashes. Field shape unchanged (`path`, `name`, `hasBaiton`).
   - Keep `PlanRepoTarget` unchanged.
   - Keep `PlanRepoLookup` as `found | missing | ambiguous { repos: readonly string[] }` (repos are `PlanRepoInfo.path` values, owner first then discovery pre-order) and ADD one variant `{ kind: 'invalid'; error: string }`, returned only when an explicit `repo` argument does not resolve. Document that callers turn `ambiguous.repos` into `<repoPath>:<slug>` candidates with `formatPlanRef`.
   - Change `PlanRepoSeam` to:
   ```ts
   export interface PlanRepoSeam {
     /** Phase-target / repo-context view: owner first, then descendants in pre-order (with or without .baiton/). Unchanged. */
     list(): readonly PlanRepoInfo[];
     /** Plan-addressing view: every discovered repo with a .baiton/ — owner first (when it has one), then the rest in discovery pre-order. Never phase worktrees. */
     owners(): readonly PlanRepoInfo[];
     /** Forward lookup: a repo path (relative to the owner, '.' = owner, '../x' allowed) to a writable target, for any discovered repo with a .baiton/. */
     target(repoPath: string): { ok: true; target: PlanRepoTarget } | { ok: false; error: string };
     /** Forward lookup by absolute repo root (for activation callers keyed by root). */
     targetAt(root: string): PlanRepoTarget | undefined;
     /** Find the repo holding the plan (or legacy spec) for a bare slug. With `repo`, look only there. No precedence: a slug in 2+ repos is ambiguous. */
     locate(slug: string, repo?: string): Promise<PlanRepoLookup>;
   }
   ```
   - Update the `DraftPlanRequest.repo` doc to say 'owning repo path relative to the conversation repo (see PlanRepoInfo.path)'.

   `list()` intentionally keeps today's subtree semantics so draft_plan's `repos` payload and ChatController's repoContext (prompt text) are byte-identical; widening applies to `owners()`, `target`, `targetAt` and `locate`. Check no other implementers of PlanRepoSeam exist besides createPlanRepoSeam and the spread-based stub in test/planWriteTools.repo.test.ts (which spreads a real seam, so it picks up new members).

   Files: `src/orchestrator/seams.ts`

3. Add the qualified <repoPath>:<slug> parser and formatter

   In src/orchestrator/planRepos.ts export two pure functions (no vscode, no fs):

   ```ts
   export type PlanRef = { repo?: string; slug: string };
   /** Parse `slug` or `<repoPath>:<slug>`. Splits on the LAST ':' (slugs never contain ':'; Windows drive letters may). */
   export function parsePlanRef(input: string): { ok: true; ref: PlanRef } | { ok: false; error: string };
   /** `<repoPath>:<slug>`; repoPath is normalized ('' -> '.'). */
   export function formatPlanRef(repoPath: string, slug: string): string;
   ```
   Rules for parsePlanRef: trim input; empty -> error `empty plan reference`. No ':' -> `{ ok: true, ref: { slug } }` (no repo key). Otherwise repo = text before last ':', slug = text after; empty slug -> error `plan reference "<input>" has no slug`; empty repo part -> error `plan reference "<input>" has an empty repo path`; repo part normalized with the shared `normalizeRepoPath` (below). The parser does NOT validate slug syntax (tools keep using isSlug). formatPlanRef(normalizeRepoPath(repo) ?? repo, slug) joined with ':'. Round-trip: parsePlanRef(formatPlanRef(p, s)) yields { repo: p, slug: s } for normalized p.

   Replace the internal `normalizedPath` with an exported-or-module-level `normalizeRepoPath(repoPath: string): string | undefined`: trim, backslashes -> '/', `path.posix.normalize`, strip trailing '/', '' or './' -> '.'. Unlike today it ALLOWS leading '../' segments (repos outside the subtree are now addressable). For an absolute input (starts with '/' or /^[A-Za-z]:/) return the normalized absolute POSIX string so it can match an out-of-relative-range repo path; matching against known repo paths (next step) is what decides validity, so nothing outside the discovered set ever resolves.

   Files: `src/orchestrator/planRepos.ts`

4. Rewrite createPlanRepoSeam over every .baiton/ repo

   In src/orchestrator/planRepos.ts rework createPlanRepoSeam (keep PlanRepoSeamDeps unchanged so commands.ts and tests compile untouched):

   - `snapshot()` unchanged (set + owner by resolved root; use the new `repoByRoot`).
   - Fallback (set undefined OR owner not found in set): exactly today's synthetic owner target (`makeFallback`, info `{ path: '.', name: '.', hasBaiton: true }`). `list()` and `owners()` return `[fallbackInfo]`; `target(p)` succeeds only for normalized '.', else error `repo "<p>" is not a discovered repo with a .baiton/ directory`; `targetAt(root)` returns the fallback only when path.resolve(root) === ownerRoot; `locate(slug, repo?)`: if repo given and not '.', return `{ kind: 'invalid', error: ... }`; else exists(resolveDocument(fallback.baitonDir, slug).documentPath) ? found : missing.
   - `infoFor(repo, owner)`: `rel = path.relative(owner.root, repo.root)`; if `path.isAbsolute(rel)` use `repo.root.split(path.sep).join('/')`, else `rel.split(path.sep).join('/') || '.'`. Descendant paths are therefore identical to today.
   - `subtreeRepos()` = today's `listedRepos().repos` (owner + isWithinSubtree descendants). `list()` maps it with infoFor — unchanged output.
   - `ownerRepos()` = `[owner if owner.baitonDir, ...reposWithBaiton(set).filter(r => r.name !== owner.name)]` (discovery pre-order). `owners()` maps with infoFor.
   - `makeTarget(repo, owner, set)` unchanged (topology = `repoTopologyFor(set, repo.name)`, guard bound to repo.root + repo.baitonDir with `deps.restricted()`), so containment stays that repo's own .baiton/plans and .baiton/specs.
   - `target(repoPath)`: normalized = normalizeRepoPath(repoPath); find in `set.repos` (ALL discovered repos, so we can give a precise error) the repo whose infoFor(...).path === normalized. Not found -> `{ ok:false, error: 'repo "<repoPath>" is not a discovered repo with a .baiton/ directory' }`. Found but no baitonDir -> keep today's exact error `repo "<repoPath>" has no .baiton/ directory; initialize Baiton there first`. Else makeTarget.
   - `targetAt(root)`: repoByRoot(set, root); undefined or no baitonDir -> undefined; else makeTarget.
   - `locate(slug, repo?)`: if `repo !== undefined`, resolve via `target(repo)`; on failure return `{ kind: 'invalid', error }`; else found/missing by exists on that target's baitonDir. Without repo: check every repo in `ownerRepos()` in parallel (Promise.all over exists(resolveDocument(r.baitonDir!, slug).documentPath)), keep order; 0 -> missing; >1 -> `{ kind: 'ambiguous', repos: matches.map(infoFor path) }`; 1 -> found(makeTarget). DELETE the owner-first short-circuit entirely — no precedence.
   - Update the function's doc comment: plan addressing spans every discovered repo with a .baiton/ (phase worktrees excluded by discovery), list() stays the owner subtree, degenerates to the synthetic owner with no discovery or a single repo.
   - `isWithinSubtree` import stays (used by subtreeRepos); add `repoByRoot`, `reposWithBaiton` imports.

   Callers: src/orchestrator/planWriteTools.ts (`locate(slug)`) keeps compiling — its existing ambiguous message stays for now (later phase replaces it); it treats the new 'invalid' kind like missing, which is unreachable because it never passes repo. Add an explicit `if (located.kind === 'invalid') return { ok:false, error:{ ok:false, error: located.error } }` there only if TS narrowing requires it; otherwise leave planWriteTools untouched. src/orchestrator/controlTools.ts draft_plan and commands.ts draftPlan.draft call `target()` unchanged; note draft_plan with `repo: '../sibling'` now succeeds when that sibling is discovered with a .baiton/ (intended widening).

   Files: `src/orchestrator/planRepos.ts`

5. Rewrite and extend test/planRepos.test.ts

   Update the two existing tests and add new ones (mocha + assert, tmp dirs as today, reuse the `repo()` and `writePlan()` helpers):

   1. 'lists the owner subtree and addresses every .baiton repo': same fixture as today. Assert `list()` is unchanged (owner, packages/api, packages/api/internal, packages/uninitialized). Assert `owners()` deep-equals `[ {'.','owner'}, {'packages/api','api'}, {'packages/api/internal','internal'}, {'../sibling','sibling'} ]` (all hasBaiton true; 'workspace' and 'no-baiton' excluded since no .baiton). `target('packages/api/../api')` still resolves (path, topology.owner 'api', guard.repoRoot). `target('../sibling')` now ok with info.path '../sibling', topology.owner 'sibling', guard.repoRoot siblingRoot, baitonDir sibling/.baiton. `target('..')` -> error `repo ".." is not a discovered repo with a .baiton/ directory` (workspace has no .baiton). `target('packages/uninitialized')` keeps the exact 'has no .baiton/ directory; initialize Baiton there first' error. `target('nope')` -> not-discovered error. `targetAt(siblingRoot)?.info.path === '../sibling'`, `targetAt(noBaitonRoot) === undefined`. Sibling guard refuses a mutating path inside owner/.baiton/plans (resolveMutatingPath(...).ok === false).
   2. 'locate has no precedence': same fixture as today's locate test plus a sibling with .baiton outside the owner. Owner + api both hold 'shared' -> `{ kind:'ambiguous', repos:['.', 'packages/api'] }` (replaces the old owner-wins assertion). api + nested 'ambiguous' -> repos ['packages/api','packages/api/nested']. Slug only in sibling -> found with info.path '../sibling'. Slug only in owner -> found '.'. 'missing' -> missing. `locate('shared', '.')` -> found owner; `locate('shared', 'packages/api')` -> found api; `locate('shared', 'packages/api/nested')` -> missing; `locate('x', 'bogus')` -> kind 'invalid'. Also a legacy spec (`locationFor(baitonDir, slug, 'spec')` or writing `.baiton/specs/<slug>/spec.md` per documentLocation) in a child is found.
   3. 'degenerates to the synthetic owner': deps.repos returns undefined -> list() and owners() equal `[{ path:'.', name:'.', hasBaiton:true }]`, target('.') ok with baitonDir ownerRoot/.baiton, target('../x') error, locate finds/misses in owner, locate(slug,'packages/api') -> invalid. Same for a RepoSet whose repos don't include ownerRoot. And a single-repo set (one repo name '.', root ownerRoot, baitonDir) gives list()/owners() `[{ path:'.', name:'.', hasBaiton:true }]` and target('.').target.topology `{ owner:'.', repos:[{ name:'.', root: ownerRoot }] }`.
   4. 'parsePlanRef / formatPlanRef': 'my-plan' -> {slug:'my-plan'} with no repo key; 'packages/api:my-plan' -> {repo:'packages/api', slug}; 'packages\\api/:my-plan' -> repo 'packages/api'; '.:x' and './:x' -> repo '.'; '../sibling:x' -> repo '../sibling'; 'C:/w/repo:x' -> repo 'C:/w/repo', slug 'x'; ':x', 'a:', '' and '   ' -> ok:false; formatPlanRef('.', 'x') === '.:x'; formatPlanRef('packages/api/', 'x') === 'packages/api:x'; round-trip for several paths.
   5. repoDiscovery helpers: repoByRoot finds by resolved root; planOwnerRepoFor returns the api repo for `<apiRoot>/.baiton/plans/s/plan.md`, the owner for `<ownerRoot>/.baiton/plans/s/plan.md`, and undefined for `<apiRoot>/src/x.ts` and for a path in a repo without .baiton (put these in test/planRepos.test.ts or the existing repoDiscovery test file if one exists — check `ls test | grep -i discovery` first and prefer the existing file only if it is clearly the home for these helpers; otherwise keep them in planRepos.test.ts).

   Files: `test/planRepos.test.ts`

6. Verify the dependent suites still pass unchanged

   Run `npm run compile`, `npm run lint` and `npm test`. Pay attention to test/planWriteTools.repo.test.ts and test/registry.controlTools.test.ts, which build real seams: (a) the add_phase hint test refuses '../sibling' via checkRepoHint on the plan's own topology — unaffected because hints validate against `target.topology`, not `target()`; (b) the child-only edit test still locates 'child-only' uniquely in packages/api; (c) the draft_plan tests' expected `repos` payloads come from `list()`, which is unchanged; the 'refuses invalid child targets' loop uses '../sibling' that is NOT in its RepoSet, so it is still refused. If any of these fail only because of a changed error string, keep the old string rather than editing those tests. If no test file edits outside test/planRepos.test.ts are needed, make none.

   Files: `test/planWriteTools.repo.test.ts`, `test/registry.controlTools.test.ts`, `src/orchestrator/planWriteTools.ts`, `src/orchestrator/controlTools.ts`, `src/activation/commands.ts`

## Risks

- Removing owner-wins from locate changes live behaviour: a slug that exists in both the owner and a nested repo now makes plan-write tools refuse with the existing 'exists in more than one nested repo' message instead of silently editing the owner's plan. That is intended by the plan, but the message wording is stale until the tools phase replaces it.
- target() now resolves repos outside the owner subtree (e.g. '../sibling'), so draft_plan with such a repo hint (controlTools.ts and commands.ts draftPlan.draft) will start drafting into a sibling repo. reposForDraftOwner filters list() (still subtree-only) by the target's descendants, so a sibling draft gets no `repos` payload — acceptable for this phase, worth revisiting later.
- Keeping list() as the owner subtree while adding owners() for plan addressing departs slightly from the OVERVIEW's wording 'widen'. It is deliberate: list() drives draft_plan's repos payload and the chat repoContext prompt, and changing it would change multi-repo prompt text and existing test expectations in this phase.
- Multi-root workspaces: repos in another folder get owner-relative paths with many '../' segments, or an absolute POSIX path on a different Windows drive. Both parse back through normalizeRepoPath and the last-':' split, but they read awkwardly in UI. Later phases may want to label them by discovery name.
- Adding the 'invalid' variant to PlanRepoLookup could break exhaustive switches. Today only planWriteTools.ts consumes locate, through if-chains, so the risk is low, but grep for `.locate(` and `PlanRepoLookup` before finishing.
- locate now runs exists() on every .baiton repo in the workspace for every bare-slug lookup. That is fine for normal repo counts but scales with discovery size (bounded by DEFAULT_DISCOVERY_MAX_ENTRIES).

## Acceptance

- `npm run compile` succeeds with no type errors; `npm run lint` is clean for src and test.
- `npm test` passes in full, including the existing test/planWriteTools.repo.test.ts and test/registry.controlTools.test.ts without changes to their expectations.
- createPlanRepoSeam(...).owners() lists every discovered repo with a .baiton/, owner first, including repos outside the owner subtree (e.g. '../sibling'), and never a repo without .baiton/; list() output is byte-identical to before for the existing fixtures.
- target('../sibling') and targetAt(siblingRoot) return a target whose guard, baitonDir, git and topology are bound to the sibling, and whose guard refuses paths in the owner's .baiton/.
- locate(slug) with the slug in both owner and a child returns { kind: 'ambiguous', repos: ['.', 'packages/api'] }, so there is no owner-wins; locate(slug, repo) looks only in that repo; an unknown repo argument returns { kind: 'invalid' }.
- With repos() undefined, an owner missing from the set, or a single-repo set, list()/owners() equal [{ path: '.', name: '.', hasBaiton: true }] and target('.') matches today's synthetic owner target.
- parsePlanRef/formatPlanRef round-trip '<repoPath>:<slug>', split on the last ':', normalize the repo part (backslashes, trailing '/', '' or './' -> '.'), and reject an empty repo part or empty slug.
- repoByRoot and planOwnerRepoFor exist in src/activation/repoDiscovery.ts, stay pure (no vscode/fs import), and are covered by tests; discoverRepos behaviour and DISCOVERY_SKIP_DIRS are unchanged.
- No file outside src/orchestrator/planRepos.ts, src/orchestrator/seams.ts, src/activation/repoDiscovery.ts and test/planRepos.test.ts is modified, except a minimal planWriteTools.ts narrowing fix if the compiler requires one.
