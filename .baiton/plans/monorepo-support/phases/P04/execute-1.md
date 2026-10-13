# Execute P04

## Summary

Added repo-scoped stage locks and owner-keyed phase queues, wired both runners and command seams, and added coverage for lock independence, queue scoping, and owner journals.

## Files changed

- `src/engine/runQueue.ts`
- `src/engine/planDraft.ts`
- `src/engine/runPipeline.ts`
- `src/activation/engineFacade.ts`
- `src/activation/commands.ts`
- `test/engineFacade.resume.test.ts`

## Commands run

- `npm run compile`
- `npm run lint`
- `env NODE_OPTIONS=--no-strip-types npx mocha --no-config --require ts-node/register --extension ts test/engineFacade*.test.ts test/engine.planDraft.test.ts test/runPipeline.test.ts test/engine.runQueue*.test.ts test/runCommands.test.ts test/integration.run-modes.test.ts test/integration.sub-agent-chats.test.ts test/integration.plan-execute-review.test.ts test/registry.controlTools.test.ts`
- `npm test -- --reporter dot`
- `git diff --check`

## Notes

- Compile passed. Lint passed with one existing unused-variable warning in src/orchestrator/webviewProtocol.ts:678.
- Focused suites passed: 158 passing. Full suite passed: 2930 passing, 1 pending.
- The focused command needed NODE_OPTIONS=--no-strip-types with Node 24; its git-backed tests also required running outside the sandbox. git diff --check was clean.
