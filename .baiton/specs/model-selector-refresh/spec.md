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

Make every model selector in Baiton reflect the current valid options and keep selections stable across refreshes. This spec fixes the config-panel model selectors so Codex and OpenCode use live dropdowns instead of stale static lists or free-text inputs, while preserving custom values as editable "Other…" entries and keeping the last known-good list when discovery is stale or unavailable.

## Required fix

- Codex must use the live `codex app-server` discovery path: `initialize` -> `initialized` -> `model/list`, then read `result.data[*].model` plus supported/default reasoning efforts. The resulting ids become the dropdown values; if discovery fails, times out, or returns malformed data, the last known-good list is kept and marked stale.
- OpenCode must use `opencode models` as the primary model source and `/api/model` as fallback. When neither succeeds, the previous model set is retained and the selector is marked stale instead of going blank or remaining free-text.
- Claude and Antigravity stay on their curated closed sets. OpenCode remains the only provider/model-formatted agent, but it still renders as a dropdown-backed selector rather than a plain text field.
- Existing config values must round-trip unchanged. Any saved value not currently in the live list is preserved as an editable custom "Other…" option so users do not lose valid data.
- Refresh results are additive: new live models are shown when available, stale values remain selectable, and the selector never silently rewrites a valid custom value.

## Current state

- `src/adapter/index.ts` still returns outdated or incomplete capability tables for Codex and OpenCode.
- `src/config/configPanel.ts` already preserves custom values, but the model list source is not refreshed from the live CLI/API output in the way the selectors expect.
- The config panel and webview treat the model field as a select-plus-Other flow, so the fix is in the capability discovery, not in the form UI alone.
- Discovery failures must degrade gracefully: keep the last successful list and mark it stale instead of blanking the model selector.

## Design

### 1. Capability discovery

`agentCapabilities()` is the single source of truth for the model and effort dropdowns. Each adapter exposes the live current model ids and supported effort values from its native discovery command or API, with the curated table kept as fallback when discovery is unavailable or malformed.

- Codex: use `codex app-server`, then `model/list`, and map each item to `model` + supported/default reasoning efforts.
- OpenCode: use `opencode models` and fall back to `/api/model` when needed.
- Claude and Antigravity remain on their curated sets.

### 2. Config panel behavior

The configuration panel continues to merge the refreshed list with any existing saved model value so legacy or custom entries remain editable as "Other…". The option set is refreshed live, and stale results are surfaced as metadata rather than silently replacing user data.

### 3. Fail-safe stale behavior

When a discovery probe fails, times out, or returns malformed data, Baiton keeps the previous model list, marks it stale, and continues showing the selector without blanking it.

## Constraints

- Discovery is asynchronous and time-boxed; failures do not block activation.
- Secrets remain on the host; webviews only receive ids, labels, and stale metadata.
- Existing config values round-trip unchanged.
- Antigravity CLI behavior remains unchanged.

## Testing

Tests cover Codex live-model parsing, OpenCode CLI/API fallback parsing, stale-list retention, config-panel round-trip of custom values, and selector behavior when discovery fails or returns partial data.

# TODOS

