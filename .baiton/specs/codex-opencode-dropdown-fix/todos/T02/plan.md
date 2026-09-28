# Plan T02

## Steps

1. Correct the curated Claude tables in src/adapter/claude.ts

   Replace CLAUDE_MODELS (currently ['claude-sonnet-5','claude-opus-5','claude-haiku-5']) with, in this exact order: 'claude-sonnet-5' (MUST stay first — CLAUDE_REQUIRED_MODEL is defined as CLAUDE_MODELS[0] and must equal defaultConfig()'s default), 'claude-opus-5-5', 'claude-fable-5-1', 'claude-haiku-4-5-20251001'. Delete 'claude-haiku-5' (no such CLI id) and 'claude-opus-5' from the curated list (a configured 'claude-opus-5' still round-trips as a custom/Other… value through configFormOptions, so do NOT add compatibility shims). Replace CLAUDE_EFFORTS with ['low','medium','high','xhigh','max'] as const, and update its doc comment to cite `claude --help`'s `--effort <low|medium|high|xhigh|max>` instead of 'Requirement 14.1' only. Leave CLAUDE_REQUIRED_MODEL, its doc comment, and index.ts's module-private CLAUDE_DEFAULT_MODEL = 'claude-sonnet-5' untouched (they already agree). No other constant changes.

   Files: `src/adapter/claude.ts`

2. Add the pure local-catalog parser claudeModelsFromCatalog

   In src/adapter/claude.ts, after claudeModelsFromFeed, add exported constants and a pure parser.

   Constants: `export const CLAUDE_CATALOG_SURFACE = 'cc';` and `export const CLAUDE_CATALOG_DIR_SEGMENTS: readonly string[] = ['cache', 'model-catalog'];` (used by the default reader).

   `export function claudeModelsFromCatalog(json: unknown): readonly ModelEntry[]` — total, never throws, never mutates. Shape it reads (verified against the real file `~/.claude/cache/model-catalog/<uuid>-<hash>-cc.json`): `{ version: 2, fetchedAt: <epoch ms number>, staleAt: <number>, catalog: { id, surface: 'cc', state?, settings_vocabulary?, config: { models: [ { id, name, short_name?, description?, section: 'main'|'overflow', thinking: { type: 'effort', effort_options: [ { id, name, badge?: { message: 'Default' } } ] } | { type: 'none' }, ... } ] } } }`.

   Algorithm, written defensively with narrow local type guards (no `any`, no non-null assertions; follow the `isRecord(value): value is Record<string, unknown>` style already used for untyped JSON in this repo):
   1. Return `[]` unless `json` is a non-null non-array object.
   2. Do NOT require `version`; tolerate a missing `version` and a missing `catalog.state`. Read `catalog` — return `[]` when it is not a non-null object.
   3. Require `typeof catalog.surface === 'string' && catalog.surface.trim() === CLAUDE_CATALOG_SURFACE` — otherwise return `[]` (never accept a non-`cc` surface).
   4. Read `catalog.config.models`; return `[]` when it is not an array.
   5. Two ordered passes over the array in file order: first elements whose `section` is the string `'main'`, then every remaining element (including `'overflow'`, an absent and an unknown `section`). Within each pass keep file order.
   6. For each element: skip unless it is a non-null object whose `id` is a string that, trimmed, is non-empty and `startsWith(CLAUDE_MODEL_ID_PREFIX)`. Skip an id already emitted (first occurrence wins, so a 'main' duplicate beats an 'overflow' one).
   7. Build the entry with the same conditional-own-key style as claudeModelsFromFeed / normalizeModelEntry — always `{ id }`, plus `label` only when `name` is a string with length > 0 and `!== id`; plus `efforts` and `defaultEffort` per step 8. Emit NO `provider`, NO `custom`, and no provenance keys.
   8. Efforts: when `thinking` is a non-null object and `thinking.type === 'effort'` and `thinking.effort_options` is an array, `efforts` is that array's elements' `id` values, in array order, keeping only non-empty trimmed strings, de-duplicated first-seen; `defaultEffort` is the id of the FIRST option whose `badge` is a non-null object with `badge.message === 'Default'` (omit the key when no option carries it, and omit it when that id is not in the kept `efforts`). When `thinking.type === 'none'`, `thinking` is absent, or the shape is anything else, set `efforts: []` (an explicit empty own key — the webview step distinguishes 'this model has no levels' from 'unknown') and omit `defaultEffort`.

   Document in the JSDoc that only ids, labels and effort names are read out of the file and nothing else of it leaves the host, and that a catalog past its `staleAt` is deliberately still used (it is the CLI's own last-known-good picker list).

   Files: `src/adapter/claude.ts`

3. Add the injectable readLocalCatalog seam and its default filesystem reader

   In src/adapter/claude.ts:

   1. Widen the imports: `import { execFile } from 'child_process';` stays; add `import * as fs from 'fs';`, `import * as os from 'os';`, `import * as path from 'path';`.
   2. Add `export type ClaudeCatalogReader = () => Promise<unknown | undefined>;` with a doc comment saying it resolves the parsed JSON of the freshest local `*-cc.json` catalog, or `undefined` when there is none / it is unreadable, and that it NEVER rejects.
   3. Extend `ClaudeAdapterOptions` with `readonly readLocalCatalog?: ClaudeCatalogReader;` (optional, so every existing `new ClaudeAdapter()` / `new ClaudeAdapter(mode)` / `new ClaudeAdapter(mode, { fetchFeed })` call site still compiles).
   4. Store it in the constructor as `private readonly readLocalCatalog: ClaudeCatalogReader = options.readLocalCatalog ?? defaultReadLocalCatalog;` (module-level function, mirroring codex.ts's `defaultSpawnAppServer`).
   5. Module-level helpers, placed beside codex.ts-style private helpers at the bottom of the file:
      - `function claudeConfigDir(): string` — `$CLAUDE_CONFIG_DIR` when set and non-empty, else `path.join(os.homedir(), '.claude')` (exact shape of `codexHome()` in src/adapter/codex.ts:1047).
      - `export function claudeCatalogDir(): string` — `path.join(claudeConfigDir(), ...CLAUDE_CATALOG_DIR_SEGMENTS)`.
      - `async function defaultReadLocalCatalog(): Promise<unknown | undefined>` — wrap the WHOLE body in try/catch returning `undefined`: `fs.readdirSync(claudeCatalogDir())`, keep names ending in `.json`, for each read `fs.readFileSync(file, 'utf8')` and `JSON.parse` inside a per-file try/catch (a bad file is skipped, not fatal), keep only parses whose `catalog.surface === CLAUDE_CATALOG_SURFACE`, and return the candidate with the largest numeric `fetchedAt` (treat a missing/non-finite `fetchedAt` as `-Infinity`; ties keep the first in readdir order). Return `undefined` when no candidate survives. Never honour `staleAt`. Read nothing but these files; no credential, token or env var other than `CLAUDE_CONFIG_DIR` is touched.
   6. Add a private `raceTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined>` next to `raceAbort`: resolves `undefined` when the timer fires first, `clearTimeout`s the timer on every settle path, `.catch`es the losing promise so no unhandled rejection escapes, and calls `timer.unref?.()` so a pending timer can never keep the mocha process alive.

   Files: `src/adapter/claude.ts`

4. Rewire ClaudeAdapter.discoverModels to prefer the local catalog over the feed

   Rewrite the body of `discoverModels(ctx)` in src/adapter/claude.ts, keeping the outer try/catch → `undefined` contract and the existing `timeoutMs` clamp (`Math.min(ctx.timeoutMs > 0 ? ctx.timeoutMs : DEFAULT_DISCOVERY_TIMEOUT_MS, DEFAULT_DISCOVERY_TIMEOUT_MS)`) exactly as they are:

   1. Early `return undefined` when `ctx.signal?.aborted === true` (unchanged).
   2. Local-catalog leg FIRST: `const raw = await this.raceTimeout(this.raceAbort(Promise.resolve().then(() => this.readLocalCatalog()), ctx.signal), timeoutMs);` — wrapping the call in `Promise.resolve().then(...)` so a reader that throws synchronously is caught by the race rather than by the outer try. Then `const local = raw === undefined ? [] : claudeModelsFromCatalog(raw);`.
   3. When `local.length > 0`: build and return the result from it and do NOT read `ctx.feed`, do NOT call `this.fetchFeed` (this is the assertion the tests pin). Re-check `ctx.signal?.aborted` before returning `undefined`.
   4. Only when `local.length === 0` (missing, unreadable, malformed, non-`cc`, or no `claude-` ids): fall through to TODAY'S feed path verbatim — `ctx.feed` when present, else `this.raceAbort(this.fetchFeed({ timeoutMs }), ctx.signal)` with the same `isOk` / `ctx.log?.(result.error)` / `undefined` handling — then `claudeModelsFromFeed(feed)`; `undefined` when that is empty.
   5. Shared tail for both legs, factored into one private helper `private capabilitiesFor(entries: readonly ModelEntry[]): AgentCapabilities`: copy the entries, append `{ id: CLAUDE_REQUIRED_MODEL }` (no `custom` flag) when no entry has that id so it is present exactly once, then `return capabilitiesFromEntries(withDefault, { efforts })` where `efforts` is the ordered first-seen union of the entries' own `efforts` when ANY entry has a non-empty `efforts`, else `[...CLAUDE_EFFORTS]`. Note: `capabilitiesFromEntries` already computes that union when `options.efforts` is omitted, so implement this as: pass `{ efforts: [...CLAUDE_EFFORTS] }` when no entry carries levels, and pass no `efforts` option at all when some entry does. Emit no `source`/`stale`/`staleReason`/`fetchedAt`/`modelLink` own keys (CatalogStore stamps provenance; claude has no modelLink) — the existing test asserting their absence must keep passing.
   6. Update the method's JSDoc: the precedence is local catalog → models.dev feed → `undefined`, the curated list is NEVER returned here, and per-model efforts come from the catalog while the feed leg keeps the capability-level CLAUDE_EFFORTS.

   Do not touch `launch`, `attach`, `probe`, `claudeSystemPromptFlags`, `raceAbort`, or any argv (`--model`/`--effort` are unchanged).

   Files: `src/adapter/claude.ts`

5. No change needed in src/adapter/index.ts beyond the doc comment

   `builtinAgentCapabilities().claude` keeps spreading CLAUDE_MODELS/CLAUDE_EFFORTS and so picks up the corrected tables with no edit. `overlayCapabilities` already prefers a non-empty snapshot-level `efforts`, already falls back to the union of per-entry efforts, and already runs `mergePreservingExisting(snapshot, [CLAUDE_DEFAULT_MODEL])` for claude — all correct for catalog-sourced entries. The only edit: in the `builtinAgentCapabilities` JSDoc, the phrase describing claude's models/efforts as 'enumerated starting sets' stays, but add one sentence to `agentCapabilities`'s or `overlayCapabilities`'s comment noting that a claude snapshot may now carry per-model `efforts`/`defaultEffort` from the CLI's local catalog, so the union path is the normal claude path and not codex-only. Do NOT add an antigravity source, do NOT touch AGENT_CATALOG_SOURCE or CATALOG_SOURCE_IDS (other todos own those).

   Files: `src/adapter/index.ts`

6. Check in the catalog fixture test/fixtures/claudeModelCatalog.sample.json

   A trimmed but structurally faithful copy of the real file (read untyped with fs + JSON.parse in the tests, like modelsDev.sample.json — no resolveJsonModule import). Top level: `{ "version": 2, "fetchedAt": 1790549038273, "staleAt": 1790552298140, "catalog": { "id": "cc-catalog-fixture", "surface": "cc", "state": {}, "config": { "id": "cc", "models": [ ... ] } } }`. `catalog.config.models`, in this order, so the fixture exercises every branch AND proves the main-before-overflow reordering (note element 2 is an overflow entry sitting between main entries):
   1. `{ "id": "claude-opus-5-5", "name": "Opus 5.5", "short_name": "Opus", "section": "main", "thinking": { "type": "effort", "effort_options": [ {"id":"low","name":"Low"}, {"id":"medium","name":"Medium","badge":{"message":"Default","variant":"neutral"}}, {"id":"high","name":"High"}, {"id":"xhigh","name":"Extra"}, {"id":"max","name":"Max"} ] } }` → efforts low..max, defaultEffort 'medium'.
   2. `{ "id": "claude-opus-4-7", "name": "Opus 4.7", "section": "overflow", "thinking": { "type": "effort", "effort_options": [ {"id":"low"}, {"id":"high","badge":{"message":"Default"}} ] } }` → efforts ['low','high'], defaultEffort 'high'.
   3. `{ "id": "claude-sonnet-5", "name": "Sonnet 5", "section": "main", "thinking": { "type": "effort", "effort_options": [ {"id":"low","name":"Low"}, {"id":"high","name":"High","badge":{"message":"Default"}} ] } }`.
   4. `{ "id": "claude-haiku-4-5-20251001", "name": "Haiku 4.5", "section": "main", "thinking": { "type": "none" } }` → `efforts: []`, no defaultEffort.
   5. `{ "id": "claude-sonnet-5", "name": "Sonnet 5 duplicate", "section": "overflow" }` → dropped (duplicate; first occurrence wins).
   6. `{ "id": "gpt-5", "name": "Not Claude", "section": "main" }` → dropped (prefix).
   7. `{ "id": "claude-label-equals-id", "name": "claude-label-equals-id", "section": "overflow" }` → kept with NO `label` own key and `efforts: []`.
   8. `{ "id": "   ", "name": "blank", "section": "main" }` → dropped.
   Expected parser output ids, in order: ['claude-opus-5-5','claude-sonnet-5','claude-haiku-4-5-20251001','claude-opus-4-7','claude-label-equals-id'].

   Files: `test/fixtures/claudeModelCatalog.sample.json`

7. Extend test/adapter.claude.test.ts: fix the two now-false assertions, then cover the parser and the new precedence

   Existing assertions to repair FIRST (they fail otherwise):
   - Line ~621-630 ('yields the fixture claude ids in feed order, including claude-opus-5-5 (absent from the curated list)'): 'claude-opus-5-5' is now IN the curated list. Move the absence guard to 'claude-haiku-4-5' — an id the modelsDev fixture carries and the corrected CLAUDE_MODELS does not (the curated id is the dated 'claude-haiku-4-5-20251001') — and rename the `it` accordingly.
   - Line ~768-781 ('capabilitiesToCatalogFetch round-trips…'): `assert.deepStrictEqual(roundTripped.efforts, ['low','medium','high'])` becomes `[...CLAUDE_EFFORTS]`.
   - HERMETICITY, mandatory: every existing test in the `ClaudeAdapter.discoverModels` describe constructs `new ClaudeAdapter(DEFAULT_PERMISSION_MODE, { fetchFeed })` and would now read the developer's REAL `~/.claude/cache/model-catalog`, making the feed-path assertions machine-dependent. Add `readLocalCatalog: async () => undefined` to every construction in that describe — cleanest via a local helper `function feedOnlyAdapter(mode: PermissionMode, fetchFeed: ClaudeFeedFetcher): ClaudeAdapter` used by all of them — including the abort/timeout/throwing-fetcher cases. Keep the 'aborted signal never calls the fetcher' case working (the abort check runs before the reader).

   New `describe('claudeModelsFromCatalog (T02)')` over the checked-in fixture, asserting: the id order above (main file order, then overflow file order); labels from `name` with no `label` own key when `name === id`; `efforts` and `defaultEffort` exactly as listed per entry; `efforts: []` as an OWN key for the `thinking.type: 'none'` model with no `defaultEffort` own key; no `provider`, `custom`, `source`, `stale` or `fetchedAt` own key on any entry; `[]` for each of: `undefined`, `null`, `42`, `'x'`, `[]`, `{}`, a doc whose `catalog.surface` is `'web'` or missing, a doc with no `catalog.config.models`, a doc whose `models` is not an array, and a doc whose models are all non-`claude-` ids; a doc with a missing `version` and no `catalog.state` still parses (tolerated); a doc whose `staleAt` is in the past still parses (never honoured); and that the function never throws for a deeply malformed doc (e.g. `{ catalog: { surface: 'cc', config: { models: [null, 1, { id: 5 }, { id: 'claude-x', thinking: 'nope' }] } } }` → only `{ id: 'claude-x', efforts: [] }`).

   New cases in the `discoverModels` describe, each with an injected `readLocalCatalog` and a RECORDING `fetchFeed`:
   - catalog usable → models/modelEntries are the fixture's (plus the guaranteed CLAUDE_REQUIRED_MODEL exactly once), per-model `efforts`/`defaultEffort` survive, `caps.efforts` is the ordered union ['low','medium','high','xhigh','max'] from the entries, the fetcher was called 0 times, and `ctx.feed` being present is likewise ignored (assert the resolved ids are the catalog's, not the feed's).
   - catalog missing (`async () => undefined`), malformed (`async () => ({ catalog: { surface: 'web' } })`), and empty (a `cc` doc with `models: []`) → each falls back to the feed and resolves the feed's ids with `caps.efforts` deepStrictEqual `[...CLAUDE_EFFORTS]`.
   - reader throws / returns a rejected promise → falls back to the feed (never rejects).
   - both unusable (no catalog + `err(...)` feed) → `undefined`, and the feed error still reaches `ctx.log`.
   - a reader that never settles plus a mid-flight `controller.abort()` → resolves `undefined` in well under 2s and the fetcher is not called (mirror the existing never-settling-fetch case's shape).
   - a reader that never settles with `ctx.timeoutMs: 25` → resolves `undefined` (or falls through to the feed, whichever the implementation of step 4 yields — assert the actual contract you implemented and say so in the test name) within the timebox, proving the timer is raced and cleared.
   - a catalog that omits 'claude-sonnet-5' → CLAUDE_REQUIRED_MODEL is appended last, exactly once, with no `custom` own key (same assertions as the existing feed-path case).
   - curated-table guards: `assert.deepStrictEqual([...CLAUDE_MODELS], ['claude-sonnet-5','claude-opus-5-5','claude-fable-5-1','claude-haiku-4-5-20251001'])`, `assert.deepStrictEqual([...CLAUDE_EFFORTS], ['low','medium','high','xhigh','max'])`, `CLAUDE_REQUIRED_MODEL === CLAUDE_MODELS[0]`, and that CLAUDE_MODELS contains neither 'claude-haiku-5' nor 'claude-opus-5'.
   Import `claudeModelsFromCatalog` (and any new exported constant you assert on) from '../src/adapter/claude'.

   Files: `test/adapter.claude.test.ts`

8. Extend test/adapter.index.test.ts for a claude snapshot carrying per-model efforts

   The existing cases keep passing unchanged (they compare against `[...CLAUDE_EFFORTS]` and `builtinAgentCapabilities()`), so only add: (1) a case that `agentCapabilities({ claude: snap('claude', [{ id: 'claude-opus-5-5', efforts: ['low','medium','high','xhigh','max'], defaultEffort: 'medium' }, { id: 'claude-sonnet-5', efforts: ['low','high'], defaultEffort: 'high' }]) }).claude` has `efforts` equal to the ordered union `['low','medium','high','xhigh','max']` (NOT the builtin list) and `modelEntries[0].defaultEffort === 'medium'` — using the existing `snap` helper and the same shape as the codex union case just below; (2) a case that the builtin claude table still exposes the corrected curated ids `['claude-sonnet-5','claude-opus-5-5','claude-fable-5-1','claude-haiku-4-5-20251001']` and that an empty claude snapshot still keeps them with `source: 'builtin'`. Do not touch the antigravity cases.

   Files: `test/adapter.index.test.ts`

9. Keep the end-to-end refresh suite hermetic

   test/modelSelectorRefresh.test.ts:290 builds the REAL ClaudeAdapter with only `fetchFeed` injected, so it would now read the developer's real `~/.claude/cache/model-catalog` and its claude expectations would become machine-dependent. Add `readLocalCatalog: async () => undefined` to that construction (and to any other real-ClaudeAdapter construction in that file, e.g. around line 697) so the existing feed-driven claude legs keep asserting the fixture feed. Do not otherwise change the file — the new catalog-path end-to-end leg belongs to the spec's later end-to-end todo. Also confirm by grep that no other suite constructs a real ClaudeAdapter and calls `discoverModels` (test/adapter.launch.property.test.ts and test/engineFacade.resume.test.ts only use launch/attach/probe, so they need no change).

   Files: `test/modelSelectorRefresh.test.ts`

10. Correct the README discovery section's claude bullet

   In README.md, under '#### Agent Model & Effort Discovery (CLI Probing & Architecture)' → '**Sources**', replace the `claude` bullet (currently 'the `anthropic` provider of the models.dev feed … Effort levels stay the CLI's own `low|medium|high`') with: the Claude CLI's own local model catalog first — `$CLAUDE_CONFIG_DIR`/`~/.claude/cache/model-catalog/*-cc.json` (version 2, `catalog.surface: "cc"`), the freshest file by `fetchedAt`, read for ids, labels and per-model effort levels only, `main` section entries before `overflow`, each model's `thinking.effort_options` becoming its own effort list with the `Default`-badged option as its default, and no network or credential needed (a catalog past its `staleAt` is still used — it is the CLI's own last-known-good picker list); the `anthropic` provider of the models.dev feed (filtered to `claude-*` ids, no per-model levels) only as the fallback when the local catalog is missing, unreadable, malformed or empty; both unusable keeps the previous list and marks it stale. State that the CLI-wide effort vocabulary is `low|medium|high|xhigh|max` (`claude --help`) and that `claude-sonnet-5` (the `defaultConfig()` default) is always present. In the '**CLI capabilities**' list, extend the `claude` line ('provides no `models` subcommand…') with the fact that the CLI nonetheless maintains the local `model-catalog` cache above, which is the authoritative list its own picker shows. Leave the codex, opencode, antigravity, 'How a refresh behaves', 'What survives' and 'Privacy' paragraphs untouched (the Privacy claim already covers this path).

   Files: `README.md`

11. Verify

   Run `npm run compile` (tsc must be clean — note `claudeModelsFromCatalog` must type-check without `any`/non-null assertions to satisfy the repo's eslint config), `npm run lint`, and `npm run test:unit`. The whole suite must be green, not only the claude files: the curated-table change is observable in test/adapter.index.test.ts and the configPanel suites, and the precedence change is observable in test/modelSelectorRefresh.test.ts. Re-run `npm test` (mocha default, includes the property suites) once before declaring done.

   Files: (none)

## Risks

- Hermeticity is the main hazard: the default readLocalCatalog reads the developer's real ~/.claude/cache/model-catalog, which EXISTS on this machine. Any existing or new test that constructs a real ClaudeAdapter without injecting readLocalCatalog will silently stop testing the feed path and start asserting against host data. Every construction in test/adapter.claude.test.ts's discoverModels describe and in test/modelSelectorRefresh.test.ts must pass `readLocalCatalog: async () => undefined`.
- test/adapter.claude.test.ts:628 asserts 'claude-opus-5-5' is ABSENT from CLAUDE_MODELS; correcting the curated table makes that assertion false, so it must be re-pointed at 'claude-haiku-4-5' (fixture id, not curated) in the same commit or the suite breaks.
- capabilitiesToCatalogFetch's round-trip test pins `['low','medium','high']`; widening CLAUDE_EFFORTS breaks it unless it is changed to `[...CLAUDE_EFFORTS]`.
- Dropping 'claude-opus-5' and 'claude-haiku-5' from the curated list must not rewrite a configured value. configFormOptions' merge already re-appends an out-of-set model, so verify (do not assume) that test/configPanel.test.ts:600-615 — which configures 'claude-opus-5' — still passes after the table change.
- ModelDiscoveryService still awaits the single feed promise before running the claude job (src/activation/modelDiscovery.ts:215-221). Offline, the claude list therefore refreshes from the local catalog only after the feed attempt settles (up to the per-source timeout), not instantly. That is the OVERVIEW's accepted behaviour and no seam change is in scope — do not 'fix' it here.
- The reader's timebox must not leak a live timer: an un-cleared or non-unref'd setTimeout in raceTimeout keeps mocha alive after the suite passes. Clear it on every settle path and consume the losing promise's rejection, exactly as raceAbort already does.
- claude-haiku-4-5-20251001 legitimately yields `efforts: []`. Emitting it as an own empty array (rather than omitting the key) is deliberate and later consumed by the webview step; capabilitiesFromEntries' union treats it as contributing nothing, so the capability-level list is unaffected — but the distinction must survive into modelEntries.
- The real catalog carries per-model fields Baiton must not read or forward (description, notice, capabilities, min_claude_code_version, fast_mode, settings_vocabulary). The parser must project only id/label/efforts/defaultEffort so nothing else can reach the webview.
- Effort ids in the fixture and the real file happen to match the CLI-wide vocabulary, but the parser must not validate against CLAUDE_EFFORTS — an unknown future level must pass through, since the catalog is the authority.

## Acceptance

- CLAUDE_MODELS is exactly ['claude-sonnet-5','claude-opus-5-5','claude-fable-5-1','claude-haiku-4-5-20251001'], CLAUDE_EFFORTS is exactly ['low','medium','high','xhigh','max'], and CLAUDE_REQUIRED_MODEL === CLAUDE_MODELS[0] === 'claude-sonnet-5'.
- claudeModelsFromCatalog is exported, pure and total: it returns [] (never throws) for undefined/null/non-object/array input, a non-'cc' or missing surface, a missing or non-array catalog.config.models, and a models array with no claude-* id; it tolerates a missing `version`, a missing `catalog.state` and a past `staleAt`.
- On test/fixtures/claudeModelCatalog.sample.json it yields ids in main-then-overflow order, labels from `name` (no `label` own key when `name === id`), per-model `efforts` in effort_options order, `defaultEffort` from the `badge.message === 'Default'` option, `efforts: []` for a `thinking.type: 'none'` model with no defaultEffort, first-occurrence-wins on duplicate ids, and no provider/custom/provenance own keys.
- ClaudeAdapter accepts `readLocalCatalog` in its options and, when that reader yields a usable catalog, discoverModels resolves the catalog's entries and the injected fetchFeed is called ZERO times even when ctx.feed is supplied.
- When the catalog is missing, unreadable, malformed or empty, discoverModels falls back to ctx.feed / fetchFeed and claudeModelsFromFeed with capability-level efforts equal to [...CLAUDE_EFFORTS]; when both legs are unusable it resolves undefined (never the curated list) and the feed error still reaches ctx.log.
- On the catalog path the capability-level `efforts` is the ordered first-seen union of the entries' own levels, and modelEntries carry each model's own efforts and defaultEffort.
- CLAUDE_REQUIRED_MODEL is present exactly once in every resolved list, appended last with no `custom` own key when the source omits it; the resolved capabilities carry no source/stale/staleReason/fetchedAt/modelLink own key.
- An already-aborted ctx.signal resolves undefined without invoking the reader's work or the fetcher; a never-settling reader plus a mid-flight abort, and a never-settling reader under a small ctx.timeoutMs, both settle well inside the timebox and leave no pending timer (mocha exits normally).
- discoverModels never rejects: a reader that throws synchronously, one that returns a rejected promise, and a malformed catalog all resolve through the fallback or to undefined.
- Only ids, labels and effort names are taken from the catalog file; the default reader touches no env var but CLAUDE_CONFIG_DIR and no credential, and the launch argv (--model/--effort) plus probe/launch/attach are byte-identical to before.
- `npm run compile`, `npm run lint`, `npm run test:unit` and `npm test` all pass, including test/adapter.index.test.ts, test/configPanel*.test.ts and test/modelSelectorRefresh.test.ts.
- README's discovery section describes the local-catalog-first precedence, the `low|medium|high|xhigh|max` vocabulary, per-model levels with the Default badge, and the models.dev feed as the claude fallback only.
