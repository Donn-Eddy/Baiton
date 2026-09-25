---
version: 1
name: model-selector-refresh
status: approved
mode: manual
base: main
base_commit: 1c225fa5931f455b22f5d2970177a8ab3c623d9a
branch: baiton/model-selector-refresh
approved_rev: d3c2518d802317f5b765cacdb44fe55ffa24ba9ecd633df587b9cf4b5524ffd4
---

# OVERVIEW

## Goal

Make every model selector in Baiton reflect what is actually available: the configuration panel's per-role agent/model/effort selectors and the Chat view's orchestrator provider/model selector. Model lists are refreshed asynchronously on every window reload from authoritative sources, providers are shown only when configured and reachable, selection is provider-first, a failed refresh keeps the last good list and marks it stale, and existing configuration values always round-trip. Antigravity (`agy`) keeps its curated catalogue and its model/effort mapping unchanged.

## Current state (what the spec builds on)

- `src/adapter/index.ts` `agentCapabilities()` returns hard-coded `CLAUDE_MODELS` (`claude-sonnet-5`, `claude-opus-5`, `claude-haiku-5`), `CODEX_MODELS` (`gpt-6-astra`, `gpt-5-codex`, `o3`, …), empty `OPENCODE_MODELS` (free text) and `ANTIGRAVITY_MODELS`. `src/extension.ts` calls it once at activation and hands the frozen table to `registerConfigPanel`; `ConfigPanelController` (`src/activation/configPanelController.ts`) folds it through `configFormOptions()` (`src/config/configPanel.ts`), which already appends out-of-set agent/model/effort values from the loaded form so they round-trip. `media/config.js` mirrors the validator and renders `select` + "Other…" text input per role.
- `src/orchestrator/providers.ts` is a closed `ProviderId` union (`copilot | google | opencode | mistral | openai`) with hard-coded, inaccurate model lists (e.g. `gemini-2.5-*`, `claude-sonnet-4-5`). `src/activation/providerRouter.ts` computes availability from SecretStorage keys / the `openai` endpoint setting / `vscode.lm` Copilot enumeration, and `ChatController.postProviders()` posts every provider as a `ProviderGroup` with `enabled: false` + `reason` for unconfigured ones. `media/chat.js` renders one `<optgroup>` per provider, including disabled ones. `media/protocol.js` mirrors the reducer.
- `src/activation/setApiKey.ts` quick-picks over `providerCatalog().filter(requiresKey)` and stores keys under `baiton.orchestrator.key.<id>`; the legacy single key migrates into the `openai` slot.
- Adapters only `probe()` with `<bin> --version`; nothing queries models. README "Agent Model & Effort Discovery" documents the static-catalogue decision and names `opencode models` as a dynamic source.

## Design

### 1. Host-free model catalog core (`src/orchestrator/modelCatalog.ts`)
A `ModelCatalogSnapshot` per source (`claude`, `codex`, `opencode`, `models.dev`) holding `models`, optional per-model `efforts`, `fetchedAt`, `source` (`live | cached | builtin`) and `stale: boolean`. A `CatalogStore` keeps the last successful snapshot per source, persists it through an injected memento (`globalState`), and exposes `applyResult(source, Result)`: success replaces and clears `stale`; failure keeps the previous snapshot and sets `stale = true` with a `staleReason`. A `mergePreservingExisting(snapshot, existingValues)` helper appends configured values missing from the refreshed list, tagged `custom: true`, so no existing selection is lost. Pure, no `vscode`, fully unit-tested.

### 2. models.dev feed (`src/orchestrator/modelsDev.ts`)
`fetchModelsDev({ url = 'https://models.dev/api.json?type=all', fetch, timeoutMs })` parses the feed into generic `FeedProvider { id, name, api?, env[], npm?, doc?, models: FeedModel[] }` and `FeedModel { id, name, reasoning, toolCall, attachment, limits, cost, releaseDate }`. It is the single source for orchestrator provider/model catalogs and for the Claude adapter's model list (the `anthropic` provider). Injected `fetch` keeps it host-free; a checked-in fixture excerpt covers Anthropic, DeepInfra, Cerebras, Baseten, DeepSeek, Google, Mistral and OpenCode.

