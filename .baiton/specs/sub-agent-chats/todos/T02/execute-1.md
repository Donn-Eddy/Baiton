# Execute T02

## Summary

Added the per-slug serialized spec-branch writer, exported it from the engine barrel, routed SpecStore.writeState (path-scoped commitPaths) and a new optional persistArtifact through it, and made the run queue persist validated artifacts via the store when available. Added writer and store tests against real temp repos.

## Files changed

- `src/engine/specBranchWriter.ts`
- `src/engine/index.ts`
- `src/engine/runQueue.ts`
- `src/activation/specStore.ts`
- `test/specBranchWriter.test.ts`
- `test/specStore.test.ts`

## Commands run

- `npm run compile`
- `npm run lint`
- `npm test`

## Notes

- Compile passes; lint has only the known webviewProtocol.ts warning; full test suite passes.
- Step 8 (queue regression case with a persistArtifact fake) was skipped; existing queue tests pass unchanged via the direct-fs fallback.
- commands.ts unchanged.
- Other spec.md writers (orchestrator tools, approve, recovery, submitPr) still use git.commit outside the lock.
