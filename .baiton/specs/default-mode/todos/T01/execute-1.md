# Execute T01

## Summary

Added 'default' (listed first) to RunMode/RUN_MODES, set DEFAULT_MODE to 'default', kept isSpecless as `mode !== 'spec'` and documented that default is spec-less, and updated the file/DEFAULT_MODE/isSpecless comments. Updated test/mode.test.ts pins: DEFAULT_MODE, default-first RUN_MODES, isRunMode('default') true and 'Default' false, isSpecless('default') true. src/model/index.ts already re-exports ./mode, so it was not edited.

## Files changed

- `src/model/mode.ts`
- `test/mode.test.ts`

## Commands run

- `npx mocha test/mode.test.ts`
- `TS_NODE_TRANSPILE_ONLY=true npx mocha test/mode.test.ts`
- `npx tsc -p ./ --noEmit`
- `TS_NODE_TRANSPILE_ONLY=true npx mocha`
- `git status --short`

## Notes

- Plain `npx mocha test/mode.test.ts` fails to load: the import graph reaches src/orchestrator/systemPrompt.ts, and `tsc` reports TS2741 there because RUN_FLOW_TEXT (line 225) lacks a 'default' key. This is the expected cross-todo gap; systemPrompt.ts was not edited. It is the only tsc error.
- .mocharc runs the whole suite, so the mode.test.ts invocations also ran every other spec. With TS_NODE_TRANSPILE_ONLY=true, all 'RunMode' tests in test/mode.test.ts pass.
- The full suite under transpile-only has at least 13 failures (numbered 1-13 in the truncated output) in chatController, webviewProtocol reducer/mirror parity and systemPrompt tests. They pin DEFAULT_MODE-derived values that later todos will update. I did not baseline them against main and did not fix them.
- isRunMode('default') is now true, so runPipeline/runStore could create a 'default' run until a later todo adds the refusal. No refusal logic was added here.