- [done] T01 Add host-free model catalog core: snapshot types, stale-aware CatalogStore with memento persistence, and preserve-existing merge helper (files: src/orchestrator/modelCatalog.ts, src/orchestrator/index.ts, test/modelCatalog.test.ts)
- [done] T02 Add models.dev feed client parsing https://models.dev/api.json?type=all into generic provider/model records with injected fetch and fixture tests (files: src/orchestrator/modelsDev.ts, test/fixtures/modelsDev.sample.json, test/modelsDev.test.ts)
- [done] T03 Extend the adapter boundary with an optional discoverModels seam and make agentCapabilities overlay discovered snapshots while keeping antigravity unchanged (after T01; files: src/adapter/adapter.ts, src/adapter/index.ts, src/adapter/antigravity.ts, test/adapter.index.test.ts)
- [done] T04 Implement Claude model discovery from the models.dev anthropic provider with the curated list as fallback so current models such as claude-opus-5-5 appear (after T02, T03; files: src/adapter/claude.ts, test/adapter.claude.test.ts)
- [done] T05 Implement Codex model discovery through `codex app-server` JSON-RPC (initialize, initialized, model/list) including supported reasoning efforts (after T03; files: src/adapter/codex.ts, test/adapter.codex.test.ts)
- [done] T06 Implement OpenCode model discovery via the server's /api/model with `opencode models` CLI output as fallback and validation source (after T03; files: src/adapter/opencode.ts, test/adapter.opencode.test.ts)
- [done] T07 Add the ModelDiscoveryService that refreshes every source asynchronously on window reload, marks failures stale, persists results, and wires it into activation plus a refresh command (after T01, T02, T04, T05, T06; files: src/activation/modelDiscovery.ts, src/extension.ts, src/activation/commands.ts, package.json, test/modelDiscovery.test.ts)
- [done] T08 Feed live capabilities into the config panel: optionsChanged protocol message, controller re-posts refreshed options with stale metadata, and existing custom values keep round-tripping (after T03, T07; files: src/config/configPanel.ts, src/activation/configPanelController.ts, src/activation/configPanel.ts, src/activation/configRefresh.ts, test/configPanel.controller.test.ts, test/configPanel.test.ts)
- [done] T09 Update the config panel webview to apply refreshed agent/model/effort options in place, show stale indicators, and keep Other… custom entries editable (after T08; files: media/config.js, media/config.html, test/configPanel.view.test.ts, test/configPanel.mirror.test.ts)
- [done] T10 Generalise the orchestrator provider catalog: open ProviderId, builtin copilot and openai entries plus models.dev-derived providers (Anthropic, DeepInfra, Cerebras, Baseten, DeepSeek, …), and legacy id/secret-key compatibility (after T01, T02; files: src/orchestrator/providers.ts, src/orchestrator/modelClient.ts, test/providers.test.ts)
- [done] T11 Make ProviderRouter catalog-driven: models from the models.dev snapshot, availability limited to configured providers, stale propagation, and preserved legacy selections re-resolved on every reload (after T07, T10; files: src/activation/providerRouter.ts, src/activation/commands.ts, test/providerRouter.test.ts)
- [done] T12 Drive the Set API Key quick pick from the generic provider catalog so hidden providers can be configured without exposing credentials to webviews (after T10; files: src/activation/setApiKey.ts, test/setApiKey.test.ts)
- [done] T13 Extend the chat webview protocol and ChatController for provider-first grouped selection with stale and custom markers, mirrored in media/protocol.js (after T10, T11; files: src/orchestrator/webviewProtocol.ts, media/protocol.js, src/activation/chatController.ts, test/webviewProtocol.reducer.test.ts, test/webviewProtocol.mirror.test.ts, test/fixtures/protocolCases.ts)
- [done] T14 Rebuild the Chat view model selector as provider select then model select, showing only configured providers, a stale badge, and custom selections (after T13; files: media/chat.js, media/chat.html, test/chatView.providers.test.ts)
- [done] T15 Add end-to-end tests for reload refresh, discovery fallback, provider filtering, grouped selection, stale-list handling and config round-trip, and update the README discovery section (after T09, T12, T14; files: test/modelSelectorRefresh.test.ts, README.md)
- [pending] T16 Fix current-model dropdown coverage for Codex and OpenCode selectors so all agents use valid, refreshed dropdowns and preserve custom values as editable "Other…" entries (after T15; files: src/adapter/index.ts, src/adapter/codex.ts, src/adapter/opencode.ts, src/config/configPanel.ts, media/config.js, test/adapter.index.test.ts, test/configPanel.controller.test.ts)

## Goal

Make every model selector in Baiton reflect what is actually available: the config panel's per-role agent/model/effort selectors and the Chat view's provider/model selector. Model lists are refreshed asynchronously from authoritative sources, providers are shown only when configured and reachable, selection is provider-first, a failed refresh keeps the last good list and marks it stale, and existing configuration values always round-trip. Antigravity (`agy`) keeps its curated model list and effort mapping unchanged.

## Required fix: current valid model dropdowns for every agent

The current configuration flow still has a selector mismatch: Codex is populated with an outdated, undersized list, and OpenCode is exposed as a free-text field instead of a proper dropdown. The fix must make all agent model selectors behave consistently as dropdowns backed by the current valid options, while preserving legacy or custom entries by falling back to an "Other…" state when needed.

Exact implementation requirements:

- `codex` must query the live Codex model catalogue via the native app-server JSON-RPC model list, not the static hard-coded fallback list. The authoritative probe is: start `codex app-server`, send `initialize`, then `initialized`, then `model/list` with `includeHidden: true` and a reasonable `limit`, read the `result.data` entries, and extract each model's `model` id plus `defaultReasoningEffort` and `supportedReasoningEfforts`. The returned ids become the dropdown values, and each model's effort options are derived from those values. If the probe fails, times out, or returns malformed data, the last good list is retained and marked stale; the selector does not go blank.
- `opencode` must query the live OpenCode model catalogue via `opencode models` and use that output as the dropdown source. If `opencode models` is unavailable or fails, fall back to the server `/api/model` endpoint when available; if both fail, the last known good list is retained and marked stale. The selector must not remain a plain text field when the CLI supports a listing command.
- `claude` and `agy` remain closed-set dropdowns and keep their curated mappings; `opencode` remains the only agent whose value semantics are provider/model formatted, but the selector is still a dropdown-backed model list rather than a free-text input.
- `agentCapabilities()` and the config panel option builder must merge live results with the persisted form values so existing custom values remain visible and editable as "Other…" entries rather than being silently rewritten or discarded.
- A failed refresh or unavailable source must keep the last known good model set and mark it stale rather than blanking the selector.
- Existing config values must round-trip unchanged, with custom values preserved as editable entries so no user data is lost.

