/**
 * The host-side ProviderRouter (multi-provider orchestrator).
 *
 * One router owns a lazily-memoised client per provider: an
 * {@link OpenAiModelClient} configured from the catalog for the
 * OpenAI-compatible providers, and a {@link CopilotModelClient} speaking
 * `vscode.lm` for `copilot`. The provider list and the per-provider model
 * lists are CATALOG-DRIVEN: the injected {@link ModelCatalogSource} supplies
 * the `models.dev` snapshot the discovery service refreshes (models, staleness
 * and `fetchedAt`) plus the last parsed feed (labels, base URLs), both read at
 * call time so a refresh that lands after construction is picked up by the
 * next call. Availability (API keys in SecretStorage, the
 * `baiton.orchestrator.endpoint` setting, Copilot model enumeration) is
 * recomputed on every `availability()` call because keys and Copilot sign-in
 * change out of band — except that API-key PRESENCE is memoised per secret
 * key when the injected storage offers `onDidChange` (the host's does), and
 * dropped per key when that event fires, so a live catalog of hundreds of
 * providers costs one SecretStorage read per key rather than one per key per
 * call. `availability()` reports only the CONFIGURED
 * providers — the rest are behind {@link ProviderRouter.hiddenProviders}, each
 * carrying the reason it is unusable. The active {@link ModelSelection} round-trips through
 * `workspaceState` under the catalog's `MODEL_SELECTION_KEY`, listeners hear
 * exactly one change event per real switch, and `complete()` routes each
 * request BY REFERENCE to the active provider's client, so the ChatController,
 * tool loop and Auto mode all switch together when `select()` runs — no
 * re-wiring.
 *
 * `vscode` is imported as a TYPE ONLY and the whole runtime surface is
 * injected (`ProviderRouterConfig`), exactly the constraint
 * src/orchestrator/copilotClient.ts documents: this module and its test load
 * with no running host, even though its siblings under `src/activation/`
 * legally import the host.
 */
import type * as vscode from 'vscode';
import {
  CompletionRequest,
  CompletionResult,
  MissingConfigError,
  ModelClient,
  ModelClientConfig,
  OpenAiModelClient,
  dialectFor,
  openCodeExtraHeaders,
} from '../orchestrator/modelClient';
import {
  CopilotModelClient,
  CopilotVscodeApi,
  COPILOT_VENDOR,
} from '../orchestrator/copilotClient';
import {
  MODEL_SELECTION_KEY,
  ModelSelection,
  PROVIDERS,
  ProviderId,
  ProviderInfo,
  COPILOT_UNAVAILABLE_REASON,
  PROVIDER_NEEDS_ENDPOINT_REASON,
  buildProviderCatalog,
  defaultModelFor,
  normalizeModelSelection,
  providerInfo,
  providerNeedsEndpointReason,
  providerNeedsKeyReason,
  providerSecretKey,
  sameModelSelection,
} from '../orchestrator/providers';
import type { ModelCatalogSnapshot } from '../orchestrator/modelCatalog';
import type { ModelsDevFeed } from '../orchestrator/modelsDev';

/**
 * Compile-time anchors for the type-only `vscode` import: the router's host
 * surface is structural ({@link SecretsLike}, {@link MementoLike}), so the
 * namespace itself is referenced nowhere at runtime. These guarded aliases
 * keep the type-only import visibly in place — the module and its test must
 * load with no running host — and document that the structural shapes aim at
 * the real host interfaces. Exported so the unused-locals check (which cannot
 * see their reference to `vscode`) does not flag them.
 */
export type SecretsLikeIsHostSubset = SecretsLike extends vscode.SecretStorage
  ? true
  : false;
export type MementoLikeIsHostSubset = MementoLike extends vscode.Memento
  ? true
  : false;

/**
 * The subset of `vscode.SecretStorage` the router reads. Only `get` is
 * needed: the router never writes secrets. `onDidChange` is optional: when
 * present the router memoises key presence and drops one key's entry each
 * time the event names it; when absent every availability read goes to
 * `get`, exactly as before the memo existed.
 */
export interface SecretsLike {
  get(key: string): Thenable<string | undefined> | string | undefined;
  onDidChange?(listener: (e: { key: string }) => void): { dispose(): void };
}

/**
 * The subset of `vscode.Memento` (`workspaceState`) the router uses: reading
 * and persisting the active {@link ModelSelection}.
 */
export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

