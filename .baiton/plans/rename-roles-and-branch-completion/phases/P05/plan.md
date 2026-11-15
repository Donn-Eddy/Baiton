# Plan P05

## Steps

1. Add the branchMerged fact to the pure tree model

   In src/model/treeModel.ts:
   - PlanGroupFacts: add `/** True when the recorded plan branch is merged into its recorded base on the configured remote (derived, never persisted). Independent of status. */ branchMerged?: boolean;`.
   - planGroupKind: keep the `done` check first, keep the existing `prsMerged === true && isPrStatus(status)` route unchanged, and add `if (facts.branchMerged === true) return 'completed';` (no status condition: the branch route is an independent third fact). Update its doc comment to list the three routes.
   - PlanNode: add `/** Present (true) only when the caller supplied the branch-merged fact; part of the facts `group` is derived from. */ branchMerged?: boolean;`.
   - PlanInput: add `/** Derived fact: the recorded `branch:` is merged into `<remote>/<base>`. Absent means not known to be merged. */ branchMerged?: boolean;`.
   - buildPlanNode: next to `prsMergedFact` add `const branchMergedFact = input.branchMerged === true ? { branchMerged: true as const } : {};` and spread it into all three returned node shapes (read-error, invalid, valid). Pass `branchMerged: input.branchMerged` into every one of the three `planGroupKind({...})` calls. In the valid branch, pass `branchMerged: input.branchMerged === true` to `legalPlanActions`.
   - Update the file header comment to mention that Completed also covers a plan whose recorded branch is merged into base. No VS Code imports.

   Files: `src/model/treeModel.ts`

2. Restrict actions for branch-merged plans

   In src/model/planActions.ts:
   - PlanActionInput: add `/** True when the recorded plan branch reads merged into base (derived, never persisted). Absent or false keeps today's actions. */ branchMerged?: boolean;`.
   - legalPlanActions: after the `invalid` early return, change the merged guard to `if (input.prsMerged === true || input.branchMerged === true) { return input.prUrl !== undefined ? ['showPr'] : []; }` so a branch-completed plan offers Show PR only when a PR is recorded and nothing otherwise (no approve, no submitPr, no pr-partial retry). Update the function doc comment accordingly. Ordering and every other path are unchanged.

   Files: `src/model/planActions.ts`

