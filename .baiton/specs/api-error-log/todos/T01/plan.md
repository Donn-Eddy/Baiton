# Plan T01

## Steps

1. Create src/orchestrator/apiLog.ts: types and constants

   New file, NO `vscode` import and no imports at all (pure, host-free). Start with a module doc comment in the style of src/orchestrator/sanitizer.ts explaining: one entry per FAILED outbound API call, successful calls never touch it, redaction is applied inside `failure()` so a call site cannot forget it, and the sink is injectable exactly like the catalog `log?: (message: string) => void` callback in modelCatalog.ts. Export:
   - `export type ApiFailureKind = 'http-status' | 'timeout' | 'connection' | 'abort' | 'malformed-response' | 'refused';`
   - `export const API_FAILURE_KINDS: readonly ApiFailureKind[] = ['http-status','timeout','connection','abort','malformed-response','refused'];` (handy for tests; optional but recommended).
   - `export interface ApiFailureEntry { readonly surface: string; readonly operation: string; readonly target?: string; readonly kind: ApiFailureKind; readonly status?: number; readonly message: string; readonly bodyExcerpt?: string; }` with JSDoc per field: surface = provider id, 'copilot', a CatalogSourceId or an agent id; operation = short verb noun e.g. 'completion', 'model list'; target = URL or model id when known; status = HTTP status for 'http-status'; bodyExcerpt = raw response body (bounded + redacted by failure()).
   - `export type ApiLogSink = (line: string) => void;`
   - `export interface ApiLog { failure(entry: ApiFailureEntry): void; }`
   - `export const BODY_EXCERPT_MAX = 500;`
   - `export const REDACTED = '[REDACTED]';`

   Files: `src/orchestrator/apiLog.ts`

2. Implement redactSecrets(text) — the single shared redaction helper

   `export function redactSecrets(text: string): string` applying these global regex replacements in this order (all use REDACTED as the placeholder; the result must be idempotent: redactSecrets(redactSecrets(x)) === redactSecrets(x)):
   1. Authorization header/field, any casing, header or JSON or query form: `/\b(authorization)("?\s*[:=]\s*"?)([^\r\n"',;}]+)/gi` -> `$1$2[REDACTED]`. This consumes the whole value including a `Bearer x` / `Basic x` scheme, up to end-of-line / quote / comma / semicolon / brace. Do NOT match bare words like 'authorization failed' (requires `:` or `=`).
   2. Bearer tokens anywhere: `/\bBearer\s+[^\s"',;]+/gi` -> `Bearer [REDACTED]`. Guard idempotence: since `[` is allowed by that class, use a negative lookahead `/\bBearer\s+(?!\[REDACTED\])[^\s"',;]+/gi` so an already-redacted value is left alone.
   3. API-key headers/params incl. x-api-key, api-key, api_key, apikey (any casing): `/\b((?:x-)?api[-_]?key)("?\s*[:=]\s*"?)(?!\[REDACTED\])([^\s"'&,;}]+)/gi` -> `$1$2[REDACTED]`.
   4. Long opaque tokens: `/\b(?:sk|key)-[A-Za-z0-9_-]{16,}/g` -> `[REDACTED]` (catches sk-..., sk-proj-..., key-... shapes; 16+ chars after the prefix so short words like 'key-value' survive).
   Return the transformed string; empty string in -> empty string out. Add a JSDoc listing what is scrubbed and noting over-redaction is preferred to leaking.

   Files: `src/orchestrator/apiLog.ts`

3. Implement excerpt(body) and one-line message collapsing

   `export function excerpt(body: string): string`: collapse every run of whitespace containing a CR/LF into a single space (`body.replace(/\s*[\r\n]+\s*/g, ' ')`), `.trim()`, and if the result's length exceeds BODY_EXCERPT_MAX return `collapsed.slice(0, BODY_EXCERPT_MAX - 1) + '…'` so the returned length NEVER exceeds BODY_EXCERPT_MAX; otherwise return it unchanged. Add a private (non-exported) `oneLine(text: string): string` that performs the same newline collapse + trim without bounding, used for `message` and `target` so a formatted entry is always exactly one line.

   Files: `src/orchestrator/apiLog.ts`

