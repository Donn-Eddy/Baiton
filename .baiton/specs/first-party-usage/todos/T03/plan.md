# Plan T03

## Steps

1. Probe the installed codex CLI (manual, read-only) and record what is real

   The todo text was cut off after 'in this order:'. Use the source order the spec fixes: (1) a CLI subcommand, (2) the CLI's own server `codex app-server`, (3) files codex writes itself, (4) only as a fallback, the credential codex already stored (`$CODEX_HOME/auth.json`, default `~/.codex/auth.json`) against the provider account endpoint. Run each probe by hand from a scratch directory, never inside the workspace, and write down the exact command, the version and what came back. NEVER print, paste or commit a token; redact it as `[redacted]` in notes.
     a. `codex --version` and `codex --help` (also `codex help` and the help for any subcommand that looks like it might apply). Look for a non-interactive usage/limits/status subcommand. Expected: none exists. `/status` is a TUI slash command only. If none exists, record it as probed and unusable.
     b. `codex app-server`: send these JSONL lines on stdin, one JSON object per line, the same framing src/adapter/codex.ts uses: `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"baiton","version":"1.0.0"}}}`, then `{"jsonrpc":"2.0","method":"initialized","params":{}}`, then `{"jsonrpc":"2.0","id":2,"method":"account/rateLimits/read","params":{}}`. If that method is rejected, try `account/read` / `getAccountRateLimits` and record what each returns. Expected shape: `result.rateLimits = { primary: {usedPercent, windowDurationMins, resetsAt(unix seconds)} | null, secondary: same | null, planType?, credits? }`, and possibly `result.rateLimitsByLimitId`. Record the real field names. The parser must follow what the probe returned, not this guess.
     c. Files: look for the newest `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. Check whether it holds `{"type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent","window_minutes","resets_at"|"resets_in_seconds"},"secondary":…,"plan_type"?}}, "timestamp":…}` lines. Record the real field names.
     d. Fallback: only check whether `auth.json` has `tokens.access_token` and `tokens.account_id`, or only `OPENAI_API_KEY`. Do not print any value. Then `GET https://chatgpt.com/backend-api/wham/usage` with `Authorization: Bearer <token>` and `ChatGPT-Account-Id: <id>`. Expected: `{plan_type, rate_limit:{primary_window:{used_percent, limit_window_seconds, reset_at, reset_after_seconds}, secondary_window}}`. Record the status and the field names only.
   Save the raw (redacted) response shapes as test fixtures in step 3. Whichever mechanism really works first becomes the primary route. A mechanism that failed goes into the README as probed and unusable, with the reason.

   Files: (none)

