# Plan T03

## Steps

1. Add the discovery vocabulary to the adapter boundary (types only, no behaviour)

   In src/adapter/adapter.ts, below the existing `import type { Role } from '../model/role';`, add two type-only imports that keep the module host-free and cycle-free (import the MODULES directly, never the barrels '../orchestrator' or './index'):

     import type { CatalogFetch, ModelEntry, SnapshotSource } from '../orchestrator/modelCatalog';
     import type { ModelsDevFeed } from '../orchestrator/modelsDev';

   Both target modules import only `../model/result`, so no import cycle is created.

   Then add, after the `AGENT_BINARY` const and before `AgentCapabilities`:

   1. `export const DEFAULT_DISCOVERY_TIMEOUT_MS = 8_000;` — doc: the per-source ceiling an adapter's `discoverModels` must respect when `ctx.timeoutMs` is not narrower; the discovery service (later todo) owns the real budget.

   2. `export interface DiscoveryContext` with all-readonly fields and a doc comment saying discovery is best-effort, timeboxed and must never throw:
      - `readonly timeoutMs: number;` — hard wall-clock budget for this one call.
      - `readonly signal?: AbortSignal;` — aborts the call early (window teardown / a newer refresh); implementations must stop work and resolve `undefined`. (AbortSignal is available: lib is ES2022 and src/orchestrator/modelClient.ts already uses it.)
      - `readonly cwd?: string;` — absolute workspace root for CLI-based discovery (`codex app-server`, `opencode serve`).
      - `readonly feed?: ModelsDevFeed;` — the models.dev feed already fetched in this refresh, so the claude adapter derives its list without a second network call.
      - `readonly log?: (message: string) => void;` — diagnostic sink; absent means discard.

   3. `export const AGENT_CATALOG_SOURCE: Readonly<Partial<Record<AgentId, CatalogSourceId>>> = { claude: 'claude', codex: 'codex', opencode: 'opencode' };` (add `CatalogSourceId` to the modelCatalog type import). Doc: which CatalogStore source id an agent's models come from; `antigravity` is deliberately ABSENT — its curated `ANTIGRAVITY_MODELS` catalogue and `antigravityModelFlags` mapping are never overlaid.

   Files: `src/adapter/adapter.ts`

2. Widen AgentCapabilities with additive discovery metadata

   Still in src/adapter/adapter.ts, extend `AgentCapabilities` with optional readonly fields ONLY (every existing consumer — `configFormOptions` in src/config/configPanel.ts via the structurally identical `AgentFormCapability`, src/activation/configPanelController.ts, src/extension.ts:169 — keeps compiling untouched):

     export interface AgentCapabilities {
       readonly models: readonly string[];
       readonly efforts: readonly string[];
       readonly modelLink?: string;
       /** Rich per-model detail behind `models` (per-model efforts, defaultEffort, provider, custom). Same order/length as `models` when present. */
       readonly modelEntries?: readonly ModelEntry[];
       /** Where this list came from in this window; absent means the curated builtin table with no refresh applied. */
       readonly source?: SnapshotSource;
       /** True when the last refresh for this agent's source failed and the list is last-known-good. */
       readonly stale?: boolean;
       /** Human-readable reason; present only with `stale: true`. */
       readonly staleReason?: string;
       /** ISO-8601 time of the last SUCCESSFUL fetch for this agent's source. */
       readonly fetchedAt?: string;
     }

   Add two pure helpers in the same file (they must live here, not in index.ts, so the per-CLI adapters can use them in later todos without importing the barrel):

     export function capabilitiesFromEntries(entries: readonly ModelEntry[], options?: { efforts?: readonly string[]; modelLink?: string; source?: SnapshotSource; stale?: boolean; staleReason?: string; fetchedAt?: string }): AgentCapabilities

     - `models` = `entries.map(e => e.id)` (fresh array);
     - `efforts` = `options.efforts` when non-undefined, else the de-duplicated union of every `entry.efforts` in first-seen order, else `[]`;
     - `modelEntries` = `[...entries]`;
     - every optional field is added CONDITIONALLY (never written as an explicit `undefined` own key), matching the `normalizeModelEntry` style already used in src/orchestrator/modelCatalog.ts;
     - pure, never throws, never mutates the input.

     export function capabilitiesToCatalogFetch(caps: AgentCapabilities): CatalogFetch

     - `models` = `caps.modelEntries` when present, else `caps.models.map(id => ({ id }))`;
     - `efforts` set only when `caps.efforts.length > 0`.
     This is the bridge the discovery service will hand to `CatalogStore.applyResult`.

   Finally add the seam to the `Adapter` interface, after `relayFiles?`, with a doc comment in the same voice as `discoverSessionId?`:

     discoverModels?(ctx: DiscoveryContext): Promise<AgentCapabilities | undefined>;

     Doc must state: optional; resolves the agent's freshly discovered models/efforts, or `undefined` when discovery is unavailable or failed; MUST never throw (any internal error resolves `undefined`); MUST honour `ctx.signal` and finish within `ctx.timeoutMs`, tearing down any child process or socket it started; MUST NOT read secrets — only model ids and labels leave the host. No adapter implements it in this todo; the per-CLI implementations land in later todos, and antigravity never will.

   Files: `src/adapter/adapter.ts`

