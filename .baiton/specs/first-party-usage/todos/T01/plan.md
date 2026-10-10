# Plan T01

## Steps

1. Create src/usage/model.ts: module header and tool ids

   New file. Start with a JSDoc header in the style of src/model/runTreeModel.ts / src/config/configPanel.ts: 'Host-free usage reading model for the Usage view (baiton.usageView) — spec first-party-usage, todo T01. Carries no vscode import, no Node built-in import and does no I/O; every function is total (never throws).' The module must import NOTHING (no vscode, no node built-ins, no other src modules) so later readers, the UsageService and the webview protocol can all depend on it.

   Exports:
   - `export const USAGE_TOOL_IDS = ['claude', 'codex', 'antigravity', 'opencode-go'] as const;` — this array IS the fixed display order.
   - `export type UsageToolId = typeof USAGE_TOOL_IDS[number];`
   - `export const USAGE_TOOL_LABELS: Readonly<Record<UsageToolId, string>> = { claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity', 'opencode-go': 'OpenCode Go' };`
   - `export function isUsageToolId(value: unknown): value is UsageToolId` (typeof string && USAGE_TOOL_IDS.includes).
   - `export function compareToolOrder(a: UsageToolId, b: UsageToolId): number` (index difference) and `export function sortReadings<T extends { readonly tool: UsageToolId }>(items: readonly T[]): T[]` returning a new array in USAGE_TOOL_IDS order (stable, does not mutate input).
   Note: these ids are deliberately distinct from `AgentId` in src/adapter/adapter.ts ('opencode' vs 'opencode-go'); do not import AgentId.

   Files: `src/usage/model.ts`

