# Plan T06

## Steps

1. Widen the Conversation modes intro paragraph to six ids

   In README.md, section `### Conversation modes` (currently around lines 121-126), replace the opening paragraph:

     "A conversation runs in one of five modes, which decides the pipeline a dispatch
     from it runs. The composer's Mode control shows them by these labels, and the
     ids are `spec | bug | quick | refactor | investigate` (`RunMode` in
     `src/model/mode.ts`):"

   with:

     "A conversation runs in one of six modes, which decides the pipeline a dispatch
     from it runs. The composer's Mode control shows them by these labels, and the
     ids are `default | spec | bug | quick | refactor | investigate` (`RunMode` in
     `src/model/mode.ts`, listed in this order by `RUN_MODES`):"

   Then, in the bullet list, add a new FIRST bullet before `- **Spec** — ...`:

     "- **Default** — the mode a Workspace conversation starts in: it recommends one
       of the five modes below and dispatches the one you pick. It is never itself a
       run."

   Leave the five existing bullets (Spec, Bug, Quick, Refactor, Investigate) byte-identical — those are the unchanged concrete-mode labels, matching `MODE_OPTIONS` in media/chat.js (`Default`, `Spec`, `Bug`, `Quick`, `Refactor`, `Investigate`).

   Files: `README.md`

2. Rewrite the DEFAULT_MODE sentence: start-in-Default rule and Spec pin

   Replace the paragraph beginning "`DEFAULT_MODE` is `spec`, and an absent or unknown stored value falls back to it, so a conversation that never touched the control behaves exactly as it always did." Keep the remainder of that paragraph ("**Bug**, **Quick** and **Refactor** share ONE spec-less plan → execute → review pipeline ... (`isSpecless(mode)` in `src/model/mode.ts`).") but make its first sentences read:

     "`DEFAULT_MODE` is `default`: the Workspace conversation starts in Default, and
     an absent or unknown stored value falls back to it. A spec conversation does
     not follow it — it is always Spec, exactly as before."

   Then continue with the existing Bug/Quick/Refactor/Investigate sentences unchanged. Update the final sentence "No non-Spec mode reads or writes anything under `.baiton/specs/` (`isSpecless(mode)` in `src/model/mode.ts`)." to stay as is (Default is spec-less, so it remains true); optionally append "`default` included" is NOT needed — leave it verbatim.

   Files: `README.md`

3. Add the recommend-and-confirm paragraph

   Immediately after the paragraph that starts "In a non-Spec conversation `OrchestratorPhase` is `run`, and the flow follows one beat list per mode (`RUN_FLOW_TEXT` ...)" (ends "**Investigate** changes nothing: no branch, no worktree and no commit."), insert ONE short new paragraph describing Default, matching RUN_FLOW_TEXT.default in src/orchestrator/systemPrompt.ts:

     "**Default** is recommend-and-confirm. The orchestrator inspects the ask with
     the read tools, states it in one line with the files it most likely touches,
     recommends exactly one of the five modes with a one-line why, and asks once
     with an `ask_user` card whose options are the five modes, its recommendation
     first, with a typed answer allowed. It dispatches only what you pick, with the
     tools that already exist: `start_run` with `mode` `bug`, `quick` or `refactor`,
     or `investigate`; that tool's own confirm card still decides whether the work
     starts. Picking **Spec** dispatches nothing — change the Mode control to Spec
     and send the request again — and a decline or a typed answer dispatches
     nothing either. A run started from Default carries the picked mode in its run
     id and branch, while its manifest records `composerMode: default` and
     `explicitMode: true`."

   Keep it one paragraph. Do not change the following `MODE_PROPOSAL_TEXT` paragraph ("The mode is your choice and the model cannot change it...").

   Files: `README.md`

4. Fix the top-of-file mode count so the README stays consistent

   README.md lines 5-7 currently say "A conversation also runs in one of five **modes** — Spec, Bug, Quick, Refactor and Investigate — and the non-Spec modes dispatch spec-less runs, each on its own branch and worktree." Change to: "A conversation also runs in one of six **modes** — Default, Spec, Bug, Quick, Refactor and Investigate. A Workspace conversation starts in Default, which recommends one of the other five, and the non-Spec modes dispatch spec-less runs, each on its own branch and worktree." Re-wrap to ~80 columns like the surrounding text. Touch nothing else outside the Conversation modes section (the Mode-control paragraph and its three verbatim tooltips, the workspaceState paragraph, the tools table, and the Runs/manifest sections stay unchanged).

   Files: `README.md`

## Risks

- Do not alter the three verbatim Mode-control tooltip strings or the statement that a spec conversation is pinned to Spec; they are unchanged behaviour and may be matched by tests or docs checks.
- Keep the five concrete-mode bullet labels and descriptions byte-identical; only the Default bullet is new.
- Do not claim `start_run`'s enum or the `investigate` tool changed — they are untouched; Default dispatches through them as-is.
- Grep the test directory for README assertions (e.g. `grep -rn README test/`) before finishing; if a test pins README text such as "one of five modes", update only as the widened list forces and report it.
- Wrap prose at ~80 columns to match the file; avoid introducing trailing whitespace.

## Acceptance

- README.md `### Conversation modes` lists ids `default | spec | bug | quick | refactor | investigate` and says six modes.
- A **Default** bullet appears first, followed by the unchanged Spec, Bug, Quick, Refactor, Investigate bullets.
- The README states `DEFAULT_MODE` is `default`, that the Workspace conversation starts in Default with absent/unknown stored values falling back to it, and that spec conversations stay Spec.
- Exactly one short paragraph describes the recommend-and-confirm flow: inspect, one-line statement + guessed files, one recommendation with a why, one `ask_user` card of the five modes (recommendation first, free text allowed), dispatch via `start_run(bug|quick|refactor)` or `investigate` under that tool's own confirm card, Spec pick / decline / typed answer dispatch nothing.
- No README text still says "five modes" or "`DEFAULT_MODE` is `spec`" (grep confirms).
- Only README.md is modified; `npx mocha` (TS_NODE_TRANSPILE_ONLY=true) still passes with 0 failing.
