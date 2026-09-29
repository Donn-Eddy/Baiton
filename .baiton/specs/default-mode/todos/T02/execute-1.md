# Execute T02

## Summary

Refused mode 'default' in RunPipeline.start (invalid-mode, names draft_spec) and RunStore.create (invalid-id, same kind as spec refusal); parseRunManifest rejects manifest mode 'default' but still accepts composerMode 'default'. Comment-only edit in controlTools.ts. Added tests in runPipeline.test.ts and runStore.test.ts.

## Files changed

- `src/engine/runPipeline.ts`
- `src/engine/runStore.ts`
- `src/orchestrator/controlTools.ts`
- `test/runPipeline.test.ts`
- `test/runStore.test.ts`

## Commands run

- `npx tsc -p ./ --noEmit`
- `TS_NODE_TRANSPILE_ONLY=true npx mocha`

## Notes

- tsc: only the known TS2741 in systemPrompt.ts RUN_FLOW_TEXT.
- mocha: 2189 passing, 26 failing; failures are all in chatController/systemPrompt/webviewProtocol tests (pre-existing from T01, out of scope); no runPipeline/runStore failures.
