/**
 * Host-free usage reading model for the Usage view (baiton.usageView) — spec
 * first-party-usage, todo T01. Carries no vscode import, no Node built-in
 * import and does no I/O; every function is total (never throws).
 *
 * This module deliberately depends on nothing so later readers, the
 * UsageService and the webview protocol can all build on it. All timestamps
 * are epoch milliseconds (numbers) so readings are JSON-serialisable and
 * comparable against an injected clock.
 */

// --- Tools -------------------------------------------------------------------

/** The tools the Usage view reports on; this array IS the fixed display order. */
export const USAGE_TOOL_IDS = ['claude', 'codex', 'antigravity', 'opencode-go'] as const;

/**
 * A usage tool id. Deliberately distinct from `AgentId` in src/adapter/adapter.ts
 * ('opencode' vs 'opencode-go'); wiring must map explicitly.
 */
export type UsageToolId = typeof USAGE_TOOL_IDS[number];

/** Human labels for each tool. */
export const USAGE_TOOL_LABELS: Readonly<Record<UsageToolId, string>> = {
  claude: 'Claude Code',
  codex: 'Codex',
  antigravity: 'Antigravity',
  'opencode-go': 'OpenCode Go',
};

/** True when `value` is one of the known usage tool ids. */
export function isUsageToolId(value: unknown): value is UsageToolId {
  return typeof value === 'string' && (USAGE_TOOL_IDS as readonly string[]).includes(value);
}

/** Orders two tool ids by the fixed display order. */
export function compareToolOrder(a: UsageToolId, b: UsageToolId): number {
  return USAGE_TOOL_IDS.indexOf(a) - USAGE_TOOL_IDS.indexOf(b);
}

/** A new array of `items` in display order (stable; the input is not mutated). */
export function sortReadings<T extends { readonly tool: UsageToolId }>(items: readonly T[]): T[] {
  return [...items].sort((x, y) => compareToolOrder(x.tool, y.tool));
}

// --- Source and provenance ---------------------------------------------------

/** Whether a reading is ok, kept from an earlier good read, or has no data. */
export type UsageStatus = 'ok' | 'stale' | 'unavailable';

/** Every status, in a stable order. */
export const USAGE_STATUSES: readonly UsageStatus[] = ['ok', 'stale', 'unavailable'] as const;

/**
 * Where a figure came from: `provider-reported` came verbatim from the
 * CLI/provider; `baiton-derived` was computed by Baiton (e.g. summed local logs).
 */
export type UsageProvenance = 'provider-reported' | 'baiton-derived';

/** How a reading was obtained. */
export type UsageMechanism =
  /** A CLI subcommand. */
  | 'cli-command'
  /** The CLI's own server, such as `codex app-server` or `opencode serve`. */
  | 'cli-server'
  /** Files the CLI writes itself. */
  | 'cli-files'
  /** A provider account endpoint using a credential the CLI already stored — fallback only. */
  | 'provider-endpoint';

/** Human labels for each mechanism. */
export const USAGE_MECHANISM_LABELS: Readonly<Record<UsageMechanism, string>> = {
  'cli-command': 'CLI command',
  'cli-server': 'CLI server',
  'cli-files': 'CLI files',
  'provider-endpoint': 'Provider account endpoint',
};

/** Provenance of one successful read. Never contains a credential. */
export interface UsageSource {
  readonly mechanism: UsageMechanism;
  /** Human description, e.g. 'codex app-server account/rateLimits/read'. */
  readonly detail: string;
  readonly provenance: UsageProvenance;
  /** Epoch ms from the injected clock. */
  readonly readAt: number;
}

// --- Windows and readings ----------------------------------------------------

/** The source's own numbers, kept verbatim when no percent is given. */
export interface UsageRawNumbers {
  readonly used?: number;
  readonly limit?: number;
  readonly remaining?: number;
  readonly unit?: string;
}

/** What a window applies to. */
export interface UsageScope {
  readonly model?: string;
  readonly plan?: string;
}

/** One usage window (e.g. a 5-hour or weekly allowance). */
export interface UsageWindow {
  /** Stable key, e.g. 'five-hour', 'weekly'. */
  readonly id: string;
  /** Display label, e.g. '5-hour', 'Weekly (Opus)'. */
  readonly label: string;
  /** 0..100, ONLY when the source gives a percentage. */
  readonly usedPercent?: number;
  readonly raw?: UsageRawNumbers;
  /** Epoch ms. */
  readonly resetsAt?: number;
  readonly scope?: UsageScope;
  readonly provenance: UsageProvenance;
}

interface UsageReadingBase {
  readonly tool: UsageToolId;
}

/**
 * A good read. Credentials never enter a reading: no type here has a field
 * that could hold a token, header or free-form extra data.
 */
export interface OkUsageReading extends UsageReadingBase {
  readonly status: 'ok';
  readonly windows: readonly UsageWindow[];
  /** Account tier/plan name as the source reports it. */
  readonly tier?: string;
  readonly source: UsageSource;
}

/** The last good read, kept after a later read failed. */
export interface StaleUsageReading extends Omit<OkUsageReading, 'status'> {
  readonly status: 'stale';
  /** Why the latest read failed. */
  readonly reason: string;
  /** Epoch ms of the failed read. Age is derived via `readingAgeMs`, not stored. */
  readonly failedAt: number;
}

