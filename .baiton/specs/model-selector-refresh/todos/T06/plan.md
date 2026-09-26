# Plan T06

## Steps

1. Add the discovery vocabulary and injectable seams to the opencode adapter module

   In src/adapter/opencode.ts, next to the existing OPENCODE_MODELS / OPENCODE_EFFORTS / OPENCODE_MODEL_DOC_URL block, add exported constants and seam types (mirroring src/adapter/codex.ts's CodexAppServerProcess / CodexAppServerSpawner / CodexAdapterOptions block, which is the template for this whole todo):

   - `export const OPENCODE_SERVE_SUBCOMMAND = 'serve';`
   - `export const OPENCODE_MODELS_SUBCOMMAND = 'models';`
   - `export const OPENCODE_MODEL_ENDPOINT = '/api/model';`
   - `export const OPENCODE_SERVE_HOSTNAME = '127.0.0.1';`
   - `export const OPENCODE_SERVE_PORT = '0';` (ephemeral port; the real port is read back from the server's own startup line)
   - `export const OPENCODE_DISCOVERY_SERVE_ARGS: readonly string[] = [OPENCODE_SERVE_SUBCOMMAND, '--hostname', OPENCODE_SERVE_HOSTNAME, '--port', OPENCODE_SERVE_PORT];`

   Seams (all structural, so no host/child_process type leaks into the pure core):

   ```ts
   /** The minimal child-process surface `discoverModels` drives for `opencode serve`. */
   export interface OpencodeServeProcess {
     readonly stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown };
     readonly stderr?: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown };
     on(event: 'error' | 'exit' | 'close', listener: (...args: unknown[]) => void): unknown;
     kill(signal?: string): unknown;
   }

   /** Spawns `opencode serve --hostname 127.0.0.1 --port 0`; the only place this module starts a server. */
   export type OpencodeServeSpawner = (options: { cwd?: string }) => OpencodeServeProcess;

   /** Runs `opencode models` in `cwd`, resolving its raw stdout; rejects on any failure. */
   export type OpencodeModelsRunner = (options: { cwd?: string; timeoutMs: number }) => Promise<string>;

   /** Optional construction options of {@link OpencodeAdapter}; every field has a default. */
   export interface OpencodeAdapterOptions {
     readonly serve?: OpencodeServeSpawner;
     readonly fetch?: FeedFetch;
     readonly runModelsCommand?: OpencodeModelsRunner;
     /** Pre-resolved server base URL; when set, NO server is spawned (tests, and a future already-running server). */
     readonly baseUrl?: string;
   }
   ```

   Reuse the existing host-free HTTP seam rather than inventing one: `import type { FeedFetch, FeedResponse } from '../orchestrator/modelsDev';` (FeedFetch = `(url, { signal, headers }) => Promise<FeedResponse>`, FeedResponse has `ok`/`status`/`text()`), and `import type { ModelEntry } from '../orchestrator/modelCatalog';`, plus `import type { AgentCapabilities, DiscoveryContext } from './adapter';` and `import { AGENT_BINARY, DEFAULT_DISCOVERY_TIMEOUT_MS, capabilitiesFromEntries } from './adapter';` (AGENT_BINARY is already imported). Add `spawn` to the existing `import { execFile } from 'child_process'` line.

   Widen the constructor without breaking `new OpencodeAdapter()` in src/adapter/index.ts (createAdapterRegistry) or the existing `new OpencodeAdapter(fakeListSessions)` calls in test/adapter.opencode.test.ts:

   ```ts
   constructor(
     private readonly listSessions: ListSessionsFn = defaultListSessions,
     options: OpencodeAdapterOptions = {},
   ) {
     this.serve = options.serve ?? defaultSpawnServe;
     this.fetchFn = options.fetch;            // undefined -> globalThis.fetch at call time
     this.runModelsCommand = options.runModelsCommand ?? defaultRunModelsCommand;
     this.baseUrlOverride = options.baseUrl;
   }
   ```

   with matching `private readonly` fields. Do NOT touch OPENCODE_MODELS / OPENCODE_EFFORTS / OPENCODE_MODEL_DOC_URL, probe(), launch(), attach(), resolveSessionId(), opencodeAgentDefinition(), opencodeAllowList() or opencodeConfigEnv(): the argv and env of every launch stay byte-identical.

   Files: `src/adapter/opencode.ts`

2. Add the pure id validator and the two pure model parsers

   Still in src/adapter/opencode.ts, above the class (pure, exported, never-throwing — the codexModelsFromAppServer equivalent):

   1. `export function opencodeModelId(value: unknown): string | undefined` — the single validation gate both sources pass through. Returns the trimmed value only when it is a non-empty string with no whitespace, containing at least one `/`, whose first `/`-split half and remainder are both non-empty (i.e. a real `provider/model` id); `undefined` otherwise. Strip a leading `- ` / `* ` bullet and any ANSI escape sequence (`/\u001b\[[0-9;]*m/g`) before the check so CLI rows parse.

   2. `export function opencodeModelsFromApi(payload: unknown): ModelEntry[]` — parse the `/api/model` body into entries, tolerating the three shapes opencode has shipped, first match wins:
      - a bare array of items;
      - `{ models: [...] }` or `{ items: [...] }` (an array);
      - a provider-keyed record `{ '<providerId>': { models: { '<modelId>': { id?, name? } } } }` (also accept `models` as an array under a provider key), where the entry id is `` `${providerKey}/${modelId}` `` when the item's own id has no `/`.
      For an array item, read the id from the first non-empty string of `id`, `modelID`, `model`, `name`; read the provider from `provider`, `providerID`, `providerId`; when the id carries no `/` and a provider is known, join them as `provider/id`. Label comes from `name` / `displayName` when it differs from the id. Every candidate id goes through `opencodeModelId`; rejects are skipped. `provider` on the entry is the id's own first `/` segment. De-duplicate by id, first-seen order preserved. Never throws, never mutates, tolerates frozen input and unknown extra fields; unrecognised shapes return `[]`.

   3. `export function opencodeModelsFromCli(stdout: unknown): ModelEntry[]` — split `String(stdout ?? '')` on `/\r?\n/`, run each line through `opencodeModelId`, drop the rejects (headers, blank lines, banner text, `Usage:` lines), and build `{ id, provider: <first segment> }`, de-duplicated by id in first-seen order. Never throws.

   Document in the doc comment of `opencodeModelsFromCli` the role the todo assigns it: it is BOTH the fallback list when the server path yields nothing AND the validation source — both sources are normalised through the same `opencodeModelId` gate, so an id that would not round-trip through `opencode -m <id>` never reaches the config panel.

   Files: `src/adapter/opencode.ts`

3. Add the server lifecycle helper (spawn, read base URL, always tear down)

   Add a private method `private startServer(ctx, timeoutMs): Promise<{ baseUrl: string; child?: OpencodeServeProcess } | undefined>` plus an exported pure helper:

   `export function opencodeServerBaseUrl(line: string): string | undefined` — extract the first `http://…` / `https://…` token from an `opencode serve` startup line (e.g. `opencode server listening on http://127.0.0.1:41235`) via `/(https?:\/\/[^\s,]+)/`, trim trailing punctuation (`.`/`,`) and any trailing `/`, and return it; `undefined` when the line carries no URL. Pure, exported, unit-tested.

   `startServer` behaviour:
   - when `this.baseUrlOverride` is a non-empty string, resolve `{ baseUrl: override }` with NO child — nothing is spawned;
   - otherwise `const child = this.serve({ cwd: ctx.cwd })`, and resolve the first base URL seen on `stdout` OR `stderr` (opencode has printed the banner on both), accumulating chunks into a line buffer exactly like codex's `onData` and feeding each complete line through `opencodeServerBaseUrl`;
   - a single idempotent `finish` clears the `setTimeout(…, timeoutMs)` (with `timer.unref?.()`), detaches the abort listener, and resolves; `error` (ENOENT -> `opencode serve was not found on PATH`), `exit`, `close`, timeout and `ctx.signal` abort all resolve `undefined` after logging through `ctx.log?.(…)`;
   - the child is returned to the caller on success so the caller owns the kill (see next step); on every failure path `startServer` kills it itself (`try { child.kill('SIGTERM'); } catch {}`).

   Files: `src/adapter/opencode.ts`

4. Implement OpencodeAdapter.discoverModels

   Add `async discoverModels(ctx: DiscoveryContext): Promise<AgentCapabilities | undefined>` to the class, implementing the `Adapter.discoverModels` contract exactly as ClaudeAdapter and CodexAdapter do (see src/adapter/claude.ts:286 and src/adapter/codex.ts:722): the whole body in one `try { … } catch { return undefined; }` so it NEVER rejects.

   Order of business:
   1. `if (ctx.signal?.aborted === true) return undefined;` — an aborted refresh must start no process and open no socket.
   2. `const timeoutMs = Math.min(ctx.timeoutMs > 0 ? ctx.timeoutMs : DEFAULT_DISCOVERY_TIMEOUT_MS, DEFAULT_DISCOVERY_TIMEOUT_MS);` and `const deadline = Date.now() + timeoutMs;` with a local `remaining = () => deadline - Date.now()` so the whole discovery (server + HTTP + CLI fallback) shares ONE wall-clock budget.
   3. Server path, in a `try`/`finally` whose `finally` always does `try { started?.child?.kill('SIGTERM'); } catch {}` — the server is torn down on success, failure, timeout and abort alike:
      - `const started = await this.startServer(ctx, remaining());`
      - when started and `remaining() > 0` and not aborted: `GET ${started.baseUrl}${OPENCODE_MODEL_ENDPOINT}` through the resolved fetch (`this.fetchFn ?? (globalThis as { fetch?: FeedFetch }).fetch`; when neither exists, skip straight to the CLI fallback) with `{ signal: controller.signal, headers: { accept: 'application/json' } }`, where `controller` is a fresh `AbortController` aborted by a `setTimeout(remaining())` AND by a forwarded `ctx.signal` abort listener (listener always removed, timer always cleared, `timer.unref?.()`).
      - a non-2xx status, a throw, an unparseable body (`JSON.parse(await response.text())` in its own try) or an empty parse all log through `ctx.log?.` and leave `entries` empty; otherwise `entries = opencodeModelsFromApi(parsed)`.
   4. CLI fallback + validation source: when `entries.length === 0` and `remaining() > 0` and `ctx.signal?.aborted !== true`, `const stdout = await this.runModelsCommand({ cwd: ctx.cwd, timeoutMs: remaining() })` inside its own try/catch (a rejection -> log + empty), then `entries = opencodeModelsFromCli(stdout)`.
   5. `if (entries.length === 0) return undefined;` — `undefined` means "keep the curated builtin free-text shape"; returning an empty capability here would falsely mark the list refreshed, and `agentCapabilities()`'s `overlayCapabilities` already treats an empty opencode snapshot as the builtin-with-stale-metadata path.
   6. `return capabilitiesFromEntries(entries, { efforts: [] });` — opencode efforts stay free text (`OPENCODE_EFFORTS` is empty by design), and deliberately NO `source`/`stale`/`staleReason`/`fetchedAt`/`modelLink`: provenance is stamped by `CatalogStore.applyResult` and the `modelLink` is re-attached by `overlayCapabilities` from the builtin table.

   No secret, env var or credential is read anywhere on this path — only ids and labels leave the host. Say so in the doc comment, as claude.ts and codex.ts do.

   Also add the two default implementations at module scope beside `defaultListSessions`:
   - `function defaultSpawnServe(options: { cwd?: string }): OpencodeServeProcess` — `spawn(OPENCODE_BIN, [...OPENCODE_DISCOVERY_SERVE_ARGS], { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })` cast through `as unknown as OpencodeServeProcess`;
   - `function defaultRunModelsCommand(options: { cwd?: string; timeoutMs: number }): Promise<string>` — `execFile(OPENCODE_BIN, [OPENCODE_MODELS_SUBCOMMAND], { cwd, timeout: options.timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, …)` resolving stdout / rejecting on error, in the shape of the existing `runVersion`.

   Finally, extend the class doc comment with a numbered point describing the discovery route (`/api/model` from a short-lived `opencode serve` on an ephemeral port, `opencode models` as fallback and validation source, ids are `provider/model`, efforts stay free text) so the adapter's documented degrades stay complete.

   Files: `src/adapter/opencode.ts`

5. Test the parsers, the base-URL helper and discoverModels end to end

   Append to test/adapter.opencode.test.ts (mocha + node:assert, same style as the file's existing suites; model the fakes on the `fakeAppServer` helper at test/adapter.codex.test.ts:1024 — plain listener arrays, `setImmediate` deliveries, NO child_process monkey-patching and no real spawn, no network).

   New imports: `opencodeModelId`, `opencodeModelsFromApi`, `opencodeModelsFromCli`, `opencodeServerBaseUrl`, `OPENCODE_MODEL_ENDPOINT`, `OPENCODE_DISCOVERY_SERVE_ARGS`, types `OpencodeServeProcess`/`OpencodeServeSpawner`/`OpencodeAdapterOptions` from '../src/adapter/opencode'; `DEFAULT_DISCOVERY_TIMEOUT_MS` and types `AgentCapabilities`/`DiscoveryContext` from '../src/adapter/adapter'; `createAdapterRegistry` from '../src/adapter/index' for the wiring assertion.

   Suite `opencodeModelId / opencodeModelsFromApi / opencodeModelsFromCli (model-selector-refresh T06)`:
   - `opencodeModelId` accepts `anthropic/claude-sonnet-5` and `openrouter/meta/llama-3.1`, strips a `- ` bullet and ANSI codes, rejects ``, `   `, `no-slash`, `provider/`, `/model`, `has space/model`, non-strings, `null`, numbers.
   - `opencodeModelsFromApi` on an array payload, a `{ models: [...] }` payload, an `{ items: [...] }` payload and a provider-keyed record all produce the same `{ id: 'anthropic/claude-sonnet-5', provider: 'anthropic', label?: 'Claude Sonnet 5' }` shape; a provider-keyed model whose own id lacks a `/` gets the key prefixed; duplicates collapse first-seen; junk items are skipped; `undefined`/`null`/`42`/`'x'` return `[]`; a deeply `Object.freeze`d payload parses without throwing (mirrors the codex frozen-input test).
   - `opencodeModelsFromCli` parses a realistic multi-line listing (banner line, blank lines, bulleted rows, duplicate row) into de-duplicated `provider/model` entries in order, and returns `[]` for `''`/`undefined`.
   - `opencodeServerBaseUrl` extracts the URL from `opencode server listening on http://127.0.0.1:41235`, drops a trailing `.`/`/`, and returns `undefined` for a line with no URL.

   Suite `OpencodeAdapter.discoverModels (model-selector-refresh T06)` — a `ctx(overrides)` helper returning `{ timeoutMs: DEFAULT_DISCOVERY_TIMEOUT_MS, ...overrides }`, a `fakeServe(script)` helper exposing `{ spawner, calls, api: { stdout, stderr, error, exit, close }, kills: () => number }`, and a `fakeFetch` recording `{ url, init }` and replying `{ ok, status, text: async () => body }`:
   - happy path: server prints its banner, `/api/model` returns the array payload -> capabilities whose `models` are the parsed ids in order, `modelEntries` carry `provider`, `efforts` is `[]`, and NO `source`/`stale`/`staleReason`/`fetchedAt`/`modelLink` own keys (`assert.deepStrictEqual(Object.keys(caps).sort(), ['efforts','modelEntries','models'])`);
   - the fetch URL is exactly `<banner base url>` + `OPENCODE_MODEL_ENDPOINT` and the spawner was called with `ctx.cwd`; the serve argv constant contains `serve`, `--hostname 127.0.0.1`, `--port 0`;
   - `baseUrl` option short-circuits the spawn: `kills() === 0` and `calls.length === 0`;
   - the server child is killed on EVERY path: success, HTTP 500, banner-less timeout, abort;
   - fallback: `/api/model` returns HTTP 500 (and separately: invalid JSON; an empty array; `opencode serve` emits `error` with `code: 'ENOENT'`; no banner before the timeout) -> `runModelsCommand` is invoked exactly once and its stdout becomes the capability models;
   - when the API path succeeds, `runModelsCommand` is NOT invoked (assert the call count is 0);
   - both sources empty -> resolves `undefined` (never an empty capability), and `runModelsCommand` rejecting (missing binary) also resolves `undefined`;
   - never rejects: a spawner that throws synchronously, a spawner returning a child with a throwing `kill`, a fetch that rejects, and a `runModelsCommand` that rejects each resolve `undefined` with the adapter still settling;
   - `ctx.signal` already aborted on entry -> `undefined` with `calls.length === 0`, no fetch and no CLI run; a signal aborted mid-flight (after the banner, before the reply) -> `undefined` and the child killed;
   - `ctx.timeoutMs` of 0 or a huge value is clamped to `DEFAULT_DISCOVERY_TIMEOUT_MS` (assert via a slow fake that never replies and a small injected timeout so the test stays fast);
   - wiring: `assert.strictEqual(typeof createAdapterRegistry().require('opencode').discoverModels, 'function')` and the no-arg / single-arg (`new OpencodeAdapter(fakeListSessions)`) constructors still compile and work.

   Add no timing-fragile sleeps: drive every outcome through the fake's explicit `api.*` calls, and use small injected `timeoutMs` values (20–50 ms) for the timeout cases, as the codex suite does.

   Files: `test/adapter.opencode.test.ts`

6. Verify

   Run, from the repo root: `npx tsc --noEmit -p tsconfig.json`; `npm run compile`; `npx eslint src/adapter/opencode.ts test/adapter.opencode.test.ts --ext .ts`; `npm run test:unit`. The only acceptable failure is the pre-existing `packaging gating: includes zero native modules` keytar assertion in test/activation.gating.test.ts, documented as failing at baseline since T01 — every other suite must stay green, in particular test/adapter.opencode.test.ts, test/adapter.index.test.ts, test/adapter.registry.test.ts and test/adapter.launch.property.test.ts (the launch/attach argv must not move).

   Files: `src/adapter/opencode.ts`, `test/adapter.opencode.test.ts`

## Risks

- The `/api/model` response shape is not pinned by anything checked into this repo (unlike the models.dev fixture), and opencode has shipped both a flat model list and a provider-keyed `{provider: {models: {...}}}` record. The parser therefore accepts array, `{models:[]}`, `{items:[]}` and provider-keyed shapes and returns `[]` for anything else, so a shape change degrades to the `opencode models` fallback rather than to a wrong list.
- The `opencode serve` startup banner's exact wording/stream is likewise unverified here. `opencodeServerBaseUrl` therefore matches any `http(s)://…` token on either stdout or stderr; if no banner arrives within the budget the adapter times out, kills the child and falls back to the CLI — the failure mode is a slower refresh, never a hang, because the whole call shares one clamped wall-clock deadline.
- The todo calls `opencode models` both the fallback AND the validation source. This plan reads that as: the CLI is run only when the server path yields no entries (no double cost on the happy path), while its `opencode provider/model` id grammar — `opencodeModelId` — is the single gate BOTH sources pass through, so no id that the CLI grammar rejects can reach the config panel. If the reviewer intends the CLI to be run unconditionally and intersected with the API list, that is a one-line change in `discoverModels` step 4's guard.
- Spawning a server, even on 127.0.0.1 and an ephemeral port, is heavier than codex's stdio child: a leaked child would outlive the window. Mitigated by the single `finally` that kills on every path (success, HTTP failure, timeout, abort, throw) and by an explicit test asserting `kills() >= 1` on each of those paths; `stdio[0]` is `'ignore'` so nothing can block on stdin.
- The constructor gains a second parameter. `createAdapterRegistry()` in src/adapter/index.ts calls `new OpencodeAdapter()` and existing tests call `new OpencodeAdapter(fakeListSessions)`; keeping `listSessions` FIRST and `options` second with a `{}` default keeps both compiling. Do not reorder them.
- Scope: the todo's files are src/adapter/opencode.ts and test/adapter.opencode.test.ts only. The README 'Agent Model & Effort Discovery' section (which still describes the static catalogue and names `opencode models` as a future source) belongs to the spec's later documentation todo — do not edit it here. As settled for T03 by ask-0002, the extension-generated `.baiton/specs/model-selector-refresh/todos/T06/execute-<n>.md` artifact in the execution commit is expected and is not an out-of-scope file.

## Acceptance

- `npx tsc --noEmit -p tsconfig.json` exits 0 and `npm run compile` succeeds.
- `npx eslint src/adapter/opencode.ts test/adapter.opencode.test.ts --ext .ts` reports no errors or warnings.
- `npm run test:unit` passes with the single documented pre-existing exception (`packaging gating: includes zero native modules` in test/activation.gating.test.ts); no other suite regresses.
- `OpencodeAdapter.prototype.discoverModels` exists, is wired through the registry (`createAdapterRegistry().require('opencode').discoverModels` is a function) and `createAdapterRegistry().require('antigravity').discoverModels` is still `undefined`.
- `discoverModels` never rejects: a throwing spawner, a rejecting fetch, a non-2xx status, invalid JSON, an unrecognised payload shape, a missing binary (ENOENT), a timeout and an aborted signal each resolve `undefined` — and `undefined`, not an empty capability, is what a fully empty discovery returns.
- On success the capability is exactly `{ models, efforts: [], modelEntries }` — ids are `provider/model`, entries carry `provider`, and no `source`/`stale`/`staleReason`/`fetchedAt`/`modelLink` own key is written (provenance belongs to `CatalogStore.applyResult`; the modelLink is re-attached by `overlayCapabilities` in src/adapter/index.ts).
- The `opencode serve` child is killed on every exit path, and no child is spawned at all when `ctx.signal` is already aborted or when the `baseUrl` option is supplied.
- The `opencode models` fallback runs exactly when the `/api/model` path produced no entries, and never when it succeeded.
- Every id from either source passes the same `opencodeModelId` `provider/model` validation; duplicates collapse first-seen and order is preserved.
- `probe()`, `launch()`, `attach()`, `resolveSessionId()`, `opencodeAgentDefinition()`, `opencodeAllowList()` and `opencodeConfigEnv()` are behaviourally unchanged — the existing opencode, registry and launch-property suites pass untouched, and no launch argv or env byte moves.
- No secret, credential or env var is read on the discovery path; only model ids and labels leave the host.
