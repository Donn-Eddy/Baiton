# Plan T05

## Steps

1. Add the app-server vocabulary and the injectable spawn seam to src/adapter/codex.ts

   At the top of the file extend the imports: add `spawn` to the existing `import { execFile } from 'child_process'` (i.e. `import { execFile, spawn } from 'child_process'`), and add to the existing type-only adapter import (`import type { Adapter, AskRelayDescriptor, DiscoverSessionInput, LaunchRequest, LaunchSpec, ProbeResult } from './adapter'`) the names `AgentCapabilities` and `DiscoveryContext`; add a value import `import { AGENT_BINARY, DEFAULT_DISCOVERY_TIMEOUT_MS, capabilitiesFromEntries } from './adapter'` (AGENT_BINARY is already imported from there — extend that statement rather than adding a second one); add `import type { ModelEntry } from '../orchestrator/modelCatalog'`.

   Then, in a new section placed AFTER the existing `CODEX_EFFORTS` / `codexEffortFlags` block and BEFORE the ask-relay block (so the discovery vocabulary sits with the model/effort vocabulary it extends), add these exported constants, each with a doc comment naming the protocol step it covers:

   - `export const CODEX_APP_SERVER_SUBCOMMAND = 'app-server';` — the argv is exactly `codex app-server` (no other flag; never `exec`).
   - `export const CODEX_APP_SERVER_INITIALIZE_METHOD = 'initialize';`
   - `export const CODEX_APP_SERVER_INITIALIZED_NOTIFICATION = 'initialized';`
   - `export const CODEX_APP_SERVER_MODEL_LIST_METHOD = 'model/list';`
   - `export const CODEX_APP_SERVER_INITIALIZE_ID = 1;` and `export const CODEX_APP_SERVER_MODEL_LIST_ID = 2;` — the two JSON-RPC request ids used, so the reader can assert framing.
   - `export const CODEX_APP_SERVER_CLIENT_INFO = { name: 'baiton', version: '1.0.0' } as const;` — sent as `params.clientInfo` of `initialize`; a literal, never read from disk or env.

   Add the process seam so tests never spawn a real CLI (mirroring `ListSessionsFn` in src/adapter/opencode.ts and `ClaudeFeedFetcher` in src/adapter/claude.ts):

   ```ts
   /** The minimal child-process surface `discoverModels` uses; `ChildProcessWithoutNullStreams` satisfies it structurally. */
   export interface CodexAppServerProcess {
     readonly stdin: { write(chunk: string): unknown; end(): unknown };
     readonly stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown };
     readonly stderr?: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown };
     on(event: 'error' | 'exit' | 'close', listener: (...args: unknown[]) => void): unknown;
     kill(signal?: string): unknown;
   }

   /** Spawns `codex app-server` with piped stdio; the only place this module starts a process for discovery. */
   export type CodexAppServerSpawner = (options: { cwd?: string }) => CodexAppServerProcess;

   /** Optional construction options of {@link CodexAdapter}; every field has a default. */
   export interface CodexAdapterOptions {
     readonly spawnAppServer?: CodexAppServerSpawner;
   }
   ```

   Add the module-private default spawner next to the other private helpers at the bottom of the file:

   ```ts
   function defaultSpawnAppServer(options: { cwd?: string }): CodexAppServerProcess {
     const child = spawn(CODEX_BIN, [CODEX_APP_SERVER_SUBCOMMAND], {
       cwd: options.cwd,
       stdio: ['pipe', 'pipe', 'pipe'],
       windowsHide: true,
     });
     return child as unknown as CodexAppServerProcess;
   }
   ```

   Give `CodexAdapter` a constructor that keeps the existing no-arg call sites (`new CodexAdapter()` in src/adapter/index.ts:156, test/adapter.launch.property.test.ts, test/engineFacade.resume.test.ts) compiling:

   ```ts
   private readonly spawnAppServer: CodexAppServerSpawner;
   constructor(options: CodexAdapterOptions = {}) {
     this.spawnAppServer = options.spawnAppServer ?? defaultSpawnAppServer;
   }
   ```

   Do not touch `probe`, `launch`, `attach`, `discoverSessionId`, any relay constant/function, or `CODEX_MODELS`/`CODEX_EFFORTS`: the launch argv must stay byte-identical.

   Files: `src/adapter/codex.ts`

