---
version: 1
name: monorepo-support
status: approved
mode: manual
base: main
base_commit: b1172d339642bb14e741b8934f540126f3747ec1
branch: baiton/monorepo-support
approved_rev: 08f9f9c1537adae7e4b42fb8c262301c26a1603413d0f4be16a63839436d3a77
---

# Endstate

Baiton works inside a monorepo, and the user declares nothing for it. On activation it walks every workspace folder and finds the repo boundaries itself. Every nested `.git` directory and every existing `.baiton/` directory defines a repo. Each repo is named by its path relative to the workspace folder (the folder root itself is the root repo) and knows its parent and children. The `multiple-baiton-roots` refusal is gone. One VS Code workspace can hold several repos that each own a `.baiton/`, and every plan and run under any of them is listed.

A plan is owned by exactly one repo: the repo whose `.baiton/` holds its document. Each phase line may carry a `repo` hint naming its target repo. The target must be the owning repo or a repo nested beneath it. The validator refuses sibling and ancestor targets. A phase without the hint, which includes every plan and legacy spec document that exists today, targets the owning repo, and those documents keep byte-identical approval hashes and input revs.

Each phase runs in its target repo. Its worktree, branch, git service, journal-free run artifacts, guard containment and adapter launch cwd all resolve against that repo. The one-stage-per-repository lock is now one stage per repo: two stages in the same repo never overlap, while stages in unrelated repos run independently. Approval, input rev and the plan journal stay in the owning repo's `.baiton/`, so a parent plan records its child-repo phases completely.

The Plan Explorer labels each plan with its owning repo and each phase with its target repo when that differs. The Runs view labels each run with its repo. `submit_pr` opens one PR per distinct repo the plan's executed phases touched, each against that repo's configured base branch. The plan reaches done only when every one of those PRs succeeds. A partial failure is a distinct, reported state that can be retried for the repos still missing. The orchestrator's system prompt and the plan-writer instructions tell agents to pick the lowest repo that satisfies a task and to prefer a child-repo plan when the work is confined to one child.

# What needs changing

**Repo discovery and identity.** Add a new pure module, for example `src/activation/repoDiscovery.ts`, with an injected filesystem seam. It walks each workspace folder, skipping `node_modules`, `.git` internals and Baiton's own worktree directories. It records every directory that contains `.git` (a directory or a worktree `.git` file) or `.baiton/`. Each repo gets a stable name (its folder-relative path, plus the folder name in a multi-root workspace), a canonicalized root, an optional `baitonDir`, a parent and children. Helpers answer `repoFor(path)` (the deepest containing repo) and `isWithinSubtree(owner, target)`.

`src/activation/workspace.ts` stops choosing one root. It returns a repo set: the existing trust flag plus the discovered repos. Single-folder workspaces still resolve to that folder's repo even when it has no `.baiton/` yet, so the initialize flow is unchanged. `src/extension.ts` builds the repo set, loads config per repo that has a `.baiton/`, and keeps a primary repo for the surfaces that are still single-root until later phases convert them.

**Plan/phase binding.** `src/model/parser.ts` adds a `repo` hint group alongside `after` and `files`, for example `(after P01; repo: packages/api)`, and exposes `repo?: string` on `Phase`. `src/model/writer.ts` and `src/engine/planDraft.ts` round-trip the hint, and the plan-draft result schema in `src/schema/schemas.ts` gains an optional per-phase `repo`. `src/model/hash.ts` keeps hashing the raw phase line, so a phase that has no hint hashes exactly as before and adding, removing or changing the hint changes both the approval hash and that phase's input rev on purpose. `src/model/validator.ts` resolves the hint against the plan's owning repo and refuses unknown, sibling and ancestor targets with a clear message. The validator receives the repo topology as an injected input so it stays pure.

**Repo-aware execution.** The single `workspaceRoot` becomes a per-phase target repo root in `src/engine/phaseWorktree.ts`, `src/engine/runWorktree.ts`, `src/engine/runStore.ts`, `src/engine/launcher.ts`, `src/engine/resultFlow.ts`, `src/engine/resultValidation.ts`, `src/engine/askRelay.ts`, `src/engine/runPipeline.ts` and `src/git/gitService.ts`. One git service is created per repo. `src/activation/planStore.ts`, the journal path helpers (`planJournalPathFor`, `phaseJournalPathFor`) and approval/input-rev reads keep resolving against the owning repo's `baitonDir`. `src/engine/runQueue.ts` and `src/engine/planDraft.ts` replace the repository lock with a lock map keyed by repo. In `src/activation/engineFacade.ts`, the queue cache and `phaseQueueKey` become keyed by owning repo, slug and phase, and `isRunning(slug)` becomes `isRunning(repo, slug)`. `src/orchestrator/guard.ts`, `readTools.ts` and `toolServices.ts` check path containment and result-write confinement against the target repo of the stage being run. `src/activation/commands.ts` resolves the owning repo from the tree item rather than from a single workspace root.

