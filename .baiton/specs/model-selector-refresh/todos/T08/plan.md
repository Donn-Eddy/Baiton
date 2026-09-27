# Plan T08

## Steps

1. Add the stale/metadata vocabulary and the `optionsChanged` message to the host-free config-panel protocol

   In `src/config/configPanel.ts` (no `vscode`, no Node imports — keep it that way):

   1. Extend `AgentFormCapability` with four OPTIONAL readonly fields, declared locally so the module stays free of adapter imports while staying structurally assignable from `AgentCapabilities` (`src/adapter/adapter.ts`, which already carries exactly these): `readonly source?: 'live' | 'cached' | 'builtin';` `readonly stale?: boolean;` `readonly staleReason?: string;` `readonly fetchedAt?: string;`. Document that an absent `source` means the curated builtin table with no refresh applied.

   2. Add an exported interface `AgentStaleness { readonly stale: boolean; readonly reason?: string; readonly fetchedAt?: string; }` — the per-agent staleness the webview renders as "stale — showing last known models".

   3. Add an exported pure builder `export function agentStaleness(byAgent: Readonly<Record<string, AgentFormCapability>>): Record<string, AgentStaleness>`: for every key of `byAgent`, emit an entry ONLY when `cap.stale === true` OR `cap.fetchedAt !== undefined` (so an untouched builtin table produces `{}` and the webview shows no badge); set `stale: cap.stale === true`, and add `reason` from `cap.staleReason` and `fetchedAt` from `cap.fetchedAt` CONDITIONALLY (never as explicit `undefined` own keys — same style as `capabilitiesFromEntries` and `normalizeModelEntry`). Never mutates its input.

   4. Add the new host→webview variant to `ConfigPanelHostToWebview`, after `loaded`, with a doc comment saying the option lists were refreshed out-of-band and the webview must replace them in place without touching the user's edits:
      `| { type: 'optionsChanged'; options: ConfigFormOptions; stale: Record<string, AgentStaleness> }`

   5. In `configFormOptions`, carry the four metadata fields through into each `byAgent` entry when copying from `capabilities`, each added CONDITIONALLY. Widen the local accumulator type from `Record<string, { models: string[]; efforts: string[]; modelLink?: string }>` to include `source?: 'live' | 'cached' | 'builtin'; stale?: boolean; staleReason?: string; fetchedAt?: string`. Everything else in `configFormOptions` is unchanged — in particular the existing block that appends the form's out-of-set agent/model/effort values stays exactly as it is, because that is what makes a configured-but-no-longer-listed model or effort keep round-tripping after a refresh.

   6. Do NOT touch `validateConfigForm`, `formFromConfig`, `formFromDocument`, `applyFormToDocument` or `LIMIT_BOUNDS`: `media/config.js` mirrors only those, and `test/configPanel.mirror.test.ts` / `test/configPanel.mirror.property.test.ts` must keep passing without a media change (the webview half of design §5 is a separate todo).

   Files: `src/config/configPanel.ts`

2. Make the controller read capabilities from a live source and re-post refreshed options

   In `src/activation/configPanelController.ts`:

   1. Extend `ConfigPanelControllerDeps` additively (do not remove `capabilities?`, so existing callers and tests keep compiling):
      - `getCapabilities?(): Readonly<Record<string, AgentCapabilities>>;` — read on EVERY use, never hoisted.
      - `onDidChangeCapabilities?(listener: () => void): { dispose(): void };` — fires when the discovery service lands a new catalog.
      Document the precedence: `getCapabilities()` → `capabilities` → `agentCapabilities()`.

   2. Replace the frozen `private readonly capabilities` field (set in the constructor) with a private accessor `private currentCapabilities(): Readonly<Record<string, AgentCapabilities>> { return this.deps.getCapabilities?.() ?? this.deps.capabilities ?? agentCapabilities(); }`. The constructor keeps initialising `this.options = configFormOptions(deps.agentIds, this.currentCapabilities())` so `save` before any `load` still validates.

   3. Remember the last form parsed from disk: add `private form: ConfigForm | undefined;`, assigned in `load()` next to `this.doc`/`this.token` (and left untouched on `loadFailed`). `load()` now calls `configFormOptions(this.deps.agentIds, this.currentCapabilities(), form)`, i.e. the live table instead of the constructor snapshot. The posted `loaded` message is otherwise byte-identical.

   4. Add `public refreshOptions(): void`: return immediately when `this.disposed`; otherwise recompute `this.options = configFormOptions(this.deps.agentIds, this.currentCapabilities(), this.form)` and post `{ type: 'optionsChanged', options: this.options, stale: agentStaleness(this.options.byAgent) }`. It deliberately does NOT re-post `loaded` and does not read the file, so an open panel's in-progress edits are never overwritten. Passing `this.form` is the round-trip guarantee: an agent/model/effort that is in `.baiton/config.json` but missing from the refreshed lists is appended again, exactly as on load. Log one line (`ConfigPanelController: model options refreshed (...)`) via `this.deps.log`.

   5. Subscribe in `start()`, once. Add `private capabilitySub: { dispose(): void } | undefined;` and, at the end of `start()`, `if (this.capabilitySub === undefined && this.deps.onDidChangeCapabilities !== undefined) { this.capabilitySub = this.deps.onDidChangeCapabilities(() => this.refreshOptions()); }`. The guard matters: `registerConfigPanel`'s `ensureController()` calls `controller.start()` again on every re-resolve of the view, and a second subscription would post duplicate `optionsChanged` messages. Wrap the listener body so a throw cannot escape into the host event loop (reuse the existing `catch` style: log `ConfigPanelController: unexpected error handling optionsChanged: <message>` and swallow).

   6. In `dispose()`, dispose and clear `this.capabilitySub` before/after setting `this.disposed = true`, so a late capability event posts nothing (same silence contract as `notifyExternalChange`).

   7. Update the module header comment: the "Passing `form` into `configFormOptions` during load is load-bearing" paragraph now also covers `refreshOptions()`.

   Files: `src/activation/configPanelController.ts`

