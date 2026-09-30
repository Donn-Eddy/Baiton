/**
 * The orchestrator's live model catalog (host-free core).
 *
 * This module is the single source of truth for refreshed model lists: the
 * snapshot vocabulary ({@link ModelEntry}, {@link ModelCatalogSnapshot}),
 * the stale-aware {@link CatalogStore} that round-trips snapshots through a
 * memento, and the preserve-existing merge that keeps user-configured model
 * ids alive across refreshes. It carries no `vscode` import, touches no host
 * API and spawns nothing, so the host glue and the unit tests both consume
 * this same contract — like src/orchestrator/providers.ts.
 */

import type { Result } from '../model/result';

/** Where a catalog snapshot's model list came from. */
export type CatalogSourceId = 'claude' | 'codex' | 'opencode' | 'antigravity' | 'models.dev';

/** Refresh order, top to bottom. */
export const CATALOG_SOURCE_IDS: readonly CatalogSourceId[] = [
  'claude',
  'codex',
  'opencode',
  'antigravity',
  'models.dev',
] as const;

/** True when `value` is one of the known {@link CatalogSourceId} strings. */
export function isCatalogSourceId(value: unknown): value is CatalogSourceId {
  return typeof value === 'string' && (CATALOG_SOURCE_IDS as readonly string[]).includes(value);
}

/**
 * One model in a catalog snapshot.
 *
 * `id` is the value written into config / {@link ModelSelection}.model.
 * `provider` carries the `provider` half of an `provider/model` id (OpenCode)
 * or the feed provider id. `efforts` / `defaultEffort` are the per-model
 * reasoning levels (codex `supportedReasoningEfforts`). `custom: true` marks
 * an entry appended by {@link mergePreservingExisting} rather than returned
 * by the source. `contextWindow` / `maxOutput` are carried only from the
 * models.dev feed; other sources leave them undefined.
 */
export interface ModelEntry {
  /** The model id itself, exactly as written into configuration. */
  readonly id: string;
  /** Human label shown as the option text; undefined when the id is the label. */
  readonly label?: string;
  /** The `provider/model` id's provider half (OpenCode) or the feed provider id. */
  readonly provider?: string;
  /** This model's reasoning levels, when the source discloses per-model levels. */
  readonly efforts?: readonly string[];
  /** This model's default reasoning level, when the source discloses it. */
  readonly defaultEffort?: string;
  /** The model's total context window in tokens, when the source discloses it (models.dev `limit.context`). */
  readonly contextWindow?: number;
  /** The model's maximum output tokens, when the source discloses it (models.dev `limit.output`). */
  readonly maxOutput?: number;
  /** True when this entry was appended from user configuration, not from the source. */
  readonly custom?: boolean;
}

/**
 * Where a snapshot's model list came from in this window:
 *
 * - `live` — just fetched in this window;
 * - `cached` — rehydrated from the memento;
 * - `builtin` — the curated fallback baked into the extension.
 */
export type SnapshotSource = 'live' | 'cached' | 'builtin';

/**
 * One source's model list at a point in time.
 *
 * `efforts` is the union-of-levels list for sources that expose one (codex);
 * per-model levels live on {@link ModelEntry.efforts}. `fetchedAt` is an
 * ISO-8601 string — the time of the last *successful* fetch, not of the
 * failure that marked the snapshot stale. The same snapshot object is what
 * the discovery service hands to `agentCapabilities(snapshots)` and to the
 * provider router.
 *
 * Note the two-level naming split resolved here (catalog OVERVIEW calls both
 * "source"): `sourceId` names WHICH feed the list came from, while `source`
 * names its origin in this window (`live` | `cached` | `builtin`). Later
 * todos (discovery service, router, config panel) must keep this split.
 */
export interface ModelCatalogSnapshot {
  /** The catalog feed this list came from. */
  readonly sourceId: CatalogSourceId;
  /** The model list, in the source's order. */
  readonly models: readonly ModelEntry[];
  /** Union-of-levels list for sources that expose one (codex). */
  readonly efforts?: readonly string[];
  /** ISO-8601 time of the last *successful* fetch, not of the stale-marking failure. */
  readonly fetchedAt: string;
  /** Which fetch generation produced this list. */
  readonly source: SnapshotSource;
  /** True when the last refresh failed and this list is no longer known current. */
  readonly stale: boolean;
  /** The human-readable reason the snapshot is stale; present only when `stale`. */
  readonly staleReason?: string;
}