## Current state (what this spec builds on)

- `src/adapter/index.ts` `agentCapabilities()` returns hard-coded `CLAUDE_MODELS` (`claude-sonnet-5`, `claude-opus-5`, `claude-haiku-5`), `CODEX_MODELS` (`gpt-6-astra`, `gpt-5-codex`, `o3`, …), empty `OPENCODE_MODELS` (free text) and `ANTIGRAVITY_MODELS`.
- `src/extension.ts` calls it once at activation and passes the frozen table to `registerConfigPanel`; `ConfigPanelController` folds it through `configFormOptions()`, which already appends out-of-set agent/model/effort values from the loaded form so they round-trip. `media/config.js` mirrors the validator and renders `select` + "Other…" text input per role.
- `src/orchestrator/providers.ts` contains a closed `ProviderId` union with hard-coded, inaccurate model lists; `ProviderRouter` computes availability from SecretStorage keys, endpoint settings and Copilot enumeration; `ChatController.postProviders()` posts every provider as a `ProviderGroup` with disabled reasons. `media/chat.js` renders grouped selectors and `media/protocol.js` mirrors the reducer logic.
- `src/activation/setApiKey.ts` quick-picks over `providerCatalog().filter(requiresKey)` and stores keys under `baiton.orchestrator.key.<id>`; the legacy single key migrates into the `openai` slot.
- Adapters only `probe()` with `<bin> --version`; nothing queries models. The README documents the static-catalogue decision and names `opencode models` as a dynamic source.

## Design

### 1. Host-free model catalog core (`src/orchestrator/modelCatalog.ts`)
A `ModelCatalogSnapshot` per source (`claude`, `codex`, `opencode`, `models.dev`) holds `models`, optional per-model `efforts`, `fetchedAt`, `source` (`live | cached | builtin`) and `stale: boolean`. A `CatalogStore` keeps the last successful snapshot per source, persists it through an injected memento (`globalState`), and exposes `applyResult(source, Result)`: success replaces and clears `stale`; failure keeps the previous snapshot and sets `stale = true` with a `staleReason`. A `mergePreservingExisting(snapshot, existingValues)` helper adds configured values missing from the refreshed list, tagged `custom: true`, so no existing selection is lost. This is pure, host-free and unit-tested.

### 2. models.dev feed (`src/orchestrator/modelsDev.ts`)
`fetchModelsDev({ url = 'https://models.dev/api.json?type=all', fetch, timeoutMs })` parses the feed into generic `FeedProvider` / `FeedModel` records. It is the single source for orchestrator provider/model catalogs and for the Claude adapter's model list. Injected `fetch` keeps it host-free; the checked-in fixture covers Anthropic, DeepInfra, Cerebras, Baseten, DeepSeek, Google, Mistral and OpenCode.

### 3. Adapter discovery seam
`Adapter` gains optional `discoverModels(ctx: DiscoveryContext): Promise<AgentCapabilities | undefined>` that must never throw and must honour `ctx.signal` / timeout. `agentCapabilities()` becomes `agentCapabilities(snapshots?)`: with no snapshots it returns the curated table; with snapshots it overlays discovered models/efforts and carries `stale` / `source` metadata into `AgentCapabilities`.

- Claude: models come from the models.dev `anthropic` provider, falling back to the curated list; efforts stay `low|medium|high`.
- Codex: start `codex app-server`, send `initialize`, then `initialized`, then `model/list`, and map each returned model entry to `{ id, efforts: supportedReasoningEfforts, defaultEffort }`. The model ids are the `model` property from the RPC result; supported efforts come from `supportedReasoningEfforts`; default effort from `defaultReasoningEffort`. The union of returned levels becomes the model's effort choices, with curated `CODEX_EFFORTS` as fallback if the RPC result is absent or malformed.
- OpenCode: execute `opencode models` and parse the CLI output into provider/model ids. If the CLI is unavailable or returns nothing, fall back to a GET to `/api/model` on a running OpenCode server; if both fail, retain the last known good list and mark it stale. Efforts remain free text.
- Antigravity: no `discoverModels`; the curated list and argv remain unchanged.

### 4. Discovery service (`src/activation/modelDiscovery.ts`)
On activation (`extension.ts`), after the adapter registry exists, start `ModelDiscoveryService.refresh()` without awaiting it. It runs each source in parallel with a timeout, feeds results into the `CatalogStore`, and fires `onDidChange(snapshotTable)`. Network or CLI failures only produce stale-marked snapshots; nothing here can block or fail activation. A `baiton.refreshModels` command re-runs it on demand. Credentials never leave the host: the service reads no secrets, and snapshots carry ids and labels only.

