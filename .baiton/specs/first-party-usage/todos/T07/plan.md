# Plan T07

## Steps

1. Define the composition seams in src/usage/index.ts

   Keep the existing barrel lines (`export * from './model'`, './usageService', './codex', './claude', './antigravity', './opencode') and add, below them, a host-free composition section. index.ts must import ONLY from local './…' modules (no 'vscode', no Node built-ins such as fs/child_process, no '../adapter'). Imports needed: `USAGE_TOOL_IDS, type UsageToolId` from './model'; `type UsageReader, type UsageReadContext, redactSecrets` from './usageService'; `createClaudeUsageReader` from './claude'; `createCodexUsageReader, CODEX_USAGE_APP_SERVER_SUBCOMMAND, type CodexUsageProcess` from './codex'; `createAntigravityUsageReader, ANTIGRAVITY_USAGE_BIN` from './antigravity'; `createOpencodeGoUsageReader` from './opencode'.

   Add these exported types:
   ```ts
   /** CLI names the readers run; resolution maps each to a path. */
   export type UsageCliName = 'claude' | 'codex' | 'agy';
   export interface UsageCommandResult { readonly code: number | null; readonly stdout: string }
   export interface UsageFetchResponse { readonly status: number; readonly body: unknown; readonly headers?: Record<string, string> }
   export type UsageFetchJson = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<UsageFetchResponse>;
   export type UsageCredentialRead = () => Promise<string | undefined>;

   /** Every external surface of the four readers. A seam left out skips that route. */
   export interface UsageReaderTableSeams {
     /** Resolves a CLI (settings override, then PATH) to an executable path, or undefined when not installed. Called only inside a read. */
     readonly resolveExecutable?: (cli: UsageCliName) => string | undefined;
     /** Runs `<executable> <args>` without a shell, from a neutral cwd, killed on signal/timeout. */
     readonly runCommand?: (executable: string, args: readonly string[], signal: AbortSignal, timeoutMs: number) => Promise<UsageCommandResult>;
     /** Spawns `<executable> <args>` with piped stdio from a neutral cwd (codex app-server). */
     readonly spawnProcess?: (executable: string, args: readonly string[]) => CodexUsageProcess;
     /** Text of the newest Codex rollout-*.jsonl, undefined when none. */
     readonly readCodexLatestRollout?: (signal: AbortSignal) => Promise<string | undefined>;
     /** One read-only GET; used only by the credential fallbacks. */
     readonly fetchJson?: UsageFetchJson;
     /** Stored-credential readers; never invoked unless isTrusted() is true. */
     readonly credentials?: {
       readonly claude?: UsageCredentialRead;     // <claude config>/.credentials.json text
       readonly codex?: UsageCredentialRead;      // $CODEX_HOME/auth.json text
       readonly opencodeGo?: UsageCredentialRead; // ~/.local/share/opencode/auth.json text
     };
     /** Live workspace-trust flag. Default () => false (fail closed). */
     readonly isTrusted?: () => boolean;
     /** Diagnostics; every message is passed through redactSecrets. */
     readonly log?: (message: string) => void;
   }
   ```
   Also export `USAGE_TOOL_CLI: Readonly<Partial<Record<UsageToolId, UsageCliName>>> = { claude: 'claude', codex: 'codex', antigravity: ANTIGRAVITY_USAGE_BIN as UsageCliName }` (opencode-go has no CLI route). Add a short doc comment at the top of the section saying the table is built lazily: constructing it resolves, spawns and reads nothing.

   Files: `src/usage/index.ts`

