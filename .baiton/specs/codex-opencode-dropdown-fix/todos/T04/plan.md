# Plan T04

## Steps

1. Add the agy discovery constants and the pure `antigravityModelsFromCliOutput` parser

   In src/adapter/antigravity.ts, next to the existing constants (after ANTIGRAVITY_EFFORTS, before ANTIGRAVITY_MODELS), add:

   - `export const ANTIGRAVITY_MODELS_SUBCOMMAND = 'models';`
   - `export const ANTIGRAVITY_MODELS_ARGS: readonly string[] = [ANTIGRAVITY_MODELS_SUBCOMMAND];` (only `agy models`; no flag agy does not document).
   - `export const ANTIGRAVITY_EFFORT_VOCABULARY = ['low', 'medium', 'high', 'max'] as const;` — the CLI-wide `--effort` vocabulary from `agy --help`. Doc comment: no listed model currently offers `max`; the vocabulary is what a trailing id suffix is recognised against, while `ANTIGRAVITY_EFFORTS` stays the curated union actually offered (`low, medium, high`).
   - `const ANTIGRAVITY_MODELS_MAX_BUFFER = 1024 * 1024;`

   Then add the pure parser, exported and total (never throws, never mutates, `[]` for empty/unrecognised input):

   ```ts
   export function antigravityModelsFromCliOutput(stdout: string): ModelEntry[]
   ```
   (import `ModelEntry` as a type from '../orchestrator/modelCatalog').

   Algorithm, in this exact order:
   1. Split on `/\r?\n/`. Clean each line with a local `cleanAgyLine(line)` that strips ANSI escapes (`.replace(/\u001B\[[0-9;]*m/g, '')` with the same `// eslint-disable-next-line no-control-regex` comment used in src/adapter/opencode.ts:497-502), strips a leading bullet/marker (`/^[\s>*•-]+/`) and trims. Skip blank cleaned lines.
   2. Split the cleaned line on the FIRST tab (`const tab = cleaned.indexOf('\t')`): `id` is the part before it trimmed (or the whole line when there is no tab), `label` the part after it trimmed (may be empty → treated as absent). Skip a blank `id`. Skip an `id` containing whitespace (a spinner or prose line that reached stdout).
   3. De-duplicate raw ids by first occurrence into an ordered list of `{ id, label? }` records.
   4. Group: for each record, if `id` ends with `-<level>` where `<level>` is in `ANTIGRAVITY_EFFORT_VOCABULARY`, its stem is `id.slice(0, id.length - level.length - 1)` (skip a stem of length 0). Build a map stem → ordered distinct levels, plus the index of its first member and that first member's label.
   5. Emit entries in the order the listing first mentions them. A stem with TWO OR MORE distinct levels becomes one family entry `{ id: stem, label?: familyLabel, efforts: [levels in listing order] }`; its member ids are NOT emitted separately. Every other record (an unsuffixed id, and a lone suffixed id such as `gpt-oss-120b-medium`) is emitted as `{ id, label?, efforts: [] }` — agy rejects `--effort` for it.
   6. `familyLabel` is the first member's label with a trailing level parenthesis removed: strip `/\s*\((?:<level>)\)$/i` only when the parenthesised text equals that member's own level suffix case-insensitively (so `Gemini 3.8 Flash (High)` → `Gemini 3.8 Flash`, while an unrelated trailing parenthesis is kept). Emit `label` only when the resulting string is non-empty and differs from the entry's `id`; never write an explicit `undefined` own key (conditional assignment, the `normalizeModelEntry`/`capabilitiesFromEntries` style).
   7. Never emit `defaultEffort` — agy defines no default. Never emit `provider` or `custom`.
   8. When a stem that forms a family is ALSO listed as a bare id, the family entry wins and the bare id is not emitted twice (dedupe by emitted id).

   Doc comment must state: pure/total, what is read (ids and labels only), that the exit code and stderr are irrelevant to it, and that on the current `agy models` listing it reproduces `ANTIGRAVITY_MODELS` exactly.

   Files: `src/adapter/antigravity.ts`

