/**
 * The model-discovery service: the asynchronous, timeboxed refresh of every
 * catalog source on window reload.
 *
 * One {@link ModelDiscoveryService} fans out to the models.dev feed plus every
 * adapter that implements the `discoverModels` seam, each bounded by its own
 * per-source wall-clock budget, and feeds the outcomes into
 * {@link CatalogStore.applyResult} — the store alone owns provenance
 * (`source`/`fetchedAt`), the stale-marking merge and memento persistence.
 * `refresh()` never rejects and never blocks activation: every failure degrades
 * to a stale-marked previous list or to the curated builtin seeds, and the host
 * starts it with `void discovery.refresh()`.
 *
 * `vscode` is not imported at all: the whole host surface arrives injected
 * through {@link ModelDiscoveryOptions} (the memento lives inside the
 * `CatalogStore` the host builds), so this module and its test load with no
 * running VS Code host, exactly the constraint src/activation/providerRouter.ts
 * documents for its own sibling module.
 *
 * Two contract choices worth recording here:
 *
 * - The feed is fetched EXACTLY ONCE per refresh and handed to the claude
 *   adapter as `ctx.feed`; the adapter only falls back to its own fetcher when
 *   `ctx.feed` is absent, so awaiting the service's single feed promise is what
 *   keeps one reload to one network call.
 * - A models.dev entry's `id` is the BARE model id with the provider half on
 *   {@link ModelEntry.provider}, because `id` is what a persisted
 *   `ModelSelection.model` stores; switching to a `provider/model` composite id
 *   later would break that round-trip.
 *
 * Failures go to the injected `apiLog`: adapter outcomes keyed by agent id, and
 * the service's own feed timeout/throw. A feed Result error is logged once by
 * `fetchModelsDev`, never here.
 *
 * Nothing here reads a secret, an environment variable or SecretStorage: only
 * model ids and labels ever leave the host.
 */
import {
  AGENT_CATALOG_SOURCE,
  DEFAULT_DISCOVERY_TIMEOUT_MS,
  capabilitiesToCatalogFetch,
} from '../adapter/adapter';
import type { Adapter, AgentCapabilities, AgentId, DiscoveryContext } from '../adapter/adapter';
import { builtinAgentCapabilities } from '../adapter';
import type {
  CatalogFetch,
  CatalogStore,
  CatalogSourceId,
  ModelCatalogTable,
  ModelEntry,
} from '../orchestrator/modelCatalog';
import { noopApiLog } from '../orchestrator/apiLog';
import type { ApiLog, ApiFailureKind } from '../orchestrator/apiLog';
import { feedModelLimitFields, fetchModelsDev } from '../orchestrator/modelsDev';
import type { ModelsDevFeed } from '../orchestrator/modelsDev';
import { ok, err } from '../model/result';
import type { Result } from '../model/result';

/**
 * The curated builtin seeds the host hands {@link CatalogStore} as its
 * `builtins`, so a first-ever window with no memento and no network still shows
 * the curated lists as `source: 'builtin'`.
 *
 * Derived from {@link builtinAgentCapabilities} through
 * {@link AGENT_CATALOG_SOURCE}: every agent is mapped, so all four CLI sources
 * (claude, codex, opencode, antigravity) are seeded, and only `'models.dev'`
 * gets no entry because there is no curated feed
 * fallback. Pure, never throws, and returns a fresh object on every call
 * (the factory convention of `builtinAgentCapabilities`/`defaultConfig`).
 */
export function builtinCatalogFetches(): Partial<Record<CatalogSourceId, CatalogFetch>> {
  const caps = builtinAgentCapabilities();
  const out: { [K in CatalogSourceId]?: CatalogFetch } = {};
  for (const agent of Object.keys(caps) as AgentId[]) {
    const sourceId = AGENT_CATALOG_SOURCE[agent];
    if (sourceId === undefined) {
      continue;
    }
    out[sourceId] = capabilitiesToCatalogFetch(caps[agent]);
  }
  return out;
}

/** The default per-source wall-clock budget of one refresh. */
export const MODEL_DISCOVERY_SOURCE_TIMEOUT_MS = DEFAULT_DISCOVERY_TIMEOUT_MS;

/** The injected models.dev feed fetcher; defaults to {@link fetchModelsDev}. */
export type FeedFetcher = (options: {
  timeoutMs: number;
  signal?: AbortSignal;
}) => Promise<Result<ModelsDevFeed, string>>;

/**
 * The adapter lookup the service needs — structurally satisfied by
 * `AdapterRegistry` from src/adapter/index.ts, so the host passes the real
 * registry and the test passes a literal.
 */
