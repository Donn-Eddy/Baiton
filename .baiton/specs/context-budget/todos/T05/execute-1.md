# Execute T05

## Summary

Added pure trimHistory (contextTrim.ts), the optional ContextBudget seam in runToolLoop, controller wiring (per-conversation ContextTracker, trim at contextTrimAt when window known), the contextTrimAt setting plus host seams in commands.ts, and unit, property and tool-loop seam tests. Compile, lint (no new warnings) and npm test pass (2399 passing, 1 pending).

## Files changed

- `src/orchestrator/contextTrim.ts`
- `src/orchestrator/toolLoop.ts`
- `src/activation/chatController.ts`
- `src/activation/commands.ts`
- `package.json`
- `test/contextTrim.test.ts`
- `test/contextTrim.property.test.ts`
- `test/toolLoop.test.ts`

## Commands run

- `npm run compile`
- `npm run lint`
- `npm test`

## Notes

- trimHistory skips results that already match the stub pattern; without this a 47-byte stub was re-stubbed to a different string (idempotence test caught it).
- Pass 1 matches auto-approved lines by exact content, so a manual card with identical prompt and decision text would also be dropped (accepted risk in the plan).
- loadHistory in chatController was removed as unused; onSend reads records once.
- Property (e) and (f) checks are somewhat loose (f accepts already-stubbed or non-shrinking results).
- Existing lint warning in webviewProtocol.ts (_legacy) is pre-existing.
