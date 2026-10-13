# Plan P06

## Steps

1. Add the partial-failure plan status and make legalPlanActions status-aware

   In src/model/planActions.ts:
   - Export `export const PR_PARTIAL_STATUS = 'pr-partial';` and `export const PR_STATUS = 'pr';` (model layer owns the constants so engine/transitions.ts can import them without a model->engine dependency).
   - Add an OPTIONAL field to `PlanActionInput`: `status?: string` (the trimmed frontmatter `status` value, undefined when unset). Optional so every existing caller compiles unchanged.
   - Rewrite `legalPlanActions` as: invalid -> []; if `input.status === PR_PARTIAL_STATUS` -> the partial branch: `actions = []`; push 'submitPr' when `approved && phaseStates.length > 0 && every state === 'done'` (the retry); push 'showPr' when `prUrl !== undefined`; return (order stays approve, submitPr, showPr; 'approve' is NOT offered in the partial branch — a partial plan is re-approved through the normal stale-approval path only, so when !approved the partial branch yields just ['showPr'] or []). Otherwise keep today's logic byte-for-byte (prUrl -> ['showPr']; approve while unapproved; submitPr when approved && all done).
   - Update the doc comment: a partial plan offers Submit PR as a retry beside Show PR.
   In src/model/treeModel.ts (the only caller of legalPlanActions, ~line 194): pass `status: status.kind === 'set' ? status.value : undefined` into the `legalPlanActions({...})` call. Nothing else in treeModel changes. If test/treeModel.property.test.ts (~line 345) recomputes `legalPlanActions({...})` for parity, pass the same `status` there so the parity assertion still holds.

   Files: `src/model/planActions.ts`, `src/model/treeModel.ts`, `test/treeModel.property.test.ts`

2. Add pure plan-level PR outcome helpers to transitions.ts

   src/engine/transitions.ts stays phase-state focused, but gains a small pure 'Plan PR state' section at the bottom (no I/O), importing `PR_STATUS`, `PR_PARTIAL_STATUS` from '../model/planActions':
   ```ts
   /** The plan frontmatter status a PR submission writes. */
   export type PlanPrStatus = 'pr' | 'pr-partial';
   /** One repo's submission outcome, reduced to what the state decision needs. */
   export interface RepoPrState { readonly repo: string; readonly ok: boolean; }
   /**
    * The plan status after a submission: 'pr' (the plan's done-with-PRs state) only when
    * every repo the plan touched has a PR (recorded earlier OR succeeded now); 'pr-partial'
    * when at least one has a PR and at least one failed; undefined when none has one
    * (nothing is recorded, exactly like today's single-repo failure).
    */
   export function planPrStatus(touched: readonly string[], recorded: ReadonlySet<string>, outcomes: readonly RepoPrState[]): PlanPrStatus | undefined
   /** The touched repos still lacking a PR, in `touched` order (a retry re-submits only these). */
   export function reposToSubmit(touched: readonly string[], recorded: ReadonlySet<string>): string[]
   /** Whether a plan status admits a (re)submission: unset/any non-'done' status. 'pr-partial' is the retry state. */
   export function isPartialPrStatus(status: string | undefined): boolean  // status?.trim() === PR_PARTIAL_STATUS
   ```
   Semantics of planPrStatus: let have = recorded ∪ {o.repo | o.ok}; if `touched.length === 0 || have ∩ touched is empty` -> undefined; if every touched repo is in have -> 'pr'; else 'pr-partial'. Add these to the module doc comment's prose (one paragraph: plan-level PR states, not phase transitions). Do not change any existing export.

   Files: `src/engine/transitions.ts`

