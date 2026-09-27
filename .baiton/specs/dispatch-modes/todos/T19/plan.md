# Plan T19

## Steps

1. Widen the intro and the view list from two views to three

   In README.md, the opening paragraph (lines 3-6) and the '## The Baiton views' section (lines 8-51) currently say Baiton contributes 'two view containers' holding the Spec Explorer and the Chat, and that 'The two views:' are Spec Explorer and Chat.

   Edits:
   1. Opening paragraph: keep the spec-driven sentence but add that a conversation also runs in one of five MODES, and that the non-Spec modes dispatch spec-less runs onto their own branch and worktree.
   2. The activity-bar bullet: the `baiton` container now holds the **Spec Explorer**, the **Runs** view and the collapsed **Configuration** section (verified in package.json `contributes.views.baiton`: ids `baiton.specExplorer` name 'Spec Explorer', `baiton.runsView` name 'Runs', `baiton.configPanel` name 'Configuration' with `visibility: collapsed`).
   3. Change 'The two views:' to 'The views:' and add a third bullet for **Runs** that forward-references the new '### The Runs view' section rather than duplicating it.
   Do not renumber or rewrite the Spec Explorer bullet's content: the Spec flow is unchanged.

   Files: `README.md`

2. Add a '### Conversation modes' section and give the orchestrator tool table a run column

   Insert a new '### Conversation modes' subsection under '## The Baiton views' immediately AFTER '### What the orchestrator does' (i.e. after the `ask_user` paragraph that ends at line 94) and BEFORE '### Chat sessions'.

   Content, all verified against source:
   - The five modes and what each is for, using the exact labels the composer shows (`MODE_OPTIONS` in media/chat.js:80-86): **Spec**, **Bug**, **Quick**, **Refactor**, **Investigate**; ids `spec | bug | quick | refactor | investigate` (`RunMode` in src/model/mode.ts). `DEFAULT_MODE` is `spec`, and an absent or unknown stored value falls back to it, so a conversation that never touched the control behaves exactly as it always did.
   - Spec is unchanged: gather -> `draft_spec` -> approve -> `run` per todo, writing under `.baiton/specs/`. Bug, Quick and Refactor share ONE spec-less plan -> execute -> review pipeline that differs only in the framing handed to the planner and executor. Investigate is a read-only dispatch ending in a written finding. No non-Spec mode reads or writes anything under `.baiton/specs/` (`isSpecless(mode)` in src/model/mode.ts).
   - **The Mode control**: a `<select>` in the composer's control row immediately LEFT of the **Auto** toggle (`#mode-select` in media/chat.html:807-812, `renderMode` in media/chat.js:1207-1233). Host-authoritative in exactly the way the Auto toggle is: the change posts `setMode` and the control repaints only when the host echoes `setMode` back (webviewProtocol.ts: host->webview `setMode`, webview->host `setMode`, plus the host->webview `setRunActive` flag; `media/protocol.js` mirrors the reducer and a shared-fixture parity test pins them). It is disabled while the chat is busy, while a run is in flight (`setRunActive`), and on a spec conversation, which is pinned to Spec because the mode is a property of the Workspace conversation. Quote its three tooltips verbatim from media/chat.js:1229-1232: 'A spec conversation always runs the Spec pipeline.', 'A run is in flight; the mode cannot change until it finishes.', 'Conversation mode: the pipeline a dispatch from this chat runs.'
   - The selection is remembered per workspace in `workspaceState` under `baiton.chat.mode` (`CHAT_MODE_KEY` in src/activation/commands.ts:173), never in `settings.json` — the same arrangement as `baiton.chat.autoMode` and `baiton.orchestrator.selection`.
   - How the model behaves in a non-Spec conversation: `OrchestratorPhase` gains `run`; the mode is the user's choice and the model cannot change it, so when work does not fit it proposes the right mode through `ask_user` and tells the user to change the Mode control instead of dispatching anyway (`MODE_PROPOSAL_TEXT`, src/orchestrator/systemPrompt.ts:267-277). Summarise the per-mode flow beats from `RUN_FLOW_TEXT` (systemPrompt.ts:225-259) in one line per mode: Bug also establishes a reproduction; Quick is for one small self-contained change; Refactor must not change behaviour and the run's reviewer — not the orchestrator — checks the configured verify command; Investigate changes nothing.

   Then extend the existing tool table (README.md lines 70-78) with a third column, 'in a run', so it reads 'creating a spec | driving a spec | in a run'. Fill it from the `phases` arrays in source, which are authoritative:
   - `list_specs`, `read_spec`, `git_status`: phases ['gather','drive','run'] -> yes/yes/yes (readTools.ts:52, 88, 289).
   - `ask_user`: ['gather','drive','run'] (controlTools.ts:95) -> yes/yes/yes. Fix the sentence at README lines 80-81 that says `ask_user` 'is available in both phases' to say all three.
   - `list_files`, `read_file`, `search`, `git_diff`, `git_log`: ['gather','run'] (readTools.ts:131, 162, 222, 315, 345) -> yes/no/yes.
   - `update_overview`, `add_todo`, `edit_todo`, `remove_todo`, `approve_spec`: ['gather','drive'] (controlTools.ts:495 and the todo tools) -> no in a run.
   - `draft_spec`: ['gather'] (controlTools.ts:193) -> no in a run.
   - `run`, `submit_pr`: ['drive'] (controlTools.ts:679, 778) -> no in a run.
   - New rows: `start_run` and `investigate`, both phases ['run'] (controlTools.ts:304, 418) -> no/no/yes.
   Add a sentence after the table: the spec tools keep their phases, so they are simply unavailable in a non-Spec conversation, and because `start_run`/`investigate` are dispatch tools the guard's Restricted-Mode rule disables them like every other dispatch tool.

   Files: `README.md`

