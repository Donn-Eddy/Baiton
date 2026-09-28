# Execute T04

## Summary

Implemented T04: antigravity model and effort discovery. Added the pure, total `antigravityModelsFromCliOutput` parser (ANSI/bullet cleaning, first-tab id/label split, family grouping from `low|medium|high|max` id suffixes with the trailing `(Level)` stripped from the family label, fixed ids with `efforts: []`, first-mention order, no defaultEffort/provider/custom), the `agy models` discovery constants (ANTIGRAVITY_MODELS_SUBCOMMAND, ANTIGRAVITY_MODELS_ARGS, ANTIGRAVITY_EFFORT_VOCABULARY), an injectable `AntigravityModelsCli` seam with `defaultRunAntigravityModelsCli` that never inspects the exit code and ignores stderr, and `AntigravityAdapter.discoverModels` with claude's raceAbort/raceTimeout helpers (never rejects, resolves undefined rather than the curated table). Registered `antigravity` as a CatalogSourceId and in AGENT_CATALOG_SOURCE, gave the curated antigravity builtin `modelEntries`, checked in the `agy models` fixture, added parser and discoverModels suites, and inverted every test and doc comment that pinned "antigravity is never overlaid". README's discovery, CLI-capabilities and privacy bullets now describe `agy models` as the antigravity source.

## Files changed

- `src/adapter/antigravity.ts`
- `src/adapter/adapter.ts`
- `src/adapter/index.ts`
- `src/orchestrator/modelCatalog.ts`
- `src/activation/modelDiscovery.ts`
- `test/fixtures/agyModels.sample.txt`
- `test/adapter.antigravity.test.ts`
- `test/adapter.index.test.ts`
- `test/adapter.claude.test.ts`
- `test/adapter.codex.test.ts`
- `test/modelCatalog.test.ts`
- `test/modelDiscovery.test.ts`
- `test/modelSelectorRefresh.test.ts`
- `README.md`

## Commands run

- `npm run compile`
- `npm run lint`
- `npm run test:unit`
- `npx mocha --require ts-node/register test/adapter.antigravity.test.ts --grep adversarial`
- `grep -rn "new AntigravityAdapter(" test | grep -v runModelsCli`

## Notes

- Verification: `npm run compile` clean; `npm run lint` has 0 errors and only the pre-existing `_legacy` unused-var warning in src/orchestrator/webviewProtocol.ts (untouched by this todo); `npm run test:unit` is 2075 passing, 0 failing, 1 pending.
- Two test files outside the todo's declared list also pinned `antigravity.discoverModels === undefined` and broke as soon as the seam existed: test/adapter.claude.test.ts:1240 and test/adapter.codex.test.ts:1729. Both edits are assertion-only (the antigravity absence assertion dropped, the per-adapter assertion kept) — no production behaviour added for them. Step 8's test/modelSelectorRefresh.test.ts and step 7.3's test/modelCatalog.test.ts were edited as the plan anticipated.
- Plan step 6 expected a bare `-low` line to parse as the id `-low`; it cannot. `cleanAgyLine`'s leading bullet/marker strip (`/^[\s>*\u2022-]+/`, copied verbatim from the opencode parser as the plan required) removes the leading dash, so the line yields the unsuffixed id `low`. The test asserts that actual behaviour with a comment, and adds a second case (`x\t-low` plus a real two-level family) that exercises the zero-length-stem guard directly. No code change was needed for the guard, which is present and covered.
- No test spawns the real `agy` for discovery: every `discoverModels` test injects `runModelsCli`, and the modelSelectorRefresh end-to-end registry stubs it with `async () => undefined`. The remaining bare `new AntigravityAdapter()` constructions in test/ are launch/attach/probe/relay tests that never call `discoverModels`.
- Flagged, not fixed (as the plan's risk section states): `optionalStringArray` in src/orchestrator/modelCatalog.ts drops an empty array, so a fixed antigravity id's `efforts: []` marker does not survive the memento round-trip — a `cached` snapshot's fixed ids come back with no `efforts` key, while live and builtin snapshots keep the marker. Out of scope for this todo.
- Antigravity is now a discovery source, so each refresh spawns one extra short-lived `agy models` child process inside the shared per-source timebox (never awaited by activation, no credential).
- `antigravityModelFlags`, `launch()`, `attach()`, `relayFiles()` and every relay constant are unchanged; `overlayCapabilities` needed no code change (an antigravity snapshot with entries takes the existing `hasEntryEfforts` branch, an empty one the curated-keeping branch).