/** No data at all. */
export interface UnavailableUsageReading extends UsageReadingBase {
  readonly status: 'unavailable';
  /** Always non-empty. */
  readonly reason: string;
  readonly checkedAt: number;
  /** Last mechanism attempted, if any. */
  readonly mechanism?: UsageMechanism;
}

/** A tool's usage reading, discriminated on `status`. */
export type UsageReading = OkUsageReading | StaleUsageReading | UnavailableUsageReading;

// --- Normalisers and constructors --------------------------------------------

export const USAGE_REASON_MAX_CHARS = 300;
export const DEFAULT_UNAVAILABLE_REASON = 'No usage source is available.';

/** A single-line, trimmed, length-capped, never-empty reason. */
export function normaliseReason(reason: unknown, fallback: string = DEFAULT_UNAVAILABLE_REASON): string {
  const safeFallback = typeof fallback === 'string' && fallback.trim() ? fallback.trim() : DEFAULT_UNAVAILABLE_REASON;
  if (typeof reason !== 'string') return safeFallback;
  const text = reason.replace(/\s+/g, ' ').trim();
  if (!text) return safeFallback;
  return text.length > USAGE_REASON_MAX_CHARS ? `${text.slice(0, USAGE_REASON_MAX_CHARS - 1)}…` : text;
}

/** A finite number clamped to 0..100, else undefined. */
export function normalisePercent(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(100, Math.max(0, value));
}

function finiteOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** A copy of `w` with a clamped percent and no non-finite numbers. */
export function normaliseWindow(w: UsageWindow): UsageWindow {
  const { usedPercent, raw, resetsAt, ...rest } = w;
  const out: { -readonly [K in keyof UsageWindow]: UsageWindow[K] } = { ...rest };
  const percent = normalisePercent(usedPercent);
  if (percent !== undefined) out.usedPercent = percent;
  if (raw) {
    const cleaned: { -readonly [K in keyof UsageRawNumbers]: UsageRawNumbers[K] } = {};
    for (const key of ['used', 'limit', 'remaining'] as const) {
      const n = finiteOrUndefined(raw[key]);
      if (n !== undefined) cleaned[key] = n;
    }
    if (typeof raw.unit === 'string') cleaned.unit = raw.unit;
    out.raw = cleaned;
  }
  const reset = finiteOrUndefined(resetsAt);
  if (reset !== undefined) out.resetsAt = reset;
  return out;
}

/** An unavailable reading with a guaranteed non-empty reason. */
export function unavailableReading(
  tool: UsageToolId,
  reason: unknown,
  checkedAt: number,
  mechanism?: UsageMechanism,
): UnavailableUsageReading {
  const base: UnavailableUsageReading = { tool, status: 'unavailable', reason: normaliseReason(reason), checkedAt };
  return mechanism === undefined ? base : { ...base, mechanism };
}

/** An ok reading; with no windows it is unavailable instead, never an empty ok. */
export function okReading(
  tool: UsageToolId,
  source: UsageSource,
  windows: readonly UsageWindow[],
  tier?: string,
): UsageReading {
  const normalised = windows.map(normaliseWindow);
  if (normalised.length === 0) {
    return unavailableReading(tool, 'The source returned no usage windows.', source.readAt, source.mechanism);
  }
  const base: OkUsageReading = { tool, status: 'ok', windows: normalised, source };
  const trimmedTier = typeof tier === 'string' ? tier.trim() : '';
  return trimmedTier ? { ...base, tier: trimmedTier } : base;
}

/** The last good reading marked stale; source.readAt stays the last good read time. */
export function staleReading(
  last: OkUsageReading | StaleUsageReading,
  reason: unknown,
  failedAt: number,
): StaleUsageReading {
  const stale: StaleUsageReading = {
    tool: last.tool,
    status: 'stale',
    windows: last.windows,
    source: last.source,
    reason: normaliseReason(reason, 'The latest usage read failed.'),
    failedAt,
  };
  return last.tier === undefined ? stale : { ...stale, tier: last.tier };
}

// --- Queries -----------------------------------------------------------------

/** Milliseconds since the last good read, or undefined when there is none. */
export function readingAgeMs(reading: UsageReading, now: number): number | undefined {
  if (reading.status === 'unavailable') return undefined;
  return Math.max(0, now - reading.source.readAt);
}

/** The reading when it holds data (ok or stale), else undefined. */
export function lastGood(reading: UsageReading | undefined): OkUsageReading | StaleUsageReading | undefined {
  return reading && reading.status !== 'unavailable' ? reading : undefined;
}

/** The source-given used percent; never derived from raw numbers. */
export function barPercent(window: UsageWindow): number | undefined {
  return normalisePercent(window.usedPercent);
}

/** 100 minus the bar percent, or undefined when there is no bar. */
export function remainingPercent(window: UsageWindow): number | undefined {
  const used = barPercent(window);
  return used === undefined ? undefined : 100 - used;
}

/** True when Baiton computed the source or any window itself. */
export function isBaitonDerived(reading: UsageReading): boolean {
  if (reading.status === 'unavailable') return false;
  return (
    reading.source.provenance === 'baiton-derived' ||
    reading.windows.some((w) => w.provenance === 'baiton-derived')
  );
}
