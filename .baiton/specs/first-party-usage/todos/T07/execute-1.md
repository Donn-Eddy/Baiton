# Execute T07

## Summary

Added createUsageReaders and the composition seam types to src/usage/index.ts (host-free, lazy, trust-gated), and test/usage.credentials.test.ts covering sentinel redaction across ok/401/reject/odd-shape/sync-throw/stale paths, Restricted Mode, table shape, resolution and host-free import checks.

## Files changed

- `src/usage/index.ts`
- `test/usage.credentials.test.ts`

## Commands run

- `npx tsc --noEmit -p .`
- `npx mocha`
- `npm run compile`
- `npm run lint`

## Notes

- Full suite passes; compile clean; lint shows only the pre-existing webviewProtocol.ts warning.
- No reader leaks were found.
- Unavailable readings expose mechanism at top level, ok/stale under source; the test uses a helper for that.
- Antigravity has no credential route; it is checked only for no credential/fetch calls and CLI-error redaction.