2. Implement the host-free Codex reader in src/usage/codex.ts

   New file `src/usage/codex.ts`. It may import ONLY from './model' and './usageService' (types plus `redactSecrets`). No 'vscode', no Node built-ins such as child_process, fs, os or path, and no import from src/adapter/codex.ts, because that module pulls in child_process and fs. Copy the needed constants and the structural process type locally.

   Exports:
   - `CODEX_USAGE_APP_SERVER_SUBCOMMAND = 'app-server'`, `CODEX_USAGE_RATE_LIMITS_METHOD = 'account/rateLimits/read'` (or whatever step 1 proved), and the ids `CODEX_USAGE_INITIALIZE_ID = 1` / `CODEX_USAGE_RATE_LIMITS_ID = 2`.
   - `CODEX_WHAM_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'`, only if step 1d proved it works.
   - `interface CodexUsageProcess { stdin:{write(s:string):unknown; end():unknown}; stdout:{on(e:'data', l:(c:Buffer|string)=>void):unknown}; stderr?:…; on(e:'error'|'exit'|'close', l:(...a:unknown[])=>void):unknown; kill(sig?:string):unknown }`. This is structurally identical to `CodexAppServerProcess`.
   - `interface CodexUsageSeams { spawnAppServer?: () => CodexUsageProcess; readLatestRollout?: (signal: AbortSignal) => Promise<string | undefined> /* text of the newest rollout-*.jsonl or undefined */; readAuthFile?: () => Promise<string | undefined>; fetchJson?: (url: string, init: { headers: Record<string,string>; signal: AbortSignal }) => Promise<{ status: number; body: unknown }>; log?: (m: string) => void }`. Any seam left out means that mechanism is skipped and its reason says it is not wired.
   - Pure, total parsers that never throw and return `UsageWindow[]` plus an optional tier:
     * `parseCodexAppServerRateLimits(result: unknown): { windows: UsageWindow[]; tier?: string }`. For each of `rateLimits.primary` and `rateLimits.secondary` (and every entry of `rateLimitsByLimitId` if present, scope.model = limit id/name), build a window when `usedPercent` is a finite number. Set `usedPercent` (provider-reported) and `resetsAt = toEpochMs(resetsAt)`. `toEpochMs` multiplies by 1000 when the value is < 1e12 and returns undefined when it is not finite. `id`/`label` come from `windowLabel(windowDurationMins)`: 300 → 'five-hour'/'5-hour', 10080 → 'weekly'/'Weekly', any other n → `${n}-minute` with a human label (`Nh`/`Nd` when it divides), and missing → 'primary'/'secondary'. `provenance: 'provider-reported'`. tier comes from `planType`. Skip null windows. Never invent 0%.
     * `parseCodexRolloutRateLimits(jsonl: string, now: number): { windows; tier?; snapshotAt?: number }`. Scan lines from the END. Take the last parseable line whose `payload.type === 'token_count'` and that has an object `payload.rate_limits`. Map `used_percent`, `window_minutes` and `resets_at` (seconds) or `resets_in_seconds` (relative to the line's `timestamp`) the same way. snapshotAt = Date.parse(line.timestamp). DROP any window whose resetsAt <= now, because that window has reset and the old percent is no longer valid. Do not replace it with 0.
     * `parseCodexWhamUsage(body: unknown): { windows; tier? }`. Map `rate_limit.primary_window` / `secondary_window` (`used_percent`, `limit_window_seconds` / 60 → label, `reset_at` seconds or now + `reset_after_seconds`). tier = `plan_type`.
     * `extractCodexCredential(authJson: string): { accessToken: string; accountId?: string } | { apiKeyOnly: true } | undefined`. Read `tokens.access_token` and `tokens.account_id`. When only `OPENAI_API_KEY` is set, return apiKeyOnly. Never throw.
     Adjust every field name to what step 1 actually saw. Keep the expected names above only where the probe confirms them.
   - `readCodexAppServerRateLimits(spawn, signal, timeoutMs): Promise<unknown>`. Use the same idempotent `finish` pattern as `CodexAdapter.discoverModels`: JSONL buffer and line split, `initialize` → on id 1 send the `initialized` notification and the request with id 2 → resolve `result` of id 2. Reject with a plain message (redacted via redactSecrets) on a JSON-RPC error (include `error.message`), on spawn ENOENT ('codex was not found on PATH'), on exit/close before the reply, on abort, or on its own timeout of min(timeoutMs, 10s). Every path calls `stdin.end()` and `kill('SIGTERM')`. Do not answer server notifications or requests. Drain stderr but never log its content unredacted.
   - `createCodexUsageReader(seams: CodexUsageSeams): UsageReader`. Returns `async (ctx) => UsageReading` and never throws. Steps in order:
     1. If `ctx.signal.aborted`, return unavailable.
     2. app-server (mechanism 'cli-server', detail 'codex app-server account/rateLimits/read'). On success with ≥1 window, return `okReading('codex', {mechanism, detail, provenance:'provider-reported', readAt: ctx.now()}, windows, tier)`. On failure or 0 windows, store the reason and continue.
     3. rollout file (mechanism 'cli-files', detail `latest codex session log (token_count at <ISO snapshotAt>)`, provenance 'provider-reported', readAt = snapshotAt ?? ctx.now()). Skip this step if step 1 found codex writes no rate_limits.
     4. provider endpoint, only if `ctx.trusted`. Call readAuthFile → extractCodexCredential. With apiKeyOnly, the reason is 'Codex is signed in with an API key; API-key accounts have no plan usage windows.' Otherwise call fetchJson with Bearer + `ChatGPT-Account-Id`, `ctx.signal`, mechanism 'provider-endpoint', detail 'chatgpt.com wham/usage (stored Codex login)'. The token stays in a local `const`, is never put in a reading, a reason or a log, and goes out of scope after the call. A non-2xx response gives the reason `Provider usage endpoint returned HTTP <status>`. If `!ctx.trusted`, the reason is 'Restricted Mode: Baiton does not read the stored Codex login.' and no credential seam is called.
     5. If nothing gave windows, return `unavailableReading('codex', joinedReasons, ctx.now(), lastMechanismTried)`. Join the per-mechanism reasons with '; ' and pass them through redactSecrets. normaliseReason caps the length.
     Wrap the whole body in try/catch and turn anything caught into unavailable.
   Do not spawn or read anything at construction time. Every effect happens inside the returned function.

   Files: `src/usage/codex.ts`

3. Export from the usage barrel

   Add `export * from './codex';` to src/usage/index.ts. Check that no exported name collides with model.ts or usageService.ts exports.

   Files: `src/usage/index.ts`

4. Unit tests in test/usage.codex.test.ts

   Mocha + assert, the same style as test/usage.service.test.ts. Put the redacted probe responses from step 1 as inline constants or under test/fixtures/usage/codex/ (app-server result, rollout jsonl excerpt, wham body). Use a fake process modelled on `fakeAppServer` in test/adapter.codex.test.ts: an EventEmitter-like stdout with a scripted reply to each request id, and a record of writes and kill calls. Cases:
   (1) parseCodexAppServerRateLimits maps primary 5h and secondary weekly: percent, resetsAt seconds→ms, labels, tier from planType. Null windows are skipped. A non-numeric usedPercent gives no window and no bar. Garbage input → [].
   (2) parseCodexRolloutRateLimits takes the LAST token_count, ignores malformed lines, drops windows whose reset has passed, and handles resets_in_seconds relative to the line timestamp.
   (3) parseCodexWhamUsage maps the windows and plan_type.
   (4) extractCodexCredential handles tokens, apiKeyOnly, and invalid JSON → undefined.
   (5) The reader on the app-server happy path gives status ok, mechanism 'cli-server', provenance provider-reported. The framing is initialize → initialized → the method with id 2, and the child is killed and stdin ended.
   (6) A JSON-RPC error falls through to the rollout seam, giving mechanism 'cli-files'.
   (7) Every seam failing → unavailable with a non-empty reason that names each mechanism.
   (8) Restricted mode (`trusted:false`): the readAuthFile and fetchJson spies are never called, and the reason mentions Restricted Mode.
   (9) Credential redaction: auth.json has the token 'eyJhbGciOi.fakepayload.sig' / 'sk-test…'. Make fetchJson reject with a message containing the token, and in another case resolve 401. Assert that JSON.stringify(reading) and every log line do not contain the token. Also assert the success reading does not contain it, and that only fetchJson's headers got it.
   (10) Abort and timeout: abort ctx.signal mid-read and the child is killed and the reader settles unavailable without hanging. Use the service with a FakeTimer as in usage.service.test.ts, or a pre-aborted signal → no spawn.
   (11) Construction does not spawn: `createCodexUsageReader({spawnAppServer: spy})` → spy not called until the reader is invoked.
   (12) Host-free check: read src/usage/codex.ts and assert every import line is from './model' or './usageService' and that 'vscode', 'child_process' and "'fs'" are absent. Drive the reader through `new UsageService({readers:{codex: reader}, isTrusted:()=>true})` once, to show it fits the service contract.

   Files: `test/usage.codex.test.ts`, `test/fixtures/usage/codex/`

5. README: Codex usage probe findings

   Add a section `### Usage view (per-tool probe findings)` right before `## Commands` (after the 'Harness ask relay' section, about README.md:1034), unless one already exists. Write it in the style of the 'Harness ask relay (per-adapter probe findings)' bullets. Give one-sentence context: the Usage view reads each first-party tool's remaining usage through the real mechanism below; nothing is shown that the source did not give. Then a `- **codex findings** (probed `codex --version` → <x.y.z>, <date>):` bullet with sub-bullets: the mechanism established as real and the exact request; what it returned (field names, a redacted example); each mechanism probed and found unusable, with the reason (e.g. no usage subcommand in `codex --help`, rollout snapshots only as recent as the last session, API-key logins have no windows); how the fallback works (stored login read only in a trusted workspace and only for one request, never logged or stored); and Restricted Mode behaviour. Mark anything not confirmed as **unverified**.

   Files: `README.md`

6. Verify

   Run `npm run compile`, `npm run lint`, `npm test` and fix anything that fails. Confirm `git status` shows changes only to src/usage/codex.ts, src/usage/index.ts, test/usage.codex.test.ts, the test fixtures and README.md. Grep the diff for any real token or account id before finishing.

   Files: (none)

## Risks

- The todo text is truncated after 'in this order:'. The plan assumes the spec's general order: CLI subcommand → cli server → CLI files → stored-credential fallback. If the original list differed, the order of the reader's steps must change.
- The app-server method name and response shape (`account/rateLimits/read`, `rateLimits.primary.usedPercent`, `windowDurationMins`, `resetsAt` in seconds) are from memory of codex's v2 protocol and vary between codex versions. The executor must match the parser to the live probe, and tolerate camelCase and snake_case.
- `account/rateLimits/read` may need a ChatGPT login. With API-key auth it may return an error or null windows, which must become an honest unavailable reason, not 0%.
- Rollout-file snapshots can be hours old. Dropping windows whose reset has passed and setting readAt to the snapshot time keeps them honest. An executor that uses ctx.now() as readAt would overstate freshness.
- The chatgpt.com wham/usage endpoint is undocumented and may refuse requests (Cloudflare or changed paths). If the probe fails, record it as unusable and leave the fallback out instead of shipping an unverified route.
- Importing anything from src/adapter/codex.ts would pull child_process and fs into the host-free core. The structural process type and the constants must be duplicated locally.
- Spawning `codex app-server` with the workspace as cwd could load project config. The seam takes no cwd. The later vscode wiring todo should spawn it from a neutral directory (e.g. os.homedir()).
- The executor must not print or commit real tokens, account ids or email addresses from auth.json or probe output. Fixtures must be synthetic or redacted.

## Acceptance

- src/usage/codex.ts exists, exports createCodexUsageReader, CodexUsageSeams and the pure parsers, and imports only from './model' and './usageService' (asserted by a test).
- The reader tries the probed mechanisms in order. It returns ok with provenance 'provider-reported' and the matching mechanism when a source gives windows. Otherwise it returns unavailable with a non-empty reason, and never a placeholder or invented figure.
- usedPercent is set only when the source gave a percentage. Windows whose reset has already passed in a file snapshot are dropped.
- With ctx.trusted === false, no credential seam (readAuthFile/fetchJson) is called, and the reason explains Restricted Mode.
- No token from auth.json appears in any reading, reason, log line or thrown message (tested with a fake token on both the success and failure paths).
- Abort, timeout and child errors always kill the child and end stdin, and the reader always settles. Constructing the reader spawns nothing.
- test/usage.codex.test.ts covers the parsers and the fallthrough, unavailable, restricted-mode, redaction, abort/timeout and no-spawn-at-construction paths.
- README.md has a 'Usage view (per-tool probe findings)' section with a codex findings bullet: the CLI version and date, the real mechanism and what it returned, and each mechanism probed and found unusable.
- `npm run compile`, `npm run lint` and `npm test` all pass.