2. Implement createUsageReaders(seams) in src/usage/index.ts

   Export `function createUsageReaders(seams: UsageReaderTableSeams = {}): Readonly<Record<UsageToolId, UsageReader>>`. Construction must not call any seam. Private helpers inside the function:
   - `isTrusted(): boolean` → `try { return seams.isTrusted?.() === true; } catch { return false; }` (missing or throwing = untrusted).
   - `log(m: string)` → `try { seams.log?.(redactSecrets(m)); } catch { /* never throws */ }`.
   - `notFound(cli)` → `Object.assign(new Error(`${cli} was not found on PATH`), { code: 'ENOENT' })` (claude/codex/antigravity readers already map code 'ENOENT' to a '<cli> was not found on PATH' reason).
   - `resolve(cli): string | undefined` → if `seams.resolveExecutable` is absent return the bare `cli` name (spawn does the PATH walk); else `try { const p = seams.resolveExecutable(cli); return typeof p === 'string' && p.trim() ? p.trim() : undefined; } catch { return undefined; }`.
   - `runCliFor(cli)` → `seams.runCommand ? async (args, signal, timeoutMs) => { const exe = resolve(cli); if (!exe) throw notFound(cli); return seams.runCommand!(exe, args, signal, timeoutMs); } : undefined`. Resolution therefore happens only at read time.
   - `spawnCodexAppServer` → `seams.spawnProcess ? () => { const exe = resolve('codex'); if (!exe) throw notFound('codex'); return seams.spawnProcess!(exe, [CODEX_USAGE_APP_SERVER_SUBCOMMAND]); } : undefined` (readCodexAppServerRateLimits calls spawn synchronously inside a try and maps ENOENT).
   - `guardCredential(read?: UsageCredentialRead)` → `read ? async () => { if (!isTrusted()) throw new Error('Restricted Mode: Baiton does not read stored credentials.'); return read(); } : undefined` (belt-and-braces if trust is revoked mid-read; the message contains no token).
   - `guardedFetch` → same pattern around `seams.fetchJson` (fetch is only ever used with a credential), throwing the same Restricted Mode error when untrusted.
   - `withTrust(reader: UsageReader): UsageReader` → `(ctx: UsageReadContext) => reader({ ...ctx, trusted: ctx.trusted === true && isTrusted() })`. This is the primary gate: every built-in reader already checks `ctx.trusted` before touching its credential seam and pushes a 'Restricted Mode: Baiton does not read the stored <tool> login.' reason, so with trusted=false the credential seams and fetch are never invoked and the row says why.

   Build the per-tool builders:
   ```ts
   const build: Record<UsageToolId, () => UsageReader> = {
     claude: () => createClaudeUsageReader({ runCli: runCliFor('claude'), readCredentials: guardCredential(seams.credentials?.claude), fetchJson: guardedFetch, log }),
     codex: () => createCodexUsageReader({ spawnAppServer: spawnCodexAppServer, readLatestRollout: seams.readCodexLatestRollout, readAuthFile: guardCredential(seams.credentials?.codex), fetchJson: guardedFetch, log }),
     antigravity: () => createAntigravityUsageReader({ runCli: runCliFor('agy'), log }),
     'opencode-go': () => createOpencodeGoUsageReader({ readAuthFile: guardCredential(seams.credentials?.opencodeGo), fetchJson: guardedFetch, log }),
   };
   ```
   Then insert in the fixed display order: `const table = {} as Record<UsageToolId, UsageReader>; for (const tool of USAGE_TOOL_IDS) table[tool] = withTrust(build[tool]()); return Object.freeze(table);` so `Object.keys(table)` equals USAGE_TOOL_IDS. Pass each seam through as `undefined` when absent (readers treat a missing seam as 'not wired'). If TypeScript complains about the codex/opencode fetchJson parameter name differences (`init` vs `options`) or the optional `headers` on the response, the UsageFetchJson shape above is structurally assignable to both; adjust only the local type, never the reader modules. Do not edit claude.ts/codex.ts/antigravity.ts/opencode.ts/usageService.ts.

   Files: `src/usage/index.ts`

