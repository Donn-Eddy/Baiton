# Plan T10

## Steps

1. Import the mode vocabulary into systemPrompt.ts and extend its header doc comment

   In `src/orchestrator/systemPrompt.ts` add `import { DEFAULT_MODE, isSpecless, RunMode } from '../model/mode';` beside the existing `parseSpec` / `OrchestratorPhase` imports. (`src/model/mode.ts` already exports `RunMode = 'spec' | 'bug' | 'quick' | 'refactor' | 'investigate'`, `RUN_MODES`, `DEFAULT_MODE = 'spec'`, `isRunMode` and `isSpecless(mode) === mode !== 'spec'`; do not change that file.) Extend the file header comment's phase list with a third bullet: `- **run** — a non-Spec Workspace conversation (Bug/Quick/Refactor/Investigate): inspect with the read tools, state the work and the guessed files, then dispatch one spec-less run with `start_run` or `investigate`.` and state in prose the invariant this todo is built around: the `mode` argument is optional and trailing on both `phaseFor` and `buildSystemPrompt`, and an absent mode or `'spec'` reproduces today's phase and today's prompt text byte for byte, so every existing Spec-mode test keeps passing unmodified. Note that the mode is a property of the Workspace conversation only — a spec conversation is always Spec — and that the PHASE `run` is not the TOOL `run` (the same warning `guard.ts` carries).

   Files: `src/orchestrator/systemPrompt.ts`

2. Add the optional trailing `mode` argument to `phaseFor`

   Change the signature to `export function phaseFor(kind: ConversationKind, specContent?: string, mode: RunMode = DEFAULT_MODE): OrchestratorPhase`. New body, in this order:

   1. `if (kind.kind === 'workspace' && isSpecless(mode)) { return 'run'; }` — every non-Spec mode maps to the single `run` phase; the pipeline, not the phase, distinguishes `investigate` from bug/quick/refactor (`controlTools.ts` already advertises `start_run` and `investigate` with `phases: ['run']`).
   2. Then the existing two statements unchanged: `if (kind.kind !== 'spec' || specContent === undefined) { return 'gather'; }` and the `DRIVE_STATUSES.includes(status) ? 'drive' : 'gather'` return.

   Because the new branch is guarded on `kind.kind === 'workspace'`, a spec conversation ignores the `mode` argument entirely and keeps its existing gather/drive split even if a caller passes `'bug'`; document that in the doc comment as the deliberate encoding of "a spec conversation is always Spec". Update the doc comment to add the `@param mode` line: absent or `'spec'` means the phase is computed exactly as before.

   Files: `src/orchestrator/systemPrompt.ts`

3. Add the run-phase role and scope text

   Beside `ROLE_TEXT` and `SCOPE_TEXT` in `src/orchestrator/systemPrompt.ts`, add two exported constants (exported so the tests can assert them verbatim, matching how `SCOPE_TEXT`/`DRIVE_TEXT`/`REFUSAL_TEXT` are already exported and asserted):

   ```ts
   /** The run-phase role text: same prohibitions, no spec tools at all. */
   export const RUN_ROLE_TEXT = [
     'You are the Baiton chat orchestrator. This conversation is not a spec conversation: you agree one piece of work with the user and dispatch it as a single run.',
     'You never edit source code. You write nothing at all yourself; the only writes in this conversation are made by the agents a run dispatches, under `.baiton/runs/` and the run\'s own worktree.',
     'You inspect the repository only through the read tools you have been given for this conversation, and never through any other means.',
   ].join('\n');

   /** The run-phase scope text: one job, plus the work that is not the orchestrator\'s. */
   export const RUN_SCOPE_TEXT = [
     'You have exactly one job here: agree what the work is, then dispatch one run.',
     'That is the whole job. Everything else belongs to someone else:',
     ...PROHIBITION_LINES,
   ].join('\n');
   ```

   Reuse `PROHIBITION_LINES` rather than restating it, so the prohibitions stay identical in every phase (an existing test already asserts each prohibition line appears in the gather and drive prompts; the new tests assert the same for run). Leave `ROLE_TEXT`, `SCOPE_TEXT`, `PROHIBITION_LINES`, `REFUSAL_TEXT`, `ASK_USER_TEXT`, `DRIVE_TEXT`, `FLOW_TEXT`, `STYLE_TEXT`, `TODO_GRAMMAR_TEXT` and `FRONTMATTER_TEXT` byte-for-byte unchanged.

   Files: `src/orchestrator/systemPrompt.ts`