/** The `baiton.orchestrator.*` settings the client configuration and availability read. */
export interface ProviderSettings {
  /** `baiton.orchestrator.endpoint` — the OpenAI / Custom base URL. */
  getEndpoint: () => string | undefined;
  /**
   * `baiton.orchestrator.endpoints[id]` — a user-set base URL for one
   * non-settings provider. When set (non-blank) it WINS over the catalog's
   * base URL, so a proxy can front a provider the feed does know; it is the
   * only way to reach a feed provider whose entry discloses no `api`.
   */
  getProviderEndpoint: (id: ProviderId) => string | undefined;
  /** `baiton.orchestrator.model` — the OpenAI / Custom model id. */
  getModel: () => string | undefined;
  /** `baiton.orchestrator.streaming` — whether the endpoint advertises streaming. */
  isStreaming: () => boolean;
  /** `baiton.orchestrator.maxTokens` — passed through; `resolveMaxTokens` already normalises. */
  getMaxTokens: () => unknown;
}

/**
 * The live model catalog the router reads: the `models.dev` snapshot the
 * discovery service refreshes plus the last successfully parsed feed. Both are
 * read at CALL time (never hoisted), so a refresh that lands after the router
 * was built is picked up by the next availability() call.
 */
export interface ModelCatalogSource {
  /** `CatalogStore.get('models.dev')`, or undefined when no list is known. */
  snapshot(): ModelCatalogSnapshot | undefined;
  /** `ModelDiscoveryService.feed()`, or undefined until one refresh parsed it. */
  feed(): ModelsDevFeed | undefined;
}

/** Everything the router needs, injected so the module stays host-free. */
export interface ProviderRouterConfig {
  secrets: SecretsLike;
  workspaceState: MementoLike;
  settings: ProviderSettings;
  /** The `vscode` namespace (host) or the test fake; used for the Copilot client and model enumeration. */
  lm: CopilotVscodeApi;
  /** Extension version, rendered as `baiton/<version>` in the OpenCode User-Agent. */
  version: string;
  /**
   * The live model catalog. Absent means "no live catalog": the router then
   * behaves exactly as before this seam existed — the six builtin entries in
   * their builtin order, with their builtin model lists.
   */
  catalog?: ModelCatalogSource;
  /** Overrides client construction in tests; defaults to the real clients. */
  createClient?: (id: ProviderId, router: ProviderRouter) => ModelClient;
  log?: (message: string) => void;
}

/** One provider's current availability as reported to the webview. */
export interface ProviderAvailability {
  id: ProviderId;
  label: string;
  enabled: boolean;
  /** Present only when `enabled` is false. */
  reason?: string;
  models: readonly string[];
  /** True when the models.dev snapshot backing `models` is no longer known current. */
  stale?: boolean;
  /** Why the snapshot is stale; present only with `stale: true`. */
  staleReason?: string;
  /** ISO-8601 time of the last SUCCESSFUL catalog fetch backing `models`. */
  fetchedAt?: string;
  /** Ids inside `models` that came from a preserved selection, not the catalog. */
  customModels?: readonly string[];
}

/** Everything {@link providerClientConfig} needs beyond the provider id. */
export interface ClientConfigDeps {
  secrets: SecretsLike;
  settings: ProviderSettings;
  version: string;
  /** Resolves the model id currently chosen for this provider. */
  getModel: () => string | undefined;
  /**
   * The live, feed-merged catalog, read at CALL time. Without it `id` is
   * resolved against the builtins only, so a feed-derived provider degrades to
   * a synthesised entry with no base URL. The router passes its own
   * `catalogEntries()` so a feed that lands after the (memoised) client was
   * built still supplies the base URL on the next request.
   */
  catalog?: () => readonly ProviderInfo[];
}

/**
 * The base URL `id` is reached at: the user's `baiton.orchestrator.endpoints`
 * entry when it is non-blank (a proxy override wins even over a known URL),
 * else the catalog entry's own base URL, else undefined.
 */
export function resolveProviderEndpoint(
  info: ProviderInfo,
  settings: ProviderSettings,
): string | undefined {
  const user = settings.getProviderEndpoint(info.id)?.trim();
  return user !== undefined && user.length > 0 ? user : info.defaultBaseUrl;
}

/**
 * The per-provider OpenAI-compatible client wiring as a pure function, so the
 * wiring is assertable without reaching into {@link OpenAiModelClient}'s
 * private state.
 *
 * Branches on `id`'s catalog entry (resolved against `deps.catalog` when
 * given, so feed providers are known):
 * - `openai` reads the `baiton.orchestrator.endpoint` setting; every other
 *   provider reads its `baiton.orchestrator.endpoints` entry and falls back to
 *   the catalog base URL (see {@link resolveProviderEndpoint}), both at call
 *   time;
 * - every provider reads its model through the injected `getModel` at call
 *   time so a switch needs no new client; `openai` additionally falls back to
 *   the `baiton.orchestrator.model` setting;
 * - the API key is read and trimmed from `baiton.orchestrator.key.<id>` at
 *   call time;
 * - the catalog's dialect applies (`google` gets the Gemini wire shaping) and
 *   the header style (`opencode` gets the OpenCode User-Agent / session
 *   headers, built ONCE per client so the `x-opencode-session` uuid stays
 *   stable per conversation);
 * - streaming and `max_tokens` pass through unchanged.
 *
 * Calling it with `id === 'copilot'` is a programmer error: Copilot is built
 * separately (see {@link ProviderRouter}).
 */
