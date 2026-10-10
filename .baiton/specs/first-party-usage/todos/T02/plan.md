# Plan T02

## Steps

1. Define the reader seam, clock/timer seams and options in src/usage/usageService.ts

   Create src/usage/usageService.ts. It must import ONLY from './model' (no 'vscode', no Node built-ins such as fs/child_process/timers; global setTimeout/clearTimeout/setInterval/clearInterval and AbortController are fine because they are ES/Node globals typed by lib + @types/node). Header doc comment in the style of model.ts: 'Host-free UsageService for the Usage view (baiton.usageView) — spec first-party-usage, todo T02. Coalesces per-tool reads, timeboxes them, keeps the last good reading as stale, never throws.'

   Export these types/constants:

   ```ts
   export interface UsageReadContext {
     /** Aborted when the read overruns its budget or the service is disposed. */
     readonly signal: AbortSignal;
     /** False in Restricted Mode: a reader must not read any stored credential. */
     readonly trusted: boolean;
     /** The injected clock (epoch ms). */
     readonly now: () => number;
     /** The per-read budget the service enforces; readers may pass it on to their own seams. */
     readonly timeoutMs: number;
   }
   /** One tool's reader. May resolve any UsageReading or reject; the service never lets either escape. */
   export type UsageReader = (ctx: UsageReadContext) => Promise<UsageReading>;

   export type UsageTimerHandle = unknown;
   export interface UsageTimer {
     setTimeout(fn: () => void, ms: number): UsageTimerHandle;
     clearTimeout(handle: UsageTimerHandle): void;
     setInterval(fn: () => void, ms: number): UsageTimerHandle;
     clearInterval(handle: UsageTimerHandle): void;
   }

   export const DEFAULT_USAGE_READ_TIMEOUT_MS = 15_000;
   export const DEFAULT_USAGE_REFRESH_INTERVAL_SECONDS = 300;
   export const MIN_USAGE_REFRESH_INTERVAL_SECONDS = 30;
   export const MAX_USAGE_REFRESH_INTERVAL_SECONDS = 86_400;

   export interface UsageServiceOptions {
     /** One reader per tool; a missing entry reports unavailable. */
     readonly readers: Partial<Record<UsageToolId, UsageReader>>;
     readonly now?: () => number;            // default Date.now
     readonly timer?: UsageTimer;            // default realUsageTimer
     readonly timeoutMs?: number;            // default DEFAULT_USAGE_READ_TIMEOUT_MS; non-finite/<=0 -> default
     readonly isTrusted?: () => boolean;     // default () => false (fail closed: no credential reads unless the host says trusted)
     readonly log?: (message: string) => void; // diagnostics; every message passes through redactSecrets
   }
   export type UsageSnapshotListener = (readings: readonly UsageReading[]) => void;
   export interface UsageDisposable { dispose(): void }
   ```

   Export `realUsageTimer: UsageTimer` wrapping the global timers; after creating a timeout/interval call `(handle as { unref?: () => void }).unref?.()` (same idiom as src/activation/modelDiscovery.ts withTimeout) so nothing keeps mocha/Node alive.

   Export `normaliseRefreshIntervalSeconds(value: unknown): number`: non-number/non-finite -> DEFAULT_USAGE_REFRESH_INTERVAL_SECONDS; otherwise Math.round and clamp to [MIN, MAX]. Never throws.

   Files: `src/usage/usageService.ts`

2. Add credential redaction helper used on every string the service stores or logs

   In src/usage/usageService.ts export `redactSecrets(text: string): string` (total; non-string input -> ''). Apply in order, replacing with the literal '[redacted]':
   1. `/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]+/gi` -> '$1 [redacted]'
   2. JWT-like: `/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g`
   3. Key prefixes: `/\b(sk-ant-|sk-|ya29\.|ghp_|gho_|xox[abp]-)[A-Za-z0-9._-]{6,}/g`
   4. key=value / JSON pairs: `/(["']?(?:access_token|refresh_token|id_token|api[_-]?key|token|authorization|password|secret|client_secret|cookie)["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi` -> '$1[redacted]'
   5. Any remaining unbroken run of >= 32 chars of [A-Za-z0-9_\-+/=] (`/[A-Za-z0-9_\-+\/=]{32,}/g`).
   Keep the function pure and documented ('a token lives in memory for one read; it never reaches a reading, a log line or the webview').

   Also a private `describeError(error: unknown): string` -> error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown error', then the caller redacts + normaliseReason.

   Private `sanitiseReading(r: UsageReading): UsageReading` returns a copy whose `reason` (unavailable/stale) is `normaliseReason(redactSecrets(reason))`, whose `source.detail` (ok/stale) is `redactSecrets(detail)`, whose `tier` is redacted, and whose window labels/scope.model/scope.plan/raw.unit strings are redacted. It also rebuilds the object field-by-field (only known model fields) so an extra property a reader smuggled in (e.g. `token`) is dropped: for ok use `okReading(tool, {mechanism, detail, provenance, readAt}, windows.map(pickWindowFields), tier)`; for unavailable use `unavailableReading(tool, reason, checkedAt, mechanism)`.

   Files: `src/usage/usageService.ts`

