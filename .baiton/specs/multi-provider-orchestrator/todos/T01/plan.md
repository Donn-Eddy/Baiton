# Plan T01

## Steps

1. Create the provider id type, order and guard in src/orchestrator/providers.ts

   New host-free module (no `vscode` import, no `fs` import — it is a pure data/validation module like src/orchestrator/webviewProtocol.ts). Start it with a file-level doc comment explaining that it is the single source of truth for orchestrator inference providers and is consumed both by host glue and by unit tests.

   Declare:

     export type ProviderId = 'copilot' | 'google' | 'opencode' | 'mistral' | 'openai';

     /** Dropdown order, top to bottom. */
     export const PROVIDER_IDS: readonly ProviderId[] = ['copilot', 'google', 'opencode', 'mistral', 'openai'] as const;

     export function isProviderId(value: unknown): value is ProviderId {
       return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value);
     }

   Follow the existing repo idiom for this shape — see `isAgentId` in src/adapter/adapter.ts (line ~30) and `isPrProvider`/`PR_PROVIDERS` in src/engine/prTool.ts:48 — a `readonly` array plus a `value is T` guard that widens the array to `readonly string[]` before `.includes`. Keep `strict`, `noUnusedLocals`, `noImplicitReturns` clean and end every statement with a semicolon (eslint `semi`).

   Files: `src/orchestrator/providers.ts`

2. Add the ProviderInfo record: labels, default base URLs, key requirement, settings-backed flag

   In the same file declare:

     export interface ProviderInfo {
       /** Stable id, also the suffix of the SecretStorage key. */
       id: ProviderId;
       /** Human label shown as the <optgroup> label in the Chat dropdown. */
       label: string;
       /** Default OpenAI-compatible base URL, or undefined when the provider is not HTTP-based (`copilot`) or takes its base URL from settings (`openai`). */
       defaultBaseUrl?: string;
       /** True when the provider needs an API key in SecretStorage before it can be used. */
       requiresKey: boolean;
       /** True when endpoint/model come from the `baiton.orchestrator.endpoint` / `baiton.orchestrator.model` settings rather than this catalog (`openai` only). */
       usesSettings: boolean;
       /** Built-in model ids offered in the dropdown; empty means "enumerate at runtime / free text". */
       models: readonly string[];
     }

     export const PROVIDERS: Readonly<Record<ProviderId, ProviderInfo>> = { ... } as const;

   Exact values:
   - copilot: label 'GitHub Copilot', no defaultBaseUrl, requiresKey false, usesSettings false, models [] (enumerated at runtime through `vscode.lm.selectChatModels({ vendor: 'copilot' })` by later todos — the catalog deliberately carries none).
   - google: label 'Google AI Studio', defaultBaseUrl 'https://generativelanguage.googleapis.com/v1beta/openai/', requiresKey true, usesSettings false, models ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'].
   - opencode: label 'OpenCode Go', defaultBaseUrl 'https://opencode.ai/zen/v1', requiresKey true, usesSettings false, models ['grok-code', 'qwen3-coder', 'kimi-k2', 'claude-sonnet-4-5', 'gpt-5-codex']. Add a comment pointing at `OPENCODE_MODEL_DOC_URL` in src/adapter/opencode.ts:186 ('https://opencode.ai/docs/go/') as the documentation source, and keep both the base URL and the model list in one place so a later correction is a one-line edit.
   - mistral: label 'Mistral AI', defaultBaseUrl 'https://api.mistral.ai/v1', requiresKey true, usesSettings false, models ['mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest', 'codestral-latest', 'devstral-medium-latest'].
   - openai: label 'OpenAI / Custom', no defaultBaseUrl (settings supply it), requiresKey true, usesSettings true, models [] (the `baiton.orchestrator.model` setting is free text).

   Also export two small accessors so callers never index `PROVIDERS` by hand:

     export function providerInfo(id: ProviderId): ProviderInfo;
     /** Catalog entries in dropdown order. */
     export function providerCatalog(): readonly ProviderInfo[];   // PROVIDER_IDS.map((id) => PROVIDERS[id])

   Note for the base URLs: `completionsUrl()` in src/orchestrator/modelClient.ts appends `/chat/completions` to any base that already has a path and strips trailing slashes, so both the Google (`/v1beta/openai/`) and Mistral (`/v1`) values above resolve correctly without further shaping — do not "fix" them by adding `/chat/completions`.

   Files: `src/orchestrator/providers.ts`, `src/orchestrator/modelClient.ts`, `src/adapter/opencode.ts`