2. Add the pure `codexModelsFromAppServer` payload parser

   Export a pure, total, never-throwing parser in src/adapter/codex.ts (place it just below the app-server constants, so the protocol shape is documented next to the method names):

   ```ts
   export function codexModelsFromAppServer(payload: unknown): ModelEntry[]
   ```

   Rules, all documented in the doc comment as deliberately tolerant (the response shape is only loosely pinned by the CLI, so an unrecognised field is ignored rather than failing the whole refresh):

   - Accept the `result` payload as a bare array, or an object whose `models` (preferred) or `items` (fallback) property is an array. Anything else → `[]`.
   - Per item: a string becomes `{ id: trimmed }`; an object's id is the first non-empty trimmed string of `id`, `model`, `slug`. An item with no usable id is skipped.
   - `label`: the first non-empty trimmed string of `displayName`, `name`; set ONLY when it differs from the id (same rule as `claudeModelsFromFeed` in src/adapter/claude.ts).
   - `efforts`: from `supportedReasoningEfforts` when it is an array — each element a non-empty trimmed string, or an object whose `effort`/`id`/`name` is one; blanks skipped, duplicates dropped keeping first-seen order. Set only when the resulting list is non-empty.
   - `defaultEffort`: the first non-empty trimmed string of `defaultReasoningEffort`, `defaultEffort`; kept only when `efforts` is empty/absent or contains it (so a response cannot select a level it did not advertise).
   - De-duplicate by id across items, first occurrence wins.
   - Build every entry with CONDITIONAL key assignment — never write an explicit `undefined` own key — matching `normalizeModelEntry` in src/orchestrator/modelCatalog.ts and `capabilitiesFromEntries` in src/adapter/adapter.ts.
   - Never throws and never mutates the input; no env var, secret or credential is read anywhere in this path.

   Files: `src/adapter/codex.ts`

