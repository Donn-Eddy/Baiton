# Plan T08

## Steps

1. OpencodeAdapter.discoverFromApi: log /api/model failures to ctx.apiLog

   In src/adapter/opencode.ts add imports: `import { excerpt, noopApiLog } from '../orchestrator/apiLog';` and `import type { ApiFailureKind } from '../orchestrator/apiLog';` (no vscode import). Add module constants near OPENCODE_MODEL_ENDPOINT_PATH: `const API_LOG_SURFACE = 'opencode';` and `const API_LOG_OPERATION = 'model list';` (the agent id and the operation noun used by the discovery service).

   Inside `discoverFromApi(ctx, remaining)`, after `const url = ...`, add:
   ```ts
   const apiLog = ctx.apiLog ?? noopApiLog;
   const logFailure = (kind: ApiFailureKind, message: string, extra: { status?: number; bodyExcerpt?: string } = {}): void => {
     apiLog.failure({ surface: API_LOG_SURFACE, operation: API_LOG_OPERATION, target: url, kind, message, ...extra });
   };
   ```
   and a `let timedOut = false;` flag; change the timer to `setTimeout(() => { timedOut = true; controller.abort(); }, remaining())`.

   Then, keeping every existing `ctx.log?.(...)` call and every return value exactly as they are:
   1. Non-2xx branch (`!response.ok || status outside 200..299`): best-effort read the body for an excerpt — `let body: string | undefined; try { body = await response.text(); } catch { body = undefined; }` — then `logFailure('http-status', \`${OPENCODE_BIN} ${OPENCODE_MODEL_ENDPOINT_PATH} returned HTTP ${response.status}\`, { status: response.status, ...(body !== undefined && body.length > 0 ? { bodyExcerpt: excerpt(body) } : {}) })` before `return []`.
   2. The request `catch (e)` branch: if `timedOut` → `logFailure('timeout', \`${OPENCODE_BIN} ${OPENCODE_MODEL_ENDPOINT_PATH} request timed out\`)`; else if `isAborted(ctx.signal)` → log NOTHING (caller cancellation — window teardown or a newer refresh — is not an API failure, and the discovery service owns abort handling); else → `logFailure('connection', <same message string already passed to ctx.log>)`. Compute the message string once in a local and reuse it for ctx.log and logFailure.
   3. The `JSON.parse` catch: `logFailure('malformed-response', \`${OPENCODE_BIN} ${OPENCODE_MODEL_ENDPOINT_PATH} returned unparseable JSON\`)`.

   Do NOT log: a successful 2xx whose JSON parses (even when `opencodeModelsFromApi` yields `[]`), the early `return []` when no base URL / no fetch / already aborted / no budget (no request was made), the CLI leg, or the server-start leg. Do not add logging in `discoverModels` itself. Only one `failure()` call can happen per `discoverFromApi` invocation. Update the class doc comment point 4 / the discoverFromApi doc comment with one sentence: failures of the `/api/model` request (non-2xx, timeout, request failure, unparseable JSON) are recorded once in `ctx.apiLog` with the request URL as target; a caller abort is not logged.

   Files: `src/adapter/opencode.ts`

2. ClaudeAdapter: forward ctx.apiLog to the feed-fetch fallback

   In src/adapter/claude.ts add `import type { ApiLog } from '../orchestrator/apiLog';`.

   1. Widen the seam: `export type ClaudeFeedFetcher = (options: { timeoutMs: number; apiLog?: ApiLog }) => Promise<Result<ModelsDevFeed, string>>;` and extend its doc comment: the optional `apiLog` is the discovery context's failure log, which the default forwards to `fetchModelsDev` so the feed leg logs exactly once there.
   2. Constructor default: `this.fetchFeed = options.fetchFeed ?? ((o) => fetchModelsDev({ timeoutMs: o.timeoutMs, ...(o.apiLog !== undefined ? { apiLog: o.apiLog } : {}) }));`
   3. In `discoverModels`, leg 2: `this.fetchFeed({ timeoutMs, ...(ctx.apiLog !== undefined ? { apiLog: ctx.apiLog } : {}) })`.
   4. The adapter itself must NOT call `ctx.apiLog.failure` for a `Result` error (fetchModelsDev already logged it) — keep the existing `ctx.log?.(result.error)` unchanged. Add a short comment there saying so. No change to the catalog leg (no network) or when `ctx.feed` is supplied (no fetch at all).
   5. Add one sentence to the discoverModels doc comment: the feed leg's failures are logged by `fetchModelsDev` through the forwarded `ctx.apiLog`; the adapter adds no entry of its own.

   Files: `src/adapter/claude.ts`

