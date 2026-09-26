# Plan T10

## Steps

1. Widen ProviderId to an open string id and keep a typed builtin vocabulary

   In src/orchestrator/providers.ts, replace the closed union with `export type ProviderId = string;` (doc it: any non-empty provider id — builtin, models.dev-derived, or a persisted id whose provider has vanished from the feed; membership is validated at the router, never at parse time).

   Add, next to it, the typed builtin vocabulary so builtin-specific code stays narrow:
   - `export type BuiltinProviderId = 'copilot' | 'google' | 'opencode' | 'mistral' | 'openai';`
   - `export const BUILTIN_PROVIDER_IDS: readonly BuiltinProviderId[] = ['copilot','google','opencode','mistral','openai'] as const;`
   - keep `export const PROVIDER_IDS = BUILTIN_PROVIDER_IDS;` (same value, same order) because src/activation/providerRouter.ts imports PROVIDER_IDS and test/providers.test.ts pins that order. Do not rename or reorder it in this todo.
   - `isProviderId(value)` keeps its exact current semantics (membership in the BUILTIN list) but narrows to `value is BuiltinProviderId`; src/activation/commands.ts:728 (`isProviderId(arg) ? arg : undefined`) must keep compiling and must keep rejecting arbitrary command arguments.
   - add `export function isProviderIdLike(value: unknown): value is ProviderId` — true for a string whose trim() is non-empty. This is the open check used by normalizeModelSelection.

   Keep `PROVIDERS` as the builtin record but retype it `Readonly<Record<BuiltinProviderId, ProviderInfo>>` (values byte-identical to today: copilot, google, opencode, mistral, openai with their current labels, base URLs, requiresKey/usesSettings, model lists, dialect and headerStyle). It is now documented as the offline/builtin base and the legacy-id compatibility set: when the models.dev feed is unavailable the catalog still offers exactly today's five providers, and the legacy ids google/mistral/opencode keep their `baiton.orchestrator.key.<id>` secrets. `ProviderInfo.id` becomes `ProviderId`.

   Extend `ProviderInfo` additively (all new fields optional so no existing construction site breaks):
   - `readonly source?: 'builtin' | 'feed' | 'custom';` (default treated as 'builtin')
   - `readonly env?: readonly string[];` and `readonly doc?: string;` carried through from the feed for the Set API key quick pick (used by a later todo).
   Do NOT touch DialectId, HeaderStyleId, LEGACY_API_KEY_SECRET, PROVIDER_SECRET_KEY_PREFIX, MODEL_SELECTION_KEY, PROVIDER_NEEDS_ENDPOINT_REASON, COPILOT_UNAVAILABLE_REASON or sameModelSelection.

   Files: `src/orchestrator/providers.ts`

