# Plan T03

## Steps

1. Pin the phaseFor/buildSystemPrompt parameter default to the literal 'spec'

   In src/orchestrator/systemPrompt.ts, T01 made DEFAULT_MODE = 'default'. Both `phaseFor(kind, specContent?, mode: RunMode = DEFAULT_MODE)` (line ~109) and `buildSystemPrompt(kind, specContent?, mode: RunMode = DEFAULT_MODE)` (line ~342) therefore now treat an ABSENT mode as Default, which would send `buildSystemPrompt({kind:'workspace'})` and `phaseFor({kind:'workspace'}, content)` into the run phase. That breaks the file's documented contract ('an absent mode or `'spec'` reproduces today's phase and today's prompt text byte for byte') and the Spec-only tests that must stay unmodified (test/systemPrompt.test.ts calls `buildSystemPrompt(WORKSPACE)` ~49 times expecting the Spec gather prompt; test/systemPrompt.phase.property.test.ts:139 asserts `phaseFor(WORKSPACE, content) === 'gather'`; test/chatController.mode.test.ts:422 compares against `buildSystemPrompt({ kind: 'workspace' })`). Change both defaults to the literal: `mode: RunMode = 'spec'`. Then drop `DEFAULT_MODE` from the import on line 44 if it is no longer referenced (it will not be): `import { isSpecless, RunMode } from '../model/mode';`. Update the JSDoc `@param mode` on both functions to say 'Absent means Spec (the literal `'spec'`, not DEFAULT_MODE, which is now Default), so the Spec prompt and phase are unchanged byte for byte.' The production caller (chatController.buildPrompt/phaseForConversation) always passes the mode explicitly for workspace conversations and passes none for spec conversations, so this changes no live behaviour. If an earlier todo already made this change, leave it as is.

   Files: `src/orchestrator/systemPrompt.ts`

2. Add RUN_FLOW_TEXT.default with the recommend-and-confirm beats

   In src/orchestrator/systemPrompt.ts, add a `default` entry as the FIRST key of `RUN_FLOW_TEXT` (mirroring RUN_MODES order), built like the others with `[...].join('\n')`. `SpeclessMode = Exclude<RunMode, 'spec'>` already includes 'default', so the Record type now compiles only with this key (this is the TS2741 T01 reported). Use this text (keep the backtick tool names and the `mode: "x"` spelling exactly; do NOT mention `draft_spec`, `submit_pr`, `mode: "default"` or `mode: "spec"` anywhere, because the existing 'omits every spec-only section' test runs over the default prompt too):

     default: [
       'Default flow:',
       '1. When the user describes work, inspect the repository with the read tools until you can state it in one line.',
       '2. State the work in one line and name the files it most likely touches. A short, honest guess is better than a long one.',
       '3. Recommend exactly one mode for it — Spec, Bug, Quick, Refactor or Investigate — with a one-line why.',
       '4. Call `ask_user` once, with the five modes as `options` (ids `spec`, `bug`, `quick`, `refactor`, `investigate`), your recommendation first, and `allow_free_text` set.',
       '5. Dispatch only the mode the user picks, from this conversation:',
       '- Bug -> call `start_run` with `mode: "bug"`, the one-line defect as `statement`, the guessed `files`, and the reproduction as `reproduction`. Ask for the reproduction with `ask_user` first if the user has not said.',
       '- Quick -> call `start_run` with `mode: "quick"`, the one-line statement of the change, and the guessed `files`.',
       '- Refactor -> call `start_run` with `mode: "refactor"`, the one-line statement of the restructure, and the guessed `files`.',
       '- Investigate -> call `investigate` with the one-line `question` and the guessed `files`.',
       '- Spec -> dispatch nothing. Tell the user to change the Mode control in the composer to Spec and send the request again.',
       '6. If the user declines the question, dispatch nothing: quote the refusal and stop. If they type an answer instead of picking, dispatch nothing: respond to what they typed.',
       '7. After a dispatch, tell the user what started: a run on its own branch and worktree that they can watch in the Runs view and merge when it passes, or an investigation whose finding will appear in the chat and under `.baiton/runs/`.',
       'Never dispatch without the user\'s pick. The dispatch tool shows its own confirm card, and that card still decides whether the work starts.',
       'Leave the Mode control as it is: a pick dispatches from Default and does not change this conversation\'s mode.',
     ].join('\n'),

   Also update doc comments: the file header's `run` bullet (lines ~21-23) to read 'a non-Spec Workspace conversation (Default/Bug/Quick/Refactor/Investigate)' and add that Default first recommends one concrete mode and confirms it with `ask_user` before dispatching; the RUN_FLOW_TEXT JSDoc to note that the `default` entry adds a recommend-and-confirm step (recommend one mode, one `ask_user` card, dispatch the pick with `start_run`/`investigate`, Spec pick and decline dispatch nothing) before the usual beats; the `SpeclessMode` comment can stay ('every mode except spec'). Do not change buildSystemPrompt's run-phase assembly: the default prompt is RUN_ROLE_TEXT, RUN_SCOPE_TEXT, REFUSAL_TEXT, ASK_USER_TEXT, runFlowText('default'), MODE_PROPOSAL_TEXT, STYLE_TEXT like every other spec-less mode (existing tests require MODE_PROPOSAL_TEXT in every spec-less prompt). Do not touch RUN_ROLE_TEXT, RUN_SCOPE_TEXT, MODE_PROPOSAL_TEXT or any Spec-phase text.

   Files: `src/orchestrator/systemPrompt.ts`