3. Write test/usage.credentials.test.ts: harness

   Mocha + `assert` like the other usage tests (ts-node via .mocharc; `import * as assert from 'assert'; import * as fs from 'fs'; import * as path from 'path';`). Import from '../src/usage/index': createUsageReaders, UsageService, redactSecrets, USAGE_TOOL_IDS, CLAUDE_OAUTH_USAGE_URL, CODEX_WHAM_USAGE_URL, OPENCODE_GO_USAGE_URL, CLAUDE_USAGE_CLI_ARGS, ANTIGRAVITY_USAGE_CLI_ARGS, CODEX_USAGE_APP_SERVER_SUBCOMMAND, types UsageReaderTableSeams, UsageReading, UsageReadContext, UsageFetchResponse.

   Constants:
   - `const SENTINEL = 'tok-SENTINEL-q7Zx';` — deliberately short (<32 chars) and without a known prefix so redactSecrets' catch-all does NOT hide a raw leak. First test asserts `redactSecrets(SENTINEL) === SENTINEL` so the suite proves the readers never place the raw token anywhere rather than relying on the catch-all.
   - `NOW = Date.parse('2026-10-09T12:00:00Z')`.
   - Credential texts: claude `JSON.stringify({ claudeAiOauth: { accessToken: SENTINEL, expiresAt: NOW + 3_600_000, subscriptionType: 'max' } })`; codex `JSON.stringify({ tokens: { access_token: SENTINEL, account_id: 'acct-fixture' } })`; opencode `JSON.stringify({ 'opencode-go': { type: 'api', key: SENTINEL } })`.
   - 200 bodies from existing fixtures: test/fixtures/usage/claude/oauth-usage.json (CLAUDE_OAUTH_USAGE_URL), test/fixtures/usage/codex/wham.json (CODEX_WHAM_USAGE_URL), test/fixtures/usage/opencode/endpoint-usage.json (OPENCODE_GO_USAGE_URL), keyed by URL.
   - `ctx(over)` → `{ signal: new AbortController().signal, trusted: true, now: () => NOW, timeoutMs: 5000, ...over }`.

   `harness(fetchMode, over?: Partial<UsageReaderTableSeams>)` returns `{ seams, calls }` where calls records: `resolve: string[]`, `run: Array<{exe,args}>`, `spawn: Array<{exe,args}>`, `rollout: number`, `cred: { claude: number; codex: number; opencodeGo: number }`, `fetch: Array<{ url; headers }>`, `logs: string[]`. Default seams: `resolveExecutable` records and returns undefined (so CLI routes fail with 'not found' and every reader falls through to its fallback); `runCommand` rejects with `new Error('cli auth failed Bearer ' + SENTINEL)`; `spawnProcess` throws; `readCodexLatestRollout` returns undefined; credentials return the texts above and count calls; `isTrusted: () => true`; `log` pushes. `fetchJson` records then behaves per `fetchMode`:
     - 'ok': status 200, body = fixture for the URL plus `{ echo: SENTINEL, access_token: SENTINEL }` spread in (unknown fields must be dropped).
     - 'http401': status 401, body `{ error: 'invalid token ' + SENTINEL }`.
     - 'rejectBearer': reject `new Error('request failed: Authorization: ' + headers.Authorization)`.
     - 'rejectJson': reject `new Error(JSON.stringify({ access_token: SENTINEL }))`.
     - 'oddShape': status 200, body `{ data: SENTINEL, token: SENTINEL }`.
     - 'throwSync': throw synchronously `new Error('Bearer ' + SENTINEL)`.
   Helper `assertNoSentinel(label, value: unknown)` → `assert.ok(!JSON.stringify(value ?? null).includes(SENTINEL), label)`; for strings check `.includes` directly.

   No usage webview protocol module exists in src/usage yet; model the serialized protocol message as `JSON.stringify({ type: 'usage/readings', readings })` built from UsageService snapshots. If, at execution time, a protocol module with a message builder exists under src/usage (e.g. src/usage/protocol.ts), use its builder + JSON.stringify instead.

   Files: `test/usage.credentials.test.ts`