3. Explorer: branchMerged checker option, memo, log-once, and an exported ancestry helper

   In src/activation/planExplorer.ts:
   1. New exported types (with doc comments):
   ```ts
   export interface BranchMergedQuery {
     slug: string;
     /** Owning repository; undefined for the primary (single-source) repo. */
     repo?: string;
     /** Trimmed recorded `branch:`, non-empty. */
     branch: string;
     /** Trimmed recorded `base:`, non-empty. */
     base: string;
     /** Trimmed recorded `base_commit:`, when non-empty. */
     baseCommit?: string;
   }
   /** Resolves true only when the branch is strictly ahead of its starting point and is an ancestor of `<remote>/<base>`; may reject (treated as not merged, logged once). */
   export type BranchMergedChecker = (query: BranchMergedQuery) => Promise<boolean>;
   ```
      Add `branchMerged?: BranchMergedChecker` to PlanExplorerOptions with a doc comment mirroring `prsMerged` (consulted at most once per repo + slug + branch + base + baseCommit per explorer instance; never awaited by refresh; only called when both `branch:` and `base:` are non-empty and status is not `done`).
   2. Exported pure-ish helper so the decision logic is unit-testable without VS Code wiring:
   ```ts
   /** The git reads the branch-merged decision needs (a subset of GitWorktreeService). */
   export interface BranchAncestryGit {
     fetchBranch(remote: string, branch: string): Promise<void>;
     branchHead(ref: string): Promise<string | undefined>;
     isAncestor(ancestor: string, descendant: string): Promise<boolean>;
   }
   /** Decide whether `query.branch` is merged into `<remote>/<base>`. Fetches `base` first when `fetch` is true. Rejects when the base tracking ref or the branch tip cannot be resolved. Never writes. */
   export async function branchMergedIntoBase(git: BranchAncestryGit, remote: string, query: BranchMergedQuery, fetch: boolean): Promise<boolean>
   ```
      Algorithm: (a) if `fetch`, `await git.fetchBranch(remote, query.base)` (a rejection propagates). (b) `baseTip = await git.branchHead(`refs/remotes/${remote}/${query.base}`)`; undefined -> throw `new Error(`${remote}/${query.base} could not be resolved`)`. (c) `tip = (await git.branchHead(`refs/heads/${query.branch}`)) ?? (await git.branchHead(`refs/remotes/${remote}/${query.branch}`))`; undefined -> throw `new Error(`branch ${query.branch} could not be resolved locally or on ${remote}`)`. (d) No-false-positive guard: if `query.baseCommit` is set, return false when `tip === baseCommit`, and return false when `!(await git.isAncestor(baseCommit, tip))` (tip must be strictly ahead of base_commit); otherwise (no base_commit) return false when `tip === baseTip`. (e) `return git.isAncestor(tip, baseTip)`. Import `type` nothing from git (structural interface keeps the file free of new imports).
   3. In the PlanExplorer class add `private readonly branchMergedMemo = new Map<string, { merged?: boolean }>();` and `private readonly branchMergedLogged = new Set<string>();` with doc comments.
   4. Add `private branchMergedFor(slug: string, repo: string | undefined, raw: string | undefined): boolean` mirroring `prsMergedFor`: return false when no checker or raw undefined; parse frontmatter in try/catch; `status = frontmatter.get('status')?.trim()`; return false when status === 'done'; `branch = (frontmatter.get('branch') ?? '').trim()`, `base = (frontmatter.get('base') ?? '').trim()`, `baseCommit = (frontmatter.get('base_commit') ?? '').trim()`; return false (no log) when branch or base is empty. Key = `[repo ?? '', slug, branch, base, baseCommit].join('\u0000')`; memo hit returns `existing.merged === true`; otherwise set an entry, call the checker inside try/catch (sync throw -> rejected promise), `.then(merged => { entry.merged = merged === true; if (entry.merged && !this.disposed) void this.refresh(); }, e => { entry.merged = false; this.logBranchMergedFailure(slug, repo, e); })`, and return false. Never await.
   5. Add `private logBranchMergedFailure(slug, repo, e)` mirroring `logPrsMergedFailure` but using `branchMergedLogged` and the message `Baiton: could not read branch state for plan "<slug>"[ in <repo>]: <describe(e)>.` via `surface.log`, wrapped in try/catch.
   6. In `refresh()`'s per-entry input object add `branchMerged: this.branchMergedFor(entry.slug, source.repo, entry.readError === undefined ? entry.raw : undefined),` beside `prsMerged`.
   7. Update the file header doc comment: Completed also includes plans whose recorded `branch:` is merged into recorded `base:` on the configured remote, derived through an injected checker and never persisted.

   Files: `src/activation/planExplorer.ts`

4. Wire branchMergedForPlan in commands.ts

   In src/activation/commands.ts:
   - Extend the `./planExplorer` import with `branchMergedIntoBase` and `type BranchMergedChecker`.
   - Right after `prsMergedForPlan`, add:
   ```ts
   /** Plans (root + slug) whose base has already been fetched this session. */
   const branchFetched = new Set<string>();
   /** Whether a plan's recorded branch is merged into `<remote>/<base>`; read-only, never writes, commits, pushes or checks out. Unresolvable repo/remote/refs reject (the explorer logs once and treats it as not merged). */
   const branchMergedForPlan: BranchMergedChecker = async (query) => {
     const name = query.repo;
     const root = name === undefined || name === ownerRepoName()
       ? repoRoot
       : activation.repos?.repos.find((r) => r.name === name)?.root;
     if (root === undefined) throw new Error(`repo ${name} is not in the workspace`);
     const rootGit = path.resolve(root) === path.resolve(repoRoot)
       ? git
       : activation.git?.forRepo(root) ?? createGitService(root);
     const remote = (name !== undefined ? activation.repoConfigs?.get(name)?.git?.remote : undefined) ?? readGitSettings().remote;
     const fetchKey = `${path.resolve(root)}\u0000${query.slug}`;
     const fetch = !branchFetched.has(fetchKey);
     branchFetched.add(fetchKey);
     return branchMergedIntoBase(rootGit, remote, query, fetch);
   };
   ```
     (Mark the fetch key before awaiting so at most one fetch per plan per session is attempted, even if it fails. Base comes from the recorded `base:` in the query, not config. Do not gate on Restricted Mode, matching prsMergedForPlan.) If `rootFor`/`remoteFor` are factored out of prsMergedForPlan to share code, keep prsMergedForPlan's behaviour identical.
   - Pass the checker to the explorer: `{ prsMerged: prsMergedForPlan, branchMerged: branchMergedForPlan }`.
   - Confirm `git` / `createGitService(...)` / `activation.git.forRepo` return `GitWorktreeService` (they do: createGitService returns ShellGitService and the registry returns GitWorktreeService), so they satisfy BranchAncestryGit structurally.

   Files: `src/activation/commands.ts`

