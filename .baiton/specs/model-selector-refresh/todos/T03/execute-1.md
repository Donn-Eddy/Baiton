# Execute T03

## Summary

T03 done. src/adapter/adapter.ts: added type-only module imports of ../orchestrator/modelCatalog and ../orchestrator/modelsDev (no barrels), and the discovery vocabulary — DEFAULT_DISCOVERY_TIMEOUT_MS (8000), DiscoveryContext (timeoutMs, signal?, cwd?, feed?, log?), AGENT_CATALOG_SOURCE (claude/codex/opencode, antigravity deliberately absent), extended AgentCapabilities with modelEntries/source/stale/staleReason/fetchedAt, pure capabilitiesFromEntries/options/unionEntryEfforts and capabilitiesToCatalogFetch helpers (conditional own-key assignment, no explicit undefined keys), and the optional Adapter.discoverModels?(ctx) seam after relayFiles? with the never-throw/honour-signal-timeout/no-secrets doc. src/adapter/index.ts: renamed the curated body to exported builtinAgentCapabilities(), added CLAUDE_DEFAULT_MODEL ('claude-sonnet-5'), and agentCapabilities(snapshots?) which overlays claude/codex/opencode snapshots via private overlayCapabilities (claude gets mergePreservingExisting [CLAUDE_DEFAULT_MODEL]; empty refreshed lists keep builtin models/efforts/modelLink with source 'builtin' and the snapshot's staleReason/fetchedAt; otherwise capabilitiesFromEntries with snapshot-level efforts winning, entry-efforts union next, builtin efforts last; modelLink preserved for opencode) while antigravity is never overlaid; both paths return fresh non-aliased objects/arrays. src/adapter/antigravity.ts: comments only — ANTIGRAVITY_MODELS doc block extension plus a no-discoverModels note next to acceptsSessionId, argv untouched. test/adapter.index.test.ts: kept all existing blocks, added the snap fixture and new describe blocks for the snapshot overlay (12 cases incl. no-metadata-keys guard, claude-sonnet-5-once, codex per-model/snapshot/efforts fallbacks, opencode free-text preservation, stale carry-through, empty-never-wipes, antigravity untouched, overlay freshness), AGENT_CATALOG_SOURCE, the discoverModels seam (antigravity undefined) and the capability helpers.

## Files changed

- `src/adapter/adapter.ts`
- `src/adapter/index.ts`
- `src/adapter/antigravity.ts`
- `test/adapter.index.test.ts`

## Commands run

- `npx tsc --noEmit -p tsconfig.json (exit 0)`
- `npm run compile (exit 0)`
- `npx eslint src/adapter/adapter.ts src/adapter/index.ts src/adapter/antigravity.ts test/adapter.index.test.ts --ext .ts (clean)`
- `npx mocha test/adapter.index.test.ts (mocharc runs the full suite: 1491 passing, 1 failing)`
- `npm run test:unit (1415 passing, 1 pending, 1 failing)`
- `git diff --stat (only the four allowed files)`

## Notes

- The single test failure is the pre-existing, baseline-documented 'packaging gating: includes zero native modules' keytar assertion in test/activation.gating.test.ts; no other failures.
- capabilitiesFromEntries sets modelEntries only when entries is non-empty, matching the plan's test expectation that capabilitiesFromEntries([]) deep-equals { models: [], efforts: [] } with no extra own keys; non-empty entries get a fresh [...entries] copy.
- In the empty-refreshed-list branch the overlay forces source to 'builtin' (not snapshot.source) while carrying the snapshot's stale/staleReason/fetchedAt, per plan step 3.4 — so an opencode snapshot with no models keeps source 'builtin' and the snapshot's stale metadata.
- src/orchestrator/modelCatalog.ts and src/orchestrator/modelsDev.ts import only ../model/result, so the new type-only imports in adapter.ts create no cycle; no file outside the four allowed was modified.