export interface DiscoveryRegistry {
  /** The adapter for an unvalidated agent string; `undefined` for an unknown id. */
  get(agent: string): Adapter | undefined;
  /** The known agent ids. */
  readonly ids: readonly AgentId[];
}

/** Everything the service needs, injected so the module stays host-free. */
export interface ModelDiscoveryOptions {
  /** The stale-aware store every outcome is applied to; it owns persistence. */
  store: CatalogStore;
  /** The adapter lookup; the real `AdapterRegistry` satisfies it structurally. */
  registry: DiscoveryRegistry;
  /** Defaults to a wrapper over `fetchModelsDev({ timeoutMs })`. */
  fetchFeed?: FeedFetcher;
  /** Read per refresh, never hoisted: activation may resolve the workspace after the service is built. */
  cwd?: () => string | undefined;
  /** Per-source budget; defaults to {@link MODEL_DISCOVERY_SOURCE_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Diagnostic sink; absent means discard. */
  log?: (message: string) => void;
  /** API failure log: forwarded to the default models.dev fetch and every adapter's ctx; the service also logs adapter-level discovery failures. Defaults to discard. */
  apiLog?: ApiLog;
}

/** The `operation` of every service-level API failure entry. */
const DISCOVERY_OPERATION = 'model list';

/** The outcome of a {@link ModelDiscoveryService.withTimeout} race. */
type Raced<T> =
  | { kind: 'value'; value: T }
  | { kind: 'timeout' }
  | { kind: 'error'; message: string };

/**
 * The window's model-discovery service.
 *
 * `refresh()` runs the feed and every adapter with a `discoverModels` seam in
 * parallel and resolves the full {@link ModelCatalogTable}; it never rejects,
 * whatever a source does (resolve `undefined`, reject, throw synchronously,
 * hang, or have no seam at all). A second `refresh()` aborts the one in flight,
 * and the superseded run's writes are dropped by the generation guard in
 * {@link ModelDiscoveryService.apply} so it can never overwrite a newer
 * snapshot or persist late.
 */
export class ModelDiscoveryService {
  private readonly listeners = new Set<(table: ModelCatalogTable) => void>();
  private inFlight: { controller: AbortController; done: Promise<ModelCatalogTable> } | undefined;
  private lastFeed: ModelsDevFeed | undefined;
  private disposed = false;

  constructor(private readonly options: ModelDiscoveryOptions) {}

  private get apiLog(): ApiLog {
    return this.options.apiLog ?? noopApiLog;
  }

  /** The store's current snapshots, indexed by source id. */
  table(): ModelCatalogTable {
    return this.options.store.table();
  }

  /**
   * The last SUCCESSFULLY parsed models.dev feed, so a later consumer (the
   * provider catalog) needs no second network call. `undefined` until one
   * refresh has fetched and parsed the feed.
   */
  feed(): ModelsDevFeed | undefined {
    return this.lastFeed;
  }