/** Snapshots indexed by source id; only sources with a known list are present. */
export type ModelCatalogTable = Readonly<Partial<Record<CatalogSourceId, ModelCatalogSnapshot>>>;

/** The payload a source's discovery returns on success. */
export interface CatalogFetch {
  /** The model list in the source's order. */
  readonly models: readonly ModelEntry[];
  /** Union-of-levels list for sources that expose one (codex). */
  readonly efforts?: readonly string[];
}

/** The human-readable `staleReason` a source's discovery produces on failure. */
export type CatalogFailure = string;

// --- pure snapshot helpers ---------------------------------------------------

/** The model ids of `snapshot`, in order; `[]` for an undefined snapshot. */
export function modelIds(snapshot: ModelCatalogSnapshot | undefined): readonly string[] {
  return snapshot?.models.map((entry) => entry.id) ?? [];
}

/** The entry of `snapshot` with `id`, or undefined when absent. */
export function findModel(
  snapshot: ModelCatalogSnapshot | undefined,
  id: string,
): ModelEntry | undefined {
  return snapshot?.models.find((entry) => entry.id === id);
}

/**
 * The reasoning levels for model `id`: the model's own `efforts`, else the
 * snapshot-level `efforts`, else `[]`. Total; never throws.
 */
export function effortsFor(
  snapshot: ModelCatalogSnapshot | undefined,
  id: string,
): readonly string[] {
  if (snapshot === undefined) {
    return [];
  }
  const entry = findModel(snapshot, id);
  if (entry === undefined) {
    return [];
  }
  return entry.efforts ?? snapshot.efforts ?? [];
}

/**
 * Read an untrusted value (a memento blob's model entry, or a source
 * adapter's raw discovery record) as a {@link ModelEntry}. Accepts a plain
 * string (→ `{ id: trimmed }`) or an object with a non-empty string `id`.
 * Returns undefined otherwise. Pure; never throws.
 */
export function normalizeModelEntry(value: unknown): ModelEntry | undefined {
  if (typeof value === 'string') {
    const id = value.trim();
    return id.length > 0 ? { id } : undefined;
  }
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw['id'] !== 'string') {
    return undefined;
  }
  const id = raw['id'].trim();
  if (id.length === 0) {
    return undefined;
  }
  const entry: { id: string; label?: string; provider?: string; efforts?: readonly string[]; defaultEffort?: string; contextWindow?: number; maxOutput?: number; custom?: boolean } = { id };
  const label = optionalString(raw['label']);
  if (label !== undefined) {
    entry.label = label;
  }
  const provider = optionalString(raw['provider']);
  if (provider !== undefined) {
    entry.provider = provider;
  }
  const efforts = optionalStringArray(raw['efforts']);
  if (efforts !== undefined) {
    entry.efforts = efforts;
  }
  const defaultEffort = optionalString(raw['defaultEffort']);
  if (defaultEffort !== undefined) {
    entry.defaultEffort = defaultEffort;
  }
  const contextWindow = optionalTokenCount(raw['contextWindow']);
  if (contextWindow !== undefined) {
    entry.contextWindow = contextWindow;
  }
  const maxOutput = optionalTokenCount(raw['maxOutput']);
  if (maxOutput !== undefined) {
    entry.maxOutput = maxOutput;
  }
  if (raw['custom'] === true) {
    entry.custom = true;
  }
  return entry;
}

/** An unknown value as a positive finite integer token count, or undefined. */
function optionalTokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * An unknown value as a non-empty trimmed string, or undefined.
 * Private helper of {@link normalizeModelEntry} and the store's hydration.
 */
function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * An unknown value as an array of non-empty trimmed strings — all-or-nothing,
 * so a half-valid array is dropped entirely — or undefined.
 */
function optionalStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out: string[] = [];
  for (const item of value) {
    const trimmed = typeof item === 'string' ? item.trim() : '';
    if (trimmed.length === 0) {
      return undefined;
    }
    out.push(trimmed);
  }
  // An empty array carries no levels; drop it so callers keep the fallback path.
  return out.length > 0 ? out : undefined;
}

// --- preserve-existing merge -------------------------------------------------

/**
 * Append to `snapshot.models` every value of `existingValues` that the
 * refreshed list does not already carry, as `{ id, custom: true }` at the
 * END of `models` — refreshed ids keep their source order and stay first.
 *
 * Each `existingValues` entry is trimmed; `undefined`, empty and
 * whitespace-only values are skipped, as is any value whose trimmed form
 * already equals an `id` of `snapshot.models` (exact, case-sensitive match)
 * or is a duplicate of an earlier appended value.
 *
 * Every other field is carried through unchanged: merging is not a refresh
 * and must not clear staleness. Never mutates the input; always returns a
 * new snapshot object (a structurally equal copy when nothing is appended).
 */