3. Plumb the live capability source through the view registration

   In `src/activation/configPanel.ts`:

   1. Extend `RegisterConfigPanelDeps` additively, mirroring the controller deps and keeping `capabilities?` untouched:
      `getCapabilities?(): Readonly<Record<string, AgentCapabilities>>;`
      `onDidChangeCapabilities?(listener: () => void): vscode.Disposable;`
      Comment that the caller wires these to `agentCapabilities(store.table())` and `discovery.onDidChange(...)`; when both are absent the panel keeps today's static behaviour, which is why `src/extension.ts` needs no change in this todo (it builds the `CatalogStore`/`ModelDiscoveryService` AFTER `registerConfigPanel`, so the wiring is a separate step).

   2. In `ensureController()`, forward both to the `ConfigPanelController` constructor alongside the existing `capabilities: deps.capabilities`:
      `...(deps.getCapabilities !== undefined ? { getCapabilities: () => deps.getCapabilities!() } : {})`, and likewise for `onDidChangeCapabilities` (pass a thin arrow so the dep object is not captured by identity). Keeping the spread conditional preserves the `getCapabilities → capabilities → agentCapabilities()` precedence for callers that pass neither.

   3. `teardown()` already calls `controller.dispose()`, which now disposes the capability subscription — no extra bookkeeping in `registerConfigPanel`. Do not add a registration-level subscription: with no controller there is no webview to post to, and the next `ensureController()` reads the live table anyway.

   4. Leave `ConfigPanelProvider` untouched; its `post`/`pending` buffer already carries any `ConfigPanelHostToWebview` variant, so `optionsChanged` posted before the first resolve is flushed on resolve.

   Files: `src/activation/configPanel.ts`

4. Document (comment-only) why the hot-reload seam carries no model-list duty

   In `src/activation/configRefresh.ts`, make a COMMENT-ONLY change: no code, no exports, no signature changes. Extend the "What needs NO refresh and why" list in the module header with an entry stating that refreshed model/effort lists reach the Config Panel through `ConfigPanelController.refreshOptions()` and the `optionsChanged` message driven by `onDidChangeCapabilities`, NOT through `ApplyConfig`: `createConfigRefresh` keeps returning only the executable-resolution and in-flight-stage notes (`IN_FLIGHT_NOTE`, `NOT_ACTIVATED_NOTE`, `FOLDER_MISMATCH_NOTE`), and a stale catalog is never a save-time note. Verify with `git diff -- src/activation/configRefresh.ts` that only comment lines changed, so `test/configRefresh.test.ts` is unaffected.

   Files: `src/activation/configRefresh.ts`