### 5. Configuration panel
`RegisterConfigPanelDeps.capabilities` becomes a live source (`getCapabilities()` + `onDidChangeCapabilities`). `ConfigPanelController` recomputes `configFormOptions(agentIds, capabilities, form)` and posts `optionsChanged { options, stale: Record<agent, { stale, reason?, fetchedAt? }> }` so an open panel updates without losing edits. `configFormOptions` keeps appending the form's existing agent/model/effort values so custom or legacy selections stay editable. `media/config.js` replaces option lists in place, preserving the focused control and "Other…" state, shows a per-agent stale note, and keeps the agent → model → effort order. `configRefresh.ts` needs no change beyond exposing the running-slugs note already there.

### 6. Orchestrator provider catalog and router
`ProviderId` widens to `string`; `PROVIDERS` becomes a builtin base plus feed-derived providers built by `providersFromFeed(feed)`. `providerSecretKey(id)` keeps `baiton.orchestrator.key.<id>`, so keys already stored for `google`, `mistral`, `opencode`, `openai` continue to work. `normalizeModelSelection` validates against the current catalog at router time, never at parse time, so persisted selections whose provider or model vanished from the feed are kept and reported as `custom` / `stale` rather than dropped.

`ProviderRouter` reads the catalog through the `CatalogStore` (models.dev snapshot + stale flag), recomputes availability on `refresh()`, and `availability()` returns only configured providers. Unconfigured providers are omitted, with a separate `hiddenProviders()` list for the Set API Key quick pick. `ProviderAvailability` gains `stale`, `staleReason`, and `fetchedAt`. `refresh()` is called on activation and again when discovery fires.

### 7. Chat view
`ProviderGroup` gains `stale?: boolean`, `staleReason?: string`; `ProviderModelItem` gains `custom?: boolean`, `efforts?: string[]`. `setProviders` carries only configured groups plus `refreshedAt`. `media/chat.html` replaces the single grouped `<select>` with a provider `<select>` followed by a model `<select>` populated from the chosen provider. A stale badge appears next to the model select when the active group is stale; selections not in the list render as `(custom)` options so they stay selectable. `media/protocol.js` mirrors the reducer changes; `ChatController.postProviders()` forwards the new fields.

## Constraints honoured

- Discovery is asynchronous, timeboxed and never awaited by activation; failures degrade to stale or builtin lists.
- Webviews only ever receive ids, labels and stale metadata; secrets stay in SecretStorage on the host.
- Existing `.baiton/config.json` values and persisted `ModelSelection` round-trip unchanged and remain editable.
- Antigravity behaviour and CLI argv remain byte-identical.
- New protocol fields are additive; mirror tests keep the JS runtime in lockstep with the TS core.

## Testing

Unit tests cover feed parsing from fixture; catalog-store stale/preserve semantics; each adapter's discovery with fake child processes / fake fetch (success, timeout, malformed output, missing binary); discovery-service refresh without blocking activation; provider catalog generation and legacy-id/key compatibility; router filtering to configured providers and stale propagation; config-panel `optionsChanged` and round-trip of custom values; chat webview provider-first rendering, hidden providers and stale badge; and README discovery docs.

# TODOS