3. Implement the UsageService class: coalescing, timeboxing, stale fallback, never throwing

   ```ts
   export class UsageService implements UsageDisposable {
     private readonly readings = new Map<UsageToolId, UsageReading>();
     private readonly inFlight = new Map<UsageToolId, Promise<UsageReading>>();
     private readonly controllers = new Set<AbortController>();
     private readonly listeners = new Set<UsageSnapshotListener>();
     private pollHandle: UsageTimerHandle | undefined;
     private disposed = false;
     constructor(private readonly options: UsageServiceOptions) {}  // MUST NOT read, spawn or start any timer
     get(tool: UsageToolId): UsageReading | undefined
     snapshot(): readonly UsageReading[]          // sortReadings([...readings.values()]); tools never read are absent
     onDidChange(listener): UsageDisposable        // listener errors caught + logged, never propagate
     refreshTool(tool: UsageToolId): Promise<UsageReading>
     refresh(tools: readonly UsageToolId[] = USAGE_TOOL_IDS): Promise<readonly UsageReading[]>
     startPolling(intervalSeconds: unknown): void
     stopPolling(): void
     get isPolling(): boolean
     dispose(): void
   }
   ```

   refreshTool(tool):
   - if disposed: resolve current `get(tool)` or `unavailableReading(tool, 'The usage view is closed.', now())` without calling any reader.
   - if `inFlight.has(tool)` return that same promise (coalescing: overlapping triggers share one read; the reader is called once).
   - else `const p = this.runRead(tool).finally(() => this.inFlight.delete(tool))` — but make sure delete only removes p itself (`if (this.inFlight.get(tool) === p)`); set inFlight before awaiting; return p. The returned promise never rejects.

   private async runRead(tool): Promise<UsageReading>:
   - `const now = this.now(); const reader = options.readers[tool];` if no reader -> settle failure with reason `No usage reader is configured for ${USAGE_TOOL_LABELS[tool]}.`
   - `const controller = new AbortController(); controllers.add(controller);`
   - trusted: call options.isTrusted in try/catch; a throw counts as false.
   - Start the reader via `Promise.resolve().then(() => reader(ctx))` so a synchronous throw becomes a rejection; map to an outcome union `{kind:'value', reading} | {kind:'error', message} | {kind:'timeout'}` with `.then(v=>..., e=>...)` so it never rejects.
   - Race it against a timeout promise built with `timer.setTimeout(() => resolve({kind:'timeout'}), timeoutMs)`; in `finally` call `timer.clearTimeout(handle)` and `controllers.delete(controller)`. On timeout call `controller.abort()`; the reader's late resolution is ignored (the race already settled, and a fresh read can start).
   - Outcome handling (`settledAt = this.now()` after the race):
     * value: validate shape — object, `isUsageToolId(r.tool) && r.tool === tool`, `USAGE_STATUSES.includes(r.status)`; otherwise failure 'The usage reader returned an invalid reading.'. If status 'ok' -> store `sanitiseReading(r)` (okReading may downgrade a zero-window ok to unavailable; then route that through the failure path so a last good reading becomes stale). If status 'unavailable' -> failure with r.reason and r.mechanism. If status 'stale' (readers should not produce it) -> failure with r.reason.
     * error: failure with `describeError(e)`.
     * timeout: failure with `Usage read timed out after ${Math.round(timeoutMs/1000)}s.` (sub-second -> `${timeoutMs}ms`).
   - failure(reason, mechanism?): `const safe = normaliseReason(redactSecrets(reason))`; `const last = lastGood(this.readings.get(tool))`; store `last ? staleReading(last, safe, settledAt) : unavailableReading(tool, safe, settledAt, mechanism)`. A stale of a stale keeps the ORIGINAL source.readAt (staleReading already does this), so age keeps growing.
   - After storing: if `!this.disposed` call `this.emit()`; return the stored reading. If disposed during the read, do NOT store or emit; return the computed reading.
   - Wrap the entire body in try/catch; any unexpected internal error becomes an unavailable reading (never throws). Log via `this.log(...)` which redacts.

   refresh(tools): filter with isUsageToolId and dedupe, `await Promise.all(tools.map(t => this.refreshTool(t)))`, return `this.snapshot()`. Never rejects.

   startPolling(intervalSeconds): if disposed return; `stopPolling()`; `const ms = normaliseRefreshIntervalSeconds(intervalSeconds) * 1000`; `pollHandle = timer.setInterval(() => { void this.refresh(); }, ms)`. It does NOT read immediately (the host calls refresh() on becoming visible). Calling it again replaces the previous interval (one timer at most).
   stopPolling(): if handle, `timer.clearInterval(handle)`, clear field.
   dispose(): idempotent; disposed = true; stopPolling(); abort every controller in `controllers`; listeners.clear(). In-flight promises still resolve (their race sees the abort through the reader or the timeout) and never reject.

   emit(): `const snap = this.snapshot();` for each listener try { listener(snap) } catch (e) { this.log(...) }.

   Files: `src/usage/usageService.ts`

