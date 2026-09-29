# Plan T07

## Steps

1. Add apiLog to DiscoveryContext

   In src/adapter/adapter.ts add `import type { ApiLog } from '../orchestrator/apiLog';` (type-only, next to the existing `../orchestrator/modelsDev` type import). Add to `interface DiscoveryContext`, after `log?`:

     /**
      * API failure log for adapters with an HTTP leg (one entry per failed call,
      * redacted by the log itself); absent means discard (use `noopApiLog`).
      */
     readonly apiLog?: ApiLog;

   No adapter code changes in this todo (OpencodeAdapter/ClaudeAdapter use it in a later todo). No `vscode` import.

   Files: `src/adapter/adapter.ts`

2. Add apiLog option to ModelDiscoveryOptions and forward it

   In src/activation/modelDiscovery.ts:
   1. Imports: `import { noopApiLog } from '../orchestrator/apiLog';` and `import type { ApiLog, ApiFailureKind } from '../orchestrator/apiLog';`.
   2. `ModelDiscoveryOptions` gains, after `log?`:
      /** API failure log: forwarded to the default models.dev fetch and every adapter's ctx; the service also logs adapter-level discovery failures. Defaults to discard. */
      apiLog?: ApiLog;
   3. Add a private getter/helper `private get apiLog(): ApiLog { return this.options.apiLog ?? noopApiLog; }`.
   4. In `refreshAgent`, the `ctx: DiscoveryContext` literal gains `...(this.options.apiLog !== undefined ? { apiLog: this.options.apiLog } : {}),` (same conditional-spread style as cwd/feed).
   5. Add a private helper that writes one entry only for a live generation (mirrors the `apply` generation guard, so a superseded/disposed run logs nothing):
      private logFailure(controller: AbortController, surface: string, kind: ApiFailureKind, message: string): void {
        if (controller.signal.aborted || this.disposed) { return; }
        this.apiLog.failure({ surface, operation: 'model list', kind, message });
      }
      (Module-level const `DISCOVERY_OPERATION = 'model list'` is fine instead of the literal.) Do not set `target` for these service-level entries.

   Files: `src/activation/modelDiscovery.ts`

3. Log adapter-level outcomes in refreshAgent

   In `refreshAgent`, where `result` is computed from `raced`, add one apiLog entry per failure branch, with surface = the agent id (`agent`), using the SAME message string that goes into `err(...)` (build the message into a local const and reuse it):
   - `raced.kind === 'timeout'` → `this.logFailure(controller, agent, 'timeout', msg)` where msg = `${agent} model discovery timed out after ${timeoutMs}ms`.
   - `raced.kind === 'error'` (rejection OR synchronous throw caught by the try/catch) → kind `'connection'`, msg = `${agent} model discovery failed: ${raced.message}`.
   - `raced.value === undefined` → kind `'malformed-response'`, msg = `${agent} model discovery returned no models`.
   - success → nothing logged.
   The store-facing `result` strings and `this.apply(...)` call are unchanged. Log BEFORE or AFTER `apply` does not matter, but keep exactly one failure() call per failed agent per live refresh. An adapter without a `discoverModels` seam returns early and logs nothing.

   Files: `src/activation/modelDiscovery.ts`

