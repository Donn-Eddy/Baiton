# Execute T05

## Summary

Replaced spec drafting with plans-only phased plan drafting, and updated the schema, writer brief, activation wiring, and tests.

## Files changed

- `src/activation/commands.ts`
- `src/activation/engineFacade.ts`
- `src/engine/index.ts`
- `src/engine/roleInstructions.ts`
- `src/engine/runPipeline.ts`
- `src/engine/runStore.ts`
- `src/engine/specDraft.ts`
- `src/engine/planDraft.ts`
- `src/orchestrator/seams.ts`
- `src/orchestrator/specWriteTools.ts`
- `src/schema/schemas.ts`
- `src/schema/types.ts`
- `test/engine.briefWatcher.test.ts`
- `test/engine.specDraft.test.ts`
- `test/engine.planDraft.test.ts`
- `test/integration.sub-agent-chats.test.ts`
- `test/schema.examples.test.ts`
- `test/schema.roundtrip.property.test.ts`
- `.baiton/runs/phased-plan-T05-execute-1-1791654146618/result.json`

## Commands run

- `npm run compile`
- `npm run lint`
- `npm test (sandbox attempt, then elevated rerun)`
- `git diff --check`
- `rg acceptance checks for stale runner names and old plan-draft fields`

## Notes

- Compile succeeded. Lint reported 0 errors and one unused-variable warning in src/orchestrator/webviewProtocol.ts:678.
- Full test suite passed: 2861 passing, 1 pending. The sandbox attempt hit Git EPERM; the elevated rerun passed.
- Acceptance grep found no stale plan-draft runner API names; remaining renderSpec/specPath matches are local test helpers and unrelated orchestrator helpers.