4. Implement formatApiFailure, createApiLog and noopApiLog

   `export function formatApiFailure(entry: ApiFailureEntry, timestamp: string): string` (exported so tests and future callers can check the shape; it performs redaction itself so it is safe on its own):
   - message = oneLine(redactSecrets(entry.message))
   - target = entry.target !== undefined && entry.target !== '' ? oneLine(redactSecrets(entry.target)) : undefined
   - body = entry.bodyExcerpt !== undefined && entry.bodyExcerpt.trim() !== '' ? excerpt(redactSecrets(entry.bodyExcerpt)) : undefined  (REDACT FIRST, THEN BOUND, so truncation can never cut a secret below its recognisable length)
   - return `[${timestamp}] ${entry.surface} ${entry.operation} ${entry.kind}` + (entry.status !== undefined ? ` HTTP ${entry.status}` : '') + (target ? ` ${target}` : '') + ` — ${message}` + (body ? ` | body: ${body}` : '')   (the separator is an em dash U+2014 with single spaces).
   `export function createApiLog(sink: ApiLogSink, now: () => string = () => new Date().toISOString()): ApiLog` returning `{ failure(entry) { let line: string; try { line = formatApiFailure(entry, now()); } catch { return; } try { sink(line); } catch { /* logging must never break the call site */ } } }` — the sink is called exactly once per failure() call, never otherwise.
   `export const noopApiLog: ApiLog = Object.freeze({ failure: (_entry: ApiFailureEntry): void => undefined });` with a JSDoc: default when a caller injects nothing, so every `apiLog?:` option stays optional. (Use `_entry` or no param to satisfy no-unused-vars argsIgnorePattern '^_'; avoid an empty `{}` body to keep @typescript-eslint/no-empty-function quiet.)

   Files: `src/orchestrator/apiLog.ts`

5. Export from the orchestrator barrel

   In src/orchestrator/index.ts append `export * from './apiLog';` (after `export * from './webviewProtocol';`, or next to modelCatalog). Verified no existing barrel export uses the names ApiFailureKind, ApiFailureEntry, ApiLogSink, ApiLog, createApiLog, noopApiLog, redactSecrets, excerpt, BODY_EXCERPT_MAX, REDACTED, API_FAILURE_KINDS or formatApiFailure, so `export *` introduces no ambiguity. If `REDACTED` or `excerpt` are judged too generic, keep them exported anyway (the overview requires `excerpt` and `BODY_EXCERPT_MAX`).

   Files: `src/orchestrator/index.ts`

6. Write test/apiLog.test.ts (mocha + assert + fast-check)

   Style: `import * as assert from 'assert'; import * as fc from 'fast-check';` and import from '../src/orchestrator/apiLog' (optionally one assertion that the barrel '../src/orchestrator' re-exports createApiLog/noopApiLog/redactSecrets). Use `describe`/`it` like the other tests. Cases:
   redactSecrets:
   - 'Authorization: Bearer abc.def-123' -> contains 'Authorization: [REDACTED]' and not 'abc.def-123'; lower-case 'authorization: Basic Zm9vOmJhcg==' redacted; JSON form '{"Authorization":"Bearer tok123"}' has no 'tok123'.
   - bare 'Bearer eyJhbGciOi.x.y' anywhere in a message -> 'Bearer [REDACTED]'.
   - 'x-api-key: sekret1', 'api_key=sekret2', 'API-KEY: sekret3', 'apikey=sekret4' and URL 'https://h/v1?api_key=sekret5&x=1' -> none of sekret1..5 survive, '&x=1' survives.
   - 'sk-' + 'A'.repeat(40), 'sk-proj-abcdefghijklmnopqrstu', 'key-0123456789abcdefXYZ' -> replaced; short words 'key-value', 'sk-1' and plain text 'connection refused' unchanged.
   - 'authorization failed' (no separator) unchanged; idempotence: redactSecrets(redactSecrets(s)) === redactSecrets(s) for the samples.
   Property sweep (fc.assert, default runs or numRuns: 200): token = fc.stringOf(fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~+/'.split('')), { minLength: 8, maxLength: 64 }); scheme ∈ ['Bearer','bearer','BEARER']; header name ∈ ['Authorization','authorization','AUTHORIZATION']; separator ∈ [': ', ':', '=', '": "']; prefix/suffix ∈ fc.constantFrom('', 'request failed ', 'HTTP 401 ', ' trailing text', '\n'). Build both `${pre}${scheme} ${token}${suf}` and `${pre}${header}${sep}${scheme} ${token}${suf}`; assert (a) the output does not contain `token` when token is not a substring of pre/suf/'[REDACTED]' (use fc.pre to skip otherwise), (b) the output does not match `/bearer\s+(?!\[REDACTED\])[^\s"',;]/i`, and (c) does not match `/authorization"?\s*[:=]\s*"?(?!\[REDACTED\])[^\s"]/i`.
   excerpt:
   - short 'a\nb\r\n  c' -> 'a b c'; 'x'.repeat(10_000) -> length === BODY_EXCERPT_MAX and endsWith('…'); exactly BODY_EXCERPT_MAX chars -> unchanged; property: for any fc.string({maxLength: 2000}) result.length <= BODY_EXCERPT_MAX and contains no '\n' or '\r'.
   formatting via createApiLog with a recording sink (`const lines: string[] = []; const log = createApiLog((l) => lines.push(l), () => '2026-01-01T00:00:00.000Z');`):
   - full entry {surface:'openai', operation:'completion', kind:'http-status', status:401, target:'https://api.example.com/v1/chat/completions', message:'endpoint returned HTTP 401', bodyExcerpt:'{"error":"bad key"}'} -> exactly one line equal to '[2026-01-01T00:00:00.000Z] openai completion http-status HTTP 401 https://api.example.com/v1/chat/completions — endpoint returned HTTP 401 | body: {"error":"bad key"}'.
   - minimal entry {surface:'copilot', operation:'completion', kind:'refused', message:'no permission'} -> '[2026-01-01T00:00:00.000Z] copilot completion refused — no permission' (no HTTP, no target, no body segment).
   - multi-line message and body produce a single line (no '\n'); a 'Bearer x' / 'sk-…' in message, target (e.g. '?api_key=abc') and bodyExcerpt are all redacted in the written line; a body of 5000 chars yields a ' | body: ' segment of length <= BODY_EXCERPT_MAX.
   - each of the six kinds (API_FAILURE_KINDS) formats with the kind token present.
   - one failure() call -> sink called exactly once; zero calls -> sink never called; default `now` produces an ISO timestamp matching /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]/.
   - a throwing sink does not make failure() throw (assert.doesNotThrow).
   noopApiLog: `assert.doesNotThrow(() => noopApiLog.failure({...}))` and it returns undefined.

   Files: `test/apiLog.test.ts`

