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