2. Add the per-id trait maps and providersFromFeed()

   Still in src/orchestrator/providers.ts, add the small per-id override maps the OVERVIEW calls for, each an exported `Readonly<Record<string, ...>>` with a comment naming why the entry exists:
   - `export const PROVIDER_DIALECTS: Readonly<Record<string, DialectId>> = { google: 'gemini' };` — everything else defaults to 'openai'.
   - `export const PROVIDER_HEADER_STYLES: Readonly<Record<string, HeaderStyleId>> = { opencode: 'opencode' };` — everything else defaults to 'default'.
   - `export const PROVIDER_BASE_URL_OVERRIDES: Readonly<Record<string, string>> = { google: 'https://generativelanguage.googleapis.com/v1beta/openai/' };` — the feed's `api` for `google` is `https://generativelanguage.googleapis.com/v1beta`, which is the native Gemini base, NOT the OpenAI-compatible one `completionsUrl()` appends `/chat/completions` to. The override must win over the feed.
   - `export const FEED_PROVIDER_DENY: readonly string[] = ['copilot', 'github-copilot'];` — ids the feed may carry that would duplicate the non-HTTP builtin Copilot path.

   Then add the pure builder (no vscode, no I/O; the module keeps importing only types):
   ```ts
   import type { ModelsDevFeed, FeedProvider } from './modelsDev';
   /** Catalog entries derived from one models.dev feed, in feed order. */
   export function providersFromFeed(feed: ModelsDevFeed): readonly ProviderInfo[]
   ```
   Per feed provider, skip it when: its id trims to empty, its id is in FEED_PROVIDER_DENY, it has no `api` (not reachable over an OpenAI-compatible HTTP base), or it lists zero models. Otherwise emit
   `{ id, label: provider.name || provider.id, defaultBaseUrl: PROVIDER_BASE_URL_OVERRIDES[id] ?? provider.api, requiresKey: true, usesSettings: false, models: <de-duplicated model ids in feed order>, dialect: PROVIDER_DIALECTS[id] ?? 'openai', headerStyle: PROVIDER_HEADER_STYLES[id] ?? 'default', source: 'feed', env: provider.env, doc: provider.doc }` (omit `doc` when the feed omits it; never write an own key whose value is undefined — match the conditional-assignment style of modelsDev.ts/modelCatalog.ts). The function must be total and never throw on a malformed FeedProvider.

   Add the merge/order function:
   ```ts
   /** The full catalog in dropdown order: builtins, then feed-only providers, `openai` (Custom) last. */
   export function buildProviderCatalog(feed?: ModelsDevFeed): readonly ProviderInfo[]
   ```
   Semantics, stated as the contract the tests pin:
   - With no feed (or an empty feed) it returns exactly `PROVIDER_IDS.map((id) => PROVIDERS[id])` — today's list, same order, same object identities.
   - For an id present in BOTH the builtins and the feed (google, mistral, opencode in the fixture), the builtin entry wins on label, defaultBaseUrl, requiresKey, usesSettings, dialect and headerStyle (these encode host behaviour the feed does not know about), and the FEED wins on `models` — that is the point of the todo: `google` must stop being pinned to the stale hard-coded list and `opencode` must stop advertising `claude-sonnet-4-5`. Carry `env`/`doc` over from the feed and keep `source: 'builtin'`.
   - Feed-only ids (anthropic, deepinfra, cerebras, baseten, deepseek, …) follow, in feed order.
   - `openai` (OpenAI / Custom) is always the last entry.
   - The result never contains duplicate ids.
   This function is the single place a caller turns a feed into a catalog; the host glue (router / discovery service) will call it in a later todo.

   Files: `src/orchestrator/providers.ts`

3. Make the lookup helpers tolerant of unknown ids (and keep every existing caller compiling)

   All of these live in src/orchestrator/providers.ts. Every helper that today indexes `PROVIDERS[id]` with a union-typed id must now cope with an arbitrary string. Use an own-property guard (`Object.prototype.hasOwnProperty.call`) rather than a bare index so a `__proto__`/`constructor` id cannot smuggle an object in.

   - `export function findProviderInfo(id: ProviderId, catalog?: readonly ProviderInfo[]): ProviderInfo | undefined` — exact, case-sensitive match against `catalog` when given, else the builtin record; undefined for anything unknown or blank.
   - `export function providerInfo(id: ProviderId, catalog?: readonly ProviderInfo[]): ProviderInfo` — KEEPS its non-optional return so src/activation/providerRouter.ts:160 (`const info: ProviderInfo = providerInfo(id)`) and src/activation/chatController.ts:1221 (`providerInfo(provider).label`) compile unchanged. For an unknown id it returns a freshly synthesised fallback entry `{ id, label: id, requiresKey: true, usesSettings: false, models: [], dialect: 'openai', headerStyle: 'default', source: 'custom' }` (blank id → label falls back to the raw id). Document that this is the graceful-degradation path for a persisted selection whose provider left the feed, and that callers who need real membership use `findProviderInfo`.
   - `export function providerCatalog(feed?: ModelsDevFeed): readonly ProviderInfo[]` — no-arg behaviour is unchanged (builtins in dropdown order), so src/activation/setApiKey.ts:181 keeps working; with a feed it delegates to `buildProviderCatalog(feed)`.
   - `export function providerSecretKey(id: ProviderId): string | undefined` — returns undefined only for a blank id or for a BUILTIN entry whose `requiresKey` is false (today: `copilot`); every other non-empty id, builtin or feed-derived, returns `` `${PROVIDER_SECRET_KEY_PREFIX}${id}` ``. This is the legacy-key compatibility guarantee: google/opencode/mistral/openai keep resolving to `baiton.orchestrator.key.<id>` exactly as before, and a feed provider gets the same shape. Keep the signature single-argument — providerRouter.ts calls `providerSecretKey(id)!` and setApiKey.ts calls it on catalog entries.
   - `export function defaultModelFor(id: ProviderId, catalog?: readonly ProviderInfo[]): string | undefined` — first model of the resolved entry (undefined when none or unknown).
   - `export function providerNeedsKeyReason(id: ProviderId, catalog?: readonly ProviderInfo[]): string` — same wording as today (`Set an API key for <label> to use it.`), now via `providerInfo(id, catalog).label` so an unknown id yields `Set an API key for <id> to use it.` instead of throwing.

   Files: `src/orchestrator/providers.ts`