3. Split agentCapabilities() into a curated builtin table plus a snapshot overlay

   In src/adapter/index.ts:

   1. Add imports: `import { mergePreservingExisting, modelIds } from '../orchestrator/modelCatalog';` and `import type { ModelCatalogSnapshot, ModelCatalogTable } from '../orchestrator/modelCatalog';`, and add `AGENT_CATALOG_SOURCE` to the existing value import from './adapter' (keep `AgentCapabilities` in the type-only import).

   2. Rename today's body to `export function builtinAgentCapabilities(): Record<AgentId, AgentCapabilities>` — byte-identical content to the current `agentCapabilities()` body (claude/opencode/antigravity/codex literals, fresh copied arrays, `modelLink: OPENCODE_MODEL_DOC_URL` for opencode, `Object.keys(ANTIGRAVITY_MODELS)` for antigravity) and keep the existing doc comment on it. Exporting it also gives the discovery service its `CatalogStore` builtin seeds later.

   3. `export function agentCapabilities(snapshots?: ModelCatalogTable): Record<AgentId, AgentCapabilities>`:

      const table = builtinAgentCapabilities();
      if (snapshots === undefined) { return table; }   // no-snapshot path is byte-identical to today: NO metadata keys added
      for (const agent of Object.keys(table) as AgentId[]) {
        const sourceId = AGENT_CATALOG_SOURCE[agent];
        if (sourceId === undefined) { continue; }       // antigravity: never overlaid
        const snapshot = snapshots[sourceId];
        if (snapshot === undefined) { continue; }       // source not refreshed yet: curated list, no metadata
        table[agent] = overlayCapabilities(agent, table[agent], snapshot);
      }
      return table;

   4. Private `function overlayCapabilities(agent: AgentId, builtin: AgentCapabilities, snapshot: ModelCatalogSnapshot): AgentCapabilities`, with these exact rules:
      - claude only: `snapshot = mergePreservingExisting(snapshot, [CLAUDE_DEFAULT_MODEL])` first, where `const CLAUDE_DEFAULT_MODEL = 'claude-sonnet-5';` is a module-local const documented as the `defaultConfig()` default that must always remain selectable. Reusing the T01 helper appends it as `{ id, custom: true }` at the END only when the refreshed list lacks it.
      - ids = `modelIds(snapshot)`. When `ids.length === 0`, the refreshed list never replaces the curated one: keep `builtin.models`, `builtin.efforts` and `builtin.modelLink`, omit `modelEntries`, and still carry `source: 'builtin'` plus `stale`/`staleReason`/`fetchedAt` from the snapshot (so the panel can still say "stale"). Note this is the normal, correct path for an opencode snapshot with no models: the free-text shape (`models: []`, `efforts: []`, `modelLink`) survives.
      - Otherwise build via `capabilitiesFromEntries([...snapshot.models], { ... })` with:
          * `efforts`: `snapshot.efforts` when it is a non-empty array; else the union of the entries' own `efforts` when any entry has them (codex `supportedReasoningEfforts`); else `[...builtin.efforts]` (claude keeps `low|medium|high`; codex falls back to `CODEX_EFFORTS`; opencode's empty builtin keeps free-text efforts).
          * `modelLink`: `builtin.modelLink` when set (opencode keeps its doc URL even once discovery produces a real list).
          * `source: snapshot.source`, `stale: snapshot.stale`, `staleReason: snapshot.staleReason` (only when defined), `fetchedAt: snapshot.fetchedAt`.
      - Returns a fresh object with fresh arrays on every call — the existing "non-aliased copies" contract must hold for the overlay path too.

   5. Update the `agentCapabilities` doc comment: it is still the single source of truth for model/effort options; with no argument it returns the curated builtin table (the fallback used at activation before any refresh lands), with a `ModelCatalogTable` it overlays the refreshed per-source lists and carries `source`/`stale`/`staleReason`/`fetchedAt` through; antigravity is never overlaid; `claude-sonnet-5` is always present for claude; an empty refreshed list never wipes a curated one.

   Do NOT touch src/extension.ts, src/activation/configPanelController.ts or src/config/configPanel.ts in this todo — `agentCapabilities()` with no argument keeps its current behaviour and signature compatibility, and the live-capabilities wiring is a later todo.

   Files: `src/adapter/index.ts`

