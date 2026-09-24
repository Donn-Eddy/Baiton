/**
 * The host-side ProviderRouter (multi-provider orchestrator).
 *
 * One router owns a lazily-memoised client per provider: an
 * {@link OpenAiModelClient} configured from the catalog for the four
 * OpenAI-compatible providers, and a {@link CopilotModelClient} speaking
 * `vscode.lm` for `copilot`. Availability (API keys in SecretStorage, the
 * `baiton.orchestrator.endpoint` setting, Copilot model enumeration) is
 * recomputed on every `availability()` call because keys and Copilot sign-in
 * change out of band. The active {@link ModelSelection} round-trips through
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
  PROVIDER_IDS,
  ProviderId,
  ProviderInfo,
  COPILOT_UNAVAILABLE_REASON,
  PROVIDER_NEEDS_ENDPOINT_REASON,
  defaultModelFor,
  normalizeModelSelection,
  providerInfo,
  providerNeedsKeyReason,
  providerSecretKey,
  sameModelSelection,
} from '../orchestrator/providers';

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
 * needed: the router never writes secrets.
 */
export interface SecretsLike {
  get(key: string): Thenable<string | undefined> | string | undefined;
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
  /** `baiton.orchestrator.model` — the OpenAI / Custom model id. */
  getModel: () => string | undefined;
  /** `baiton.orchestrator.streaming` — whether the endpoint advertises streaming. */
  isStreaming: () => boolean;
  /** `baiton.orchestrator.maxTokens` — passed through; `resolveMaxTokens` already normalises. */
  getMaxTokens: () => unknown;
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
}

/** Everything {@link providerClientConfig} needs beyond the provider id. */
export interface ClientConfigDeps {
  secrets: SecretsLike;
  settings: ProviderSettings;
  version: string;
  /** Resolves the model id currently chosen for this provider. */
  getModel: () => string | undefined;
}

/**
 * The per-provider OpenAI-compatible client wiring as a pure function, so the
 * wiring is assertable without reaching into {@link OpenAiModelClient}'s
 * private state.
 *
 * Branches on `id`'s catalog entry:
 * - providers with a catalog base URL use it verbatim; `openai` reads the
 *   `baiton.orchestrator.endpoint` setting instead;
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
  const info: ProviderInfo = providerInfo(id);
  const config: ModelClientConfig = {
    getEndpoint: info.usesSettings
      ? () => deps.settings.getEndpoint() || undefined
      : () => info.defaultBaseUrl,
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
  /** The model last chosen per provider, so switching provider and back restores it. */
  private readonly lastModel = new Map<ProviderId, string>();
  /** Selection listeners, fired once per real change. */
  private readonly listeners = new Set<(s: ModelSelection | undefined) => void>();

  constructor(config: ProviderRouterConfig) {
    this.config = config;
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
        : this.lastModel.get(id) ?? defaultModelFor(id);
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
   * A stored selection is kept only when it normalises to a known provider
   * with a non-empty model that is currently enabled; anything else falls
   * back to the first enabled provider with a model, and that fallback is
   * persisted. Runs on the activation path, so every failure is swallowed and
   * logged — activation must not break here (matching
   * `migrateLegacyApiKey`). Does not fire the change event: nothing has
   * changed for a listener that has not subscribed yet.
   */
  public async init(): Promise<void> {
    try {
      const stored = this.config.workspaceState.get(MODEL_SELECTION_KEY);
      const restored = normalizeModelSelection(stored);
      const enabled = await this.enabledProviders();
      if (
        restored !== undefined &&
        enabled.includes(restored.provider) &&
        restored.model.trim().length > 0
      ) {
        // A valid persisted selection: restored as-is, no rewrite needed
        // (the stored blob already matches).
        this.selected = restored;
      } else {
        // Fall back to the first enabled provider whose first model exists,
        // and persist that fallback so the next window restores it.
        for (const id of PROVIDER_IDS) {
          if (!enabled.includes(id)) {
            continue;
          }
          const models = await this.modelsFor(id);
          const model = models[0];
          if (model !== undefined) {
            const fallback: ModelSelection = { provider: id, model };
            this.selected = fallback;
            await this.config.workspaceState.update(MODEL_SELECTION_KEY, fallback);
            break;
          }
        }
      }
      if (this.selected !== undefined) {
        this.lastModel.set(this.selected.provider, this.selected.model);
      }
    } catch (err) {
      this.config.log?.(`Baiton: provider router init failed: ${describe(err)}`);
      this.selected = undefined;
    }
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
   * {@link modelFor} at call time.
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
   * cannot break a provider switch for the others.
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
   * Every provider's availability, one entry per id in
   * {@link PROVIDER_IDS} order, recomputed on every call because keys and
   * Copilot sign-in change out of band.
   */
  public async availability(): Promise<ProviderAvailability[]> {
    return Promise.all(PROVIDER_IDS.map((id) => this.availabilityOf(id)));
  }

  /** The ids of the currently enabled providers, in catalog order. */
  public async enabledProviders(): Promise<ProviderId[]> {
    const all = await this.availability();
    return all.filter((a) => a.enabled).map((a) => a.id);
  }

  /** The model ids currently offered by `id`. */
  public async modelsFor(id: ProviderId): Promise<readonly string[]> {
    const entry = await this.availabilityOf(id);
    return entry.models;
  }

  /** One provider's availability entry, branched on its id. */
  private async availabilityOf(id: ProviderId): Promise<ProviderAvailability> {
    if (id === 'copilot') {
      return this.copilotAvailability();
    }
    const info = providerInfo(id);
    if (id === 'openai') {
      return this.openAiAvailability(info);
    }
    // google / mistral / opencode: catalog models, gated on the secret key.
    const key = providerSecretKey(id)!;
    let enabled = false;
    try {
      enabled = hasKey(await this.config.secrets.get(key));
    } catch (err) {
      // A SecretStorage read that throws counts as "no key"; never propagate.
      this.config.log?.(`Baiton: reading the ${info.label} API key failed: ${describe(err)}`);
    }
    return {
      id,
      label: info.label,
      enabled,
      ...(enabled ? {} : { reason: providerNeedsKeyReason(id) }),
      models: info.models,
    };
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
    const key = providerSecretKey('openai')!;
    let hasApiKey = false;
    try {
      hasApiKey = hasKey(await this.config.secrets.get(key));
    } catch (err) {
      this.config.log?.(`Baiton: reading the ${info.label} API key failed: ${describe(err)}`);
    }
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