3. Add the SecretStorage key names, including the legacy one

   In providers.ts declare:

     /** Prefix of every per-provider SecretStorage key. */
     export const PROVIDER_SECRET_KEY_PREFIX = 'baiton.orchestrator.key.';

     /**
      * The SecretStorage key holding `id`'s API key, or undefined for a provider
      * that needs none (`copilot`).
      */
     export function providerSecretKey(id: ProviderId): string | undefined {
       return PROVIDERS[id].requiresKey ? `${PROVIDER_SECRET_KEY_PREFIX}${id}` : undefined;
     }

     /**
      * The pre-multi-provider single-key secret, written by
      * `setOrchestratorApiKey` in src/activation/setApiKey.ts. Migrated once into
      * the `openai` slot by the host glue; kept here so the migration and the
      * catalog cannot drift.
      */
     export const LEGACY_API_KEY_SECRET = 'baiton.orchestrator.apiKey';

   The literal must match `API_KEY_SECRET` in src/activation/setApiKey.ts exactly. Do NOT edit setApiKey.ts in this todo (later todos re-point it); providers.ts only records the name.

   Files: `src/orchestrator/providers.ts`, `src/activation/setApiKey.ts`

4. Add the ModelSelection type, its persistence key, defaults and validator

   Still in providers.ts:

     /** The active provider + model pair, as persisted and as sent to the webview. */
     export interface ModelSelection {
       provider: ProviderId;
       model: string;
     }

     /** `workspaceState` key the active selection is persisted under. */
     export const MODEL_SELECTION_KEY = 'baiton.orchestrator.selection';

     /** The first built-in model for `id`, or undefined when the catalog lists none. */
     export function defaultModelFor(id: ProviderId): string | undefined {
       return PROVIDERS[id].models[0];
     }

     /**
      * Read an untrusted value (a `workspaceState` blob written by an older
      * build, or a webview `selectModel` payload) as a ModelSelection.
      * Returns undefined for anything that is not an object with a known
      * `provider` and a non-empty string `model`. Pure; never throws.
      */
     export function normalizeModelSelection(value: unknown): ModelSelection | undefined;

   Implement `normalizeModelSelection` in the style of `normalizeEscalation` (src/orchestrator/webviewProtocol.ts:154): reject non-objects and `null`, read `provider` through `isProviderId`, require `model` to be a string whose `.trim()` is non-empty, and return `{ provider, model: model.trim() }` — a fresh object, never the input. Do not validate `model` against `PROVIDERS[provider].models`: `copilot` and `openai` carry empty catalogs on purpose and their models are runtime/free-text.

   The `workspaceState` key follows the existing convention in src/activation/commands.ts:627-638 (`baiton.chat.session.<scope>`, `baiton.chat.autoMode`), so keep the `baiton.` prefix and the dotted lower-camel tail.

   Files: `src/orchestrator/providers.ts`, `src/orchestrator/webviewProtocol.ts`, `src/activation/commands.ts`

5. Re-export the catalog from the orchestrator barrel

   Add `export * from './providers';` to src/orchestrator/index.ts. Place it next to the other host-free cores — immediately after the `export * from './seams';` line reads fine, or at the end of the list; order does not matter to the barrel but keep it grouped with the non-glue modules.

   Before adding, confirm no exported name collides with an existing barrel export: `modelClient.ts` already exports `ModelProvider` and `EndpointProvider`, so do NOT name anything in providers.ts `ModelProvider`. The names introduced here (`ProviderId`, `PROVIDER_IDS`, `isProviderId`, `ProviderInfo`, `PROVIDERS`, `providerInfo`, `providerCatalog`, `PROVIDER_SECRET_KEY_PREFIX`, `providerSecretKey`, `LEGACY_API_KEY_SECRET`, `ModelSelection`, `MODEL_SELECTION_KEY`, `defaultModelFor`, `normalizeModelSelection`) are free as of this branch — verify with `grep -rn "<name>" src --include=*.ts` if the compiler reports a duplicate-export error.

   Files: `src/orchestrator/index.ts`

