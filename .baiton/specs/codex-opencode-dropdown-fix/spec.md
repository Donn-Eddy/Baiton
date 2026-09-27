---
version: 1
name: codex-opencode-dropdown-fix
status: draft
mode: manual
base:
base_commit:
branch:
approved_rev:
---

# OVERVIEW

## Goal

Fix the model selectors so Codex and OpenCode use current valid dropdowns backed by live discovery results, while preserving custom values as editable "Other…" entries and keeping the last known-good list when discovery fails.

## Required fix

- Codex must use the live `codex app-server` discovery path: `initialize` -> `initialized` -> `model/list`, then read `result.data[*].model` plus the supported/default reasoning-effort metadata. The returned ids become the dropdown values; if discovery fails, times out, or returns malformed data, the last known-good list is kept and marked stale.
- OpenCode must use `opencode models` as the primary model source and `/api/model` as fallback. When neither succeeds, the previous model set is retained and the selector is marked stale instead of blanking out or staying free-text.
- Claude must not rely only on a generic curated list when a richer local model catalog exists. The discovery path should consider the local Claude model catalog in `~/.claude/cache/model-catalog/` as a source of valid current Claude models and effort levels. The spec should treat that catalog as an authoritative local fallback or confirmation source for Claude capabilities, while still keeping the existing curated table as a safe fallback when the cache is absent or stale.
- Antigravity and Claude remain on their supported closed sets. OpenCode remains the only provider/model-formatted agent, but it is still rendered as a dropdown-backed selector rather than a plain text input.
- Existing config values must round-trip unchanged. Any saved value not currently in the live list is preserved as an editable custom "Other…" entry so users do not lose valid data.
- Refresh results are additive: new live models are shown when available, stale values remain selectable, and the selector never silently rewrites a valid custom value.

## Current state

- `src/adapter/index.ts` still returns outdated or incomplete capability tables for Codex and OpenCode.
- `src/config/configPanel.ts` already preserves custom values, but the model list source is not refreshed from the live CLI/API output in the way the selectors expect.
- The config panel optionally keeps the "Other…" field flow, so the fix is in the capability discovery and option merge rather than in the form alone.
- Discovery failures must degrade gracefully: keep the last successful list and mark it stale instead of blanking the selector.
- Claude has a local cache at `~/.claude/cache/model-catalog/` that appears to contain the current valid model catalog and effort levels; the spec should treat this as a concrete Claude capability source to validate against the curated list.

## Design

### 1. Capability discovery

`agentCapabilities()` is the single source of truth for the model and effort dropdowns. Each adapter exposes the live current model ids and supported effort values from its native discovery command or API, with the curated table kept as fallback when discovery is unavailable or malformed.

- Codex: use `codex app-server`, then `model/list`, and map each item to `model` + supported/default reasoning efforts.
- OpenCode: use `opencode models` and fall back to `/api/model` when needed.
- Claude: consult the local Claude model cache under `~/.claude/cache/model-catalog/` as a concrete source of valid current models and effort levels; fall back to the curated table when the cache is missing, unreadable, or stale.
- Antigravity: remain on the curated set.

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

Tests cover Codex live-model parsing, OpenCode CLI/API fallback parsing, Claude local-cache parsing and fallback behavior, stale-list retention, config-panel round-trip of custom values, and selector behavior when discovery fails or returns partial data.

# TODOS

- [pending] T01 Add the Codex live discovery probe to the adapter capability flow: `codex app-server` + `initialize`/`initialized`/`model/list`, extracting current model ids and reasoning-effort metadata (files: src/adapter/codex.ts, src/adapter/index.ts, test/adapter.codex.test.ts)
- [pending] T02 Add the OpenCode discovery probe to the adapter capability flow: `opencode models` with `/api/model` fallback, preserving stale data on failure (files: src/adapter/opencode.ts, src/adapter/index.ts, test/adapter.opencode.test.ts)
- [pending] T03 Add the Claude local model-cache source for valid current models and effort levels from `~/.claude/cache/model-catalog/`, with curated fallback if the cache is missing or stale (files: src/adapter/claude.ts, src/adapter/index.ts, test/adapter.claude.test.ts)
- [pending] T04 Ensure the config panel merges refreshed live model lists with existing custom values and keeps them editable as "Other…" entries (files: src/config/configPanel.ts, src/activation/configPanelController.ts, media/config.js, test/configPanel.controller.test.ts)
- [pending] T05 Ensure stale or failed refreshes keep the last good model list and surface stale metadata without blanking the selector (files: src/adapter/index.ts, src/config/configPanel.ts, test/adapter.index.test.ts, test/configPanel.controller.test.ts)
- [pending] T06 Add or update tests to cover live discovery, cache-based Claude fallback, stale retention, and custom-value round-tripping for Codex/OpenCode selectors (files: test/adapter.index.test.ts, test/adapter.codex.test.ts, test/adapter.opencode.test.ts, test/adapter.claude.test.ts, test/configPanel.controller.test.ts, README.md)