- [done] T01 Add host-free model catalog core: snapshot types, stale-aware CatalogStore with memento persistence, and preserve-existing merge helper (files: src/orchestrator/modelCatalog.ts, src/orchestrator/index.ts, test/modelCatalog.test.ts)
- [done] T02 Add models.dev feed client parsing https://models.dev/api.json?type=all into generic provider/model records with injected fetch and fixture tests (files: src/orchestrator/modelsDev.ts, test/fixtures/modelsDev.sample.json, test/modelsDev.test.ts)
- [done] T03 Extend the adapter boundary with an optional discoverModels seam and make agentCapabilities overlay discovered snapshots while keeping antigravity unchanged (after T01; files: src/adapter/adapter.ts, src/adapter/index.ts, src/adapter/antigravity.ts, test/adapter.index.test.ts)
- [done] T04 Implement Claude model discovery from the models.dev anthropic provider with the curated list as fallback so current models such as claude-opus-5-5 appear (after T02, T03; files: src/adapter/claude.ts, test/adapter.claude.test.ts)
- [done] T05 Implement Codex model discovery through `codex app-server` JSON-RPC (initialize, initialized, model/list) including supported reasoning efforts (after T03; files: src/adapter/codex.ts, test/adapter.codex.test.ts)
- [done] T06 Implement OpenCode model discovery via the server's /api/model with `opencode models` CLI output as fallback and validation source (after T03; files: src/adapter/opencode.ts, test/adapter.opencode.test.ts)
- [done] T07 Add the ModelDiscoveryService that refreshes every source asynchronously on window reload, marks failures stale, persists results, and wires it into activation plus a refresh command (after T01, T02, T04, T05, T06; files: src/activation/modelDiscovery.ts, src/extension.ts, src/activation/commands.ts, package.json, test/modelDiscovery.test.ts)
- [done] T08 Feed live capabilities into the config panel: optionsChanged protocol message, controller re-posts refreshed options with stale metadata, and existing custom values keep round-tripping (after T03, T07; files: src/config/configPanel.ts, src/activation/configPanelController.ts, src/activation/configPanel.ts, src/activation/configRefresh.ts, test/configPanel.controller.test.ts, test/configPanel.test.ts)
- [done] T09 Update the config panel webview to apply refreshed agent/model/effort options in place, show stale indicators, and keep Other… custom entries editable (after T08; files: media/config.js, media/config.html, test/configPanel.view.test.ts, test/configPanel.mirror.test.ts)
- [done] T10 Generalise the orchestrator provider catalog: open ProviderId, builtin copilot and openai entries plus models.dev-derived providers (Anthropic, DeepInfra, Cerebras, Baseten, DeepSeek, …), and legacy id/secret-key compatibility (after T01, T02; files: src/orchestrator/providers.ts, src/orchestrator/modelClient.ts, test/providers.test.ts)
- [done] T11 Make ProviderRouter catalog-driven: models from the models.dev snapshot, availability limited to configured providers, stale propagation, and preserved legacy selections re-resolved on every reload (after T07, T10; files: src/activation/providerRouter.ts, src/activation/commands.ts, test/providerRouter.test.ts)
- [done] T12 Drive the Set API Key quick pick from the generic provider catalog so hidden providers can be configured without exposing credentials to webviews (after T10; files: src/activation/setApiKey.ts, test/setApiKey.test.ts)
- [done] T13 Extend the chat webview protocol and ChatController for provider-first grouped selection with stale and custom markers, mirrored in media/protocol.js (after T10, T11; files: src/orchestrator/webviewProtocol.ts, media/protocol.js, src/activation/chatController.ts, test/webviewProtocol.reducer.test.ts, test/webviewProtocol.mirror.test.ts, test/fixtures/protocolCases.ts)
- [done] T14 Rebuild the Chat view model selector as provider select then model select, showing only configured providers, a stale badge, and custom selections (after T13; files: media/chat.js, media/chat.html, test/chatView.providers.test.ts)
- [done] T15 Add end-to-end tests for reload refresh, discovery fallback, provider filtering, grouped selection, stale-list handling and config round-trip, and update the README discovery section (after T09, T12, T14; files: test/modelSelectorRefresh.test.ts, README.md)
- [pending] T16 Fix current-model dropdown coverage for Codex and OpenCode selectors so all agents use valid, refreshed dropdowns and preserve custom values as editable "Other…" entries (after T15; files: src/adapter/index.ts, src/adapter/codex.ts, src/adapter/opencode.ts, src/config/configPanel.ts, media/config.js, test/adapter.index.test.ts, test/configPanel.controller.test.ts)

## Goal

Make every model selector in Baiton reflect what is actually available: the configuration panel's per-role agent/model/effort selectors and the Chat view's orchestrator provider/model selector. Model lists are refreshed asynchronously on every window reload from authoritative sources, providers are shown only when configured and reachable, selection is provider-first, a failed refresh keeps the last good list and marks it stale, and existing configuration values always round-trip. Antigravity (`agy`) keeps its curated catalogue and its model/effort mapping unchanged.

## Required fix: current valid model dropdowns for every agent

The current configuration flow still has a selector mismatch: Codex is populated with an outdated, undersized list, and OpenCode is exposed as a free-text field instead of a proper dropdown. The fix must make all agent model selectors behave consistently as dropdowns backed by the current valid options, while preserving legacy or custom entries by falling back to an "Other…" state when needed.

Exact implementation requirements:

