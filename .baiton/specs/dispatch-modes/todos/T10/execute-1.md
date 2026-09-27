# Execute T10

## Summary

Added an optional trailing `mode: RunMode = DEFAULT_MODE` argument to both `phaseFor` and `buildSystemPrompt` in src/orchestrator/systemPrompt.ts. A workspace conversation in any spec-less mode now maps to the single `run` phase and gets a run-phase prompt assembled from new exported constants (RUN_ROLE_TEXT, RUN_SCOPE_TEXT, RUN_FLOW_TEXT as an exhaustive Record<SpeclessMode, string>, runFlowText(), MODE_PROPOSAL_TEXT) plus the unchanged REFUSAL_TEXT, ASK_USER_TEXT and STYLE_TEXT; it deliberately omits the todo grammar, frontmatter rules and spec-content block. A spec conversation ignores the mode entirely (the new branch is guarded on kind.kind === 'workspace'), and an absent mode or 'spec' reproduces today's prompt byte for byte. Added test/systemPrompt.mode.test.ts with 36 new cases across 8 suites; no existing source or test file was modified.

## Files changed

- `src/orchestrator/systemPrompt.ts`
- `test/systemPrompt.mode.test.ts`

## Commands run

- `npm run compile`
- `npm run lint`
- `npm test`

## Notes

- npm run compile: clean (tsc -p ./, no output).
- npm run lint: 1 problem, 0 errors, 1 warning — the pre-existing unused `_legacy` at src/orchestrator/webviewProtocol.ts:591, exactly as the plan predicted.
- npm test: 1931 passing, 1 pending, 0 failing. All 8 new 'mode-scoped system prompt' suites are present and green; every previously passing test still passes.
- The run-phase branch in buildSystemPrompt is guarded as `kind.kind === 'workspace' && mode !== 'spec'` rather than `isSpecless(mode)`: isSpecless returns plain boolean, so only the literal comparison narrows `mode` to SpeclessMode, which lets `runFlowText(mode)` be called with no `as` cast and no `any`. phaseFor still uses isSpecless(mode), where no narrowing is needed. Both functions remain total for every RunMode.
- In the test file, SPECLESS_MODES is built with a type-predicate filter (`(mode): mode is Exclude<RunMode, 'spec'> => mode !== 'spec'`) so RUN_FLOW_TEXT[mode] typechecks without an index-signature cast; the exhaustiveness loop over RUN_MODES uses `mode === 'spec'` to skip (and asserts !isSpecless('spec') there) for the same narrowing reason. isSpecless is still asserted directly in the phaseFor mapping loop, so a new RunMode is forced into the test.
- Verified against the source rather than the plan: controlTools.ts declares start_run with `mode` enum ['bug','quick','refactor'], `statement`, `files`, optional `reproduction`, and investigate with `question`, `files`; both carry phases: ['run']. The flow text names them exactly as declared.
- Did not touch src/activation/chatController.ts, src/orchestrator/guard.ts, controlTools.ts, registry.ts or src/model/mode.ts; the existing chatController call sites keep compiling because `mode` is trailing and defaulted.