# OVERVIEW

## Goal

Make the config panel's Codex and OpenCode model selectors current, valid dropdowns backed by live discovery, while custom values stay selectable and editable as "Other…" entries and a failed, timed-out or malformed refresh keeps the last known-good list marked stale. Claude and Antigravity keep their curated closed sets. This is the pending T16 of the model-selector-refresh spec, re-scoped from what the repository actually does today.

## What is actually broken (read-only findings)

The discovery pipeline exists end to end (`Adapter.discoverModels` → `ModelDiscoveryService` → `CatalogStore` → `agentCapabilities(snapshots)` → `configFormOptions` → `optionsChanged` → `media/config.js`), but four seams are wrong or unconnected:

1. **The config panel never receives live capabilities.** `src/extension.ts` calls `registerConfigPanel({ capabilities: agentCapabilities() })` with the frozen builtin table and never passes `getCapabilities` / `onDidChangeCapabilities`; the `CatalogStore` and `ModelDiscoveryService` are built only afterwards. `RegisterConfigPanelDeps` and `ConfigPanelController` already support the live seam (the T15 end-to-end test wires it by hand), so in a real window every refresh lands in the store and the panel keeps showing the curated `CODEX_MODELS` and the free-text OpenCode field. This is the root cause of "outdated Codex list" and "OpenCode is a text input".
2. **The Codex `model/list` parser does not match the app-server reply.** `codexModelsFromAppServer` accepts `models` / `items` / bare array but not `result.data`; it prefers `id` over `model`; and `effortsFromSupported` reads `effort` / `id` / `name` on object elements while the app-server sends `{ reasoningEffort, description }`. The request also sends `params: {}` (no `includeHidden`, no `limit`, no `nextCursor` handling). A real reply therefore parses to `[]`, `discoverModels` resolves `undefined`, the service applies `err("codex model discovery returned no models")` and the builtin list is marked stale on every reload.
3. **OpenCode precedence is inverted.** `OpencodeAdapter.discoverModels` GETs `/api/model` first (starting an `opencode serve` child on every refresh) and only unions `opencode models` stdout afterwards. The requirement is `opencode models` primary, `/api/model` fallback when available.
4. **Custom values are flattened into ordinary options.** `configFormOptions` appends a configured-but-unlisted model as a plain id in `models`, so the webview renders it as a normal dropdown option, not as an editable "Other…" entry; `AgentFormCapability` carries no `modelEntries`, so labels, per-model `efforts`, `defaultEffort` and `custom` markers (which `capabilitiesFromEntries` and `mergePreservingExisting` already produce) never reach the webview. The Codex per-model reasoning-effort metadata is lost at this seam.

Everything else needed already exists and is kept: `CatalogStore.applyResult` (failure keeps the previous list, sets `stale`/`staleReason`, persists), `overlayCapabilities` (an empty refreshed list never wipes a curated one), `configFormOptions` round-tripping out-of-set agent/model/effort, the `optionsChanged` protocol message, the in-place `syncSelectOptions` and the sticky `otherModel` / `otherEffort` flags in `media/config.js`.

## Design

### 1. Codex: parse the real `model/list` reply (`src/adapter/codex.ts`)

- Send `model/list` with `params: { includeHidden: true, limit: <a reasonable page size, e.g. 100> }`; while the reply carries a non-empty `nextCursor` and the timebox has budget, send further `model/list` requests (new ids 3, 4, …) with `cursor` and concatenate the pages; a failed or timed-out follow-up page settles with the pages already received rather than `undefined`.
- `codexModelsFromAppServer` additionally accepts an object whose `data` is an array (preferred over `models` / `items`), takes the id from `model` first (then `id`, then `slug`), and `effortsFromSupported` additionally reads `reasoningEffort` on object elements. `defaultReasoningEffort` handling is unchanged. Hidden models are kept (the id is still valid to launch with).
- The handshake, JSONL framing, kill-on-every-path, timeout clamp and `undefined`-on-failure contract stay exactly as they are; the curated `CODEX_MODELS` / `CODEX_EFFORTS` remain the builtin fallback.

