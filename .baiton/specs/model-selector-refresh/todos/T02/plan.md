# Plan T02

## Steps

1. Create the feed vocabulary in src/orchestrator/modelsDev.ts

   New host-free module (no `vscode` import, no `require('vscode')`, no process spawning, no direct network globals) with a file-header doc comment in the style of src/orchestrator/modelCatalog.ts and src/orchestrator/providers.ts. Export:

   - `export const MODELS_DEV_URL = 'https://models.dev/api.json?type=all';`
   - `export interface FeedModelLimits { readonly context?: number; readonly output?: number; }`
   - `export interface FeedModelCost { readonly input?: number; readonly output?: number; readonly cacheRead?: number; readonly cacheWrite?: number; }`
   - `export interface FeedModel { readonly id: string; readonly name: string; readonly reasoning: boolean; readonly toolCall: boolean; readonly attachment: boolean; readonly limits?: FeedModelLimits; readonly cost?: FeedModelCost; readonly releaseDate?: string; }`
   - `export interface FeedProvider { readonly id: string; readonly name: string; readonly api?: string; readonly env: readonly string[]; readonly npm?: string; readonly doc?: string; readonly models: readonly FeedModel[]; }`
   - `export type ModelsDevFeed = readonly FeedProvider[];`

   All fields `readonly`; optional fields must be OMITTED rather than set to `undefined` (the repo builds objects with a local mutable literal type and conditional assignment — see `normalizeModelEntry` in src/orchestrator/modelCatalog.ts — because `strict` + `exactOptional`-style deepStrictEqual assertions in tests compare key presence).

   Name mapping from the feed's snake_case to camelCase is part of the contract: `tool_call` → `toolCall`, `release_date` → `releaseDate`, `limit` → `limits`, `cost.cache_read` → `cost.cacheRead`, `cost.cache_write` → `cost.cacheWrite`.

   Files: `src/orchestrator/modelsDev.ts`

