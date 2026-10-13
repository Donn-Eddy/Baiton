# Execute P05

## Summary

Submit PR now refuses pr and pr-partial plans when every recorded PR reads merged, while unknown merged state preserves the existing submission and partial-retry flows.

## Files changed

- `src/engine/submitPr.ts`
- `src/activation/commands.ts`
- `test/submitPr.test.ts`
- `test/submitPr.multiRepo.test.ts`

## Commands run

- `npm run compile`
- `npm run lint`
- `npx mocha --no-config --node-option no-strip-types --require ts-node/register test/submitPr.test.ts test/submitPr.multiRepo.test.ts`
- `npm test`
- `git diff --check`
- `git diff --stat`

## Notes

- Compile passed. Lint passed with the existing webviewProtocol.ts unused-variable warning.
- The initial focused-suite attempt was blocked by sandbox git EPERM; rerun with subprocess permission passed: 29 tests.
- The full suite passed: 2992 passing, 1 pending.
- git diff --check was clean; the diff contains only the four phase files.
