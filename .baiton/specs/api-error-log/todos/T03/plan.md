# Plan T03

## Steps

1. Import the log unit and extend ModelClientConfig

   In src/orchestrator/modelClient.ts add, next to the existing `import type { DialectId } from './providers';`:
     `import { noopApiLog } from './apiLog';`
     `import type { ApiLog, ApiFailureEntry } from './apiLog';`
   (apiLog.ts has no imports, so there is no cycle; do NOT import from './index').
   Add two optional fields at the end of `interface ModelClientConfig` (after `connectTimeoutMs`), with doc comments in the existing style:
     `/** Receives one entry per failed completion call; defaults to {@link noopApiLog}. Successful calls never touch it. */ apiLog?: ApiLog;`
     `/** The `surface` recorded on API-log entries (the provider id); defaults to 'openai'. */ surfaceId?: string;`
   Add a module constant near DEFAULT_CONNECT_TIMEOUT_MS: `const DEFAULT_SURFACE_ID = 'openai';`. Every existing caller/test still compiles because both fields are optional.

   Files: `src/orchestrator/modelClient.ts`

2. Add a private logFailure helper on OpenAiModelClient

   Add to OpenAiModelClient:
   ```ts
   /** The per-call part of an API-log entry; surface/operation/target are filled in by {@link logFailure}. */
   type CallFailure = Pick<ApiFailureEntry, 'kind' | 'message' | 'status' | 'bodyExcerpt'>;  // declare this as a module-level type alias above the class

   /** Records one failed completion call. Never throws, so the caller's thrown error is unchanged. */
   private logFailure(url: URL, failure: CallFailure): void {
     try {
       (this.config.apiLog ?? noopApiLog).failure({
         surface: this.config.surfaceId ?? DEFAULT_SURFACE_ID,
         operation: 'completion',
         target: url.toString(),
         ...failure,
       });
     } catch {
       /* logging must never change the call's outcome */
     }
   }
   ```
   Redaction and body bounding are done inside `failure()` (apiLog.ts), so pass raw text; do not call redactSecrets/excerpt here.

   Files: `src/orchestrator/modelClient.ts`

3. Route every postCompletion rejection through the log, exactly once

   In `postCompletion`, change `finishReject` to `const finishReject = (err: Error, failure: CallFailure): void => { if (settled) return; settled = true; cleanup(); this.logFailure(url, failure); request.destroy(); reject(err); };` — logging sits after the `settled` guard so the late `request` 'error' that `request.destroy()` triggers (and any second res/req event) can never produce a second entry. (postCompletion is an arrow-function closure inside a method, so `this` is the client.) Update each call site; keep every thrown Error object and message byte-for-byte identical:
   1. onAbort: `finishReject(new UnreachableEndpointError('request was aborted'), { kind: 'abort', message: 'request was aborted' })`. This covers both the listener and the `if (signal.aborted) { onAbort(); return; }` branch.
   2. Non-2xx in res 'end': keep the error `endpoint returned HTTP ${status}: ${text.slice(0, 500)}`; failure `{ kind: 'http-status', status, message: `endpoint returned HTTP ${status}`, bodyExcerpt: text }` (the body goes only in bodyExcerpt, not duplicated in message).
   3. res 'error': keep `new UnreachableEndpointError('response stream failed', { cause: err })`; failure `{ kind: 'connection', message: `response stream failed: ${err.message}` }`.
   4. request.setTimeout: keep the error; failure `{ kind: 'timeout', message: `connection did not complete within ${connectTimeoutMs}ms` }`.
   5. request 'error': keep `new UnreachableEndpointError('connection failed', { cause: err })`; failure `{ kind: 'connection', message: `connection failed: ${err.message}` }` (err.message carries e.g. `connect ECONNREFUSED 127.0.0.1:1234`).
   No change to headers, body, timeout or streaming semantics. Update the postCompletion doc comment with one sentence: each rejection records exactly one API-log entry.

   Files: `src/orchestrator/modelClient.ts`

4. Log a non-JSON non-streaming body as malformed-response

   Change `private parseNonStreaming(raw: string)` to `private parseNonStreaming(raw: string, url: URL)` and the call in `complete()` to `this.parseNonStreaming(raw, url)`. In its catch block, before the existing `throw new UnreachableEndpointError('endpoint returned a non-JSON response', { cause: err });`, add `this.logFailure(url, { kind: 'malformed-response', message: 'endpoint returned a non-JSON response', bodyExcerpt: raw });`. The streaming SSE parser's skipping of malformed frames is NOT a call failure and is not logged.
   Deliberately NOT logged (no request was issued): the three `MissingConfigError` throws and the pre-start `if (req.signal.aborted) throw new UnreachableEndpointError('request was aborted before it started')` in complete(). Add a short comment on that pre-start check saying it is not logged because no call was made. Also add a sentence to the class doc comment: failures are reported to `config.apiLog`; missing configuration is not a call failure.

   Files: `src/orchestrator/modelClient.ts`