export function mergePreservingExisting(
  snapshot: ModelCatalogSnapshot,
  existingValues: readonly (string | undefined)[],
): ModelCatalogSnapshot {
  const refreshedIds = new Set(modelIds(snapshot));
  const appended: ModelEntry[] = [];
  const seen = new Set<string>();
  for (const value of existingValues) {
    if (value === undefined) {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed.length === 0 || refreshedIds.has(trimmed) || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    appended.push({ id: trimmed, custom: true });
  }
  const models: readonly ModelEntry[] = [...snapshot.models, ...appended];
  const merged: {
    sourceId: CatalogSourceId;
    models: readonly ModelEntry[];
    efforts?: readonly string[];
    fetchedAt: string;
    source: SnapshotSource;
    stale: boolean;
    staleReason?: string;
  } = {
    sourceId: snapshot.sourceId,
    models,
    fetchedAt: snapshot.fetchedAt,
    source: snapshot.source,
    stale: snapshot.stale,
  };
  if (snapshot.efforts !== undefined) {
    merged.efforts = snapshot.efforts;
  }
  if (snapshot.staleReason !== undefined) {
    merged.staleReason = snapshot.staleReason;
  }
  return merged;
}

/**
 * Apply {@link mergePreservingExisting} per present source of `table`,
 * carrying each source's values from the matching `existing` slot; absent
 * sources are left untouched. Returns a new table; never mutates `table`.
 */
export function mergeTablePreservingExisting(
  table: ModelCatalogTable,
  existing: Partial<Record<CatalogSourceId, readonly (string | undefined)[]>>,
): ModelCatalogTable {
  const merged: { [K in CatalogSourceId]?: ModelCatalogSnapshot } = {};
  for (const sourceId of CATALOG_SOURCE_IDS) {
    const snapshot = table[sourceId];
    if (snapshot === undefined) {
      continue;
    }
    merged[sourceId] = mergePreservingExisting(snapshot, existing[sourceId] ?? []);
  }
  return merged;
}

// --- stale-aware store with memento persistence ------------------------------

/**
 * The subset of `vscode.Memento` (`globalState`) the store persists through,
 * mirroring the `MementoLike` pattern in src/activation/providerRouter.ts so
 * this module stays host-free. The host passes `context.globalState`.
 *
 * `Thenable` is the ambient global interface of @types/vscode (world-scope
 * augmentation, NOT a namespace import) — every real promise satisfies it, so
 * no `vscode` import is needed to reference it.
 */
export interface CatalogMemento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | void;
}

/** Memento key the catalog persist blob is stored under. */
export const MODEL_CATALOG_MEMENTO_KEY = 'baiton.models.catalog';

/** Persist format version; a wrong version discards the whole stored blob. */
export const MODEL_CATALOG_PERSIST_VERSION = 1;

/** Everything the store needs, injected so the module stays host-free. */
export interface CatalogStoreOptions {
  /** The host's `context.globalState`, or a test fake; persistence is best-effort when absent. */
  memento?: CatalogMemento;
  /** Returns the fetchedAt timestamp; defaults to `() => new Date().toISOString()` so tests are deterministic. */
  now?: () => string;
  /** The curated fallback used when neither memento nor a live fetch has produced a snapshot. */
  builtins?: Partial<Record<CatalogSourceId, CatalogFetch>>;
  /** Diagnostic sink; defaults to discarding messages. */
  log?: (message: string) => void;
}

/**
 * The stale-aware model catalog store.
 *
 * Snapshots enter through {@link applyResult} (one `Result` per source): OK
 * counts as a new `'live'` snapshot, ERR marks the source stale while keeping
 * the previous list — a failure must never clear a previous success, and a
 * later success clears `stale` + `staleReason`. On construction the store
 * rehydrates persisted snapshots from the injected memento (defensively
 * normalized, `source` forced to `'cached'`) and seeds any source that has
 * neither a stored snapshot nor a live fetch with its {@link builtins} entry.
 * Free of timers, network and process spawning: the discovery service owns
 * all of that and only calls `applyResult`.
 */