export function providerClientConfig(id: ProviderId, deps: ClientConfigDeps): ModelClientConfig {
  if (id === 'copilot') {
    throw new Error('copilot has no OpenAI-compatible client config');
  }
  const resolve = (): ProviderInfo => providerInfo(id, deps.catalog?.());
  // Dialect and header style are fixed per client (the OpenCode session uuid
  // must stay stable), so they come from the entry known at construction.
  const info: ProviderInfo = resolve();
  const config: ModelClientConfig = {
    getEndpoint: info.usesSettings
      ? () => deps.settings.getEndpoint() || undefined
      : () => resolveProviderEndpoint(resolve(), deps.settings),
    getModel: info.usesSettings
      ? () => deps.getModel() ?? (deps.settings.getModel() || undefined)
      : () => deps.getModel(),
    getApiKey: async () => {
      const key = providerSecretKey(id);
      return key === undefined ? undefined : (await deps.secrets.get(key))?.trim() || undefined;
    },
    isStreaming: () => deps.settings.isStreaming(),
    getMaxTokens: () => deps.settings.getMaxTokens(),
    dialect: dialectFor(info.dialect),
  };
  if (info.headerStyle === 'opencode') {
    config.extraHeaders = openCodeExtraHeaders({ version: deps.version });
  }
  return config;
}

/** Renders an error's message without assuming it is an `Error` instance. */
function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Reads a secret as "has a usable value": a string with non-whitespace content. */
function hasKey(value: string | undefined | null): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * The first configured provider that offers at least one model, or undefined
 * when no provider is currently usable. Walks an already computed
 * `availability()` result in catalog order (builtins, then feed-only
 * providers, `openai` last), which is already filtered to the configured ones
 * and already carries each entry's models — so the caller's single
 * availability read serves both its enabled check and this fallback.
 */
function firstUsableSelection(
  available: readonly ProviderAvailability[],
): ModelSelection | undefined {
  for (const entry of available) {
    const model = entry.models[0];
    if (model !== undefined) {
      return { provider: entry.id, model };
    }
  }
  return undefined;
}

/**
 * The orchestrator's provider router: one client per provider, the active
 * {@link ModelSelection} persisted under `MODEL_SELECTION_KEY`, a change
 * event, availability enumeration, and the routing `complete()` every
 * consumer already calls.
 */
export class ProviderRouter implements ModelClient {
  private readonly config: ProviderRouterConfig;
  /** Lazily built clients, one per provider id, memoised for the router's life. */
  private readonly clients = new Map<ProviderId, ModelClient>();
  /** The active selection, `undefined` until `init`/`select` resolves one. */
  private selected: ModelSelection | undefined;
  /**
   * A persisted (or previously active) selection whose provider is not
   * configured in this window: kept in memory, deliberately NOT written over
   * in `workspaceState`, and restored by {@link refresh} the moment its
   * provider becomes configured again (a key stored, an endpoint set, Copilot
   * signed in). Its provider is enumerated by {@link catalogEntries} so it
   * keeps an availability entry of its own even after leaving the feed.
   */
  private preserved: ModelSelection | undefined;
  /** The model last chosen per provider, so switching provider and back restores it. */
  private readonly lastModel = new Map<ProviderId, string>();
  /** Selection listeners, fired once per real change. */
  private readonly listeners = new Set<(s: ModelSelection | undefined) => void>();
  /**
   * Memoised API-key presence per SecretStorage key, populated only while
   * {@link secretsSub} exists (the storage can tell us when a key changes).
   * A read that throws is never recorded, so the next call retries it.
   */
  private readonly keyPresence = new Map<string, boolean>();
  /**
   * The in-flight presence read per SecretStorage key, shared while the memo
   * is live. Two catalog entries can resolve to ONE slot (`opencode-go`
   * aliases `opencode`, see `PROVIDER_SECRET_ALIAS`) and `computeAll` reads
   * every entry concurrently, so without this both would hit SecretStorage
   * before either memoised — breaking the one-read-per-key guarantee.
   */
  private readonly keyReads = new Map<string, Promise<boolean>>();
  /**
   * Bumped on every invalidation, so a `get` that was in flight when a key
   * changed does not record its (possibly stale) answer.
   */
  private secretsEpoch = 0;
  /** The `secrets.onDidChange` subscription, when the storage offers one. */
  private readonly secretsSub: { dispose(): void } | undefined;
  /** Set by {@link dispose}: nothing is memoised once the subscription is gone. */
  private disposed = false;

