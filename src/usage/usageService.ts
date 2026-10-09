/**
 * Host-free UsageService for the Usage view (baiton.usageView) — spec
 * first-party-usage, todo T02. Coalesces per-tool reads, timeboxes them, keeps
 * the last good reading as stale, never throws.
 *
 * Imports only from './model': no vscode, no Node built-in modules. Timers come
 * from an injected seam so tests never wait on real time.
 */

import {
  USAGE_STATUSES,
  USAGE_TOOL_IDS,
  USAGE_TOOL_LABELS,
  type UsageReading,
  type UsageToolId,
  type UsageWindow,
  isUsageToolId,
  lastGood,
  normaliseReason,
  okReading,
  sortReadings,
  staleReading,
  unavailableReading,
} from './model';

// --- Seams -------------------------------------------------------------------

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
  /** Default Date.now. */
  readonly now?: () => number;
  /** Default realUsageTimer. */
  readonly timer?: UsageTimer;
  /** Default DEFAULT_USAGE_READ_TIMEOUT_MS; non-finite or <= 0 falls back to the default. */
  readonly timeoutMs?: number;
  /** Default () => false: fail closed, no credential reads unless the host says trusted. */
  readonly isTrusted?: () => boolean;
  /** Diagnostics; every message passes through redactSecrets. */
  readonly log?: (message: string) => void;
}
export type UsageSnapshotListener = (readings: readonly UsageReading[]) => void;
export interface UsageDisposable {
  dispose(): void;
}