3. Tests: opencode /api/model logging

   In test/adapter.opencode.test.ts add `import type { ApiFailureEntry, ApiLog } from '../src/orchestrator/apiLog';` and, inside (or as a sibling of) the `OpencodeAdapter.discoverModels` describe, a new `describe('OpencodeAdapter /api/model API failure log (api-error-log T08)', ...)` that reuses the same helper shapes (copy `ctx`, `fakeFetch`, `okResponse`, `fakeCli`, `fakeServer` or move the new tests inside the existing describe to reuse them). Recording log helper: `function recordingLog(): { log: ApiLog; entries: ApiFailureEntry[] } { const entries: ApiFailureEntry[] = []; return { log: { failure: (e) => { entries.push(e); } }, entries }; }`. Always use `runModelsCli: fakeCli(undefined).runModelsCli` so the fallback runs, and `serverBaseUrl: 'http://127.0.0.1:4096'` (or the fake starter) so the URL is deterministic; save/restore OPENCODE_SERVER as the existing afterEach does.

   Cases (each asserts `entries.length === 1` and `caps === undefined` unless stated):
   - non-2xx: fetch returns `{ ok: false, status: 503, text: async () => 'upstream down' }` → entry `{ surface: 'opencode', operation: 'model list', kind: 'http-status', status: 503, target: 'http://127.0.0.1:4096/api/model' }` and `bodyExcerpt` contains 'upstream down'.
   - request failure: fetch throws `new Error('ECONNREFUSED')` → kind 'connection', message includes 'ECONNREFUSED'.
   - timeout: fetch returns a promise that rejects when `init.signal` aborts (listen for 'abort' on the passed signal), with `ctx({ timeoutMs: 30 })` → kind 'timeout'. (FeedFetch receives `{ signal, headers }`; check the FeedFetch type in src/orchestrator/modelsDev.ts for the init param name.)
   - unparseable JSON: `okResponse('not json{')` → kind 'malformed-response'.
   - success: `okResponse(JSON.stringify(API_PAYLOAD))` → caps defined and `entries.length === 0`.
   - CLI primary success (`fakeCli(VERBOSE_FIXTURE)`) → `entries.length === 0`.
   - caller abort: fetch aborts `controller` (ctx.signal) then throws → `entries.length === 0`.
   - redaction smoke: non-2xx with body `'Authorization: Bearer sk-abcdefghijklmnopqrstuv'` → the entry is recorded (redaction happens in createApiLog; optionally wire `createApiLog(sink)` and assert the sink line does not contain 'sk-abcdefghijklmnopqrstuv').
   - no apiLog in ctx: a failing fetch still resolves undefined without throwing (noop default).

   Files: `test/adapter.opencode.test.ts`

