# Execute T02

## Summary

Implemented T02: intervention card protocol in the pure webview reducer. Added InterventionView (type-only import from ./interventions, no runtime coupling, no barrel collisions), new HostToWebview messages showIntervention/resolveIntervention/setAutoMode and WebviewToHost messages answerIntervention/setAutoMode, required autoMode: boolean on WebviewState seeded false, three new reduce cases (in-place card replacement by id, first-pending-card settlement with same-reference no-op on miss/already-settled, setAutoMode toggle), intervention field on RenderRecord/ConversationRecord and TranscriptRecord (chatTranscript), toRenderRecords now carries a card through only when present, interventionRecord/interventionUpdate helpers, and a new 'interventions' reducer describe block plus a toRenderRecords projection case and extended the no-mutation test. npm run compile, npm run lint and npm test all pass (863 passing, 1 pending).

## Files changed

- `src/orchestrator/webviewProtocol.ts`
- `src/orchestrator/chatTranscript.ts`
- `test/webviewProtocol.reducer.test.ts`

## Commands run

- `npm run compile`
- `npm run lint`
- `npm test`

## Notes

- Kept the interventions import as `import type` and named the new interface InterventionView so the src/orchestrator/index.ts barrel's `export *` over both modules has no duplicate exports.
- toRenderRecords only attaches the `intervention` key when a card exists, so all pre-existing deepStrictEqual assertions on projected records still pass.
- resolveIntervention returns the identical state reference when no pending card matches the id, mirroring updateTool's no-op contract.
- media/protocol.js and the controller were deliberately left untouched per the brief; the webview ignores the three new message types until later todos land.
- During test editing an accidental describe rename was made and immediately reverted; final file verified by compile/lint/test.