  constructor(config: ProviderRouterConfig) {
    this.config = config;
    const secrets = config.secrets;
    this.secretsSub =
      typeof secrets.onDidChange === 'function'
        ? secrets.onDidChange((e) => this.forgetSecret(e.key))
        : undefined;
  }

  /**
   * Drops the memoised presence of one SecretStorage key so the next
   * availability read goes back to `secrets.get`. Driven by
   * `secrets.onDidChange`; also reachable through {@link forgetProviderKey}.
   */
  private forgetSecret(key: string): void {
    this.secretsEpoch++;
    this.keyPresence.delete(key);
    this.keyReads.delete(key);
  }

  /**
   * Drops the memoised key presence of provider `id`. The host calls this
   * right after it stores or clears that provider's key and before
   * {@link refresh}, so the refresh sees the new key even when the storage's
   * own change event has not been delivered yet. A no-op for `copilot`.
   */
  public forgetProviderKey(id: ProviderId): void {
    const key = providerSecretKey(id);
    if (key !== undefined) {
      this.forgetSecret(key);
    }
  }

  /**
   * Releases the `secrets.onDidChange` subscription and the key-presence
   * memo. The router stays usable afterwards; it simply reads SecretStorage
   * on every call again.
   */
  public dispose(): void {
    this.secretsSub?.dispose();
    this.keyPresence.clear();
    this.keyReads.clear();
    this.secretsEpoch++;
    this.disposed = true;
  }

  /**
   * Whether `key` holds a usable API key (see {@link hasKey}), answered from
   * {@link keyPresence} when memoised and otherwise read from SecretStorage
   * and memoised — only while the change subscription is live, and only when
   * no invalidation landed during the read. A read that throws counts as "no
   * key", is logged under `label`, and is NOT memoised, so the next call
   * retries it.
   */
  private async hasStoredKey(key: string, label: string): Promise<boolean> {
    const cached = this.keyPresence.get(key);
    if (cached !== undefined) {
      return cached;
    }
    if (this.secretsSub === undefined || this.disposed) {
      return this.readStoredKey(key, label);
    }
    const pending = this.keyReads.get(key);
    if (pending !== undefined) {
      return pending;
    }
    const read = this.readStoredKey(key, label).finally(() => {
      if (this.keyReads.get(key) === read) {
        this.keyReads.delete(key);
      }
    });
    this.keyReads.set(key, read);
    return read;
  }

  /** One SecretStorage read behind {@link hasStoredKey}; memoises per its rules. */
  private async readStoredKey(key: string, label: string): Promise<boolean> {
    const epoch = this.secretsEpoch;
    try {
      const present = hasKey(await this.config.secrets.get(key));
      if (this.secretsSub !== undefined && !this.disposed && epoch === this.secretsEpoch) {
        this.keyPresence.set(key, present);
      }
      return present;
    } catch (err) {
      // A SecretStorage read that throws counts as "no key"; never propagate.
      this.config.log?.(`Baiton: reading the ${label} API key failed: ${describe(err)}`);
      return false;
    }
  }

  /**
   * The model id currently chosen for `id`: the active selection's model when
   * `id` is the active provider, else the model last chosen for `id`, else the
   * catalog default. For `openai` an unset choice falls through to the
   * `baiton.orchestrator.model` setting. Read at call time by every client,
   * so a model switch needs no new client.
   */
  public modelFor(id: ProviderId): string | undefined {
    const chosen =
      this.selected?.provider === id
        ? this.selected.model
        : this.lastModel.get(id) ?? defaultModelFor(id, this.catalogEntries());
    if (chosen !== undefined) {
      return chosen;
    }
    return id === 'openai' ? this.config.settings.getModel() || undefined : undefined;
  }

  /** The client for `id`, built on first use and memoised thereafter. */
  private clientFor(id: ProviderId): ModelClient {
    let client = this.clients.get(id);
    if (client === undefined) {
      if (this.config.createClient !== undefined) {
        client = this.config.createClient(id, this);
      } else if (id === 'copilot') {
        client = new CopilotModelClient({
          api: this.config.lm,
          getModel: () => this.modelFor('copilot'),
        });
      } else {
        client = new OpenAiModelClient(
          providerClientConfig(id, {
            secrets: this.config.secrets,
            settings: this.config.settings,
            version: this.config.version,
            getModel: () => this.modelFor(id),
            catalog: () => this.catalogEntries(),
          }),
        );
      }
      this.clients.set(id, client);
    }
    return client;
  }