  /**
   * Subscribes to catalog changes. The returned handle removes the listener on
   * `dispose()`. A throwing listener is logged and skipped so it cannot break
   * the refresh or the other listeners. Listeners may be called SEVERAL times
   * per refresh — once per source as it lands — and must tolerate a call whose
   * table is unchanged (the same contract as `router.refresh()`).
   */
  onDidChange(listener: (table: ModelCatalogTable) => void): { dispose(): void } {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  /**
   * Refresh every catalog source once, in parallel, each bounded by the
   * per-source timeout, and resolve the resulting table.
   *
   * NEVER rejects. After `dispose()` it resolves the current table without
   * calling a single adapter. A refresh already in flight is aborted first: its
   * `AbortSignal` fires, and anything it later tries to apply is dropped.
   */
  refresh(): Promise<ModelCatalogTable> {
    if (this.disposed) {
      return Promise.resolve(this.table());
    }
    this.inFlight?.controller.abort();
    const controller = new AbortController();
    const done = this.runRefresh(controller);
    const run = { controller, done };
    this.inFlight = run;
    return done;
  }

  /**
   * Tear the service down: abort the in-flight refresh (so nothing it still has
   * outstanding reaches the store) and drop every listener. Idempotent.
   */
  dispose(): void {
    this.disposed = true;
    this.inFlight?.controller.abort();
    this.listeners.clear();
  }

  /** One refresh generation: the feed plus every adapter source, in parallel. */
  private async runRefresh(controller: AbortController): Promise<ModelCatalogTable> {
    const signal = controller.signal;
    const timeoutMs = this.options.timeoutMs ?? MODEL_DISCOVERY_SOURCE_TIMEOUT_MS;
    const cwd = this.options.cwd?.();

    // The feed is kicked off FIRST and awaited only by the claude job, so the
    // CLI sources start immediately and the feed is fetched exactly once.
    const feedPromise = this.refreshFeed(controller, signal, timeoutMs);
    const jobs: Promise<void>[] = [];
    for (const agent of Object.keys(AGENT_CATALOG_SOURCE) as AgentId[]) {
      const sourceId = AGENT_CATALOG_SOURCE[agent];
      if (sourceId === undefined) {
        continue;
      }
      if (agent === 'claude') {
        jobs.push(
          feedPromise.then((feed) =>
            this.refreshAgent(agent, sourceId, { controller, signal, timeoutMs, cwd, feed }),
          ),
        );
        continue;
      }
      jobs.push(this.refreshAgent(agent, sourceId, { controller, signal, timeoutMs, cwd }));
    }
    await Promise.all(jobs);

    const table = this.table();
    if (this.inFlight?.controller === controller) {
      this.inFlight = undefined;
    }
    return table;
  }

  /**
   * Refresh one agent-backed source. Every agent is mapped to a source and
   * every shipped adapter implements `discoverModels`; a hypothetical adapter
   * without that seam never touches the store at all: no snapshot, no stale
   * mark.
   */
  private async refreshAgent(
    agent: AgentId,
    sourceId: CatalogSourceId,
    parts: {
      controller: AbortController;
      signal: AbortSignal;
      timeoutMs: number;
      cwd: string | undefined;
      feed?: ModelsDevFeed | undefined;
    },
  ): Promise<void> {
    const adapter = this.options.registry.get(agent);
    if (adapter?.discoverModels === undefined) {
      return;
    }
    const { controller, signal, timeoutMs, cwd, feed } = parts;
    const ctx: DiscoveryContext = {
      timeoutMs,
      signal,
      ...(cwd !== undefined ? { cwd } : {}),
      ...(feed !== undefined ? { feed } : {}),
      ...(this.options.apiLog !== undefined ? { apiLog: this.options.apiLog } : {}),
      log: (m: string) => this.log(`${agent} model discovery: ${m}`),
    };
    let raced: Raced<AgentCapabilities | undefined>;
    try {
      raced = await this.withTimeout(adapter.discoverModels(ctx), timeoutMs);
    } catch (error) {
      // A synchronously throwing `discoverModels` breaks the adapter contract,
      // but the service must survive it.
      raced = { kind: 'error', message: describe(error) };
    }
    let result: Result<CatalogFetch, string>;
    if (raced.kind === 'timeout') {
      const msg = `${agent} model discovery timed out after ${timeoutMs}ms`;
      this.logFailure(controller, agent, 'timeout', msg);
      result = err(msg);
    } else if (raced.kind === 'error') {
      const msg = `${agent} model discovery failed: ${raced.message}`;
      this.logFailure(controller, agent, 'connection', msg);
      result = err(msg);
    } else if (raced.value === undefined) {
      const msg = `${agent} model discovery returned no models`;
      this.logFailure(controller, agent, 'malformed-response', msg);
      result = err(msg);
    } else {
      result = ok(capabilitiesToCatalogFetch(raced.value));
    }
    this.apply(sourceId, result, controller);
  }

  /**
   * Fetch and apply the models.dev feed, resolving the parsed feed so the
   * claude job can pass it as `ctx.feed`. Resolves `undefined` on any failure;
   * never rejects.
   */
  private async refreshFeed(
    controller: AbortController,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<ModelsDevFeed | undefined> {
    let serviceTimedOut = false;
    // The default fetcher logs its own Result errors through fetchModelsDev; the
    // gate drops a late entry for a fetch the service's race already reported
    // as a timeout, so one failure never produces two lines.
    const gatedApiLog: ApiLog = {
      failure: (entry) => {
        if (!serviceTimedOut) {
          this.apiLog.failure(entry);
        }
      },
    };
    const fetchFeed: FeedFetcher =
      this.options.fetchFeed ??
      ((o) => fetchModelsDev({ timeoutMs: o.timeoutMs, apiLog: gatedApiLog }));
    let raced: Raced<Result<ModelsDevFeed, string>>;
    try {
      raced = await this.withTimeout(fetchFeed({ timeoutMs, signal }), timeoutMs);
    } catch (error) {
      raced = { kind: 'error', message: describe(error) };
    }
    if (raced.kind === 'timeout') {
      serviceTimedOut = true;
      const msg = `models.dev fetch timed out after ${timeoutMs}ms`;
      this.logFailure(controller, 'models.dev', 'timeout', msg);
      this.apply('models.dev', err(msg), controller);
      return undefined;
    }
    if (raced.kind === 'error') {
      const msg = `models.dev fetch failed: ${raced.message}`;
      this.logFailure(controller, 'models.dev', 'connection', msg);
      this.apply('models.dev', err(msg), controller);
      return undefined;
    }
    if (!raced.value.ok) {
      // Not logged here: fetchModelsDev already logged this Result error, and an
      // injected fetcher's err is treated the same, so it is never logged twice.
      this.apply('models.dev', err(raced.value.error), controller);
      return undefined;
    }
    const feed = raced.value.value;
    this.lastFeed = feed;
    this.apply('models.dev', ok(feedCatalogFetch(feed)), controller);
    return feed;
  }

  /**
   * Apply one source's outcome to the store and fire the change event.
   *
   * The generation guard is load-bearing: a superseded (`controller` aborted)
   * or torn-down (`disposed`) refresh writes NOTHING, so it can neither
   * overwrite a newer snapshot nor persist late.
   */
  private apply(
    sourceId: CatalogSourceId,
    result: Result<CatalogFetch, string>,
    controller: AbortController,
  ): void {
    if (controller.signal.aborted || this.disposed) {
      return;
    }
    this.options.store.applyResult(sourceId, result);
    this.log(
      result.ok
        ? `${sourceId} refreshed (${result.value.models.length} models)`
        : `${sourceId} marked stale: ${result.error}`,
    );
    this.fire();
  }

  /** Writes one API failure entry, only for a live generation (mirrors {@link apply}). */
  private logFailure(
    controller: AbortController,
    surface: string,
    kind: ApiFailureKind,
    message: string,
  ): void {
    if (controller.signal.aborted || this.disposed) {
      return;
    }
    this.apiLog.failure({ surface, operation: DISCOVERY_OPERATION, kind, message });
  }

  /** Fires the change event once, defensively, with a copy of the listener set. */
  private fire(): void {
    const table = this.table();
    for (const listener of [...this.listeners]) {
      try {
        listener(table);
      } catch (error) {
        this.log(`a catalog listener threw: ${describe(error)}`);
      }
    }
  }

  /**
   * Race `promise` against a `ms` timer — a second line of defence over a
   * source that ignores its own `ctx.timeoutMs`.
   *
   * The timer is `unref()`'d where the runtime offers it (absent on the browser
   * typing) and always cleared, so no pending timer keeps mocha alive; and the
   * losing promise's rejection is always consumed, so a rejecting source can
   * never surface as an unhandled rejection in an unrelated suite (the same
   * requirement `ClaudeAdapter.raceAbort` documents).
   */
  private async withTimeout<T>(promise: Promise<T>, ms: number): Promise<Raced<T>> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled: Promise<Raced<T>> = promise.then(
      (value) => ({ kind: 'value', value }) as Raced<T>,
      (error: unknown) => ({ kind: 'error', message: describe(error) }) as Raced<T>,
    );
    const timeout = new Promise<Raced<T>>((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'timeout' }), ms);
      (timer as { unref?: () => void }).unref?.();
    });
    try {
      // `settled` never rejects, so the loser of this race leaks nothing.
      return await Promise.race([settled, timeout]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  /** Route one diagnostic line to the injected sink. */
  private log(message: string): void {
    this.options.log?.(`Baiton model discovery: ${message}`);
  }
}

/**
 * Flatten a models.dev feed into a {@link CatalogFetch}: one {@link ModelEntry}
 * per provider/model pair, in feed order, the BARE model id as `id` and the
 * provider half on `provider`. Duplicate ids across providers are therefore
 * expected and only a (provider, id) pair is de-duplicated. No `efforts`: the
 * feed discloses no reasoning levels. Plus `contextWindow`/`maxOutput` from the
 * feed's `limit` block when disclosed. Pure.
 */
function feedCatalogFetch(feed: ModelsDevFeed): CatalogFetch {
  const models: ModelEntry[] = [];
  const seen = new Set<string>();
  for (const provider of feed) {
    for (const model of provider.models) {
      const key = `${provider.id}\u0000${model.id}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      models.push({
        id: model.id,
        provider: provider.id,
        ...(model.name !== model.id ? { label: model.name } : {}),
        ...feedModelLimitFields(model),
      });
    }
  }
  return { models };
}

/**
 * A thrown or rejected value as a concise message, tolerating any shape
 * (Error, string, arbitrary object, undefined) without throwing itself —
 * matching `errorMessage` in src/orchestrator/modelCatalog.ts.
 */
function describe(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