3. Document the confirm card and the branch/worktree layout of a spec-less run

   Add a '### Spec-less runs (Bug, Quick, Refactor)' section after '### Driving a spec' (which ends at README line 207) and before '### Auto mode'.

   Content:
   - The dispatch: `start_run(mode, statement, files, reproduction?)` with `mode` restricted to `bug | quick | refactor` (controlTools.ts schema, enum ['bug','quick','refactor']), and `investigate(question, files)` for the read-only mode. Every argument is validated BEFORE the card is raised and before the seam is touched, so a malformed call asks nothing and dispatches nothing; the tool returns as soon as the run is LAUNCHED (unlike `run`, which blocks).
   - **The confirm card**: an inline confirm, not a modal, prompted 'Start a <mode> run?' with the detail lines quoted verbatim from controlTools.ts:360-367 — `Mode: <mode>`, `Work: <statement>`, `Files: <files, comma-separated, or (none guessed)>`, `Reproduction: <reproduction>` when one was collected, `Target branch: <branch>`, and the closing line 'The run works on its own branch and worktree; nothing outside .baiton/runs/ and .baiton/worktrees/ changes until you merge it.' State that a decline writes nothing and dispatches nothing, and that its refusal reaches the model as 'starting the <mode> run was declined; nothing was written'. Investigate's card is prompted 'Investigate this question?' with `Mode: investigate`, `Question:`, `Files:`, `Target branch:` and 'Read-only: no branch, no worktree and no commit. The only write is the finding under .baiton/runs/.'
   - **The layout**. Run id: `<mode>-<stamp>-<suffix4>`, e.g. `bug-20260926-141501-a1b2` (`newRunId` in src/engine/runStore.ts). Branch: `baiton/<mode>/<run-id>` (`runBranchFor`). Worktree: `.baiton/worktrees/<run-id>/`, created with `git worktree add -b` at the head of the branch that was checked out when the run started (`createRunWorktree` in src/engine/runWorktree.ts). A run cannot start from a detached HEAD, and cannot start on a branch with no commits — say so, since both are user-visible refusals ('detached-head', 'no-base-head').
   - **What lives where**: the manifest `.baiton/runs/<run-id>/run.json` (id, mode, the composer's mode plus an `explicitMode` flag, statement, guessed files, optional reproduction, base branch and its head commit at start, branch, worktree dir, state, per-stage attempt counters, outcome and timestamps); the run's journal `.baiton/runs/<run-id>/runs.jsonl`; and the rendered artifacts `plan.md`, `execute-<n>.md`, `review-<n>.md`, `finding.md`, all in the run directory and never under a spec. Each stage LAUNCH gets its own sibling directory named `<run-id>.<stage>.<n>` holding that launch's brief, result and `asks/` files — which is why a run id may contain no dot — and for a code run those launch directories resolve inside the worktree, so the relative run-dir grants in the role profiles still point at what the launcher wrote (src/engine/runPipeline.ts header, src/engine/runStore.ts header, `launchIdFor`).
   - **States**: `confirmed | planning | planned | executing | executed | reviewing | done | failed | cancelled | answered | merged` (`RunState`); the complete ones — done, failed, cancelled, answered, merged — are the Runs view's Complete group (`isRunComplete`).
   - **The pipeline**: plan -> execute -> review, a `findings` verdict sends the run back to execute bounded by `limits.exec_attempts`, a `pass` marks it `done`. Execute commits in the worktree with a `Run-Id: <run-id>` trailer (`RUN_ID_TRAILER` in runPipeline.ts:96). Investigate reuses the existing `reviewer` role (read + shell, writes confined to the run directory), so `.baiton/config.json` needs no new role and no migration. Cancelling disposes the running stage's terminal, records `cancelled`, and deliberately LEAVES the worktree and branch in place for inspection.
   - **The one-stage-per-repository guarantee holds both ways**: a run refuses with `busy` while a spec queue or the spec draft has a stage in flight, and a running run makes the spec queue externally busy. Also update the existing sentence at README line 192-193 ('Only one stage runs per repository, so a spec draft and a todo stage never run at the same time.') to name a spec-less run as the third thing in that interlock.
   - Note that `.baiton/.gitignore` now excludes `/worktrees/` alongside `/runs/` (`GITIGNORE_CONTENTS` in src/config/gitignore.ts), so nothing a run owns is ever committed; add `/worktrees/` to the transcript/paths note at README lines 117-126 or to this new section, whichever reads better.

   Files: `README.md`

4. Document the Runs view with the Cancel, View diff and Merge rules

   Add a '### The Runs view' section. Put it next to the run documentation (immediately after the spec-less-runs section) and have the third bullet of '## The Baiton views' point at it.

   Content, all from src/model/runTreeModel.ts and src/activation/runsExplorer.ts:
   - The view is `baiton.runsView`, titled **Runs**, sitting beside the Spec Explorer in the activity-bar container. Exactly two groups, **Active** first then **Complete**, both always present even when empty.
   - Each run node shows the statement as its label, truncated to 80 chars with an ellipsis (`RUN_LABEL_MAX_CHARS`), and a description of `<mode> · <stage>` (with ` (attempt <n>)` past the first attempt) while a stage is in flight, `<mode> · <state>` for an active-but-idle run, and `<mode> · <outcome>` once complete. The tooltip spells out `<mode> run <run-id>`, the statement, `Branch: <branch> (from <base branch>)`, `State:`, `Stage: <stage> (attempt <n>)` when one is running, and `Outcome:` when complete.
   - Outcome text (`runOutcomeLabel`): 'merged', 'answered', 'cancelled', 'review passed' for a `done` run whose verdict was `pass` (else 'done'), and for `failed` either `failed: <message truncated to 60 chars>` or 'review reported findings'.
   - **The action rules**, quoting `legalRunActions` exactly and in its order (cancel, viewDiff, merge):
     - **Cancel** only while the run is active AND a stage is actually in flight — an active-but-idle run (`confirmed`, `planned`, `executed` with no live stage) offers nothing, because there is no terminal to dispose. Cancelling keeps the worktree and the branch. If the stage finishes first, the cancel warns rather than claiming success.
     - **View diff** only on a complete run that still has a worktree and is not `merged`: merging removes the worktree and the branch, and an Investigate run never had one, so neither offers a diff. It opens the range `<base commit>..<branch>`, named in both the diff title and the log (`shortSha`/`runDiffRange` in runsExplorer.ts); a `failed` or `cancelled` run keeps its branch and offers View diff alone.
     - **Merge into `<base branch>`** only on a `done` run with a worktree — one whose review passed.
   - **Why a merge is refused**, in the pinned check order wrong-branch -> base-moved -> dirty-tree -> missing-branch -> merge (`mergeRunWorktree` in src/engine/runWorktree.ts). One reason reaches the user, and the machine-readable reason token is logged beside the prose: `wrong-branch` (the base branch the run started from is not the one checked out), `base-moved` (the base branch has moved since the run started, or no longer exists), `dirty-tree` (the working tree has uncommitted changes, reported as a count), `missing-branch` (the run branch is gone — it may already have been merged and cleaned up), `conflict` (the merge conflicted and was aborted, so the base branch is unchanged and the run's branch and worktree are untouched). Say that the merge always runs in the main checkout, never in the worktree; that it commits `Merge <branch>: <statement>` with a `Run-Id: <run-id>` trailer so the merge is findable by run id; and that a successful merge removes the worktree and deletes the branch, with cleanup problems reported as warnings that never turn a landed merge into a failure.
   - **Refresh**: a `FileSystemWatcher` over `.baiton/runs/*/run.json`, debounced 500 ms (`RUNS_REFRESH_DEBOUNCE_MS`) so a burst of manifest writes coalesces, plus every run-pipeline change event applied immediately so a started stage repaints without waiting out the debounce. Launch directories (`<run-id>.<stage>.<n>`) are skipped.
   - **Restricted Mode**: state, from package.json's `view/item/context` `when` clauses, that `baiton.runs.cancel` and `baiton.runs.merge` are gated on `!baiton.restricted` while `baiton.runs.viewDiff` is not, because it only reads.

   Files: `README.md`

5. Document Investigate findings and the promote offer

   Add a '### Investigate findings' subsection after the Runs-view section (or as the closing part of it).

   Content:
   - An Investigate run launches ONE `investigate` stage from the main checkout: no branch, no worktree, no commit and no diff. Its result is validated against `investigateSchema` (`finding`, `files`, `next_steps`) and rendered to `.baiton/runs/<run-id>/finding.md`; the run ends in the state `answered`, which the Runs view shows as the outcome 'answered'.
   - When the finding lands, a system note is posted on the Workspace conversation and the controller offers a **promote card** — once per run id (`ChatController.promoteFinding`). Describe it with its real shape (`promoteCardRequest`): the prompt reads 'Investigation `<run-id>` found: <finding>', then 'Files: …' (or 'Files: (none named)'), then 'Next steps: …' when the finding named any, then 'Start a run from this finding?'; the three options are **Start a Bug run** ('Plan, fix and review the defect on its own branch.'), **Start a Quick run** ('Plan, make and review the small change on its own branch.') and **Dismiss** ('Keep the finding only.').
   - Choosing Bug or Quick raises the ORDINARY run confirm card with the finding as the work statement and the branch the investigation started from as the target branch (`promoteRunConfirm`), so a promoted run reads identically to a model-dispatched one. Only an approval dispatches: a dismissal, a decline or a typed answer writes nothing and dispatches nothing. In Restricted Mode no card is offered and a note stands in for it ('Restricted Mode: the finding of `<run-id>` was not offered as a run.').
   - Note that `PROMOTE_MODES` is exactly `bug` and `quick` — a finding is never promoted straight to Refactor or Spec.

   Files: `README.md`

6. Extend the Commands and Settings sections

   In '## Commands' (README lines 651-662), add three bullets in package.json order, with the titles verbatim from `contributes.commands`:
   - **Baiton: Cancel Run** (`baiton.runs.cancel`) — disposes the terminal of the stage in flight for the selected run; the worktree and the branch are kept.
   - **Baiton: View Run Diff** (`baiton.runs.viewDiff`) — opens the run branch's diff against the commit it started from (`<base commit>..<branch>`).
   - **Baiton: Merge Run** (`baiton.runs.merge`) — merges a passed run's branch into the branch it started from, then removes the worktree and deletes the branch.
   Add one sentence saying all three are Runs-view item actions rather than palette entries — each is contributed with `"when": "false"` under `commandPalette` — and that cancel and merge additionally require `!baiton.restricted`.

   In the closing 'Deliberately **not** settings' paragraph (README lines 682-685), add the conversation mode: it lives in `workspaceState` under `baiton.chat.mode`, next to `baiton.chat.autoMode` and `baiton.orchestrator.selection`, and link back to the new '### Conversation modes' section.

   Files: `README.md`

7. Re-read the whole edited README for internal consistency

   Read README.md end to end once after the edits and fix any statement the new modes falsify. Specifically check: the opening 'two jobs' framing of '### What the orchestrator does' (lines 55-66) — a non-Spec conversation has a third job, so either widen that sentence or scope it explicitly to a Spec conversation; the sentence 'There is no tool for reading a stage's artifacts' (lines 97-100), which stays true for runs too and can name `finding.md`/`plan.md` under `.baiton/runs/<run-id>/`; the 'Only one stage runs per repository' sentence; and the '### Harness ask relay' opening (line 549), which already speaks of `.baiton/runs/<run-id>/asks/` and should be read against the new `<run-id>.<stage>.<n>` launch-directory naming so it does not contradict it. Keep the existing prose style: ~80-column wrapping, bold for UI labels, backticks for ids, paths and symbols, and no change to the Spec-flow wording beyond the widenings named above.

   Files: `README.md`

## Risks

- The README is the project's single long reference document and is heavily cross-referenced; inserting four new sections risks contradicting existing sentences (the orchestrator's 'exactly two jobs', 'The two views', 'available in both phases', 'Only one stage runs per repository'). Each of those is named explicitly in the steps and must actually be edited, not just left standing.
- Every user-facing string quoted (card prompts, tooltips, outcome labels, command titles) must match the source byte for byte. They are sourced above with file and line; if a line has shifted, re-grep for the string rather than trusting the line number, and quote what the file says.
- The action rules are easy to state slightly wrong. Cancel needs a stage actually in flight (not merely an active run); View diff is excluded on a `merged` run and on any Investigate run; Merge is `done` + has worktree only. Restating these from memory rather than from `legalRunActions` would ship a README that disagrees with the view.
- The merge refusal order is pinned and tested (wrong-branch -> base-moved -> dirty-tree -> missing-branch -> conflict). Documenting a different order would describe behaviour the code does not have.
- This todo is documentation only. Do not touch any file under src/, media/ or package.json — even where the README reveals a wording that could be improved; note it instead.
- The README already documents `.baiton/runs/<run-id>/asks/` for harness asks. Under a run those directories belong to a LAUNCH id (`<run-id>.<stage>.<n>`), so the new text must not imply a run's own directory holds the asks.

## Acceptance

- README.md is the only file changed: `git status --porcelain` lists `M README.md` and nothing else, and no `.baiton/runs/` or `.baiton/worktrees/` residue appears.
- The five modes are documented by their composer labels (Spec, Bug, Quick, Refactor, Investigate) and their ids, with Spec named as the default and the non-Spec modes stated to write nothing under `.baiton/specs/`.
- The Mode control is documented as a composer select immediately left of the Auto toggle, host-authoritative through `setMode`, disabled while busy / while a run is in flight / on a spec conversation, and remembered in `workspaceState` under `baiton.chat.mode` rather than in `settings.json`.
- The confirm card's detail lines (Mode / Work / Files / Reproduction / Target branch plus the 'nothing outside .baiton/runs/ and .baiton/worktrees/ changes until you merge it' line) appear verbatim, and the README states that a decline writes and dispatches nothing.
- The branch (`baiton/<mode>/<run-id>`) and worktree (`.baiton/worktrees/<run-id>/`) layout is documented, along with the run manifest at `.baiton/runs/<run-id>/run.json`, the journal `runs.jsonl`, the artifacts `plan.md`/`execute-<n>.md`/`review-<n>.md`/`finding.md`, the `<run-id>.<stage>.<n>` launch directories, and the `/worktrees/` entry in `.baiton/.gitignore`.
- The Runs view section documents both groups, the node label/description/tooltip shape, every outcome label, and the exact legality rules for Cancel, View diff and Merge, including that cancel keeps the worktree and branch and that a successful merge removes both.
- All five merge refusal reasons are named in the pinned check order with their user-facing meaning.
- Investigate is documented as read-only (no branch, worktree or commit) ending in `finding.md` and the `answered` state, and the promote card is documented with its Bug / Quick / Dismiss options, its re-use of the ordinary run confirm card, its once-per-run posting, and its Restricted-Mode note.
- The orchestrator tool table has a third 'in a run' column whose every cell matches the `phases` array of that tool in `src/orchestrator/readTools.ts` / `src/orchestrator/controlTools.ts`, with `start_run` and `investigate` added as run-only dispatch tools.
- The Commands section lists `baiton.runs.cancel`, `baiton.runs.viewDiff` and `baiton.runs.merge` with the titles from `package.json`, noting the Restricted-Mode gate on cancel and merge and that they are view-item actions rather than palette entries.
- The README still describes the Spec flow as it did: the Spec Explorer bullet, 'Creating a spec' and 'Driving a spec' are unchanged apart from the explicitly named widenings (the two-jobs sentence, 'The two views', the `ask_user` phase sentence and the one-stage-per-repository sentence).
- Every quoted string, id, path and symbol name in the new text is found by grep in the repository at the location the prose claims.