  /** The active selection, `undefined` when nothing valid has been resolved yet. */
  public getSelection(): ModelSelection | undefined {
    return this.selected;
  }

  /** The active provider's id, `undefined` when nothing is selected. */
  public activeProvider(): ProviderId | undefined {
    return this.selected?.provider;
  }

  /**
   * Restores the persisted selection or picks the first usable provider.
   *
   * A stored selection is restored as-is when its provider is configured in
   * this window; the stored MODEL is deliberately not validated against the
   * refreshed list, so a model that has left the feed stays selected and is
   * surfaced through {@link ProviderAvailability.customModels}.
   *
   * A stored selection whose provider is NOT configured right now is kept in
   * {@link preserved} and never written over: routing falls back to the first
   * configured provider, and a later {@link refresh} hands the user's choice
   * back the moment its key/endpoint/Copilot returns. Only an absent or
   * malformed blob — nothing worth protecting — takes the old path of
   * persisting the fallback.
   *
   * Runs on the activation path, so every failure is swallowed and logged —
   * activation must not break here (matching `migrateLegacyApiKey`). Does not
   * fire the change event: nothing has changed for a listener that has not
   * subscribed yet.
   */
  public async init(): Promise<void> {
    try {
      const stored = normalizeModelSelection(this.config.workspaceState.get(MODEL_SELECTION_KEY));
      // Set before availability is read so `catalogEntries()` enumerates the
      // stored provider even when it is absent from both feed and snapshot.
      this.preserved = stored;
      // ONE availability read serves both the enabled check and the fallback.
      const available = await this.availability();
      const enabled = available.map((a) => a.id);
      if (stored !== undefined && enabled.includes(stored.provider)) {
        // A configured persisted selection: restored as-is, no rewrite needed
        // (the stored blob already matches).
        this.selected = stored;
        this.preserved = undefined;
      } else if (stored !== undefined) {
        // A real choice whose provider is unconfigured in this window: keep it
        // in memory, route through the fallback, and persist NOTHING so the
        // user's blob survives the reload.
        this.selected = firstUsableSelection(available);
      } else {
        // Absent or malformed blob: fall back to the first enabled provider
        // whose first model exists, and persist it so the next window restores it.
        const fallback = firstUsableSelection(available);
        if (fallback !== undefined) {
          this.selected = fallback;
          await this.config.workspaceState.update(MODEL_SELECTION_KEY, fallback);
        }
      }
      if (this.selected !== undefined) {
        this.lastModel.set(this.selected.provider, this.selected.model);
      }
      if (this.preserved !== undefined) {
        // So the preserved model reappears in its provider's list.
        this.lastModel.set(this.preserved.provider, this.preserved.model);
      }
    } catch (err) {
      this.config.log?.(`Baiton: provider router init failed: ${describe(err)}`);
      this.selected = undefined;
      this.preserved = undefined;
    }
  }

  /**
   * Re-reads availability after something outside the router changed it — an
   * API key stored or cleared, Copilot sign-in, a landed catalog refresh.
   *
   * A {@link preserved} selection wins first: as soon as its provider is
   * configured again the user's own choice comes back, with nothing persisted
   * (the stored blob already equals it). Otherwise, when nothing is selected
   * or the active provider is no longer enabled, the selection is re-resolved
   * — an active selection displaced this way becomes the new `preserved` and
   * the fallback is NOT persisted, so it too returns later; only a
   * re-resolution with no selection to protect persists its fallback. Either
   * way the change event fires exactly once so the Chat view repaints its
   * Provider & Model dropdown. A listener must therefore tolerate an event
   * whose selection did not actually change. Every failure is swallowed and
   * logged: this runs off a command handler and must never reject.
   */
  public async refresh(): Promise<void> {
    try {
      // ONE availability read serves both the enabled check and the fallback.
      const available = await this.availability();
      const enabled = available.map((a) => a.id);
      const preserved = this.preserved;
      if (preserved !== undefined && enabled.includes(preserved.provider)) {
        this.selected = preserved;
        this.lastModel.set(preserved.provider, preserved.model);
        this.preserved = undefined;
      } else {
        const active = this.selected;
        if (active === undefined || !enabled.includes(active.provider)) {
          const next = firstUsableSelection(available);
          this.selected = next;
          if (next !== undefined) {
            this.lastModel.set(next.provider, next.model);
          }
          if (active !== undefined) {
            // The user's choice is only displaced, never overwritten.
            this.preserved = active;
          } else if (next !== undefined) {
            await this.config.workspaceState.update(MODEL_SELECTION_KEY, next);
          }
        }
      }
    } catch (err) {
      this.config.log?.(`Baiton: refreshing provider availability failed: ${describe(err)}`);
    }
    this.fire();
  }