**UI labelling.** `src/model/treeModel.ts` and `src/model/runTreeModel.ts` carry repo identity. `src/activation/planLister.ts` lists plans across every repo's `.baiton/`. `src/activation/planExplorer.ts` and `src/activation/runsExplorer.ts` render a repo label on plan rows, phase rows whose target differs from the owner, and run rows.

**Per-repo PR submission.** `src/engine/submitPr.ts` groups executed phases by target repo and produces one diff, branch and PR per repo against that repo's configured base branch. It returns a multi-PR result. `src/engine/prTool.ts` reports each PR. `src/model/planActions.ts` and `src/engine/transitions.ts` gain a partial-failure plan state: done only when all PRs succeed, otherwise a reported partial state whose retry re-submits only the failed repos. A single-repo plan behaves exactly as today.

**Guidance.** `src/orchestrator/systemPrompt.ts` describes the discovered repos and the binding rules. `src/engine/roleInstructions.ts` (the plan-writer and planner instructions) tells agents to choose the lowest repo that satisfies the task, to prefer a child-repo plan when the work stays inside one child, and to emit the `repo` hint only for child targets. The orchestrator's plan-writing tools (`src/orchestrator/planWriteTools.ts`) accept the hint and write the new plan into the right repo's `.baiton/`.

# Limitations & constraints

- There is no repo declaration file and no repos list in config, and the config schema version does not change for discovery.
- Existing plan and legacy spec documents keep working untouched. A missing `repo` hint means the owning repo, and their approval hash and input rev must stay byte-identical. Pin this with a property test over hint-less phase lines. Adding, changing or removing a `repo` hint is a deliberate content change that invalidates approval and that phase's input rev, and tests must cover it.
- The validator refuses any phase bound to a sibling or an ancestor of the owning repo, and any phase bound to an unknown repo. A plan in a child repo can only target itself.
- One stage at a time per repo stays absolute. That includes plan-draft and plan-less run-pipeline stages, which take the lock of the repo they run in. Unrelated repos must not block each other, and a parent and a child repo are distinct repos for locking.
- Sibling repos never coordinate within a single plan.
- Restricted Mode, path containment and result-write confinement still hold, now evaluated against each stage's target repo. Nothing may widen containment to the workspace folder or to a parent repo.
- Baiton never edits source code outside its own `.baiton/` plan-writing tools, and this change must not weaken that.
- Approval, input rev and the plan journal live only in the owning repo's `.baiton/`. A child repo's `.baiton/` never receives entries for a parent's plan.
- Single-repo workspaces must behave exactly as before at every phase boundary. That covers activation, the initialize flow, tree output, lock behaviour and single-PR submission. The repository must build and pass its test suite after every phase.
- Discovery must be bounded and cheap. It skips `node_modules`, `.git` internals and Baiton-managed worktree directories, and must not treat a phase worktree as a new repo.
- Pure model and engine modules keep their injected seams (no direct `vscode` or real-filesystem dependency in the core), matching the existing `resolveWorkspace` and guard designs.

# PHASES

- [done] P01 Add repo discovery and repo identity, replacing single-root workspace resolution (files: src/activation/workspace.ts, src/extension.ts, src/git/gitService.ts, test/activation.gating.test.ts)
- [done] P02 Parse, write and hash the per-phase repo hint, and validate subtree-only bindings (after P01; files: src/model/parser.ts, src/model/writer.ts, src/model/hash.ts, src/model/validator.ts, src/engine/planDraft.ts, src/schema/schemas.ts, test/hash.approval.property.test.ts, test/parser.roundtrip.property.test.ts)
- [done] P03 Bind phase worktrees, git service, launch cwd and guard containment to each phase's target repo (after P02; files: src/engine/phaseWorktree.ts, src/engine/runWorktree.ts, src/engine/runStore.ts, src/engine/launcher.ts, src/engine/resultFlow.ts, src/engine/resultValidation.ts, src/engine/askRelay.ts, src/orchestrator/guard.ts, src/orchestrator/readTools.ts, src/orchestrator/toolServices.ts, src/activation/planStore.ts, src/journal/journal.ts)
- [executed] P04 Replace the repository lock with a per-repo lock and repo-keyed queues in the engine facade (after P03; files: src/engine/runQueue.ts, src/engine/planDraft.ts, src/engine/runPipeline.ts, src/activation/engineFacade.ts, src/activation/commands.ts, test/engineFacade.resume.test.ts)
- [pending] P05 List plans across all repos and show repo labels on plans, phases and runs (after P01, P02; files: src/activation/planLister.ts, src/model/treeModel.ts, src/model/runTreeModel.ts, src/activation/planExplorer.ts, src/activation/runsExplorer.ts, test/planExplorer.test.ts, test/planLister.test.ts)
- [pending] P06 Submit one PR per touched repo, with a multi-PR result and a partial-failure plan state (after P03, P04; files: src/engine/submitPr.ts, src/engine/prTool.ts, src/model/planActions.ts, src/engine/transitions.ts, test/planActions.property.test.ts)
- [pending] P07 Teach the orchestrator and plan writer to pick the lowest repo and emit repo hints (after P02, P06; files: src/orchestrator/systemPrompt.ts, src/engine/roleInstructions.ts, src/orchestrator/planWriteTools.ts)
