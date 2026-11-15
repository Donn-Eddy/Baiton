# Execute P03

## Summary

PR records now commit only when changed and are pushed afterward, so owner PR branches carry the pr/pr-partial record. Added retry, failure, grouped, and child-only coverage plus remote assertions.

## Files changed

- `src/engine/submitPr.ts`
- `test/transitions.prStatus.test.ts`
- `test/submitPr.test.ts`
- `test/submitPr.multiRepo.test.ts`

## Commands run

- `npx mocha --no-config --require ts-node/register --node-option no-strip-types --timeout 60000 test/transitions.prStatus.test.ts (pre-fix: 6 failing, including owner/grouped/partial remote-record reproductions)`
- `npx mocha --no-config --require ts-node/register --node-option no-strip-types --timeout 60000 test/transitions.prStatus.test.ts (post-fix: 14 passing)`
- `npx tsc --noEmit -p . (passed)`
- `npm run lint (passed)`
- `npx mocha --no-config --require ts-node/register --node-option no-strip-types --timeout 60000 test/transitions.prStatus.test.ts test/submitPr.test.ts test/submitPr.multiRepo.test.ts test/journal*.test.ts`
- `git diff --check (passed)`

## Notes

- The focused real-git suite could not run in the sandbox because spawning git returned EPERM. An elevated retry awaited approval and was stopped without a result.
- Lint has one existing warning in src/orchestrator/webviewProtocol.ts; the changed files report no lint warnings.
