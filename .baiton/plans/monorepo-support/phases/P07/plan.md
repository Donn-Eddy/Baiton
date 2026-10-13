# Plan P07

## Steps

1. Add a plan-repo seam to ToolServices (owner topology, slug lookup, per-repo write targets)

   Background: today every plan-writing tool resolves `services.baitonDir`, checks containment with `tc.ctx.resolveMutatingPath` (a GuardContext bound to the conversation's repo, whose document roots are only `<baitonDir>/plans` and `<baitonDir>/specs`) and commits with `services.git`. The chat conversation is bound to the primary repo. Repo discovery already exists in `src/activation/repoDiscovery.ts` (`Repo`, `RepoSet`, `repoByName`, `isWithinSubtree`, `reposWithBaiton`, `repoTopologyFor(set, ownerName)`), and `src/model/validator.ts` exports `RepoTopology`, `RepoTopologyEntry` and `resolvePhaseRepo(hint, topology): RepoBinding` (`{ok:true,target,isOwner}` | `{ok:false, reason:'invalid'|'unknown'|'sibling'|'ancestor', target?}`).

   In `src/orchestrator/seams.ts` add (pure types, no vscode import):
   ```ts
   /** One repo the conversation's owning repo may plan into: itself or a descendant. */
   export interface PlanRepoInfo {
     /** Path relative to the conversation's owning repo root; '.' for the owner. */
     readonly path: string;
     /** Stable discovery name (RepoSet name). */
     readonly name: string;
     /** Whether the repo has its own `.baiton/` (can own plans). */
     readonly hasBaiton: boolean;
   }
   /** Where a plan document of one repo is written and committed. */
   export interface PlanRepoTarget {
     readonly info: PlanRepoInfo;
     readonly root: string;
     readonly baitonDir: string;
     readonly git: GitService;
     /** Topology whose owner is THIS repo, for validating phase `repo` hints. */
     readonly topology: RepoTopology;
     /** Guard bound to this repo; containment is this repo's own .baiton/plans and .baiton/specs only. */
     readonly guard: GuardContext;
   }
   export type PlanRepoLookup =
     | { kind: 'found'; target: PlanRepoTarget }
     | { kind: 'missing' }
     | { kind: 'ambiguous'; repos: readonly string[] };
   export interface PlanRepoSeam {
     /** Owner first, then descendants in pre-order. Never siblings or ancestors. */
     list(): readonly PlanRepoInfo[];
     /** Resolve a repo path relative to the owner ('.' = owner) to a writable target; refuses unknown, non-descendant, or no-.baiton repos with a message. */
     target(repoPath: string): { ok: true; target: PlanRepoTarget } | { ok: false; error: string };
     /** Find the repo whose .baiton/ holds `slug` (plans/<slug>/plan.md or legacy specs/<slug>/spec.md). The owner wins when it holds the slug; otherwise exactly one descendant, else ambiguous/missing. */
     locate(slug: string): Promise<PlanRepoLookup>;
   }
   ```
   Add `repo?: string` to `DraftPlanRequest` (doc: owning repo path relative to the conversation repo; absent = the conversation repo) and `repos?: readonly PlanRepoInfo[]` (the repos the plan writer may target, relative to the new plan's owner; set only when more than one).

   In `src/orchestrator/toolServices.ts` add an optional field `planRepos?: PlanRepoSeam` with a doc comment: absent means single-repo behaviour, byte-for-byte as today.

   Implement the seam as a pure factory in a new file `src/orchestrator/planRepos.ts`: `createPlanRepoSeam(deps: { repos: () => RepoSet | undefined; ownerRoot: string; restricted: () => boolean; gitFor(root: string): GitService; exists(p: string): Promise<boolean> }): PlanRepoSeam`. Owner = the repo whose `root` equals `path.resolve(ownerRoot)`; `list()` = owner plus every repo for which `isWithinSubtree(set, owner, repo)` holds, `path` = `path.relative(owner.root, repo.root).split(path.sep).join('/') || '.'`. `target(p)`: normalize like the validator (reject absolute / `..`-escaping), match on `path`, refuse with `repo "<p>" is not the owning repo or a repo nested beneath it` / `repo "<p>" has no .baiton/ directory; initialize Baiton there first` ; build `topology = repoTopologyFor(set, repo.name)` and `guard = new GuardContext({ repoRoot: repo.root, baitonDir: repo.baitonDir, restricted: restricted() })`. `locate(slug)`: use `resolveDocument(baitonDir, slug).documentPath` + `exists` for each listed repo with `.baiton/`. When the RepoSet is undefined or the owner is not found, `list()` returns `[{path:'.', name:'.', hasBaiton:true}]`-equivalent and `locate`/`target` only ever return the owner (built from ownerRoot / services values) — or simpler: callers treat an absent seam as single-repo, so the factory may return undefined from `createPlanRepoSeam` when `repos()` is undefined. Pick one and document it.

   Files: `src/orchestrator/seams.ts`, `src/orchestrator/toolServices.ts`, `src/orchestrator/planRepos.ts`

2. planWriteTools: write to the plan's owning repo and accept the `repo` hint on add_phase/edit_phase

   In `src/orchestrator/planWriteTools.ts`:

   1. `loadPlanForWrite(services, slug, tc)` returns, in addition to `absolute/content/kind`, a `target: { baitonDir: string; git: GitService; topology?: RepoTopology; repoPath: string }`. Logic: if `services.planRepos` is undefined → exactly today's path (`resolveDocument(services.baitonDir, slug)`, `tc.ctx.resolveMutatingPath`, git = `services.git`, topology undefined, repoPath '.'). Otherwise `await services.planRepos.locate(slug)`: `found` → use `target.baitonDir`, containment via `target.guard.resolveMutatingPath(location.documentPath)` when the target is not the owner and via `tc.ctx.resolveMutatingPath` when it is the owner (path '.'), so the owner path is unchanged; ALSO refuse when `tc.ctx.restricted` is true (the guard already disables mutating tools under Restricted Mode, but keep the per-repo guard built with the same flag). `missing` → fall through to the owner path (keeps today's `plan "<slug>" was not found` message). `ambiguous` → `{ok:false, error: 'plan "<slug>" exists in more than one nested repo (<list>); open it from its own repo'}`. Never widen containment: a child target is only ever checked against that child's own document roots.

   2. `writeAndCommit(services, absolute, content, slug, id, what)` gains an optional trailing `git?: GitService` (default `services.git`) and every tool passes `loaded.target.git`, so the commit lands in the owning repo's git. Keep the export signature backward compatible.

   3. `renderPhaseLine(state, id, title, after, files, repo?: string)`: after the `files:` group push `repo: <repo>` when `repo` is defined, trimmed, non-empty and not '.'. Group order `after; files; repo` matches `src/engine/planDraft.ts` (lines ~405-412) so round-trips are identical. A call without `repo` renders byte-identical lines to today.

   4. `add_phase` and `edit_phase` schemas gain `repo: { type: 'string' }` (still `additionalProperties:false`). Read with `readString(args,'repo')`. Validation helper `checkRepoHint(hint, topology, id): string | undefined`: skip when hint is undefined; reject a value containing any of `,;()\n\r` or empty-after-trim except the clear value; when `topology` is defined call `resolvePhaseRepo(hint, topology)` and map `invalid/unknown/sibling/ancestor` to messages mirroring `validator.ts` (e.g. `add_phase: phase "P03" targets repo "x", which is a sibling of the owning repo "."; a phase may only target the owning repo or a repo nested beneath it`). When `topology` is undefined (single-repo host) any hint other than '.' is refused with `add_phase: repo hints need a workspace with nested repos; omit "repo"` — this avoids writing a plan the validator will reject. `add_phase`: pass the hint to `renderPhaseLine`. `edit_phase`: `repo` absent → keep `phase.repo`; `repo` equal to '.' or '' → clear the hint; otherwise validate and set. Note in the tool descriptions: `repo` is the target repo path relative to the plan's owning repo; omit it for the owning repo; changing it invalidates approval and that phase's input rev.

   5. Update the module doc comment: tools write the plan in the repo whose `.baiton/` holds it, commit with that repo's git, and accept an optional `repo` hint on add/edit.

   Files: `src/orchestrator/planWriteTools.ts`

3. draft_plan: let the orchestrator pick the owning repo for a new plan

   In `src/orchestrator/controlTools.ts` `draftPlanTool`: add optional `repo: { type: 'string' }` to the schema and description ('the repo that will own the plan, as a path relative to this repo; omit for this repo'). When `repo` is absent or '.', or `services.planRepos` is undefined (then a non-'.' repo is refused with `draft_plan: this workspace has no nested repos; omit "repo"`), keep today's flow exactly. Otherwise `services.planRepos.target(repo)`; on error return it; use `target.baitonDir` for `locationFor`/`resolveDocument` and `target.guard.resolveMutatingPath` for the containment check; include the repo in `draftConfirmation` (`Draft plan "<slug>" in repo "<repo>" ...`) only when it is not '.'. Dispatch `services.draftPlan.draft({ slug, requirements: request, repo, repos })` where `repos` = the subset of `planRepos.list()` that are the new owner or nested beneath it, rewritten relative to the new owner (only when that subset has more than one entry). Leave the existing `busy` message as is.

   In `src/engine/planDraft.ts`: `PlanDraftRequest` gains `repos?: readonly { path: string; hasBaiton: boolean }[]`; change `requirementsContext(requirements, repos?)` to append, only when `repos` has more than one entry, a `## Repositories` section:
   ```
   ## Repositories

   The plan is owned by `.`. Phases may target it or a repo nested beneath it:

   - `.` (owning repo)
   - `packages/api`
   ```
   With no/one repo the output is byte-identical to today. Pass `req.repos` at the `briefContext` call site.

   In `src/activation/commands.ts` (where `createPlanDraftRunner` and `buildToolServices` are called, ~lines 650-720 and ~1985): build `const planRepos = createPlanRepoSeam({ repos: () => activation.repos, ownerRoot: repoRoot, restricted: () => !vscode.workspace.isTrusted (or whatever guardContextFor uses), gitFor: (root) => path.resolve(root) === path.resolve(repoRoot) ? git : activation.git?.forRepo(root) ?? createGitService(root), exists })` and add `planRepos` to both ToolServices bundles (add a trailing optional param to `buildToolServices`). Replace the single `planDraftRunner` used by the registry's `draftPlan.draft` with a lazily-filled `Map<string, PlanDraftRunner>` keyed by the target repo path: '.'/absent → the existing runner (unchanged deps); a child → `createPlanDraftRunner({ ...sameDeps, workspaceRoot: target.root, services: { ...draftServices, repoRoot: target.root, baitonDir: target.baitonDir, git: target.git } })` sharing the same `repoLocks` (so the child's lock key is the child root, independent of the parent). Strip `repo`/`repos` mapping into `PlanDraftRequest` (`{ slug, requirements, repos }`).

   In the ChatController deps (`src/activation/chatController.ts`) add optional `repoContext?(): PromptRepoContext | undefined` and pass its value as the new trailing argument of `buildSystemPrompt` in `buildPrompt` (both branches). Wire it in commands.ts at `new ChatController({...})` from `planRepos.list()` (return undefined when the list has one entry).

   Files: `src/orchestrator/controlTools.ts`, `src/engine/planDraft.ts`, `src/activation/commands.ts`, `src/activation/chatController.ts`

