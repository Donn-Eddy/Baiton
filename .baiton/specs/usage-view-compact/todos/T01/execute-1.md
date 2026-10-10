# Execute T01

## Summary

Reflowed usage windows into a compact row with a pure windowRow helper, optional reset text, scope, and progress bar below.

## Files changed

- `media/usage.js`
- `media/usage.html`

## Commands run

- `npm run compile`
- `npm run lint`
- `npm test (sandboxed attempt)`
- `npm test (escalated rerun)`

## Notes

- Compile passed. Lint passed with one warning in src/orchestrator/webviewProtocol.ts:678.
- The sandboxed test attempt hit EPERM while spawning child processes; the escalated rerun passed with 2812 passing and 1 pending.
