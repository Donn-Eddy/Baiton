---
version: 1
name: child-repo-plans-first-class
status: approved
mode: manual
base: main
base_commit: 8fbbb806e56c3d4c65a73110713bb0370db588d6
branch: baiton/child-repo-plans-first-class
approved_rev: 0a46fc1b3426ccf70e66ce983c1cc93616614972a1849acdc67dc66695c3e370
---

# Endstate

Every plan is addressed by the pair (owning repo, slug), and every surface that shows or acts on a plan carries both. The owning repo is the discovered repo whose `.baiton/plans` (or legacy `.baiton/specs`) holds the document. A plan owned by a child repo can do everything an owner plan can. It is listed in the Plan Explorer under its own repo label. Clicking it opens the Chat view as its own conversation. Its document gets phase CodeLens. It appears in every palette picker. Plan, Execute, Review, Re-plan, Stop, Approve, View plan, Show PR and Submit PR all work from the explorer row, the CodeLens and the palette. None of this requires opening the child repo as the workspace folder, and no feature quietly works only for owner plans.

Chat conversations are keyed by (repo, slug). An owner plan and a child plan with the same slug are two conversations with two transcript folders, each under its own repo's `.baiton/`. Owner-plan transcripts, child sessions and legacy `chat.jsonl` migration resolve to exactly the paths and workspaceState keys they use today.

A bare slug still works and means "the plan with this slug" when exactly one discovered repo has it. When two or more repos have it, nothing guesses. The explorer shows both rows and every list-style surface shows both entries. Pickers offer the qualified choices. A call that cannot show a chooser, such as an orchestrator tool, refuses and names the candidates as `<repoPath>:<slug>`. Owner-wins precedence is gone from `planRepos.locate`.

`update_overview`, `add_phase`, `edit_phase`, `remove_phase`, `land_phase`, `submit_pr`, `approve_plan` and the plan reads (`list_plans` and reading a plan) can target any discovered repo with a `.baiton/`, using an optional owning-repo argument or the qualified `<repoPath>:<slug>` form. Guard containment for each write is that repo's own `.baiton/plans` and `.baiton/specs` and nothing wider. Refining another repo's plan from one conversation is a normal, supported flow. Two child-repo plans can run phases at the same time, each with its own plan store, writer and queue entries in the engine facade. Submit PR resolves base branch, remote and PR tool from the plan's repo, not the conversation's.

# What needs changing

**Plan addressing seam (`src/orchestrator/planRepos.ts`, `src/orchestrator/seams.ts`).** Widen `createPlanRepoSeam` from "the owner and the repos nested beneath it" to "every discovered repo that has a `.baiton/`". Phase worktrees are still excluded, as discovery already ensures. `PlanRepoInfo.path` stays relative to the conversation owner when the repo is beneath it. Add the following:

- A forward lookup from repo path to `PlanRepoTarget`, replacing the subtree-only `target()`.
- A `locate(slug, repo?)` that returns *found / missing / ambiguous(candidates)* with no owner-wins step.
- A small pure parser and formatter for the qualified `<repoPath>:<slug>` form, so every layer spells candidates the same way.

With no discovery, or a single repo, the seam degenerates to today's synthetic owner target.

**Tree model (`src/model/treeModel.ts`).** `PlanNode`, `PhaseNode` and `ErrorNode` gain an *owning* repo field, kept separate from the phase's *target* repo (the `repo:` hint). Labels and actions are unchanged when there is one repo.

**Session storage (`src/orchestrator/sessionStore.ts`, `subAgent.ts`, `interventions.ts`).** The plan `SessionScope` carries its owning repo and the owning repo's `baitonDir`, so `dirFor`, `pathFor`, `childrenDirFor` and `legacyPathFor` resolve against that repo. `scopeId` returns the bare slug for an owner-repo plan, which keeps today's keys, and a repo-qualified id for a plan in any other repo.

