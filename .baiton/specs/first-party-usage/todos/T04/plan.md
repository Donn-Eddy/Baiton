# Plan T04

## Steps

1. Probe the installed claude CLI (read-only) and record findings

   Before writing code, run these probes and note the exact outputs (version, date). Do NOT write into ~/.claude (or $CLAUDE_CONFIG_DIR), do NOT configure a statusline/hook, do NOT run anything that consumes a model turn, and never print a token to the terminal or a file (pipe credential output through `jq 'del(..|.accessToken?, .refreshToken?)'` or only inspect keys with `jq 'paths'`).
   (1) `claude --version`; `claude --help`; `claude doctor --help` / `claude doctor` (non-interactive?); check every listed subcommand for a usage/limits/status command (e.g. `claude usage`, `claude status`). (2) Check whether a slash command works non-interactively without a model call: `claude -p '/usage' --output-format json` and `claude -p '/status'` — record whether it prints usage numbers, an error such as 'not available in non-interactive mode', or starts a model turn (if it starts a model turn, stop and treat it as unusable). (3) Session files the CLI writes: `ls $CONFIG/projects/*/` newest `*.jsonl`; grep them for `rate_limit`, `rateLimit`, `utilization`, `resets_at`, `five_hour`, `seven_day`, `limit reached` — record whether any line carries a current percent/reset (token `usage` counts per message are NOT a remaining-usage figure and must not be summed into one). Also check `$CONFIG/statsig`, `$CONFIG/.claude.json`/`~/.claude.json` keys only (`jq 'keys'`) for cached limit data. (4) Credential store: `jq 'paths|map(tostring)|join(".")' $CONFIG/.credentials.json` (keys only) — expected `claudeAiOauth.{accessToken,refreshToken,expiresAt,scopes,subscriptionType,rateLimitTier}`; on macOS the store is the keychain item 'Claude Code-credentials' (note it, do not wire it). (5) Endpoint: with the token in a shell variable only (`T=$(jq -r .claudeAiOauth.accessToken $CONFIG/.credentials.json)`), `curl -s -H "Authorization: Bearer $T" -H 'anthropic-beta: oauth-2025-04-20' -H 'Accept: application/json' https://api.anthropic.com/api/oauth/usage | jq .` then `unset T`. Expected shape (verify, don't assume): `{five_hour:{utilization,resets_at}, seven_day:{...}, seven_day_opus:{...}|null, seven_day_sonnet:{...}|null, seven_day_oauth_apps:..., extra_usage:{is_enabled,monthly_limit,used_credits,utilization}|null}` with `utilization` a 0..100 percent and `resets_at` an ISO-8601 string. Confirm whether utilization is 0..100 or 0..1 by comparing to `/usage` in an interactive session if needed. Also record the response to a bad token (expected 401) without echoing the token. Save a sanitized copy of the real response (no account ids/emails) as the test fixture in step 4. Decide the route order from the results: a CLI route goes first ONLY if it yields a real number without a model turn and without writes; otherwise the CLI routes are recorded as 'probed, unusable'.

   Files: (none)

2. Export config-dir helpers from the claude adapter

   In src/adapter/claude.ts change `function claudeConfigDir(): string` (around line 677) to `export function claudeConfigDir(): string` (same body: $CLAUDE_CONFIG_DIR when non-empty else ~/.claude) and add, next to `claudeCatalogDir()`:
   ```ts
   /** The file where the Claude CLI stores its OAuth login on Linux/Windows (macOS uses the keychain). */
   export const CLAUDE_CREDENTIALS_FILE = '.credentials.json';
   /** `<config dir>/.credentials.json`. Read only by the Usage view, only in a trusted workspace. */
   export function claudeCredentialsPath(): string { return path.join(claudeConfigDir(), CLAUDE_CREDENTIALS_FILE); }
   /** `<config dir>/projects` — the CLI's per-project session logs. */
   export function claudeProjectsDir(): string { return path.join(claudeConfigDir(), 'projects'); }
   ```
   Add `claudeProjectsDir` only if step 1 established a session-file route. No other adapter behaviour changes. Check src/adapter/index.ts re-exports (`export * from './claude'`) produce no name clash (grep for `claudeConfigDir|claudeCredentialsPath` across src). These are for the later vscode wiring todo; src/usage/claude.ts must NOT import the adapter.

   Files: `src/adapter/claude.ts`

3. Write src/usage/claude.ts (host-free reader)

   Mirror src/usage/codex.ts structure exactly. Imports only from './model' (`okReading`, `unavailableReading`, types `UsageMechanism`, `UsageReading`, `UsageWindow`) and './usageService' (`UsageReader`, `redactSecrets`); no vscode, no Node built-ins, no adapter import.

   Module header JSDoc: spec first-party-usage todo T04; the probe findings from step 1 (claude version + date; the established route; what it returned, with a sanitized example; every mechanism probed and found unusable and why — CLI subcommands, `-p '/usage'`, session files, statusline rate_limits (only delivered to a configured statusline command, which would require writing user settings), keychain on macOS not wired; 'Unverified:' items).

   Constants: `CLAUDE_OAUTH_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'`, `CLAUDE_OAUTH_BETA_HEADER = 'oauth-2025-04-20'` (use the values the probe confirmed).

   Seams:
   ```ts
   export interface ClaudeUsageSeams {
     /** ONLY if step 1 found a CLI route: runs `claude <args>` (no shell, neutral cwd) and returns its output. */
     readonly runCli?: (args: readonly string[], signal: AbortSignal, timeoutMs: number) => Promise<{ code: number | null; stdout: string }>;
     /** ONLY if step 1 found usage data in session files: text of the newest session log, or undefined. */
     readonly readLatestSessionLog?: (signal: AbortSignal) => Promise<string | undefined>;
     /** Text of <config>/.credentials.json (or the keychain item), undefined when absent. */
     readonly readCredentials?: () => Promise<string | undefined>;
     readonly fetchJson?: (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ status: number; body: unknown }>;
     readonly log?: (message: string) => void;
   }
   ```
   Omit `runCli`/`readLatestSessionLog` (and their parser) entirely if the probe found no CLI route — do not ship dead seams; the header then documents why.

   Parsers (all exported, total, try/catch returning `{ windows: [] }`):
   - `parseClaudeOauthUsage(body: unknown): { windows: UsageWindow[] }` — iterate the body's own keys in a fixed known order first (`five_hour`, `seven_day`, `seven_day_sonnet`, `seven_day_opus`, `seven_day_oauth_apps`), then any other key whose value is an object with a finite numeric `utilization` (generic id = key, label = key with '_'→' '). Skip null/non-object entries and entries without a numeric utilization (no bar invented, no zero). Mapping: five_hour → `{id:'five-hour', label:'5-hour'}`; seven_day → `{id:'weekly', label:'Weekly (all models)'}`; seven_day_opus → `{id:'weekly:opus', label:'Weekly (Opus)', scope:{model:'opus'}}`; seven_day_sonnet → same with sonnet; seven_day_oauth_apps → `{id:'weekly:oauth-apps', label:'Weekly (OAuth apps)'}`. `usedPercent` = utilization exactly as given (scale per probe; if probe shows 0..1, multiply by 100 and say so in the header). `resetsAt` = `Date.parse(resets_at)` when finite (also accept a numeric seconds/ms value like codex `toEpochMs`). `provenance: 'provider-reported'`. `extra_usage`: only when `is_enabled === true`; window `{id:'extra-usage', label:'Extra usage'}` with `usedPercent` only if `utilization` is numeric and `raw: { used: used_credits, limit: monthly_limit, unit: 'credits' }` with only finite numbers kept; skip if it would carry neither percent nor raw numbers.
   - `extractClaudeCredential(text: string): { accessToken: string; expiresAt?: number; tier?: string } | { apiKeyOnly: true } | undefined` — JSON.parse; read `claudeAiOauth.accessToken` (non-empty string), `expiresAt` (finite number, ms), tier = `subscriptionType` (e.g. 'max') plus rateLimitTier if useful (e.g. `max (default_claude_max_20x)`; pick one consistent format and document it); `{apiKeyOnly:true}` when there is no oauth block but a `primaryApiKey`/`apiKey`-style field exists (use what probe step 4 showed); undefined otherwise. Never throws, never logs.
   - If a CLI route exists: `parseClaudeCliUsage(stdout: string)` / `parseClaudeSessionLogUsage(jsonl: string, now: number)` returning `{ windows, tier?, snapshotAt? }`, dropping windows whose reset has passed (as codex rollout does).

   Reader: `export function createClaudeUsageReader(seams: ClaudeUsageSeams): UsageReader` — construction does nothing. Body follows `createCodexUsageReader`: `reasons: string[]`, `last: UsageMechanism | undefined`, redacting `log`, abort check before each route, outer try/catch returning `unavailableReading('claude', redactSecrets(...), ctx.now(), last)`.
    Route order: (1) CLI route(s) if they exist (mechanism 'cli-command' / 'cli-files'); ENOENT from runCli → reason 'claude was not found on PATH'; a CLI that reports signed out → reason 'Claude Code is signed out (run `claude` to log in)'. Return ok as soon as one yields ≥1 window. (2) Provider endpoint fallback: if `!ctx.trusted` push 'Restricted Mode: Baiton does not read the stored Claude Code login.' and do NOT call readCredentials/fetchJson; else if both seams wired: `last='provider-endpoint'`; read credentials (rejection → 'stored Claude Code login is unreadable'); undefined → 'no stored Claude Code login found (signed out?)'; apiKeyOnly → 'Claude Code is signed in with an API key; API-key accounts have no plan usage windows.'; `expiresAt <= ctx.now()` → 'the stored Claude Code login has expired; run `claude` once to refresh it' (never refresh the token — that would write the credential store); otherwise `fetchJson(CLAUDE_OAUTH_USAGE_URL, { headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': CLAUDE_OAUTH_BETA_HEADER, Accept: 'application/json' }, signal: ctx.signal })`. Non-2xx → `Provider usage endpoint returned HTTP ${status}` (401/403 additionally ' (sign in again with `claude`)'). 2xx with zero windows → 'Provider usage endpoint returned an unknown response shape'. Success → `okReading('claude', { mechanism:'provider-endpoint', detail:'api.anthropic.com oauth/usage (stored Claude Code login)', provenance:'provider-reported', readAt: ctx.now() }, windows, credential.tier)`. Catch → `Provider usage endpoint failed: ${redactSecrets(describe(e))}`. The token stays in a local `const` inside that block only; it is never in a reason, log, reading or thrown message. (3) Final: `unavailableReading('claude', redactSecrets(reasons.join('; ')), ctx.now(), last)` and a redacted log line.

   Add `export * from './claude';` to src/usage/index.ts and check for export-name clashes with codex.ts (all names are claude-prefixed).

   Files: `src/usage/claude.ts`, `src/usage/index.ts`

4. Add sanitized fixtures

   Create test/fixtures/usage/claude/oauth-usage.json from the probe's real response with ids/emails removed (keep five_hour, seven_day, at least one per-model bucket — add a `seven_day_opus` and a null `seven_day_sonnet` if the live response lacked them so both paths are covered — and extra_usage). Create test/fixtures/usage/claude/credentials.json with a FAKE token (e.g. 'sk-ant-oat01-FAKEFAKEFAKEFAKE'), a future `expiresAt`, `subscriptionType`, `rateLimitTier`. If a CLI route exists add its fixture too (cli-usage.txt or session.jsonl).

   Files: `test/fixtures/usage/claude/oauth-usage.json`, `test/fixtures/usage/claude/credentials.json`

5. Write test/usage.claude.test.ts

   Mocha + assert, modelled on test/usage.codex.test.ts (fixture loader via `path.join(__dirname,'fixtures','usage','claude',name)`, a `ctx(overrides)` helper building `UsageReadContext` with a fresh AbortController, `trusted: true`, fixed `now`, `timeoutMs: 1000`). Cases:
   Parsers: maps five_hour/seven_day/opus with ids, labels, scope.model, resetsAt = Date.parse(ISO), usedPercent verbatim; null bucket and non-numeric utilization skipped (no window, no zero); unknown extra bucket with utilization gets a generic window; extra_usage disabled → no window, enabled → raw numbers; garbage inputs (undefined, [], 'x', {five_hour:'x'}) → `{windows:[]}` without throwing. extractClaudeCredential: oauth → token/expiresAt/tier; api-key-only; invalid JSON / {} → undefined.
   Reader: (a) happy path via endpoint → status ok, mechanism 'provider-endpoint', provenance 'provider-reported', tier set, fetchJson called once with the URL, Bearer header and beta header. (b) Route precedence: if a CLI route exists, CLI success → ok with CLI mechanism and readCredentials/fetchJson never called; CLI failing/no number → falls through to endpoint; reason lists each mechanism when all fail. If no CLI route exists, test instead that with no credential seams the reason names the missing route and that only the endpoint route is attempted. (c) Unavailable reasons: CLI absent (ENOENT, if CLI route), credentials undefined (signed out), readCredentials rejects (unreadable), api-key-only, expired token (fetchJson NOT called), HTTP 401, 2xx unknown shape ({foo:1}) — each `status:'unavailable'` with non-empty reason and `tool:'claude'`. (d) Restricted Mode: `trusted:false` → readCredentials and fetchJson call counts stay 0 and reason contains 'Restricted Mode'. (e) Credential redaction: with token 'sk-ant-oat01-SECRETSECRETSECRET', make fetchJson reject with `new Error('boom Bearer ' + token)` and separately return 401 with a body echoing the token; assert the token string is absent from `JSON.stringify(reading)` and from every captured `log` message; also on success assert the token is absent from the ok reading. (f) Pre-aborted signal → unavailable, no seam called. (g) Constructing the reader calls no seam. (h) Module shape: read src/usage/claude.ts source and assert its imports are only './model' and './usageService' (copy the codex shape test), and that `new UsageService({ readers: { claude: createClaudeUsageReader(seams) }, isTrusted: () => true, ... })` produces a claude reading (follow how usage.codex.test.ts drives UsageService, including its timer/now options).

   Files: `test/usage.claude.test.ts`

6. Record the claude findings in README

   Under `### Usage view (per-tool probe findings)` in README.md (after the intro paragraph, BEFORE the existing `- **codex findings**` bullet so the order matches the view: Claude Code, Codex, …), add `- **claude findings** (probed `claude --version` → <ver>, <date>):` with sub-bullets in the codex bullet's style: **Established route** (what and why), **Returned** (sanitized shape/example), **Probed, unusable** (each CLI route tried and its result), **Fallback handling** (credential file path `$CLAUDE_CONFIG_DIR`/`~/.claude/.credentials.json`, trusted workspaces only, one request, never logged/stored, expired tokens are not refreshed), **Restricted Mode** (the exact reason text), **Unverified** (macOS keychain not wired; other CLI versions; anything not confirmed). Keep it consistent with the module header.

   Files: `README.md`

7. Verify

   Run `npm run compile`, `npm run lint`, `npm test` (or `npx mocha test/usage.claude.test.ts` first for iteration). Fix any lint in new files (the pre-existing `_legacy` warning in src/orchestrator/webviewProtocol.ts is known). `git status` must show only the files listed in this plan; nothing written under ~/.claude.

   Files: (none)

## Risks

- The planner could not run the CLI; the endpoint URL, beta header, response keys, utilization scale (0..100 vs 0..1) and credential-file keys are from prior knowledge and MUST be confirmed by the step-1 probe — adjust constants, parser and fixture to what the probe actually returns.
- `claude -p '/usage'` or similar may start a billed model turn; stop the probe and treat it as unusable rather than shipping a route that spends tokens.
- Do not refresh an expired OAuth token: that would rotate and write the CLI's credential store, violating the no-write rule; report unavailable instead.
- macOS stores the login in the keychain; the reader is seam-based so the later wiring todo can supply a keychain reader, but this todo does not wire it — record as unverified.
- Leaking the token: build the Authorization header only inside the endpoint block, never interpolate it into a reason/log/Error, and pass every message through redactSecrets; tests must assert absence of the token string.
- Per-message token `usage` in session logs is not remaining usage; summing it into a percent would be an invented/extrapolated figure and is forbidden.
- README.md is outside the todo's listed files but the OVERVIEW requires per-tool findings there and T03 added the codex entry the same way; keep the edit confined to the new claude bullet. src/usage/index.ts and fixtures are likewise required supporting edits.
- Exporting `claudeConfigDir` from the adapter is re-exported via src/adapter/index.ts; check for name clashes before compiling.

## Acceptance

- src/usage/claude.ts exists, exports createClaudeUsageReader, parseClaudeOauthUsage, extractClaudeCredential (plus CLI parsers only if a CLI route was established), imports only './model' and './usageService', and its header documents the probe findings (version, date, established route, returned shape, unusable routes, unverified items).
- Route precedence: any established CLI route is tried before the stored-credential endpoint; the endpoint is used only as fallback and never in Restricted Mode (readCredentials/fetchJson not called when trusted is false).
- Every failure (CLI absent, signed out, token unreadable, API-key-only, expired token, non-2xx, unknown response shape, abort) yields status 'unavailable' with a non-empty reason; no figure is invented and windows lacking a source percentage get no usedPercent.
- The token never appears in a reading, reason, or log message (asserted in tests with a fake token in rejection messages and response bodies).
- src/adapter/claude.ts exports claudeConfigDir and claudeCredentialsPath with no behaviour change to the adapter.
- src/usage/index.ts re-exports './claude'; README has a claude findings bullet under 'Usage view (per-tool probe findings)'.
- test/usage.claude.test.ts covers parsers, route precedence, each unavailable path, restricted mode, credential redaction, abort, lazy construction and the host-free import shape.
- `npm run compile`, `npm run lint` and `npm test` pass.