5. Unit-test the protocol/core additions

   In `test/configPanel.test.ts`, add a `describe('stale metadata and agentStaleness (model-selector-refresh T08)')` inside the existing top-level describe (import `agentStaleness` and the `AgentStaleness` type from `../src/config/configPanel`). Cases:
   1. `configFormOptions` with a capability carrying `{ source: 'live', stale: true, staleReason: 'models.dev unreachable', fetchedAt: '2026-01-02T03:04:05.000Z' }` copies all four fields into `byAgent[agent]` and still copies `models`/`efforts`/`modelLink`.
   2. A capability WITHOUT the metadata yields a `byAgent` entry with exactly the old keys — assert `Object.keys(result.byAgent.claude)` has no `stale`/`source`/`fetchedAt`/`staleReason`, which is what keeps the existing `deepStrictEqual` case at `test/configPanel.test.ts:301` green.
   3. `agentStaleness` returns `{}` for `agentCapabilities()` (curated builtins carry no metadata), emits `{ stale: true, reason, fetchedAt }` for a stale capability, `{ stale: false, fetchedAt }` for a fresh one with a `fetchedAt`, omits `reason` when `staleReason` is absent, and does not mutate its input.
   4. Round-trip: with a refreshed `claude` capability whose `models` no longer contain `claude-opus-5` and whose `efforts` are `['low','medium','high']`, `configFormOptions(AGENTS, refreshed, form)` where the form names `model: 'claude-opus-5'`, `effort: 'ultra'` still lists both values, and `validateConfigForm(form, result)` returns `[]`.

   Files: `test/configPanel.test.ts`

6. Unit-test the controller's live-capability behaviour

   In `test/configPanel.controller.test.ts`, add `describe('9. live capabilities and optionsChanged (model-selector-refresh T08)')`, reusing `RecordingWebview`, `newDir()` and the file-writing helpers already in the file. Add a tiny local fake emitter (`function makeCapabilitySource(initial)` returning `{ getCapabilities, onDidChangeCapabilities, set(next), fire(), listeners }`) rather than importing `vscode`; the suite must stay host-free (no `vscodeLoader` hook). Cases:
   1. `getCapabilities` is read per load, not frozen at construction: `ready` → change the fake's table → `load` → the second `loaded.options.byAgent.claude.models` carries the new list.
   2. Legacy precedence: with only `capabilities` injected (no `getCapabilities`), `loaded.options` is built from it exactly as before; with neither, it falls back to `agentCapabilities()`.
   3. A capability change after `ready` posts EXACTLY ONE `optionsChanged` and NO second `loaded`; its `options.byAgent` reflects the new models and its `stale` map is `{}` for a fresh table.
   4. Stale propagation: a table whose `codex` entry has `stale: true`, `staleReason`, `fetchedAt` → `optionsChanged.stale.codex` deep-equals `{ stale: true, reason: <staleReason>, fetchedAt: <fetchedAt> }` and `options.byAgent.codex.models` is the last-known list.
   5. Round-trip after refresh: write a config whose planner uses `model: 'claude-opus-4-9'` and `effort: 'high'`, `ready`, then fire a refresh whose `claude.models` omit that model → `optionsChanged.options.byAgent.claude.models` still contains it, and a following `save` of the loaded form yields `saved` (not `saveFailed`) with the value still on disk.
   6. `start()` called twice (the re-resolve path) subscribes once: one fired change → exactly one `optionsChanged`.
   7. After `dispose()`, firing a change posts nothing and the fake's listener set is empty (the subscription was disposed).
   8. Integration with the real catalog core (host-free, so importable here): build a `CatalogStore` from `../src/orchestrator/modelCatalog` with no memento, `builtins: builtinCatalogFetches()` from `../src/activation/modelDiscovery`, call `applyResult('claude', ok({ models: [{ id: 'claude-opus-5-5' }] }))`, wire `getCapabilities: () => agentCapabilities(store.table())` and assert the posted `optionsChanged.options.byAgent.claude.models` contains both `claude-opus-5-5` and `claude-sonnet-5`; then `applyResult('claude', err('network down'))` and assert `stale.claude.stale === true` with the models unchanged.

   Files: `test/configPanel.controller.test.ts`

7. Verify the build, the suites and the touched-file scope

   Run, from the repo root, in order: `npx tsc --noEmit -p tsconfig.json`; `npm run compile`; `npx eslint src/config/configPanel.ts src/activation/configPanelController.ts src/activation/configPanel.ts src/activation/configRefresh.ts test/configPanel.test.ts test/configPanel.controller.test.ts --ext .ts`; `npx mocha test/configPanel.test.ts test/configPanel.controller.test.ts test/configPanel.mirror.test.ts test/configPanel.mirror.property.test.ts test/configPanel.view.test.ts test/configRefresh.test.ts` (note `.mocharc.json` widens the spec to `test/**/*.test.ts`, so a targeted invocation may still run the whole suite — read the summary, not the invocation); `npm run test:unit`; `git status --porcelain`. Expect: tsc/compile exit 0, eslint clean, the two mirror suites and `configPanel.view`/`configRefresh` unchanged and green, `test:unit` green apart from the pre-existing `packaging gating: includes zero native modules` keytar assertion in `test/activation.gating.test.ts` (documented baseline failure), and `git status --porcelain` showing only the four source files, the two test files, and the extension-generated `.baiton/specs/model-selector-refresh/todos/T08/execute-<n>.md` artifact.

   Files: `src/config/configPanel.ts`, `src/activation/configPanelController.ts`, `src/activation/configPanel.ts`, `src/activation/configRefresh.ts`, `test/configPanel.test.ts`, `test/configPanel.controller.test.ts`