4. Add the per-mode run flow text and the mode-proposal text

   Still in `src/orchestrator/systemPrompt.ts`, add a `SpeclessMode` alias and one flow text per spec-less mode, plus a shared closing paragraph, all exported:

   ```ts
   /** A mode whose conversation is in the `run` phase: every mode except `spec`. */
   export type SpeclessMode = Exclude<RunMode, 'spec'>;
   ```

   `export const RUN_FLOW_TEXT: Readonly<Record<SpeclessMode, string>> = { bug: ..., quick: ..., refactor: ..., investigate: ... }` — an exhaustive `Record`, so adding a mode to `RunMode` later fails to compile until its flow text exists. Each entry is a `[...].join('\n')` numbered flow that follows the same four beats the OVERVIEW names — inspect with the read tools, state the work in one line, name the guessed files, call the run tool — and names the tool call concretely as `controlTools.ts` defines it (`start_run(mode, statement, files, reproduction?)` with `mode` one of `bug`/`quick`/`refactor`; `investigate(question, files)`):

   - `bug`: 'Bug flow:' / '1. When the user reports a defect, inspect the repository with the read tools until you can state the defect in one line.' / '2. Establish how to reproduce it. Ask with `ask_user` if the user has not said.' / '3. Name the files the fix most likely touches. A short, honest guess is better than a long one.' / '4. Call `start_run` with `mode: "bug"`, the one-line defect as `statement`, the guessed `files`, and the reproduction as `reproduction`.' / '5. Then tell the user the run has started on its own branch and worktree, and that they can watch it in the Runs view and merge it when it passes.'
   - `quick`: same five beats without reproduction: state the change in one line, name the guessed files, 'Call `start_run` with `mode: "quick"`, the one-line statement of the change, and the guessed `files`.', plus 'Quick is for one small, self-contained change. If the work needs several coordinated changes, say so and offer to switch mode rather than dispatching it anyway.'
   - `refactor`: same shape with `mode: "refactor"`, plus 'A refactor must not change behaviour: say in the statement what shape the code should end up in, not what it should start doing.' and 'The configured verify command must still pass afterwards; the run\'s reviewer checks that, not you.'
   - `investigate`: 'Investigation flow:' / '1. Inspect the repository with the read tools until you can state the question in one line.' / '2. Name the files the answer most likely lives in.' / '3. Call `investigate` with that one-line `question` and the guessed `files`.' / '4. Then tell the user the investigation has started and that the finding will appear in the chat and under `.baiton/runs/` when it lands.' / 'An investigation changes nothing: no branch, no worktree, no commit. If the user wants the problem fixed rather than answered, say so and offer to switch mode.'

   Then the shared paragraph, appended for every spec-less mode:

   ```ts
   /** How to propose a different mode rather than forcing the work into this one. */
   export const MODE_PROPOSAL_TEXT = [
     'The mode is the user\'s choice, not yours, and you cannot change it yourself.',
     'When the work does not fit this mode, propose the mode that does with `ask_user` and wait for the answer:',
     '- Work that needs an agreed requirements document and several todos -> Spec.',
     '- A defect with a reproduction -> Bug.',
     '- One small, self-contained change -> Quick.',
     '- A behaviour-preserving restructure -> Refactor.',
     '- A question to be answered rather than work to be done -> Investigate.',
     'If they agree, tell them to change the Mode control in the composer; do not dispatch under the wrong mode.',
   ].join('\n');
   ```

   Add a small exported helper `export function runFlowText(mode: SpeclessMode): string { return RUN_FLOW_TEXT[mode]; }` so callers and tests need no index-signature dance.

   Files: `src/orchestrator/systemPrompt.ts`