3. Update the DEFAULT_MODE pins in test/systemPrompt.mode.test.ts

   DEFAULT_MODE is now 'default', so two existing assertions flip and must be updated (the spec-conversation ones stay valid because a spec conversation ignores the mode — leave lines ~77-102 untouched):
   - In the first test (~line 69) rename to 'builds an identical workspace prompt with no mode and "spec"' and keep only `assert.strictEqual(buildSystemPrompt(WORKSPACE), buildSystemPrompt(WORKSPACE, undefined, 'spec'))`. Add a new `it('builds the Default run prompt, not the Spec prompt, for DEFAULT_MODE on a workspace conversation', ...)` asserting `DEFAULT_MODE === 'default'`, `buildSystemPrompt(WORKSPACE, undefined, DEFAULT_MODE) === buildSystemPrompt(WORKSPACE, undefined, 'default')` and `!== buildSystemPrompt(WORKSPACE)`.
   - In 'keeps a Spec-mode workspace conversation in gather' (~line 106) remove the `phaseFor(WORKSPACE, undefined, DEFAULT_MODE)` 'gather' line; add a separate `it('maps DEFAULT_MODE on a workspace conversation to the run phase', ...)` asserting `phaseFor(WORKSPACE, undefined, DEFAULT_MODE) === 'run'`.
   - Update the header coverage comment: Spec output unchanged when mode is absent or 'spec' (and DEFAULT_MODE for spec conversations); DEFAULT_MODE on a workspace conversation is the Default run prompt; Default's recommend-and-confirm flow text.
   The loops over SPECLESS_MODES (derived from RUN_MODES) automatically pick up 'default' for run-phase mapping, spec-conversation ignoring, run-prompt assembly, spec-only omission and mode-proposal tests; `Object.keys(RUN_FLOW_TEXT).length === RUN_MODES.length - 1` holds at 5 === 6 - 1. Leave those unchanged.

   Files: `test/systemPrompt.mode.test.ts`

4. Add a Default-flow describe block to test/systemPrompt.mode.test.ts

   Add `describe('mode-scoped system prompt: Default recommends and confirms', () => { ... })` after the 'each mode names its own tool and framing' block, with focused `it`s over `const flow = RUN_FLOW_TEXT.default` and `const prompt = buildSystemPrompt(WORKSPACE, undefined, 'default')`:
   1. 'puts the Default flow in the Default run prompt': `prompt.includes(flow)`, and `phaseFor(WORKSPACE, undefined, 'default') === 'run'`.
   2. 'inspects with the read tools and states the work with guessed files': `/read tools/`, `/one line/`, `/files/` on flow.
   3. 'recommends exactly one mode with a why': `/Recommend exactly one mode/`, `/why/`.
   4. 'asks one ask_user card listing the five concrete modes, recommendation first, free text allowed': `/`ask_user` once/`, `/recommendation first/`, `/allow_free_text/`; for each of Spec, Bug, Quick, Refactor, Investigate `flow.includes(name)`; for each id spec/bug/quick/refactor/investigate `flow.includes('`' + id + '`')`; and `!/`default`/.test(flow)` so Default is not offered as an option.
   5. 'dispatches bug/quick/refactor through start_run with the picked mode and investigate through investigate': for each of bug, quick, refactor `flow.includes('`start_run` with `mode: "' + m + '"`')`; `/call `investigate`/`; `!/mode: "default"/` and `!/mode: "spec"/`.
   6. 'asks for the ask_user pick before any dispatch': `flow.indexOf('`ask_user`') < flow.indexOf('`start_run`')` and `< flow.indexOf('call `investigate`')`.
   7. 'dispatches nothing for a Spec pick and points at the Mode control': match `/Spec -> dispatch nothing/` and `/change the Mode control in the composer to Spec/`, `/again/`.
   8. 'dispatches nothing on a decline or a typed answer': `/declines[^\n]*dispatch nothing/` and `/type an answer[^\n]*dispatch nothing/`.
   9. 'never dispatches without the pick and defers to the confirm card': `/Never dispatch without the user's pick/`, `/confirm card/`.
   10. 'leaves the Mode control as it is': `/Leave the Mode control as it is/`.
   11. 'never mentions spec-writing tools': `!/draft_spec/.test(flow)` (redundant with the omission loop but local to the beat).
   Match the file's style: `assert.ok`/`assert.match` with a short message, no new imports needed beyond what is already imported (DEFAULT_MODE, RUN_FLOW_TEXT, buildSystemPrompt, phaseFor). If the implemented flow wording differs slightly from step 2, keep regexes aligned with the actual text.

   Files: `test/systemPrompt.mode.test.ts`