4. Log only the service's own feed failures in refreshFeed, and forward apiLog to fetchModelsDev without double-logging

   Rewrite the start of `refreshFeed`:
     let serviceTimedOut = false;
     // The default fetcher logs its own Result errors through fetchModelsDev; the
     // gate drops a late entry for a fetch the service's race already reported
     // as a timeout, so one failure never produces two lines.
     const gatedApiLog: ApiLog = {
       failure: (entry) => { if (!serviceTimedOut) { this.apiLog.failure(entry); } },
     };
     const fetchFeed: FeedFetcher =
       this.options.fetchFeed ?? ((o) => fetchModelsDev({ timeoutMs: o.timeoutMs, apiLog: gatedApiLog }));
   Then after the race:
   - `raced.kind === 'timeout'` → set `serviceTimedOut = true;` then `this.logFailure(controller, 'models.dev', 'timeout', msg)` with msg = `models.dev fetch timed out after ${timeoutMs}ms` (reuse the same string for `err(...)`).
   - `raced.kind === 'error'` (thrown/rejected fetcher) → `this.logFailure(controller, 'models.dev', 'connection', msg)` with msg = `models.dev fetch failed: ${raced.message}`.
   - `!raced.value.ok` → NO service log (fetchModelsDev already logged it when it is the default fetcher; an injected fetcher returning err is treated the same — the Result error is not re-logged). Add a short comment saying so.
   - success → nothing.
   The FeedFetcher type and the injected-fetcher call shape `{ timeoutMs, signal }` stay unchanged. Update the module/class doc comment briefly: failures go to the injected `apiLog` (adapter outcomes keyed by agent id; the feed's Result errors are logged once by fetchModelsDev, not here).

   Files: `src/activation/modelDiscovery.ts`

5. Document that CatalogStore.applyResult is not a logging point

   In src/orchestrator/modelCatalog.ts, extend the doc comment of `applyResult` (lines ~386-399) with a paragraph, no code change:

      * Deliberately NOT an API-failure logging point: the discovery service
      * (src/activation/modelDiscovery.ts) and `fetchModelsDev` are the single
      * choke point that writes `ApiLog` entries for catalog sources. Logging an
      * ERR here as well would record one failure twice, so do not add an
      * `apiLog` call to this method.

   Files: `src/orchestrator/modelCatalog.ts`

6. Wire surface.apiLog in extension.ts

   In src/extension.ts, the `new ModelDiscoveryService({...})` literal (around line 207) gains `apiLog: surface.apiLog,` right after `log: (m) => surface.log(m),`. Nothing else changes (the API channel is already pushed to subscriptions by T02).

   Files: `src/extension.ts`

7. Tests in test/modelDiscovery.test.ts

   Add `import { createApiLog, type ApiLog, type ApiFailureEntry } from '../src/orchestrator/apiLog';` (or just the types). Add a helper:
     function apiLogSpy(): { apiLog: ApiLog; entries: ApiFailureEntry[] } { const entries: ApiFailureEntry[] = []; return { apiLog: { failure: (e) => { entries.push(e); } }, entries }; }
   Add `describe('T07 ModelDiscoveryService apiLog', ...)` with:
   1. 'forwards apiLog into every adapter ctx': fake claude/codex/opencode adapters resolving caps; after refresh assert each `calls[0].apiLog === spy.apiLog`; and with no apiLog option, `calls[0].apiLog === undefined` (or `'apiLog' in ctx` false).
   2. 'a fully successful refresh writes no entry': all adapters resolve caps, feedSpy ok → `entries.length === 0`.
   3. 'adapter timeout logs one timeout entry': hanging codex, timeoutMs 20 (this.timeout(2000)) → exactly one entry `{surface:'codex', operation:'model list', kind:'timeout'}`, message matches /timed out after 20ms/.
   4. 'rejecting adapter and synchronously throwing adapter each log one connection entry': codex rejects Error('app-server died'), opencode = throwingAdapter('opencode','spawn failed') → exactly two entries, one per surface, kind 'connection', messages match the error texts.
   5. 'adapter resolving undefined logs malformed-response': claude resolves undefined → one entry surface 'claude', kind 'malformed-response', message === 'claude model discovery returned no models'.
   6. 'a feed Result error is not re-logged by the service': fetchFeed: async () => err('models.dev returned HTTP 503'), adapters succeed → entries.length === 0.
   7. 'a throwing feed fetcher logs one connection entry': fetchFeed: async () => { throw new Error('boom'); } → one entry surface 'models.dev', kind 'connection', message matches /boom/.
   8. 'a hanging feed fetcher logs one timeout entry': fetchFeed returns a never-settling deferred, timeoutMs 20, registry {} → one entry surface 'models.dev', kind 'timeout'.
   9. 'a superseded refresh logs nothing for its aborted work': codex adapter returning deferreds (as in the existing supersede test) that later resolve undefined for the first call and caps for the second; call refresh twice, resolve both, await both → entries.length === 0.
   10. 'default fetcher forwards apiLog to fetchModelsDev' is optional; if added, avoid real network: do NOT rely on global fetch. Prefer skipping it (fetchModelsDev apiLog behaviour is already covered in test/modelsDev.test.ts by T06).
   Also add a small check (e.g., in the host-free describe or a new it) that modelCatalog.ts source contains no `apiLog` call inside the store: `assert.ok(!/apiLog\./.test(fs.readFileSync(<modelCatalog.ts>)))` — optional but cheap. Use `service.dispose()` at the end of every test.

   Files: `test/modelDiscovery.test.ts`

8. Verify

   Run `npm run compile`, `npm run lint`, `npm test`. All must be green (lint may show only the pre-existing webviewProtocol.ts warning).

   Files: (none)

## Risks

- Double-logging the feed timeout: the default fetchModelsDev uses the same timeoutMs as the service race, so both could report the same timeout. The `serviceTimedOut` gate on the apiLog passed to the default fetcher prevents a second line; keep the gate or tests may see flaky duplicates in production-like runs.
- Adapters with an HTTP leg (opencode, claude feed fallback) will later log their own failures via ctx.apiLog AND the service will log the adapter-level outcome (e.g. resolved undefined). This is the accepted design in the overview (different surfaces/levels); do not try to dedupe it here.
- Superseded/disposed refreshes must not log: logFailure must check `controller.signal.aborted || this.disposed` exactly as `apply` does, otherwise the supersede test path emits spurious entries.
- The ctx.apiLog spread must be conditional so existing tests that deepStrictEqual or inspect ctx shape are unaffected when no apiLog is injected.
- Timeout tests use real timers (20ms); set `this.timeout(2_000)` with `function ()` syntax as the existing hanging-adapter test does.
- No `vscode` import may enter modelDiscovery.ts, adapter.ts or modelCatalog.ts; the existing host-free test guards modelDiscovery.ts.

## Acceptance

- DiscoveryContext has `readonly apiLog?: ApiLog` and ModelDiscoveryOptions has `apiLog?: ApiLog`.
- Every adapter's discoverModels receives ctx.apiLog identical to the injected ApiLog; absent when none injected.
- The default feed fetcher calls fetchModelsDev with an apiLog derived from the injected one.
- refreshAgent writes exactly one entry per failed agent: timeout → 'timeout', reject/throw → 'connection', resolved undefined → 'malformed-response' with message '<agent> model discovery returned no models'; surface = agent id, operation 'model list'.
- refreshFeed logs only its own race timeout ('timeout') and a thrown/rejected fetcher ('connection') with surface 'models.dev'; a Result err from the fetcher produces zero service entries.
- A fully successful refresh and a superseded/disposed run write no entries.
- CatalogStore.applyResult doc comment states it is deliberately not a logging point; no apiLog call in modelCatalog.ts.
- src/extension.ts passes `apiLog: surface.apiLog` to ModelDiscoveryService.
- Store-facing staleReason strings and all existing modelDiscovery tests are unchanged and pass.
- `npm run compile`, `npm run lint` and `npm test` are green.
