# Plan T06

## Steps

1. Add the discovery vocabulary and injection seams to src/adapter/opencode.ts

   At the top of the file add `import type { ModelEntry } from '../orchestrator/modelCatalog';`, `import type { FeedFetch, FeedResponse } from '../orchestrator/modelsDev';` and extend the existing adapter import to `import type { Adapter, AgentCapabilities, DiscoveryContext, LaunchRequest, LaunchSpec, ProbeResult } from './adapter';` plus `import { AGENT_BINARY, DEFAULT_DISCOVERY_TIMEOUT_MS, capabilitiesFromEntries } from './adapter';` and `import { spawn } from 'child_process'` alongside the existing `execFile` import. Then, in a new section comment `// --- opencode model discovery (model-selector-refresh T06) ---`, placed AFTER the existing OPENCODE_MODELS / OPENCODE_EFFORTS / OPENCODE_MODEL_DOC_URL constants and BEFORE the `OpencodeAdapter` class doc comment, export these constants and seams:

   - `export const OPENCODE_SERVE_SUBCOMMAND = 'serve';` — the only subcommand discovery ever spawns.
   - `export const OPENCODE_SERVE_HOSTNAME = '127.0.0.1';` and `export const OPENCODE_SERVE_PORT = '0';` — loopback only, ephemeral port, so discovery never binds a predictable public port.
   - `export const OPENCODE_SERVE_ARGS: readonly string[] = [OPENCODE_SERVE_SUBCOMMAND, '--hostname', OPENCODE_SERVE_HOSTNAME, '--port', OPENCODE_SERVE_PORT];`
   - `export const OPENCODE_MODELS_SUBCOMMAND = 'models';` — the CLI fallback/validation source.
   - `export const OPENCODE_MODEL_ENDPOINT_PATH = '/api/model';` — the server route the primary path GETs.
   - `export const OPENCODE_SERVER_ENV_VAR = 'OPENCODE_SERVER';` — when this env var already holds an `http://`/`https://` URL an opencode server is assumed to be running and is used INSTEAD of spawning one. Document in the doc comment that this is a base URL, never a credential, and that it is the only env var this path reads.
   - `export interface OpencodeServer { readonly baseUrl: string; dispose(): void; }` — a started (or pre-existing) server handle; `dispose()` must be idempotent and never throw.
   - `export type OpencodeServerStarter = (options: { cwd?: string; timeoutMs: number; log?: (message: string) => void }) => Promise<OpencodeServer | undefined>;` — resolves `undefined` (never rejects) when no server could be started.
   - `export type OpencodeModelsCli = (options: { cwd?: string; timeoutMs: number }) => Promise<string | undefined>;` — resolves `opencode models` stdout, or `undefined` on any failure; never rejects.
   - `export interface OpencodeAdapterOptions { readonly startServer?: OpencodeServerStarter; readonly fetchModels?: FeedFetch; readonly runModelsCli?: OpencodeModelsCli; readonly serverBaseUrl?: string; }` — every field optional with a default, mirroring `CodexAdapterOptions` in src/adapter/codex.ts.

   Reuse `FeedFetch`/`FeedResponse` from src/orchestrator/modelsDev.ts rather than declaring a second structural fetch type.

   Files: `src/adapter/opencode.ts`

