# Execute T04

## Summary

T04 implemented: Claude model discovery from the models.dev anthropic provider. src/adapter/claude.ts now exports ANTHROPIC_PROVIDER_ID, CLAUDE_MODEL_ID_PREFIX, CLAUDE_REQUIRED_MODEL (= CLAUDE_MODELS[0], distinct name to avoid the index.ts CLAUDE_DEFAULT_MODEL clash), the pure claudeModelsFromFeed feed→entries helper (anthropic-only, claude-* prefix, first-occurrence dedupe, conditional label/provider keys), the ClaudeFeedFetcher/ClaudeAdapterOptions injectable fetcher seam (default fetchModelsDev, the only network path; constructor stays additive-optional), and ClaudeAdapter.discoverModels — wrapped so it never rejects, honours ctx.signal (pre-aborted => undefined with zero fetch calls, mid-flight abort via a listener-cleanup raceAbort), clamps timeoutMs to min(ctx, DEFAULT_DISCOVERY_TIMEOUT_MS), uses ctx.feed with zero network calls, logs fetch errors via ctx.log, returns undefined for failed/empty extraction (curated list kept), guarantees claude-sonnet-5 present exactly once at the end without a custom flag, and returns exactly models/efforts/modelEntries (no source/stale/staleReason/fetchedAt/modelLink; capabilitiesToCatalogFetch round-trips to {models, efforts: ['low','medium','high']}). No secrets read anywhere on the path; launch/attach argv unchanged. Test file adds two suites covering the pure helper against test/fixtures/modelsDev.sample.json (order, labels, provider filtering, array-shaped duplicate ids, case/whitespace tolerance, blank ids) and discoverModels success/fallback/timeout-clamp/error/throw/abort/registry-wiring paths, all injecting fetchFeed or ctx.feed so no test touches the network.

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

- npx mocha test/adapter.claude.test.ts runs the full mocha spec per the project mocha config (1509 passing, 1 pending): only failure is the pre-existing baseline one, 'packaging gating: includes zero native modules' (keytar in node_modules, test/activation.gating.test.ts) — unrelated and baseline-documented.
- npm run test:unit: 1433 passing, 1 pending, 1 failing — the same pre-existing keytar gating failure.
- npx tsc --noEmit, npx eslint (on both changed files) and npm run compile are clean.
- git status shows exactly the two allowed files modified.
- test/adapter.index.test.ts's 'no adapter implements discoverModels yet' title (part of T03's files) becomes stale in wording only; its boolean assertion still passes and it was left untouched.