5. Add the optional trailing `mode` argument to `buildSystemPrompt` and branch on the run phase

   Change the signature to `export function buildSystemPrompt(kind: ConversationKind, specContent?: string, mode: RunMode = DEFAULT_MODE): string` and pass the mode straight through: `const phase = phaseFor(kind, specContent, mode);`.

   Branch before the existing assembly, so the existing path is untouched code:

   ```ts
   if (phase === 'run') {
     return [
       RUN_ROLE_TEXT,
       RUN_SCOPE_TEXT,
       REFUSAL_TEXT,
       ASK_USER_TEXT,
       runFlowText(mode as SpeclessMode),
       MODE_PROPOSAL_TEXT,
       STYLE_TEXT,
     ].join('\n\n');
   }
   ```

   Prefer a narrowing that needs no cast: since `phase === 'run'` is only reachable via the `isSpecless(mode)` branch of `phaseFor`, write `if (kind.kind === 'workspace' && isSpecless(mode))` as the guard instead and compute `phase` after it, or keep `phase` and narrow with `if (phase === 'run' && mode !== 'spec')`. Whichever form is used, no `as` cast and no `any` may appear (the repo lints with `@typescript-eslint`), and the function must still be total for every `RunMode`.

   The run prompt deliberately omits `TODO_GRAMMAR_TEXT`, `FRONTMATTER_TEXT` and the `Current spec file content:` block: a run-phase conversation has no spec-writing tool at all (`controlTools.ts` keeps `draft_spec`, `add_todo`, `edit_todo`, `remove_todo`, `update_overview`, `approve_spec`, `run` and `submit_pr` off the `run` phase), so spec grammar would describe files it cannot touch. Say that in a comment at the branch.

   Everything after the branch — the `sections` array, the `phase === 'drive' ? DRIVE_TEXT : FLOW_TEXT` choice, the spec-content append and the `sections.join('\n\n')` — stays exactly as it is today. Update the doc comment with `@param mode`: 'The conversation\'s mode. Absent or `spec` builds the prompt exactly as before; any other mode builds the run-phase prompt for that mode. Ignored for a spec conversation, which is always Spec.'

   Files: `src/orchestrator/systemPrompt.ts`