5. Add an 'API failure log' describe block to test/modelClient.test.ts

   Import `createApiLog` and `type ApiLog` from '../src/orchestrator/apiLog'. Add a helper at module level:
   ```ts
   const TS = '2026-01-01T00:00:00.000Z';
   function recordingLog(): { lines: string[]; apiLog: ApiLog } { const lines: string[] = []; return { lines, apiLog: createApiLog((l) => lines.push(l), () => TS) }; }
   /** Let late socket events (e.g. the error after request.destroy()) fire before counting entries. */
   const settle = () => new Promise<void>((r) => setTimeout(r, 20));
   ```
   Add `describe('API failure log', ...)` inside the top-level `describe('OpenAiModelClient')`, reusing startMockServer/makeConfig/liveSignal/SAMPLE_*. Each failure test: build config with `makeConfig(url, { apiLog, ...})`, assert.rejects with the SAME error class/message as today, `await settle()`, then `assert.strictEqual(lines.length, 1)` and match the line. Always close servers in finally/afterEach. Tests:
   1. non-streaming success (200 valid completion JSON, as in the first existing test) → lines.length === 0.
   2. streaming success (isStreaming: () => true, SSE body with `data: {...}\n\ndata: [DONE]\n\n`, content-type text/event-stream) → 0 lines.
   3. HTTP 500 with body 'boom\nline2' → err.message === 'Orchestrator endpoint was unreachable: endpoint returned HTTP 500: boom\nline2' (unchanged); one line matching /^\[2026-01-01T00:00:00\.000Z\] openai completion http-status HTTP 500 http:\/\/127\.0\.0\.1:\d+\/v1\/chat\/completions — endpoint returned HTTP 500 \| body: boom line2$/.
   4. surfaceId: same 500 with `surfaceId: 'deepseek'` → line contains '] deepseek completion http-status'.
   5. redaction: 401 whose body echoes `Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz` → line does not include 'sk-abcdefghijklmnopqrstuvwxyz' and does include '[REDACTED]'.
   6. refused connection (reserve-then-close port as in the existing test) → one line with ' completion connection ' and 'connection failed'.
   7. connect timeout (silent server, connectTimeoutMs: 50) → one line with ' completion timeout ' and 'within 50ms' (the settle() guards against a second entry from the destroy-triggered error).
   8. abort mid-request: silent server, AbortController, `setTimeout(() => ac.abort(), 20)`, large connectTimeoutMs (e.g. 5000) → rejects with UnreachableEndpointError /request was aborted/; one line with ' completion abort '.
   9. non-JSON 200 body 'not json' (non-streaming) → rejects /non-JSON response/; one line with ' completion malformed-response ' and '| body: not json'.
   10. response stream failure: server `res.writeHead(200, { 'content-type': 'text/event-stream', 'content-length': '1000' }); res.write('data: {'); setTimeout(() => res.socket?.destroy(), 10);` with isStreaming: () => true → rejects UnreachableEndpointError; exactly one line with kind ' completion connection ' (accept either 'response stream failed' or 'connection failed' in the message — which event Node emits for a truncated response varies by version).
   11. not logged: MissingConfigError for missing endpoint (makeConfig(undefined, { apiLog })) → 0 lines; an already-aborted signal (AbortController aborted before complete()) → rejects /aborted before it started/ and 0 lines.
   12. default noop: a failing call (HTTP 500) with no apiLog configured still rejects with the same UnreachableEndpointError (no throw from logging).
   Optionally 13: an apiLog whose failure() throws → the call still rejects with the original UnreachableEndpointError.

   Files: `test/modelClient.test.ts`

6. Verify

   Run `npm run compile`, `npm run lint`, `npm test`. All existing modelClient tests must pass unchanged (no edits to existing assertions). Grep that src/orchestrator/modelClient.ts still has no `vscode` import.

   Files: (none)

## Risks

- Double logging: request.destroy() inside finishReject emits a later 'error' on the request, and timeout/abort can race with res events. Logging must sit after the `settled` guard in finishReject; tests await a short settle delay before counting entries to catch regressions.
- Test 10 (truncated response) depends on Node's IncomingMessage behaviour on premature socket close: newer Node emits res 'error' ('aborted'/ECONNRESET), older may emit only 'aborted' and hang. If the test hangs or is non-deterministic on this Node version, give it a short connectTimeoutMs so the timeout path still rejects, or relax to asserting exactly one entry of any kind; do not change production semantics to make it pass.
- The abort test uses a timer-driven abort against a silent server; keep connectTimeoutMs well above the abort delay so the entry is 'abort' not 'timeout'.
- Thrown errors must stay byte-for-byte identical (existing tests and callers match on messages such as 'within 50ms' and 'HTTP 500'); only the log entry uses the shorter message without the body.
- A custom ApiLog could throw; logFailure wraps the call in try/catch so the original rejection is preserved.
- Import apiLog from './apiLog' directly, not the './index' barrel, to avoid a circular import through the barrel.

## Acceptance

- ModelClientConfig has optional `apiLog?: ApiLog` and `surfaceId?: string`; omitting both compiles and behaves exactly as before (noopApiLog, surface 'openai').
- Every rejection from postCompletion (abort, non-2xx, response stream error, connect timeout, connection error) and the non-JSON non-streaming body produce exactly one ApiLog.failure call with surface = surfaceId ?? 'openai', operation 'completion', target = the completions URL, and kinds abort / http-status (with status and bodyExcerpt) / connection / timeout / connection / malformed-response respectively.
- MissingConfigError paths and the pre-start aborted-signal check produce no entry; successful streaming and non-streaming calls produce no entry.
- All thrown error classes and messages are unchanged; existing tests in test/modelClient.test.ts pass without modification.
- New tests in test/modelClient.test.ts assert one entry per induced failure (500, refused connection, timeout, abort, non-JSON, truncated stream), zero entries on success and on missing config, surfaceId propagation, and that a secret echoed in the body is redacted in the line.
- src/orchestrator/modelClient.ts imports nothing from vscode.
- `npm run compile`, `npm run lint` (no new warnings) and `npm test` are green.