2. Define source/provenance/status types

   In src/usage/model.ts add:
   - `export type UsageStatus = 'ok' | 'stale' | 'unavailable';` and `export const USAGE_STATUSES: readonly UsageStatus[] = ['ok', 'stale', 'unavailable'] as const;`
   - `export type UsageProvenance = 'provider-reported' | 'baiton-derived';` (provider-reported = figure came verbatim from the CLI/provider; baiton-derived = Baiton computed it, e.g. summed local logs).
   - `export type UsageMechanism = 'cli-command' | 'cli-server' | 'cli-files' | 'provider-endpoint';` with a JSDoc per member (CLI subcommand; the CLI's own server such as `codex app-server` / `opencode serve`; files the CLI writes itself; provider account endpoint using a credential the CLI already stored — fallback only).
   - `export const USAGE_MECHANISM_LABELS: Readonly<Record<UsageMechanism, string>>` (e.g. 'CLI command', 'CLI server', 'CLI files', 'Provider account endpoint').
   - `export interface UsageSource { readonly mechanism: UsageMechanism; readonly detail: string; /* human description, e.g. 'codex app-server account/rateLimits/read' — never contains a credential */ readonly provenance: UsageProvenance; readonly readAt: number; /* epoch ms from the injected clock */ }`
   All timestamps in the model are epoch milliseconds (numbers) so readings are JSON-serialisable for the webview and comparable against an injected clock.

   Files: `src/usage/model.ts`

3. Define window and reading types

   In src/usage/model.ts add:
   - `export interface UsageRawNumbers { readonly used?: number; readonly limit?: number; readonly remaining?: number; readonly unit?: string; }` — the source's own numbers, kept verbatim when no percent is given.
   - `export interface UsageScope { readonly model?: string; readonly plan?: string; }`
   - `export interface UsageWindow { readonly id: string; /* stable key, e.g. 'five-hour', 'weekly' */ readonly label: string; /* e.g. '5-hour', 'Weekly (Opus)' */ readonly usedPercent?: number; /* 0..100, ONLY when the source gives a percentage */ readonly raw?: UsageRawNumbers; readonly resetsAt?: number; /* epoch ms */ readonly scope?: UsageScope; readonly provenance: UsageProvenance; }`
   - Reading as a discriminated union on `status`:
     `interface UsageReadingBase { readonly tool: UsageToolId; }`
     `export interface OkUsageReading extends UsageReadingBase { readonly status: 'ok'; readonly windows: readonly UsageWindow[]; readonly tier?: string; /* account tier/plan name as the source reports it */ readonly source: UsageSource; }`
     `export interface StaleUsageReading extends Omit<OkUsageReading, 'status'> { readonly status: 'stale'; readonly reason: string; /* why the latest read failed */ readonly failedAt: number; /* epoch ms of the failed read */ }` (age is derived via `readingAgeMs`, not stored).
     `export interface UnavailableUsageReading extends UsageReadingBase { readonly status: 'unavailable'; readonly reason: string; /* non-empty */ readonly checkedAt: number; readonly mechanism?: UsageMechanism; /* last mechanism attempted, if any */ }`
     `export type UsageReading = OkUsageReading | StaleUsageReading | UnavailableUsageReading;`
   There must be NO field anywhere in these types that could hold a token/credential (no `headers`, `token`, `auth`, free-form `extra`). Document this in the type JSDoc: credentials never enter a reading.

   Files: `src/usage/model.ts`

4. Add total constructor/normaliser helpers

   In src/usage/model.ts add pure, never-throwing helpers:
   - `export const USAGE_REASON_MAX_CHARS = 300;` and `export const DEFAULT_UNAVAILABLE_REASON = 'No usage source is available.';`
   - `export function normaliseReason(reason: unknown, fallback = DEFAULT_UNAVAILABLE_REASON): string` — String-coerce only strings (non-strings -> fallback), collapse whitespace/newlines to single spaces, trim, cut to USAGE_REASON_MAX_CHARS with a trailing '…'; empty result -> fallback (fallback itself is trimmed and, if empty, DEFAULT_UNAVAILABLE_REASON). Guarantees the 'non-empty reason' invariant.
   - `export function normalisePercent(value: unknown): number | undefined` — returns undefined for non-number / NaN / non-finite; otherwise clamps to [0, 100].
   - `export function normaliseWindow(w: UsageWindow): UsageWindow` — runs usedPercent through normalisePercent (dropping the key when undefined), drops non-finite raw numbers and non-finite resetsAt, keeps everything else.
   - `export function okReading(tool: UsageToolId, source: UsageSource, windows: readonly UsageWindow[], tier?: string): UsageReading` — returns an OkUsageReading with normalised windows; if `windows` is empty after normalisation return `unavailableReading(tool, 'The source returned no usage windows.', source.readAt, source.mechanism)` instead (never an empty 'ok' row). Omit `tier` when undefined/blank.
   - `export function unavailableReading(tool: UsageToolId, reason: unknown, checkedAt: number, mechanism?: UsageMechanism): UnavailableUsageReading` — reason via normaliseReason; omit `mechanism` key when undefined.
   - `export function staleReading(last: OkUsageReading | StaleUsageReading, reason: unknown, failedAt: number): StaleUsageReading` — copies tool/windows/tier/source from `last` (the source.readAt therefore stays the time of the last GOOD read), status 'stale', normalised reason, failedAt.
   - `export function readingAgeMs(reading: UsageReading, now: number): number | undefined` — for ok/stale: max(0, now - source.readAt); for unavailable: undefined.
   - `export function lastGood(reading: UsageReading | undefined): OkUsageReading | StaleUsageReading | undefined` — returns the reading when status is ok or stale.
   - `export function barPercent(window: UsageWindow): number | undefined` — returns window.usedPercent (normalised) or undefined; a bar is drawn only when this is defined. Never derive a percent from raw numbers here.
   - `export function remainingPercent(window: UsageWindow): number | undefined` — 100 - barPercent, or undefined.
   - `export function isBaitonDerived(reading: UsageReading): boolean` — true when status is ok/stale and (source.provenance === 'baiton-derived' or any window.provenance === 'baiton-derived').
   Keep each helper short with a one-line JSDoc, matching the comment density of src/model/runTreeModel.ts.

   Files: `src/usage/model.ts`

5. Add src/usage/index.ts barrel

   Create `src/usage/index.ts` with a short header comment ('Host-free usage core — see model.ts.') and `export * from './model';`. Later todos add readers/service/protocol exports here. Must not import vscode.

   Files: `src/usage/index.ts`

6. Unit tests for the model

   Create `test/usage.model.test.ts` (mocha + `import * as assert from 'assert'`, same style as test/runTreeModel.test.ts; imports from '../src/usage/model'). Cases:
   1. USAGE_TOOL_IDS deepStrictEquals ['claude','codex','antigravity','opencode-go']; USAGE_TOOL_LABELS maps to 'Claude Code','Codex','Antigravity','OpenCode Go'; isUsageToolId accepts each, rejects 'opencode', '', 42, undefined.
   2. sortReadings orders a shuffled array of unavailable readings into display order and does not mutate the input.
   3. normaliseReason: '' / '   ' / undefined / 7 -> DEFAULT_UNAVAILABLE_REASON; 'a\n  b' -> 'a b'; 1000-char string -> length USAGE_REASON_MAX_CHARS ending in '…'; custom fallback used when blank.
   4. normalisePercent: NaN/Infinity/'50'/undefined -> undefined; -5 -> 0; 150 -> 100; 42.5 -> 42.5.
   5. okReading with one window carrying usedPercent 120 -> status 'ok', window usedPercent 100; okReading with [] -> status 'unavailable' with non-empty reason, checkedAt === source.readAt, mechanism copied.
   6. staleReading from an ok reading: status 'stale', windows/source/tier identical, source.readAt unchanged, failedAt set, blank reason -> non-empty; readingAgeMs(stale, readAt + 5000) === 5000; readingAgeMs of a future readAt clamps to 0; readingAgeMs(unavailable) === undefined.
   7. barPercent: window with only raw {used: 10, limit: 50} -> undefined (no derived bar); with usedPercent 30 -> 30; remainingPercent -> 70.
   8. isBaitonDerived: false for provider-reported source+windows; true when source.provenance is 'baiton-derived'; true when one window is 'baiton-derived'; false for unavailable.
   9. Every reading constructed above survives JSON.parse(JSON.stringify(r)) deepStrictEqual (JSON-safe for the webview), and its JSON contains no key named token/authorization/apiKey/credential (Object key walk).
   10. Host-free guard: read `src/usage/model.ts` with fs.readFileSync (path via path.join(__dirname, '..', 'src', 'usage', 'model.ts')) and assert it has no `import`/`require` statements at all (regex /^\s*import\s|require\(/m does not match) — in particular no 'vscode'.

   Files: `test/usage.model.test.ts`

7. Verify

   Run `npm run compile`, `npm run lint` (no new warnings in src/usage or test/usage.model.test.ts; types PascalCase), and `npm test` (or `npx mocha test/usage.model.test.ts` first for quick iteration). Do not touch package.json, media/, src/activation or README in this todo — those belong to later todos.

   Files: (none)

## Risks

- The todo text in the brief is truncated after 'A reading type that carries:'; the field list here is reconstructed from the OVERVIEW (windows, percent or raw numbers, reset time, model/plan scope, account tier, mechanism + provenance + read time, status ok|stale|unavailable with non-empty reason). Later todos may want a slightly different shape; keeping it a discriminated union with total constructors makes extension cheap.
- Tool id 'opencode-go' differs from AgentId 'opencode' in src/adapter/adapter.ts; later wiring must map explicitly rather than assume identity.
- Storing usedPercent (not remaining) means sources that report remaining percent must convert (100 - x) in their reader; that is arithmetic on a provider-given percentage, still provider-reported — readers must not label it baiton-derived, and must never fill usedPercent from raw used/limit unless they mark the window baiton-derived.
- The host-free guard test asserts zero imports in model.ts; if a later todo legitimately adds a type-only import from a sibling usage module it must relax the regex to forbid only 'vscode' and node built-ins.
- Timestamps are epoch ms numbers; the webview must format them itself — no Date objects should be placed in readings or JSON round-trip equality breaks.

## Acceptance

- src/usage/model.ts exists, has no import/require statements, and exports USAGE_TOOL_IDS = ['claude','codex','antigravity','opencode-go'], UsageToolId, USAGE_TOOL_LABELS, UsageStatus, UsageProvenance, UsageMechanism, UsageSource, UsageWindow, UsageReading (ok/stale/unavailable union) and the helpers okReading, unavailableReading, staleReading, normaliseReason, normalisePercent, readingAgeMs, lastGood, barPercent, remainingPercent, isBaitonDerived, sortReadings, isUsageToolId.
- Stale and unavailable readings always carry a non-empty reason; okReading with no windows yields unavailable, never an empty ok.
- barPercent returns a value only when the source supplied usedPercent; it never derives one from raw numbers.
- No reading type has a field capable of carrying a credential; readings round-trip through JSON unchanged.
- src/usage/index.ts re-exports the model.
- test/usage.model.test.ts covers the cases listed and passes.
- npm run compile, npm run lint and npm test all pass.