**Orchestrator tools (`planWriteTools.ts`, `readTools.ts`, `controlTools.ts`, `toolServices.ts`, `guard.ts`).** `ToolServices.planRepos` becomes mandatory, and `buildToolServices` always passes it. Each plan tool takes an optional owning-repo argument and also accepts the qualified slug. It resolves through the widened seam and returns the candidate list on ambiguity in place of the current "exists in more than one nested repo" refusal. `checkRepoHint` validates the phase `repo:` hint against the plan's own repo topology, with no conversation-subtree rule. Every write binds its `GuardContext` to the target repo's `.baiton/`. `list_plans` lists across repos with qualified names wherever a slug collides. `land_phase`, `submit_pr` and `approve_plan` act on the plan's repo, and `src/engine/submitPr.ts` receives the plan's repo as the base for its per-repo grouping.

**Prompts (`src/orchestrator/systemPrompt.ts`, `src/engine/roleInstructions.ts`).** `ConversationKind` for a plan carries its owning repo, so the plan prompt can name it. The tool guidance teaches the qualified form and the ambiguity reply. Single-repo prompt text stays byte-identical.

**Engine facade (`src/activation/engineFacade.ts`).** Each discovered `.baiton/` repo gets its own `planStore`, `planWriter` and owner entry, created lazily and keyed by repo root. Queues stay keyed per (owning repo, slug, phase), so child-repo plans run concurrently with each other and with owner plans.

**Commands and CodeLens (`src/activation/commands.ts`).**

- `slugArg`, `phaseArgs`, `resolveTarget`, `pickPlanSlug` and `promptForSlug` return a repo-qualified target. Tree-node arguments carry the owning repo, and string arguments accept the qualified form. Pickers list every discovered repo's plans and label them by repo only when there is more than one repo.
- `queueFor`, `phaseQueues.find`, the stage and action commands, `runView`, `runViewPlan`, `runShowPr` and `runSubmitPr` take that target and resolve the plan's `baitonDir` and git service from it.
- `PlanCodeLensProvider` watches `**/.baiton/{plans,specs}/*/*.md` across the workspace. It derives the owning repo from the document path, matched against discovered repos, reads that repo's journal and phase plans, and passes the repo in each lens's arguments.

**Plan Explorer (`src/activation/planExplorer.ts`, `src/activation/planLister.ts`, `src/activation/commands.ts`).** Construct `PlanExplorer` with `options.sources`, one source per discovered `.baiton/` repo built from `planListingRepos`. Each source has its own `isApproved`, `topology` and `actionable`. `actionable` is false in Restricted Mode, and false for a repo whose `.baiton/` cannot be loaded. `listPlansAcrossRepos` becomes the only listing path, with the single-repo case as a one-source list. The `openPlan` sink and every inline action pass the owning repo with the slug, and de-duplication keys on (repo, slug).

**Chat controller (`src/activation/chatController.ts`, plus the workspaceState wiring in `commands.ts`).** `activePlan` becomes an owner-qualified identity `{ repo, slug }` at all of its roughly 14 sites. `setActivePlan`, editor-follow, `readPlanDocument`, `buildPrompt`, `stepForConversation`, `buildConversationItems` and `scopeForAsk` all resolve against the plan's repo. The session-memory key `baiton.chat.session.<scopeId>` and the migration key take the new `scopeId`, so owner-plan keys are unchanged.

# Limitations & constraints

