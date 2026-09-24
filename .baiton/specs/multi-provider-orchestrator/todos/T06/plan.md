# Plan T06

## Steps

1. Add the host-free availability vocabulary to the provider catalog

   In src/orchestrator/providers.ts (keep it import-free: no `vscode`, no modelClient import beyond the existing `DialectId`/`HeaderStyleId` declarations) append a small, documented block after `normalizeModelSelection`:

   1. `export function providerNeedsKeyReason(id: ProviderId): string` returning `` `Set an API key for ${PROVIDERS[id].label} to use it.` ``.
   2. `export const PROVIDER_NEEDS_ENDPOINT_REASON = 'Set baiton.orchestrator.endpoint to use OpenAI / Custom.'`.
   3. `export const COPILOT_UNAVAILABLE_REASON = 'GitHub Copilot is not available in this window. Install and sign in to GitHub Copilot Chat.'`.
   4. `export function sameModelSelection(a: ModelSelection | undefined, b: ModelSelection | undefined): boolean` — true when both are undefined, or both defined with equal `provider` and `model`. Pure, never throws.

   These are the exact strings the router reports as a disabled provider's `reason`; keeping them in the catalog lets the later webview todo render them without duplicating wording. Do not change any existing export, the PROVIDERS records, or the module's dependency-free property.

   Files: `src/orchestrator/providers.ts`

2. Create src/activation/providerRouter.ts with its injected-dependency surface

   New file. Import `vscode` as a TYPE ONLY (`import type * as vscode from 'vscode';`) so the module and its test load with no host — exactly the constraint src/orchestrator/copilotClient.ts documents. Runtime imports: `{ CompletionRequest, CompletionResult, MissingConfigError, ModelClient, ModelClientConfig, OpenAiModelClient, dialectFor, openCodeExtraHeaders }` from '../orchestrator/modelClient', `{ CopilotModelClient, CopilotVscodeApi, COPILOT_VENDOR }` from '../orchestrator/copilotClient', and from '../orchestrator/providers' (direct module, not the barrel — mirroring setApiKey.ts): `MODEL_SELECTION_KEY, ModelSelection, PROVIDERS, PROVIDER_IDS, ProviderId, ProviderInfo, COPILOT_UNAVAILABLE_REASON, PROVIDER_NEEDS_ENDPOINT_REASON, defaultModelFor, normalizeModelSelection, providerInfo, providerNeedsKeyReason, providerSecretKey, sameModelSelection`.

   Declare the structural (cast-free for tests) dependency types:

   ```ts
   export interface SecretsLike { get(key: string): Thenable<string | undefined> | string | undefined; }
   export interface MementoLike { get<T>(key: string): T | undefined; update(key: string, value: unknown): Thenable<void>; }
   export interface ProviderSettings {
     getEndpoint: () => string | undefined;   // baiton.orchestrator.endpoint
     getModel: () => string | undefined;      // baiton.orchestrator.model
     isStreaming: () => boolean;              // baiton.orchestrator.streaming
     getMaxTokens: () => unknown;             // baiton.orchestrator.maxTokens
   }
   export interface ProviderRouterConfig {
     secrets: SecretsLike;
     workspaceState: MementoLike;
     settings: ProviderSettings;
     /** The `vscode` namespace (host) or the test fake; used for the Copilot client and model enumeration. */
     lm: CopilotVscodeApi;
     /** Extension version, rendered as `baiton/<version>` in the OpenCode User-Agent. */
     version: string;
     /** Overrides client construction in tests; defaults to the real clients. */
     createClient?: (id: ProviderId, router: ProviderRouter) => ModelClient;
     log?: (message: string) => void;
   }
   export interface ProviderAvailability {
     id: ProviderId;
     label: string;
     enabled: boolean;
     /** Present only when `enabled` is false. */
     reason?: string;
     models: readonly string[];
   }
   ```

   No class body yet — the following steps fill it in.

   Files: `src/activation/providerRouter.ts`