4. System prompt: describe the discovered repos and the binding rules

   In `src/orchestrator/systemPrompt.ts`:

   - Export `interface PromptRepoContext { readonly repos: readonly { readonly path: string; readonly hasBaiton: boolean }[] }` (paths relative to the conversation's owning repo, owner first as '.').
   - Export `function repoListText(ctx: PromptRepoContext): string` producing:
   ```
   Repositories in this workspace you may plan into (paths relative to this repo):
   - `.` (this repo, owns this conversation's plans)
   - `packages/api` (has its own .baiton/)
   - `packages/web`
   ```
   - Export `const REPO_GATHER_TEXT` (joined lines):
     'Choosing a repo:'
     '- Pick the lowest repo that satisfies the task: the deepest repo that contains every file the work touches.'
     '- When the work stays inside one child repo that has its own `.baiton/`, prefer a plan owned by that child: pass its path as `repo` to `draft_plan`.'
     '- When the work spans this repo and its children, the plan stays here and the plan writer binds each phase confined to a child with a `repo: <path>` hint.'
     '- A phase may target only the repo that owns its plan or a repo nested beneath it. Sibling and ancestor repos are refused; sibling repos never coordinate within one plan.'
     '- `add_phase` and `edit_phase` take the same optional `repo`; omit it for the owning repo. Adding, changing or removing a phase\'s `repo` invalidates approval and that phase\'s input rev.'
   - Export `const REPO_DRIVE_TEXT`: 'Each phase runs in its target repo: the owning repo, or the repo its `repo:` hint names. Approval and the plan journal stay in the owning repo. `submit_pr` opens one pull request per repo the executed phases touched.'
   - Export `const REPO_HINT_GRAMMAR_LINE = '- `repo: <path>` names the phase\'s target repo relative to the repo that owns the plan; omit it for the owning repo.'`
   - `buildSystemPrompt(kind, documentContent?, mode = 'plan', repos?: PromptRepoContext)`: add the trailing optional param. Only when `repos !== undefined && repos.repos.length > 1` AND it is the plan (gather/drive) prompt: push `[repoListText(repos), step === 'drive' ? REPO_DRIVE_TEXT : REPO_GATHER_TEXT].join('\n\n')` right after FLOW_TEXT/DRIVE_TEXT, and append `REPO_HINT_GRAMMAR_LINE` to the grammar section (build a local `grammar = PHASE_GRAMMAR_TEXT + '\n' + REPO_HINT_GRAMMAR_LINE`; do NOT edit the PHASE_GRAMMAR_TEXT constant). Absent / single-repo → the returned string must be byte-identical to today for every kind, step and mode. Leave the run-step prompt and `buildSubAgentPrompt` unchanged (start_run/investigate take no repo argument). Update the file doc comment with one paragraph on the repo context.
   - Keep P06's additions (`pr-partial` status, `prs` key) untouched.

   Files: `src/orchestrator/systemPrompt.ts`

5. Role instructions: plan writer and planner repo guidance

   In `src/engine/roleInstructions.ts`:

   - Export `const PLAN_WRITER_REPO_INSTRUCTION` (joined lines) and append it (after a blank line) to `PLAN_WRITER_INSTRUCTION`'s phase rules:
     'Repositories:'
     '- When the context lists more than one repository, the plan is owned by the one marked as owning; every other listed repo is nested beneath it.'
     '- Choose the lowest repository that satisfies each phase: the deepest one that contains every file the phase touches.'
     '- Set a phase\'s `repo` only when the phase is confined to a nested child repository, as that child\'s path relative to the owning repository (for example `packages/api`). Omit `repo` for phases in the owning repository; never name a sibling or an ancestor.'
     '- A phase\'s `files` are relative to its target repository.'
     '- If every phase would target the same child repository, say in `constraints` that the plan belongs in that child repository.'
     '- When the context lists no repositories, omit `repo` everywhere.'
   - Export `const PLANNER_REPO_INSTRUCTION = 'When the phase line carries a `repo:` hint, the phase runs in that repository: the executor works in its root, and every file path in your plan is relative to it. Without the hint the phase runs in the repository that owns the plan.'` and insert it into the `planner` entry between the 'Write the plan so...' paragraph and `CONTEXT_IS_COMPLETE_INSTRUCTION` (blank-line separated).
   - Do not touch executor/reviewer/investigate text, `EXECUTOR_*` constants or the ask-relay functions.
   - Before finalizing, grep `test/` for assertions on the exact planner or plan-writer strings (e.g. `You are the planner`, `PLAN_WRITER_INSTRUCTION`) and update any that compare whole strings.

   Files: `src/engine/roleInstructions.ts`

6. Tests

   Add/extend tests (mocha + ts-node, mirror existing style):

   1. `test/systemPrompt.repos.test.ts`: (a) property/table test: for workspace kind, plan kind with draft and approved content, and every RunMode, `buildSystemPrompt(k, c, m)` === `buildSystemPrompt(k, c, m, undefined)` === `buildSystemPrompt(k, c, m, { repos: [{path:'.',hasBaiton:true}] })`; (b) multi-repo gather prompt contains `repoListText(...)`, `REPO_GATHER_TEXT`, `REPO_HINT_GRAMMAR_LINE`, 'lowest repo', and not `REPO_DRIVE_TEXT`; (c) approved plan contains `REPO_DRIVE_TEXT`, not `REPO_GATHER_TEXT`; (d) run-step prompt (mode 'bug') with a multi-repo context equals the one without; (e) `PHASE_GRAMMAR_TEXT` section unchanged when no context.
   2. `test/roleInstructions.repo.test.ts`: plan-writer text includes `PLAN_WRITER_REPO_INSTRUCTION` and 'lowest repository'; planner text includes `PLANNER_REPO_INSTRUCTION` and still `CONTEXT_IS_COMPLETE_INSTRUCTION`; executor/reviewer/investigate text unchanged (compare with snapshots taken from constants).
   3. `test/planWriteTools.repo.test.ts` (reuse the temp-git-repo scaffolding from `test/planWriteTools.protectedState.property.test.ts`): without `planRepos`, `add_phase` with no repo writes the same line as before and `repo:'packages/api'` is refused; with a fake `PlanRepoSeam` over a parent repo + child `packages/api` (+ sibling under another folder): `add_phase {repo:'packages/api'}` writes `- [pending] P02 T (after P01; repo: packages/api)` and the result parses (`parsePlan(...).phases[1].repo === 'packages/api'`) and `validatePlan` with the topology passes; sibling/ancestor/unknown hints are refused with nothing written and no commit; `edit_phase` without `repo` preserves an existing hint, `repo:'.'` clears it; adding/removing a hint changes `approvalHash` / the phase input rev (use `src/model/hash.ts` exports) while a hint-less edit keeps them; a slug that lives only in the child's `.baiton/plans` is edited and committed in the child repo's git (check `git log` in the child) and the parent repo gets no commit; an `ambiguous` lookup is refused.
   4. `test/registry.controlTools.test.ts` (or a new `test/controlTools.draftPlanRepo.test.ts`): `draft_plan` without `repo` dispatches `{slug, requirements}` exactly as before; with `repo:'packages/api'` and a fake seam it dispatches `repo` and the relativized `repos`; a non-descendant or no-.baiton repo is refused before confirm; with no seam a non-'.' repo is refused.
   5. `test/engine.planDraft.test.ts`: `requirementsContext(r)` and `requirementsContext(r, [{path:'.',hasBaiton:true}])` equal today's output; with two repos it contains `## Repositories` and the child path.
   6. Unit tests for `createPlanRepoSeam` in `test/planRepos.test.ts` over a hand-built `RepoSet`: list contains owner + descendants only, relative paths use '/', target refuses siblings/ancestors/no-.baiton, locate prefers the owner and reports ambiguity.

   Files: `test/systemPrompt.repos.test.ts`, `test/roleInstructions.repo.test.ts`, `test/planWriteTools.repo.test.ts`, `test/registry.controlTools.test.ts`, `test/engine.planDraft.test.ts`, `test/planRepos.test.ts`

7. Verify

   Run `npm run compile`, `npm run lint` (the pre-existing unused-variable warning in src/orchestrator/webviewProtocol.ts is acceptable), the focused suites `env NODE_OPTIONS=--no-strip-types npx mocha --no-config --timeout 20000 --require ts-node/register --extension ts test/systemPrompt*.test.ts test/roleInstructions*.test.ts test/planWriteTools*.test.ts test/planRepos.test.ts test/registry*.test.ts test/engine.planDraft.test.ts test/runContext.test.ts test/engine.briefWatcher.test.ts`, then `npm test` (git subprocess tests need an unsandboxed run; report if it cannot run) and `git diff --check`.

   Files: (none)

## Risks

- Writing a child-owned plan needs a GuardContext bound to that child repo; it must only ever check against the child's own .baiton/plans and .baiton/specs. Never pass a parent or workspace-folder root, and never widen the conversation guard's documentRoots.
- The chat conversation stays bound to the primary repo (chatController lists plans from its own baitonDir). A child-owned plan created through draft_plan(repo) appears in the Plan Explorer, but a plan conversation for it may still read the primary baitonDir. The slug lookup in planWriteTools covers writes; keep chat reads unchanged in this phase and mention the gap in the execution notes.
- Byte identity: buildSystemPrompt with no or single-repo context, renderPhaseLine without repo, requirementsContext without repos, and draft_plan without repo must produce exactly today's output. Existing tests that compare whole strings will catch regressions, and the new property test pins the prompt.
- The `repo` hint grammar used by the parser (src/model/parser.ts parseHints) rejects values containing `,;()` and newlines and accepts only one repo group. planWriteTools must reject such values up front, or it writes a line that parses as part of the title.
- Paths in the hint are relative to the owning repo, but RepoSet names are folder-relative (plus the folder name in multi-root). Use path.relative between roots for PlanRepoInfo.path, and use resolvePhaseRepo with repoTopologyFor(set, owner.name) for validation. Do not compare hints to RepoSet names directly.
- Telling agents that phase `files` are relative to the target repo assumes the executor's cwd is the target repo worktree, as P03–P05 implemented. If the stage context or runQueue resolves `files` against the owner, adjust the instruction wording to match the code, not the reverse.
- Changing the planner and plan-writer brief text may break tests that snapshot the brief (engine.briefWatcher, runContext, engine.launcher). Update only the exact-string assertions, not behaviour.
- The per-repo draft runner map must share the single `repoLocks` instance so that one-stage-per-repo holds across draft, run pipeline and queues.

## Acceptance

- `npm run compile` and `npm run lint` pass. Lint shows no new warnings.
- `npm test` passes, or if git EPERM blocks the sandbox, the escalated run passes. Every new test listed above exists and passes.
- buildSystemPrompt(kind, content, mode) returns byte-identical output with no repo context, an undefined repo context, or a single-repo context, for every kind, step and mode. With two or more repos, the gather prompt lists the repos and states the lowest-repo, prefer-child-plan, owner-or-descendant-only and repo-hint rules. The drive prompt lists the repos and per-repo execution and PRs. The run-step and sub-agent prompts are unchanged.
- PLAN_WRITER_INSTRUCTION tells the writer to choose the lowest repository, to set `repo` only for nested child targets relative to the owner, to never name siblings or ancestors, and to flag a plan that belongs in one child. The planner instructions explain that a `repo:` hint means the phase runs in that repository. Executor, reviewer and investigate text is unchanged.
- add_phase and edit_phase accept an optional `repo`. A valid child hint renders as `(...; repo: <path>)` in after/files/repo order and parses back with Phase.repo set. Unknown, sibling, ancestor and malformed hints are refused with no file write and no commit. edit_phase preserves an existing hint when `repo` is omitted and clears it on '.'. Without a plan-repo seam, any hint other than '.' is refused.
- Adding, changing or removing a hint via the tools changes the approval hash and that phase's input rev. A hint-less add or edit produces exactly the bytes the tools produced before this phase.
- Plan-writing tools edit a plan that lives only in a nested repo's .baiton/ in that repo's document and commit it with that repo's git. The parent repo receives no commit. A slug present in more than one nested repo is refused. Containment for a child is evaluated only against that child's .baiton/plans and .baiton/specs.
- draft_plan without `repo` behaves exactly as before. draft_plan with `repo: <child path>` validates the child (descendant, has .baiton/) before confirming, then launches the plan writer in the child repo. The plan writer runs under the child's repo lock and writes plan.md into the child's .baiton/plans/<slug>/. Its brief context lists the repositories when there is more than one.
- `git diff --check` reports nothing.