2. Implement `AntigravityAdapter.discoverModels` with an injectable `agy models` runner

   Still in src/adapter/antigravity.ts, mirroring OpencodeAdapter's seam (src/adapter/opencode.ts:283-298, 1254-1273) and ClaudeAdapter's race helpers (src/adapter/claude.ts:486-541, 573-629):

   1. Add the injectable type and options, exported:
   ```ts
   export type AntigravityModelsCli = (options: { cwd?: string; timeoutMs: number }) => Promise<string | undefined>;
   export interface AntigravityAdapterOptions { readonly runModelsCli?: AntigravityModelsCli; }
   ```
   2. Give the class a constructor `constructor(options: AntigravityAdapterOptions = {}) { this.runModelsCli = options.runModelsCli ?? defaultRunAntigravityModelsCli; }` with `private readonly runModelsCli: AntigravityModelsCli;`. `createAdapterRegistry()` keeps calling `new AntigravityAdapter()` unchanged.
   3. `function defaultRunAntigravityModelsCli(options: { cwd?: string; timeoutMs: number }): Promise<string | undefined>` — `execFile(ANTIGRAVITY_BIN, [...ANTIGRAVITY_MODELS_ARGS], { cwd: options.cwd, timeout: options.timeoutMs, windowsHide: true, maxBuffer: ANTIGRAVITY_MODELS_MAX_BUFFER }, (error, stdout) => …)`; never rejects. The exit code is deliberately NOT inspected: resolve `stdout` even when `error` is set, EXCEPT when the failure means no usable output — a spawn failure (`error.code === 'ENOENT'`), or a kill/timeout (`error.killed === true` or `error.signal != null`) — in which case resolve `undefined`. stderr is ignored entirely (agy prints its spinner there).
   4. Replace the `// No discoverModels` comment (src/adapter/antigravity.ts:399-400) with:
   ```ts
   async discoverModels(ctx: DiscoveryContext): Promise<AgentCapabilities | undefined>
   ```
   Body, wrapped in one `try { … } catch { return undefined; }`:
      - `if (ctx.signal?.aborted === true) return undefined;` (an aborted refresh spawns nothing);
      - `const timeoutMs = Math.min(ctx.timeoutMs > 0 ? ctx.timeoutMs : DEFAULT_DISCOVERY_TIMEOUT_MS, DEFAULT_DISCOVERY_TIMEOUT_MS);`
      - `const stdout = await this.raceTimeout(this.raceAbort(Promise.resolve().then(() => this.runModelsCli({ ...(ctx.cwd !== undefined ? { cwd: ctx.cwd } : {}), timeoutMs })), ctx.signal), timeoutMs);`
      - `if (ctx.signal?.aborted === true) return undefined;`
      - `const entries = antigravityModelsFromCliOutput(stdout ?? '');`
      - `return entries.length > 0 ? capabilitiesFromEntries(entries) : undefined;`
   5. Copy `raceAbort` and `raceTimeout` as private methods verbatim from src/adapter/claude.ts:573-629 (unref'd timer, listener removal, losing rejections consumed).
   6. Imports to add in this file: `DEFAULT_DISCOVERY_TIMEOUT_MS`, `capabilitiesFromEntries` from './adapter' (value imports) and `AgentCapabilities`, `DiscoveryContext` as types; `ModelEntry` as a type from '../orchestrator/modelCatalog'.
   7. Contract in the doc comment, matching the other adapters: never rejects; `undefined` means "keep the last known-good list" and the curated `ANTIGRAVITY_MODELS` table is NEVER returned here; honours `ctx.signal` and `ctx.timeoutMs`; ignores stderr and the exit code because agy exits 0 even on an error (so stdout is what is judged); reads only ids and labels; touches no credential (agy uses its own sign-in); carries NO `source`/`stale`/`fetchedAt`/`modelLink` (the store stamps provenance) and no `defaultEffort`.
   8. Rewrite the `ANTIGRAVITY_MODELS` doc comment (src/adapter/antigravity.ts:42-48): the curated table is now the builtin SEED and FALLBACK that also supplies `modelEntries`; `agy models` is discovered live and overlaid; `antigravityModelFlags` still validates against the curated table, and a discovered family absent from it passes through as `--model <family> --effort <level>`, which agy accepts. Keep "refresh the curated table by hand when agy adds a model". Also fix degrade 6's wording only if it asserts the table is the sole source; `antigravityModelFlags`, `launch()` and `attach()` are otherwise untouched.

   Files: `src/adapter/antigravity.ts`

3. Register `antigravity` as a catalog source

   1. src/orchestrator/modelCatalog.ts:16 — `export type CatalogSourceId = 'claude' | 'codex' | 'opencode' | 'antigravity' | 'models.dev';` and line 19-24 — `CATALOG_SOURCE_IDS = ['claude', 'codex', 'opencode', 'antigravity', 'models.dev']` (this exact order; the store's builtin seeding and hydration loops iterate it). No other change in this file: `isCatalogSourceId`, `normalizeModelEntry`, `mergePreservingExisting`, `CatalogStore` all pick the new id up automatically, and a memento blob written by an older window simply has no `antigravity` key.
   2. src/adapter/adapter.ts:64-68 — add `antigravity: 'antigravity'` to `AGENT_CATALOG_SOURCE` and rewrite the doc comment at lines 58-63 (delete the "`antigravity` is deliberately ABSENT" paragraph; state that every agent is now mapped, and that the antigravity source's list comes from `agy models` while `antigravityModelFlags` still maps model+effort through the curated table).
   3. src/adapter/adapter.ts:288-300 — in the `discoverModels` doc comment drop "No adapter implements it yet … and antigravity never will"; say every adapter implements it (claude, codex, opencode, antigravity).
   4. src/activation/modelDiscovery.ts — doc-only: line 59-63 (`builtinCatalogFetches`) no longer "keeps antigravity's curated catalogue out of the store" — it now seeds four CLI sources, and only `'models.dev'` has no curated fallback; and the `refreshAgent` comment at ~line 236 that says an agent with no source (antigravity) never touches the store must be generalised (no agent is unmapped now). No functional change: the `Object.keys(AGENT_CATALOG_SOURCE)` loop at line 210 picks antigravity up, and the claude-only `feedPromise` branch is untouched.

   Files: `src/orchestrator/modelCatalog.ts`, `src/adapter/adapter.ts`, `src/activation/modelDiscovery.ts`

4. Give the curated antigravity capability `modelEntries`

   src/adapter/index.ts:205-208 — build the antigravity builtin from `ANTIGRAVITY_MODELS` as rich entries so the curated fallback also renders per-family efforts. Add a module-local helper next to `builtinAgentCapabilities`:

   ```ts
   /** The curated antigravity table as ModelEntry records: each family's suffixes as its own efforts, `[]` for a fixed id. */
   function antigravityBuiltinEntries(): ModelEntry[] {
     return Object.entries(ANTIGRAVITY_MODELS).map(([id, efforts]) => ({ id, efforts: [...efforts] }));
   }
   ```
   and set
   ```ts
   antigravity: { models: Object.keys(ANTIGRAVITY_MODELS), efforts: [...ANTIGRAVITY_EFFORTS], modelEntries: antigravityBuiltinEntries() },
   ```
   (keep `models` and `efforts` exactly as they are — same values, same order; no label is available for a curated entry; do not route this through `capabilitiesFromEntries`, whose `efforts` union would not equal `ANTIGRAVITY_EFFORTS` if the tables ever diverge). Import `ModelEntry` as a type from '../orchestrator/modelCatalog' if not already imported.

   Also update the doc comments that promise antigravity is never overlaid: `builtinAgentCapabilities` (lines 180-193, mention antigravity now carries `modelEntries`), `agentCapabilities` (lines 216-232, delete "antigravity is never overlaid (no `AGENT_CATALOG_SOURCE` entry)" and say the antigravity snapshot overlays like the others, with no claude-style required-model merge), and `overlayCapabilities` (lines 252-273, note that the union-of-entry-efforts path is now also the antigravity path). `overlayCapabilities` itself needs NO code change: an antigravity snapshot with entries takes the `hasEntryEfforts` branch, and an empty one keeps the curated models/efforts with the snapshot's stale metadata.

   Note the consequence, which is intended: `builtinCatalogFetches()` (src/activation/modelDiscovery.ts:65) now seeds the store's `antigravity` source from these entries via `capabilitiesToCatalogFetch`, so a first-ever window already shows per-family efforts as `source: 'builtin'`.

   Files: `src/adapter/index.ts`

5. Check in the `agy models` fixture

   New file test/fixtures/agyModels.sample.txt: the real tab-separated listing, one `id<TAB>label` line per model, in an order whose parse reproduces `Object.keys(ANTIGRAVITY_MODELS)` and each family's effort order EXACTLY (the tests assert that), i.e. gemini-3.8-flash first with low, medium, high in that order, then 3.7-flash, 3.6-flash, then gemini-3.1-pro (low, high), then the three fixed ids:

   ```
   gemini-3.8-flash-low	Gemini 3.8 Flash (Low)
   gemini-3.8-flash-medium	Gemini 3.8 Flash (Medium)
   gemini-3.8-flash-high	Gemini 3.8 Flash (High)
   gemini-3.7-flash-low	Gemini 3.7 Flash (Low)
   gemini-3.7-flash-medium	Gemini 3.7 Flash (Medium)
   gemini-3.7-flash-high	Gemini 3.7 Flash (High)
   gemini-3.6-flash-low	Gemini 3.6 Flash (Low)
   gemini-3.6-flash-medium	Gemini 3.6 Flash (Medium)
   gemini-3.6-flash-high	Gemini 3.6 Flash (High)
   gemini-3.1-pro-low	Gemini 3.1 Pro (Low)
   gemini-3.1-pro-high	Gemini 3.1 Pro (High)
   claude-sonnet-4-6	Claude Sonnet 4.6
   claude-opus-4-6-thinking	Claude Opus 4.6 (Thinking)
   gpt-oss-120b-medium	GPT-OSS 120B Medium
   ```
   (real tab characters between the two columns, trailing newline, no CRLF). ANSI-coloured, blank and duplicate lines are exercised by strings built inside the test rather than in the fixture, so the fixture stays a faithful copy of the CLI output.

   Files: `test/fixtures/agyModels.sample.txt`

6. Unit-test the parser and `discoverModels` in test/adapter.antigravity.test.ts

   Add the new imports (`antigravityModelsFromCliOutput`, `ANTIGRAVITY_EFFORT_VOCABULARY`, `ANTIGRAVITY_MODELS_ARGS`, `ANTIGRAVITY_EFFORTS`) and read the fixture once at module scope with the pattern of test/adapter.opencode.test.ts:663-667 (`fs.readFileSync(path.join(__dirname, 'fixtures', 'agyModels.sample.txt'), 'utf8')`). Extend the file header comment with the new discovery coverage. Two new suites:

   `describe('antigravityModelsFromCliOutput', …)`:
   - on the fixture: the families `gemini-3.8-flash`, `gemini-3.7-flash`, `gemini-3.6-flash` carry `['low','medium','high']` and `gemini-3.1-pro` carries `['low','high']`; family labels are `Gemini 3.8 Flash` … `Gemini 3.1 Pro` (level parenthesis removed); no suffixed member id appears as its own entry;
   - the three fixed ids `claude-sonnet-4-6`, `claude-opus-4-6-thinking`, `gpt-oss-120b-medium` are present with `efforts: []` (the lone `-medium` suffix must NOT form a family), and `claude-opus-4-6-thinking` keeps its `(Thinking)` label untouched;
   - `assert.deepStrictEqual(entries.map(e => e.id), Object.keys(ANTIGRAVITY_MODELS))` and, per entry, `assert.deepStrictEqual([...entry.efforts], ANTIGRAVITY_MODELS[entry.id])` — the drift guard between the listing and the curated table; plus `assertSameSet`-style check that the union of the families' levels equals `[...ANTIGRAVITY_EFFORTS]`;
   - ANSI escapes around ids and labels are stripped (wrap fixture lines in `\u001B[32m…\u001B[0m`);
   - blank lines, whitespace-only lines, a leading-bullet line and a duplicate id line change nothing (duplicate keeps the first occurrence);
   - a line with no tab yields an entry with no `label` own key (`Object.prototype.hasOwnProperty.call(entry, 'label') === false`);
   - `''`, `'\n\n'` and a pure-prose/spinner output yield `[]`;
   - no entry carries `defaultEffort`, `provider` or `custom`;
   - the parser never throws on adversarial input (a bare `-low` line, an id ending `-max`, a single `-max` id, a stem of length 0).

   `describe('AntigravityAdapter.discoverModels', …)`, all through the injected `runModelsCli` (no real `agy` is ever spawned):
   - the fixture stdout yields `models` equal to `Object.keys(ANTIGRAVITY_MODELS)`, `efforts` equal to the ordered union `['low','medium','high']`, `modelEntries` carrying the per-family levels, and NO own `source`/`stale`/`staleReason`/`fetchedAt`/`modelLink` key;
   - the runner resolving `undefined` (missing binary), `''`, or unparseable prose resolves `undefined` — never the curated table;
   - a runner that rejects, and one that throws synchronously, resolve `undefined`;
   - an already-aborted `ctx.signal` calls the runner zero times and resolves `undefined`; a signal aborted while the runner is pending resolves `undefined`;
   - a runner that never settles resolves `undefined` within a small `ctx.timeoutMs` (e.g. 20 ms) and the test does not hang;
   - the runner receives `cwd: ctx.cwd` and a `timeoutMs` no larger than `DEFAULT_DISCOVERY_TIMEOUT_MS` (assert with `ctx.timeoutMs` far larger);
   - a runner whose stdout is the fixture but whose "process" failed with a non-zero exit still yields the entries — the exit code is never inspected (model this by having the runner resolve the stdout, and assert the adapter's result, i.e. that no exit-code check exists at the seam);
   - `ANTIGRAVITY_MODELS_ARGS` is exactly `['models']` (no undocumented flag).

   Files: `test/adapter.antigravity.test.ts`

7. Invert the tests that pin "antigravity is never overlaid"

   1. test/adapter.index.test.ts:
      - line ~180-190 (`no argument returns the builtin table with no optional metadata keys`): keep asserting the absence of `source`/`stale`/`staleReason`/`fetchedAt` for every agent, but move `modelEntries` out of that key list into a per-agent rule — absent for claude, opencode and codex, PRESENT for antigravity — and assert `caps.antigravity.modelEntries!.map(e => e.id)` equals `Object.keys(ANTIGRAVITY_MODELS)` with each entry's `efforts` equal to the curated list. `assert.deepStrictEqual(caps, builtinAgentCapabilities())` at the top of that test still holds.
      - line 307-316 (`antigravity is never overlaid, even with a fully populated table`): rewrite as `antigravity is overlaid from its own snapshot` — a table with `antigravity: snap('antigravity', [{ id: 'gemini-4.0-flash', efforts: ['low','high'] }, { id: 'claude-sonnet-5-0' }])` yields `models: ['gemini-4.0-flash','claude-sonnet-5-0']`, `efforts: ['low','high']` (union of entry efforts), `modelEntries` carrying them, and the snapshot's `source`/`stale` metadata; and an EMPTY antigravity snapshot keeps `builtinAgentCapabilities().antigravity.models` with `source: 'builtin'` and the snapshot's `stale` flag (the `overlayCapabilities` empty-list branch). Note the fresh-object test at line 317 onwards may be extended with an antigravity snapshot.
      - line 343-363 (`AGENT_CATALOG_SOURCE`): replace `assert.strictEqual(AGENT_CATALOG_SOURCE.antigravity, undefined)` with `assert.strictEqual(AGENT_CATALOG_SOURCE.antigravity, 'antigravity')`, require all four agents to be mapped, and assert the key set equals `createAdapterRegistry().ids`.
      - line 366-376 (`discoverModels seam`): rename to "every adapter implements discoverModels" and assert `typeof createAdapterRegistry().require(id).discoverModels === 'function'` for every registry id, antigravity included.
   2. test/modelDiscovery.test.ts line ~543-551 (`T07 builtinCatalogFetches`): the seeded keys are now `['antigravity','claude','codex','opencode']` (sorted), antigravity IS seeded and its seed carries per-family `efforts` on its entries; `'models.dev'` still has no seed. Keep the "no adapter discovery seam" fake at line 75 but re-word its comment (it is no longer "the antigravity shape" — it is a hypothetical adapter without the seam).
   3. test/modelCatalog.test.ts line 108-113: `assert.deepStrictEqual([...CATALOG_SOURCE_IDS], ['claude', 'codex', 'opencode', 'antigravity', 'models.dev'])`.

   Files: `test/adapter.index.test.ts`, `test/modelDiscovery.test.ts`, `test/modelCatalog.test.ts`

8. Keep the end-to-end suite deterministic and green

   test/modelSelectorRefresh.test.ts is NOT in the todo's file list but breaks as soon as antigravity is mapped, so it must be fixed here (a real `agy models` would otherwise run on the developer's machine during the suite):

   1. line 323-324 — replace `antigravity: new AntigravityAdapter()` with `antigravity: new AntigravityAdapter({ runModelsCli: async () => undefined })` and change the comment to say the agy CLI is stubbed out exactly as the claude reader and the opencode CLI are (same reason: the real listing would make the expectations machine-dependent; the live agy leg belongs to the end-to-end todo).
   2. line 613-625 — the "antigravity: never overlaid" block becomes: the antigravity snapshot exists, its `models` still equal `builtinAgentCapabilities().antigravity.models` (the curated seed survives a failed refresh), `byAgent.antigravity.source === 'builtin'` and `stale === true` with a non-empty `staleReason`. Drop the `for (const key of ['source','stale','fetchedAt'])` absence loop.
   3. line 743 — `assert.strictEqual(hasOwnKey(caps.antigravity, 'stale'), false)` becomes `assert.strictEqual(caps.antigravity.stale, true)` with `caps.antigravity.models` still equal to the curated list; if that test iterates source ids, leave its `['claude','codex','opencode']` loops alone (they remain valid) or extend them with `'antigravity'` — the seeded snapshot behaves identically.
   4. Grep the file for any remaining `never overlaid` / `no AGENT_CATALOG_SOURCE entry` comment and correct it.

   Files: `test/modelSelectorRefresh.test.ts`

9. Update the README discovery section

   README.md:
   1. The `antigravity (agy) — unchanged: its curated catalogue and model/effort mapping are never overlaid (it has no AGENT_CATALOG_SOURCE entry).` bullet (~line 821-822) becomes a real source description, in the style of the codex/opencode bullets: `agy models` prints one `id<TAB>label` line per model; two or more sibling ids sharing a stem with distinct `low|medium|high|max` suffixes become one family whose suffixes are its effort list and whose label drops the trailing `(Level)`, while every other id — including a lone suffixed id like `gpt-oss-120b-medium` — is a fixed id with no effort; the agent-level effort list is the ordered union of the families' levels; agy exits 0 even on an error and prints its spinner on stderr, so only stdout is judged and the exit code is never inspected; agy needs its own sign-in and no Baiton credential; a failure, timeout or empty listing keeps the previous list and marks it stale; the launch argv is unchanged — `antigravityModelFlags` still maps model+effort through the curated table, which stays the builtin seed and fallback and is still refreshed by hand.
   2. The "CLI capabilities" bullet (~line 851-852) — `agy models` now also states that it is Baiton's antigravity discovery source and that the effort levels are encoded as id suffixes.
   3. The Privacy bullet (~line 839) — add that the `agy models` listing is read only for ids and labels.

   Files: `README.md`

10. Verify

   Run, from the repository root:
   - `npm run compile` — clean (the widened `CatalogSourceId` must not break any `Record<CatalogSourceId, …>` site; `Partial` mapped types in src/activation/modelDiscovery.ts and src/orchestrator/modelCatalog.ts already tolerate it);
   - `npm run lint` — clean (the ANSI regex needs the `no-control-regex` disable comment used in opencode.ts);
   - `npm run test:unit` — the whole suite green, in particular test/adapter.antigravity.test.ts, test/adapter.index.test.ts, test/modelCatalog.test.ts, test/modelDiscovery.test.ts and test/modelSelectorRefresh.test.ts;
   - confirm no test spawns `agy`: `grep -rn "new AntigravityAdapter(" test | grep -v runModelsCli` should show only constructions whose tests never call `discoverModels`.
   Optional manual check on a machine with agy signed in: `agy models` and compare the parse against `ANTIGRAVITY_MODELS`.

   Files: (none)

## Risks

- Widening `CatalogSourceId`/`CATALOG_SOURCE_IDS` is a cross-module change: any exhaustive `Record<CatalogSourceId, …>` or switch would start failing to compile. A grep shows only `Partial`/mapped uses in src/adapter/adapter.ts and src/activation/modelDiscovery.ts, but `npm run compile` is the real gate.
- `optionalStringArray` in src/orchestrator/modelCatalog.ts (lines 205-219) DROPS an empty array, so a fixed antigravity id's `efforts: []` marker does not survive the memento round-trip: a `cached` snapshot's fixed ids come back with no `efforts` key. Live and builtin snapshots keep the marker. The webview rule planned in later todos distinguishes `[]` (only the default option) from an absent key (agent-level union), so a fixed id may show the agent-level union after a window reload. Out of scope for this todo — flagged, not fixed.
- test/modelSelectorRefresh.test.ts and test/modelCatalog.test.ts are outside the todo's declared file list but must be edited, or the suite either fails or shells out to the developer's real `agy` (machine-dependent, ~1.5 s per refresh). Both edits are assertion/stub-only; no production behaviour is added for them.
- The fixture's line order defines the discovered order and each family's effort order, and the tests assert equality with `ANTIGRAVITY_MODELS`. If the real `agy models` prints families or levels in a different order than the fixture, the drift-guard assertion pins the fixture, not the CLI; the curated table stays the hand-maintained reference either way.
- `agy models` ignoring the exit code means a signed-out or erroring agy whose error text happens to contain a tab-separated token could yield a junk entry. The parser's guards (non-blank id, no whitespace inside the id) keep this unlikely, and a junk list would be replaced by the next successful refresh; the launch path still validates against the curated table, so a junk id cannot silently change an argv.
- Antigravity is now a discovery source, so every window reload spawns one extra short-lived `agy models` child process per refresh. It is inside the shared per-source timebox, never awaited by activation, and needs no credential, but it is new process activity on reload.

## Acceptance

- `antigravityModelsFromCliOutput` on test/fixtures/agyModels.sample.txt yields entry ids exactly `Object.keys(ANTIGRAVITY_MODELS)`, with each entry's `efforts` deep-equal to the curated list (gemini-3.8/3.7/3.6-flash → low, medium, high; gemini-3.1-pro → low, high; claude-sonnet-4-6, claude-opus-4-6-thinking, gpt-oss-120b-medium → []), family labels with the trailing level parenthesis removed, and no `defaultEffort`/`provider`/`custom` key anywhere.
- The parser is total: ANSI escapes, blank lines, leading bullets, duplicate ids, tab-less lines and adversarial suffixes never throw, and empty or prose-only input yields `[]`.
- `AntigravityAdapter.discoverModels` resolves `capabilitiesFromEntries(entries)` for the fixture listing (efforts = ordered union `low, medium, high`, `modelEntries` carrying the per-family levels, no provenance or `modelLink` keys), and resolves `undefined` — never the curated table — on a missing binary, empty stdout, unparseable output, a rejecting or throwing runner, an already-aborted or mid-flight-aborted signal, and a timeout; it never inspects the exit code and never reads stderr.
- `AGENT_CATALOG_SOURCE.antigravity === 'antigravity'`, `CATALOG_SOURCE_IDS` is `['claude','codex','opencode','antigravity','models.dev']`, and `builtinCatalogFetches()` seeds all four CLI sources (antigravity's seed carrying per-family efforts) and still no `models.dev`.
- `builtinAgentCapabilities().antigravity` keeps its current `models` and `efforts` and additionally carries `modelEntries` mirroring `ANTIGRAVITY_MODELS`; `agentCapabilities()` with no argument still carries no `source`/`stale`/`staleReason`/`fetchedAt` for any agent.
- `agentCapabilities(table)` overlays a non-empty antigravity snapshot (models, union efforts, modelEntries, stale metadata) and, for an empty snapshot, keeps the curated models/efforts with `source: 'builtin'` plus the snapshot's stale flag and reason.
- `antigravityModelFlags`, `launch()`, `attach()`, `relayFiles()` and every relay constant are byte-for-byte unchanged, and the existing launch/relay/permission tests pass untouched.
- `npm run compile`, `npm run lint` and `npm run test:unit` are all clean, and no test spawns the real `agy` binary for discovery (every `discoverModels` test injects `runModelsCli`).
- README's discovery section describes `agy models` as the antigravity source — family/fixed-id rules, stdout-only judging, stale-on-failure, unchanged argv — and its privacy bullet names the listing as ids-and-labels only.
