# Execute T03

## Summary

T03: persisted intervention records. Added `interventionTranscriptRecord`/`settledInterventionView` helpers to chatTranscript.ts (InterventionAnswer imported as a type only; module doc updated). transcriptReader.ts now validates a record's `intervention` field with a structural `isInterventionView` guard (malformed cards skip the line) and passes intervention records through `dropOrphanToolRecords` without resetting the open call window, so assistant(c1) → system(card) → tool(c1) survives reload. toRenderRecords is now idempotent by card id: the row renders at the first occurrence's position carrying the last recorded card state, and cards are copied, not aliased. New test blocks in transcriptReader.test.ts (round trip of all three kinds, malformed-card skipping, pair-awareness regression + inverse) and webviewProtocol.reducer.test.ts (collapse, distinct ids, tool-after-card projection, purity).

## Files changed

- `src/orchestrator/chatTranscript.ts`
- `src/orchestrator/transcriptReader.ts`
- `src/orchestrator/webviewProtocol.ts`
- `test/transcriptReader.test.ts`
- `test/webviewProtocol.reducer.test.ts`

## Commands run

- `npm run compile`
- `npm run lint`
- `npm test`

## Notes

- Full suite: 874 passing / 1 pending, up from the post-T02 863/1 baseline with the 11 new cases; compile and lint clean.
- toChatMessage in src/activation/chatController.ts maps a persisted system record to an assistant message, so a card's prompt text re-enters the model history as assistant text on reload — pre-existing for system records and outside this todo's scope; flag it for the controller todo.
- media/protocol.js remains untouched as per plan; TS/JS reducer parity is deferred to the later mirror-test todo.
- interventionTranscriptRecord/settledInterventionView are reachable via the existing `export *` barrel in src/orchestrator/index.ts with no name collisions; interventionTranscriptRecord is documented as the append-once-when-settled write policy for the controller todo.