4. Document antigravity's deliberate opt-out of discovery

   src/adapter/antigravity.ts gets documentation only — zero behaviour change, argv byte-identical.

   1. Extend the doc block above `ANTIGRAVITY_MODELS` (currently ending '…with "Other…" for anything newer.') with a sentence: this curated catalogue is authoritative — the antigravity adapter implements no `Adapter.discoverModels`, `AGENT_CATALOG_SOURCE` has no `antigravity` entry, and `agentCapabilities(snapshots)` therefore never overlays refreshed models onto it, because `antigravityModelFlags` maps model+effort to agy's suffixed ids and a discovered id list could not carry that mapping. Refresh it by hand from `agy models`.

   2. Inside `class AntigravityAdapter`, next to the `acceptsSessionId` declaration, add a comment-only note (no member) recording the same decision, in the style of the existing degrade notes: `// No `discoverModels`: see ANTIGRAVITY_MODELS — the curated catalogue plus `antigravityModelFlags` stays the sole source of agy model/effort options.`

   Do not add a `discoverModels` stub returning `undefined`: the absent optional member is what the seam and the tests assert.

   Files: `src/adapter/antigravity.ts`

5. Extend test/adapter.index.test.ts for the seam and the overlay

   Keep every existing `describe` block passing unchanged (they pin the no-argument behaviour). Add imports: `agentCapabilities, builtinAgentCapabilities, createAdapterRegistry, askRelayKind, usesConfigDrivenAskRelay` from '../src/adapter'; `AGENT_BINARY, AGENT_CATALOG_SOURCE, capabilitiesFromEntries, capabilitiesToCatalogFetch` from '../src/adapter/adapter'; `isCatalogSourceId` and types from '../src/orchestrator/modelCatalog'; `CODEX_EFFORTS`, `CLAUDE_EFFORTS`, `OPENCODE_MODEL_DOC_URL`, `ANTIGRAVITY_MODELS` as needed.

   Add a local fixture helper:
     function snap(sourceId: CatalogSourceId, models: readonly (string | ModelEntry)[], extra: Partial<ModelCatalogSnapshot> = {}): ModelCatalogSnapshot — builds `{ sourceId, models: models.map(m => typeof m === 'string' ? { id: m } : m), fetchedAt: '2026-01-02T03:04:05.000Z', source: 'live', stale: false, ...extra }`.

   New `describe('agentCapabilities snapshot overlay')` cases:
     1. no argument ⇒ deepStrictEqual to `builtinAgentCapabilities()`, and for every agent the object has NONE of the keys `modelEntries|source|stale|staleReason|fetchedAt` (`Object.prototype.hasOwnProperty` per key) — guards the existing config-panel consumers against shape drift.
     2. empty table `{}` ⇒ deepStrictEqual to `agentCapabilities()`.
     3. claude overlay: `{ claude: snap('claude', ['claude-opus-5-5', 'claude-sonnet-5']) }` ⇒ claude.models is exactly that list in order, `source: 'live'`, `stale: false`, `fetchedAt` carried, `efforts` deepStrictEqual `[...CLAUDE_EFFORTS]`, `modelEntries` length matches models.
     4. claude default always present: snapshot WITHOUT `claude-sonnet-5` ⇒ `models` ends with `'claude-sonnet-5'` and its `modelEntries` last entry has `custom: true`; a snapshot that already lists it ⇒ no duplicate (`models.filter(m => m === 'claude-sonnet-5').length === 1`).
     5. codex per-model efforts: entries `[{ id: 'gpt-6-astra', efforts: ['low','medium'], defaultEffort: 'medium' }, { id: 'o3', efforts: ['high'] }]` with no snapshot-level `efforts` ⇒ `efforts` deepStrictEqual `['low','medium','high']` (union, first-seen order) and `modelEntries[0].defaultEffort === 'medium'`; the same entries with snapshot-level `efforts: ['none','xhigh']` ⇒ that list wins.
     6. codex with entries but no efforts anywhere ⇒ `efforts` deepStrictEqual `[...CODEX_EFFORTS]`.
     7. opencode overlay: `snap('opencode', ['anthropic/claude-sonnet-5','openai/gpt-6-astra'])` ⇒ those models, `modelLink` still `OPENCODE_MODEL_DOC_URL`; and `snap('opencode', [])` ⇒ free-text shape preserved (`models: []`, `efforts: []`, `modelLink` present) with `source: 'builtin'` and the snapshot's stale metadata.
     8. stale snapshot: `snap('claude', ['claude-sonnet-5'], { stale: true, staleReason: 'feed unreachable', source: 'cached' })` ⇒ models kept, `stale === true`, `staleReason === 'feed unreachable'`, `source === 'cached'`.
     9. empty refreshed list never wipes the curated list: `snap('codex', [], { stale: true, staleReason: 'app-server timed out' })` ⇒ `models` deepStrictEqual `builtinAgentCapabilities().codex.models`, `source === 'builtin'`, `stale === true`, no `modelEntries` key.
     10. antigravity untouched: with a fully populated table for all four sources, `deepStrictEqual(agentCapabilities(table).antigravity, agentCapabilities().antigravity)` and its models still equal `Object.keys(ANTIGRAVITY_MODELS)`.
     11. freshness holds on the overlay path: two calls with the same table are deepStrictEqual but `notStrictEqual` per agent, per `models`, per `efforts`, and mutating one must not affect the other (mirrors the existing aliasing test).

   New `describe('AGENT_CATALOG_SOURCE')`: keys are a subset of `Object.keys(AGENT_BINARY)`, contains claude/codex/opencode, `AGENT_CATALOG_SOURCE.antigravity === undefined`, and every value satisfies `isCatalogSourceId`.

   New `describe('discoverModels seam')`: for every id in `createAdapterRegistry().ids`, `registry.require(id).discoverModels` is either `undefined` or a function; assert explicitly that `createAdapterRegistry().require('antigravity').discoverModels === undefined`.

   New `describe('capability helpers')`: `capabilitiesFromEntries([])` ⇒ `{ models: [], efforts: [] }` with no extra own keys; entries + `{ source: 'live', stale: true, staleReason: 'x', fetchedAt: 't' }` ⇒ those carried and `modelEntries` copied (`notStrictEqual` to the input array); `capabilitiesToCatalogFetch` round-trips ids and omits `efforts` when the capability's efforts are empty.

   Files: `test/adapter.index.test.ts`