4. Open normalizeModelSelection to any provider id

   In src/orchestrator/providers.ts, `normalizeModelSelection` keeps its shape checks (object, non-null, `model` a string that trims to non-empty, extra properties dropped, fresh object returned, never throws) but replaces `if (!isProviderId(raw['provider']))` with the open check `if (!isProviderIdLike(raw['provider']))`, and stores the TRIMMED provider: `{ provider: raw['provider'].trim(), model }`. Update the JSDoc: a persisted selection whose provider or model is no longer in the catalog is preserved here and reported as custom/stale by the router, never dropped at parse time. `{ provider: '', model: 'x' }` and `{ provider: '   ', model: 'x' }` still return undefined, as does a non-string provider. `sameModelSelection` is unchanged.

   Files: `src/orchestrator/providers.ts`

5. Widen dialectFor in the model client

   src/orchestrator/modelClient.ts:395 — change the signature to `export function dialectFor(id: DialectId | string): WireDialect` and keep the body (`return id === 'gemini' ? geminiDialect : openAiDialect;`). Update the JSDoc: a catalog entry's dialect may now come from a models.dev-derived provider via `PROVIDER_DIALECTS`, so any unrecognised value maps to the default OpenAI wire dialect rather than being a type error. The `import type { DialectId } from './providers';` at line 21 stays. No other change in this file: `openCodeExtraHeaders` and `completionsUrl` are untouched, so src/activation/providerRouter.ts:174-177 keeps compiling unchanged.

   Files: `src/orchestrator/modelClient.ts`

