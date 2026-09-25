# Execute T04

## Summary

T04 retry: fixed the single review finding. ClaudeAdapter.raceAbort in src/adapter/claude.ts now checks signal.aborted on entry before installing a listener: when the signal has already completed (an injected fetchFeed can abort the ctx controller synchronously and return a never-settling promise), no listener is installed (none would ever fire) and the call resolves undefined immediately, with the losing promise consumed via .catch so its rejection can never be unhandled. Doc comment updated. Added a regression test 'a fetcher that aborts the ctx signal synchronously and never settles resolves undefined promptly' to the discoverModels suite, alongside the previous T04 implementation (constants, claudeModelsFromFeed, fetcher seam, discoverModels contract, helper tests) which carries over unchanged. tsc --noEmit, eslint on both files, npm run compile clean; suites pass except the baseline-documented keytar packaging-gating failure.

## Files changed

- `src/adapter/claude.ts`
- `test/adapter.claude.test.ts`

## Commands run

- `npx tsc --noEmit -p tsconfig.json`
- `npx eslint src/adapter/claude.ts test/adapter.claude.test.ts --ext .ts`
- `npx mocha test/adapter.claude.test.ts`
- `npm run compile`
- `npm run test:unit`
- `git status --porcelain`

## Notes

- npx mocha test/adapter.claude.test.ts runs the full project mocha spec: only the pre-existing 'packaging gating: includes zero native modules' keytar failure remains; the new synchronously-aborted-fetch regression test passes.
- npm run test:unit: 1434 passing (one more than before), 1 pending, 1 failing — the same baseline keytar failure.
- git status shows exactly src/adapter/claude.ts and test/adapter.claude.test.ts modified.
