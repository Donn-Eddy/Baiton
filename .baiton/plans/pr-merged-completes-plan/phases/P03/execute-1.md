# Execute P03

## Summary

Threaded the derived prsMerged fact through plan grouping and actions, with merged PR plans grouped as completed and offering Show PR only. Added property and example coverage.

## Files changed

- `src/model/planActions.ts`
- `src/model/treeModel.ts`
- `test/planActions.property.test.ts`
- `test/treeModel.property.test.ts`

## Commands run

- `npx tsc --noEmit -p . (passed)`
- `npx mocha --require ts-node/register test/treeModel.property.test.ts test/planActions.property.test.ts (repository Mocha config expanded this to the full suite; interrupted)`
- `npx mocha --no-config --require ts-node/register test/treeModel.property.test.ts test/planActions.property.test.ts (15 passing)`
- `git diff --check (passed)`

## Notes

- The initial Mocha invocation pulled in the full suite through repository configuration; the requested property test files passed when run directly with --no-config.