6. Verify

   Run, from the repo root: `npx tsc --noEmit -p tsconfig.json` (exit 0); `npm run compile` (exit 0); `npx eslint src/adapter/adapter.ts src/adapter/index.ts src/adapter/antigravity.ts test/adapter.index.test.ts --ext .ts` (clean); `npx mocha test/adapter.index.test.ts`; then `npm run test:unit`. Expect the single PRE-EXISTING failure 'packaging gating: includes zero native modules' (the keytar/node_modules check in test/activation.gating.test.ts, documented at baseline in the T01 run) and no other failures. Also confirm `git diff --stat` touches only the four files above.

   Files: `src/adapter/adapter.ts`, `src/adapter/index.ts`, `src/adapter/antigravity.ts`, `test/adapter.index.test.ts`

## Risks

- Import cycle: src/adapter/adapter.ts must import '../orchestrator/modelCatalog' and '../orchestrator/modelsDev' as type-only imports of the MODULES, never the '../orchestrator' barrel (which also pulls providers/webview code) and never './index'. Both modules import only '../model/result', so a direct type-only import is safe.
- Shape drift breaking the config panel: src/config/configPanel.ts declares AgentFormCapability structurally (models/efforts/modelLink) and receives Record<AgentId, AgentCapabilities> through configFormOptions. Extra optional properties are fine for a non-literal assignment, but the no-snapshot path must add no new own keys or deepStrictEqual assertions in test/configPanel.*.test.ts and test/fixtures/configFormCases.ts could start failing.
- Optional fields written as explicit `undefined` own keys would break deepStrictEqual comparisons and the persisted-blob shape; follow modelCatalog.ts's conditional-assignment style everywhere.
- Overwriting a curated list with an empty discovered list would silently empty the claude/codex dropdowns; the 'empty never replaces' rule plus test case 9 is the guard. The mirror-image trap is opencode, where an empty list is the intended free-text shape — keep modelLink in both branches.
- Antigravity regression: any overlay reaching antigravity would change the config-panel model list and, downstream, antigravityModelFlags' suffix mapping. The guard is structural (no `antigravity` key in AGENT_CATALOG_SOURCE, no `antigravity` CatalogSourceId) plus test case 10.
- `claude-sonnet-5` is hardcoded in this todo as the always-present default; if defaultConfig() ever changes its default model the constant must move with it — the existing "defaultConfig()'s model and effort are members of the claude lists" test only covers the no-snapshot path.
- AbortSignal in DiscoveryContext relies on lib ES2022 with no DOM lib; it already compiles elsewhere (src/orchestrator/modelClient.ts), but a stray `fetch`/`Response` type in the new code would not.
- noUnusedLocals/noUnusedParameters are on: a type imported for documentation only but not referenced will fail the build.