4. Write test/usage.credentials.test.ts: redaction cases

   describe('usage credential redaction'):
   1. 'sentinel is not masked by redactSecrets' (precondition above).
   2. For each fetchMode in ['ok','http401','rejectBearer','rejectJson','oddShape','throwSync'] (generate `it` per mode): build `createUsageReaders(h.seams)`, call every reader in USAGE_TOOL_IDS order with `ctx()`; collect readings. Then assert:
      - non-vacuous: `calls.cred.claude, codex, opencodeGo` are each 1; `calls.fetch.length === 3`; every recorded fetch has `headers.Authorization === 'Bearer ' + SENTINEL` (the token really flowed) and `!url.includes(SENTINEL)`.
      - every reading: `assertNoSentinel` on the whole JSON, and when unavailable/stale its `reason` is non-empty and lacks SENTINEL.
      - every `calls.logs` entry lacks SENTINEL.
      - for 'ok': claude, codex and opencode-go are status 'ok' with `source.mechanism === 'provider-endpoint'`; JSON has no 'echo' key.
      - for the error modes: those three are 'unavailable' with mechanism 'provider-endpoint'.
   3. Same matrix through the service: `const snaps: string[] = []; const svcLogs: string[] = []; const svc = new UsageService({ readers: createUsageReaders(h.seams), isTrusted: () => true, now: () => NOW, timeoutMs: 5000, log: (m) => svcLogs.push(m) }); svc.onDidChange((r) => snaps.push(JSON.stringify({ type: 'usage/readings', readings: r }))); await svc.refresh();` then assert snapshot JSON, every snaps entry, svcLogs and h.calls.logs lack SENTINEL; `svc.dispose()` at end.
   4. Stale path: one mutable `mode` variable read by fetchJson; first refresh with 'ok' (three ok rows), switch to 'rejectBearer', refresh again → claude/codex/opencode-go are 'stale', their `reason` and the whole serialized message lack SENTINEL.
   5. Antigravity has no credential route: with resolveExecutable returning '/opt/bin/agy' and runCommand rejecting with a Bearer-SENTINEL error, its reading is unavailable, reason lacks SENTINEL, and no credential seam was invoked by it (run it alone and assert cred counters stay 0 and fetch length 0).

   Files: `test/usage.credentials.test.ts`

5. Write test/usage.credentials.test.ts: Restricted Mode, table shape, resolution

   describe('usage Restricted Mode'):
   - table untrusted (`isTrusted: () => false`) with ctx trusted true: run all four readers → `calls.cred` all 0, `calls.fetch.length === 0`; claude, codex, opencode-go readings are unavailable and `reason.includes('Restricted Mode')`.
   - table trusted but service untrusted: `new UsageService({ readers: createUsageReaders({...seams, isTrusted: () => true}), isTrusted: () => false, now: () => NOW })`, `await svc.refresh()` → same zero counts and 'Restricted Mode' reasons in `svc.snapshot()`.
   - isTrusted omitted → fail closed (zero credential/fetch calls, 'Restricted Mode').
   - isTrusted throws → treated as untrusted, same assertions, and the reader still resolves (never throws).
   - untrusted but CLI route works: resolveExecutable returns '/opt/bin/claude', runCommand resolves with the claude CLI fixture stdout (test/fixtures/usage/claude/cli-usage.json) → claude is 'ok' via 'cli-command' while credential counters stay 0 (Restricted Mode only blocks credential reads, not the CLI).

   describe('usage reader table'):
   - `Object.keys(createUsageReaders({}))` deepStrictEqual `[...USAGE_TOOL_IDS]`, and the result is frozen.
   - construction is inert: build with a full harness, assert every counter (resolve, run, spawn, rollout, cred, fetch) is 0 before any read; also after `new UsageService({ readers })` with no refresh.
   - empty seams: each reader resolves an 'unavailable' reading for its own tool with a non-empty reason.
   - resolution happens at read time and is used: resolveExecutable returns `'/opt/bin/' + cli`; runCommand records → claude call is `{ exe: '/opt/bin/claude', args: CLAUDE_USAGE_CLI_ARGS }`, antigravity `{ exe: '/opt/bin/agy', args: ANTIGRAVITY_USAGE_CLI_ARGS }`; spawnProcess records then throws → codex spawn call is `{ exe: '/opt/bin/codex', args: [CODEX_USAGE_APP_SERVER_SUBCOMMAND] }`.
   - unresolved executable: resolveExecutable returns undefined (trusted false so nothing else succeeds) → runCommand/spawnProcess never called, and claude/codex/antigravity reasons include 'not found on PATH'.
   - host-free: read src/usage/index.ts with fs; every `import`/`export … from` line targets a `'./…'` specifier and no line mentions 'vscode', 'fs', 'child_process' or '../' (mirror the 'stays host-free' check in test/usage.service.test.ts).

   Files: `test/usage.credentials.test.ts`

