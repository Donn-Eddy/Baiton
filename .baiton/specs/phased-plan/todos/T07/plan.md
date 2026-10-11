# Plan T07

## Steps

1. Rename the internal conversation 'phase' to 'conversation step' in systemPrompt.ts

   In src/orchestrator/systemPrompt.ts:
   - Add, right after the imports, `/** The conversation step a chat is in: `gather`, `drive` or `run`. This is not a plan phase. The tool surface in guard.ts still names the same union `OrchestratorPhase` and its `phases` field. */ export type ConversationStep = OrchestratorPhase;`. Change the import to `import type { OrchestratorPhase } from './guard';`. Do NOT rename `OrchestratorPhase`, `ORCHESTRATOR_PHASES` or the `Tool.phases` field in guard.ts/controlTools.ts/registry.ts; that is outside this todo and touches dozens of tests.
   - Rename `export function phaseFor(kind, specContent?, mode = 'plan'): OrchestratorPhase` to `export function conversationStepFor(kind: ConversationKind, documentContent?: string, mode: RunMode = 'plan'): ConversationStep`. Keep the body logic exactly the same: workspace + isPlanless(mode) -> 'run'; non-'spec' kind or undefined content -> 'gather'; else parsePlan(documentContent).frontmatter.get('status') trimmed in DRIVE_STATUSES -> 'drive', otherwise 'gather'.
   - In `buildSystemPrompt`, rename the `specContent` parameter to `documentContent` and the local `const phase = phaseFor(...)` to `const step = conversationStepFor(kind, documentContent, mode)`; `step === 'drive' ? DRIVE_TEXT : FLOW_TEXT`.
   - In `buildSubAgentPrompt(kind, phase, depth, specContent?)` rename the params to `(kind: ConversationKind, step: ConversationStep, depth: number, documentContent?: string)`; `if (step === 'drive')`. Positional callers (src/orchestrator/subAgent.ts:338, test/subAgent.test.ts:246) need no change.
   - Rewrite every doc comment in the file that says 'phase' for gather/drive/run to say 'conversation step' / 'step' (file header bullets 'gather/drive/run', 'The step is derived from the document content through {@link conversationStepFor}', 'Beware: the STEP `run` is not the TOOL `run` — the tool belongs to the `drive` step ...', DRIVE_STATUSES comment, RUN_ROLE_TEXT/RUN_SCOPE_TEXT/PlanlessMode comments ('A mode whose conversation is in the `run` step'), DRIVE_TEXT comment ('The drive-step text'), the `run`-step comment block inside buildSystemPrompt, and the buildSubAgentPrompt comment ('`step` is the parent's conversation step (passed in, not derived) so a sub-agent of a run-step conversation never sees the drive table')). After this, the word 'phase' in this file must refer only to plan phases (PHASE_STATES, phase lines, `land_phase`, `add_phase` etc.) or to the guard's `OrchestratorPhase` type name.
   - Also reword spec/todo vocabulary in comments: 'the current spec content' -> 'the current plan document content', 'spec-less' -> 'plan-less', 'never finish a spec' -> 'never finish a plan', 'a spec conversation' -> 'a plan conversation', 'the new-spec flow' -> 'the Phased Plan flow', 'section-5 todo grammar' -> 'section-5 phase-line grammar', and drop the historical '(T10)' style references if any appear. On `ConversationKind`, keep the `{ kind: 'spec'; slug: string }` member unchanged (it is the persisted scope kind read by sessionStore/subAgent/guard) and add a comment marking it legacy: `/** `'spec'` is the legacy persisted name for a plan conversation; kept so saved sessions and callers still match. */`.

   Files: `src/orchestrator/systemPrompt.ts`

2. Update the one external caller of phaseFor

   In src/activation/chatController.ts: change the import `phaseFor,` (line ~98, from '../orchestrator') to `conversationStepFor,` (keep alphabetical-ish placement consistent with neighbours — it goes between `compactionTranscriptRecord` and `defaultSummary`, or simply in place). Change the two calls in `phaseForConversation` (lines ~1416, ~1418) to `conversationStepFor(...)` with identical arguments. Rename the private method `phaseForConversation` to `stepForConversation` and update its callers inside chatController.ts (grep `phaseForConversation`), and reword its doc comment: 'The conversation step of the conversation being sent to (Req 11.1), derived from the same plan document the prompt is built from ...'. Leave the `OrchestratorPhase` type annotations as they are. No other src file imports `phaseFor` (verified: only chatController.ts and the systemPrompt tests).

   Files: `src/activation/chatController.ts`

3. Rewrite the Plan-mode prompt text in phased-plan terms

   In src/orchestrator/systemPrompt.ts replace the text constants (keep all exported names; keep each one a `[...].join('\n')`):

   PROHIBITION_LINES (each its own sentence):
     'You do not write plan documents.', 'You do not write phase plans.', 'You do not review phase plans.', 'You do not execute phase plans.', 'You do not review executions.', 'A configured coding agent does each of those when you dispatch it.'

   SCOPE_TEXT:
     'You have exactly two jobs.',
     '1. Help the user create a phased plan. Ask clarifying questions, restate the change as endstate, what needs changing, and limitations & constraints, and once you and the user agree on it hand it to the plan writer with `draft_plan`.',
     '2. Drive an approved plan to completion. Dispatch each stage with `run`, land each done phase with `land_phase`, and when every phase is done and landed finish with `submit_pr`.',
     'That is the whole job. Everything else belongs to someone else:', ...PROHIBITION_LINES

   ROLE_TEXT:
     'You are the Baiton chat orchestrator. You help the user create phased plans and you drive approved plans to completion.',
     'You never edit source code. Your only writes go through the plan-writing tools, which touch `.baiton/plans/**` (and legacy `.baiton/specs/**` documents) and nothing else.',
     third line unchanged.

   DRIVE_TEXT (same structure, plan/phase words; keep every stage-table line byte-identical where it has no spec/todo word):
     'This plan is approved. Your job here is to drive it to completion, one phase at a time.',
     'The next legal stage follows the phase\'s current state:',
     '- `pending` -> `run` the `plan` stage.', '- `planned` -> `run` the `execute` stage.', '- `executed` -> `run` the `review` stage.',
     '- A review that sends the phase back -> `run` the `execute` stage again.',
     '- `done` (unlanded) -> `land_phase` it, which merges its branch into the plan branch.',
     'A phase can be planned only once every phase it comes `after` is done and landed.',
     '`run` blocks until the stage finishes and returns its outcome. There is nothing to poll, watch or read afterwards: when it returns, the stage is over and the plan document already reflects it.',
     'Drive one phase at a time. Take the next phase only when the one before it is `done`; land a done phase whenever you choose, but before any phase that comes `after` it is planned.',
     'You do not read the phase plan, the diff, or any source file to check the work. The plan reviewer and the execution reviewer do that; the user has View plan and the repository for the rest.',
     'When every phase is `done` and landed, tell the user and offer to `submit_pr`. `submit_pr` refuses while any phase is unlanded.'

   FLOW_TEXT (the gather flow; this is the core of the todo):
     'Phased Plan flow:',
     '1. When the user describes work, inspect the repository with the read tools and ask clarifying questions until you understand what is wanted.',
     '2. Restate the change in three sections: Endstate (what is true once the work is done), What needs changing (the areas, files and behaviours that must change), and Limitations & constraints (what must not change, compatibility requirements and other limits).',
     '3. Present that restatement to the user and revise it until they agree.',
     '4. Once they agree, call `draft_plan` with a slug and the agreed restatement as the request.',
     '5. Then tell the user the plan is being written by the configured harness, that they can watch it in the plan-writer terminal, and that the plan appears in the Plan Explorer once it lands.',
     'You never propose the phases yourself. `draft_plan` hands the agreed restatement to the plan-writer agent, which studies the repository and drafts the preamble and the dependency-ordered phases.',
     'After a draft lands you may refine it with `update_overview` (the preamble), `add_phase`, `edit_phase` and `remove_phase`.'

   STYLE_TEXT: change only the 4th bullet to '- Keep replies to a few sentences. The one exception is the endstate / what needs changing / limitations & constraints restatement, which you present in full.' (keep 'Answer first', 'not restate the user\'s request' — that bullet stays as is — 'not summarize tool output', 'one clarifying question at a time with `ask_user`').

   TODO_GRAMMAR_TEXT: rename the const to PHASE_GRAMMAR_TEXT and make it:
     'Phase line grammar (tech-sheet section 5):',
     '- Each phase line has the shape `- [<state>] <id> <title>`, optionally followed by ` (<hints>)` as the last thing on the line.',
     `- \`state\` is one of: ${PHASE_STATES.join(', ')}.`,
     '- In a plan (phases under `# PHASES`), `id` is `P` followed by two or more digits (for example `P01`), unique in the file, and never renumbered.',
     '- A legacy spec document (lines under `# TODOS`) uses `T` ids instead (for example `T01`). A line whose id prefix does not match its document is malformed.',
     '- `hints` are groups separated by `;`. `after P01, P02` lists dependency ids. `files: a, b` lists starting files.',
     '- A trailing parenthesis that does not parse as hints is part of the title.'

   FRONTMATTER_TEXT: first line 'Plan frontmatter rules (tech-sheet section 5):'; rest unchanged (enum values and EXTENSION_WRITTEN_KEYS unchanged).

   The appended content block in BOTH buildSystemPrompt and buildSubAgentPrompt: 'Current spec file content:' -> 'Current plan document content:'.
   Update the PHASE_STATES comment to 'The eight allowed phase lifecycle states'. Update the comment in buildSystemPrompt's run branch to name PHASE_GRAMMAR_TEXT, FRONTMATTER_TEXT and the `Current plan document content:` block, and 'plan grammar would describe files it cannot touch'.

   Files: `src/orchestrator/systemPrompt.ts`

4. Phased Plan / Quick Fix framing in the run-step text and sub-agent text

   In src/orchestrator/systemPrompt.ts:
   - RUN_ROLE_TEXT line 1: 'You are the Baiton chat orchestrator. This conversation is not a plan conversation: you agree one piece of work with the user and dispatch it as a single run.' (rest unchanged).
   - RUN_FLOW_TEXT.default: unchanged except nothing says spec/todo already; keep 'Phased Plan', 'Quick Fix', the option ids `plan`,`bug`,`quick`,`refactor`,`investigate`, and 'Phased Plan -> dispatch nothing. Tell the user to change the Mode control in the composer to Phased Plan and send the request again.' Change the bullet '- Quick -> call `start_run` with `mode: "quick"`...' to '- Quick Fix -> call `start_run` with `mode: "quick"`, ...' (the string '`start_run` with `mode: "quick"`' must remain).
   - RUN_FLOW_TEXT.quick: heading 'Quick Fix flow:'; last line 'Quick Fix is for one small, self-contained change. If the work needs several coordinated changes, say so and offer to switch to Phased Plan rather than dispatching it anyway.'
   - MODE_PROPOSAL_TEXT: replace '- Work that needs an agreed requirements document and several todos -> Phased Plan.' with '- Work that needs an agreed endstate and several dependency-ordered phases -> Phased Plan.' Keep the other four bullets ('-> Bug.', '-> Quick Fix.', '-> Refactor.', '-> Investigate.') and the surrounding lines.
   - runFlowText comment: 'The flow text for one plan-less mode'. RUN_FLOW_TEXT doc comment: replace 'the beats the OVERVIEW names' with 'the same beats' and 'a Spec pick' with 'a Phased Plan pick'.
   - SUBAGENT_ROLE_TEXT line 3: 'You never finish a plan. You do not draft, approve, land or submit; only the top-level chat does that, and those tools are not yours.'
   - SUBAGENT_DRIVE_TEXT: 'Your parent is driving an approved plan. When your task is to move a phase forward, dispatch the next legal stage with `run`:', stage lines unchanged except '- A review that sends the phase back -> `run` the `execute` stage again.'; the done line and the blocking line unchanged.
   - Comments: 'The run table a sub-agent sees only while its parent is driving an approved plan.'; 'The sub-agent's role: one task, a concise report back, and no plan finishing.'

   Files: `src/orchestrator/systemPrompt.ts`

5. Update test/systemPrompt.test.ts

   - Import `conversationStepFor` instead of `phaseFor`; replace every call.
   - Rename local fixtures: `SPEC` -> `PLAN` ({ kind: 'spec', slug: 'my-plan' } with a `// 'spec' is the legacy persisted conversation kind` comment), `specWithStatus` -> `planWithStatus` producing a PLAN document. Check the plan-kind headings the parser expects (src/model/parser.ts: `# PHASES` and the preamble section headings — read the parser to get the exact heading strings, e.g. `# Endstate`, `# What needs changing`, `# Limitations & constraints`) and build: frontmatter (version, name: my-plan, status), the three preamble sections with one line each, `# PHASES`, `- [pending] P01 Do the first thing`. `DRAFT_SPEC`/`APPROVED_SPEC` -> `DRAFT_PLAN`/`APPROVED_PLAN`. Add `legacySpecWithStatus(status)` producing the old `# OVERVIEW`/`# TODOS`/`T01` document and `APPROVED_LEGACY_SPEC`, and add a test 'conversationStepFor is drive for an approved legacy spec document too' asserting 'drive' and that buildSystemPrompt(PLAN, APPROVED_LEGACY_SPEC) includes DRIVE_TEXT.
   - Rewrite the header comment in plan terms (role text, Phased Plan flow, phase grammar with P ids and legacy T ids, frontmatter, plan document content included/omitted; 'Conversation-step split: `conversationStepFor` ...'). Drop '(Task 3.2)' and `create_spec`-style historical references except where the test asserts their absence.
   - role text: /spec-writing tools/ -> /plan-writing tools/; add assert prompt includes '`.baiton/plans/**`'.
   - 'new-spec flow' describe -> 'Phased Plan flow (Req 11.2)': assert /clarifying questions/i, /draft_plan/, /agree/i, and that the prompt includes 'Endstate', 'What needs changing', 'Limitations & constraints', /revise it until they agree/i, and that the index of 'Restate the change' is before the index of 'call `draft_plan`'. Replace the 'names the parts a requirements document must cover' test with this three-section test. 'forbids proposing the todo list' -> assert /never propose the phases yourself/i. Keep the harness/watch test and add /Plan Explorer/. Keep 'no longer mentions create_spec'; add assert !prompt.includes('requirements document').
   - style: 'bounds replies to a few sentences, excepting the restatement': /few sentences/i and /restatement, which you present in full/i.
   - 'todo grammar' describe -> 'phase grammar (Req 11.3)'; line-shape message 'phase line shape'; replace the T-id test with: /`P`.*two or more digits/i and /legacy spec[^\n]*`T` ids/i; hint test unchanged except it still checks 'separated by `;`'.
   - content inclusion: content fixture becomes a plan document; message strings say plan; 'ignores document content for a workspace conversation'.
   - scope: labels 'a draft plan', 'an approved plan', 'a plan with no content'; 'names both jobs': keep /exactly two jobs/i, /clarifying questions/i, /agree/i, '`draft_plan`', '`run`', '`submit_pr`', '`land_phase`' (message 'job two lands each done phase'), add SCOPE_TEXT includes 'phased plan'.
   - ask_user labels as above.
   - 'phase split' describe -> 'conversation-step split (Req 11.1)'; test names 'conversationStepFor is gather for ...'; 'includes the drive text only for a plan past draft'; 'includes the Phased Plan flow only while gathering' using /Phased Plan flow:/; stage table assertions unchanged except /review that sends the phase back.*`execute`/; submit_pr test: /every phase is `done` and landed/, /`submit_pr` refuses while any phase is unlanded/, /after.*done and landed/; blocking test: /one phase at a time/i. Keep 'plan-review' absence test.

   Files: `test/systemPrompt.test.ts`

6. Rename and update the property test

   `git mv test/systemPrompt.phase.property.test.ts test/systemPrompt.step.property.test.ts` (mocha picks up test/**/*.test.ts, so no config change). In it: import `conversationStepFor` instead of `phaseFor`; rename `SPEC` to `PLAN` (still `{ kind: 'spec', slug: 'my-plan' }`, comment it as the legacy persisted kind). Header comment: 'Property: the orchestrator's conversation step follows the document's status and nothing else' — rewrite 'phase' -> 'conversation step'/'step' throughout and spec -> plan document. Extend the body arbitrary's constantFrom with plan-kind lines ('# PHASES', '- [pending] P01 Do the first thing', '- [done] P02 Do the second thing', and the preamble headings the parser uses) alongside the legacy '# OVERVIEW'/'# TODOS'/T lines, so both document kinds are generated. Describe 'orchestrator conversation-step derivation (property, Req 11.1)'; test names/messages: 'the drive text appears exactly in the drive step'. Keep numRuns values and the comparison against parsePlan's status.

   Files: `test/systemPrompt.phase.property.test.ts`, `test/systemPrompt.step.property.test.ts`

7. Update test/systemPrompt.mode.test.ts

   - Import `conversationStepFor`; replace every `phaseFor` call. Fixtures: `SPEC` -> `PLAN`, `specWithStatus` -> `planWithStatus` (plan document as in systemPrompt.test.ts), DRAFT/APPROVED_PLAN. `SPECLESS_MODES` -> `PLANLESS_MODES`.
   - Header comment: drop '(T10)'; 'Phased Plan output is byte-for-byte unchanged when mode is absent or plan'; 'conversationStepFor maps every plan-less mode ... to the single `run` step'; 'A plan conversation ignores the mode'; '... none of the Phased Plan flow, drive table, phase grammar, frontmatter rules or plan document content'.
   - describe names: 'phaseFor mapping' -> 'conversationStepFor mapping'; 'a spec conversation is always Spec' -> 'a plan conversation is always Phased Plan'; test names 'to the run step', 'from the run-step sections', 'draft-plan', 'approved-plan', 'contentless-plan'.
   - 'omits every plan-only section': keep !/draft_plan/, !/submit_pr/, !/Phase line grammar/, change to !/Plan frontmatter rules/ and !prompt.includes('Current plan document content:'), add !/Phased Plan flow:/.
   - framing: 'names the one-small-change rule in the quick flow' also assert /^Quick Fix flow:/ on RUN_FLOW_TEXT.quick and /Phased Plan/ in it. Add to the mode-proposal describe: assert MODE_PROPOSAL_TEXT matches /dependency-ordered phases -> Phased Plan/. Default test 'never mentions plan-writing tools'. Keep all other assertions (they still hold: '`start_run` with `mode: "quick"`', 'Phased Plan -> dispatch nothing', etc.).

   Files: `test/systemPrompt.mode.test.ts`

8. Update test/systemPrompt.subagent.test.ts

   Rename `SPEC` -> `PLAN` (kind 'spec', comment legacy). Keep importing ORCHESTRATOR_PHASES from guard (not renamed) but rename loop variables `phase` -> `step` and test names: 'for every conversation step and depth', 'includes the run table only in the drive step'. Change 'You never finish a spec' -> 'You never finish a plan'. Content block assertions: 'Current plan document content:\n\nPLAN BODY' and the two negative checks with 'Current plan document content:'; test name 'appends document content only for a plan kind that has it'. Add an assertion that SUBAGENT_DRIVE_TEXT includes 'move a phase forward' and 'review that sends the phase back'.

   Files: `test/systemPrompt.subagent.test.ts`

9. Verify

   Run `npm run compile`, `npm run lint`, `npm test`. Then sweeps: `rg -n '\bphaseFor\b' src test` (expect no matches; `stepForConversation`/`conversationStepFor` only); `rg -nw 'spec|specs|Spec|todo|todos|Todo|TODOS' src/orchestrator/systemPrompt.ts` — the only allowed hits are the `kind: 'spec'` ConversationKind member / `kind.kind === 'spec'` checks (marked legacy), the legacy `.baiton/specs/**` mention in ROLE_TEXT, the legacy-spec/`# TODOS` grammar line and its comment; `rg -n -i 'phase' src/orchestrator/systemPrompt.ts` — every hit must be a plan phase (PHASE_STATES, PHASE_GRAMMAR_TEXT, phase line, `land_phase`/`add_phase`/`edit_phase`/`remove_phase`, 'Phased Plan', 'phase plans') or the imported `OrchestratorPhase` type name, never gather/drive/run called a phase. Confirm test/chatController.mode.test.ts and test/subAgent.test.ts still pass (they compare against buildSystemPrompt/buildSubAgentPrompt output, so they follow the new text automatically).

   Files: (none)

## Risks

- `OrchestratorPhase`, `ORCHESTRATOR_PHASES` and the `Tool.phases` field in guard.ts/controlTools.ts/registry.ts/chatController.ts/commands.ts/subAgent.ts still use the word 'phase' for gather/drive/run. This plan only renames what systemPrompt.ts owns, adding a `ConversationStep` alias, because a full rename touches many tool definitions and tests outside this todo's file list. If reviewers read the constraint as covering the whole codebase, that is follow-up work (rename to ConversationStep / CONVERSATION_STEPS / `steps`).
- chatController.ts sits outside the listed files, but it is the only src caller of `phaseFor`, so it has to change in the same commit to keep compile green.
- The plan-document fixtures in the tests must use the exact preamble and `# PHASES` headings parsePlan expects. Read src/model/parser.ts rather than guessing. If a fixture doesn't parse, the status still parses from frontmatter, so step tests pass, but the fixture would be misleading.
- PROHIBITION_LINES is asserted verbatim by other tests through the exported constant, never as literal strings (checked with grep), so changing the wording is safe. Still, grep for 'You do not write' before finishing.
- chatController.mode.test.ts and subAgent.test.ts compare full prompt strings built by the same functions, so they pick up the text changes on their own. Any test that hard-codes old prompt phrases like 'New spec flow:' or 'Current spec file content:' would break. grep found none outside the systemPrompt tests.

## Acceptance

- `npm run compile` succeeds, and `npm run lint` reports 0 errors.
- `npm test` passes in full, including the renamed test/systemPrompt.step.property.test.ts. test/systemPrompt.phase.property.test.ts no longer exists.
- `phaseFor` no longer exists anywhere in src or test. `conversationStepFor` and the `ConversationStep` type are exported from src/orchestrator/systemPrompt.ts, and chatController.ts uses `conversationStepFor`.
- The gather (Plan-mode workspace or draft plan) prompt contains 'Phased Plan flow:' and tells the orchestrator, in this order, to: inspect and ask clarifying questions, restate the change as Endstate / What needs changing / Limitations & constraints, revise until the user agrees, then call `draft_plan`. It says the orchestrator never proposes the phases itself, and it no longer mentions 'requirements document', 'todo' or 'New spec flow'.
- The drive prompt, scope text, sub-agent text and grammar use plan/phase words: P## ids for plans, T## ids described only as the legacy spec form, 'Plan frontmatter rules', 'Current plan document content:'. The Plan-mode prompt contains no word-match of spec/todo except the clearly marked legacy references.
- The run-step prompts frame modes as Phased Plan and Quick Fix ('Quick Fix flow:', and MODE_PROPOSAL_TEXT points dependency-ordered phased work at Phased Plan). The Default flow still lists option ids plan/bug/quick/refactor/investigate, and every existing dispatch-tool assertion still holds.
- conversationStepFor returns the same values phaseFor did for every input: 'run' for plan-less workspace modes, 'drive' for the five approved statuses on a plan conversation (for both plan and legacy spec documents), and 'gather' otherwise. buildSystemPrompt is still pure, and gives identical output for no mode, 'plan' and DEFAULT_MODE on a plan conversation.