7. Verify

   Run `npm run compile`, `npm run lint` (no new warnings in the three files) and `npm test` (all suites incl. the new test/apiLog.test.ts). No other source files change in this todo; no call site is wired yet (that is later todos).

   Files: (none)

## Risks

- Regex over-/under-redaction: the authorization pattern consumes to end of line/quote/comma, which may hide harmless trailing text; this is intended (leaking is worse), but tests must not assert text after an authorization value survives on the same segment.
- Idempotence: without the `(?!\[REDACTED\])` lookaheads the Bearer/api-key patterns would re-match the placeholder; keep them so redactSecrets is idempotent and formatApiFailure can be safely re-applied.
- The `\bkey-` opaque-token rule could redact legitimate identifiers of 16+ chars that happen to start with 'key-'; acceptable for a failure log but keep the 16-char minimum so short words survive.
- Property-test flakiness: a generated token could coincidentally be a substring of the fixed prefix/suffix or of '[REDACTED]'/'Bearer'; guard with fc.pre and use the structural regex assertions as the primary check.
- Truncation order: bounding before redaction could cut a secret below its recognisable length; formatApiFailure must redact first, then call excerpt().
- ESLint (@typescript-eslint/recommended) may flag an empty function body or unused parameter in noopApiLog; use `(_entry) => undefined` as specified.
- Barrel `export *` name clashes would break compile; names were checked against current src/orchestrator exports and none collide (modelsDev.ts is not in the barrel).

## Acceptance

- src/orchestrator/apiLog.ts exists, has no `vscode` import (grep `from 'vscode'` finds nothing in it), and exports ApiFailureKind (exactly the six kinds), ApiFailureEntry, ApiLogSink, ApiLog, createApiLog(sink, now?), noopApiLog, redactSecrets, BODY_EXCERPT_MAX = 500 and excerpt.
- src/orchestrator/index.ts contains `export * from './apiLog';` and the symbols are importable from '../src/orchestrator'.
- createApiLog(...).failure(entry) writes exactly one single-line string per call in the format `[<iso ts>] <surface> <operation> <kind>[ HTTP <status>][ <target>] — <message>[ | body: <excerpt>]`, and never calls the sink otherwise.
- failure() redacts message, target and bodyExcerpt unconditionally: no Bearer token, authorization value, api-key/x-api-key value or sk-/key- opaque token survives into the written line.
- excerpt() output is newline-free and never longer than BODY_EXCERPT_MAX; body excerpts in formatted lines respect that bound.
- noopApiLog.failure() is a silent no-op that does not throw; a throwing sink does not make failure() throw.
- test/apiLog.test.ts covers redaction (including the fast-check sweep that no Bearer/authorization value survives), formatting, excerpt bounding and noop, and passes.
- `npm run compile`, `npm run lint` and `npm test` all succeed.