4. Tests: claude feed fallback forwards ctx.apiLog

   In test/adapter.claude.test.ts add `import type { ApiFailureEntry, ApiLog } from '../src/orchestrator/apiLog';` and `import { fetchModelsDev } from '../src/orchestrator/modelsDev';` (merge with the existing modelsDev import), plus a new `describe('ClaudeAdapter feed fallback API failure log (api-error-log T08)', ...)` using a local `ctx()` and the `readLocalCatalog: async () => undefined` pattern from `feedOnlyAdapter`.

   Cases:
   - forwarding: a recording fetcher `async (o) => { seen.push(o.apiLog); return ok(fixtureFeed); }`; call `discoverModels(ctx({ apiLog: log }))` → `seen[0] === log` (strictEqual identity). Without `apiLog` in ctx → `seen[0] === undefined` / no own `apiLog` key.
   - end-to-end single entry: fetcher `(o) => fetchModelsDev({ timeoutMs: o.timeoutMs, apiLog: o.apiLog, fetch: async () => ({ ok: false, status: 502, text: async () => 'bad gateway' }) })` → `caps === undefined`, exactly one entry with `surface: 'models.dev'`, `operation: 'model list'`, `kind: 'http-status'`, `status: 502` (proves the adapter adds no duplicate of its own).
   - a fetcher returning `err('...')` directly (not via fetchModelsDev) produces ZERO entries from the adapter.
   - success through fetchModelsDev with a fake fetch returning the fixture JSON (`fs.readFileSync(... 'fixtures/modelsDev.sample.json')`) → caps defined, zero entries.
   - `ctx.feed` supplied → fetcher never called, zero entries; local catalog hit (readLocalCatalog returning a minimal valid cc catalog, e.g. reuse an existing catalog fixture from the claudeModelsFromCatalog tests) → fetcher never called, zero entries.
   - Ensure the existing `fakeFetcher` helper still type-checks with the widened option type (it only reads `options.timeoutMs`).

   Files: `test/adapter.claude.test.ts`

5. Verify

   Run `npm run compile`, `npm run lint`, `npm test`. Confirm no `vscode` import was added under src/adapter/, and `grep -n apiLog src/adapter/opencode.ts src/adapter/claude.ts` shows only the edits above.

   Files: (none)

## Risks

- Timeout vs connection classification in opencode relies on a `timedOut` flag set by the local timer; if the flag is not set before controller.abort() the entry would be misclassified as 'connection' — set the flag first inside the timer callback.
- Reading the response body on a non-2xx for the excerpt adds an await inside the request try block; if text() hangs it is still bounded by the same controller/timer — keep the read inside the existing try so the finally still clears the timer and removes the abort listener.
- Double logging: the ClaudeAdapter must not log a Result error itself because fetchModelsDev already logs it; the discovery service also adds one adapter-level 'malformed-response' entry when discoverModels resolves undefined — that is by design (T07) and not part of this todo's tests, which call the adapter directly.
- Caller aborts (ctx.signal) are deliberately not logged by opencode; if a reviewer expects an 'abort' entry, note that the overview scopes opencode logging to non-2xx, request failure/timeout and unparseable JSON.
- Widening ClaudeFeedFetcher's options type is additive; any other place constructing a ClaudeFeedFetcher (grep for ClaudeFeedFetcher in src/ and test/) must still compile — it will, since apiLog is optional.
- Timeout test timing: use a short ctx.timeoutMs (e.g. 30ms) and a fetch that only rejects on signal abort, to avoid flaky or slow tests; timers are unref'd so mocha won't hang.

## Acceptance

- OpencodeAdapter.discoverFromApi writes exactly one ctx.apiLog entry (surface 'opencode', operation 'model list', target '<base>/api/model') for each of: non-2xx (kind 'http-status' with status and bodyExcerpt), request rejection (kind 'connection'), local timeout (kind 'timeout'), unparseable JSON (kind 'malformed-response').
- A successful /api/model call, a successful CLI primary path, and a caller abort write zero entries; discoverModels still never rejects and its return values and ctx.log messages are unchanged.
- ClaudeFeedFetcher accepts an optional apiLog; ClaudeAdapter.discoverModels passes ctx.apiLog (by identity) to fetchFeed, and the default fetchFeed forwards it to fetchModelsDev.
- A failed feed fetch via fetchModelsDev yields exactly one 'models.dev' entry and the adapter adds none of its own; success, ctx.feed supplied, and a local-catalog hit yield zero entries.
- No vscode import in src/adapter/; existing tests in test/adapter.opencode.test.ts and test/adapter.claude.test.ts pass unchanged.
- `npm run compile`, `npm run lint` and `npm test` are all green.
