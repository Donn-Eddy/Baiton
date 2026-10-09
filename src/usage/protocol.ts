/**
 * Usage view message protocol (host-free core) — spec first-party-usage, todo T08.
 *
 * Defines the messages exchanged between the host and the Usage webview, plus
 * pure helpers that build them. Carries no vscode import and no Node built-in
 * import; every exported function is total (never throws).
 *
 * Credential redaction is NOT done here: UsageService already redacts every
 * reading string. {@link toWebviewReading} only guarantees that no unknown
 * field crosses to the webview.
 */
import {
  USAGE_TOOL_IDS,
  USAGE_TOOL_LABELS,
  isUsageToolId,
  sortReadings,
  type UsageReading,
  type UsageSource,
  type UsageToolId,
  type UsageWindow,
} from './model';

/** One tool's row in the Usage view. */
export interface UsageViewRow {
  readonly tool: UsageToolId;
  readonly label: string;
  /** undefined = not read yet in this view's lifetime */
  readonly reading?: UsageReading;
  /** true while a read for this tool is in flight */
  readonly refreshing: boolean;
}

/** View-level state accompanying the rows. */
export interface UsageViewState {
  /** any read in flight */
  readonly refreshing: boolean;
  /** workspace trust; false = Restricted Mode, so no credentials are read */
  readonly trusted: boolean;
  /** effective poll interval in whole seconds */
  readonly refreshIntervalSeconds: number;
  /** host clock (epoch ms) when the message was built; the webview computes ages from it */
  readonly now: number;
}

/** Messages the host posts to the webview. */
export type UsageHostToWebview =
  /** The current readings: always exactly one row per tool, in display order. */
  | { type: 'readings'; rows: UsageViewRow[]; now: number }
  /** The view-level state (refreshing, trust, poll interval). */
  | { type: 'state'; state: UsageViewState };

/** Messages the webview posts to the host. */
export type UsageWebviewToHost =
  /** The webview mounted; the host should post state and readings. */
  | { type: 'ready' }
  /** The user clicked refresh in the webview. */
  | { type: 'refresh' };

/** Parses a raw webview message; a fresh object with only the known fields, or undefined. */
export function parseUsageWebviewMessage(raw: unknown): UsageWebviewToHost | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const type = (raw as { type?: unknown }).type;
  if (type === 'ready') return { type: 'ready' };
  if (type === 'refresh') return { type: 'refresh' };
  return undefined;
}

function pickWindow(w: UsageWindow): UsageWindow {
  const out: { -readonly [K in keyof UsageWindow]: UsageWindow[K] } = {
    id: w.id,
    label: w.label,
    provenance: w.provenance,
  };
  if (w.usedPercent !== undefined) out.usedPercent = w.usedPercent;
  if (w.raw !== undefined) {
    const raw: { used?: number; limit?: number; remaining?: number; unit?: string } = {};
    if (w.raw.used !== undefined) raw.used = w.raw.used;
    if (w.raw.limit !== undefined) raw.limit = w.raw.limit;
    if (w.raw.remaining !== undefined) raw.remaining = w.raw.remaining;
    if (w.raw.unit !== undefined) raw.unit = w.raw.unit;
    out.raw = raw;
  }
  if (w.resetsAt !== undefined) out.resetsAt = w.resetsAt;
  if (w.scope !== undefined) {
    const scope: { model?: string; plan?: string } = {};
    if (w.scope.model !== undefined) scope.model = w.scope.model;
    if (w.scope.plan !== undefined) scope.plan = w.scope.plan;
    out.scope = scope;
  }
  return out;
}

function pickSource(s: UsageSource): UsageSource {
  return { mechanism: s.mechanism, detail: s.detail, provenance: s.provenance, readAt: s.readAt };
}

/** A defensive field-picking copy: nothing a reader smuggled onto the object crosses to the webview. */
export function toWebviewReading(r: UsageReading): UsageReading {
  if (r.status === 'unavailable') {
    const base = { tool: r.tool, status: 'unavailable' as const, reason: r.reason, checkedAt: r.checkedAt };
    return r.mechanism === undefined ? base : { ...base, mechanism: r.mechanism };
  }
  if (r.status === 'stale') {
    const base = {
      tool: r.tool,
      status: 'stale' as const,
      windows: r.windows.map(pickWindow),
      source: pickSource(r.source),
      reason: r.reason,
      failedAt: r.failedAt,
    };
    return r.tier === undefined ? base : { ...base, tier: r.tier };
  }
  const base = {
    tool: r.tool,
    status: 'ok' as const,
    windows: r.windows.map(pickWindow),
    source: pickSource(r.source),
  };
  return r.tier === undefined ? base : { ...base, tier: r.tier };
}

/** Exactly one row per tool, in display order. */
export function usageViewRows(
  readings: readonly UsageReading[],
  inFlight: ReadonlySet<UsageToolId> = new Set(),
): UsageViewRow[] {
  const valid = sortReadings((Array.isArray(readings) ? readings : []).filter((r) => r && isUsageToolId(r.tool)));
  return USAGE_TOOL_IDS.map((tool) => {
    const base = { tool, label: USAGE_TOOL_LABELS[tool], refreshing: inFlight.has(tool) };
    const reading = valid.find((r) => r.tool === tool);
    return reading ? { ...base, reading: toWebviewReading(reading) } : base;
  });
}

export function readingsMessage(
  readings: readonly UsageReading[],
  inFlight: ReadonlySet<UsageToolId>,
  now: number,
): UsageHostToWebview {
  return { type: 'readings', rows: usageViewRows(readings, inFlight), now };
}

export function stateMessage(state: UsageViewState): UsageHostToWebview {
  return { type: 'state', state: { ...state } };
}