export class CatalogStore {
  private readonly snapshots = new Map<CatalogSourceId, ModelCatalogSnapshot>();
  private readonly memento: CatalogMemento | undefined;
  private readonly nowFn: () => string;
  private readonly builtins: Partial<Record<CatalogSourceId, CatalogFetch>>;
  private readonly logFn: (message: string) => void;

  constructor(options: CatalogStoreOptions = {}) {
    this.memento = options.memento;
    this.nowFn = options.now ?? (() => new Date().toISOString());
    this.builtins = options.builtins ?? {};
    this.logFn = options.log ?? (() => undefined);
    this.hydrate();
    for (const sourceId of CATALOG_SOURCE_IDS) {
      if (this.snapshots.has(sourceId)) {
        continue;
      }
      const fallback = this.builtins[sourceId];
      if (fallback !== undefined) {
        this.snapshots.set(sourceId, this.builtinSnapshot(sourceId, fallback));
      }
    }
  }

  /** The snapshot of `sourceId`, or undefined when no list is known. */
  get(sourceId: CatalogSourceId): ModelCatalogSnapshot | undefined {
    return this.snapshots.get(sourceId);
  }

  /** Snapshots indexed by source id; a shallow copy so callers cannot mutate internal state. */
  table(): ModelCatalogTable {
    const table: { [K in CatalogSourceId]?: ModelCatalogSnapshot } = {};
    for (const [sourceId, snapshot] of this.snapshots) {
      table[sourceId] = snapshot;
    }
    return table;
  }

  /**
   * The result of source `sourceId`'s refresh:
   *
   * - success → replace the snapshot with a `'live'`, not-stale one built from
   *   `result.value`, then persist;
   * - failure → keep the previous snapshot's `models`/`efforts`/`fetchedAt`/
   *   `source` exactly as they are and return a copy with `stale: true` and
   *   `staleReason: result.error`, then persist. With no previous snapshot
   *   (no live, cached, or builtin list) record nothing and return
   *   undefined — a source that never succeeded has no list to show.
   *
   * A failure never clears a previous success, and a later success clears
   * `stale`/`staleReason`.
   *
   * Deliberately NOT an API-failure logging point: the discovery service
   * (src/activation/modelDiscovery.ts) and `fetchModelsDev` are the single
   * choke point that writes `ApiLog` entries for catalog sources. Logging an
   * ERR here as well would record one failure twice, so do not add an
   * `apiLog` call to this method.
   */
  applyResult(
    sourceId: CatalogSourceId,
    result: Result<CatalogFetch, CatalogFailure>,
  ): ModelCatalogSnapshot | undefined {
    if (result.ok) {
      const fetched = result.value;
      const snapshot: {
        sourceId: CatalogSourceId;
        models: readonly ModelEntry[];
        efforts?: readonly string[];
        fetchedAt: string;
        source: SnapshotSource;
        stale: boolean;
      } = {
        sourceId,
        models: [...fetched.models],
        fetchedAt: this.nowFn(),
        source: 'live',
        stale: false,
      };
      if (fetched.efforts !== undefined) {
        snapshot.efforts = [...fetched.efforts];
      }
      this.snapshots.set(sourceId, snapshot);
      this.persist();
      return snapshot;
    }
    const previous = this.snapshots.get(sourceId);
    if (previous === undefined) {
      return undefined;
    }
    const copy: {
      sourceId: CatalogSourceId;
      models: readonly ModelEntry[];
      efforts?: readonly string[];
      fetchedAt: string;
      source: SnapshotSource;
      stale: boolean;
      staleReason: string;
    } = {
      sourceId: previous.sourceId,
      models: previous.models,
      fetchedAt: previous.fetchedAt,
      source: previous.source,
      stale: true,
      staleReason: result.error,
    };
    if (previous.efforts !== undefined) {
      copy.efforts = previous.efforts;
    }
    this.snapshots.set(sourceId, copy);
    this.persist();
    return copy;
  }

  /** Drop all snapshots and persist (used by tests and a future `baiton.refreshModels` hard reset). */
  clear(): void {
    this.snapshots.clear();
    this.persist();
  }

  /** Seed `sourceId` with the curated fallback snapshot. */
  private builtinSnapshot(sourceId: CatalogSourceId, fallback: CatalogFetch): ModelCatalogSnapshot {
    const snapshot: {
      sourceId: CatalogSourceId;
      models: readonly ModelEntry[];
      efforts?: readonly string[];
      fetchedAt: string;
      source: SnapshotSource;
      stale: boolean;
    } = {
      sourceId,
      models: [...fallback.models],
      fetchedAt: this.nowFn(),
      source: 'builtin',
      stale: false,
    };
    if (fallback.efforts !== undefined) {
      snapshot.efforts = [...fallback.efforts];
    }
    return snapshot;
  }

