# Execute T02

## Summary

Moved usage detail text into status badge hints while retaining sourceLine as an alias, and added keyboard focus styling for hinted badges.

## Files changed

- `media/usage.js`
- `media/usage.html`

## Commands run

- `npm run compile`
- `npm run lint`
- `npm test (sandboxed; failed on EPERM child-process restrictions)`
- `npm test (elevated retry)`

## Notes

- Compile passed.
- Lint passed with one pre-existing unused-variable warning in src/orchestrator/webviewProtocol.ts:678.
- Elevated test run passed: 2812 passing, 1 pending.
- Confirmed media/usage.js contains no source-line string; stale/unavailable reason lines and Baiton-derived markers remain visible.