- `codex` must query the live Codex model catalogue via the native app-server JSON-RPC model list, not the static hard-coded fallback list. The authoritative probe is: start `codex app-server`, send `initialize`, then `initialized`, then `model/list` with `includeHidden: true` and a reasonable `limit`, read the `result.data` entries, and extract each model's `model` id and its supported/default reasoning-effort values. The returned ids become the dropdown values, and the `efforts` list for each model is derived from `supportedReasoningEfforts` / `defaultReasoningEffort` values. If the probe fails, times out, or returns malformed data, the last good list is retained and marked stale; the selector does not go blank.
- `opencode` must query the live OpenCode model catalogue via `opencode models` and use that output as the dropdown source. If `opencode models` is unavailable or fails, it falls back to the server `/api/model` endpoint when available; if both fail, the last known good list is retained and marked stale. The selector must not remain a plain text field when the CLI supports a listing command.
- `claude` and `agy` remain closed-set dropdowns and keep their curated mappings; `opencode` remains the only agent whose value semantics are provider/model formatted, but the selector is still a dropdown-backed model list rather than a free text input.
- `agentCapabilities()` and the config panel option builder must merge the live results with the persisted form values so existing custom values remain visible and editable as "Other…" entries rather than being silently rewritten or discarded.
- A failed refresh or unavailable source must keep the last known good model set and mark it stale rather than blanking the selector.
- Existing config values must round-trip unchanged, with custom values preserved as editable entries so no user data is lost.

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
- **Codex**: start `codex app-server`, send `initialize`, then `initialized`, then `model/list`, and map each returned model entry to `{ id, efforts: supportedReasoningEfforts, defaultEffort }`. Model ids are the `model` property from the RPC result; supported efforts come from `supportedReasoningEfforts`, default effort from `defaultReasoningEffort`. The union of returned levels becomes the model's effort choices, with the curated `CODEX_EFFORTS` set as fallback if the RPC result is absent or malformed. The child is killed after the response or on timeout.
- **OpenCode**: execute `opencode models` and parse the CLI output into provider/model ids. If the CLI is unavailable or returns no models, fall back to a GET to `/api/model` on a running OpenCode server; if that also fails, keep the last good list and mark it stale. Efforts remain free text.
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
- [done] T02 Add models.dev feed client parsing https://models.dev/api.json?type=all into generic provider/model records with injected fetch and fixture tests (files: src/orchestrator/modelsDev.ts, test/fixtures/modelsDev.sample.json, test/modelsDev.test.ts)
- [done] T03 Extend the adapter boundary with an optional discoverModels seam and make agentCapabilities overlay discovered snapshots while keeping antigravity unchanged (after T01; files: src/adapter/adapter.ts, src/adapter/index.ts, src/adapter/antigravity.ts, test/adapter.index.test.ts)
- [done] T04 Implement Claude model discovery from the models.dev anthropic provider with the curated list as fallback so current models such as claude-opus-5-5 appear (after T02, T03; files: src/adapter/claude.ts, test/adapter.claude.test.ts)
- [done] T05 Implement Codex model discovery through `codex app-server` JSON-RPC (initialize, initialized, model/list) including supported reasoning efforts (after T03; files: src/adapter/codex.ts, test/adapter.codex.test.ts)
- [done] T06 Implement OpenCode model discovery via the server's /api/model with `opencode models` CLI output as fallback and validation source (after T03; files: src/adapter/opencode.ts, test/adapter.opencode.test.ts)
- [done] T07 Add the ModelDiscoveryService that refreshes every source asynchronously on window reload, marks failures stale, persists results, and wire it into activation plus a refresh command (after T01, T02, T04, T05, T06; files: src/activation/modelDiscovery.ts, src/extension.ts, src/activation/commands.ts, package.json, test/modelDiscovery.test.ts)
- [done] T08 Feed live capabilities into the config panel: optionsChanged protocol message, controller re-posts refreshed options with stale metadata, and existing custom values keep round-tripping (after T03, T07; files: src/config/configPanel.ts, src/activation/configPanelController.ts, src/activation/configPanel.ts, src/activation/configRefresh.ts, test/configPanel.controller.test.ts, test/configPanel.test.ts)
- [done] T09 Update the config panel webview to apply refreshed agent/model/effort options in place, show stale indicators, and keep Other… custom entries editable (after T08; files: media/config.js, media/config.html, test/configPanel.view.test.ts, test/configPanel.mirror.test.ts)
- [done] T10 Generalise the orchestrator provider catalog: open ProviderId, builtin copilot and openai entries plus models.dev-derived providers (Anthropic, DeepInfra, Cerebras, Baseten, DeepSeek, …), and legacy id/secret-key compatibility (after T01, T02; files: src/orchestrator/providers.ts, src/orchestrator/modelClient.ts, test/providers.test.ts)
- [done] T11 Make ProviderRouter catalog-driven: models from the models.dev snapshot, availability limited to configured providers, stale propagation, and preserved legacy selections re-resolved on every reload (after T07, T10; files: src/activation/providerRouter.ts, src/activation/commands.ts, test/providerRouter.test.ts)
- [done] T12 Drive the Set API Key quick pick from the generic provider catalog so hidden providers can be configured without exposing credentials to webviews (after T10; files: src/activation/setApiKey.ts, test/setApiKey.test.ts)
- [done] T13 Extend the chat webview protocol and ChatController for provider-first grouped selection with stale and custom markers, mirrored in media/protocol.js (after T10, T11; files: src/orchestrator/webviewProtocol.ts, media/protocol.js, src/activation/chatController.ts, test/webviewProtocol.reducer.test.ts, test/webviewProtocol.mirror.test.ts, test/fixtures/protocolCases.ts)
- [done] T14 Rebuild the Chat view model selector as provider select then model select, showing only configured providers, a stale badge, and custom selections (after T13; files: media/chat.js, media/chat.html, test/chatView.providers.test.ts)
- [done] T15 Add end-to-end tests for reload refresh, discovery fallback, provider filtering, grouped selection, stale-list handling and config round-trip, and update the README discovery section (after T09, T12, T14; files: test/modelSelectorRefresh.test.ts, README.md)
- [pending] T16 Fix current-model dropdown coverage for Codex and OpenCode selectors so all agents use valid, refreshed dropdowns and preserve custom values as editable "Other…" entries (after T15; files: src/adapter/index.ts, src/adapter/codex.ts, src/adapter/opencode.ts, src/config/configPanel.ts, media/config.js, test/adapter.index.test.ts, test/configPanel.controller.test.ts)