### 2. OpenCode: `opencode models` first, `/api/model` fallback (`src/adapter/opencode.ts`)

- `discoverModels` runs `opencode models` first (within the shared budget). When it yields at least one `provider/model` entry, that list is the result and no server is started, no request is made.
- Only when the CLI is unavailable, fails, times out or yields nothing does it fall back to `/api/model`: a pre-existing server (`serverBaseUrl` / `OPENCODE_SERVER`) or one `opencode serve` child on loopback with an ephemeral port, disposed exactly once. `mergeOpencodeModelSources` is kept for the fallback (CLI entries, then API entries), or simplified accordingly.
- Both empty → `undefined` ("keep the last known-good list"), never the curated list. Efforts stay `[]` (free-text `--variant`), `modelLink` stays on the builtin, and provenance is still stamped by the store.

### 3. Wire the live table into the config panel (`src/extension.ts`)

- Build the `CatalogStore` and `ModelDiscoveryService` before `registerConfigPanel`, and pass `getCapabilities: () => agentCapabilities(catalogStore.table())` and `onDidChangeCapabilities: (l) => discovery.onDidChange(() => l())` (returning the disposable). Keep `capabilities: agentCapabilities()` as the static fallback the controller already prefers last. `registerConfigPanel` and `ConfigPanelController` need no behavioural change; update the doc comment in `src/activation/configPanel.ts` that claims the wiring is a separate step.
- Ordering guarantee: the store is seeded (persisted `cached` snapshots or curated builtins) before the panel's first `load()`, so the first `loaded` already shows last known-good lists and every later `applyResult` reaches the open panel as `optionsChanged` without touching edits.

### 4. Carry rich entries and custom markers through the option merge (`src/config/configPanel.ts`, controller)

- `AgentFormCapability` gains optional `modelEntries: readonly { id; label?; efforts?; defaultEffort?; custom? }[]` (declared locally, mirroring `ModelEntry`, to keep the module import-free of adapter/orchestrator code). `configFormOptions` copies `modelEntries` from the capability (falling back to `{ id }` per model when absent) and, when it appends a form model that the list lacks, appends a matching `{ id, custom: true }` entry using the same rules as `mergePreservingExisting` (trim; skip blank, duplicate and already-present values; refreshed ids stay first, custom ones last). Appended out-of-set efforts stay in `efforts` as today. `models` keeps containing the custom id so `validateConfigForm`, the mirror validator, host-side re-validation and the existing round-trip tests are unchanged.
- `agentStaleness` is unchanged. `ConfigPanelController.refreshOptions()` / `load()` need no change beyond the richer options flowing through; the controller test gains cases for the entries/custom markers reaching `loaded` and `optionsChanged`. Only ids, labels, effort names and stale metadata cross to the webview.

### 5. Webview rendering (`media/config.js`, `media/config.html`)

- Dynamic model options are built from `modelEntries` when present: value = id, text = label (or id), and entries with `custom: true` are NOT rendered as ordinary options. A role whose model matches a custom entry (or is absent from the list) renders in the "Other…" state: the select shows "Other…", the text input is visible with the value and stays editable; the sticky `otherModel` flag keeps working. `syncSelectOptions` keeps its in-place, focus-preserving contract (compare by value and text).
- OpenCode: with a non-empty list the model control is the dropdown plus "Other…" exactly like the other agents, the documentation link stays visible, and the free-text input is shown only while the list is empty (first window before any snapshot).
- Codex effort dropdown: when the selected model's entry carries `efforts`, the dynamic effort options are that model's list (else the agent-level union); when it carries `defaultEffort`, the static `(default)` option reads `(default: <effort>)`. Validation stays against the agent-level union so a saved effort of another model is never rejected. Switching models re-syncs the effort options without resetting an "Other…" effort.
- Stale note unchanged ("stale — showing last known models"). The mirror block (`validateConfigForm`) is unchanged or updated in both places; `test/configPanel.mirror.test.ts` must still pass.

### 6. Fail-safe behaviour (no new mechanism; verified end to end)