3. Build the per-provider client configuration as an exported pure function

   Still in src/activation/providerRouter.ts, export `providerClientConfig` so the wiring is assertable without reaching into `OpenAiModelClient`'s private state:

   ```ts
   export interface ClientConfigDeps {
     secrets: SecretsLike;
     settings: ProviderSettings;
     version: string;
     /** Resolves the model id currently chosen for this provider. */
     getModel: () => string | undefined;
   }
   export function providerClientConfig(id: ProviderId, deps: ClientConfigDeps): ModelClientConfig
   ```

   Behaviour, branching on `providerInfo(id)`:
   - `getEndpoint`: `info.usesSettings ? () => deps.settings.getEndpoint() || undefined : () => info.defaultBaseUrl`.
   - `getModel`: `info.usesSettings ? () => deps.getModel() ?? (deps.settings.getModel() || undefined) : () => deps.getModel()`. Both must read at call time so a model switch needs no new client.
   - `getApiKey`: `async () => { const key = providerSecretKey(id); return key === undefined ? undefined : (await deps.secrets.get(key))?.trim() || undefined; }`.
   - `isStreaming: () => deps.settings.isStreaming()`, `getMaxTokens: () => deps.settings.getMaxTokens()` (pass through unchanged; `resolveMaxTokens` already normalises).
   - `dialect: dialectFor(info.dialect)` — `google` therefore gets `geminiDialect`.
   - `extraHeaders`: only when `info.headerStyle === 'opencode'`, set to `openCodeExtraHeaders({ version: deps.version })`; otherwise omit the key entirely (spread-conditional, do not pass `undefined` explicitly where the property is optional under exactOptionalPropertyTypes — check tsconfig and match the codebase's `...(x !== undefined ? { x } : {})` idiom used in modelClient.ts).
   - Calling it with `id === 'copilot'` is a programmer error: throw `new Error('copilot has no OpenAI-compatible client config')` (Copilot is built separately).

   Build the OpenCode header provider ONCE per router instance (one `openCodeExtraHeaders` factory per provider client), not per request, so the `x-opencode-session` uuid stays stable per conversation as T02 designed.

   Files: `src/activation/providerRouter.ts`

4. Implement ProviderRouter: selection state, lazily memoised clients, change event

   `export class ProviderRouter implements ModelClient`.

   Private state: `config: ProviderRouterConfig`; `clients = new Map<ProviderId, ModelClient>()`; `selected: ModelSelection | undefined`; `lastModel = new Map<ProviderId, string>()` (the model last chosen per provider, so switching provider and back restores it); `listeners = new Set<(s: ModelSelection | undefined) => void>()`.

   Members:
   - `modelFor(id: ProviderId): string | undefined` — `this.selected?.provider === id ? this.selected.model : this.lastModel.get(id) ?? defaultModelFor(id)`; for `openai` fall through to `config.settings.getModel() || undefined` when that is still undefined.
   - `private clientFor(id: ProviderId): ModelClient` — memoised in `clients`. Default construction: `copilot` → `new CopilotModelClient({ api: this.config.lm, getModel: () => this.modelFor('copilot') })`; every other id → `new OpenAiModelClient(providerClientConfig(id, { secrets, settings, version, getModel: () => this.modelFor(id) }))`. When `config.createClient` is set, use it instead (still memoised, so a test counts one construction per provider).
   - `getSelection(): ModelSelection | undefined` and `activeProvider(): ProviderId | undefined`.
   - `async init(): Promise<void>` — read `config.workspaceState.get(MODEL_SELECTION_KEY)`, run it through `normalizeModelSelection`; keep it only when that provider is currently enabled (use the availability pass of the next step) and the model is non-empty; otherwise choose the first entry of `PROVIDER_IDS` whose availability is `enabled` and whose `models[0]` exists, and persist that choice. Seed `lastModel` from the resolved selection. `init` does not fire the change event (nothing has changed for a listener that has not subscribed yet), and it must never throw: wrap the reads in try/catch, `log` the failure and leave `selected` undefined.
   - `async select(value: unknown): Promise<boolean>` — `normalizeModelSelection(value)`; return false for anything invalid (unknown provider, empty model) without touching state. If `sameModelSelection(next, this.selected)` return true without persisting or firing. Otherwise set `selected`, `lastModel.set(next.provider, next.model)`, `await config.workspaceState.update(MODEL_SELECTION_KEY, next)` (a rejected update is caught, logged and still applied in memory so the UI does not desync), then fire the change event. Do NOT clear `clients`: each client reads its model through `modelFor` at call time.
   - `onDidChangeSelection(listener): { dispose(): void }` — adds to `listeners`, `dispose()` removes it. Firing iterates a copy of the set and wraps each call in try/catch routed to `config.log`, so one throwing listener cannot break a provider switch.

   Files: `src/activation/providerRouter.ts`

5. Implement availability + model enumeration

   On `ProviderRouter`:

   - `async availability(): Promise<ProviderAvailability[]>` — one entry per id in `PROVIDER_IDS` order, resolved in parallel (`Promise.all`) and returned in catalog order.
     - `copilot`: call `this.config.lm.lm.selectChatModels({ vendor: COPILOT_VENDOR })`. Models = each returned chat model's `id`, de-duplicated, in the order returned. `enabled` = models.length > 0; when empty, `reason = COPILOT_UNAVAILABLE_REASON`. A rejected/throwing `selectChatModels` is caught: `enabled: false`, `models: []`, same reason, and the error is passed to `config.log`.
     - `google`, `mistral`, `opencode`: models = `providerInfo(id).models`; `enabled` = the SecretStorage value at `providerSecretKey(id)!` is a string with non-whitespace content; when not, `reason = providerNeedsKeyReason(id)`. A SecretStorage read that throws counts as "no key" (logged, never propagated).
     - `openai`: models = `[settings.getModel()]` when that setting is non-empty, else `[]`. `enabled` requires BOTH a non-empty key and a non-empty `settings.getEndpoint()`; when the key is missing report `providerNeedsKeyReason('openai')`, otherwise (endpoint missing) `PROVIDER_NEEDS_ENDPOINT_REASON` — check the key first so the message is deterministic.
   - `async enabledProviders(): Promise<ProviderId[]>` — convenience over `availability()`, used by `init`.
   - `async modelsFor(id: ProviderId): Promise<readonly string[]>` — the `models` of that id's availability entry (Copilot hits `selectChatModels`, the rest are synchronous catalog/settings reads).

   Availability is always recomputed on call (keys and Copilot sign-in change out of band); do not cache it.

   Files: `src/activation/providerRouter.ts`

6. Implement the routing complete() so ChatController, the tool loop and Auto mode all switch together

   `public async complete(req: CompletionRequest): Promise<CompletionResult>` on `ProviderRouter`:

   ```ts
   const selection = this.selected;
   if (selection === undefined) { throw new MissingConfigError('model'); }
   return this.clientFor(selection.provider).complete(req);
   ```

   The request object is forwarded BY REFERENCE and unmodified — `messages`, `tools`, `signal`, `sessionId` and `onDelta` all reach the underlying client untouched, so the OpenCode session header and streaming deltas behave exactly as their own suites pin them. Errors from the delegate propagate unwrapped (`MissingConfigError` / `UnreachableEndpointError` are what the controller's inline-error path already branches on). The provider is resolved per call, so a `select()` between two completions routes the next one to the new provider with no re-wiring of `ChatController`, `toolLoop` or `decideAsk`.

   Do not modify src/activation/commands.ts in this todo: `buildModelClient` stays as it is and the router is not yet wired into activation (that lands with the protocol/webview todo). Optionally add `export * from './providerRouter';` to src/activation/index.ts ONLY if `tsc` and the existing host-free suites stay clean — that barrel is currently host-free cores only, so prefer leaving it untouched and importing the module directly.

   Files: `src/activation/providerRouter.ts`

7. Write test/providerRouter.test.ts

   New mocha/assert suite in the style of test/setApiKey.test.ts and test/copilotClient.test.ts, but with a STATIC import of `../src/activation/providerRouter` — the module's only `vscode` import is type-only, so no loader registration is needed (state this in the file header comment).

   Fakes (local to the file): `FakeSecrets` (a Map plus a `failGet` flag), `FakeMemento` (Map + recorded `updates`), a `settings` object literal with mutable fields behind the four `ProviderSettings` getters, and `fakeLm` = `{ lm: { selectChatModels: async () => models } }` cast to `CopilotVscodeApi`, where `models` is a settable array of `{ id, family }` or a thrown error. A `RecordingClient implements ModelClient` records every `CompletionRequest` and returns a canned `CompletionResult`; pass it through `createClient` to observe routing.

   Cases:
   1. `providerClientConfig`: google → `getEndpoint()` is the catalog base and `dialect` is the gemini dialect (`dialectFor('gemini')`, assert `shapeMessages` drops `content` from an empty-content assistant tool_calls turn rather than comparing object identity); mistral → openai dialect and no `extraHeaders`; opencode → `extraHeaders` present, returning `user-agent: baiton/<version>` and a stable `x-opencode-session` across two calls with the same `sessionId` and a different one for a different `sessionId`; openai → endpoint/model come from settings and change when the settings change; `getApiKey` reads and trims `baiton.orchestrator.key.<id>` and yields `undefined` for an empty/whitespace value; calling it with `'copilot'` throws.
   2. `availability()`: all five entries in `PROVIDER_IDS` order; keyed providers flip `enabled` with the secret; the disabled `reason` equals `providerNeedsKeyReason(id)`; `openai` needs key AND endpoint and reports `PROVIDER_NEEDS_ENDPOINT_REASON` when only the endpoint is missing; copilot `enabled` with model ids from `selectChatModels` (deduped, in order) and disabled with `COPILOT_UNAVAILABLE_REASON` both when the list is empty and when the call rejects; a throwing `secrets.get` degrades to disabled without throwing.
   3. `init()`: restores a valid persisted selection; falls back to the first enabled provider + its first model when the stored blob is absent, malformed, names an unknown provider, or names a now-disabled provider, and persists that fallback under `MODEL_SELECTION_KEY`; never throws when `workspaceState.get` throws.
   4. `select()`: rejects malformed input (returns false, no `update`, no event); persists a valid selection and fires `onDidChangeSelection` once with it; a repeat of the identical selection returns true and fires nothing; a disposed listener stops receiving; a throwing listener does not prevent the other listeners or the state change; a rejected `workspaceState.update` still leaves the in-memory selection applied.
   5. Routing: `complete()` with no selection rejects with `MissingConfigError` whose `missing === 'model'`; with a selection it reaches exactly that provider's client, forwarding the SAME request object (assert identity of `messages`/`signal` and that `sessionId`/`onDelta` survive); the delegate's error propagates unchanged; after `select()` to another provider the NEXT `complete()` hits the new provider while the first client is not called again; clients are memoised (two completions on one provider construct one client).
   6. Model resolution: switching provider and back restores the previously chosen model for that provider; `modelFor('copilot')` is what the Copilot client's injected `getModel` returns.

   Files: `test/providerRouter.test.ts`

8. Verify

   Run, from the repository root: `npx tsc --noEmit -p tsconfig.json` (must be clean); `npx eslint src/activation/providerRouter.ts src/orchestrator/providers.ts test/providerRouter.test.ts --ext .ts` (no new findings; the pre-existing no-unused-vars warning in src/orchestrator/webviewProtocol.ts is out of scope); `npx mocha test/providerRouter.test.ts` and `npx mocha test/providers.test.ts` (note that a bare `npx mocha <file>` unions with the .mocharc `spec`, so expect the whole suite to run); and `npm run test:unit`, which must stay fully green and land at or above the T05 baseline of 1251 passing / 1 pending.

   Files: (none)

## Risks

- src/orchestrator/providers.ts must stay dependency-free and src/activation/providerRouter.ts must keep its `vscode` import type-only: the orchestrator barrel is statically loaded by host-free suites, and a runtime `require('vscode')` reached from either would break test/copilotClient.test.ts and the setApiKey/configPanel suites.
- Caching availability or the resolved model inside a client would break the acceptance criterion that switching model takes effect immediately: every client must read its model through `modelFor` at call time, and availability must be recomputed per call because keys and Copilot sign-in change out of band.
- Building `openCodeExtraHeaders` per request instead of once per client would mint a fresh `x-opencode-session` uuid every call and break the stable-session header T02 established.
- The Copilot models are enumerated with `selectChatModels({ vendor: 'copilot' })`, which can reject or return an empty list in a window without Copilot; an unguarded call would make `availability()` and `init()` throw during activation.
- `init()` runs on the activation path: a SecretStorage or workspaceState failure there must be swallowed and logged, matching how `migrateLegacyApiKey` already refuses to break activation.
- This todo deliberately does not touch src/activation/commands.ts; `buildModelClient` and the legacy `baiton.orchestrator.apiKey` read stay live until the wiring todo, so nothing user-visible changes yet and no existing suite should move.
- The catalog's OpenCode base URL and model ids are best-effort documentation values; a wrong base URL surfaces as an UnreachableEndpointError at runtime, not as a router defect.

## Acceptance

- `npx tsc --noEmit -p tsconfig.json` is clean and `npx eslint` reports nothing new on the three changed files.
- `npm run test:unit` is fully green with no regression against the T05 baseline (1251 passing / 1 pending), and test/providerRouter.test.ts passes.
- src/activation/providerRouter.ts exports `ProviderRouter` (implementing `ModelClient`), `providerClientConfig`, `ProviderRouterConfig`, `ProviderAvailability`, `ProviderSettings`, `SecretsLike` and `MementoLike`, and imports `vscode` as a type only.
- `availability()` returns one entry per provider in `PROVIDER_IDS` order, with `enabled` driven by the per-provider secret (`baiton.orchestrator.key.<id>`), by `baiton.orchestrator.endpoint` for `openai`, and by `vscode.lm.selectChatModels({ vendor: 'copilot' })` for Copilot, each disabled entry carrying the catalog's reason string.
- Model enumeration yields the Copilot model ids at runtime, the catalog lists for google/mistral/opencode, and the `baiton.orchestrator.model` setting for openai.
- The active selection round-trips through `workspaceState` under `MODEL_SELECTION_KEY`: a valid stored selection is restored by `init()`, an invalid or now-disabled one falls back to the first enabled provider and is persisted, and `select()` validates through `normalizeModelSelection`.
- `onDidChangeSelection` fires exactly once per real change, not at all for a repeat of the same selection, and a disposed or throwing listener cannot affect the switch.
- `complete()` delegates to the active provider's client, forwarding the request object unchanged (including `sessionId` and `onDelta`), propagates the delegate's errors unwrapped, throws `MissingConfigError('model')` when nothing is selected, and routes the next call to the new provider after `select()` without reconstructing the other clients.
- The google client is built with the gemini dialect and the opencode client with the OpenCode extra headers, whose `x-opencode-session` is stable for a given `sessionId`.
- src/activation/commands.ts, the chat controller, the tool loop and the auto-mode evaluator are unmodified by this todo.
