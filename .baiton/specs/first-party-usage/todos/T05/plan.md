# Plan T05

## Steps

1. Probe the installed agy CLI for a real usage route (no repo writes)

   Run every probe from a scratch directory outside the repo (e.g. the session scratchpad), never inside the workspace, and record exact commands, the agy version and the date for the module header. Do NOT print any token: when a probe has to touch a stored credential, use a tiny throwaway node script in the scratch dir that reads the file, keeps the token in a variable, and prints only HTTP status plus the response body with any token-looking value replaced (or just the key structure). Do not refresh an expired token (that would rewrite agy's credential store) and do not write into ~/.gemini, ~/.config or any agy config dir.

   Probe in this priority order and stop adding mechanisms once a working one is found, but still probe the earlier-listed ones far enough to record them as unusable:
   1. CLI command (mechanism 'cli-command'): `agy --version`; `agy --help`; `agy help`; `agy <sub> --help` for every subcommand listed. Look for anything named usage / quota / limits / stats / status / account / whoami / credits. Also check `agy models --help` for a flag that adds quota columns (the adapter documents `agy models` printing `id<TAB>label` only; see src/adapter/antigravity.ts ANTIGRAVITY_MODELS_ARGS). If agy has non-interactive slash commands via `-p` (as the adapter uses `-p=...` in README probes), try `agy -p '/usage'`, `'/quota'`, `'/stats'` ONLY if `--help` shows they are local commands; confirm no model turn ran (no credits consumed: compare a quota reading before/after if one is reachable). Note: agy exits 0 even on error and prints a spinner on stderr — judge stdout only, exactly as the adapter's discoverModels does.
   2. CLI server (mechanism 'cli-server'): whether `agy --help` lists a server/daemon/language-server mode Baiton could start itself and query (analogous to `codex app-server`). Do not read another process's argv/CSRF token.
   3. CLI files (mechanism 'cli-files'): list agy's config/state dirs (candidates: ~/.gemini/antigravity*, ~/.gemini, ~/.antigravity, ~/.config/agy, ~/.config/Antigravity, ~/.local/share/agy, $XDG_STATE_HOME) with `ls -la`, and grep them for key NAMES only (`grep -rl -E 'remainingFraction|quotaInfo|resetTime|quota|credits'`), never cat a file that holds a token. If a quota/state file exists, capture its shape (redacted) and its write time relative to the last agy session.
   4. Fallback provider endpoint (mechanism 'provider-endpoint', trusted only): locate the credential agy already stored (file path and JSON key names; if it lives in the OS keyring/secret service only, record that and treat the fallback as not wired). With the token held in memory only, try the Google Cloud Code endpoints the Antigravity/Gemini tooling uses: POST https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist (body {"metadata":{"ideType":"ANTIGRAVITY"}} or {} — record which works; gives currentTier/paidTier and cloudaicompanionProject), then POST https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels with {"project":"<project>"} (per-model quotaInfo {remainingFraction, resetTime}) and/or POST v1internal:retrieveUserQuota with {"project":"<project>"} (buckets [{modelId, remainingFraction, resetTime, tokenType}]). Record status codes, exact response shape, whether `remainingFraction` is omitted for an exhausted model, and the 401 behaviour with a bad token. Pick the one that returns per-model quota; keep the other only if it adds the tier.
   Save scrubbed copies of every real response that the reader will parse (replace emails, project ids, account ids, tokens with placeholders) — they become the test fixtures in step 3.

   Files: (none)

2. Implement src/usage/antigravity.ts mirroring src/usage/codex.ts and src/usage/claude.ts

   Host-free module: imports only from './model' and './usageService' (no vscode, no Node built-ins, no import of src/adapter/antigravity.ts — repeat the binary name 'agy' as a local constant). Constructing the reader performs no I/O.

   Module header doc comment: 'Host-free Antigravity usage reader for the Usage view (spec first-party-usage, todo T05)', then 'Probe findings (agy <version>, linux, <date>):' with the same structure as claude.ts: Established route (primary, mechanism ...) with the exact command/endpoint and an abridged real output; Fallback (trusted only) with endpoint, headers (token shown as <stored token>), body, the response shape and where the stored login lives plus the key names used; 'Probed, unusable:' every mechanism from step 1 that did not work and why; 'Unverified:' versions/platforms/login kinds not exercised. If NO route works, the header says so precisely and the reader below implements only the unavailable path with that reason.

   Exports (keep only the ones the probe justified; names fixed so tests and later wiring can rely on them):
   - Constants: `ANTIGRAVITY_USAGE_BIN = 'agy'`; `ANTIGRAVITY_USAGE_CLI_ARGS: readonly string[]` (only if a CLI route exists); endpoint URL constants e.g. `ANTIGRAVITY_LOAD_CODE_ASSIST_URL`, `ANTIGRAVITY_FETCH_MODELS_URL` / `ANTIGRAVITY_RETRIEVE_QUOTA_URL` (only those actually used); `const CLI_MAX_TIMEOUT_MS = 15_000`.
   - `export interface AntigravityUsageSeams` — every effect optional, a missing seam skips that mechanism: `runCli?(args, signal, timeoutMs): Promise<{ code: number | null; stdout: string }>` (no shell, neutral cwd); `readStateFile?(signal): Promise<string | undefined>` (only if a CLI-written quota/state file exists); `readCredentials?(): Promise<string | undefined>` (text of agy's stored login); `postJson?(url, init: { headers: Record<string,string>; body: unknown; signal: AbortSignal }): Promise<{ status: number; body: unknown }>` (POST, since the cloudcode endpoints are POST; use `fetchJson` with GET shape instead if the probe shows GET); `log?(message)`.
   - Parsers, all total (try/catch → empty result), using the same local helpers isRec/num/str/toEpochMs (ISO string or s/ms) as claude.ts:
     * `parseAntigravityQuota(body: unknown): { windows: UsageWindow[]; tier?: string }` accepting each shape the probe actually saw. Shapes to support if observed: (a) `{ models: { [id]: { displayName?, label?, quotaInfo?: { remainingFraction?, resetTime? } } } }`; (b) `{ buckets: [{ modelId, remainingFraction?, resetTime?, tokenType? }] }`; (c) a nested `userStatus.cascadeModelConfigData.clientModelConfigs[]` with `{ label, modelOrAlias: { model }, quotaInfo }` if a CLI file/command emits it. Per model: usedPercent = (1 - remainingFraction) * 100 when remainingFraction is a finite number (clamp handled by model.normaliseWindow; percent is the provider's own fraction so provenance 'provider-reported'); if the source gives a percent field use it directly. A model with no quota fraction/percent gets NO window (never invent 0 or 100) — unless the probe proved that an omitted remainingFraction with a resetTime means exhausted, in which case document that in the header and map it to usedPercent 100 with a test. Window: `{ id: 'model:<id>', label: displayName ?? id, usedPercent, resetsAt?, scope: { model: id }, provenance: 'provider-reported' }`; de-duplicate by id, keep source order. If several model ids share one quota group in the response, emit one window per model anyway (do not merge or average).
     * `parseAntigravityTier(body: unknown): string | undefined` from loadCodeAssist (`paidTier.name ?? currentTier.name ?? currentTier.id`) or planInfo/planName if that is the shape seen.
     * `parseAntigravityCliUsage(stdout: string, now: number)` only if a CLI command exists; same contract as parseClaudeCliUsage (windows + optional signedOut).
     * `extractAntigravityCredential(text: string): { accessToken: string; expiresAt?: number } | undefined` using the key names found (e.g. access_token / accessToken, expiry / expires_at / expiry_date normalised to epoch ms). Never throws, never logs.
   - `export function createAntigravityUsageReader(seams: AntigravityUsageSeams): UsageReader` with exactly the claude/codex control flow: reasons: string[], `let last: UsageMechanism | undefined`, redacted log wrapper; early unavailable when `ctx.signal.aborted`; try CLI route(s) first (budget `Math.min(ctx.timeoutMs > 0 ? ctx.timeoutMs : CLI_MAX_TIMEOUT_MS, CLI_MAX_TIMEOUT_MS)`), then state file, each returning `okReading('antigravity', { mechanism, detail, provenance: 'provider-reported', readAt }, windows, tier)` when windows.length > 0 (for a file snapshot use its own timestamp as readAt like codex rollout, and drop windows whose resetsAt <= now); ENOENT → 'agy was not found on PATH'; then `if (!ctx.trusted) reasons.push('Restricted Mode: Baiton does not read the stored Antigravity login.')` — in that branch readCredentials and postJson must not be called at all; else if both seams present: extract credential → missing: 'no stored Antigravity login found (signed out?)'; expired (expiresAt <= ctx.now()): 'the stored Antigravity login has expired; run `agy` once to refresh it' (never refresh); otherwise call the endpoint(s) with headers { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' }, non-2xx → `Provider usage endpoint returned HTTP ${status}` (+ ' (sign in again with `agy`)' for 401/403), ok with windows → okReading with detail like 'cloudcode-pa fetchAvailableModels (stored Antigravity login)', no windows → 'Provider usage endpoint reported no model quotas'. Token only in a local const inside that block; never placed in reasons, detail, tier or logs; every reason and caught error passes through redactSecrets. Final: `unavailableReading('antigravity', redactSecrets(reasons.join('; ')), ctx.now(), last)`; outer catch → 'Antigravity usage read failed: ...'. Mechanisms the probe found unusable are not coded at all (they appear only in the header).

   Files: `src/usage/antigravity.ts`

3. Export from the usage barrel

   Add `export * from './antigravity';` to src/usage/index.ts after the './claude' line. Make sure no exported name collides with codex.ts/claude.ts exports (all new names are Antigravity-/ANTIGRAVITY_-prefixed; keep helpers like isRec/num/str non-exported).

   Files: `src/usage/index.ts`

4. Adapter cross-reference (minimal)

   In src/adapter/antigravity.ts, extend the class doc comment (or the `discoverModels` doc) with one short note that usage/quota is read by src/usage/antigravity.ts and that the adapter's `agy models` listing carries no quota (or whatever the probe established). Only if the probe found the route is an agy subcommand that the adapter should own, also export the argv constant there (e.g. `ANTIGRAVITY_USAGE_ARGS`) — but the usage module must still not import the adapter (duplicate the constant and add a test asserting they are equal, like the claude/codex readers keep their own constants). Do not change launch(), discoverModels() or any existing behaviour; test/adapter.antigravity.test.ts must stay green unchanged.

   Files: `src/adapter/antigravity.ts`

5. Fixtures from the real probe

   Create test/fixtures/usage/antigravity/ holding the scrubbed real outputs captured in step 1, e.g. `cli-usage.txt` (if a CLI route exists), `fetch-available-models.json` and/or `retrieve-user-quota.json`, `load-code-assist.json`, `credentials.json` (fake token 'ya29.fakeTokenABCDEFGH' / 'eyJhbGciOi.fakepayload.sig', fake expiry) and a state file if one exists. Replace every email, project id, account id and token with placeholders; keep the structure and numeric fields verbatim.

   Files: `test/fixtures/usage/antigravity/`

6. Unit tests in test/usage.antigravity.test.ts

   Follow test/usage.codex.test.ts style (mocha + assert, fixtures read via fs from __dirname/fixtures/usage/antigravity, a `ctx(overrides)` helper building a UsageReadContext with a fresh AbortController, trusted true, fixed now, timeoutMs 5000). Cases:
   - Parsers: each fixture parses to the expected windows (ids 'model:<id>', labels, usedPercent = (1 - fraction)*100 within 1e-9, resetsAt from ISO), tier from load-code-assist; a model without quotaInfo/fraction yields no window; garbage inputs (undefined, 42, '{', [], {models: null}) return { windows: [] } without throwing; fraction > 1 or < 0 ends clamped after okReading; duplicate model ids de-duplicated; extractAntigravityCredential on fixture, on API-key/empty/invalid JSON.
   - CLI route (if implemented): runCli fake returns fixture stdout → ok, mechanism 'cli-command', provenance 'provider-reported'; runCli rejecting with {code:'ENOENT'} → falls through and the final reason contains 'agy was not found on PATH'; empty stdout with exit 0 → next mechanism.
   - Fallback: trusted + credentials + postJson fixture → ok, mechanism 'provider-endpoint', Authorization header equals `Bearer <fake token>` on the request the fake received; HTTP 401 → unavailable with 'HTTP 401' and the sign-in hint; expired credential → postJson never called, reason mentions expired; missing credentials → 'no stored Antigravity login'.
   - Restricted mode: ctx.trusted false → readCredentials and postJson spies called 0 times, status unavailable (or ok from a CLI route), reason contains 'Restricted Mode'.
   - Credential redaction: with a postJson fake that throws an Error whose message embeds the token and a log spy, JSON.stringify(reading) and every logged line do not contain the token; same for a 500 body echoing the token.
   - Never before expand / construction is inert: createAntigravityUsageReader(seams) with spies on every seam → all counts 0 until the reader is invoked; constructing a UsageService with this reader triggers no seam.
   - Abort: ctx with an already-aborted signal → unavailable, no seam called.
   - Unavailable with no seams wired → status 'unavailable', non-empty reason, no windows.
   - Service integration: UsageService({ readers: { antigravity: reader }, isTrusted: () => true }) refresh → ok reading for 'antigravity'; a second failing read keeps it as stale with the reason; two concurrent refreshTool('antigravity') calls hit the seam once (coalescing); a never-resolving seam with a small timeoutMs and a fake timer settles as unavailable 'timed out'.
   If the probe found no workable route, the tests assert the precise unavailable reason for each wired-but-empty case and that no windows are ever produced.

   Files: `test/usage.antigravity.test.ts`

7. README probe findings

   Under README.md '### Usage view (per-tool probe findings)', add an '- **antigravity (agy) findings** (probed `agy --version` → <version>, <date>):' bullet after the codex bullet, with sub-bullets in the codex style: Established route (primary), Returned (abridged real shape, no ids/tokens), Probed, unusable as the route (each mechanism and why), Probed, fallback only (endpoint + stored-login location + key names), Fallback handling (trusted only, memory-only token, redactSecrets), Restricted Mode (what is skipped and the exact reason text), Unverified. Keep it consistent with the module header.

   Files: `README.md`

8. Verify

   Run `npm run compile`, `npm run lint`, `npm test` (or `npx mocha test/usage.antigravity.test.ts` first for speed, then the full suite). Confirm `git status` shows only the files listed in this plan changed/added and nothing written outside the repo's intended paths; delete any scratch probe scripts (they live in the scratchpad, not the repo). Grep src/usage/antigravity.ts to confirm it has no `from 'vscode'`, no `from 'fs'`/`child_process`/`path`/`os`, and no import from '../adapter'.

   Files: (none)

## Risks

- The real agy usage route is unknown until probed; the plan names candidates (CLI subcommand/slash command, agy-written state files, cloudcode-pa loadCodeAssist + fetchAvailableModels/retrieveUserQuota) but the executor must code only what the probe proves and record the rest as unusable. If nothing works, the correct outcome is an unavailable-only reader with a precise reason — not a guessed endpoint.
- Probing the fallback touches the user's real stored login: a careless `cat` or verbose curl would print the token into the transcript. Use a scratch node script that never echoes the token; never refresh an expired token (that rewrites agy's credential store).
- remainingFraction → usedPercent is a unit conversion of the provider's own figure, so it is labelled provider-reported and gets a bar; an omitted remainingFraction must NOT be treated as 0/exhausted unless the probe observed that semantics on an exhausted model.
- Running agy `-p` slash commands may start a model turn and consume quota; only use one if --help/output proves it is a local command.
- agy exits 0 on errors and writes a spinner to stderr; judge stdout content, not exit code.
- The credential may live only in the OS keyring/secret service on this host; then the fallback seam stays unwired (host may supply it later) and this must be documented as unverified, not faked.
- Name collisions in the src/usage barrel: keep helper functions unexported and all exports Antigravity-prefixed.
- Undocumented Google endpoints may change shape; parsers must stay total and the endpoint is tried last.

## Acceptance

- src/usage/antigravity.ts exists, imports only './model' and './usageService', and exports createAntigravityUsageReader plus total parser functions; its header records agy version/date, the established route with real output, the fallback, every mechanism probed and found unusable, and unverified points.
- src/usage/index.ts re-exports './antigravity'.
- The reader returns ok only with source-given figures (provider-reported provenance, bar only from a source percentage/fraction) and otherwise unavailable with a non-empty, redacted, specific reason; it never returns placeholder or extrapolated numbers.
- In Restricted Mode (ctx.trusted false) the credential-read and provider-HTTP seams are never called and the reason contains 'Restricted Mode'.
- No token appears in any reading, reason, source detail, tier or log line (tested).
- Constructing the reader (and a UsageService with it) invokes no seam (tested).
- test/usage.antigravity.test.ts covers each parser against real scrubbed fixtures in test/fixtures/usage/antigravity/, the unavailable, restricted-mode, credential-redaction, abort, coalescing, stale and timeout paths.
- README '### Usage view (per-tool probe findings)' has an antigravity (agy) findings bullet consistent with the module header.
- src/adapter/antigravity.ts behaviour is unchanged (existing adapter tests pass unmodified).
- `npm run compile`, `npm run lint` and `npm test` all pass.