## Goal

Make every model selector in Baiton reflect what is actually available: the configuration panel's per-role agent/model/effort selectors and the Chat view's orchestrator provider/model selector. Model lists are refreshed asynchronously on every window reload from authoritative sources, providers are shown only when configured and reachable, selection is provider-first, a failed refresh keeps the last good list and marks it stale, and existing configuration values always round-trip. Antigravity (`agy`) keeps its curated catalogue and its model/effort mapping unchanged.

## Required fix: current valid model dropdowns for every agent

The current configuration flow still has a selector mismatch: Codex is populated with an outdated, undersized list, and OpenCode is exposed as a free-text field instead of a proper dropdown. The fix must make all agent model selectors behave consistently as dropdowns backed by the current valid options, while preserving legacy or custom entries by falling back to an "Other…" state when needed.

- `codex` must surface the current valid model IDs from the active discovery source and keep them refreshed as the catalogue updates; stale or unsupported entries must not be silently rewritten.
- `opencode` must render a dropdown populated with valid current provider/model values, not a plain text field, while still allowing a saved custom value to remain editable if it is not currently in the list.
- `claude` and `agy` remain closed-set dropdowns; `opencode` remains the only agent whose value semantics are provider/model formatted, but the selector must still be a dropdown-backed model list.
- A failed refresh or unavailable source must keep the last known good model set and mark it stale rather than blanking the selector.
- Existing config values must round-trip unchanged, with custom values preserved as editable entries so no user data is lost.

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
- [done] T02 Add models.dev feed client parsing https://models.dev/api.json?type=all into generic provider/model records with injected fetch and fixture tests (files: src/orchestrator/modelsDev.ts, test/fixtures/modelsDev.sample.json, test/modelsDev.test.ts)
- [done] T03 Extend the adapter boundary with an optional discoverModels seam and make agentCapabilities overlay discovered snapshots while keeping antigravity unchanged (after T01; files: src/adapter/adapter.ts, src/adapter/index.ts, src/adapter/antigravity.ts, test/adapter.index.test.ts)
- [done] T04 Implement Claude model discovery from the models.dev anthropic provider with the curated list as fallback so current models such as claude-opus-5-5 appear (after T02, T03; files: src/adapter/claude.ts, test/adapter.claude.test.ts)
- [done] T05 Implement Codex model discovery through `codex app-server` JSON-RPC (initialize, initialized, model/list) including supported reasoning efforts (after T03; files: src/adapter/codex.ts, test/adapter.codex.test.ts)
- [done] T06 Implement OpenCode model discovery via the server's /api/model with `opencode models` CLI output as fallback and validation source (after T03; files: src/adapter/opencode.ts, test/adapter.opencode.test.ts)
- [done] T07 Add the ModelDiscoveryService that refreshes every source asynchronously on window reload, marks failures stale, persists results, and wire it into activation plus a refresh command (after T01, T02, T04, T05, T06; files: src/activation/modelDiscovery.ts, src/extension.ts, src/activation/commands.ts, package.json, test/modelDiscovery.test.ts)
- [done] T08 Feed live capabilities into the config panel: optionsChanged protocol message, controller re-posts refreshed options with stale metadata, and existing custom values keep round-tripping (after T03, T07; files: src/config/configPanel.ts, src/activation/configPanelController.ts, src/activation/configPanel.ts, src/activation/configRefresh.ts, test/configPanel.controller.test.ts, test/configPanel.test.ts)
- [done] T09 Update the config panel webview to apply refreshed agent/model/effort options in place, show stale indicators, and keep Other… custom entries editable (after T08; files: media/config.js, media/config.html, test/configPanel.view.test.ts, test/configPanel.mirror.test.ts)
- [done] T10 Generalise the orchestrator provider catalog: open ProviderId, builtin copilot and openai entries plus models.dev-derived providers (Anthropic, DeepInfra, Cerebras, Baseten, DeepSeek, …), and legacy id/secret-key compatibility (after T01, T02; files: src/orchestrator/providers.ts, src/orchestrator/modelClient.ts, test/providers.test.ts)
- [done] T11 Make ProviderRouter catalog-driven: models from the models.dev snapshot, availability limited to configured providers, stale propagation, and preserved legacy selections re-resolved on every reload (after T07, T10; files: src/activation/providerRouter.ts, src/activation/commands.ts, test/providerRouter.test.ts)
- [done] T12 Drive the Set API Key quick pick from the generic provider catalog so hidden providers can be configured without exposing credentials to webviews (after T10; files: src/activation/setApiKey.ts, test/setApiKey.test.ts)
- [done] T13 Extend the chat webview protocol and ChatController for provider-first grouped selection with stale and custom markers, mirrored in media/protocol.js (after T10, T11; files: src/orchestrator/webviewProtocol.ts, media/protocol.js, src/activation/chatController.ts, test/webviewProtocol.reducer.test.ts, test/webviewProtocol.mirror.test.ts, test/fixtures/protocolCases.ts)
- [done] T14 Rebuild the Chat view model selector as provider select then model select, showing only configured providers, a stale badge, and custom selections (after T13; files: media/chat.js, media/chat.html, test/chatView.providers.test.ts)
- [done] T15 Add end-to-end tests for reload refresh, discovery fallback, provider filtering, grouped selection, stale-list handling and config round-trip, and update the README discovery section (after T09, T12, T14; files: test/modelSelectorRefresh.test.ts, README.md)
- [pending] T16 Fix current-model dropdown coverage for Codex and OpenCode selectors so all agents use valid, refreshed dropdowns and preserve custom values as editable "Other…" entries (after T15; files: src/adapter/index.ts, src/adapter/codex.ts, src/adapter/opencode.ts, src/config/configPanel.ts, media/config.js, test/adapter.index.test.ts, test/configPanel.controller.test.ts)

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
- [done] T02 Add models.dev feed client parsing https://models.dev/api.json?type=all into generic provider/model records with injected fetch and fixture tests (files: src/orchestrator/modelsDev.ts, test/fixtures/modelsDev.sample.json, test/modelsDev.test.ts)
- [done] T03 Extend the adapter boundary with an optional discoverModels seam and make agentCapabilities overlay discovered snapshots while keeping antigravity unchanged (after T01; files: src/adapter/adapter.ts, src/adapter/index.ts, src/adapter/antigravity.ts, test/adapter.index.test.ts)
- [done] T04 Implement Claude model discovery from the models.dev anthropic provider with the curated list as fallback so current models such as claude-opus-5-5 appear (after T02, T03; files: src/adapter/claude.ts, test/adapter.claude.test.ts)
- [done] T05 Implement Codex model discovery through `codex app-server` JSON-RPC (initialize, initialized, model/list) including supported reasoning efforts (after T03; files: src/adapter/codex.ts, test/adapter.codex.test.ts)
- [done] T06 Implement OpenCode model discovery via the server's /api/model with `opencode models` CLI output as fallback and validation source (after T03; files: src/adapter/opencode.ts, test/adapter.opencode.test.ts)
- [done] T07 Add the ModelDiscoveryService that refreshes every source asynchronously on window reload, marks failures stale, persists results, and wire it into activation plus a refresh command (after T01, T02, T04, T05, T06; files: src/activation/modelDiscovery.ts, src/extension.ts, src/activation/commands.ts, package.json, test/modelDiscovery.test.ts)
- [done] T08 Feed live capabilities into the config panel: optionsChanged protocol message, controller re-posts refreshed options with stale metadata, and existing custom values keep round-tripping (after T03, T07; files: src/config/configPanel.ts, src/activation/configPanelController.ts, src/activation/configPanel.ts, src/activation/configRefresh.ts, test/configPanel.controller.test.ts, test/configPanel.test.ts)
- [done] T09 Update the config panel webview to apply refreshed agent/model/effort options in place, show stale indicators, and keep Other… custom entries editable (after T08; files: media/config.js, media/config.html, test/configPanel.view.test.ts, test/configPanel.mirror.test.ts)
- [done] T10 Generalise the orchestrator provider catalog: open ProviderId, builtin copilot and openai entries plus models.dev-derived providers (Anthropic, DeepInfra, Cerebras, Baseten, DeepSeek, …), and legacy id/secret-key compatibility (after T01, T02; files: src/orchestrator/providers.ts, src/orchestrator/modelClient.ts, test/providers.test.ts)
- [done] T11 Make ProviderRouter catalog-driven: models from the models.dev snapshot, availability limited to configured providers, stale propagation, and preserved legacy selections re-resolved on every reload (after T07, T10; files: src/activation/providerRouter.ts, src/activation/commands.ts, test/providerRouter.test.ts)
- [done] T12 Drive the Set API Key quick pick from the generic provider catalog so hidden providers can be configured without exposing credentials to webviews (after T10; files: src/activation/setApiKey.ts, test/setApiKey.test.ts)
- [done] T13 Extend the chat webview protocol and ChatController for provider-first grouped selection with stale and custom markers, mirrored in media/protocol.js (after T10, T11; files: src/orchestrator/webviewProtocol.ts, media/protocol.js, src/activation/chatController.ts, test/webviewProtocol.reducer.test.ts, test/webviewProtocol.mirror.test.ts, test/fixtures/protocolCases.ts)
- [done] T14 Rebuild the Chat view model selector as provider select then model select, showing only configured providers, a stale badge, and custom selections (after T13; files: media/chat.js, media/chat.html, test/chatView.providers.test.ts)
- [done] T15 Add end-to-end tests for reload refresh, discovery fallback, provider filtering, grouped selection, stale-list handling and config round-trip, and update the README discovery section (after T09, T12, T14; files: test/modelSelectorRefresh.test.ts, README.md)