3. Implement `CodexAdapter.discoverModels` over the stdio JSON-RPC handshake

   Add `async discoverModels(ctx: DiscoveryContext): Promise<AgentCapabilities | undefined>` to `CodexAdapter`, placed after `discoverSessionId` and before the private `runVersion`. Contract, per src/adapter/adapter.ts:300 and the `ClaudeAdapter.discoverModels` precedent in src/adapter/claude.ts:286 — it MUST never reject and MUST resolve `undefined` on any failure (undefined means "keep the curated `CODEX_MODELS`/`CODEX_EFFORTS` list"; returning the curated list here would falsely mark it refreshed).

   Body shape:

   1. Wrap everything in `try { … } catch { return undefined; }` so even a synchronous throw from the injected spawner resolves `undefined`.
   2. `if (ctx.signal?.aborted === true) { return undefined; }` BEFORE spawning — an aborted refresh must start no process.
   3. `const timeoutMs = Math.min(ctx.timeoutMs > 0 ? ctx.timeoutMs : DEFAULT_DISCOVERY_TIMEOUT_MS, DEFAULT_DISCOVERY_TIMEOUT_MS);` (identical clamp to claude's).
   4. `const child = this.spawnAppServer({ cwd: ctx.cwd });` then drive one `new Promise<ModelEntry[] | undefined>` whose settle path is a single idempotent `finish(entries?: ModelEntry[], reason?: string)` closure that: guards a `settled` boolean; clears the timeout timer; removes the `abort` listener from `ctx.signal`; calls `ctx.log?.(reason)` when a reason was given; best-effort `try { child.stdin.end(); } catch {}` and `try { child.kill('SIGTERM'); } catch {}` — the child is killed on EVERY path (success, error, timeout, abort), never left running; and resolves.
   5. Framing: line-delimited JSON (JSONL), one JSON object per line, NOT `Content-Length` framing. Keep a `buffer` string, append each `stdout` `data` chunk via `String(chunk)`, split on `\n`, keep the trailing partial line in `buffer` (so a response split across chunk boundaries still parses), and for each complete line: skip when the trimmed line is empty, `JSON.parse` inside try/catch and skip an unparseable line, then dispatch on the parsed message.
   6. Dispatch: ignore anything that is not an object, anything with no `id` matching one of our two ids (server notifications and server→client requests are ignored, never answered). On `id === CODEX_APP_SERVER_INITIALIZE_ID`: a truthy `error` property finishes with `undefined` and a reason naming the failed `initialize`; otherwise write the `initialized` NOTIFICATION (no `id`) and then the `model/list` request. On `id === CODEX_APP_SERVER_MODEL_LIST_ID`: a truthy `error` finishes `undefined` with a reason; otherwise `codexModelsFromAppServer((message as {result?: unknown}).result)` and finish with those entries.
   7. Writing: a private helper `writeMessage(child, message)` doing `child.stdin.write(`${JSON.stringify(message)}\n`)` inside try/catch (a write to a dead pipe finishes `undefined`, never throws). Messages sent, in this exact order and no others: `{ jsonrpc: '2.0', id: CODEX_APP_SERVER_INITIALIZE_ID, method: CODEX_APP_SERVER_INITIALIZE_METHOD, params: { clientInfo: CODEX_APP_SERVER_CLIENT_INFO } }`, then `{ jsonrpc: '2.0', method: CODEX_APP_SERVER_INITIALIZED_NOTIFICATION, params: {} }`, then `{ jsonrpc: '2.0', id: CODEX_APP_SERVER_MODEL_LIST_ID, method: CODEX_APP_SERVER_MODEL_LIST_METHOD, params: {} }`. Write the `initialize` request only after the listeners are installed.
   8. Failure wiring: `child.on('error', …)` finishes `undefined` with a reason distinguishing ENOENT (`` `${CODEX_BIN} ${CODEX_APP_SERVER_SUBCOMMAND} was not found on PATH` ``) from any other spawn error; `child.on('exit', …)` and `child.on('close', …)` finish `undefined` with a reason when the model/list response has not arrived (a late exit after success is a no-op thanks to the `settled` guard); `setTimeout(() => finish(undefined, `${CODEX_BIN} ${CODEX_APP_SERVER_SUBCOMMAND} timed out after ${timeoutMs}ms`), timeoutMs)` with `timer.unref?.()` so a stray timer can never hold the test process open; `ctx.signal?.addEventListener('abort', onAbort)` finishing `undefined`. Optionally attach a `stderr` `data` listener that only forwards to `ctx.log?.()` (drained so a chatty child cannot block on a full pipe); it must never affect the outcome.
   9. Result mapping after the promise resolves: `undefined` or an empty entry list → return `undefined`. Otherwise `const hasEfforts = entries.some((entry) => (entry.efforts ?? []).length > 0);` and `return capabilitiesFromEntries(entries, hasEfforts ? undefined : { efforts: [...CODEX_EFFORTS] });` — with per-model levels present, `capabilitiesFromEntries` computes the first-seen UNION of the returned levels as the capability-level `efforts`; with none disclosed, the curated `CODEX_EFFORTS` is the documented fallback. Pass no `source`/`stale`/`staleReason`/`fetchedAt`/`modelLink`: provenance is stamped by `CatalogStore.applyResult`, and codex has no model doc link (assert-free comment, same as claude's).

   Extend the `CodexAdapter` class doc comment with a numbered degrade/note entry describing discovery: `codex app-server` stdio JSON-RPC (`initialize` → `initialized` → `model/list`), the never-throw/timebox/kill-the-child contract, that per-model `supportedReasoningEfforts` become `ModelEntry.efforts`/`defaultEffort` and their union the capability `efforts` (falling back to `CODEX_EFFORTS`), and that discovery reads no secrets — only ids and labels leave the host.

   Files: `src/adapter/codex.ts`

4. Add the discovery test suites to test/adapter.codex.test.ts

   Append two `describe` blocks — `codexModelsFromAppServer (model-selector-refresh T05)` and `CodexAdapter.discoverModels (model-selector-refresh T05)` — after the existing suites, and extend the file's header comment with a bullet for the app-server discovery handshake. Extend the existing imports: from '../src/adapter/codex' add `CODEX_MODELS`, `CODEX_EFFORTS`, `CODEX_APP_SERVER_SUBCOMMAND`, `CODEX_APP_SERVER_INITIALIZE_METHOD`, `CODEX_APP_SERVER_INITIALIZED_NOTIFICATION`, `CODEX_APP_SERVER_MODEL_LIST_METHOD`, `CODEX_APP_SERVER_INITIALIZE_ID`, `CODEX_APP_SERVER_MODEL_LIST_ID`, `codexModelsFromAppServer`, and the types `CodexAppServerProcess`/`CodexAppServerSpawner`; from '../src/adapter/adapter' add `DEFAULT_DISCOVERY_TIMEOUT_MS`, `capabilitiesToCatalogFetch` and the types `AgentCapabilities`, `DiscoveryContext`; add `import { createAdapterRegistry } from '../src/adapter/index'` (mirroring the registry-wiring assertion at test/adapter.claude.test.ts:895).

   Test helpers (no `child_process` monkey-patching, no real spawn — inject through `new CodexAdapter({ spawnAppServer })`, the pattern of test/adapter.claude.test.ts's `fakeFetcher`):

   - `function ctx(overrides: Partial<DiscoveryContext> = {}): DiscoveryContext { return { timeoutMs: DEFAULT_DISCOVERY_TIMEOUT_MS, ...overrides }; }`
   - `function fakeAppServer(script: { onLine?(line: unknown, api: FakeApi): void; onSpawn?(api: FakeApi): void })` returning `{ spawner, calls, writes, kills, emit }` where the fake process object implements `CodexAppServerProcess` over plain listener arrays: `stdin.write` pushes the raw chunk into `writes` (the suite asserts on `writes.map((w) => JSON.parse(w))`) and invokes the script's `onLine`; `stdout.on('data', …)` records the listener so the script can push chunks (as a string OR a `Buffer`, and possibly a partial line) via `api.stdout(chunk)`; `kill()` increments `kills`; `on('error'|'exit'|'close')` records listeners so the script can fire them via `api.error(err)` / `api.exit(code)`. Replies are delivered asynchronously (`setImmediate`) so the adapter's promise wiring is exercised, and `calls` records each `{ cwd }` the spawner was called with.
   - A default happy script: on the `initialize` request reply `{ jsonrpc: '2.0', id: 1, result: {} }`; on the `model/list` request reply `{ jsonrpc: '2.0', id: 2, result: { models: [ { id: 'gpt-6-astra', displayName: 'GPT-6 Astra', supportedReasoningEfforts: ['low','medium','high','xhigh'], defaultReasoningEffort: 'medium' }, { id: 'gpt-5-codex', supportedReasoningEfforts: ['minimal','low','medium','high'], defaultReasoningEffort: 'low' } ] } }`; the `initialized` notification is recorded and not answered.

   Cases for `codexModelsFromAppServer` (pure, no adapter): `{models:[…]}`, `{items:[…]}` and a bare array all parse; string items become `{id}`; ids are trimmed and blank/absent ids skipped; a duplicate id keeps the first entry; `displayName`/`name` become `label` only when different from the id; `supportedReasoningEfforts` of plain strings and of `{effort}` objects both parse, blanks and duplicates dropped, order preserved; `defaultReasoningEffort` absent from a non-empty `efforts` list is dropped while `defaultEffort` alongside empty efforts is kept; `undefined`, `null`, `42`, `'x'`, `{}` and `{models:'nope'}` all yield `[]`; no entry carries an own `undefined` key (assert via `Object.prototype.hasOwnProperty`).

   Cases for `discoverModels`:
   1. Happy path — resolves models `['gpt-6-astra','gpt-5-codex']`; `modelEntries` carry per-model `efforts`/`defaultEffort` and the `label` only for the first; `caps.efforts` deep-equals the first-seen union `['low','medium','high','xhigh','minimal']`; `caps` carries NO own `source`/`stale`/`staleReason`/`fetchedAt`/`modelLink` key; `writes` parsed is exactly the three messages in order — `initialize` with `id: CODEX_APP_SERVER_INITIALIZE_ID` and `params.clientInfo`, the `initialized` notification with no `id`, `model/list` with `id: CODEX_APP_SERVER_MODEL_LIST_ID` — each `jsonrpc: '2.0'` and each written chunk newline-terminated; `kills` is at least 1.
   2. `capabilitiesToCatalogFetch(caps)` round-trips the ids and the union `efforts`.
   3. Models with no `supportedReasoningEfforts` → `caps.efforts` deep-equals `[...CODEX_EFFORTS]` and `caps.models` is the discovered ids (not `CODEX_MODELS`).
   4. `ctx.cwd` is forwarded to the spawner.
   5. Multi-chunk framing — the `model/list` response delivered as two chunks split mid-line (and one chunk as a `Buffer`), plus interleaved blank lines, a non-JSON line, a notification with no `id` and a server→client request with an unknown `id`: still resolves the models, and no reply is written for the notification/unknown request (`writes` stays at three).
   6. `initialize` replying `{ error: { code: -32600, message: 'bad' } }` → `undefined`, and NO `model/list` was written (`writes` has exactly one entry); the child was killed.
   7. `model/list` replying with a JSON-RPC `error` → `undefined`, child killed, and `ctx.log` received a non-empty message.
   8. Missing binary — the fake fires `error` with `Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' })` → `undefined` and the logged message mentions `codex app-server` / PATH.
   9. Early exit — the fake fires `exit(1)` (and separately `close`) before any response → `undefined`, no rejection.
   10. Timeout — a script that never replies with `ctx({ timeoutMs: 30 })` → `undefined` within the test timeout, child killed exactly once, `ctx.log` mentions the timeout; the clamp is also pinned: `ctx({ timeoutMs: 60_000 })` still times out via the `DEFAULT_DISCOVERY_TIMEOUT_MS` ceiling (assert by inspecting the reason/behaviour rather than waiting — e.g. a script that replies immediately, plus a direct assertion that a `timeoutMs: 0` context still spawns and succeeds).
   11. Abort — an already-aborted `AbortSignal` resolves `undefined` AND the spawner was never called (`calls.length === 0`); an abort fired mid-flight (after `initialize`, before the `model/list` reply) resolves `undefined` and kills the child.
   12. A spawner that throws synchronously, and one whose `stdin.write` throws, both resolve `undefined` (never reject).
   13. Empty discovered list (`{ models: [] }`) → `undefined`, so the curated `CODEX_MODELS` list is kept by `agentCapabilities()`.
   14. Wiring — `typeof createAdapterRegistry().require('codex').discoverModels === 'function'`, `createAdapterRegistry().require('antigravity').discoverModels === undefined`, and `new CodexAdapter()` (no argument) still constructs, launches and attaches exactly as the existing suites assert.

   Every test must finish deterministically: no real timers longer than ~50 ms, no unhandled rejection (consume every promise), and no listener left attached to `process`.

   Files: `test/adapter.codex.test.ts`

5. Verify and keep the change inside the todo's file scope

   Run, from the workspace root: `npx tsc --noEmit -p tsconfig.json`; `npm run compile`; `npx eslint src/adapter/codex.ts test/adapter.codex.test.ts --ext .ts`; `npm run test:unit`. The only acceptable failure is the pre-existing `packaging gating: includes zero native modules` keytar assertion in test/activation.gating.test.ts, documented as failing at baseline — every other suite must pass, and the new codex discovery suites must be green.

   Touch only src/adapter/codex.ts and test/adapter.codex.test.ts. Do not edit src/adapter/index.ts (the registry's `new CodexAdapter()` keeps working because the new constructor parameter is optional), src/adapter/adapter.ts (the `discoverModels` seam already exists from T03), or test/adapter.index.test.ts. Note that test/adapter.index.test.ts:344 asserts 'no adapter implements discoverModels yet' — verify what it actually asserts before running: if it iterates the registry and requires `discoverModels === undefined` for codex it will now fail, and the minimal fix belongs there; T04 already had to make that assertion claude-aware, so it most likely already allows implemented adapters (test/adapter.claude.test.ts:896 asserts claude's is a function). If a change to test/adapter.index.test.ts is genuinely required, keep it to the single assertion about which adapters implement the seam and say so in the execution summary. The extension-generated `.baiton/specs/model-selector-refresh/todos/T05/execute-<n>.md` artifact appearing in the commit is expected (same as the approved T03 scope) and is not a code change.

   Files: `src/adapter/codex.ts`, `test/adapter.codex.test.ts`

## Risks

- The exact `codex app-server` response shape for `model/list` is not pinned by anything checked into this repo, and no probe can be run from a planning stage. The plan therefore makes `codexModelsFromAppServer` deliberately tolerant (`models` | `items` | bare array; `id`/`model`/`slug`; `displayName`/`name`; `supportedReasoningEfforts` of strings or objects) and makes every unrecognised shape resolve `undefined`, which keeps the curated `CODEX_MODELS` list. If the real field names differ, only this one pure function needs revising.
- Framing assumption: line-delimited JSON over stdio, not `Content-Length` headers. If the CLI ever emits LSP-style framing the parser sees no parseable lines and discovery degrades to a timeout → `undefined` (stale/builtin list), never a crash — but it would also never discover anything, so the JSONL assumption is the single highest-value thing to re-probe.
- A leaked child process or timer would outlive the refresh and could hang `npm run test:unit`. Mitigated by the single idempotent `finish()` that always clears the timer, removes the abort listener, ends stdin and kills the child, by `timer.unref?.()`, and by the fake-process tests asserting `kills >= 1` on the success, error, timeout and abort paths.
- `discoverModels` must never reject: an unhandled rejection from the spawner, a write to a dead pipe, or a listener callback would break unrelated suites. Mitigated by the outer try/catch, try/catch around every `stdin.write`/`kill`, and explicit tests for a synchronously throwing spawner and a throwing `write`.
- Adding a constructor parameter to `CodexAdapter` could break the existing no-arg call sites (src/adapter/index.ts:156, test/adapter.launch.property.test.ts, test/engineFacade.resume.test.ts); the parameter is optional with a default `{}` precisely so those compile unchanged, and step 5 pins that with tsc plus a wiring test.
- test/adapter.index.test.ts's 'no adapter implements discoverModels yet' assertion may still enumerate adapters and now see codex implementing the seam. Step 5 says to check it before running and, if it fails, to keep the fix to that single assertion — a file outside the todo's nominal two-file scope, which must be called out in the execution summary.
- Spawning `codex app-server` on every window reload is a new process start on the user's machine. It is timeboxed by `min(ctx.timeoutMs, DEFAULT_DISCOVERY_TIMEOUT_MS)`, never awaited by activation, and killed on every exit path; discovery reads no secrets and sends nothing but model ids and labels onward.

## Acceptance

- `CodexAdapter` implements `discoverModels(ctx: DiscoveryContext): Promise<AgentCapabilities | undefined>`; `createAdapterRegistry().require('codex').discoverModels` is a function and antigravity's is still `undefined`.
- On success the adapter writes exactly three JSON-RPC messages, newline-terminated, in order: `initialize` (id `CODEX_APP_SERVER_INITIALIZE_ID`, `params.clientInfo`), the `initialized` notification (no `id`), `model/list` (id `CODEX_APP_SERVER_MODEL_LIST_ID`); notifications and unknown-id server messages are never answered.
- Each returned model maps to a `ModelEntry` with its `supportedReasoningEfforts` as `efforts` and `defaultReasoningEffort` as `defaultEffort`; the capability-level `efforts` is the first-seen union of the returned levels, and `[...CODEX_EFFORTS]` when no model discloses any.
- The resolved `AgentCapabilities` carries no own `source`, `stale`, `staleReason`, `fetchedAt` or `modelLink` key, and `capabilitiesToCatalogFetch` round-trips its ids and efforts.
- Every failure path — missing binary (ENOENT), `initialize` or `model/list` JSON-RPC error, malformed/unparseable stdout, early exit/close, timeout, aborted `ctx.signal`, throwing spawner, throwing `stdin.write`, empty model list — resolves `undefined` and never rejects; an already-aborted signal spawns no process.
- The child process is killed and stdin ended on every path (success, error, timeout, abort), and the timeout timer is cleared and unref'd; no test leaves a live process, timer or listener behind.
- `codexModelsFromAppServer` is pure and total: it never throws, never mutates its input, trims and de-duplicates ids, drops a `defaultEffort` absent from a non-empty `efforts` list, writes no explicit `undefined` own keys, and returns `[]` for any unrecognised payload.
- Launch behaviour is unchanged: the existing codex suites (probe, fresh/resume/attach argv, sandbox and approval flags, `--add-dir`, `developer_instructions` TOML quoting, relay flags and hook script) pass untouched, and `new CodexAdapter()` with no argument still compiles and behaves identically.
- `npx tsc --noEmit -p tsconfig.json` and `npm run compile` exit 0; `npx eslint src/adapter/codex.ts test/adapter.codex.test.ts --ext .ts` is clean; `npm run test:unit` passes with the single pre-existing `packaging gating: includes zero native modules` keytar failure as the only failure.
- The diff is confined to src/adapter/codex.ts and test/adapter.codex.test.ts (plus the extension-generated `todos/T05/execute-<n>.md` artifact); any unavoidable one-assertion edit to test/adapter.index.test.ts is called out explicitly in the execution summary.