4. Re-export from the usage barrel

   Append `export * from './usageService';` to src/usage/index.ts and update its doc comment to 'Host-free usage core — see model.ts and usageService.ts.' Do not touch model.ts (if a helper seems missing, keep it private in usageService.ts).

   Files: `src/usage/index.ts`

5. Unit tests in test/usage.service.test.ts

   New mocha file mirroring test/usage.model.test.ts style (`import * as assert from 'assert'`, describe/it, imports from '../src/usage/usageService' and '../src/usage/model'). Build helpers in the test:
   - `FakeTimer implements UsageTimer`: stores timeouts/intervals in Maps keyed by incrementing ids; `fireTimeouts()` runs and removes all pending timeouts; `fireIntervals()` runs every interval callback; counters `setIntervalCalls`, `setTimeoutCalls`; `pendingIntervals()`.
   - `deferred<T>()` returning {promise, resolve, reject}.
   - a mutable clock `let t = 1000; const now = () => t;`.
   - `okFor(tool, readAt)` building a reading with okReading and one window (usedPercent 40).
   - `flush()` = `await new Promise(r => setImmediate(r))` a couple of times to let microtasks settle.

   Cases (each its own `it`):
   1. never-before-expand: constructing a service with counting readers + FakeTimer calls no reader, no setTimeout, no setInterval; snapshot() is []. Even after startPolling no reader is called until an interval fires.
   2. ok path: refresh() calls each reader once, returns 4 readings in USAGE_TOOL_IDS order, statuses ok; ctx.timeoutMs equals the option, ctx.now === injected clock.
   3. missing reader -> unavailable with reason mentioning the tool label, non-empty.
   4. unavailable from reader with no prior good -> unavailable keeping reader's reason and mechanism.
   5. stale: first read ok at t=1000, advance t to 61000, second read rejects with Error('boom') -> status 'stale', reason 'boom', failedAt 61000, source.readAt 1000, readingAgeMs(r, 61000) === 60000, windows preserved. Third failure keeps source.readAt 1000. A reader returning 'unavailable' after a good read also yields stale.
   6. coalescing: reader returns a deferred; call refreshTool('codex') twice and refresh() once before resolving -> reader called exactly once, all promises resolve to the same reading; after settling a new refreshTool calls the reader again.
   7. timeout: reader never resolves; refreshTool pending; `timer.fireTimeouts()`; result is unavailable with reason matching /timed out/; the ctx.signal passed to the reader is aborted; with a prior good reading it is stale instead. A late resolve of the hung reader afterwards does not change get(tool).
   8. never throws: reader that throws synchronously, rejects with a non-Error (e.g. 42 / undefined), returns null, returns a reading for the wrong tool, or returns {status:'ok', windows:[]} -> refresh() resolves, each such tool is unavailable with a non-empty reason. A listener that throws does not break refresh.
   9. restricted mode: with isTrusted: () => false the reader sees ctx.trusted === false; with () => true it sees true; with isTrusted throwing it sees false; default (option omitted) is false.
   10. credential redaction: reader rejects with Error('401 for Bearer abc.def-123 token=sk-ant-SECRETSECRET123 eyJhbGciOi.eyJzdWIi.sig'); reader returns ok reading with an extra `token: 'sk-SECRET...'` property and source.detail containing 'access_token=xyz123'; and a reader whose unavailable reason contains 'refresh_token: "r3fr3sh"'. Assert `JSON.stringify(service.snapshot())` contains none of the secret substrings, contains '[redacted]' where relevant, has no key named token; also log messages captured via options.log contain no secrets. Direct unit asserts on redactSecrets for each pattern and that ordinary text ('5-hour window resets at 12:00') is unchanged.
   11. polling: startPolling(60) calls setInterval once with 60000; startPolling again clears the old interval (pendingIntervals() === 1); fireIntervals() triggers a refresh (readers called); stopPolling clears it; normaliseRefreshIntervalSeconds: undefined/NaN/'x' -> 300, 1 -> 30, 1e9 -> 86400, 90.4 -> 90.
   12. dispose: dispose() clears the interval, aborts in-flight signals, later refresh() calls no reader, listeners are not called after dispose, dispose twice is safe, an in-flight read settling after dispose resolves (does not reject) and does not emit.
   13. onDidChange: listener receives the ordered snapshot after each settled read; the returned disposable unsubscribes.
   14. host-free guard: read src/usage/usageService.ts with fs and assert it has no `from 'vscode'`/`require('vscode')` and no import of 'fs', 'child_process', 'http', 'https' or 'path' (same approach usage.model.test.ts uses if it has one; otherwise a simple regex over import lines).

   Files: `test/usage.service.test.ts`