6. Verify

   Run `npm run compile`, `npm run lint` (expect only the pre-existing warning in src/orchestrator/webviewProtocol.ts) and `npm test` (or `npx mocha test/usage.credentials.test.ts` first, then the full suite). Fix any failure in index.ts or the new test only; if a test reveals a real leak in a reader, report it rather than weakening the assertion.

   Files: `src/usage/index.ts`, `test/usage.credentials.test.ts`

## Risks

- A sentinel of 32+ chars or with a known prefix (sk-, eyJ…) would be masked by redactSecrets' catch-all and make the leak test vacuous; keep the short neutral sentinel and the precondition assertion.
- Antigravity has no credential fallback (T05 found none), so the 'every reader's credential fallback' requirement is covered for claude, codex and opencode-go; antigravity is checked only for no credential/fetch calls and CLI-error redaction, and its untrusted reason does not mention Restricted Mode because it blocks nothing.
- No usage webview protocol module exists yet; the test models the serialized message as JSON.stringify of the service snapshot. A later protocol todo should reuse or extend this test with its real message builder.
- Two trust inputs exist (UsageService.isTrusted → ctx.trusted, and the table's isTrusted); withTrust ANDs them so either being false blocks credential reads. Host wiring must pass vscode.workspace.isTrusted to both.
- Codex app-server reads use a real setTimeout inside readCodexAppServerRateLimits; tests must make spawnProcess throw (not return a hanging fake process) to avoid waiting on its budget.
- If resolveExecutable is omitted the bare CLI name is used, so spawn's own PATH lookup applies; host wiring should always supply the settings-aware resolver from src/activation/executable.ts.
- Type mismatch between the readers' fetchJson parameter shapes could need a local cast; do not change the reader modules to fix it.

## Acceptance

- src/usage/index.ts exports createUsageReaders and UsageReaderTableSeams (plus UsageCliName, UsageCommandResult, UsageFetchResponse, UsageFetchJson, UsageCredentialRead, USAGE_TOOL_CLI) and still re-exports model, usageService, codex, claude, antigravity, opencode.
- src/usage/index.ts imports only from './…' modules: no vscode, no Node built-ins, no ../adapter.
- Object.keys(createUsageReaders(seams)) equals USAGE_TOOL_IDS (claude, codex, antigravity, opencode-go) and constructing the table calls no seam.
- With the table's isTrusted false, missing, or throwing, or with ctx.trusted false, no credential seam and no fetchJson is invoked, and the claude, codex and opencode-go rows are unavailable with a reason containing 'Restricted Mode'.
- test/usage.credentials.test.ts feeds a sentinel token through the claude, codex and opencode-go credential fallbacks (proving it reached the Authorization header) and asserts it appears in no reading, reason, reader log argument, service log argument or serialized protocol message across ok, HTTP error, rejected, odd-shape, sync-throw and stale paths.
- Executable resolution happens only inside a read; resolved paths are passed to runCommand/spawnProcess, and an unresolved CLI gives a 'not found on PATH' reason without spawning.
- npm run compile, npm run lint (no new warnings) and npm test pass.