- **Single-repo workspaces behave exactly as they do today** at every boundary: activation, the initialize flow, tree output and labels, chat scopes, dispatch, prompt text and single-PR submission. Every phase must leave the repository building and its full test suite passing. A phase that changes a shared signature updates its callers in the same phase.
- **No change to the plan or spec document format.** Plan identity comes from location under a repo's `.baiton/`. No `repo:` frontmatter key is added. Approval hashes and input revs of existing documents stay byte-identical.
- **No precedence when resolving a bare slug.** A bare slug resolves only when it is unique across discovered repos. Nothing resolves by precedence: no owner-wins (which means removing today's owner-first step in `planRepos.locate`) and no first-found. Ambiguity is reported as `<repoPath>:<slug>` candidates and never picked silently.
- **Transcript compatibility is absolute.** For owner-repo plans, `scopeId`, `dirFor`, `legacyPathFor`, child-session paths, the `baiton.chat.session.<scope>` workspaceState key and legacy `chat.jsonl` migration must resolve to exactly the values they produce today. Only plans in other repos get new, repo-qualified keys.
- **Restricted Mode still disables every write and dispatch**, including those aimed at child repos, and no child source is actionable there. Widening the write target must not widen path containment past the target repo's own `.baiton/plans` and `.baiton/specs`. No write may reach the workspace folder, a parent repo, or another repo's source tree.
- **Source-read tools keep their per-conversation repo binding.** `read_file`, `list_files`, `search` and `git_*` stay bound to the conversation's repo. Only plan addressing, plan reads and plan writes widen. The `draftPlan.draft` root-rebinding seam in `src/activation/commands.ts` stays the only route to reading another repo's source.
- **Discovery stays bounded and unchanged.** A repo is a valid plan target only if it has a `.baiton/`, and a phase worktree must never be listed as a repo. Nothing changes the config schema, adds a repo declaration file, or changes how `.baiton/` is discovered or ignored.
- **Pure modules stay `vscode`-free.** Model, storage and orchestrator modules (`planRepos`, `treeModel`, `sessionStore`, the tools, `systemPrompt`) keep their injected seams and do not import `vscode`. The activation layer stays the only place that touches the host.
- **Phase ownership.** All phases target files in the owning repository, so no phase sets `repo`.

# PHASES

- [done] P01 Widen the plan-repo seam to every discovered .baiton/ repo, with forward lookup, precedence-free locate, and a qualified <repoPath>:<slug> parser (files: src/orchestrator/planRepos.ts, src/orchestrator/seams.ts, src/activation/repoDiscovery.ts, test/planRepos.test.ts)
- [done] P02 Add an owning-repo field to plan, phase and error tree nodes, distinct from the phase target repo (files: src/model/treeModel.ts, test/treeModel.property.test.ts)
- [done] P03 Make session scopes owner-aware so transcripts resolve against the plan's repo and owner-plan paths and keys stay unchanged (files: src/orchestrator/sessionStore.ts, src/orchestrator/subAgent.ts, src/orchestrator/interventions.ts, test/sessionStore.test.ts, test/sessionStore.property.test.ts)
- [done] P04 Re-address the orchestrator plan tools through the mandatory seam: optional owning repo, ambiguity candidates, guard bound to the target repo's .baiton/, plan-repo submit_pr (after P01; files: src/orchestrator/toolServices.ts, src/orchestrator/planWriteTools.ts, src/orchestrator/readTools.ts, src/orchestrator/controlTools.ts, src/orchestrator/guard.ts, src/engine/submitPr.ts, src/activation/commands.ts, test/planWriteTools.repo.test.ts, test/registry.controlTools.test.ts, test/submitPr.multiRepo.test.ts, test/guard.repoBinding.test.ts)
- [done] P05 Carry the owning repo in ConversationKind and teach the qualified plan form in the system prompt and role instructions (after P04; files: src/orchestrator/systemPrompt.ts, src/engine/roleInstructions.ts, test/systemPrompt.repos.test.ts, test/systemPrompt.test.ts)
- [done] P06 Give each discovered .baiton/ repo its own plan store, plan writer and owner entry in the engine facade (after P01; files: src/activation/engineFacade.ts, src/activation/planStore.ts, test/engineFacade.resume.test.ts)
- [done] P07 Resolve palette and command targets as (repo, slug): qualified pickers, queueFor, stage/action commands, view, view plan, show PR and submit PR (after P01, P02, P06; files: src/activation/commands.ts, test/runCommands.test.ts)
- [done] P08 Serve phase CodeLens for plan documents in any repo, deriving the owning repo from the document path (after P07; files: src/activation/commands.ts)
- [done] P09 Feed the Plan Explorer one source per discovered .baiton/ repo and carry the owning repo through openPlan and inline actions (after P02, P07; files: src/activation/planExplorer.ts, src/activation/planLister.ts, src/activation/commands.ts, test/planExplorer.test.ts, test/planLister.test.ts)
- [planning] P10 Key chat conversations by (repo, slug): owner-qualified activePlan, plan reads, prompts, ask scopes and workspaceState session memory (after P03, P05, P09; files: src/activation/chatController.ts, src/activation/commands.ts, test/chatController.mode.test.ts, test/chatController.subAgents.test.ts)