### 3. Adapter discovery seam
`Adapter` gains optional `discoverModels(ctx: DiscoveryContext): Promise<AgentCapabilities | undefined>` that must never throw and must honour `ctx.signal`/timeout. `agentCapabilities()` becomes `agentCapabilities(snapshots?)`: with no snapshots it returns today's curated table (builtin fallback); with snapshots it overlays discovered models/efforts and carries `stale`/`source` metadata into `AgentCapabilities`.
- **Claude**: models = `claude-*` ids from the models.dev `anthropic` provider (so `claude-opus-5-5` appears as soon as the feed lists it), falling back to the curated list; efforts stay `low|medium|high`. `claude-sonnet-5` (the `defaultConfig()` default) is always present.
- **Codex**: spawn `codex app-server` (stdio JSON-RPC), send `initialize`, then `initialized`, then `model/list`; map each entry to `{ id, efforts: supportedReasoningEfforts, defaultEffort }`; efforts list becomes the union of returned levels (fallback `CODEX_EFFORTS`). The child is killed after the response or on timeout.
- **OpenCode**: GET `/api/model` from a running/started opencode server (`opencode serve` on an ephemeral port, torn down after the call) and fall back to parsing `opencode models` stdout; both produce `provider/model` ids grouped by provider. Efforts remain free text.
- **Antigravity**: no `discoverModels`; the curated `ANTIGRAVITY_MODELS`/`antigravityModelFlags` path is untouched.

### 4. Discovery service (`src/activation/modelDiscovery.ts`)
On activation (`extension.ts`), after the adapter registry exists, start `ModelDiscoveryService.refresh()` without awaiting it. It runs every source in parallel with a per-source timeout, feeds results into the `CatalogStore`, and fires `onDidChange(snapshotTable)`. Network or CLI failures only produce stale-marked snapshots; nothing here can block or fail activation. A `baiton.refreshModels` command re-runs it on demand. Credentials never leave the host: the service reads no secrets, and snapshots carry ids/labels only.

### 5. Configuration panel
`RegisterConfigPanelDeps.capabilities` becomes a live source (`getCapabilities()` + `onDidChangeCapabilities`). `ConfigPanelController` recomputes `configFormOptions(agentIds, capabilities, form)` and posts a new `optionsChanged { options, stale: Record<agent, {stale, reason?, fetchedAt?}> }` message (added to `ConfigPanelHostToWebview`) so an open panel updates without losing edits. `configFormOptions` keeps appending the form's existing agent/model/effort so custom or legacy selections stay editable. `media/config.js` replaces option lists in place (preserving the focused control and "Other…" input state), shows a per-agent "stale — showing last known models" note, and keeps the agent → model → effort order (provider-first within the panel). `configRefresh.ts` needs no change beyond exposing the running-slugs note already there.

### 6. Orchestrator provider catalog and router
`ProviderId` widens to `string`; `PROVIDERS` becomes a builtin base (`copilot`, `openai` / Custom) plus feed-derived providers built by `providersFromFeed(feed)` (id, label, `api` as `defaultBaseUrl`, `requiresKey: true`, `dialect` from a small per-id map defaulting to `openai`, `headerStyle: 'opencode'` for `opencode`). `providerSecretKey(id)` keeps `baiton.orchestrator.key.<id>`, so keys already stored for `google`, `mistral`, `opencode`, `openai` continue to work. `normalizeModelSelection` accepts any non-empty provider id and validates against the current catalog at the router, never at parse time, so a persisted selection whose provider or model vanished from the feed is kept and reported as `custom`/`stale` rather than dropped.
`ProviderRouter` reads the catalog through the `CatalogStore` (models.dev snapshot, stale flag included), recomputes availability on `refresh()`, and `availability()` returns only configured providers: a keyed provider with a stored key, `openai` with key + endpoint, `copilot` when `vscode.lm` enumerates models. Unconfigured providers are omitted (with a separate `hiddenProviders()` list for the Set API key quick pick). `ProviderAvailability` gains `stale`, `staleReason`, `fetchedAt`. `refresh()` is called once after `init()` on every activation (already wired in `commands.ts`) and again when the discovery service fires.

### 7. Chat view
`ProviderGroup` gains `stale?: boolean`, `staleReason?: string`; `ProviderModelItem` gains `custom?: boolean`, `efforts?: string[]`. `setProviders` carries only configured groups plus `refreshedAt`. `media/chat.html` replaces the single grouped `<select>` with a provider `<select>` followed by a model `<select>` populated from the chosen provider (provider-first). A stale badge appears next to the model select when the active group is stale; an active selection whose model is not in the list renders as a `(custom)` option so it stays selectable. `media/protocol.js` mirrors the reducer changes; `ChatController.postProviders()` forwards the new fields. `setApiKey.ts` quick-picks over every keyed provider in the generic catalog (configured ones marked "API key set") so users can enable a hidden provider.

## Constraints honoured
- Discovery is asynchronous, timeboxed and never awaited by activation; failures degrade to stale/builtin lists.
- Webviews only ever receive ids, labels and stale metadata; secrets stay in SecretStorage on the host.
- Existing `.baiton/config.json` values and persisted `ModelSelection` round-trip unchanged and remain editable.
- Antigravity behaviour and argv are byte-identical.
- New protocol fields are additive; `test/webviewProtocol.mirror.test.ts` and `test/configPanel.mirror*.test.ts` keep the JS mirrors in lockstep.

