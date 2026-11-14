---
version: 1
name: rename-roles-and-branch-completion
status: approved
mode: manual
base: main
base_commit: 3575b59b64632aa8a23baa2f0047c7060be89086
branch: baiton/rename-roles-and-branch-completion
approved_rev: 75f995748664d7a8844c6105db9c5c9050591572e8fecd15398d5b0557bc97f8
---

# Endstate

**Role names.** The role list in `src/model/role.ts` is `phased-planner`, `step-planner`, `step-reviewer`, `executor`, `reviewer`, `pr-writer`, in that order. `phased-planner` drafts the whole phased plan (`plan-draft` stage, `draft_plan` tool). `step-planner` writes one phase's plan (`plan` stage). `step-reviewer` reviews that phase plan (`plan-review` sub-stage). The new names appear everywhere a user can see a role: the `STAGE_ROLE` map, role profiles (`baiton-phased-planner`, `baiton-step-planner`, `baiton-step-reviewer`, with matching descriptions and prompt fragments), role instructions, the plan-draft error text (`roles.phased-planner.agent`), the orchestrator's system prompt and `draft_plan` tool text, the default config, the Config Panel roles table (`media/config.js` mirrors `ROLES` in the same order) and the README. A `config.json` written before the rename still loads. `roles.spec-writer` and `roles.plan-writer` are read as `phased-planner`, `roles.planner` as `step-planner` and `roles.plan-reviewer` as `step-reviewer`. An explicit new-name key always wins over a legacy key. A config with no drafting entry at all still inherits the step planner's entry, as it does today. Every new write uses the new names: the default config, a Config Panel save and the role profiles. This repository's own `.baiton/config.json`, which uses `spec-writer`, `plan-writer`, `planner` and `plan-reviewer`, loads unchanged.

**opencode link.** The Config Panel's Model column shows no Documentation link for opencode or any other agent. `OPENCODE_MODEL_DOC_URL` no longer exists. The generic optional `modelLink` seam stays in the adapter capability and in the form options; no adapter supplies a value.

**PR status.** A successful Submit PR leaves the plan document reading `status: pr` (or `pr-partial`) with its `pr:`/`prs:` URLs, on the branch that the pull request actually merges. Once that PR merges, the base branch's copy of the document says `pr`, not `approved`. A record step that cannot complete returns a visible `record-failed` error and is never swallowed. `checkReady`'s refusals and the `pr-partial` retry behave exactly as before.