6. Write test/providers.test.ts

   New mocha + `assert` test file in the repo's existing style (plain `describe`/`it`, `import * as assert from 'assert';`, imports straight from '../src/orchestrator/providers'). No fixtures, no vscodeFake — the module is host-free. Cover:

   1. Catalog shape: `PROVIDER_IDS` deep-equals `['copilot','google','opencode','mistral','openai']` (order is the dropdown order and is part of the contract); `providerCatalog()` returns one entry per id, in that same order, and each entry's `.id` matches its position.
   2. `PROVIDERS` has exactly `PROVIDER_IDS.length` own keys and every key is a `ProviderId` (guards against a stray entry).
   3. Labels: every `label` is a non-empty string and all labels are distinct.
   4. `isProviderId`: true for each id in `PROVIDER_IDS`; false for '', 'OPENAI', 'gemini', 'anthropic', `undefined`, `null`, `42`, `{}`.
   5. Base URLs: `google` is exactly 'https://generativelanguage.googleapis.com/v1beta/openai/' and `mistral` exactly 'https://api.mistral.ai/v1'; `copilot` and `openai` have `defaultBaseUrl === undefined`; every defined `defaultBaseUrl` parses with `new URL(...)` and has protocol 'https:'.
   6. Key policy: `requiresKey` is false for `copilot` and true for every other provider; `providerSecretKey('copilot') === undefined`; for each keyed provider `providerSecretKey(id) === 'baiton.orchestrator.key.' + id`, all such keys are distinct, and none equals `LEGACY_API_KEY_SECRET`.
   7. Legacy key: `LEGACY_API_KEY_SECRET === 'baiton.orchestrator.apiKey'` (pin the literal — the migration depends on it).
   8. Settings-backed provider: `usesSettings` is true only for `openai`; `PROVIDERS.openai.models` is empty; `PROVIDERS.copilot.models` is empty.
   9. Built-in model lists: `google.models` and `mistral.models` and `opencode.models` are each non-empty, contain only non-empty strings, have no duplicates within a provider, and `google.models[0]` starts with 'gemini-'; `defaultModelFor(id)` equals `PROVIDERS[id].models[0]` for the populated providers and is `undefined` for `copilot` and `openai`.
   10. `MODEL_SELECTION_KEY === 'baiton.orchestrator.selection'`.
   11. `normalizeModelSelection`: accepts `{ provider: 'google', model: 'gemini-2.5-pro' }` and returns a deep-equal object that is NOT the same reference as the input; trims `'  gemini-2.5-flash  '`; accepts a model not present in the catalog (e.g. `{ provider: 'copilot', model: 'gpt-4.1' }`) since copilot models are runtime-enumerated; ignores extra properties on the input (result has exactly the `provider` and `model` keys — assert via `Object.keys(result).sort()`); returns `undefined` for `undefined`, `null`, `'google'`, `42`, `[]`, `{}`, `{ provider: 'nope', model: 'x' }`, `{ provider: 'google' }`, `{ provider: 'google', model: '' }`, `{ provider: 'google', model: '   ' }`, `{ provider: 'google', model: 5 }`; and never throws for any of those.
   12. A round-trip guard: for every `id` in `PROVIDER_IDS` with a default model, `normalizeModelSelection({ provider: id, model: defaultModelFor(id) })` deep-equals `{ provider: id, model: defaultModelFor(id) }`.

   Keep the file under `test/` so the default `.mocharc` spec (`test/**/*.test.ts`) picks it up; it is a unit test, not a property test, so the name must NOT contain `.property.`.

   Files: `test/providers.test.ts`

7. Verify

   Run `npx tsc --noEmit -p tsconfig.json` (or `npm run compile` if present), `npx eslint src/orchestrator/providers.ts src/orchestrator/index.ts test/providers.test.ts --ext .ts`, and `npx mocha test/providers.test.ts`. Then run the fuller `npm run test:unit` once to confirm the new barrel export did not break any existing import (in particular test/modelClient.test.ts and test/webviewProtocol.mirror.test.ts, which import from the orchestrator tree).

   Files: `src/orchestrator/providers.ts`, `src/orchestrator/index.ts`, `test/providers.test.ts`