A refresh that fails, times out or returns malformed data resolves `undefined` in the adapter, becomes `err(...)` in the service, and `CatalogStore.applyResult` keeps the previous `models`/`efforts`/`fetchedAt`/`source` with `stale: true` and a reason; `overlayCapabilities` never replaces a non-empty list with an empty one; `configFormOptions` re-appends configured values; the webview replaces options in place and shows the stale note. A stale or failed refresh never blanks a selector and never rewrites a custom value. The end-to-end suite (`test/modelSelectorRefresh.test.ts`) gains the Codex `data`-shaped reply, the OpenCode CLI-first path, malformed-data staleness and the custom-as-Other… round-trip, and README's discovery section is corrected to describe the new sources, precedence and the Other… behaviour.

## Constraints honoured

- Specification only; the fix reuses the existing capability/discovery flow and `configFormOptions` merge; no ad hoc selector path.
- Codex and OpenCode launch/attach argv, permission mapping, session handling and ask-relay wiring are untouched; only the model source and selector rendering change.
- Antigravity and Claude stay on their curated closed sets (Claude still overlays the models.dev list with `claude-sonnet-5` always present; antigravity is never overlaid).
- Discovery stays asynchronous, timeboxed, never awaited by activation, reads no secrets; webviews receive ids, labels, effort names and stale metadata only.
- Existing `.baiton/config.json` values round-trip unchanged; legacy/custom values are never silently rewritten or dropped.

## Testing

Unit: Codex parser accepts `data`, prefers `model`, reads `reasoningEffort`, sends `includeHidden`/`limit`, follows `nextCursor`, and still degrades to `undefined` on malformed/empty/timeout; OpenCode runs the CLI first, starts no server when the CLI succeeds, falls back to `/api/model` only when the CLI is empty or fails, and resolves `undefined` when both fail; `configFormOptions` emits `modelEntries` with `custom: true` for appended values while `models`/`efforts` and validation are unchanged; controller posts the richer options in `loaded` and `optionsChanged`. Webview (fake-DOM pattern of `test/configPanel.view.test.ts`): custom entry renders as Other… with an editable input, OpenCode switches from text input to dropdown when a list arrives, Codex per-model efforts and default label, stale note. Activation: `registerConfigPanel` receives `getCapabilities` and `onDidChangeCapabilities` bound to the store and discovery service. End to end: reload refresh reaches an open panel, failure after success keeps the last good list stale, malformed data never blanks, custom values survive as Other…; README updated.

# TODOS

- [pending] T01 Fix Codex app-server model discovery: request model/list with includeHidden and limit, follow nextCursor, parse result.data entries by their `model` id and read `reasoningEffort` objects in supportedReasoningEfforts, keeping the undefined-on-failure contract (files: src/adapter/codex.ts, test/adapter.codex.test.ts, README.md)
- [pending] T02 Make `opencode models` the primary OpenCode model source and `/api/model` the fallback used only when the CLI is unavailable or yields nothing, starting no server on the primary path and resolving undefined when both fail (files: src/adapter/opencode.ts, test/adapter.opencode.test.ts, README.md)
- [pending] T03 Wire the live catalog into the config panel: build CatalogStore and ModelDiscoveryService before registerConfigPanel in extension.ts and pass getCapabilities (agentCapabilities(store.table())) plus onDidChangeCapabilities (discovery.onDidChange), so refreshes reach the panel as optionsChanged (files: src/extension.ts, src/activation/configPanel.ts, test/activation.gating.test.ts, test/modelSelectorRefresh.test.ts)
- [pending] T04 Carry modelEntries (label, per-model efforts, defaultEffort, custom) through AgentFormCapability and configFormOptions, marking configured-but-unlisted models custom with mergePreservingExisting rules while keeping models/efforts, validation and round-trip unchanged (files: src/config/configPanel.ts, src/activation/configPanelController.ts, src/adapter/index.ts, test/configPanel.test.ts, test/configPanel.controller.test.ts, test/adapter.index.test.ts)
- [pending] T05 Render custom model entries as editable Other… in the config webview, show OpenCode as a dropdown once a list exists, use labels and per-model Codex efforts with the default effort shown, and keep in-place option sync, stale notes and the validator mirror intact (after T04; files: media/config.js, media/config.html, test/configPanel.view.test.ts, test/configPanel.mirror.test.ts)
- [pending] T06 Add end-to-end coverage for the corrected Codex and OpenCode sources reaching an open panel, failed/timed-out/malformed refreshes keeping the last known-good list marked stale without blanking, and custom values surviving as Other…, and update the README discovery section (after T01, T02, T03, T05; files: test/modelSelectorRefresh.test.ts, test/modelDiscovery.test.ts, README.md)