  /**
   * Rebuild the store's snapshots from the persisted blob. The blob is
   * validated defensively — an object, `version === MODEL_CATALOG_PERSIST_VERSION`
   * (anything else discards the WHOLE blob), and `snapshots` an object —
   * and each entry whose key is a {@link CatalogSourceId} rebuilds a snapshot
   * per {@link hydrateSnapshot}. Never throws: every failure is skipped
   * silently (or routed through `log`).
   */
  private hydrate(): void {
    if (this.memento === undefined) {
      return;
    }
    let raw: unknown;
    try {
      raw = this.memento.get(MODEL_CATALOG_MEMENTO_KEY);
    } catch (error) {
      this.logFn(`model catalog rehydrate failed: ${errorMessage(error)}`);
      return;
    }
    if (typeof raw !== 'object' || raw === null) {
      return;
    }
    const blob = raw as Record<string, unknown>;
    if (blob['version'] !== MODEL_CATALOG_PERSIST_VERSION) {
      return;
    }
    const stored = blob['snapshots'];
    if (typeof stored !== 'object' || stored === null) {
      return;
    }
    for (const [key, value] of Object.entries(stored as Record<string, unknown>)) {
      if (!isCatalogSourceId(key)) {
        continue;
      }
      const snapshot = this.hydrateSnapshot(key, value);
      if (snapshot !== undefined) {
        this.snapshots.set(key, snapshot);
      }
    }
  }

  /** Rebuild one snapshot from a stored entry; a snapshot whose `models` aren't normalized is dropped. */
  private hydrateSnapshot(sourceId: CatalogSourceId, value: unknown): ModelCatalogSnapshot | undefined {
    if (typeof value !== 'object' || value === null) {
      return undefined;
    }
    const raw = value as Record<string, unknown>;
    if (!Array.isArray(raw['models'])) {
      return undefined;
    }
    const models: ModelEntry[] = [];
    for (const item of raw['models']) {
      const entry = normalizeModelEntry(item);
      if (entry !== undefined) {
        models.push(entry);
      }
    }
    const efforts = optionalStringArray(raw['efforts']);
    const snapshot: {
      sourceId: CatalogSourceId;
      models: readonly ModelEntry[];
      efforts?: readonly string[];
      fetchedAt: string;
      source: SnapshotSource;
      stale: boolean;
      staleReason?: string;
    } = {
      sourceId,
      models,
      fetchedAt: optionalString(raw['fetchedAt']) ?? this.nowFn(),
      // Rehydrated snapshots came from an earlier success (live fetch or
      // builtin seeding) in an earlier window, not from a fetch in this one.
      source: 'cached',
      stale: raw['stale'] === true,
    };
    if (efforts !== undefined) {
      snapshot.efforts = efforts;
    }
    const staleReason = raw['stale'] === true ? optionalString(raw['staleReason']) : undefined;
    if (staleReason !== undefined) {
      snapshot.staleReason = staleReason;
    }
    return snapshot;
  }

  /**
   * Write the persist blob to the memento. Called at the end of
   * {@link applyResult} and {@link clear}; best-effort — a missing memento
   * (a no-persistence store) is a no-op, and a throwing or rejected `update`
   * is logged, never thrown, so persistence can never fail a refresh.
   */
  private persist(): void {
    if (this.memento === undefined) {
      return;
    }
    const blob = { version: MODEL_CATALOG_PERSIST_VERSION, snapshots: this.table() };
    try {
      const maybeThenable = this.memento.update(MODEL_CATALOG_MEMENTO_KEY, blob) as
        | Thenable<void>
        | undefined;
      if (typeof maybeThenable?.then === 'function') {
        // The rejection handler is load-bearing: a rejecting `update` would
        // otherwise surface as an unhandled rejection beyond the caller's
        // stack, which must never happen even though persistence is best-effort.
        maybeThenable.then(undefined, (reason: unknown) => {
          this.logFn(`model catalog persist rejected: ${errorMessage(reason)}`);
        });
      }
    } catch (error) {
      this.logFn(`model catalog persist failed: ${errorMessage(error)}`);
    }
  }
}

/**
 * A thrown or rejected value as a concise message, tolerating any shape
 * (Error, string, arbitrary object, undefined) without throwing itself.
 */
function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