## Testing
Unit tests cover: feed parsing from fixture; catalog store stale/preserve semantics; each adapter's discovery with fake child processes / fake fetch (success, timeout, malformed output, missing binary); discovery service running on reload without blocking; provider catalog generation and legacy-id/key compatibility; router filtering to configured providers and stale propagation; config panel `optionsChanged` and round-trip of custom values; chat webview provider-first rendering, hidden providers and stale badge (fake-DOM pattern from `test/chatView.providers.test.ts`). README's discovery section is updated to describe the new sources.

# TODOS

- [done] T01 Add host-free model catalog core: snapshot types, stale-aware CatalogStore with memento persistence, and preserve-existing merge helper (files: src/orchestrator/modelCatalog.ts, src/orchestrator/index.ts, test/modelCatalog.test.ts)
- [executing] T02 Add models.dev feed client parsing https://models.dev/api.json?type=all into generic provider/model records with injected fetch and fixture tests (files: src/orchestrator/modelsDev.ts, test/fixtures/modelsDev.sample.json, test/modelsDev.test.ts)
- [pending] T03 Extend the adapter boundary with an optional discoverModels seam and make agentCapabilities overlay discovered snapshots while keeping antigravity unchanged (after T01; files: src/adapter/adapter.ts, src/adapter/index.ts, src/adapter/antigravity.ts, test/adapter.index.test.ts)
- [pending] T04 Implement Claude model discovery from the models.dev anthropic provider with the curated list as fallback so current models such as claude-opus-5-5 appear (after T02, T03; files: src/adapter/claude.ts, test/adapter.claude.test.ts)
- [pending] T05 Implement Codex model discovery through `codex app-server` JSON-RPC (initialize, initialized, model/list) including supported reasoning efforts (after T03; files: src/adapter/codex.ts, test/adapter.codex.test.ts)
- [pending] T06 Implement OpenCode model discovery via the server's /api/model with `opencode models` CLI output as fallback and validation source (after T03; files: src/adapter/opencode.ts, test/adapter.opencode.test.ts)
- [pending] T07 Add the ModelDiscoveryService that refreshes every source asynchronously on window reload, marks failures stale, persists results, and wire it into activation plus a refresh command (after T01, T02, T04, T05, T06; files: src/activation/modelDiscovery.ts, src/extension.ts, src/activation/commands.ts, package.json, test/modelDiscovery.test.ts)
- [pending] T08 Feed live capabilities into the config panel: optionsChanged protocol message, controller re-posts refreshed options with stale metadata, and existing custom values keep round-tripping (after T03, T07; files: src/config/configPanel.ts, src/activation/configPanelController.ts, src/activation/configPanel.ts, src/activation/configRefresh.ts, test/configPanel.controller.test.ts, test/configPanel.test.ts)
- [pending] T09 Update the config panel webview to apply refreshed agent/model/effort options in place, show stale indicators, and keep Other… custom entries editable (after T08; files: media/config.js, media/config.html, test/configPanel.view.test.ts, test/configPanel.mirror.test.ts)
- [pending] T10 Generalise the orchestrator provider catalog: open ProviderId, builtin copilot and openai entries plus models.dev-derived providers (Anthropic, DeepInfra, Cerebras, Baseten, DeepSeek, …), and legacy id/secret-key compatibility (after T01, T02; files: src/orchestrator/providers.ts, src/orchestrator/modelClient.ts, test/providers.test.ts)
- [pending] T11 Make ProviderRouter catalog-driven: models from the models.dev snapshot, availability limited to configured providers, stale propagation, and preserved legacy selections re-resolved on every reload (after T07, T10; files: src/activation/providerRouter.ts, src/activation/commands.ts, test/providerRouter.test.ts)
- [pending] T12 Drive the Set API Key quick pick from the generic provider catalog so hidden providers can be configured without exposing credentials to webviews (after T10; files: src/activation/setApiKey.ts, test/setApiKey.test.ts)
- [pending] T13 Extend the chat webview protocol and ChatController for provider-first grouped selection with stale and custom markers, mirrored in media/protocol.js (after T10, T11; files: src/orchestrator/webviewProtocol.ts, media/protocol.js, src/activation/chatController.ts, test/webviewProtocol.reducer.test.ts, test/webviewProtocol.mirror.test.ts, test/fixtures/protocolCases.ts)
- [pending] T14 Rebuild the Chat view model selector as provider select then model select, showing only configured providers, a stale badge, and custom selections (after T13; files: media/chat.js, media/chat.html, test/chatView.providers.test.ts)
- [pending] T15 Add end-to-end tests for reload refresh, discovery fallback, provider filtering, grouped selection, stale-list handling and config round-trip, and update the README discovery section (after T09, T12, T14; files: test/modelSelectorRefresh.test.ts, README.md)