6. Update and extend test/providers.test.ts

   Existing assertions that must be edited (they encode the closed union):
   - `isProviderId` 'rejects unknown values': keep `'anthropic'`, `'gemini'`, `'OPENAI'`, `''`, undefined, null, 42, {} rejected — builtin membership is unchanged. Add a sibling describe for `isProviderIdLike`: accepts 'anthropic', 'deepinfra', 'copilot'; rejects '', '   ', undefined, null, 42, {}, [].
   - `normalizeModelSelection` 'rejects malformed input': remove `{ provider: 'nope', model: 'x' }` from the bad list and add a positive case asserting it now round-trips `{ provider: 'anthropic', model: 'claude-opus-5-5' }`, plus `{ provider: '  google  ', model: 'x' }` → `{ provider: 'google', model: 'x' }` (provider trimmed) and `{ provider: '', model: 'x' }` / `{ provider: '   ', model: 'x' }` still undefined.
   - Rename nothing else; 'PROVIDER_IDS is the exact dropdown order', the base-URL, dialect, headerStyle, key-policy, legacy-key and MODEL_SELECTION_KEY blocks all stay green as-is.

   New coverage to add (load the feed the same way test/modelsDev.test.ts does: `fs.readFileSync(path.join(__dirname, 'fixtures', 'modelsDev.sample.json'), 'utf8')` then `parseModelsDevFeed(JSON.parse(text))`, unwrapping the Result):
   - `providersFromFeed`: returns the eight fixture providers minus none (all have api + models), in fixture order; anthropic → label 'Anthropic', defaultBaseUrl 'https://api.anthropic.com/v1', requiresKey true, usesSettings false, dialect 'openai', headerStyle 'default', source 'feed', env ['ANTHROPIC_API_KEY'], models starting with 'claude-opus-5-5'; google → dialect 'gemini' and defaultBaseUrl overridden to 'https://generativelanguage.googleapis.com/v1beta/openai/' (NOT the feed's '/v1beta'); opencode → headerStyle 'opencode'. A hand-built feed entry with no `api`, with zero models, with a blank id, or with id 'copilot' is skipped. Never throws on a malformed entry.
   - `buildProviderCatalog`: with no argument it deep-equals `providerCatalog()` (today's five, same order); with the fixture feed the ids are unique, begin with 'copilot', end with 'openai', contain every feed-derived id, and google/mistral/opencode appear exactly once with the BUILTIN label/dialect/headerStyle/defaultBaseUrl but the FEED models (assert `models` includes 'gemini-2.5-pro' for google and that opencode no longer lists 'claude-sonnet-4-5').
   - `providerInfo`/`findProviderInfo`: `findProviderInfo('anthropic')` is undefined against the builtins and defined against `buildProviderCatalog(feed)`; `providerInfo('anthropic')` never throws and yields the synthesised fallback (label 'anthropic', requiresKey true, models [], dialect 'openai', source 'custom'); `providerInfo('__proto__')` and `providerInfo('constructor')` return a plain fallback entry, not a smuggled object.
   - legacy compatibility: for every id in PROVIDER_IDS except copilot, `providerSecretKey(id)` is still `'baiton.orchestrator.key.' + id`; `providerSecretKey('copilot')` is undefined; `providerSecretKey('anthropic')` is 'baiton.orchestrator.key.anthropic'; `providerSecretKey('')` and `providerSecretKey('   ')` are undefined; no generated key equals LEGACY_API_KEY_SECRET.
   - every feed-derived `defaultBaseUrl` parses as an https URL and `completionsUrl(base).href` ends with '/chat/completions' (reuse the `completionsUrl` import already at the top of the file).
   - `providerNeedsKeyReason('anthropic')` === 'Set an API key for anthropic to use it.' and, with the feed catalog passed, 'Set an API key for Anthropic to use it.'
   - `defaultModelFor('anthropic', buildProviderCatalog(feed))` === 'claude-opus-5-5'; `defaultModelFor('anthropic')` (builtins only) is undefined.
   Keep the file's mocha+assert style, no vscode import.

   Files: `test/providers.test.ts`, `test/fixtures/modelsDev.sample.json`

7. Check the barrel and verify

   src/orchestrator/index.ts already re-exports './providers' and './modelsDev', so no edit is needed — but grep the new exported names (BuiltinProviderId, BUILTIN_PROVIDER_IDS, isProviderIdLike, PROVIDER_DIALECTS, PROVIDER_HEADER_STYLES, PROVIDER_BASE_URL_OVERRIDES, FEED_PROVIDER_DENY, providersFromFeed, buildProviderCatalog, findProviderInfo) across src/ to confirm none collides with another barrel module's export.

   Then run, from the repo root:
   1. `npx tsc --noEmit -p tsconfig.json` — must be exit 0. This is the real gate on the ProviderId widening: it compiles src/activation/providerRouter.ts, chatController.ts, setApiKey.ts, commands.ts and src/orchestrator/webviewProtocol.ts against the new types. Fix any fallout INSIDE providers.ts/modelClient.ts (by keeping signatures compatible) rather than editing those out-of-scope files.
   2. `npm run compile`
   3. `npx eslint src/orchestrator/providers.ts src/orchestrator/modelClient.ts test/providers.test.ts --ext .ts`
   4. `npx mocha test/providers.test.ts` and `npx mocha test/providerRouter.test.ts test/setApiKey.test.ts test/modelClient.test.ts test/webviewProtocol.mirror.test.ts`
   5. `npm run test:unit`
   Baseline: the suite has ONE known pre-existing failure — 'packaging gating … includes zero native modules' (keytar) in test/activation.gating.test.ts. Any other failure is caused by this todo.

   Files: `src/orchestrator/index.ts`

## Risks

- Widening ProviderId to `string` removes exhaustiveness checking in every downstream file (providerRouter.ts, chatController.ts, setApiKey.ts, commands.ts, webviewProtocol.ts). Those files are out of scope: keep providerInfo() returning a non-optional ProviderInfo, keep providerSecretKey() single-argument, and keep PROVIDERS typed Record<BuiltinProviderId, ProviderInfo> so `PROVIDERS.copilot.label` (providerRouter.ts:489) still type-checks. `npx tsc --noEmit` is the gate.
- isProviderId is used by src/activation/commands.ts:728 to decide whether a command argument is a provider. If it were loosened to 'any non-empty string', an arbitrary argument would flow into setOrchestratorApiKey and store a key under a bogus id. Keep isProviderId as builtin membership and introduce isProviderIdLike for the open check.
- The feed's `api` for google is the native Gemini base (`/v1beta`), not the OpenAI-compatible one (`/v1beta/openai/`). Letting the feed override it would silently break Google requests; PROVIDER_BASE_URL_OVERRIDES must win, and the test must pin the override.
- Taking model lists from the feed changes what the Chat dropdown offers for google/opencode/mistral. A persisted ModelSelection pointing at a now-absent model must NOT be dropped — normalizeModelSelection keeps it, and the router (a later todo) marks it custom. Do not add catalog validation to the parse path.
- providerSecretKey now returns a key for any non-builtin id, so a malformed or hostile id would become a SecretStorage key name. Reject blank/whitespace ids; the id charset itself is constrained by what the feed and the catalog produce.
- Indexing a plain object with an arbitrary string id can return inherited members ('__proto__', 'constructor'). Use hasOwnProperty guards (or a Map) in findProviderInfo/providerInfo and cover it with a test.
- The orchestrator barrel re-exports both providers.ts and modelsDev.ts; a name collision among the new exports would only surface as a compile error at the barrel. Grep before adding.
- test/providers.test.ts currently asserts `{ provider: 'nope', model: 'x' }` is rejected and that the catalog has exactly five keys — both assertions encode the closed union and must be updated deliberately, not deleted wholesale.

## Acceptance

- `npx tsc --noEmit -p tsconfig.json` and `npm run compile` both exit 0 with no edits outside src/orchestrator/providers.ts, src/orchestrator/modelClient.ts and test/providers.test.ts (src/orchestrator/index.ts only if a re-export is genuinely missing).
- `ProviderId` is `string`; `BuiltinProviderId`/`BUILTIN_PROVIDER_IDS` exist and `PROVIDER_IDS` still deep-equals ['copilot','google','opencode','mistral','openai'].
- `buildProviderCatalog()` with no feed deep-equals `providerCatalog()` — today's five entries, same order and same field values, so an offline window behaves exactly as before.
- `buildProviderCatalog(feed)` over test/fixtures/modelsDev.sample.json yields unique ids starting with 'copilot' and ending with 'openai', includes anthropic, deepinfra, cerebras, baseten and deepseek, and keeps google/mistral/opencode with their builtin label, dialect, headerStyle and defaultBaseUrl but the feed's model lists (google includes 'gemini-2.5-pro'; opencode no longer lists 'claude-sonnet-4-5').
- `providersFromFeed` skips feed entries with no api, no models, a blank id, or an id in FEED_PROVIDER_DENY, and never throws on a malformed entry.
- `providerSecretKey` returns 'baiton.orchestrator.key.<id>' for google, opencode, mistral, openai and for feed ids such as anthropic; undefined for copilot and for a blank id; never equals LEGACY_API_KEY_SECRET.
- `providerInfo('anthropic')` (builtins only) returns a synthesised fallback instead of throwing, `findProviderInfo('anthropic')` is undefined against the builtins and defined against the feed catalog, and '__proto__'/'constructor' return plain fallback entries.
- `normalizeModelSelection({ provider: 'anthropic', model: 'claude-opus-5-5' })` round-trips, the provider is trimmed, and blank/whitespace/non-string providers and blank models are still rejected; the function still never throws.
- `dialectFor` accepts `DialectId | string` and maps anything other than 'gemini' to `openAiDialect`.
- `npx mocha test/providers.test.ts` passes, and `npm run test:unit` shows no new failures versus the single pre-existing 'packaging gating … includes zero native modules' (keytar) failure in test/activation.gating.test.ts.
- `npx eslint src/orchestrator/providers.ts src/orchestrator/modelClient.ts test/providers.test.ts --ext .ts` reports no new errors, and providers.ts still imports only types (no vscode, no node builtins, no I/O).