## Acceptance

- src/adapter/adapter.ts exports DiscoveryContext, DEFAULT_DISCOVERY_TIMEOUT_MS, AGENT_CATALOG_SOURCE, capabilitiesFromEntries and capabilitiesToCatalogFetch, and Adapter declares the optional `discoverModels?(ctx: DiscoveryContext): Promise<AgentCapabilities | undefined>` with a doc comment stating it never throws, honours ctx.signal/timeoutMs and leaks no secrets.
- AgentCapabilities carries the additive optional fields modelEntries, source, stale, staleReason and fetchedAt; models/efforts/modelLink are unchanged and still required/optional as before.
- `agentCapabilities()` with no argument returns exactly what it returns today (deepStrictEqual to builtinAgentCapabilities(), no new own keys), and builtinAgentCapabilities() is exported.
- `agentCapabilities(table)` overlays the claude/codex/opencode entries from the matching CatalogStore snapshots, carries source/stale/staleReason/fetchedAt, and always includes 'claude-sonnet-5' in the claude list exactly once.
- A snapshot with zero models leaves the curated models/efforts in place (source 'builtin') while still reporting the snapshot's stale metadata; opencode keeps its modelLink in every branch.
- agentCapabilities(table).antigravity is deepStrictEqual to agentCapabilities().antigravity for any table, no adapter implements discoverModels yet, and createAdapterRegistry().require('antigravity').discoverModels is undefined; src/adapter/antigravity.ts changes are comments only.
- Both paths still return fresh, non-aliased objects and arrays on every call.
- No file outside src/adapter/adapter.ts, src/adapter/index.ts, src/adapter/antigravity.ts and test/adapter.index.test.ts is modified.
- `npx tsc --noEmit -p tsconfig.json` and `npm run compile` exit 0; eslint is clean on the four touched files; `npm run test:unit` shows the new adapter.index cases passing and no failures other than the pre-existing 'packaging gating: includes zero native modules' keytar assertion.