6. Write test/systemPrompt.mode.test.ts (new tests only)

   New file `test/systemPrompt.mode.test.ts`, mocha + node `assert` in the style of `test/systemPrompt.test.ts` (plain `describe`/`it`, a header doc comment listing coverage, module-level `const WORKSPACE: ConversationKind = { kind: 'workspace' }` and `const SPEC: ConversationKind = { kind: 'spec', slug: 'my-spec' }`, plus a local `specWithStatus(status)` helper copied from that file for the draft/approved fixtures). Import `buildSystemPrompt`, `phaseFor`, `ConversationKind`, `MODE_PROPOSAL_TEXT`, `PROHIBITION_LINES`, `REFUSAL_TEXT`, `ASK_USER_TEXT`, `RUN_FLOW_TEXT`, `RUN_ROLE_TEXT`, `RUN_SCOPE_TEXT` from `../src/orchestrator/systemPrompt`, and `DEFAULT_MODE`, `RUN_MODES`, `RunMode`, `isSpecless` from `../src/model/mode'`. Modify no existing test file.

   Suites and cases:

   1. **Spec output is unchanged (the load-bearing test).** `assert.strictEqual(buildSystemPrompt(WORKSPACE), buildSystemPrompt(WORKSPACE, undefined, 'spec'))`; `assert.strictEqual(buildSystemPrompt(WORKSPACE), buildSystemPrompt(WORKSPACE, undefined, DEFAULT_MODE))`; the same three-way equality for `buildSystemPrompt(SPEC, DRAFT_SPEC, ...)`, `buildSystemPrompt(SPEC, APPROVED_SPEC, ...)` and `buildSystemPrompt(SPEC)`. Full-string `strictEqual`, not `match`, so any drift in the Spec prompt fails here.

   2. **`phaseFor` mapping.** `assert.strictEqual(phaseFor(WORKSPACE), 'gather')` and with `'spec'`; for each of `['bug','quick','refactor','investigate']`, `assert.strictEqual(phaseFor(WORKSPACE, undefined, mode), 'run')` and also with `APPROVED_SPEC` passed as content (the content is irrelevant for a workspace). A `for (const mode of RUN_MODES)` loop asserting `phaseFor(WORKSPACE, undefined, mode) === (isSpecless(mode) ? 'run' : 'gather')`, so a new `RunMode` is forced into this test.

   3. **A spec conversation is always Spec.** For each spec-less mode: `assert.strictEqual(phaseFor(SPEC, DRAFT_SPEC, mode), 'gather')`, `assert.strictEqual(phaseFor(SPEC, APPROVED_SPEC, mode), 'drive')`, `assert.strictEqual(phaseFor(SPEC, undefined, mode), 'gather')`, and `assert.strictEqual(buildSystemPrompt(SPEC, APPROVED_SPEC, mode), buildSystemPrompt(SPEC, APPROVED_SPEC))`.

   4. **Run prompt content, per mode.** For each spec-less mode, build `const prompt = buildSystemPrompt(WORKSPACE, undefined, mode)` and assert: it contains `RUN_ROLE_TEXT`, `RUN_SCOPE_TEXT`, `REFUSAL_TEXT`, `ASK_USER_TEXT`, `RUN_FLOW_TEXT[mode]` and `MODE_PROPOSAL_TEXT` verbatim (`assert.ok(prompt.includes(...))`); every line of `PROHIBITION_LINES` appears; it matches `/read tools/i` and mentions the Style rules (`/Answer first/`). Negative assertions: it does **not** contain the spec-flow text (`assert.ok(!/draft_spec/.test(prompt))`), the drive stage table (`assert.ok(!/submit_pr/.test(prompt))`), the todo grammar (`assert.ok(!/Todo line grammar/.test(prompt))`), the frontmatter rules (`assert.ok(!/Spec frontmatter rules/.test(prompt))`) or `Current spec file content:`.

   5. **Each mode names its own tool and framing.** `bug`, `quick`, `refactor` prompts each match `/`start_run`/` and `` new RegExp(`mode: "${mode}"`) ``, and none of them matches `/`investigate`\(/`-style advice to call `investigate` as the dispatch (they may still mention Investigate in `MODE_PROPOSAL_TEXT`, so assert on the flow text alone: `assert.ok(!/call `investigate`/i.test(RUN_FLOW_TEXT[mode]))`). The `investigate` prompt matches `/`investigate`/` and its flow text does **not** match `/start_run/`. `bug` matches `/reproduc/i`; `refactor` matches `/not change behaviour/i` and `/verify/i`; `quick` matches `/small, self-contained/i`; `investigate` matches `/changes nothing|read-only/i`.

   6. **Mode proposal.** Every run prompt tells the model to propose a different mode through `ask_user` (`assert.match(prompt, /propose the mode that does with `ask_user`/)`) and names all five modes (`Spec`, `Bug`, `Quick`, `Refactor`, `Investigate`) in `MODE_PROPOSAL_TEXT`.

   7. **Every spec-less mode has flow text.** `for (const mode of RUN_MODES) if (isSpecless(mode)) assert.ok(typeof RUN_FLOW_TEXT[mode] === 'string' && RUN_FLOW_TEXT[mode].trim().length > 0)`, and `assert.strictEqual(Object.keys(RUN_FLOW_TEXT).length, RUN_MODES.length - 1)`.

   8. **Purity.** A `buildSystemPrompt(WORKSPACE, undefined, 'bug')` called twice returns `strictEqual` strings (the builder stays pure and stateless).

   Files: `test/systemPrompt.mode.test.ts`