## Risks

- `src/extension.ts` builds the `CatalogStore`/`ModelDiscoveryService` AFTER it calls `registerConfigPanel`, and `extension.ts` is not in this todo's file list. The plan therefore makes `getCapabilities`/`onDidChangeCapabilities` OPTIONAL additive deps so nothing breaks and nothing must be reordered; the actual activation wiring (and the `media/config.js` in-place option replacement plus the stale note) belong to the later todos of design §5. Without that wiring the panel's behaviour is byte-identical to today, which is the intended, compiling intermediate state — do not widen scope to wire it here.
- `media/config.js` ignores unknown message types today, so an `optionsChanged` arriving before the webview half exists is silently dropped. That is safe, but it means the end-to-end effect is not observable in the UI from this todo alone; verification has to be the unit suites.
- The mirror suites (`test/configPanel.mirror.test.ts`, `test/configPanel.mirror.property.test.ts`) compare only `ROLES`, `LIMIT_BOUNDS` and `validateConfigForm` verbatim. Any edit to validation wording or to those constants would break them and force a `media/config.js` change outside this todo's files — so keep the validator untouched.
- Two existing assertions pin the exact key set of a `byAgent` entry (`test/configPanel.test.ts:301` and `:324`). The new metadata MUST be copied conditionally (never as explicit `undefined` own keys) or those cases fail.
- `registerConfigPanel`'s `ensureController()` calls `controller.start()` again on every view re-resolve. Without the `capabilitySub` guard the panel would accumulate subscriptions and post duplicate `optionsChanged` messages per refresh; case 6 of the controller suite exists to pin that.
- `refreshOptions()` rebuilds options from the LAST FORM READ FROM DISK, so a closed-set effort the user typed into "Other…" but has not saved is not appended and a save could then be refused as invalid. This is the same outcome as typing an unsupported effort today, and preferring it keeps the closed-set effort check meaningful; do not pass the incoming `save` form into `configFormOptions` at validation time, which would make every effort validate.
- `agentStaleness` keys off agent ids present in `options.byAgent`, which includes agents appended from the form (unknown/legacy ids). Those have no metadata, so they must produce no entry — otherwise the webview would badge an unknown agent as fresh.

## Acceptance

- `ConfigPanelHostToWebview` contains the additive variant `{ type: 'optionsChanged'; options: ConfigFormOptions; stale: Record<string, AgentStaleness> }`, and `AgentFormCapability` carries optional `source`/`stale`/`staleReason`/`fetchedAt` — with no new import added to `src/config/configPanel.ts`.
- `configFormOptions` copies those four fields into `byAgent` entries conditionally, and still appends the form's out-of-set agent, model and effort values so an existing `.baiton/config.json` selection remains listed and `validateConfigForm` accepts it after a refresh that dropped it.
- `ConfigPanelController` resolves capabilities through `getCapabilities()` → `capabilities` → `agentCapabilities()` on every `load()` and every `refreshOptions()`, never caching a table in the constructor beyond the initial `options` seed.
- A fired `onDidChangeCapabilities` produces exactly one `optionsChanged` carrying the refreshed `options` and the per-agent `stale` map, and produces no `loaded`, no file read and no change to `this.doc`/`this.token`.
- Stale metadata round-trips end to end: `agentCapabilities(store.table())` over a `CatalogStore` whose source failed yields `optionsChanged.stale[agent] = { stale: true, reason, fetchedAt }` with the last-known model list intact.
- After `dispose()` no `optionsChanged` is posted and the capability subscription is disposed; calling `start()` twice yields one subscription and one message per change.
- `RegisterConfigPanelDeps` gained only optional members, so `src/extension.ts` compiles untouched and the panel's behaviour with neither new dep passed is identical to before this todo.
- `src/activation/configRefresh.ts` differs only in comments (`git diff` shows no code line changed).
- `npx tsc --noEmit -p tsconfig.json` and `npm run compile` exit 0; eslint is clean on the six touched files.
- `npm run test:unit` passes apart from the pre-existing `packaging gating: includes zero native modules` keytar failure; `test/configPanel.mirror.test.ts`, `test/configPanel.mirror.property.test.ts`, `test/configPanel.view.test.ts` and `test/configRefresh.test.ts` pass with no change to `media/config.js`.
- `git status --porcelain` lists only the four source files, the two test files and the extension-generated `T08/execute-<n>.md` artifact.