2. Write the pure `/api/model` payload parser `opencodeModelsFromApi`

   `export function opencodeModelsFromApi(payload: unknown): ModelEntry[]` — pure, total, never throws, never mutates the input, returns `[]` for any unrecognised shape. Mirror the tolerance and the CONDITIONAL key assignment style of `codexModelsFromAppServer` in src/adapter/codex.ts (never write an explicit `undefined` own key).

   Accepted shapes, in this order:
   1. a bare array of items;
   2. an object whose `providers`, `models` or `items` property is an array (first present wins, in that order);
   3. an object whose `providers` property is an OBJECT keyed by provider id, each value being either an array of model items or an object whose `models` is an array or an object keyed by model id;
   4. the same provider-keyed OBJECT at the top level (no `providers` wrapper) — i.e. every value is an object carrying a `models` array/map.
   Anything else → `[]`.

   Per item, with an inherited `providerId` when the shape supplied one (the map key, or the parent's `id`):
   - a string item is the raw id; an object item's raw id is the first non-empty trimmed string of `id`, `model`, `modelID`, `slug`; a map-keyed model uses the key when the value carries no id. No usable raw id → skip the item.
   - the emitted `id` is the raw id when it already contains a `/`, else `` `${providerId}/${rawId}` `` when a provider id is known, else the raw id unchanged. Never double-prefix.
   - `provider` is set to the emitted id's segment before the first `/` when there is one, else the known `providerId`, else omitted.
   - `label` is the first non-empty trimmed string of `displayName`, `name`, set ONLY when it differs from the emitted `id` (same rule as `codexModelsFromAppServer`).
   - no `efforts` / `defaultEffort` are ever emitted: opencode effort is free-text `--variant`.
   - de-duplicate by emitted `id`, first occurrence wins; source order is otherwise preserved.

   Add two small private helpers if useful, but reuse the local idiom: a `firstNonEmptyString(values: readonly unknown[]): string | undefined` private helper identical in behaviour to codex's.

   Files: `src/adapter/opencode.ts`

3. Write the pure CLI parser `opencodeModelsFromCliOutput` and the union helper `mergeOpencodeModelSources`

   `export function opencodeModelsFromCliOutput(stdout: string): ModelEntry[]` — pure, total, never throws. Split on `/\r?\n/`; for each line strip ANSI escapes (`/\u001B\[[0-9;]*m/g`), strip a leading bullet/marker (`/^[\s>*\u2022-]+/`) and trim; take the FIRST whitespace-delimited token of the remainder (opencode prints an id plus optional trailing description). Keep a token only when it matches `/^[A-Za-z0-9._-]+\/[A-Za-z0-9._:-]+$/` — exactly one `/`, no spaces — which drops headers, blank lines and prose. Emit `{ id: token, provider: token.slice(0, token.indexOf('/')) }`, de-duplicated by id, first-seen order preserved.

   `export function mergeOpencodeModelSources(apiEntries: readonly ModelEntry[], cliEntries: readonly ModelEntry[]): ModelEntry[]` — the todo's "fallback AND validation source" rule made explicit and testable: the API entries come first in their own order (they carry labels), then every CLI entry whose id is not already present is appended. The CLI list therefore VALIDATES (its ids are cross-checked and any it alone knows are added) but never DROPS an API-reported model — a model missing from one source is a gap in that source, not evidence the model is gone. With an empty `apiEntries` the result is exactly the CLI entries (pure fallback); with empty `cliEntries` it is exactly the API entries. Pure, never mutates either input.

   Files: `src/adapter/opencode.ts`

4. Add the default server starter, the URL sniffer and the default `opencode models` runner

   Below the class, next to the existing `defaultListSessions`, add:

   - `export function parseOpencodeServerUrl(text: string): string | undefined` — pure. Match `/(https?:\/\/[^\s,)"']+)/` against the accumulated serve output, return the first match with any trailing `/` removed, else `undefined`. This is how the ephemeral port is learned.
   - `function defaultStartOpencodeServer(options: { cwd?: string; timeoutMs: number; log?: (m: string) => void }): Promise<OpencodeServer | undefined>` — `spawn(OPENCODE_BIN, [...OPENCODE_SERVE_ARGS], { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })`. Accumulate stdout AND stderr into one buffer, run `parseOpencodeServerUrl` on each chunk, and resolve `{ baseUrl, dispose }` on the first match. Resolve `undefined` on `error` (including ENOENT), on `exit`/`close` before a URL appeared, and on an unref'd `setTimeout(options.timeoutMs)`. Exactly one idempotent `settle` path clears the timer, detaches listeners and — on every non-success path — kills the child, mirroring the `finish` helper in `CodexAdapter.discoverModels`. `dispose()` kills the child with `SIGTERM` inside try/catch and is safe to call twice.
   - `function defaultRunModelsCli(options: { cwd?: string; timeoutMs: number }): Promise<string | undefined>` — `execFile(OPENCODE_BIN, [OPENCODE_MODELS_SUBCOMMAND], { cwd, timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, …)` resolving `stdout` on success and `undefined` on any error (never rejecting), matching the never-throw contract.

   Files: `src/adapter/opencode.ts`

5. Widen the OpencodeAdapter constructor and implement `discoverModels`

   Change the constructor to `constructor(private readonly listSessions: ListSessionsFn = defaultListSessions, options: OpencodeAdapterOptions = {})`, keeping the existing positional parameter so `new OpencodeAdapter()` in src/adapter/index.ts and `new OpencodeAdapter(fakeList)` in the tests compile unchanged (this mirrors `ClaudeAdapter(mode, options)`). Store `private readonly startServer = options.startServer ?? defaultStartOpencodeServer`, `private readonly fetchModels = options.fetchModels ?? ((globalThis as { fetch?: FeedFetch }).fetch)` (may be `undefined`; the API path is then skipped), `private readonly runModelsCli = options.runModelsCli ?? defaultRunModelsCli`, and `private readonly serverBaseUrl = options.serverBaseUrl`.

   Add `async discoverModels(ctx: DiscoveryContext): Promise<AgentCapabilities | undefined>` with a doc comment stating the contract it honours (never rejects; `undefined` means "keep the curated free-text list"; honours `ctx.signal` and `ctx.timeoutMs`; tears down every child process and socket; reads no secret — only `OPENCODE_SERVER_ENV_VAR`, a base URL — so only ids and labels leave the host). Body, entirely wrapped in `try { … } catch { return undefined; }`:

   1. `if (ctx.signal?.aborted === true) return undefined;` — an aborted refresh starts no process and makes no request.
   2. `const timeoutMs = Math.min(ctx.timeoutMs > 0 ? ctx.timeoutMs : DEFAULT_DISCOVERY_TIMEOUT_MS, DEFAULT_DISCOVERY_TIMEOUT_MS);` and `const deadline = Date.now() + timeoutMs;` with a local `const remaining = () => deadline - Date.now();`.
   3. API path, in a `try/finally` whose `finally` calls `server?.dispose()` exactly once: resolve the base URL as `this.serverBaseUrl` ?? a non-empty `process.env[OPENCODE_SERVER_ENV_VAR]` that starts with `http` ?? (`await this.startServer({ cwd: ctx.cwd, timeoutMs: remaining(), log: ctx.log })`)`?.baseUrl`; only the started handle is disposed (a pre-existing server is never killed). With a base URL, no abort and `remaining() > 0` and `this.fetchModels !== undefined`, GET `` `${baseUrl}${OPENCODE_MODEL_ENDPOINT_PATH}` `` through `this.fetchModels(url, { signal, headers: { accept: 'application/json' } })`, where `signal` comes from a local `AbortController` aborted by an unref'd `setTimeout(remaining())` and by an `abort` listener on `ctx.signal` (always `clearTimeout` and `removeEventListener` in a `finally`). Treat `!response.ok` or a status outside 200-299, a rejected `text()`, unparseable JSON or a throwing fetch as "no API entries" — log through `ctx.log?.(…)` and continue, never throw. On success run `opencodeModelsFromApi(JSON.parse(text))`.
   4. CLI path: when not aborted and `remaining() > 0`, `const stdout = await this.runModelsCli({ cwd: ctx.cwd, timeoutMs: remaining() })` and `opencodeModelsFromCliOutput(stdout ?? '')`. Run it both as the fallback (API produced nothing) and as the validation source (API produced entries and budget remains); skip it silently when the budget is spent, in which case the API entries stand alone.
   5. `const entries = mergeOpencodeModelSources(apiEntries, cliEntries); if (ctx.signal?.aborted === true || entries.length === 0) return undefined;`
   6. `return capabilitiesFromEntries(entries, { efforts: [...OPENCODE_EFFORTS] });` — efforts stay free text (empty list). Deliberately NO `source`/`stale`/`staleReason`/`fetchedAt` (stamped by `CatalogStore.applyResult`) and NO `modelLink` (re-attached from the builtin by `overlayCapabilities` in src/adapter/index.ts); state this in the comment, exactly as `CodexAdapter.discoverModels` does.

   Do NOT change `launch()`, `attach()`, `probe()`, `resolveSessionId()`, `opencodeAgentDefinition`, `opencodeAllowList` or `opencodeConfigEnv`, and do NOT edit src/adapter/index.ts: `AGENT_CATALOG_SOURCE.opencode = 'opencode'` and the empty-snapshot branch of `overlayCapabilities` already wire this list into `agentCapabilities(snapshots)`.

   Files: `src/adapter/opencode.ts`

6. Cover the parsers with unit tests

   Append to test/adapter.opencode.test.ts (leaving every existing suite untouched) and extend the imports with the new symbols plus `import type { DiscoveryContext } from '../src/adapter/adapter';` and `import { DEFAULT_DISCOVERY_TIMEOUT_MS } from '../src/adapter/adapter';` and `import { capabilitiesToCatalogFetch } from '../src/adapter/adapter';`.

   `describe('opencodeModelsFromApi (model-selector-refresh T06)')`: array of strings; array of objects with `id`/`name`; `{ providers: [{ id: 'anthropic', models: [{ id: 'claude-sonnet-5', name: 'Claude Sonnet 5' }] }] }` → id `anthropic/claude-sonnet-5`, `provider: 'anthropic'`, `label` set; provider-keyed maps at both nesting levels; an id that already contains `/` is never double-prefixed; `label` equal to the id is omitted; duplicates collapse first-wins; blanks/idless items are skipped; `null`, a number, a string and `{}` each → `[]`; no entry ever carries `efforts` or `defaultEffort`; the input object is deep-equal to a pristine copy afterwards (purity).

   `describe('opencodeModelsFromCliOutput (model-selector-refresh T06)')`: a realistic multi-line listing yields the provider-prefixed ids in order; blank lines, a header line, an indented bullet and an ANSI-coloured line are handled; a line with a trailing description keeps only the id token; non-`provider/model` tokens are dropped; duplicates collapse; `''` → `[]`.

   `describe('mergeOpencodeModelSources (model-selector-refresh T06)')`: API order first then CLI-only ids; overlapping ids are not duplicated and the API entry (with its label) wins; empty API → CLI verbatim; empty CLI → API verbatim; neither input is mutated.

   `describe('parseOpencodeServerUrl (model-selector-refresh T06)')`: extracts `http://127.0.0.1:52341` from a realistic serve banner, strips a trailing slash, returns `undefined` for output with no URL.

   Files: `test/adapter.opencode.test.ts`

7. Cover `OpencodeAdapter.discoverModels` with fake seams

   `describe('OpencodeAdapter.discoverModels (model-selector-refresh T06)')` with a local `function ctx(overrides: Partial<DiscoveryContext> = {}): DiscoveryContext { return { timeoutMs: DEFAULT_DISCOVERY_TIMEOUT_MS, ...overrides }; }`, a `fakeServer()` helper returning `{ starter, calls, disposals }`, a `fakeFetch(responses)` helper returning `{ fetch, urls }` whose response objects implement the structural `{ ok, status, text() }` (`FeedResponse`), and a `fakeCli(stdout)` recording its calls. Cases:

   - happy path: fetch returns a provider-keyed payload → the requested URL is exactly `<baseUrl>/api/model`, the result's `models` are the merged ids, `efforts` is `[]`, and the object has NO `source`/`stale`/`staleReason`/`fetchedAt`/`modelLink` own keys (`assert.ok(!('source' in caps))` etc.);
   - the started server is disposed exactly once on success, on fetch failure, on timeout and on abort;
   - `serverBaseUrl`/`OPENCODE_SERVER` set → the starter is never called and nothing is spawned (restore `process.env` in `afterEach`);
   - API failure modes each fall back to the CLI and yield the CLI-derived entries: starter resolves `undefined`; fetch rejects; HTTP 500; `text()` rejects; body is not JSON; body parses to an unrecognised shape;
   - API ok + CLI ok → union with API entries first (validation-source behaviour), and the CLI runner IS invoked;
   - both sources empty/failing → resolves `undefined` (never the curated list) and never throws;
   - `ctx.signal` already aborted → resolves `undefined` with zero starter, fetch and CLI calls;
   - aborting mid-flight (starter pending, fetch pending) → resolves `undefined` and disposes;
   - a starter that THROWS synchronously and a CLI runner that REJECTS both resolve `undefined` rather than rejecting;
   - budget: `ctx.timeoutMs` larger than `DEFAULT_DISCOVERY_TIMEOUT_MS` is clamped down, `0`/negative falls back to the default — assert on the `timeoutMs` the starter/CLI fakes received;
   - round-trip: `capabilitiesToCatalogFetch(result!)` yields `models` with the same ids in order and no `efforts` key (opencode's list is empty);
   - regression: `new OpencodeAdapter()` and `new OpencodeAdapter(fakeListSessions)` still behave as the existing suites expect, and a launch built by an adapter constructed WITH discovery options is deep-equal to one from `new OpencodeAdapter()` (argv and env untouched by this todo).

   Files: `test/adapter.opencode.test.ts`

## Risks

- The `/api/model` response shape is not pinned by any checked-in fixture or documentation in this repo; the parser is therefore written tolerantly (array, `providers` array, provider-keyed maps) and any unrecognised shape yields `[]`, which degrades to the `opencode models` fallback rather than failing the refresh.
- `opencode serve` flag spelling (`--hostname`/`--port`) and its startup banner vary by version; a starter that never prints a parseable URL times out, resolves `undefined` and falls back to the CLI, so a wrong flag costs a fallback, not a crash — but it does cost the spawn budget.
- Spawning `opencode serve` starts a real child process on every window reload. The idempotent `dispose()` in a `finally`, the unref'd timers and the kill-on-every-settle path are load-bearing: a missed teardown leaks a server bound to an ephemeral port for the life of the host.
- Reading `process.env.OPENCODE_SERVER` is the only env read in this path; it must stay a base URL check (non-empty, `http`-prefixed) and never be logged or forwarded, so the "no secrets leave the host" constraint holds.
- A single wall-clock budget is split between the server/API path and the CLI path; a slow server start can leave no budget for the validation CLI run. That is intended (the API entries stand alone), but tests must pin it so a future refactor does not silently make discovery exceed `DEFAULT_DISCOVERY_TIMEOUT_MS`.
- The constructor gains a second parameter; keeping `listSessions` positional and first is required or `new OpencodeAdapter()` in src/adapter/index.ts and the existing session-resolution tests break.
- `npm run test:unit` has one pre-existing failure — the 'packaging gating: includes zero native modules' keytar assertion in test/activation.gating.test.ts, documented at baseline in the T01 run. It is unrelated to this todo and must not be 'fixed' here.
- This repo's runs have repeatedly flagged the extension-generated `.baiton/specs/model-selector-refresh/todos/T06/execute-<n>.md` artifact as out of scope; per the human decision on ask-0002 for T03 that artifact is expected alongside the code files and should not be treated as an unexpected edit.

## Acceptance

- `src/adapter/opencode.ts` exports `opencodeModelsFromApi`, `opencodeModelsFromCliOutput`, `mergeOpencodeModelSources`, `parseOpencodeServerUrl`, `OpencodeServer`, `OpencodeServerStarter`, `OpencodeModelsCli`, `OpencodeAdapterOptions`, `OPENCODE_SERVE_SUBCOMMAND`, `OPENCODE_SERVE_ARGS`, `OPENCODE_MODELS_SUBCOMMAND`, `OPENCODE_MODEL_ENDPOINT_PATH` and `OPENCODE_SERVER_ENV_VAR`, and `OpencodeAdapter` implements `discoverModels(ctx: DiscoveryContext): Promise<AgentCapabilities | undefined>`.
- `discoverModels` GETs `<baseUrl>/api/model` as its primary source, falls back to `opencode models` stdout when the API yields nothing, and unions the two (API order first) when both succeed.
- `discoverModels` never rejects on any path — starter failure/throw, missing binary, fetch rejection, non-2xx, malformed JSON, unparseable stdout, timeout, abort — and resolves `undefined` whenever no entry was discovered.
- An already-aborted `ctx.signal` starts no process and makes no request; an abort mid-flight resolves `undefined`; any server the adapter started is disposed exactly once on every exit path, and a pre-existing server (from `serverBaseUrl`/`OPENCODE_SERVER`) is never killed.
- The effective budget is `Math.min(ctx.timeoutMs > 0 ? ctx.timeoutMs : DEFAULT_DISCOVERY_TIMEOUT_MS, DEFAULT_DISCOVERY_TIMEOUT_MS)` and every timer created is unref'd and cleared.
- A successful result carries `efforts: []` (free text preserved) and no `source`, `stale`, `staleReason`, `fetchedAt` or `modelLink` own key; ids are `provider/model` with `provider` populated, de-duplicated, never double-prefixed.
- No secret is read: the only env access in the discovery path is the `OPENCODE_SERVER` base-URL check.
- `launch()`, `attach()`, `probe()`, `resolveSessionId()` and the `OPENCODE_CONFIG_CONTENT` layer are byte-identical to before — the existing suites in test/adapter.opencode.test.ts pass unmodified, and `new OpencodeAdapter()` / `new OpencodeAdapter(listSessions)` still compile.
- Only `src/adapter/opencode.ts` and `test/adapter.opencode.test.ts` are modified (plus the extension-generated `todos/T06/execute-<n>.md` artifact); src/adapter/index.ts, src/adapter/adapter.ts and src/orchestrator/* are untouched.
- `npx tsc --noEmit -p tsconfig.json` exits 0, `npm run compile` exits 0, and `npx eslint src/adapter/opencode.ts test/adapter.opencode.test.ts --ext .ts` is clean.
- `npm run test:unit` passes with the new suites green and the only failure being the pre-existing 'packaging gating: includes zero native modules' keytar assertion.
