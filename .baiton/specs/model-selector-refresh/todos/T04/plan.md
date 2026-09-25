# Plan T04

## Steps

1. Add the discovery imports and constants to src/adapter/claude.ts

   At the top of src/adapter/claude.ts, next to the existing `import type { Adapter, LaunchRequest, LaunchSpec, ProbeResult } from './adapter';`, add `DEFAULT_DISCOVERY_TIMEOUT_MS` as a VALUE import and `AgentCapabilities`, `DiscoveryContext` as TYPE imports from './adapter', plus `capabilitiesFromEntries` (value) from './adapter'. Add `import { fetchModelsDev } from '../orchestrator/modelsDev';` and `import type { ModelsDevFeed } from '../orchestrator/modelsDev';`, `import type { ModelEntry } from '../orchestrator/modelCatalog';`, and `import { isOk } from '../model/result'; import type { Result } from '../model/result';`. (No import from './index' — that would be a cycle; everything needed lives in ./adapter, ../orchestrator/modelsDev, ../orchestrator/modelCatalog and ../model/result.)

   Below the existing `CLAUDE_EFFORTS` declaration add three exported constants with doc comments:
   - `export const ANTHROPIC_PROVIDER_ID = 'anthropic';` — the models.dev provider id the Claude CLI's models come from.
   - `export const CLAUDE_MODEL_ID_PREFIX = 'claude-';` — only ids with this prefix are Claude CLI `--model` values.
   - `export const CLAUDE_REQUIRED_MODEL: string = CLAUDE_MODELS[0];` — the `defaultConfig()` default (`claude-sonnet-5`) that must stay selectable; document that src/adapter/index.ts keeps its own private `CLAUDE_DEFAULT_MODEL` copy for the snapshot overlay and that the two must move together. Do NOT name this constant `CLAUDE_DEFAULT_MODEL` and do NOT edit src/adapter/index.ts: index.ts declares a module-private `CLAUDE_DEFAULT_MODEL` while re-exporting `export * from './claude'`, and this todo's allowed files are src/adapter/claude.ts and test/adapter.claude.test.ts only.

   Files: `src/adapter/claude.ts`

