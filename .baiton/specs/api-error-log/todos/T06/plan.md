# Plan T06

## Steps

1. Add the apiLog option to FetchModelsDevOptions

   In src/orchestrator/modelsDev.ts add `import type { ApiLog, ApiFailureKind } from './apiLog';` and `import { noopApiLog } from './apiLog';` (relative import, no vscode). Extend `FetchModelsDevOptions` with a documented optional field:

   ```ts
   /** Failure log; one entry per failed fetch. Defaults to {@link noopApiLog}. */
   apiLog?: ApiLog;
   ```

   Add module-level constants `const API_SURFACE = 'models.dev';` and `const API_OPERATION = 'model list';`. Update the module header doc comment and the `fetchModelsDev` doc comment with one sentence: every err path also writes exactly one entry to `options.apiLog` (surface 'models.dev', operation 'model list', target the feed URL); successful fetches write nothing; the returned `Result` is unchanged.

   Files: `src/orchestrator/modelsDev.ts`

2. Route every err path in fetchModelsDev through one local fail helper

   Inside `fetchModelsDev`, after computing `url` and `timeoutMs`, add `const apiLog = options.apiLog ?? noopApiLog;` and a closure:

   ```ts
   const fail = (kind: ApiFailureKind, message: string, status?: number): Result<ModelsDevFeed, string> => {
     apiLog.failure({ surface: API_SURFACE, operation: API_OPERATION, target: url, kind, message, ...(status !== undefined ? { status } : {}) });
     return err(message);
   };
   ```

   (If exactOptionalPropertyTypes is not on, `status` can be passed directly; the spread form is safe either way.) Replace each existing `return err(...)` with `return fail(...)`, keeping the EXACT same message strings so the Result contract and existing tests are unchanged:
   - missing global fetch → `fail('connection', 'models.dev fetch is unavailable in this runtime')` (the helper must be defined before this early return, so move the `apiLog`/`fail` declarations above it).
   - fetchFn throws and `controller.signal.aborted` → `fail('timeout', `models.dev request timed out after ${timeoutMs}ms`)`.
   - fetchFn throws otherwise → `fail('connection', `models.dev request failed: ${errorMessage(error)}`)`.
   - non-2xx → `fail('http-status', `models.dev returned HTTP ${response.status}`, response.status)`. Do NOT read the response body here (no protocol/semantics change; no bodyExcerpt).
   - `response.text()` throws: aborted → `fail('timeout', ...)`, otherwise → `fail('connection', ...)` with the same messages as today.
   - JSON.parse throws → `fail('malformed-response', 'models.dev returned invalid JSON')`.
   - Final parse: replace `return parseModelsDevFeed(parsed);` with `const feed = parseModelsDevFeed(parsed); if (!feed.ok) { return fail('malformed-response', feed.error); } return feed;` (use the Result narrowing idiom used elsewhere in the file/`../model/result`; `feed.error` is the parser's string).
   The success path must not call apiLog. `createApiLog` already swallows sink errors, so no try/catch is needed at the call site; `fetchModelsDev` still never throws/rejects. Keep `clearTimeout` in the `finally`.

   Files: `src/orchestrator/modelsDev.ts`

3. Test: one entry per failure path, none on success

   In test/modelsDev.test.ts import `{ createApiLog }` and `type { ApiLog }` from '../src/orchestrator/apiLog'. Add a helper:

   ```ts
   function recordingLog(): { apiLog: ApiLog; lines: string[] } {
     const lines: string[] = [];
     return { apiLog: createApiLog((line) => lines.push(line), () => 'T'), lines };
   }
   ```

   Add a nested `describe('apiLog', ...)` inside `describe('fetchModelsDev')` with one test per path, each asserting the Result is still `ok: false` with the SAME error text as before AND `lines.length === 1` and the line content (format is `[T] models.dev model list <kind>[ HTTP <status>] <url> — <message>`):
   1. success with fixture → `result.ok === true` and `lines.length === 0`.
   2. non-2xx 503 → line starts with `[T] models.dev model list http-status HTTP 503 ` and contains `MODELS_DEV_URL` and `models.dev returned HTTP 503`.
   3. custom url + non-2xx → line contains the custom url (target is the actual URL used).
   4. invalid JSON body → line contains ` malformed-response ` and `invalid JSON`.
   5. unparseable feed (valid JSON `{}` or `42`) → Result error matches /no providers/ (or 'not an object'), line contains ` malformed-response ` and the same error text.
   6. rejecting fetch (`ECONNREFUSED`) → line contains ` connection ` and `ECONNREFUSED`.
   7. header timeout (reuse the abort-listening fetch, timeoutMs 10, this.timeout(2000)) → exactly one line containing ` timeout ` and `timed out after 10ms`.
   8. body timeout (hanging `text()`) → one line with ` timeout `.
   9. `text()` rejects without abort (`text: async () => { throw new Error('reset'); }`) → one ` connection ` line containing `reset`.
   10. missing global fetch (delete globalThis.fetch in try/finally as the existing test does, pass `{ apiLog }` only) → one ` connection ` line containing `unavailable in this runtime`.
   11. secret redaction smoke: a rejecting fetch throwing `new Error('Authorization: Bearer sk-abcdefghijklmnopqrstuvwx')` → the line does not contain `sk-abcdefghijklmnopqrstuvwx` and contains `[REDACTED]`.
   12. a throwing sink (`createApiLog(() => { throw new Error('boom'); })`) on a 503 still resolves to the same err (never rejects).
   Existing tests stay untouched (they pass no apiLog → noopApiLog).

   Files: `test/modelsDev.test.ts`

4. Verify

   Run `npm run compile`, `npm run lint` and `npm test`. The existing host-free test in test/modelsDev.test.ts must still pass (the new import is './apiLog', not vscode).

   Files: (none)

## Risks

- The `fail` helper must be declared before the missing-fetch early return, otherwise that path cannot log.
- Error message strings must stay byte-identical: they become the models.dev snapshot staleReason and existing tests match on them.
- Reading the body on non-2xx for an excerpt would add an await and change behaviour; the plan deliberately does not read it.
- If tsconfig enables exactOptionalPropertyTypes, passing `status: undefined` would fail to compile — use the conditional spread.
- Timeout tests rely on real timers (10ms); keep this.timeout(2000) and ensure clearTimeout still runs in finally so no timer leaks.
- Later todos (discovery service refreshFeed) must not re-log a Result error that fetchModelsDev already logged; this todo only adds the fetchModelsDev-side logging.

## Acceptance

- FetchModelsDevOptions has an optional `apiLog?: ApiLog`; omitting it behaves exactly as before (noopApiLog).
- Each failure path (unavailable fetch, request failure, header timeout, body timeout, body read failure, non-2xx, invalid JSON, unparseable feed) writes exactly one entry with surface 'models.dev', operation 'model list', target the feed URL used, and the kinds connection/connection/timeout/timeout/connection/http-status(+status)/malformed-response/malformed-response respectively.
- A successful fetch writes zero entries.
- All Result error strings are unchanged and fetchModelsDev never throws or rejects, even with a throwing sink.
- src/orchestrator/modelsDev.ts still has no vscode import.
- New tests in test/modelsDev.test.ts cover every path above; `npm run compile`, `npm run lint` and `npm test` are green.