5. Tree model property tests

   In test/treeModel.property.test.ts, next to the existing prsMerged property (around line 410):
   - Extend the planGroupKind property arbitrary with `branchMerged: fc.option(fc.boolean(), { nil: undefined })` and the oracle: `done` -> completed; else `prsMerged === true && status in {pr, pr-partial}` -> completed; else `branchMerged === true` -> completed; else active/pending as before. Keep the existing assertion that `prsMerged: undefined` reproduces today's result, and add that `{ prsMerged: undefined, branchMerged: undefined }` equals the pre-change oracle.
   - Property: for any status (including unset, draft, approved) and any phaseStates, `branchMerged: true` yields `completed`.
   - buildPlanTree example tests: an approved plan with `branchMerged: true` lands in group `completed`, carries `branchMerged: true`; an ordinary input has no `branchMerged` key (`'branchMerged' in node === false`); a read-error input and an invalid-plan input with `branchMerged: true` both get group `completed` and `actions: []`; a valid branch-merged plan with a `pr:` URL has actions `['showPr']` and without a PR `[]`.

   Files: `test/treeModel.property.test.ts`

6. Plan actions property tests

   In test/planActions.property.test.ts, mirroring the prsMerged tests (around line 185-225):
   - Property: for arbitrary approved/prUrl/phaseStates/status, `legalPlanActions({ ..., invalid: false, branchMerged: true })` deep-equals `prUrl !== undefined ? ['showPr'] : []` (covers status `pr-partial` with all-done phases: no submitPr retry).
   - Property: `invalid: true` with `branchMerged: true` gives `[]`.
   - Property: `branchMerged: false` and `branchMerged` absent give identical results to the input without the field (today's behaviour).

   Files: `test/planActions.property.test.ts`

7. Plan Explorer tests for the branch route and the ancestry helper

   In test/planExplorer.test.ts (import `type BranchMergedQuery` alongside PrsMergedQuery; use `mod.branchMergedIntoBase` from the dynamically loaded module):
   Explorer tests (pattern of the existing prsMerged tests, using writePlan/groupSlugs/waitFor/refreshAfterChange):
   1. 'groups a plan Completed when its recorded branch is merged into base, without writing the document': writePlan('branchdone', ['status: approved', 'base: main', 'base_commit: abc', 'branch: baiton/branchdone']); writePlan('nobranch', ['status: approved', 'base: main']); writePlan('nobase', ['status: approved', 'branch: baiton/x']); writePlan('isdone', ['status: done', 'base: main', 'branch: baiton/d']). Checker `{ branchMerged: async (q) => { calls.push(q); return true; } }`. Wait until completed includes 'branchdone'; assert calls.length === 1 with `{ slug: 'branchdone', branch: 'baiton/branchdone', base: 'main', baseCommit: 'abc' }` and repo undefined; 'nobranch'/'nobase' not completed; plan file bytes unchanged (fs.readFileSync before/after); contextValue equals `planContextValue([])`; no logs.
   2. Show PR only with a recorded PR: plan `['status: approved','base: main','branch: b','pr: https://github.com/o/r/pull/9']` -> Completed with contextValue `planContextValue(['showPr'])`.
   3. Memo: two extra refreshAfterChange() calls keep calls.length === 1; changing `branch:` in the document re-arms (calls.length === 2).
   4. Hung checker (never-resolving promise) does not block refresh: plans 'alpha'/'beta' still show and the plan stays out of Completed.
   5. Rejected and synchronously thrown checkers: plan stays out of Completed, exactly one surface.log per plan containing 'branch state', no repeat after further refreshes.
   6. A checker resolving false leaves the plan in Active/Pending.
   Helper tests ('branchMergedIntoBase') with a fake BranchAncestryGit recording calls: `heads: Record<string,string|undefined>`, `ancestors: Set<string>` of `${a}..${b}` pairs, a fetch log, and an optional fetch rejection:
   - fetch=true calls `fetchBranch('origin','main')` exactly once before any branchHead; fetch=false never calls it.
   - merged: base_commit B0, local tip T (T != B0, B0 ancestor of T), T ancestor of `refs/remotes/origin/main` -> true; isAncestor called with (T, baseTip).
   - falls back to `refs/remotes/origin/<branch>` when `refs/heads/<branch>` is undefined.
   - tip === base_commit -> false (no false positive) even though isAncestor(T, baseTip) would be true.
   - base_commit not an ancestor of tip -> false.
   - no base_commit and tip === base tip -> false.
   - tip not an ancestor of base tip -> false.
   - tip unresolvable both locally and remotely -> rejects; base tracking ref unresolvable -> rejects; fetch rejection -> rejects.
   - the fake records no write method calls (the fake only implements the three reads).

   Files: `test/planExplorer.test.ts`

8. Verify

   Run `npx tsc -p ./ --noEmit`, `npx mocha test/treeModel.property.test.ts test/planActions.property.test.ts test/planExplorer.test.ts`, then `npm test` and `npm run lint`, and `git diff --check`. Confirm no file outside the phase's file list changed and that `.baiton/config.json` and all plan documents are untouched.

   Files: (none)

## Risks

- commands.ts wiring itself has no direct unit test; the decision logic lives in the exported branchMergedIntoBase helper so it is covered in test/planExplorer.test.ts. Keep branchMergedForPlan a thin resolver of root/git/remote/fetch-once.
- branchHead uses `rev-parse --verify <ref>^{commit}`; pass fully-qualified `refs/heads/<branch>` and `refs/remotes/<remote>/<base>` so a tag or ambiguous name cannot be picked up.
- Squash or rebase merges are not detectable by ancestry; those plans remain covered only by the recorded-PR route (known limit, not a bug).
- A plan whose base was fetched once this session will not see later remote merges until reload, because fetching is limited to once per plan per session and the explorer memo holds the result per branch/base/base_commit key.
- Plans whose status is `pr`/`pr-partial` may now be triggered by both checkers; both are fire-and-forget and either one completing re-refreshes, so this is harmless but doubles background work.
- The explorer test file loads planExplorer through a VS Code mock; exporting a new helper and types from planExplorer.ts must not add new runtime imports that the mock lacks.
- Do not add any setFrontmatterKey/commit/push/checkout call on this path; the plan document, phase lines and approval hashes must stay byte-identical.

## Acceptance

- planGroupKind returns 'completed' when branchMerged is true regardless of status; 'done' and the prsMerged-with-pr-status routes behave exactly as before; absent branchMerged reproduces today's grouping.
- PlanNode carries `branchMerged: true` only when the input supplied it; ordinary nodes have no branchMerged key.
- legalPlanActions with branchMerged true returns ['showPr'] when a PR URL is recorded and [] otherwise, for every status including pr-partial.
- PlanExplorer accepts a `branchMerged` checker option; it is called at most once per repo+slug+branch+base+base_commit per instance, only when branch and base are non-empty and status is not done; refresh never awaits it; a true result re-refreshes and moves the plan to Completed.
- A rejected or synchronously thrown branch check leaves the plan out of Completed and logs exactly once per plan per session via surface.log.
- branchMergedIntoBase: returns false when the tip equals base_commit, when base_commit is not an ancestor of the tip, or (no base_commit) when the tip equals the base tip; tests ancestry against refs/remotes/<remote>/<base>; falls back to refs/remotes/<remote>/<branch>; rejects on unresolvable refs or fetch failure; fetches the base branch only when asked.
- commands.ts passes `branchMerged: branchMergedForPlan` to the PlanExplorer; it resolves root and remote like prsMergedForPlan, uses the recorded base, and fetches at most once per plan per session.
- The branch route writes nothing: plan document bytes are unchanged in the explorer test, and no commit/push/checkout/setFrontmatterKey is invoked.
- `npx tsc -p ./ --noEmit`, `npm test` and `npm run lint` (no errors) pass.