/** The real timers; handles are unref'd so they never keep Node alive. */
export const realUsageTimer: UsageTimer = {
  setTimeout(fn, ms) {
    const handle = setTimeout(fn, ms);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
  setInterval(fn, ms) {
    const handle = setInterval(fn, ms);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearInterval(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

/** A refresh interval in whole seconds, clamped to [MIN, MAX]; anything unusable gives the default. */
export function normaliseRefreshIntervalSeconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_USAGE_REFRESH_INTERVAL_SECONDS;
  return Math.min(
    MAX_USAGE_REFRESH_INTERVAL_SECONDS,
    Math.max(MIN_USAGE_REFRESH_INTERVAL_SECONDS, Math.round(value)),
  );
}

// --- Redaction ---------------------------------------------------------------

const REDACTED = '[redacted]';

/**
 * Masks anything that looks like a credential. A token lives in memory for one
 * read; it never reaches a reading, a log line or the webview. Pure and total
 * (non-string input gives '').
 */
export function redactSecrets(text: string): string {
  if (typeof text !== 'string') return '';
  return text
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, REDACTED)
    .replace(/\b(sk-ant-|sk-|ya29\.|ghp_|gho_|xox[abp]-)[A-Za-z0-9._-]{6,}/g, REDACTED)
    .replace(
      /(["']?(?:access_token|refresh_token|id_token|api[_-]?key|token|authorization|password|secret|client_secret|cookie)["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi,
      `$1${REDACTED}`,
    )
    .replace(/[A-Za-z0-9_\-+/=]{32,}/g, REDACTED);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown error';
}

function redactOptional(text: string | undefined): string | undefined {
  return typeof text === 'string' ? redactSecrets(text) : undefined;
}

function pickWindowFields(w: UsageWindow): UsageWindow {
  const out: { -readonly [K in keyof UsageWindow]: UsageWindow[K] } = {
    id: redactSecrets(String(w.id)),
    label: redactSecrets(String(w.label)),
    provenance: w.provenance,
  };
  if (w.usedPercent !== undefined) out.usedPercent = w.usedPercent;
  if (w.resetsAt !== undefined) out.resetsAt = w.resetsAt;
  if (w.raw) {
    const raw: { -readonly [K in keyof NonNullable<UsageWindow['raw']>]: NonNullable<UsageWindow['raw']>[K] } = {};
    if (w.raw.used !== undefined) raw.used = w.raw.used;
    if (w.raw.limit !== undefined) raw.limit = w.raw.limit;
    if (w.raw.remaining !== undefined) raw.remaining = w.raw.remaining;
    const unit = redactOptional(w.raw.unit);
    if (unit !== undefined) raw.unit = unit;
    out.raw = raw;
  }
  if (w.scope) {
    const scope: { model?: string; plan?: string } = {};
    const model = redactOptional(w.scope.model);
    const plan = redactOptional(w.scope.plan);
    if (model !== undefined) scope.model = model;
    if (plan !== undefined) scope.plan = plan;
    out.scope = scope;
  }
  return out;
}

/**
 * Rebuilds an ok reading field by field so a property a reader smuggled in is
 * dropped, redacting every string. May return unavailable (zero windows).
 */
function sanitiseOk(r: Extract<UsageReading, { status: 'ok' }>): UsageReading {
  const windows = Array.isArray(r.windows) ? r.windows.filter((w) => w && typeof w === 'object') : [];
  return okReading(
    r.tool,
    {
      mechanism: r.source.mechanism,
      detail: redactSecrets(r.source.detail),
      provenance: r.source.provenance,
      readAt: r.source.readAt,
    },
    windows.map(pickWindowFields),
    redactOptional(r.tier),
  );
}

// --- Service -----------------------------------------------------------------

type Outcome =
  | { readonly kind: 'value'; readonly reading: unknown }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'timeout' };

export class UsageService implements UsageDisposable {
  private readonly readings = new Map<UsageToolId, UsageReading>();
  private readonly inFlight = new Map<UsageToolId, Promise<UsageReading>>();
  private readonly controllers = new Set<AbortController>();
  private readonly listeners = new Set<UsageSnapshotListener>();
  private pollHandle: UsageTimerHandle | undefined;
  private disposed = false;

  /** Does not read, spawn or start any timer. */
  constructor(private readonly options: UsageServiceOptions) {}

  private now(): number {
    try {
      const n = (this.options.now ?? Date.now)();
      return typeof n === 'number' && Number.isFinite(n) ? n : Date.now();
    } catch {
      return Date.now();
    }
  }

  private get timer(): UsageTimer {
    return this.options.timer ?? realUsageTimer;
  }

  private get timeoutMs(): number {
    const t = this.options.timeoutMs;
    return typeof t === 'number' && Number.isFinite(t) && t > 0 ? t : DEFAULT_USAGE_READ_TIMEOUT_MS;
  }

  private log(message: string): void {
    try {
      this.options.log?.(redactSecrets(message));
    } catch {
      // diagnostics must never throw
    }
  }

  get(tool: UsageToolId): UsageReading | undefined {
    return this.readings.get(tool);
  }

  /** Readings in display order; tools never read are absent. */
  snapshot(): readonly UsageReading[] {
    return sortReadings([...this.readings.values()]);
  }

  onDidChange(listener: UsageSnapshotListener): UsageDisposable {
    this.listeners.add(listener);
    return { dispose: () => void this.listeners.delete(listener) };
  }

  refreshTool(tool: UsageToolId): Promise<UsageReading> {
    if (this.disposed) {
      return Promise.resolve(
        this.readings.get(tool) ?? unavailableReading(tool, 'The usage view is closed.', this.now()),
      );
    }
    const existing = this.inFlight.get(tool);
    if (existing) return existing;
    const p: Promise<UsageReading> = this.runRead(tool).finally(() => {
      if (this.inFlight.get(tool) === p) this.inFlight.delete(tool);
    });
    this.inFlight.set(tool, p);
    return p;
  }

  async refresh(tools: readonly UsageToolId[] = USAGE_TOOL_IDS): Promise<readonly UsageReading[]> {
    try {
      const unique = [...new Set((Array.isArray(tools) ? tools : []).filter(isUsageToolId))];
      await Promise.all(unique.map((t) => this.refreshTool(t)));
    } catch (error) {
      this.log(`Usage refresh failed: ${describeError(error)}`);
    }
    return this.snapshot();
  }

  startPolling(intervalSeconds: unknown): void {
    if (this.disposed) return;
    this.stopPolling();
    const ms = normaliseRefreshIntervalSeconds(intervalSeconds) * 1000;
    this.pollHandle = this.timer.setInterval(() => {
      void this.refresh();
    }, ms);
  }

  stopPolling(): void {
    if (this.pollHandle !== undefined) {
      const handle = this.pollHandle;
      this.pollHandle = undefined;
      try {
        this.timer.clearInterval(handle);
      } catch (error) {
        this.log(`Clearing the usage poll failed: ${describeError(error)}`);
      }
    }
  }

  get isPolling(): boolean {
    return this.pollHandle !== undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopPolling();
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    this.listeners.clear();
  }

  private async runRead(tool: UsageToolId): Promise<UsageReading> {
    let settledAt = this.now();
    const failure = (reason: string, mechanism?: Parameters<typeof unavailableReading>[3]): UsageReading => {
      const safe = normaliseReason(redactSecrets(reason));
      const last = lastGood(this.readings.get(tool));
      return last ? staleReading(last, safe, settledAt) : unavailableReading(tool, safe, settledAt, mechanism);
    };
    const finish = (reading: UsageReading): UsageReading => {
      if (this.disposed) return reading;
      this.readings.set(tool, reading);
      this.emit();
      return reading;
    };

    try {
      const reader = this.options.readers[tool];
      if (!reader) {
        return finish(failure(`No usage reader is configured for ${USAGE_TOOL_LABELS[tool]}.`));
      }
      const timeoutMs = this.timeoutMs;
      const controller = new AbortController();
      this.controllers.add(controller);
      let trusted = false;
      try {
        trusted = this.options.isTrusted?.() === true;
      } catch {
        trusted = false;
      }
      const ctx: UsageReadContext = {
        signal: controller.signal,
        trusted,
        now: this.options.now ?? Date.now,
        timeoutMs,
      };

      let handle: UsageTimerHandle | undefined;
      let outcome: Outcome;
      try {
        const read: Promise<Outcome> = Promise.resolve()
          .then(() => reader(ctx))
          .then(
            (reading): Outcome => ({ kind: 'value', reading }),
            (e): Outcome => ({ kind: 'error', message: describeError(e) }),
          );
        const timeout = new Promise<Outcome>((resolve) => {
          handle = this.timer.setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
        });
        outcome = await Promise.race([read, timeout]);
        if (outcome.kind === 'timeout') controller.abort();
      } finally {
        if (handle !== undefined) {
          try {
            this.timer.clearTimeout(handle);
          } catch {
            // ignore
          }
        }
        this.controllers.delete(controller);
      }

      settledAt = this.now();
      if (outcome.kind === 'timeout') {
        const label = timeoutMs < 1000 ? `${Math.round(timeoutMs)}ms` : `${Math.round(timeoutMs / 1000)}s`;
        return finish(failure(`Usage read timed out after ${label}.`));
      }
      if (outcome.kind === 'error') return finish(failure(outcome.message));

      const r = outcome.reading as UsageReading | null | undefined;
      if (
        !r ||
        typeof r !== 'object' ||
        !isUsageToolId(r.tool) ||
        r.tool !== tool ||
        !USAGE_STATUSES.includes(r.status)
      ) {
        return finish(failure('The usage reader returned an invalid reading.'));
      }
      if (r.status === 'ok') {
        const clean = sanitiseOk(r);
        return finish(clean.status === 'ok' ? clean : failure(clean.status === 'unavailable' ? clean.reason : ''));
      }
      return finish(failure(r.reason, r.status === 'unavailable' ? r.mechanism : undefined));
    } catch (error) {
      this.log(`Usage read for ${tool} failed unexpectedly: ${describeError(error)}`);
      try {
        return finish(failure(describeError(error)));
      } catch {
        return unavailableReading(tool, 'The usage read failed.', this.now());
      }
    }
  }

  private emit(): void {
    const snap = this.snapshot();
    for (const listener of [...this.listeners]) {
      try {
        listener(snap);
      } catch (error) {
        this.log(`A usage listener failed: ${describeError(error)}`);
      }
    }
  }
}
