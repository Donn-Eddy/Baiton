# Execute T03

## Summary

Added optional contextWindow/maxOutput to ModelEntry (normalized as positive integers, round-tripped via the memento without a version bump), a feedModelLimitFields helper carried onto models.dev discovery entries and claudeModelsFromFeed, the host-free contextBudget.ts with resolveContextWindow, and the baiton.orchestrator.contextWindow setting, with tests. compile, lint and npm test all pass (2357 passing, 1 pending).

## Files changed

- `src/orchestrator/modelCatalog.ts`
- `src/orchestrator/modelsDev.ts`
- `src/activation/modelDiscovery.ts`
- `src/adapter/claude.ts`
- `src/orchestrator/contextBudget.ts`
- `package.json`
- `test/modelCatalog.test.ts`
- `test/modelsDev.test.ts`
- `test/modelDiscovery.test.ts`
- `test/adapter.claude.test.ts`
- `test/contextBudget.test.ts`

## Commands run

- `npm run compile`
- `npm run lint`
- `npm test`

## Notes

- MODEL_CATALOG_PERSIST_VERSION left at 1; old blobs still hydrate.
- No existing test expectations needed updating.
- test/adapter.claude.test.ts is outside the todo's listed files; it was touched additively, as the plan allowed, for the claudeModelsFromFeed limits test.