2. Add the pure feed→entries helper `claudeModelsFromFeed`

   In src/adapter/claude.ts add an exported pure function:

   ```ts
   export function claudeModelsFromFeed(feed: ModelsDevFeed): readonly ModelEntry[]
   ```

   Behaviour (pure, total, never throws, never mutates the input):
   1. Find the provider whose `id.trim().toLowerCase() === ANTHROPIC_PROVIDER_ID` (case/whitespace-tolerant); return `[]` when absent. Models of every other provider are ignored even when their ids look like Claude ids (the real feed's `opencode` provider re-lists Anthropic models under `anthropic/claude-*` — those must NOT appear).
   2. Iterate `provider.models` in feed order; keep a model when `model.id.trim().startsWith(CLAUDE_MODEL_ID_PREFIX)`; skip blank ids and ids already emitted (first occurrence wins, so a duplicated array-shaped feed cannot produce duplicate options).
   3. Map each kept model to a `ModelEntry` built the conditional-own-key way used by `normalizeModelEntry` in src/orchestrator/modelCatalog.ts: always `{ id: trimmedId, provider: ANTHROPIC_PROVIDER_ID }`; add `label: model.name` only when `model.name` is a non-empty string different from the id. Do NOT set per-model `efforts`/`defaultEffort` (Claude's levels are capability-level `low|medium|high`) and do NOT set `custom`.
   4. Return the entries in feed order.

   Against test/fixtures/modelsDev.sample.json this yields, in order: `claude-opus-5-5` (label 'Claude Opus 5.5'), `claude-sonnet-5` ('Claude Sonnet 5'), `claude-haiku-4-5` ('Claude Haiku 4.5').

   Files: `src/adapter/claude.ts`

3. Add the injectable feed fetcher seam to ClaudeAdapter's constructor

   In src/adapter/claude.ts declare the injection types above the class:

   ```ts
   export type ClaudeFeedFetcher = (options: { timeoutMs: number }) => Promise<Result<ModelsDevFeed, string>>;
   export interface ClaudeAdapterOptions { readonly fetchFeed?: ClaudeFeedFetcher; }
   ```

   Widen the constructor to `constructor(private readonly mode: PermissionMode = DEFAULT_PERMISSION_MODE, options: ClaudeAdapterOptions = {})` and store `private readonly fetchFeed: ClaudeFeedFetcher = options.fetchFeed ?? ((o) => fetchModelsDev({ timeoutMs: o.timeoutMs }))` (assign in the constructor body, since it depends on `options`). Both parameters stay optional, so `createAdapterRegistry()`'s `new ClaudeAdapter(mode)` in src/adapter/index.ts and every existing `new ClaudeAdapter(...)` in the tests compile unchanged. Document that the default fetcher is the only network path and that tests inject a fake instead of touching the network.

   Files: `src/adapter/claude.ts`

4. Implement ClaudeAdapter.discoverModels

   Add to `ClaudeAdapter` (after `attach()`, before the private `runVersion()`):

   ```ts
   async discoverModels(ctx: DiscoveryContext): Promise<AgentCapabilities | undefined>
   ```

   Contract, matching the `Adapter.discoverModels` doc in src/adapter/adapter.ts:
   1. Wrap the WHOLE body in `try { … } catch { return undefined; }` so it can never reject; log through `ctx.log?.(…)` only (no console).
   2. If `ctx.signal?.aborted === true`, return `undefined` immediately WITHOUT calling `this.fetchFeed`.
   3. Budget: `const timeoutMs = Math.min(ctx.timeoutMs > 0 ? ctx.timeoutMs : DEFAULT_DISCOVERY_TIMEOUT_MS, DEFAULT_DISCOVERY_TIMEOUT_MS);` — honour a narrower `ctx.timeoutMs`, never exceed the module ceiling.
   4. Feed acquisition: when `ctx.feed !== undefined` use it and make NO network call. Otherwise call `this.fetchFeed({ timeoutMs })` and race it against abort with a private helper `raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T | undefined>` that resolves `undefined` on the signal's `abort` event and ALWAYS removes its listener in a `finally` (no leaked listeners, no unhandled rejection: attach a `.catch(() => undefined)` on the raced promise or let the outer try/catch handle it). A raced-out or `undefined` result, or an `isOk(result) === false` result, returns `undefined` (the consumer keeps the curated `CLAUDE_MODELS`); log the `result.error` string via `ctx.log` in the failure case.
   5. After the await, re-check `ctx.signal?.aborted` and return `undefined` when aborted.
   6. `const entries = claudeModelsFromFeed(feed);` — when `entries.length === 0` (no anthropic provider, or it lists no `claude-*` id) return `undefined`; returning the curated list here would falsely mark it refreshed.
   7. Guarantee the default: when no entry's `id` equals `CLAUDE_REQUIRED_MODEL`, append `{ id: CLAUDE_REQUIRED_MODEL }` at the END of the entries (no `custom` flag — it is curated, not user config). This mirrors the `mergePreservingExisting(snapshot, [CLAUDE_DEFAULT_MODEL])` step `agentCapabilities()` already applies, so the invariant holds even for a caller that consumes `discoverModels` directly.
   8. Return `capabilitiesFromEntries(entries, { efforts: [...CLAUDE_EFFORTS] })`. Deliberately pass NO `source`/`stale`/`staleReason`/`fetchedAt`/`modelLink`: the `CatalogStore` owns snapshot provenance (`applyResult` stamps `source`/`fetchedAt`), and claude has no `modelLink`. The result therefore has exactly `models`, `efforts`, `modelEntries` as own keys, so `capabilitiesToCatalogFetch` round-trips it into `{ models: entries, efforts: ['low','medium','high'] }`.

   No secret, env var or credential is read anywhere in this path; only ids and labels leave the helper.

   Files: `src/adapter/claude.ts`

5. Test the pure helper against the checked-in fixture

   In test/adapter.claude.test.ts add a block `describe('claudeModelsFromFeed (model-selector-refresh T04)', …)`. Load the fixture the way test/modelsDev.test.ts does: `const fixtureText = fs.readFileSync(path.join(__dirname, 'fixtures', 'modelsDev.sample.json'), 'utf8');` at module scope (the file already imports `fs` and `path`), and build the feed with `parseModelsDevFeed(JSON.parse(fixtureText))` from '../src/orchestrator/modelsDev', asserting `result.ok` before use (or via `isOk`). Import `claudeModelsFromFeed`, `CLAUDE_MODELS`, `CLAUDE_EFFORTS`, `ANTHROPIC_PROVIDER_ID`, `CLAUDE_MODEL_ID_PREFIX`, `CLAUDE_REQUIRED_MODEL` from '../src/adapter/claude'.

   Cases:
   - ids in fixture order: `['claude-opus-5-5','claude-sonnet-5','claude-haiku-4-5']`, proving `claude-opus-5-5` (absent from the curated `CLAUDE_MODELS`) now appears.
   - every entry carries `provider: 'anthropic'` and the fixture's `name` as `label`; an entry whose `name` equals its id carries NO `label` own key (use a synthetic feed for that).
   - a synthetic feed where the `anthropic` provider also lists a non-`claude-` id (e.g. `some-other-model`) drops it, and where another provider (`opencode`) lists `claude-sonnet-5` / `anthropic/claude-sonnet-5` those are NOT picked up.
   - a feed with no `anthropic` provider → `[]`; an `anthropic` provider with no models → `[]`.
   - a duplicated id in an array-shaped provider block is emitted once (first occurrence).
   - provider id matching is case/whitespace tolerant (`'Anthropic'` matches).

   Files: `test/adapter.claude.test.ts`

6. Test ClaudeAdapter.discoverModels success, fallback, timeout and abort paths

   Add `describe('ClaudeAdapter.discoverModels (model-selector-refresh T04)', …)` to test/adapter.claude.test.ts. Import `DEFAULT_DISCOVERY_TIMEOUT_MS`, `capabilitiesToCatalogFetch` and the `DiscoveryContext` type from '../src/adapter/adapter'. Helper `ctx(overrides = {}): DiscoveryContext` returning `{ timeoutMs: DEFAULT_DISCOVERY_TIMEOUT_MS, ...overrides }`. Helper `fakeFetcher(result)` recording each `{ timeoutMs }` call.

   Cases (each asserts a resolved value, never a rejection):
   1. with `ctx.feed` set to the parsed fixture: `models` deepStrictEqual `['claude-opus-5-5','claude-sonnet-5','claude-haiku-4-5']`, `efforts` deepStrictEqual `[...CLAUDE_EFFORTS]`, `modelEntries` present with the same ids, and NO own `source`/`stale`/`staleReason`/`fetchedAt`/`modelLink` keys (loop `Object.prototype.hasOwnProperty.call`); the injected fetcher was called zero times.
   2. `capabilitiesToCatalogFetch(caps!)` yields `{ models: <the entries>, efforts: ['low','medium','high'] }` — the shape the discovery service will hand `CatalogStore.applyResult`.
   3. with no `ctx.feed`: the injected fetcher is called exactly once, and `models` matches case 1. With `ctx.timeoutMs: 25` the recorded `timeoutMs` is 25; with `ctx.timeoutMs: 60_000` it is clamped to `DEFAULT_DISCOVERY_TIMEOUT_MS`.
   4. fetcher returning `err('models.dev request timed out after 10ms')` → resolves `undefined`, and the message reaches an injected `ctx.log` sink.
   5. fetcher that THROWS synchronously, and one returning a rejected promise → both resolve `undefined` (never throw).
   6. fetcher returning a feed with no `anthropic` provider, and one whose `anthropic` block has only non-`claude-` ids → `undefined` (curated list kept by the caller).
   7. an `AbortController` already aborted in `ctx.signal` → `undefined` and the fetcher was never called.
   8. a fetcher whose promise never settles plus a signal aborted on the next macrotask → the call resolves `undefined` promptly (guards against a hang; keep it well under the mocha timeout).
   9. feed omitting `claude-sonnet-5` (synthetic anthropic block with only `claude-opus-5-5`) → `models` ends with `CLAUDE_REQUIRED_MODEL`, appears exactly once, and `CLAUDE_REQUIRED_MODEL === CLAUDE_MODELS[0]`.
   10. registry wiring: `typeof createAdapterRegistry().require('claude').discoverModels === 'function'` while `createAdapterRegistry().require('antigravity').discoverModels === undefined`, and `new ClaudeAdapter()` / `new ClaudeAdapter(mode)` still compile (existing launch/attach tests already cover the argv, which must stay byte-identical).

   Files: `test/adapter.claude.test.ts`

7. Verify compile, lint and the suites

   Run `npx tsc --noEmit -p tsconfig.json`, `npm run compile`, `npx eslint src/adapter/claude.ts test/adapter.claude.test.ts --ext .ts`, `npx mocha test/adapter.claude.test.ts`, then `npm run test:unit`. Expect green except the baseline-documented single failure 'packaging gating: includes zero native modules' (the keytar/node_modules check in test/activation.gating.test.ts), which is pre-existing and unrelated. Confirm `git status` shows only src/adapter/claude.ts and test/adapter.claude.test.ts modified (plus the extension-generated .baiton/specs/.../todos/T04/execute-<n>.md artifact).

   Files: `src/adapter/claude.ts`, `test/adapter.claude.test.ts`

## Risks

- Naming collision: src/adapter/index.ts already declares a module-private `CLAUDE_DEFAULT_MODEL` while doing `export * from './claude'`. Exporting that exact name from claude.ts risks a confusing/ambiguous binding, and editing index.ts is out of this todo's file scope — hence the distinct `CLAUDE_REQUIRED_MODEL` name plus a comment tying the two constants together.
- Import cycle: claude.ts must import only from './adapter', '../orchestrator/modelsDev', '../orchestrator/modelCatalog' and '../model/result'. Importing from './index' (which re-exports claude.ts) would create a cycle.
- test/adapter.index.test.ts's 'discoverModels seam' case is titled 'no adapter implements discoverModels yet' but asserts only `seam === undefined || typeof seam === 'function'`, so it still passes once claude implements the seam. Only its title becomes stale; it belongs to T03's files and must not be edited here.
- Never let discovery reach the real network in tests: the default fetcher is `fetchModelsDev` over the global `fetch`, so every test must inject `fetchFeed` or pass `ctx.feed`. A test that forgets both would hit models.dev and become flaky.
- The abort race must remove its `abort` listener and must not leave an unhandled rejection from the losing fetch promise, or mocha will report a stray rejection in unrelated suites.
- Returning the curated list (instead of `undefined`) on a failed or empty feed would falsely present a stale/builtin list as freshly discovered; `undefined` is the contract for 'keep the curated builtin list'.
- launch()/attach() argv and the probe must stay byte-identical: the new constructor parameter is additive and optional, and no existing code path may read it.
- The fixture's `opencode` provider re-lists Anthropic models; a filter that keys on the id prefix alone rather than the `anthropic` provider would emit duplicate/prefixed ids.

## Acceptance

- src/adapter/claude.ts exports `claudeModelsFromFeed`, `ANTHROPIC_PROVIDER_ID`, `CLAUDE_MODEL_ID_PREFIX`, `CLAUDE_REQUIRED_MODEL`, `ClaudeFeedFetcher` and `ClaudeAdapterOptions`, and `ClaudeAdapter` implements `discoverModels(ctx: DiscoveryContext): Promise<AgentCapabilities | undefined>`.
- Given the test/fixtures/modelsDev.sample.json feed, `discoverModels` resolves models `['claude-opus-5-5','claude-sonnet-5','claude-haiku-4-5']` — so `claude-opus-5-5`, absent from the curated `CLAUDE_MODELS`, is now offered — with `efforts` exactly `['low','medium','high']` and `modelEntries` carrying `provider: 'anthropic'` plus feed labels.
- `claude-sonnet-5` (`CLAUDE_REQUIRED_MODEL === CLAUDE_MODELS[0]`) is present exactly once in the discovered list even when the feed omits it.
- Only the models.dev `anthropic` provider's `claude-*` ids are used: other providers' Claude-looking ids and non-`claude-` anthropic ids are excluded.
- `discoverModels` never rejects and resolves `undefined` for: a failed/erroring/throwing fetch, a feed without an `anthropic` provider, an `anthropic` provider with no `claude-*` id, and an already-aborted or mid-flight-aborted `ctx.signal`; an already-aborted signal makes no fetch call.
- `ctx.feed`, when present, is used with zero network calls; without it the injected fetcher is called once with `timeoutMs = min(ctx.timeoutMs, DEFAULT_DISCOVERY_TIMEOUT_MS)`.
- The returned capabilities carry no `source`/`stale`/`staleReason`/`fetchedAt`/`modelLink` own keys, and `capabilitiesToCatalogFetch` round-trips them to `{ models: <entries>, efforts: ['low','medium','high'] }`.
- `launch()`/`attach()` argv and `probe()` behaviour are unchanged; `new ClaudeAdapter()` and `new ClaudeAdapter(mode)` still compile and `createAdapterRegistry()` needs no change, while `require('antigravity').discoverModels` stays `undefined`.
- No secrets, environment variables or credentials are read on the discovery path.
- `npx tsc --noEmit -p tsconfig.json`, `npm run compile` and `npx eslint src/adapter/claude.ts test/adapter.claude.test.ts --ext .ts` are clean; `npx mocha test/adapter.claude.test.ts` passes; `npm run test:unit` passes except the pre-existing 'packaging gating: includes zero native modules' keytar failure.
- Only src/adapter/claude.ts and test/adapter.claude.test.ts are modified (plus the extension-generated T04 execute-<n>.md artifact).