2. Implement the pure parser parseModelsDevFeed(raw)

   `export function parseModelsDevFeed(raw: unknown): Result<ModelsDevFeed, string>` importing `Result`/`ok`/`err` from `../model/result` (type-only import for `Result` where it is only a type, matching modelCatalog.ts's `import type { Result } from '../model/result';`). Pure, total, never throws — it takes ALREADY-PARSED JSON so it can be unit-tested against the fixture without any transport.

   Shape handling — models.dev/api.json is an OBJECT keyed by provider id:
   ```
   { "anthropic": { "id": "anthropic", "name": "Anthropic", "api": "https://api.anthropic.com/v1", "env": ["ANTHROPIC_API_KEY"], "npm": "@ai-sdk/anthropic", "doc": "https://docs.claude.com/...",
       "models": { "claude-sonnet-5": { "id": "claude-sonnet-5", "name": "Claude Sonnet 5", "attachment": true, "reasoning": true, "tool_call": true, "release_date": "2025-09-29", "limit": { "context": 200000, "output": 64000 }, "cost": { "input": 3, "output": 15, "cache_read": 0.3, "cache_write": 3.75 } } } } }
   ```
   Rules:
   - `raw` not a non-null object (including `null`, arrays of non-objects, strings, numbers) → `err('models.dev feed is not an object')`.
   - Also accept a top-level ARRAY of provider records (defensive; the feed has shipped both shapes) — detect with `Array.isArray` and take each element's `id` from the record itself.
   - Iterate `Object.entries(raw)` in source order; the entry KEY is the provider id fallback when the record's own `id` is missing/blank. Skip any entry whose value is not a non-null object.
   - `name` falls back to the provider id when missing/blank. `api`, `npm`, `doc` are optional trimmed non-empty strings (omit otherwise). `env` is an array of non-empty trimmed strings, filtered element-wise, defaulting to `[]` (never undefined).
   - `models` may be an object keyed by model id OR an array; anything else → the provider contributes `models: []`. Each model: `id` from the record's `id` else the object key, trimmed, non-empty — otherwise SKIP that model. `name` falls back to the id. `reasoning`, `toolCall` (`tool_call`), `attachment` are `value === true` (missing → `false`). `limit` → `limits` with numeric finite `context`/`output` only, omitted when neither is present. `cost` likewise with `input`/`output`/`cache_read`/`cache_write`, omitted when empty. `release_date` → `releaseDate` as a trimmed non-empty string, omitted otherwise.
   - Providers whose `models` ends up empty are KEPT (they still matter to the provider catalog in a later todo) — do not drop them; the parser filters models, not providers.
   - Preserve source order for both providers and models; do NOT sort. Ordering decisions belong to the provider-catalog todo.
   - A parse that yields zero providers → `err('models.dev feed contained no providers')`.

   Add small private helpers mirroring modelCatalog.ts's style: `optionalString(value)`, `stringArray(value)`, `optionalNumber(value)` (finite numbers only, rejecting NaN/Infinity/strings), `asRecord(value)`.

   Files: `src/orchestrator/modelsDev.ts`

3. Implement fetchModelsDev with injected fetch and timeout

   Transport types declared locally so the module needs neither the DOM lib (tsconfig `lib` is ES2022 only) nor a global `fetch` typing:
   ```ts
   export interface FeedResponse { readonly ok: boolean; readonly status: number; text(): Promise<string>; }
   export type FeedFetch = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<FeedResponse>;
   export interface FetchModelsDevOptions { url?: string; fetch?: FeedFetch; timeoutMs?: number; }
   ```
   (`AbortSignal`/`AbortController` are ambient in @types/node and already used in src/orchestrator/autoMode.ts, so no import is needed.)

   `export async function fetchModelsDev(options: FetchModelsDevOptions = {}): Promise<Result<ModelsDevFeed, string>>`:
   - Defaults: `url = MODELS_DEV_URL`, `timeoutMs = 10_000`, `fetch` defaults to a thin wrapper over the global `fetch` accessed defensively — `const g = (globalThis as { fetch?: FeedFetch }).fetch;` — returning `err('models.dev fetch is unavailable in this runtime')` when absent. Do not import `node:https`; the injected seam plus global fetch (Node 20+) is enough, and tests always inject.
   - Create an `AbortController`, arm `const timer = setTimeout(() => controller.abort(), timeoutMs)`, and ALWAYS `clearTimeout(timer)` in a `finally` so a test never leaks a pending timer / hanging mocha process.
   - Call `fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } })` inside `try`/`catch`. On a thrown/rejected transport error return `err(...)`; when `controller.signal.aborted` is true report the timeout explicitly: `err(\`models.dev request timed out after ${timeoutMs}ms\`)`, otherwise `err(\`models.dev request failed: ${errorMessage(error)}\`)` using a local `errorMessage(value: unknown)` helper identical in spirit to modelCatalog.ts's.
   - Non-2xx (`!response.ok` or status outside 200–299) → `err(\`models.dev returned HTTP ${status}\`)`.
   - `await response.text()` (guarded by the same try/catch), `JSON.parse` inside its own try → `err('models.dev returned invalid JSON')` on failure.
   - Hand the parsed value to `parseModelsDevFeed` and return its Result unchanged.
   - The function must NEVER throw or reject: every path returns a Result. Keep the error strings human-readable — they become `staleReason` on the `models.dev` snapshot via `CatalogStore.applyResult`.

   Files: `src/orchestrator/modelsDev.ts`

4. Add the checked-in fixture excerpt

   `test/fixtures/modelsDev.sample.json`: a hand-trimmed excerpt of the real api.json in the real feed shape (object keyed by provider id), containing exactly these providers in this order — `anthropic`, `deepinfra`, `cerebras`, `baseten`, `deepseek`, `google`, `mistral`, `opencode` — each with `id`, `name`, `env`, and `api` where the real provider has one (`opencode` → `https://opencode.ai/zen/v1`, `mistral` → `https://api.mistral.ai/v1`, `deepseek` → `https://api.deepseek.com`, `cerebras`/`deepinfra`/`baseten` → their OpenAI-compatible bases; `google` and `anthropic` keep their native bases). 2–4 models each, using `claude-opus-5-5`, `claude-sonnet-5` and `claude-haiku-4-5` under `anthropic` so a later todo's Claude list has something recognisable to overlay, and `provider/model`-free plain ids elsewhere. Include at least one `models` entry with `limit` + `cost` + `release_date` fully populated and at least one minimal entry carrying only `id`/`name` so the optional-field-omission path is exercised.

   Deliberately include these malformed bits so the parser's defensiveness is covered by the SAME fixture the happy path uses only if it does not break the happy-path assertions — prefer instead to keep the fixture clean and build malformed inputs inline in the test file as object literals. Keep the fixture valid JSON, ~120–200 lines, and note at the top of the test (not in the JSON, which allows no comments) that it is a trimmed excerpt of https://models.dev/api.json?type=all.

   Note: `resolveJsonModule` is on, but read the fixture with `fs.readFileSync(path.join(__dirname, 'fixtures', 'modelsDev.sample.json'), 'utf8')` + `JSON.parse` rather than importing it, so the parser is exercised on genuinely untyped input (and `rootDir: '.'` copies nothing unexpected into `out/`).

   Files: `test/fixtures/modelsDev.sample.json`

5. Write test/modelsDev.test.ts

   Mocha + `assert` (`import * as assert from 'assert'`, `import * as fs from 'fs'`, `import * as path from 'path'`), same structure as test/modelCatalog.test.ts: a top-level `describe('modelsDev', ...)` with nested describes. Cover:

   `describe('parseModelsDevFeed')`:
   - fixture parses OK: `result.ok === true`; provider ids in fixture order deepStrictEqual `['anthropic','deepinfra','cerebras','baseten','deepseek','google','mistral','opencode']`.
   - the `anthropic` provider's model ids include `claude-opus-5-5`, `claude-sonnet-5`, `claude-haiku-4-5` in fixture order; `api`/`env`/`npm`/`doc` are carried through.
   - snake_case → camelCase: the fully-populated fixture model deepStrictEquals the expected `FeedModel` object exactly (proving `toolCall`, `releaseDate`, `limits`, `cost.cacheRead`/`cacheWrite`).
   - optional omission: the minimal fixture model has NO `limits`/`cost`/`releaseDate` keys — assert with `Object.prototype.hasOwnProperty` or a deepStrictEqual against `{ id, name, reasoning: false, toolCall: false, attachment: false }`.
   - defensive inputs (inline literals, not the fixture): `null`, `42`, `'x'`, `[]` → `err`; a provider whose value is not an object is skipped; a provider with `models: 'nope'` yields `models: []` and is still present; a model with a blank/missing id is skipped while its siblings survive; `env` missing → `[]`; `cost: { input: 'free' }` → `cost` omitted; the top-level-array shape parses equivalently to the keyed shape.
   - an empty object `{}` → `err` mentioning no providers.
   - provider `id` falls back to the object key when the record omits it; `name` falls back to the id.

   `describe('fetchModelsDev')`:
   - success: a fake `FeedFetch` returning `{ ok: true, status: 200, text: async () => fixtureText }` → OK feed; assert the fake was called with `MODELS_DEV_URL` by default and with a custom `url` when passed, and that `init.signal` is an `AbortSignal`.
   - HTTP error: `{ ok: false, status: 503, text: async () => '' }` → `err` containing `503`.
   - invalid JSON body → `err` mentioning invalid JSON.
   - rejecting fetch (`async () => { throw new Error('ECONNREFUSED'); }`) → `err` containing the message, and the call resolves rather than rejecting.
   - timeout: a fake fetch that resolves only when its `init.signal` fires `abort` (register `signal.addEventListener('abort', ...)` and reject there) with `timeoutMs: 10` → `err` mentioning `timed out`; the test must finish promptly, proving the timer aborts and is cleared.
   - missing global fetch: call with `fetch` omitted while temporarily deleting/stubbing `(globalThis as any).fetch` (restore in `finally`) → `err` about the runtime, never a throw.

   `describe('host-free')`: mirror test/modelCatalog.test.ts:534-541 verbatim against `src/orchestrator/modelsDev.ts` — the source must contain neither `from '...vscode'` nor `require(...vscode`.

   Files: `test/modelsDev.test.ts`, `test/fixtures/modelsDev.sample.json`

6. Verify compile, lint and tests

   Run `npm run compile` (tsc with `strict`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns` — all four bite in this module), `npm run lint`, and `npx mocha test/modelsDev.test.ts` plus `npm run test:unit` to confirm nothing else regressed. No other source file changes in this todo: do not touch `src/orchestrator/providers.ts`, `src/adapter/index.ts`, `src/activation/*`, `media/*` or the README — those belong to later todos.

   Files: `src/orchestrator/modelsDev.ts`, `test/modelsDev.test.ts`

## Risks

- The real models.dev payload is an object keyed by provider id, not an array, and its model records use snake_case (`tool_call`, `release_date`, `limit`). Parsing the wrong shape would silently yield an empty feed; the fixture must be written in the real shape and the array form supported only as a defensive extra.
- tsconfig `lib` is ES2022 with no DOM lib, so `fetch`, `Response` and `Headers` are not guaranteed to be typed. Declaring local `FeedFetch`/`FeedResponse` structural types and reading the global through `(globalThis as { fetch?: FeedFetch }).fetch` avoids a compile break; referencing `RequestInit`/`Response` directly likely will not compile.
- An un-cleared timeout timer keeps the mocha process alive past the suite. `clearTimeout` must run on every path (finally), and the timeout test must rely on the abort signal rather than on wall-clock waiting.
- `strict` plus deepStrictEqual key-presence assertions mean an optional field assigned `undefined` is not the same as an omitted field. Build result objects with a local mutable literal type and conditional assignment, as modelCatalog.ts does.
- Over-filtering is the subtle failure: dropping providers with zero models, or sorting output, would remove information later todos (provider catalog, Claude model overlay) depend on. Keep source order and keep model-less providers.
- Error strings become user-visible `staleReason` text on the `models.dev` snapshot, so they must be human-readable and must never leak a URL with credentials or a raw stack.

## Acceptance

- `src/orchestrator/modelsDev.ts` exists and exports `MODELS_DEV_URL`, `FeedModel`, `FeedProvider`, `ModelsDevFeed`, `FeedFetch`, `FetchModelsDevOptions`, `parseModelsDevFeed` and `fetchModelsDev`, and its source contains no `vscode` import or require.
- `parseModelsDevFeed` is pure and total: for `null`, non-objects, empty objects, malformed providers and malformed models it returns a `Result` (never throws), and for the checked-in fixture it returns the eight providers in fixture order with camelCased model fields.
- `fetchModelsDev` never throws or rejects: success, non-2xx, invalid JSON, a rejecting transport, a timeout and a missing global fetch each resolve to the appropriate `Result`, and the request timer is cleared on every path.
- `test/fixtures/modelsDev.sample.json` is valid JSON in the real feed shape and covers Anthropic, DeepInfra, Cerebras, Baseten, DeepSeek, Google, Mistral and OpenCode.
- `npm run compile` and `npm run lint` are clean, and `npm run test:unit` passes including the new `test/modelsDev.test.ts`.
- No file outside `src/orchestrator/modelsDev.ts`, `test/modelsDev.test.ts` and `test/fixtures/modelsDev.sample.json` is modified.
