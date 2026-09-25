# Review T04

Verdict: **findings**

## Findings

- **must** `src/adapter/claude.ts`:297 — The fetch call is evaluated before raceAbort installs its abort listener. If an injected fetcher synchronously aborts ctx.signal and returns a never-settling promise, raceAbort adds a listener to an already-aborted signal (whose abort event will not fire) and discoverModels never resolves. Re-check signal.aborted at the start of raceAbort (and resolve undefined) so every mid-flight abort satisfies the never-hang contract.

## Tests

- ran: true
- passed: true

```
npx tsc --noEmit -p tsconfig.json and ESLint completed cleanly. Focused npx mocha test/adapter.claude.test.ts --grep 'ClaudeAdapter\.discoverModels': 10 passing (9ms).
```