**Branch-derived completion.** The Plan Explorer lists a plan under Completed when its status is `done`, or when every recorded PR reads merged (today's route, unchanged), or when its recorded `branch:` is merged into its recorded `base:` on the configured remote. The third route writes nothing: no frontmatter key, no commit, no push, no checkout. Front matter, phase lines and approval hashes stay byte-identical. `pr-merged-completes-plan`, `config-panel-settings-and-api-keys` and `config-panel-toolbar-and-legacy-key-cleanup` read as Completed without their documents being touched. A plan marked complete through its branch offers Show PR only when it has a recorded PR, and no actions otherwise.

# What needs changing

### Role rename (TypeScript, webview, docs)

- `src/model/role.ts`: the `Role` union and `ROLES` take the new names, in the order `phased-planner`, `step-planner`, `step-reviewer`, `executor`, `reviewer`, `pr-writer`. Update the doc comments.
- `src/adapter/roleProfile.ts`: the role keys, `agentName` (`baiton-phased-planner`, `baiton-step-planner`, `baiton-step-reviewer`), descriptions, and the `readOnlyFragment(...)` / prompt text that name the role.
- `src/activation/engineFacade.ts` (`STAGE_ROLE`, the `role: 'planner'` literal, comments), `src/engine/runPipeline.ts` (`plan: 'planner'`), `src/activation/commands.ts` (`AUTO_MODE_FALLBACK_ROLE`).
- `src/engine/roleInstructions.ts` (instruction map keys) and `src/engine/planDraft.ts` (`PLAN_WRITER_ROLE`, the doc comment, and the `role "…"` / `roles.<role>.agent` error text).
- `src/config/defaultConfig.ts`: new names only.
- `src/config/loadConfig.ts`: replace the single-key `LEGACY_ROLE_KEYS` with an ordered list of legacy keys per role:
  - `phased-planner` ← `plan-writer`, then `spec-writer`
  - `step-planner` ← `planner`
  - `step-reviewer` ← `plan-reviewer`

  Resolution order is: the new key, then the legacy keys in order, then `ROLE_FALLBACKS`. `phased-planner` falls back to the resolved `step-planner` entry, which covers a legacy `planner` key. Missing-section errors name the new role.
- `src/config/configPanel.ts` (`applyFormToDocument`): writes the new keys. A legacy key whose value now lives under its new name is dropped from the written document, so a saved file does not keep a stale duplicate. Other unknown role keys still survive untouched.
- `src/adapter/permissions.ts`, `src/adapter/antigravity.ts` and other `src/adapter/*` comments that list roles. `src/orchestrator/systemPrompt.ts`, `src/orchestrator/controlTools.ts` (`draft_plan` description and reply text), `src/orchestrator/planWriteTools.ts`, `src/orchestrator/autoMode.ts` (its example in the comment), and the `src/schema/types.ts` comments.
- `media/config.js`: the `ROLES` mirror in the same order, plus the roles-table labels.
- `README.md`: role names, the roles table, and the legacy-key paragraph, which now lists all four legacy keys and their precedence.
- Tests that spell role names: `test/adapter.*`, `test/config*.test.ts`, `test/configPanel.*`, `test/fixtures/configFormCases.ts`, `test/mode.test.ts`, `test/roleInstructions.repo.test.ts`, `test/engine.planDraft.test.ts`, `test/systemPrompt.test.ts`, `test/autoMode.*`, `test/askWatcher.routing.test.ts`, `test/engine.*`, `test/runQueue.*`, `test/runPipeline.test.ts`, `test/integration.plan-execute-review.test.ts`. New config tests cover each legacy key, new-key-wins when both keys exist, the `spec-writer`/`plan-writer` precedence, and the repo's own legacy-shaped config.

### opencode Documentation link

- `src/adapter/opencode.ts`: delete `OPENCODE_MODEL_DOC_URL` and its export.
- `src/adapter/index.ts`: drop `modelLink` from the opencode capability entry. Leave the `modelLink` field in `src/adapter/adapter.ts`, `src/config/configPanel.ts`, `src/orchestrator/providers.ts` and `media/config.js`.
- Tests: `test/adapter.index.test.ts`, `test/adapter.opencode.test.ts`, `test/modelSelectorRefresh.test.ts`, `test/configPanel.view.test.ts`. Assert that no agent renders a Documentation link and that the seam still renders one when a capability supplies it.

### Submit PR record step

- `src/engine/submitPr.ts`: fix the owner path (the record block around line 336) and the grouped path (`recordGroupedPr`, around line 574).
  - The phase first reproduces the bug in a test against the fake git and PR seams. The leading hypothesis is ordering: the branch is pushed and the PR opened *before* the `plan(<slug>): pr` record commit is made. The record commit then exists only locally, and the merged PR carries only `plan(<slug>): pr draft`.
  - The fix makes the recorded status reach the pushed branch, for example by pushing the branch again after the record commit. A push or commit failure there returns `record-failed` naming the PR URL. The journal's `PrCompletion.record` flag is true only once the record is actually on the remote.
- Tests: `test/submitPr.*` and `test/transitions.prStatus.test.ts`.

### Git ancestry read

- `src/git/types.ts` / `src/git/gitService.ts`: add `isAncestor(ancestor, descendant): Promise<boolean>`, backed by `git merge-base --is-ancestor`. Exit 0 means true, exit 1 means false, and any other exit rejects. Add a targeted fetch of a single ref, or reuse `fetch(remote)`, so a remote-only merge becomes visible through `<remote>/<base>`.
- Update the fake git used in tests, plus a new fake-git test for the exit-code mapping and the fetch arguments.

### Branch-derived completion

- `src/model/treeModel.ts`: add a derived `branchMerged?: boolean` fact to `PlanInput`/`PlanGroupFacts`/the plan node. `planGroupKind` returns `completed` when it is true, alongside the existing `done` and `prsMerged` routes.
- `src/model/planActions.ts`: when `branchMerged` is true, offer `showPr` only when a PR is recorded, and nothing otherwise.
- `src/activation/planExplorer.ts`: add a `branchMerged` checker option with a per-session memo and log-once set, mirroring `prsMergedFor`. The refresh reads the memo synchronously, starts the check in the background and re-refreshes when it reads true. It never awaits.
- `src/activation/commands.ts`: wire a `branchMergedForPlan` checker. It resolves the plan's repo root and its configured remote/base the same way `prsMergedForPlan` does, fetches at most once per plan per session, finds the branch tip (the local `branch:`, else `<remote>/<branch>`), and tests ancestry against `<remote>/<base>`.
- Tests: `test/treeModel.property.test.ts`, `test/planActions.property.test.ts`, `test/planExplorer.test.ts`.

# Limitations & constraints

- **No persisted completion.** A merged branch triggers no `status: done` write, no `setFrontmatterKey`, no commit, no push and no checkout. `status`, `pr`/`prs`, `approved_rev`, `base_commit` and every phase line stay byte-identical, so approval hashes and input revs of existing documents are unaffected.
- **Both derivation routes stay.** `done` and the all-PRs-merged route keep today's behaviour and tests. The branch route is a third, independent fact.
- **Never block, never throw.** These cases all degrade to "not complete": a missing `branch:`/`base:`, an unconfigured remote, a missing git CLI, a network or fetch failure, or an unresolvable branch tip (for example, branch deleted locally and on the remote). Each is logged at most once per plan per session. `PlanExplorer.refresh` never awaits git or the network and never throws.
- **No false positives.** A branch whose tip equals its recorded `base_commit` has no commits of its own. It is trivially an ancestor of base and must not read as merged. Require the tip to be strictly ahead of `base_commit` when one is recorded. Where none is recorded, require the tip to differ from the base tip.
- **Remote-accurate.** Ancestry is tested against the configured remote's tracking ref (`<remote>/<base>`), refreshed at most once per plan per session. A local `base` alone is not enough.
- **Known limits.** A squash or rebase merge does not make the branch an ancestor of base, so the branch route cannot detect it. Such plans stay covered only by the recorded-PR route. The branch route looks only at the owning repo's recorded `branch:`/`base:`; nested-repo plan branches are out of scope.
- **The submit-status fix is a diagnosis, not a guess.** Reproduce in a test why the `plan(<slug>): pr` record commit does not reach the merged history, then fix that cause. Do not weaken `checkReady`'s refusals (`done`, missing approval, unlanded phases, already-recorded PR) or the `pr-partial` retry, which still resubmits only the failed repos.
- **Config compatibility.** All four legacy role keys keep loading. A new-name key always wins over a legacy key. The existing `phased-planner` ← `step-planner` fallback is kept. Do not hand-edit this repo's `.baiton/config.json`; it is the live legacy-shape fixture.
- **Narrow link removal.** Only opencode's `modelLink` value goes. The generic `modelLink` seam stays in the adapter capability, the form options and the webview, so claude, codex and antigravity are unaffected.
- **Role rename scope.** `executor`, `reviewer` and `pr-writer` keep their names. Stage ids (`plan-draft`, `plan`, `plan-review`), tool names (`draft_plan`) and run-directory and journal formats do not change.
- **Style.** Exported symbols get doc comments. Tests use injectable seams (fake git, fake PR tool, fake run command) rather than real `child_process` or `git`. Pure helpers in `src/model/*` have no VS Code imports.

# PHASES

- [done] P01 Rename plan-writer/planner/plan-reviewer to phased-planner/step-planner/step-reviewer with legacy config keys (files: src/model/role.ts, src/adapter/roleProfile.ts, src/adapter/permissions.ts, src/adapter/antigravity.ts, src/activation/engineFacade.ts, src/activation/commands.ts, src/engine/runPipeline.ts, src/engine/roleInstructions.ts, src/engine/planDraft.ts, src/config/defaultConfig.ts, src/config/loadConfig.ts, src/config/configPanel.ts, src/orchestrator/systemPrompt.ts, src/orchestrator/controlTools.ts, src/orchestrator/planWriteTools.ts, src/orchestrator/autoMode.ts, src/schema/types.ts, media/config.js, README.md, test/config.test.ts, test/configPanel.view.test.ts, test/fixtures/configFormCases.ts, test/adapter.roleProfile.test.ts, test/engine.planDraft.test.ts, test/mode.test.ts, test/roleInstructions.repo.test.ts, test/systemPrompt.test.ts)
- [planning] P02 Remove the opencode model Documentation link, keeping the generic modelLink seam (files: src/adapter/opencode.ts, src/adapter/index.ts, test/adapter.index.test.ts, test/adapter.opencode.test.ts, test/modelSelectorRefresh.test.ts, test/configPanel.view.test.ts)
- [pending] P03 Diagnose and fix Submit PR so the pr/pr-partial record lands on the pushed branch (files: src/engine/submitPr.ts, test/transitions.prStatus.test.ts)
- [pending] P04 Add a git ancestry read (merge-base --is-ancestor) and remote ref refresh to GitService (files: src/git/types.ts, src/git/gitService.ts)
- [pending] P05 Derive Completed from the recorded branch being merged into base in the Plan Explorer (after P04; files: src/model/treeModel.ts, src/model/planActions.ts, src/activation/planExplorer.ts, src/activation/commands.ts, test/treeModel.property.test.ts, test/planActions.property.test.ts, test/planExplorer.test.ts)
