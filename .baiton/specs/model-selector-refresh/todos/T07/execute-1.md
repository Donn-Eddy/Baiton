# Execute T07

## Summary

Added the host-free ModelDiscoveryService (src/activation/modelDiscovery.ts): builtinCatalogFetches() derives the CatalogStore builtin seeds from builtinAgentCapabilities() via AGENT_CATALOG_SOURCE (claude/codex/opencode only, no antigravity, no models.dev); refresh() fans out to the models.dev feed plus every adapter with a discoverModels seam in parallel, each bounded by a per-source timeout (default DEFAULT_DISCOVERY_TIMEOUT_MS), maps every outcome (capabilities / undefined / rejection / synchronous throw / timeout) to a Result and feeds it to CatalogStore.applyResult, and never rejects. The feed is fetched exactly once per refresh and awaited by the claude job so it arrives as ctx.feed; feed() returns the last successfully parsed feed; the models.dev snapshot stores bare model ids with the provider half on ModelEntry.provider in feed order. An apply() generation guard drops every write from a superseded or disposed run; onDidChange fires the full table per applied source and tolerates a throwing listener; dispose() aborts the in-flight refresh and clears listeners. Exported from the activation barrel, added COMMANDS.refreshModels = 'baiton.refreshModels' plus its package.json contribution (no commandPalette entry, so it stays visible before the activation gate), and wired the CatalogStore + service into activate() ahead of the gate with getModelCatalogStore()/getModelDiscovery() accessors, the refresh command, teardown, a log-only onDidChange subscriber and a non-awaited `void discovery.refresh()`. New test/modelDiscovery.test.ts covers all fourteen listed cases (15 `it`s) and passes.

## Files changed

- `src/activation/modelDiscovery.ts`
- `src/activation/index.ts`
- `src/activation/commands.ts`
- `src/extension.ts`
- `package.json`
- `test/modelDiscovery.test.ts`

## Commands run

- `npx tsc --noEmit -p tsconfig.json`
- `npm run compile`
- `npx eslint src/activation/modelDiscovery.ts src/activation/index.ts src/activation/commands.ts src/extension.ts test/modelDiscovery.test.ts --ext .ts`
- `npx mocha test/modelDiscovery.test.ts`
- `npm run test:unit`
- `npm run test:property`
- `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))"`
- `git status --porcelain`

## Notes

- tsc --noEmit exits 0, npm run compile exits 0, eslint on the five touched TS files is clean, and package.json still parses.
- All 15 T07 tests pass. npm run test:unit reports 1521 passing / 1 failing and npm run test:property 1597 passing / 1 failing; the single failure in both is the pre-existing 'packaging gating: includes zero native modules' keytar assertion in test/activation.gating.test.ts (node_modules/keytar/*.node), untouched by this todo. Note the repo .mocharc.json widens every mocha invocation to the whole test/**/*.test.ts spec, so test:property also runs the unit suites.
- modelDiscovery.ts imports vscode not at all (not even `import type`): the whole host surface is injected, and a regex guard test over the module source pins that.
- Plan step 3 listed `isOk` among the imports; it is unused by the implementation (the feed Result is narrowed inline), so it was left out rather than imported dead — eslint would flag it.
- withTimeout takes no `label` argument: the per-source message wording is built at the call site where the agent id / source id is already in hand, which keeps the timeout string identical to the plan's text. The timer is unref()'d behind a guard and cleared in a finally, and the losing promise's rejection is always consumed, so the suite leaks no timer and no unhandled rejection.
- One case beyond the fourteen was added: a feed failure over a PREVIOUSLY CACHED models.dev snapshot marks it stale with the fetcher's reason and keeps its models. It is needed because models.dev has no builtin seed, so case 5's fresh-store shape legitimately records no snapshot at all (CatalogStore.applyResult returns undefined with no previous list) — the test asserts both shapes.
- Scope held: no file under src/adapter/, src/orchestrator/, src/config/ or media/ was modified; git status --porcelain shows exactly the six files this todo owns. antigravity behaviour is unchanged (it has no AGENT_CATALOG_SOURCE entry, so it is neither seeded nor refreshed nor marked stale).