5. Compile and run the prompt tests

   Run `npx tsc -p ./ --noEmit` — the TS2741 on RUN_FLOW_TEXT must be gone; any remaining errors must be outside systemPrompt.ts (report them, do not fix other todos' files). Run `npx mocha` (.mocharc runs the whole suite; filter with `--grep 'system prompt'` or `-g 'mode-scoped system prompt'` to focus) and confirm test/systemPrompt.mode.test.ts, test/systemPrompt.test.ts and test/systemPrompt.phase.property.test.ts all pass. Failures in chatController/webviewProtocol tests that pin DEFAULT_MODE-derived values belong to later todos; note them but do not edit those files.

   Files: (none)

## Risks

- Changing the phaseFor/buildSystemPrompt parameter default from DEFAULT_MODE to 'spec' touches Spec-path code; it is required so an absent mode stays Spec byte-for-byte (test/systemPrompt.test.ts, systemPrompt.phase.property.test.ts:139 and chatController.mode.test.ts:422 rely on it), but a reviewer might see it as outside the literal todo wording. Production callers pass the mode explicitly for workspace conversations, so live behaviour is unchanged.
- The existing 'omits every spec-only section' loop now runs over the default prompt: any mention of `draft_spec` or `submit_pr` in the Default flow text (e.g. when describing the Spec pick) fails it. The Spec pick must be described only as changing the Mode control and re-sending.
- MODE_PROPOSAL_TEXT ('When the work does not fit this mode, propose the mode that does...') is still appended to the Default prompt because existing tests require it in every spec-less prompt; its wording overlaps with, but does not contradict, the Default flow. Do not special-case it out.
- ASK_USER_TEXT already says a declined question is a refusal to quote and stop; the Default decline beat must stay consistent with it (dispatch nothing, quote, stop).
- Full-suite failures in chatController and webviewProtocol tests (DEFAULT_MODE-derived pins) predate this todo and belong to later todos; the executor must not chase them into files outside this todo's list.

## Acceptance

- src/orchestrator/systemPrompt.ts has a `default` key in RUN_FLOW_TEXT (listed first) and `npx tsc -p ./ --noEmit` reports no error in systemPrompt.ts.
- RUN_FLOW_TEXT.default names: inspecting with the read tools; stating the work in one line with guessed files; recommending exactly one mode with a one-line why; one `ask_user` call whose options are the five concrete modes (Spec, Bug, Quick, Refactor, Investigate) with the recommendation first and `allow_free_text`; dispatch of the pick via `start_run` with `mode: "bug"|"quick"|"refactor"` or `investigate`; Spec pick dispatches nothing and tells the user to change the Mode control to Spec and re-send; decline or typed answer dispatches nothing; never dispatch without the pick and the tool's confirm card still governs; the Mode control stays as it is.
- RUN_FLOW_TEXT.default contains no `draft_spec`, `submit_pr`, `mode: "default"` or `mode: "spec"`.
- buildSystemPrompt(WORKSPACE) (no mode) still equals buildSystemPrompt(WORKSPACE, undefined, 'spec'), and phaseFor(WORKSPACE, content) with no mode is still 'gather'; buildSystemPrompt(WORKSPACE, undefined, 'default') is the run-phase prompt containing RUN_FLOW_TEXT.default.
- test/systemPrompt.mode.test.ts has updated DEFAULT_MODE pins and a new Default describe block, and it passes together with test/systemPrompt.test.ts and test/systemPrompt.phase.property.test.ts, which are not modified.
- No files other than src/orchestrator/systemPrompt.ts and test/systemPrompt.mode.test.ts are changed.
