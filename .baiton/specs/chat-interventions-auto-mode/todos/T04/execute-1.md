# Execute T04

## Summary

Mirrored the T02 reducer changes in media/protocol.js (autoMode in initialWebviewState; showIntervention, resolveIntervention and setAutoMode cases between updateTool and setConversations, translated to the file's ES5 Object.assign style) and added the shared parity harness: test/fixtures/protocolCases.ts (35 named cases covering every HostToWebview variant plus the intervention edge cases: in-place replacement by id, trailing-streaming finalize, first-pending settlement, unknown-id/already-resolved no-ops with sameReference, all four InterventionAnswer variants with and without rationale/auto, and an interleaved multi-message sequence) and test/webviewProtocol.mirror.test.ts (vm.runInNewContext loader, seed parity, full-state deepStrictEqual parity over independent per-side clones, sameReference identity assertions for both reducers, and a purity test). test/configPanel.mirror.test.ts was not touched.

## Files changed

- `media/protocol.js`
- `test/fixtures/protocolCases.ts`
- `test/webviewProtocol.mirror.test.ts`

## Commands run

- `npm run compile`
- `npm run lint`
- `npm test`

## Notes

- The first full run failed every assertion comparing mirror results because objects created inside the vm sandbox have a different Object.prototype realm, so deepStrictEqual reports 'same structure but not reference-equal' even for identical shapes. Fixed with a hardClone helper in the mirror test that rebuilds mirror output in the host realm; Array.from (not value.map) is used so nested arrays are also host-realm, and own keys with undefined values (empty: undefined, rationale/auto on settle) are preserved — JSON round-tripping was deliberately avoided because it would erase exactly the present-with-undefined distinction the parity contract pins.
- media/protocol.js updates its cases with the same !==-undefined style as the TS predicate; the existing updateTool `!record.tool` truthiness was left as-is (behaviourally equivalent) per plan scope.
- npm run compile, npm run lint and npm test all pass: 912 passing, 1 pending, 0 failing. src/orchestrator/webviewProtocol.ts, src/orchestrator/chatTranscript.ts and media/chat.js were not modified.