7. Verify nothing else needed changing

   Do not modify `src/activation/chatController.ts` (its `buildSystemPrompt(kind)` / `buildSystemPrompt(kind, specContent)` and `phaseFor(...)` calls at roughly lines 891, 894, 905 and 907 keep compiling unchanged because `mode` is trailing and defaulted — threading the conversation's mode through the controller belongs to the chat-mode-control todo, not this one). Do not modify `src/orchestrator/guard.ts`, `controlTools.ts`, `registry.ts`, `src/model/mode.ts`, or any existing test. Then run `npm run compile`, `npm run lint` and `npm test` and report the counts; the only lint warning expected is the pre-existing unused `_legacy` at `src/orchestrator/webviewProtocol.ts:591`.

   Files: `src/orchestrator/systemPrompt.ts`, `test/systemPrompt.mode.test.ts`

## Risks

- Regressing the Spec prompt. Any edit inside ROLE_TEXT, SCOPE_TEXT, FLOW_TEXT, DRIVE_TEXT, STYLE_TEXT, TODO_GRAMMAR_TEXT, FRONTMATTER_TEXT or the existing assembly order breaks test/systemPrompt.test.ts and test/systemPrompt.phase.property.test.ts, which must not be touched. Add new constants beside the old ones and gate every new behaviour behind `isSpecless(mode)`; the full-string equality test in suite 1 is the tripwire.
- Argument-order mistake. `mode` must be the third, optional, defaulted parameter on both functions; inserting it before `specContent` would silently break every existing call site in chatController.ts and the two existing test files.
- Phase leakage on a spec conversation. If the spec-less branch in `phaseFor` is not guarded on `kind.kind === 'workspace'`, a stray mode value would put an approved spec into the `run` phase, where `run`/`submit_pr` do not exist and the spec could never be driven. The guard plus suite 3 pin this.
- Type narrowing. `runFlowText` takes `SpeclessMode`, so the call site needs narrowing rather than a cast; an `as` cast would pass tsc but hide a future `RunMode` addition that has no flow text. Structure the branch so control flow narrows `mode` (`mode !== 'spec'`), and keep `RUN_FLOW_TEXT` an exhaustive `Record<SpeclessMode, string>` so a new mode is a compile error.
- Wording drift between the prompt and the tools. The flow text names `start_run(mode, statement, files, reproduction?)` and `investigate(question, files)` and the `bug`/`quick`/`refactor` enum exactly as src/orchestrator/controlTools.ts declares them; if those schemas are read differently than recorded here, follow the source, not this plan.
- Over-reach. T10 is prompt text plus tests only. Threading the mode from the webview/workspaceState through chatController, and the phase/tool selection there, belong to the later chat-mode-control todo; touching chatController here would collide with it.

## Acceptance

- `buildSystemPrompt(kind, content)` and `buildSystemPrompt(kind, content, 'spec')` return strictly equal strings for a workspace conversation, a draft spec, an approved spec and a spec with no content; likewise for `DEFAULT_MODE`.
- `phaseFor(kind, content)` and `phaseFor(kind, content, 'spec')` agree for every input, and `phaseFor({kind:'workspace'}, any, mode)` is `'run'` for each of bug, quick, refactor and investigate.
- A spec conversation ignores the mode: `phaseFor({kind:'spec',...}, approvedSpec, 'bug')` is `'drive'`, with a draft or no content it is `'gather'`, and `buildSystemPrompt` for a spec conversation is unchanged by the mode argument.
- Each of the four run prompts contains its own mode's flow text, the run role and scope text, the unchanged REFUSAL_TEXT and ASK_USER_TEXT, every PROHIBITION_LINES line, the style rules, and the mode-proposal paragraph naming `ask_user` and all five modes.
- No run prompt contains `draft_spec`, `submit_pr`, the todo-line grammar, the spec frontmatter rules, or `Current spec file content:`.
- The bug/quick/refactor flow texts direct the model to `start_run` with their own mode value; the investigate flow text directs it to `investigate` and states that nothing is written except the finding; bug names reproduction, refactor names behaviour preservation and the verify command.
- `RUN_FLOW_TEXT` is an exhaustive, non-empty `Record<Exclude<RunMode,'spec'>, string>`, so adding a mode without flow text fails to compile.
- test/systemPrompt.mode.test.ts is the only new file under test/, and no existing test file is modified.
- `npm run compile` is clean, `npm run lint` reports 0 errors (only the pre-existing `_legacy` warning at src/orchestrator/webviewProtocol.ts:591), and `npm test` passes with every previously passing test still passing plus the new cases.