6. Verify

   Run `npm run compile`, `npm run lint` (no new warnings in src/usage or the new test) and `npm test` (or at least `npx mocha test/usage.service.test.ts test/usage.model.test.ts` first, then the full suite). Ensure no pending real timers: every test uses FakeTimer, and realUsageTimer unrefs its handles.

   Files: (none)

## Risks

- The todo text in the brief is truncated after 'Behaviour:'; behaviour here is inferred from the OVERVIEW (coalesce per tool, timebox, last good becomes stale with age and reason, never throw, no work before first expand, interval disposed with the view, restricted mode, credential redaction). If the full todo lists extra items, the executor should follow them.
- Default isTrusted is fail-closed (false). The T-later host wiring must pass vscode.workspace.isTrusted explicitly or credential fallbacks will silently never run.
- redactSecrets' 32+ char catch-all could redact legitimate long identifiers (e.g. long model names or paths) in reasons/details; tests should confirm ordinary short text is untouched, and readers should keep detail strings short.
- Timeout handling cannot cancel a reader that ignores ctx.signal; the late result is discarded but the underlying work (e.g. a spawned process) may linger. Readers (later todos) must honour ctx.signal.
- A re-read can start while a timed-out read is still running in the background because inFlight is cleared on timeout; this is intended (no hang) but means two underlying operations may briefly overlap for one tool.
- sanitiseReading rebuilds readings via okReading, which turns an ok reading with zero windows into unavailable — handled by routing that case through the failure path so a prior good reading becomes stale rather than being replaced.
- Mocha may hang if any test uses realUsageTimer without unref or leaves intervals running; tests must use FakeTimer and dispose services.

## Acceptance

- src/usage/usageService.ts exists, exports UsageService, UsageReader, UsageReadContext, UsageTimer, UsageServiceOptions, realUsageTimer, redactSecrets, normaliseRefreshIntervalSeconds and the DEFAULT_/MIN_/MAX_ constants, and imports nothing from 'vscode' or Node built-in modules.
- src/usage/index.ts re-exports usageService.
- Constructing a UsageService performs no reads and creates no timers; startPolling does not read until the interval fires.
- Overlapping refresh/refreshTool calls for a tool invoke its reader exactly once and share the result.
- A read that exceeds timeoutMs settles (stale if a last good reading exists, otherwise unavailable) with a 'timed out' reason and aborts ctx.signal; late results are ignored.
- After a good read, a failed read yields status 'stale' with the original source.readAt, the failure reason and failedAt; readingAgeMs reports the age.
- No public method ever throws or rejects, including for throwing/rejecting/malformed readers and throwing listeners.
- ctx.trusted reflects isTrusted() (false by default and when isTrusted throws).
- Secrets in reader errors, reasons, details or smuggled extra properties never appear in snapshot(), listener payloads or log output.
- dispose() clears the interval, aborts in-flight reads, stops emissions and makes later refreshes no-ops.
- test/usage.service.test.ts covers the ok, unavailable, stale, coalescing, timeout, never-before-expand, restricted-mode, credential-redaction, polling and dispose paths.
- npm run compile, npm run lint and npm test pass.
