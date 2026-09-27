# Execute T11

## Summary

Extended the webview protocol with conversation mode and run-activity state. src/orchestrator/webviewProtocol.ts now imports { DEFAULT_MODE, type RunMode } from ../model/mode (no re-export), declares HostToWebview members { type: 'setMode'; mode: RunMode } and { type: 'setRunActive'; active: boolean }, a WebviewToHost member { type: 'setMode'; mode: RunMode }, required WebviewState fields mode: RunMode and runActive: boolean right after autoMode, seeds them as DEFAULT_MODE/false in initialWebviewState(), handles both messages in reduce (no isRunMode guard, so the mirror can fold identically) and documents them in the reduce doc comment. media/protocol.js mirrors the seed (mode: 'spec' with a comment noting it tracks DEFAULT_MODE by hand, runActive: false, same object position) and both reduce cases. test/fixtures/protocolCases.ts imports RUN_MODES, adds the two fields to the seed() literal, and appends cases (52)-(58): one per mode, mode replacement, a mode fold over a rich state, setRunActive both ways, a mode-preserving setRunActive, a setMode/setRunActive sequence, and an interleave with setBusy/setAutoMode. test/webviewProtocol.reducer.test.ts gains a 'conversation mode and run activity' describe (seed defaults, every-mode setMode, mode replacement, non-interference with the rest of the state, setRunActive both ways, mutual independence of the two fields, purity, and a typed WebviewToHost setMode literal) and adds both new messages to the existing every-message purity sweep.

## Files changed

- `src/orchestrator/webviewProtocol.ts`
- `media/protocol.js`
- `test/fixtures/protocolCases.ts`
- `test/webviewProtocol.reducer.test.ts`

## Commands run

- `npm run compile`
- `npm run lint`
- `npm test`

## Notes

- npm run compile: clean, zero TypeScript errors.
- npm run lint: 0 errors, 1 warning — the pre-existing '_legacy' is assigned a value but never used, now reported at src/orchestrator/webviewProtocol.ts:622 (it shifted from line 591 because of the added union members and fields). Left alone as instructed.
- npm test: 1951 passing, 1 pending, 0 failing. All additive; no existing assertion weakened or removed. The only edits to pre-existing tests are the two added reduce(...) lines in 'does not mutate the input state on any message' and the two fields added to the seed() helper literal, both as the plan specified.
- test/webviewProtocol.mirror.test.ts was not modified: 'mirrors the initial seed state exactly' and all 58 fixture cases pass over both reducers, so the three hand-maintained seeds (TS core, media/protocol.js, fixture literal) are in sync.
- The new reducer describe block is at the end of the file, after the interventions describe (which is the file's last block), as the plan required. It declares its own local rec helper and groups fixture because the originals are scoped inside earlier describes.
- No compile fallout elsewhere: no WebviewState literal outside the seeds needed the new fields, and ChatController.handle switches over WebviewToHost with no exhaustiveness guard, so the new setMode variant is declared but intentionally unwired here (T12's job).
