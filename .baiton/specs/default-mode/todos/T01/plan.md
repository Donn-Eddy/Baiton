# Plan T01

## Steps

1. Widen RunMode and RUN_MODES with 'default' listed first

   In src/model/mode.ts change the union to `export type RunMode = 'default' | 'spec' | 'bug' | 'quick' | 'refactor' | 'investigate';` and the array to `export const RUN_MODES: readonly RunMode[] = ['default', 'spec', 'bug', 'quick', 'refactor', 'investigate'] as const;`. Update the doc comment above RUN_MODES from "spec first" to "default first". Update the file-header JSDoc: it currently says "`spec` is the default"; rewrite so it says a conversation starts in `default`, a recommend-and-confirm mode that is never itself a run (it inspects the ask, recommends one of the five concrete modes via one ask_user card, and dispatches the picked mode with the existing tools); `spec` keeps the gather -> draft_spec -> approve -> run per-todo flow byte-for-byte; bug/quick/refactor share the spec-less plan -> execute -> review pipeline; investigate is the read-only dispatch ending in a finding. isRunMode needs no code change (it reads RUN_MODES).

   Files: `src/model/mode.ts`

2. Make DEFAULT_MODE 'default'

   In src/model/mode.ts set `export const DEFAULT_MODE: RunMode = 'default';`. Rewrite its JSDoc: it is the mode a Workspace conversation starts in and the fallback for an absent/unknown stored value; note that spec conversations do not follow it (callers that must stay Spec — a spec conversation's effective mode, webview fallbacks — use the literal 'spec'). Do not touch any caller in this todo.

   Files: `src/model/mode.ts`

3. Keep isSpecless('default') true and document it

   Leave `isSpecless` body as `return mode !== 'spec';` (so 'default' is spec-less and phaseFor/buildSystemPrompt map it to the run phase). Extend its JSDoc with one sentence: `default` is spec-less too — it never dispatches as itself and never reads or writes a spec; it maps to the run phase beside bug/quick/refactor/investigate, and runPipeline/runStore refuse it as a run mode just like 'spec'.

   Files: `src/model/mode.ts`

4. Confirm the barrel export

   src/model/index.ts already has `export * from './mode';` (line 7), so DEFAULT_MODE/RUN_MODES/RunMode/isRunMode/isSpecless flow through unchanged. No edit is needed; only touch it if the export line is missing.

   Files: `src/model/index.ts`

5. Update test/mode.test.ts pins

   In the `describe('RunMode')` block: (1) rename the first test to `it('defaults to default so a Workspace conversation starts in recommend-and-confirm', ...)` and assert `assert.strictEqual(DEFAULT_MODE, 'default');`. (2) Rename `'lists every mode, spec first'` to `'lists every mode, default first'` and pin `['default', 'spec', 'bug', 'quick', 'refactor', 'investigate']`. (3) In the isRunMode rejection test, add `assert.strictEqual(isRunMode('Default'), false);`. (4) Keep `'treats every mode but spec as spec-less'` as is (the loop now covers 'default'), and add an explicit `assert.strictEqual(isSpecless('default'), true);` line. (5) Add `it('recognises default as a mode', () => assert.strictEqual(isRunMode('default'), true));` (or fold into the recognise test). Leave the investigate-stage, investigate-result and existing-stages describe blocks untouched. Update the describe-level JSDoc comment to mention the `default` mode alongside the RunMode union.

   Files: `test/mode.test.ts`

## Risks

- Compile break outside this todo's files: src/orchestrator/systemPrompt.ts:216 defines `type SpeclessMode = Exclude<RunMode, 'spec'>` and line 225 `RUN_FLOW_TEXT: Readonly<Record<SpeclessMode, string>>` with keys bug/quick/refactor/investigate only. Widening RunMode makes 'default' a SpeclessMode, so `tsc -p ./` reports a missing `default` property there. ts-node (mocha via .mocharc.json, no transpileOnly) type-checks every imported file, so any test importing systemPrompt.ts transitively (test/mode.test.ts imports src/activation/engineFacade, which may pull it in) will fail to load. The Default flow text belongs to a later todo; the executor must not edit systemPrompt.ts here. Verify T01 with TS_NODE_TRANSPILE_ONLY=true if needed, and report the RUN_FLOW_TEXT error as the expected, known cross-todo gap rather than 'fixing' it with a placeholder.
- Changing DEFAULT_MODE flips behaviour of every current caller (commands.ts:382 composerMode fallback, chatController.ts:365/417 seeding and :694 effectiveMode for spec conversations, webviewProtocol.ts:357 initialWebviewState, systemPrompt.ts:109/342 default params). Those are intentionally updated by later todos (e.g. effectiveMode must pin to literal 'spec', initialWebviewState to literal 'spec'); other existing tests that pin DEFAULT_MODE-derived values (chatController, webviewProtocol mirror parity, systemPrompt tests) may fail until those todos land. Do not fix them in T01.
- runPipeline.start/runStore.create currently accept any isRunMode value other than 'spec'; after this change isRunMode('default') is true, so until the later todo adds the refusal, a 'default' run could technically be created. Not in T01's scope; do not add refusal logic here.
- runContext.ts switch on input.mode uses a `default:` fallthrough, so it compiles with the new member; no action needed.

## Acceptance

- src/model/mode.ts: RunMode is `'default' | 'spec' | 'bug' | 'quick' | 'refactor' | 'investigate'`, RUN_MODES equals ['default','spec','bug','quick','refactor','investigate'] in that order, DEFAULT_MODE === 'default', isSpecless unchanged (`mode !== 'spec'`), comments updated to describe default.
- src/model/index.ts still re-exports ./mode (unchanged).
- test/mode.test.ts asserts DEFAULT_MODE === 'default', RUN_MODES pinned default-first, isRunMode('default') true and isRunMode('Default') false, isSpecless('default') true, isSpecless('spec') false; investigate/stage tests unchanged.
- `TS_NODE_TRANSPILE_ONLY=true npx mocha test/mode.test.ts` passes (plain `npx mocha test/mode.test.ts` also passes if its import graph does not reach systemPrompt.ts).
- `npx tsc -p ./ --noEmit` shows no errors in src/model/mode.ts or test/mode.test.ts; the only new errors, if any, are the known missing `default` key in RUN_FLOW_TEXT in src/orchestrator/systemPrompt.ts (owned by a later todo), and the executor reports them.
- No files other than src/model/mode.ts and test/mode.test.ts are modified.