  /**
   * Switches the active provider/model.
   *
   * Malformed input (unknown provider, empty model) returns `false` without
   * touching state. A repeat of the identical selection returns `true` and
   * changes nothing. Otherwise the selection is set, the per-provider model
   * memory is updated, the choice is persisted (a rejected persist is logged
   * but still applied in memory so the UI does not desync), and the change
   * event fires. Clients are NOT rebuilt: each reads its model through
   * {@link modelFor} at call time. A successful switch also clears
   * {@link preserved} when it names the same provider: the user has spoken.
   */
  public async select(value: unknown): Promise<boolean> {
    const next = normalizeModelSelection(value);
    if (next === undefined) {
      return false;
    }
    if (sameModelSelection(next, this.selected)) {
      return true;
    }
    this.selected = next;
    this.lastModel.set(next.provider, next.model);
    if (this.preserved?.provider === next.provider) {
      // The user has spoken about this provider; nothing left to restore.
      this.preserved = undefined;
    }
    try {
      await this.config.workspaceState.update(MODEL_SELECTION_KEY, next);
    } catch (err) {
      this.config.log?.(
        `Baiton: persisting the model selection failed: ${describe(err)}`,
      );
    }
    this.fire();
    return true;
  }

  /**
   * Subscribes to selection changes. The returned handle removes the
   * listener on `dispose()`. A throwing listener is logged and skipped so it
   * cannot break a provider switch for the others. A listener must tolerate a
   * call whose selection is unchanged: `refresh()` fires even when re-reading
   * availability changed nothing, so the view still repaints.
   */
  public onDidChangeSelection(listener: (s: ModelSelection | undefined) => void): {
    dispose(): void;
  } {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  /** Fires the change event once, defensively, with a copy of the listener set. */
  private fire(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(this.selected);
      } catch (err) {
        this.config.log?.(`Baiton: a selection listener threw: ${describe(err)}`);
      }
    }
  }

  /**
   * The CONFIGURED providers' availability, in catalog order, recomputed on
   * every call because keys, Copilot sign-in and the catalog itself change out
   * of band. API-key presence alone may come from the per-key memo, which
   * `secrets.onDidChange` keeps current (see {@link SecretsLike}).
   *
   * "Configured" means: a keyed provider with a stored key and a resolvable
   * endpoint (see {@link resolveProviderEndpoint}), `openai` with both
   * a key and a `baiton.orchestrator.endpoint`, `copilot` when `vscode.lm`
   * enumerates at least one model. Every returned entry therefore has
   * `enabled: true` and no `reason`; the ones left out are
   * {@link hiddenProviders}.
   */
  public async availability(): Promise<ProviderAvailability[]> {
    return (await this.computeAll()).filter((a) => a.enabled);
  }

  /**
   * Exactly the entries {@link availability} omits — the providers the
   * dropdown hides — each carrying the `reason` it is unusable
   * (`providerNeedsKeyReason(id)`, `providerNeedsEndpointReason(id)`,
   * {@link PROVIDER_NEEDS_ENDPOINT_REASON} or {@link COPILOT_UNAVAILABLE_REASON}). This is the list the Set-API-key
   * quick pick offers, so a provider can be configured before it can appear.
   */
  public async hiddenProviders(): Promise<ProviderAvailability[]> {
    return (await this.computeAll()).filter((a) => !a.enabled);
  }

  /** The ids of the currently configured providers, in catalog order. */
  public async enabledProviders(): Promise<ProviderId[]> {
    const all = await this.availability();
    return all.filter((a) => a.enabled).map((a) => a.id);
  }

  /**
   * The model ids currently offered by `id`, whether or not `id` is
   * configured: the chat view asks for the active provider's models even
   * mid-clear, so this resolves the entry directly rather than searching the
   * filtered {@link availability} list.
   */
  public async modelsFor(id: ProviderId): Promise<readonly string[]> {
    const entry = await this.computeEntry(providerInfo(id, this.catalogEntries()));
    return entry.models;
  }

  /**
   * Every provider this window knows about, in dropdown order.
   *
   * The feed-merged catalog first ({@link buildProviderCatalog}; with no feed
   * this is byte-identical to the six builtin entries), then — skipping ids
   * already present — every distinct provider of the models.dev snapshot in
   * snapshot order, then the active and preserved selections' providers.
   *
   * The snapshot pass is the OFFLINE path: the snapshot is persisted but the
   * feed is not, so a window whose fetch has not landed yet still enumerates
   * every provider the cached snapshot knows. Those entries come from
   * {@link providerInfo}'s synthesised `source: 'custom'` fallback
   * (`label === id`, `requiresKey: true`, no base URL) because the snapshot
   * stores no provider label; labels upgrade as soon as the refresh lands.
   * The selection pass keeps a persisted id that has left the feed enumerated
   * rather than dropping it.
   */
  private catalogEntries(): readonly ProviderInfo[] {
    const entries = [...buildProviderCatalog(this.config.catalog?.feed())];
    const seen = new Set<string>(entries.map((entry) => entry.id));
    const append = (id: ProviderId | undefined): void => {
      if (id === undefined || id.length === 0 || seen.has(id)) {
        return;
      }
      seen.add(id);
      entries.push(providerInfo(id));
    };
    for (const model of this.config.catalog?.snapshot()?.models ?? []) {
      append(model.provider);
    }
    append(this.selected?.provider);
    append(this.preserved?.provider);
    return entries;
  }

  /**
   * The ids of the models.dev snapshot's models belonging to `id`,
   * de-duplicated, in snapshot order.
   */
  private snapshotModelsFor(id: ProviderId): readonly string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const model of this.config.catalog?.snapshot()?.models ?? []) {
      if (model.provider !== id || seen.has(model.id)) {
        continue;
      }
      seen.add(model.id);
      out.push(model.id);
    }
    return out;
  }

  /**
   * One provider's model list: the models.dev snapshot's list when it has one,
   * else the catalog entry's own (builtin, or feed-merged) list.
   */
  private modelsForInfo(info: ProviderInfo): { models: readonly string[]; fromSnapshot: boolean } {
    const fromSnapshot = this.snapshotModelsFor(info.id);
    return fromSnapshot.length > 0
      ? { models: fromSnapshot, fromSnapshot: true }
      : { models: info.models, fromSnapshot: false };
  }

  /**
   * Append to `models`, at the END and without reordering the catalog ids,
   * every model this router must keep selectable for `id` that the list does
   * not already carry: the active selection's model, the preserved selection's
   * model, and the model last chosen for `id`. Values are trimmed, and blanks
   * and duplicates (exact, case-sensitive match) are skipped — the same
   * semantics as `mergePreservingExisting` in src/orchestrator/modelCatalog.ts,
   * applied to a bare id list. The appended ids are the entry's
   * {@link ProviderAvailability.customModels}.
   */
  private preserveInto(
    id: ProviderId,
    models: readonly string[],
  ): { models: readonly string[]; customModels: readonly string[] } {
    const existing = new Set(models);
    const customModels: string[] = [];
    const candidates: Array<string | undefined> = [
      this.selected?.provider === id ? this.selected.model : undefined,
      this.preserved?.provider === id ? this.preserved.model : undefined,
      this.lastModel.get(id),
    ];
    for (const candidate of candidates) {
      const trimmed = candidate?.trim() ?? '';
      if (trimmed.length === 0 || existing.has(trimmed)) {
        continue;
      }
      existing.add(trimmed);
      customModels.push(trimmed);
    }
    return customModels.length === 0
      ? { models, customModels }
      : { models: [...models, ...customModels], customModels };
  }

  /** Every provider's entry, configured or not, from ONE catalog build. */
  private async computeAll(): Promise<ProviderAvailability[]> {
    return Promise.all(this.catalogEntries().map((info) => this.computeEntry(info)));
  }

  /**
   * One resolved catalog entry's availability, branched on its id: `copilot`
   * through `vscode.lm`, `openai` through key + endpoint + the
   * `baiton.orchestrator.model` setting, and every other id keyed on its
   * SecretStorage slot plus a resolvable endpoint (its
   * `baiton.orchestrator.endpoints` entry or catalog base URL), with the
   * catalog/snapshot model list. Snapshot-backed
   * models additionally carry the snapshot's `fetchedAt` and, when it is
   * stale, `stale` + `staleReason`; the keys stay ABSENT otherwise.
   */
  private async computeEntry(info: ProviderInfo): Promise<ProviderAvailability> {
    const id = info.id;
    let base: ProviderAvailability;
    let fromSnapshot = false;
    if (id === 'copilot') {
      // Enumerated live by the host, never from the catalog: never stale.
      base = await this.copilotAvailability();
    } else if (id === 'openai') {
      // Models come from the `baiton.orchestrator.model` setting: never stale.
      base = await this.openAiAvailability(info);
    } else {
      const hasApiKey = await this.hasStoredKey(providerSecretKey(id)!, info.label);
      // Key first, then endpoint, so the reported reason is deterministic
      // (the same order as `openai`). A `source: 'custom'` entry is one the
      // feed has not described yet (offline, snapshot only): its base URL is
      // unknown rather than absent, so it is not reported as endpoint-less —
      // the landed feed or a completion's own MissingConfigError says more.
      const needsEndpoint =
        hasApiKey &&
        info.source !== 'custom' &&
        resolveProviderEndpoint(info, this.config.settings) === undefined;
      const resolved = this.modelsForInfo(info);
      fromSnapshot = resolved.fromSnapshot;
      const enabled = hasApiKey && !needsEndpoint;
      // `[info]` is the resolved entry itself, so the reason names this
      // catalog's label without rebuilding the catalog per provider.
      const reason = !hasApiKey
        ? providerNeedsKeyReason(id, [info])
        : needsEndpoint
          ? providerNeedsEndpointReason(id, [info])
          : undefined;
      base = {
        id,
        label: info.label,
        enabled,
        ...(reason !== undefined ? { reason } : {}),
        models: resolved.models,
      };
    }
    const preserved = this.preserveInto(id, base.models);
    const entry: ProviderAvailability = { ...base, models: preserved.models };
    const snapshot = fromSnapshot ? this.config.catalog?.snapshot() : undefined;
    if (snapshot !== undefined) {
      entry.fetchedAt = snapshot.fetchedAt;
      if (snapshot.stale === true) {
        entry.stale = true;
        if (snapshot.staleReason !== undefined) {
          entry.staleReason = snapshot.staleReason;
        }
      }
    }
    if (preserved.customModels.length > 0) {
      entry.customModels = preserved.customModels;
    }
    return entry;
  }

  /**
   * Copilot availability: the ids of the chat models `vscode.lm` enumerates
   * for the Copilot vendor, de-duplicated in the order returned. An empty
   * list or a rejected enumeration both report
   * {@link COPILOT_UNAVAILABLE_REASON} rather than throwing.
   */
  private async copilotAvailability(): Promise<ProviderAvailability> {
    let models: string[] = [];
    try {
      const chatModels = await this.config.lm.lm.selectChatModels({ vendor: COPILOT_VENDOR });
      const seen = new Set<string>();
      for (const chat of chatModels ?? []) {
        if (typeof chat.id === 'string' && chat.id.length > 0 && !seen.has(chat.id)) {
          seen.add(chat.id);
          models.push(chat.id);
        }
      }
    } catch (err) {
      this.config.log?.(`Baiton: enumerating Copilot models failed: ${describe(err)}`);
      models = [];
    }
    const enabled = models.length > 0;
    return {
      id: 'copilot',
      label: PROVIDERS.copilot.label,
      enabled,
      ...(enabled ? {} : { reason: COPILOT_UNAVAILABLE_REASON }),
      models,
    };
  }

  /**
   * OpenAI / Custom availability: needs BOTH a stored key and a non-empty
   * `baiton.orchestrator.endpoint`. The key is checked first so the reported
   * reason is deterministic. Models come from the
   * `baiton.orchestrator.model` setting (one entry when set, none otherwise).
   */
  private async openAiAvailability(info: ProviderInfo): Promise<ProviderAvailability> {
    const hasApiKey = await this.hasStoredKey(providerSecretKey('openai')!, info.label);
    if (!hasApiKey) {
      return {
        id: 'openai',
        label: info.label,
        enabled: false,
        reason: providerNeedsKeyReason('openai'),
        models: [],
      };
    }
    const endpoint = this.config.settings.getEndpoint();
    if (!hasKey(endpoint)) {
      return {
        id: 'openai',
        label: info.label,
        enabled: false,
        reason: PROVIDER_NEEDS_ENDPOINT_REASON,
        models: [],
      };
    }
    const model = this.config.settings.getModel();
    const models = hasKey(model) ? [model as string] : [];
    return { id: 'openai', label: info.label, enabled: true, models };
  }

  /**
   * Routes one completion to the active provider's client.
   *
   * The request object is forwarded BY REFERENCE and unmodified — `messages`,
   * `tools`, `signal`, `sessionId` and `onDelta` all reach the underlying
   * client untouched, so the OpenCode session header and streaming deltas
   * behave exactly as their own suites pin them. Errors from the delegate
   * propagate unwrapped: `MissingConfigError` / `UnreachableEndpointError`
   * are what the controller's inline-error path branches on. The provider is
   * resolved per call, so a `select()` between two completions routes the
   * next one to the new provider with no re-wiring of the callers.
   */
  public async complete(req: CompletionRequest): Promise<CompletionResult> {
    const selection = this.selected;
    if (selection === undefined) {
      throw new MissingConfigError('model');
    }
    return this.clientFor(selection.provider).complete(req);
  }
}