## Risks

- The OpenCode Go base URL and model list are the least certain values in the catalog. The repo only records the documentation URL ('https://opencode.ai/docs/go/', src/adapter/opencode.ts:186) and deliberately ships an EMPTY model list for the opencode CLI adapter because its models are arbitrary user-configured 'provider/model' strings. If the hosted gateway base differs from 'https://opencode.ai/zen/v1', or the model ids differ, the fix is a one-line edit to PROVIDERS.opencode — so keep the test assertions on that provider structural (non-empty, https, no duplicates) rather than pinning exact literals, and pin exact literals only for Google and Mistral, whose bases are named in the design.
- Name collisions in the orchestrator barrel: src/orchestrator/modelClient.ts already exports `ModelProvider`, `EndpointProvider` and `ApiKeyProvider`. Avoid those names entirely in providers.ts; `export * from './providers'` would otherwise fail to compile with a duplicate-export error.
- `LEGACY_API_KEY_SECRET` must stay byte-identical to `API_KEY_SECRET` in src/activation/setApiKey.ts ('baiton.orchestrator.apiKey'). A drift silently makes the later one-time migration a no-op and users lose their existing key. This todo introduces the duplicate deliberately (providers.ts is host-free and cannot import the vscode-bound setApiKey.ts); the test pins the literal.
- Over-validating `ModelSelection.model` against the catalog would break `copilot` (models enumerated from `vscode.lm` at runtime) and `openai` (free-text `baiton.orchestrator.model` setting). `normalizeModelSelection` must validate the provider id only.
- Scope creep: this todo must not touch modelClient.ts, webviewProtocol.ts, media/protocol.js, commands.ts or setApiKey.ts. The mirror test (test/webviewProtocol.mirror.test.ts) guards protocol changes and would fail if the webview protocol were edited here.
- Google's base URL ends in a trailing slash and Mistral's does not; `completionsUrl()` normalizes both, so neither needs reshaping. Adding '/chat/completions' by hand here would double the path in later todos.

## Acceptance

- src/orchestrator/providers.ts exists, imports nothing from `vscode` and nothing from `fs`/`path`, and exports: ProviderId, PROVIDER_IDS, isProviderId, ProviderInfo, PROVIDERS, providerInfo, providerCatalog, PROVIDER_SECRET_KEY_PREFIX, providerSecretKey, LEGACY_API_KEY_SECRET, ModelSelection, MODEL_SELECTION_KEY, defaultModelFor, normalizeModelSelection.
- PROVIDER_IDS is exactly ['copilot','google','opencode','mistral','openai'] and providerCatalog() returns the five entries in that order.
- PROVIDERS.google.defaultBaseUrl === 'https://generativelanguage.googleapis.com/v1beta/openai/' and PROVIDERS.mistral.defaultBaseUrl === 'https://api.mistral.ai/v1'; copilot and openai have no defaultBaseUrl.
- providerSecretKey('copilot') is undefined; providerSecretKey(id) is 'baiton.orchestrator.key.' + id for google, opencode, mistral and openai; LEGACY_API_KEY_SECRET === 'baiton.orchestrator.apiKey'.
- PROVIDERS.openai.usesSettings is true and it is the only provider with usesSettings true; PROVIDERS.copilot.requiresKey is false and it is the only provider with requiresKey false; both carry empty model lists.
- google, opencode and mistral each carry a non-empty, duplicate-free built-in model list, and defaultModelFor(id) returns its first entry (undefined for copilot and openai).
- MODEL_SELECTION_KEY === 'baiton.orchestrator.selection'.
- normalizeModelSelection returns a fresh {provider, model} for a valid pair (trimming the model, tolerating models absent from the catalog, dropping extra properties) and returns undefined — without throwing — for every malformed input listed in the test step.
- src/orchestrator/index.ts re-exports './providers'.
- test/providers.test.ts exists and `npx mocha test/providers.test.ts` passes; `npx tsc --noEmit` and `npx eslint src test --ext .ts` report no new errors; `npm run test:unit` is green.