3. Add per-repo PR reporting helpers to prTool.ts

   In src/engine/prTool.ts add (pure, no new I/O):
   ```ts
   /** One repo's PR as reported to the user/orchestrator. */
   export interface RepoPullRequest { repo: string; pr: PullRequest; reused: boolean; }
   /** One repo whose push/create failed. */
   export interface RepoPrFailureReport { repo: string; message: string; }
   /** Render each repo's PR (and each failure) one per line, e.g. `packages/api: https://…/pull/7 (reused)` / `packages/web: failed — <message>`. The owner repo name '.' renders as `(root)`. */
   export function describeRepoPrs(prs: readonly RepoPullRequest[], failures?: readonly RepoPrFailureReport[]): string
   /** Serialize the per-repo PR map for the `prs:` frontmatter key: a single-line JSON object {repoName: url}, keys in the given order. */
   export function formatPrsValue(prs: readonly { repo: string; url: string }[]): string   // JSON.stringify(Object.fromEntries(...))
   /** Parse a `prs:` value; tolerant: empty/garbage/non-object -> empty map, non-string values skipped. */
   export function parsePrsValue(raw: string | undefined): Map<string, string>
   ```
   The CLI backends (gh/glab) need no change: each repo gets its own PrTool built with `createPrTool({ kind, executable, repoRoot: <that repo's root> })`, so `findOpenByHead`/`create` already run in the right repo.

   Files: `src/engine/prTool.ts`

4. Register the `prs` managed frontmatter key

   The per-repo URL map is written to a new extension-managed frontmatter key `prs` (approval hash excludes frontmatter, so writing it never stales approval). In src/model/managedKey.ts add `| 'prs'` to `ManagedKey` and `'prs'` to `MANAGED_KEYS` (after 'pr'). In src/orchestrator/systemPrompt.ts add `'prs'` to `EXTENSION_WRITTEN_KEYS` and `'pr-partial'` to `STATUS_VALUES` (after 'pr') so agents know both are extension-owned. `prs` is written ONLY for plans that touch more than one repo; single-repo plans never get the key (byte-identical documents to today). Existing tests over MANAGED_KEYS / EXTENSION_WRITTEN_KEYS keep passing (they only assert inclusion).

   Files: `src/model/managedKey.ts`, `src/orchestrator/systemPrompt.ts`

5. Make submitPr group done phases by target repo and submit one PR per repo

   Edit src/engine/submitPr.ts. Keep every existing export and keep the single-repo path behaviourally identical (same checks, same order, same `diff.patch`, same pr-writer context text, same journal entries, same commits `plan(<slug>): pr draft` / `plan(<slug>): pr`, same frontmatter writes `pr` + `status: pr`, never writes `prs`).

   (a) New types/deps:
   ```ts
   /** A non-owner repo a phase targets, as submitPr needs it. */
   export interface PrRepoTarget { name: string; root: string; isOwner: boolean; git: GitService; }
   /** Remote/base/PR tool for one target repo (its own config when it has one). */
   export interface PrRepoSettings { remote: string; base: string; pr: PrTool; }
   // SubmitPrDeps gains (both optional; absent => every phase targets the owner, i.e. today):
   phaseTarget?: (slug: string, phaseId: string) => Promise<Result<PrRepoTarget, string>>;
   repoSettings?: (target: PrRepoTarget) => Promise<Result<PrRepoSettings, string>>;
   ```
   (`PhaseTargetRepo` from engine/phaseWorktree is structurally assignable to PrRepoTarget; import `Result` from '../model/result' or wherever `Result` lives.)

   (b) Result types (backward compatible: ok:true keeps `pr`, `reused`, `title`):
   ```ts
   export interface RepoPrSuccess { repo: string; isOwner: boolean; branch: string; base: string; pr: PullRequest; reused: boolean; }
   export interface RepoPrFailure { repo: string; isOwner: boolean; branch: string; base: string; error: SubmitPrError; }
   // SubmitPrError gains: | { kind: 'partial'; message: string; prs: readonly RepoPrSuccess[]; failures: readonly RepoPrFailure[] }
   // SubmitPrResult ok:true gains: prs: readonly RepoPrSuccess[]  (single-repo: exactly one entry, repo = owner name or '.')
   ```
   `pr`/`reused` on ok:true are the PRIMARY PR: the owner's when the owner was touched, else the first success in order.

   (c) Exported pure helper `groupPhasesByRepo(phases: readonly {id: string}[], targets: ReadonlyMap<string, PrRepoTarget>): PrRepoGroup[]` where `PrRepoGroup = { target: PrRepoTarget; phaseIds: string[] }`, grouped by canonical `path.resolve(target.root)`, owner group first (if any), then other repos in first-appearance phase order. In `submitPr`, after `checkReady`, resolve every phase: when `deps.phaseTarget` is undefined, every phase maps to the owner target `{ name: '.', root: deps.workspaceRoot, isOwner: true, git: deps.git }`; otherwise call it per phase and on `ok:false` return `fail({kind:'not-ready', message: <its error>})` before anything is launched. 'Touched repos' = the groups (all phases are done by the readiness gate, so all phases are executed phases).

   (d) Retry/partial bookkeeping: read `status` and `prs` from the plan frontmatter in checkReady (extend `ReadyPlan` with `status: string` and `recorded: Map<string,string>` from `parsePrsValue`, plus `pr` raw value). If status is not partial, `recorded` is treated as empty. For a single-repo plan with status 'pr-partial' (impossible in practice) treat it normally. `toSubmit = reposToSubmit(touchedNames, new Set(recorded.keys()))`; when it is empty (everything recorded already) skip launching and go straight to recording `status: pr` (step g) returning ok:true with the recorded URLs as `prs` (reused: true).

   (e) Pre-flight for each NON-owner group in `toSubmit` (before Verify/launch, so a failure pushes nothing): `settings = await deps.repoSettings?.(target)` (missing dep or ok:false -> not-ready naming the repo); `planBranch = planBranchFor(slug)` (import from './phaseWorktree'; it equals the owner's `branch` frontmatter convention `baiton/<slug>`); require `await target.git.branchHead(planBranch) !== undefined` else not-ready `phase(s) <ids> target repo <name> but its plan branch <planBranch> does not exist; land those phases first`; resolve `baseCommit = await target.git.resolveBaseCommit(settings.base)` (fail -> not-ready naming repo and base). Child repos are NOT required to have the plan branch checked out or a clean tree (push works by ref), and Verify runs only in the owner root as today. The owner group (when touched and in toSubmit) uses the frontmatter branch/base/base_commit and deps.remote/deps.pr exactly as today. Note the owner readiness checks (approval, all done, unlanded, branch checked out, clean tree) stay unconditional even when the owner is not touched, because approval and the plan document live there.

   (f) Launch the pr-writer ONCE per submission. Write the owner diff to `diff.patch` (PR_DIFF_FILE_NAME) as today when the owner is in toSubmit; for each child write `prDiffFileNameFor(repoName)` = `diff.${repoName.replace(/[^A-Za-z0-9._-]+/g, '_')}.patch` (export this helper) with `target.git.diff(baseCommit, planBranch)`. If the owner is not in toSubmit, still create the run dir. Extend `prContext` with an optional `repos?: readonly { repo: string; diffPath: string; base: string; branch: string }[]`: when absent or of length <= 1 AND it is the owner, return today's exact four lines; otherwise replace the third line with one line per repo (`Repo \`<name>\`: the diff of branch \`<branch>\` against base \`<base>\` is at \`<path>\`.`) and add a line `This plan opens one pull request per repo listed; write a title and body that fit all of them.`. Journal start/completion, draft commit and `resetWorkingTree` are unchanged (owner repo).

   (g) Submit per repo, sequentially in group order, never aborting on a per-repo failure once a draft exists: push (`git.push(remote, branch)`), then `findOpenByHead(branch)` -> reuse, else `create({ base, head: branch, title: draft.title, body: bodyFor(repo) })`. `bodyFor` returns `draft.body` unchanged for a single-repo plan; for multi-repo append `\n\n---\nPart of plan \`<slug>\`, which opens one PR per repo: <comma list of repo names>.` (export as `prBodyFor(body, slug, repo, allRepos)`). A push failure yields RepoPrFailure{error:{kind:'push-failed',...}}, a create failure {kind:'create-failed',...} with today's message texts. Journal: keep ONE `appendCompletion` per run with `pr: PrCompletion` where push/create are true only if every attempted repo succeeded that step, record as below (keep the single-repo early-return points so the single-repo journal is identical: for a single repo, a push failure still returns `push-failed` directly, create failure returns `create-failed` directly).

   (h) Record once in the OWNER plan document: compute `status = planPrStatus(touchedNames, recordedSet, outcomes)`. undefined (no PR anywhere) -> append completion and return the first failure's error (single repo: identical to today). Otherwise: merged map = recorded ∪ successes (touched order); primary URL as in (b); `setFrontmatterKey(content,'pr', primary)`; when touched.length > 1 also `setFrontmatterKey(content,'prs', formatPrsValue(merged))`; `setFrontmatterKey(content,'status', status)`; write and commit `plan(<slug>): pr` (status 'pr') or `plan(<slug>): pr (partial)` ('pr-partial'). Write/commit failure -> `record-failed` as today. Then: status 'pr' -> `{ ok: true, pr, reused, title, prs }`; 'pr-partial' -> `fail({ kind: 'partial', message: \`opened ${n} of ${m} pull requests for plan "<slug>"; failed: <repo: msg; …>. Submit PR again to retry only the failed repos.\`, prs, failures })`.

   (i) `checkReady` keeps refusing status 'done'; a status of 'pr-partial' is allowed (retry). Update the module doc comment to describe per-repo grouping, the single draft, per-repo push/create, and the 'pr' vs 'pr-partial' recording.

   Files: `src/engine/submitPr.ts`

6. Wire per-repo targets/settings into the host and report each PR

   src/activation/commands.ts, `submitPrForSlug` (~line 528): pass
   - `phaseTarget: (s, id) => phaseTargets.forPhase(s, id)` (PhaseTargetRepo satisfies PrRepoTarget),
   - `repoSettings: async (target) => { const rc = activation.repoConfigs?.get(target.name)?.git; const remote = rc?.remote ?? readGitSettings().remote; const base = rc?.base ?? cfg().git.base; let url; try { url = await target.git.remoteUrl(remote) } catch { return err(`git remote "${remote}" is not configured in repo ${target.name}`) } const k = selectProvider(selection, url); const exe = resolveProviderExecutable(k, { override: readPrToolPath() }); if (!exe) return err(<same not-found text>); return ok({ remote, base, pr: createPrTool({ kind: k, executable: exe, repoRoot: target.root }) }); }` (guard `activation.repoConfigs` may be absent in lightweight fixtures; check the actual Activation field name — extension.ts exposes `repoConfigs: ReadonlyMap<string, Config>` keyed by repo name; if the commands-layer Activation interface lacks it, add it there as optional).
   - On success map to `SubmitPrOutcome` `{ ok: true, url: result.pr.url, reused: result.reused, title: result.title, prs: result.prs.map(p => ({ repo: p.repo, url: p.pr.url, reused: p.reused })) }`.
   - `describeSubmitPrError`: for kind 'partial' return `${error.message}\n${describeRepoPrs(successes, failures)}`.
   src/orchestrator/toolServices.ts: extend `SubmitPrOutcome` ok:true with optional `prs?: readonly { repo: string; url: string; reused: boolean }[]` (optional so test fakes in registry.controlTools / guard.restrictedMode / integration tests still compile).
   src/orchestrator/controlTools.ts `submit_pr`: include `prs` in the returned `data` when present (`...(outcome.prs ? { prs: outcome.prs } : {})`). The partial case arrives as `ok:false` with the multi-line message, which already reports each repo.
   Update any test file that constructs `SubmitPrResult`/`SubmitPrOutcome` ok:true literally only if compile requires it (prs is required on SubmitPrResult ok:true, so fakes typed as SubmitPrResult need `prs: []`; grep test/ for `reused:` to find them).

   Files: `src/activation/commands.ts`, `src/orchestrator/toolServices.ts`, `src/orchestrator/controlTools.ts`

7. Extend the planActions property test

   In test/planActions.property.test.ts:
   - Add `statusArb = fc.option(fc.constantFrom('draft','approved','in-progress','pr','pr-partial','done'), { nil: undefined })` and pass `status` to every `legalPlanActions` call in the three existing properties (expected-value logic for non-partial statuses unchanged).
   - In the first property, branch on `status === 'pr-partial'` before the prUrl branch: expect `actions` to equal `[...(approved && phaseStates.length>0 && all done ? ['submitPr'] : []), ...(prUrl !== undefined ? ['showPr'] : [])]` and never include 'approve'.
   - Second property: showPr ⇔ `!invalid && prUrl !== undefined` still holds for every status (true by construction).
   - New property 'a partial plan with all phases done and approval current offers the Submit PR retry even with a PR URL recorded'.
   - New property: for status !== 'pr-partial', the result equals legalPlanActions with `status` omitted (single-repo behaviour unchanged).
   - New pure tests (same file or test/transitions.prStatus.test.ts) for `planPrStatus`/`reposToSubmit` with fast-check: generate a touched list of distinct repo names (minLength 1), a recorded subset, outcomes for the not-recorded remainder; assert 'pr' ⇔ every touched repo recorded-or-ok, 'pr-partial' ⇔ some but not all, undefined ⇔ none; `reposToSubmit` returns exactly touched \ recorded in touched order; single-element touched never yields 'pr-partial'.

   Files: `test/planActions.property.test.ts`, `test/transitions.prStatus.test.ts`

8. Add multi-repo submitPr and prTool helper tests

   New test/submitPr.multiRepo.test.ts, modelled on test/submitPr.test.ts's harness (real git repos via its `makeRepo`/`git` helpers, StubAdapter/StubTerminalHost/StubWatcherFactory, a FakePrTool with a per-instance `failCreate`/`failPush`-style toggle; copy the helpers locally rather than importing from another test file unless they are already exported). Setup: an owner repo whose plan has phases `P01` (no hint) and `P02 (repo: packages/api)` both [done], approved (approved_rev = approvalHash), on branch baiton/<slug>; a child git repo at <owner>/packages/api with its own bare remote and branch `baiton/<slug>` carrying one commit beyond its `main`. Inject `phaseTarget` (P01 -> owner, P02 -> child) and `repoSettings` (child -> { remote: 'origin', base: 'main', pr: childFake }). Cases:
   1. Both succeed: two pr-writer launches? No — exactly ONE terminal/watcher; the run dir holds `diff.patch` and `diff.packages_api.patch` (child diff contains the child commit); ownerFake and childFake each `create` once with head baiton/<slug>, base main; child body ends with the 'Part of plan' footer; plan frontmatter has `status: pr`, `pr:` = owner URL, `prs:` JSON with both repos; result ok with `prs.length === 2`; child remote has the branch.
   2. Child create fails: result ok:false kind 'partial', `prs` = [owner], `failures` = [packages/api]; frontmatter `status: pr-partial`, `prs` holds only the owner; commit message `plan(<slug>): pr (partial)`.
   3. Retry after (2) with childFake fixed: only childFake is called (ownerFake.created unchanged, owner push not repeated — assert via a spy/counter on push or by the fake's call log); frontmatter becomes `status: pr` with both URLs; ok:true.
   4. All phases on the child only (owner untouched): only the child PR is opened; `pr:` = child URL.
   5. Pre-flight: child plan branch missing -> not-ready naming the repo and no terminal created; `repoSettings` error -> not-ready, nothing pushed.
   6. Single-repo regression: with `phaseTarget` absent and with `phaseTarget` mapping everything to the owner, the document after a successful submit has no `prs:` line and equals the document produced by today's flow (`status: pr`, `pr: <url>`), and `prs` has one entry.
   Also add small unit tests for `formatPrsValue`/`parsePrsValue` round-trip (including garbage input -> empty map) and `describeRepoPrs` output, and `prContext` returning today's exact text for the single-owner case (put these in test/prTool.test.ts / test/submitPr.multiRepo.test.ts as fits the existing layout). Existing test/submitPr.test.ts must pass unmodified except for adding `prs` expectations if desired.

   Files: `test/submitPr.multiRepo.test.ts`, `test/prTool.test.ts`

9. Build, lint and run the suites

   Run `npm run compile`, `npm run lint`, then the focused suites: `env NODE_OPTIONS=--no-strip-types npx mocha --no-config --require ts-node/register --extension ts test/submitPr*.test.ts test/planActions.property.test.ts test/treeModel.property.test.ts test/transitions*.test.ts test/prTool*.test.ts test/systemPrompt.test.ts test/model.test.ts test/writer.scope.property.test.ts test/registry.controlTools.test.ts test/integration.plan-execute-review.test.ts test/integration.sub-agent-chats.test.ts` (git-backed tests may need to run outside the sandbox), then `npm test` and `git diff --check`. Fix any fake/stub in tests that types `SubmitPrResult` ok:true without `prs`.

   Files: (none)

## Risks

- The child repo's diff for the pr-writer is two-dot (`resolveBaseCommit(base)`..planBranch) because GitService has no merge-base; if the child's base branch advanced after the plan branch was cut, the diff file will also show the base's new commits reversed. Only the writer's context is affected, not the PR itself (the provider computes its own diff). Acceptable for this phase; a merge-base helper could be added later.
- Child-repo PRs skip Verify (the child main checkout need not be on the plan branch) and skip the clean-tree check; only the owner's Verify runs. Document this in the submitPr doc comment so it is a deliberate choice.
- One pr-writer draft is shared by every repo's PR; titles are identical across repos, distinguished only by the body footer. If reviewers want per-repo titles, that is a follow-up.
- Adding `prs` to ManagedKey and 'pr-partial' to STATUS_VALUES touches files outside the phase's file hint (managedKey.ts, systemPrompt.ts, treeModel.ts, commands.ts, toolServices.ts, controlTools.ts); these are small, necessary for compile/wiring, and must not alter single-repo outputs.
- Single-repo byte-identity is the main regression risk: the single-repo path must keep its early-return error kinds (push-failed/create-failed/record-failed), its journal completion shape, its `diff.patch`/prContext text, and must never write a `prs:` key. Case 6 of the multi-repo test plus the unchanged test/submitPr.test.ts guard this.
- SubmitPrResult ok:true gains a required `prs` field; any test fake returning that type literally will fail to compile until `prs` is added. SubmitPrOutcome's `prs` is optional to avoid churning the orchestrator fakes.
- The commands-layer Activation type may not yet expose `repoConfigs`; if it does not, add it as an optional field and fall back to the owner config/VS Code git settings when absent (test fixtures).

## Acceptance

- `npm run compile` succeeds and `npm run lint` exits 0 (the pre-existing webviewProtocol.ts unused-variable warning is acceptable).
- `npm test` passes in full, including the unmodified test/submitPr.test.ts and the integration tests that call submitPr.
- A plan whose phases all target the owner (or have no repo hints) submits exactly one PR, writes `status: pr` and `pr: <url>`, never writes a `prs:` key, journals one completion, and returns ok:true with `prs` of length 1 — identical document output to before this phase.
- A plan touching the owner and one child repo launches the pr-writer once, writes `diff.patch` and `diff.<repo>.patch`, pushes `baiton/<slug>` in each repo, opens one PR per repo against that repo's configured base, and records `status: pr`, `pr:` (owner URL) and `prs:` (JSON map of both).
- When one repo's push or create fails and another succeeds, submitPr returns ok:false with error kind 'partial' listing successes and failures, records `status: pr-partial` with `prs:` holding only the successes, and commits `plan(<slug>): pr (partial)`.
- Retrying a 'pr-partial' plan re-submits only the repos missing from `prs:` (no push/create in already-recorded repos) and moves the plan to `status: pr` once all succeed.
- Pre-flight failures for a child repo (missing plan branch, unresolvable base, missing remote/CLI, unresolvable repo hint) return not-ready before any terminal is launched or anything is pushed.
- legalPlanActions offers ['submitPr','showPr'] for an approved, all-done 'pr-partial' plan with a recorded URL, never offers 'approve' for a partial plan, and returns exactly today's actions for every other status; test/planActions.property.test.ts covers this with fast-check.
- planPrStatus/reposToSubmit property tests pass: 'pr' iff every touched repo has a PR, 'pr-partial' iff some but not all, undefined iff none; a single-repo plan never yields 'pr-partial'.
- The submit_pr control tool and the Submit PR command report each repo's PR URL (and each failure on partial) via describeRepoPrs.
- `git diff --check` reports no issues.
