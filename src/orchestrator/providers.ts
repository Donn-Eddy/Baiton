/**
 * The orchestrator's provider catalog (host-free core).
 *
 * This module is the single source of truth for the inference providers the
 * orchestrator can talk to: their ids, dropdown order, human labels, default
 * OpenAI-compatible base URLs, per-provider SecretStorage key names, built-in
 * model lists and the persisted {@link ModelSelection}. It carries no `vscode`
 * import and touches no host API, so the host glue and the unit tests both
 * consume this same contract — like src/orchestrator/webviewProtocol.ts.
 */

import type { ModelsDevFeed, FeedProvider } from './modelsDev';

/**
 * One orchestrator inference provider, keyed by its stable id.
 *
 * Any non-empty provider id: a builtin ({@link BuiltinProviderId}), a
 * models.dev-derived id, or a persisted id whose provider has since vanished
 * from the feed. Membership is validated at the router, never at parse time —
 * see {@link normalizeModelSelection}.
 */
export type ProviderId = string;

/** The providers this build ships without any feed: the offline/builtin base. */
export type BuiltinProviderId = 'copilot' | 'google' | 'opencode' | 'mistral' | 'openai';

/** The builtin vocabulary, in dropdown order. */
export const BUILTIN_PROVIDER_IDS: readonly BuiltinProviderId[] = [
  'copilot',
  'google',
  'opencode',
  'mistral',
  'openai',
] as const;

/** Dropdown order, top to bottom. Same value and order as {@link BUILTIN_PROVIDER_IDS}. */
export const PROVIDER_IDS = BUILTIN_PROVIDER_IDS;

/**
 * True when `value` is one of the builtin provider ids.
 *
 * Deliberately narrow: src/activation/commands.ts uses it to decide whether a
 * command argument names a provider, so an arbitrary string must not pass. The
 * open check is {@link isProviderIdLike}.
 */
export function isProviderId(value: unknown): value is BuiltinProviderId {
  return typeof value === 'string' && (BUILTIN_PROVIDER_IDS as readonly string[]).includes(value);
}

/**
 * True when `value` could be any provider id at all — a string that trims to
 * non-empty. This is the open check used by {@link normalizeModelSelection}: a
 * feed-derived or vanished provider id is still a usable selection.
 */
export function isProviderIdLike(value: unknown): value is ProviderId {
  return typeof value === 'string' && value.trim().length > 0;
}

/** One catalog entry: how a provider is labelled, reached and keyed. */
export interface ProviderInfo {
  /** Stable id, also the suffix of the SecretStorage key. */
  id: ProviderId;
  /** Human label shown as the <optgroup> label in the Chat dropdown. */
  label: string;
  /** Default OpenAI-compatible base URL, or undefined when the provider is not HTTP-based (`copilot`) or takes its base URL from settings (`openai`). */
  defaultBaseUrl?: string;
  /** True when the provider needs an API key in SecretStorage before it can be used. */
  requiresKey: boolean;
  /** True when endpoint/model come from the `baiton.orchestrator.endpoint` / `baiton.orchestrator.model` settings rather than this catalog (`openai` only). */
  usesSettings: boolean;
  /** Built-in model ids offered in the dropdown; empty means "enumerate at runtime / free text". */
  models: readonly string[];
  /** The wire shaping applied to messages before serialisation; `gemini` fixes Google's tool-chaining rejections. */
  dialect: DialectId;
  /** Extra headers added to every request; `opencode` adds User-Agent and x-opencode-session. */
  headerStyle: HeaderStyleId;
  /** Where the entry came from; a missing value is treated as `'builtin'`. */
  readonly source?: 'builtin' | 'feed' | 'custom';
  /** Environment variables the provider reads, carried through from the feed. */
  readonly env?: readonly string[];
  /** The provider's documentation URL, carried through from the feed. */
  readonly doc?: string;
}

/** Which wire shaping a provider's OpenAI-compatible payload needs. */
export type DialectId = 'openai' | 'gemini';

/** Which extra request headers a provider needs beyond the OpenAI defaults. */
/**
 * The catalog has no `extraHeadersFor(style)` counterpart that would build an
 * {@link ExtraHeadersProvider} from a `HeaderStyleId` alone: the OpenCode
 * header provider needs the extension version at construction time, an
 * argument a host-free catalog cannot supply. The host glue branches on the
 * catalog field by hand and calls `openCodeExtraHeaders({ version })`
 * (src/orchestrator/modelClient.ts) for the `'opencode'` style itself.
 */
export type HeaderStyleId = 'default' | 'opencode';

/**
 * The builtin provider catalog, one record per {@link BuiltinProviderId}.
 *
 * This is the offline base and the legacy-id compatibility set: when the
 * models.dev feed is unavailable the catalog still offers exactly these five
 * providers, and the legacy ids `google`/`mistral`/`opencode` keep their
 * `baiton.orchestrator.key.<id>` secrets.
 *
 * Base URLs are the prefix `completionsUrl()` (src/orchestrator/modelClient.ts)
 * appends `/chat/completions` to: `normalizeBase` strips every trailing slash
 * first, so the Google base's trailing slash is harmless rather than required —
 * do not add `/chat/completions` by hand.
 */
export const PROVIDERS: Readonly<Record<BuiltinProviderId, ProviderInfo>> = {
  // Enumerated at runtime through `vscode.lm.selectChatModels({ vendor: 'copilot' })`;
  // the catalog deliberately carries no model ids and needs no API key or HTTP base.
  copilot: {
    id: 'copilot',
    label: 'GitHub Copilot',
    requiresKey: false,
    usesSettings: false,
    models: [],
    // Unused: the Copilot client is not HTTP, so neither the dialect nor the
    // header style applies to it.
    dialect: 'openai',
    headerStyle: 'default',
  },
  google: {
    id: 'google',
    label: 'Google AI Studio',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    requiresKey: true,
    usesSettings: false,
    models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'],
    dialect: 'gemini',
    headerStyle: 'default',
  },
  // Base URL and model list follow the hosted Go gateway; the model ids are
  // documented at OPENCODE_MODEL_DOC_URL (src/adapter/opencode.ts,
  // 'https://opencode.ai/docs/go/'). Keep both here so a later correction is
  // a one-line edit.
  opencode: {
    id: 'opencode',
    label: 'OpenCode Go',
    defaultBaseUrl: 'https://opencode.ai/zen/v1',
    requiresKey: true,
    usesSettings: false,
    models: ['grok-code', 'qwen3-coder', 'kimi-k2', 'claude-sonnet-4-5', 'gpt-5-codex'],
    dialect: 'openai',
    headerStyle: 'opencode',
  },
  mistral: {
    id: 'mistral',
    label: 'Mistral AI',
    defaultBaseUrl: 'https://api.mistral.ai/v1',
    requiresKey: true,
    usesSettings: false,
    models: [
      'mistral-large-latest',
      'mistral-medium-latest',
      'mistral-small-latest',
      'codestral-latest',
      'devstral-medium-latest',
    ],
    dialect: 'openai',
    headerStyle: 'default',
  },
  // The endpoint/model come from the `baiton.orchestrator.endpoint` /
  // `baiton.orchestrator.model` settings, not from this catalog.
  openai: {
    id: 'openai',
    label: 'OpenAI / Custom',
    requiresKey: true,
    usesSettings: true,
    models: [],
    dialect: 'openai',
    headerStyle: 'default',
  },
};

// --- per-id traits the feed cannot tell us -----------------------------------
//
// The models.dev feed describes providers generically; these maps carry the
// handful of host behaviours it does not know about. Everything absent from a
// map takes the default.

/** Providers whose payloads need non-default wire shaping; everything else is `'openai'`. */
export const PROVIDER_DIALECTS: Readonly<Record<string, DialectId>> = {
  // Google rejects OpenAI-style tool chaining without the gemini shaping.
  google: 'gemini',
};

/** Providers needing extra request headers; everything else is `'default'`. */
export const PROVIDER_HEADER_STYLES: Readonly<Record<string, HeaderStyleId>> = {
  // The hosted OpenCode gateway wants User-Agent + x-opencode-session.
  opencode: 'opencode',
};

/** Base URLs that must win over the feed's `api`. */
export const PROVIDER_BASE_URL_OVERRIDES: Readonly<Record<string, string>> = {
  // The feed's `api` for google is `https://generativelanguage.googleapis.com/v1beta`,
  // the NATIVE Gemini base. `completionsUrl()` appends `/chat/completions`, so
  // we need the OpenAI-compatible base instead.
  google: 'https://generativelanguage.googleapis.com/v1beta/openai/',
};

/** Feed ids that would duplicate the non-HTTP builtin Copilot path. */
export const FEED_PROVIDER_DENY: readonly string[] = ['copilot', 'github-copilot'];

/** True when `record` carries `key` as its own (not inherited) property. */
function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/** The de-duplicated, non-blank model ids of one feed provider, in feed order. */
function feedModelIds(provider: FeedProvider): readonly string[] {
  const models = Array.isArray(provider.models) ? provider.models : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const model of models) {
    const id = typeof model?.id === 'string' ? model.id.trim() : '';
    if (id.length === 0 || seen.has(id)) {
      continue;
    }
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Catalog entries derived from one models.dev feed, in feed order.
 *
 * Total and never throws, whatever a {@link FeedProvider} contains. A feed
 * provider is skipped when its id trims to empty, its id is in
 * {@link FEED_PROVIDER_DENY}, it discloses no `api` (so it is not reachable over
 * an OpenAI-compatible HTTP base) or it lists no usable models.
 */
export function providersFromFeed(feed: ModelsDevFeed): readonly ProviderInfo[] {
  const providers = Array.isArray(feed) ? feed : [];
  const out: ProviderInfo[] = [];
  for (const provider of providers) {
    if (provider === null || typeof provider !== 'object') {
      continue;
    }
    const id = typeof provider.id === 'string' ? provider.id.trim() : '';
    if (id.length === 0 || FEED_PROVIDER_DENY.includes(id)) {
      continue;
    }
    const api = typeof provider.api === 'string' ? provider.api.trim() : '';
    if (api.length === 0) {
      continue;
    }
    const models = feedModelIds(provider);
    if (models.length === 0) {
      continue;
    }
    const label = typeof provider.name === 'string' && provider.name.trim().length > 0 ? provider.name : id;
    const entry: ProviderInfo & { env?: readonly string[]; doc?: string } = {
      id,
      label,
      defaultBaseUrl: hasOwn(PROVIDER_BASE_URL_OVERRIDES, id) ? PROVIDER_BASE_URL_OVERRIDES[id] : api,
      requiresKey: true,
      usesSettings: false,
      models,
      dialect: hasOwn(PROVIDER_DIALECTS, id) ? (PROVIDER_DIALECTS[id] as DialectId) : 'openai',
      headerStyle: hasOwn(PROVIDER_HEADER_STYLES, id) ? (PROVIDER_HEADER_STYLES[id] as HeaderStyleId) : 'default',
      source: 'feed',
      env: Array.isArray(provider.env) ? provider.env : [],
    };
    if (typeof provider.doc === 'string' && provider.doc.length > 0) {
      entry.doc = provider.doc;
    }
    out.push(entry);
  }
  return out;
}

/**
 * The full catalog in dropdown order: builtins, then feed-only providers,
 * `openai` (OpenAI / Custom) last.
 *
 * With no feed (or an empty one) this is exactly today's five builtin entries,
 * same order and same object identities, so an offline window behaves as
 * before. For an id present in both sets the builtin entry wins on label, base
 * URL, key policy, dialect and header style — those encode host behaviour the
 * feed does not know about — while the FEED wins on `models`, so `google` stops
 * being pinned to a stale hard-coded list. Ids are never duplicated.
 */
export function buildProviderCatalog(feed?: ModelsDevFeed): readonly ProviderInfo[] {
  const builtins = PROVIDER_IDS.map((id) => PROVIDERS[id]);
  const fromFeed = feed === undefined ? [] : providersFromFeed(feed);
  if (fromFeed.length === 0) {
    return builtins;
  }
  const byId = new Map<string, ProviderInfo>();
  for (const entry of fromFeed) {
    if (!byId.has(entry.id)) {
      byId.set(entry.id, entry);
    }
  }

  const out: ProviderInfo[] = [];
  const emitted = new Set<string>();
  for (const builtin of builtins) {
    if (builtin.id === 'openai') {
      continue; // always last
    }
    const feedEntry = byId.get(builtin.id);
    if (feedEntry === undefined) {
      out.push(builtin);
    } else {
      const merged: ProviderInfo & { env?: readonly string[]; doc?: string } = {
        ...builtin,
        models: feedEntry.models,
        source: 'builtin',
        env: feedEntry.env ?? [],
      };
      if (feedEntry.doc !== undefined) {
        merged.doc = feedEntry.doc;
      }
      out.push(merged);
    }
    emitted.add(builtin.id);
  }
  for (const entry of fromFeed) {
    if (emitted.has(entry.id) || entry.id === 'openai') {
      continue;
    }
    emitted.add(entry.id);
    out.push(entry);
  }
  out.push(PROVIDERS.openai);
  return out;
}

/**
 * The catalog entry of `id`, or undefined when `id` is unknown or blank.
 * Exact, case-sensitive match against `catalog` when given, else against the
 * builtin record. Callers who need real membership use this rather than
 * {@link providerInfo}.
 */
export function findProviderInfo(id: ProviderId, catalog?: readonly ProviderInfo[]): ProviderInfo | undefined {
  if (typeof id !== 'string' || id.length === 0) {
    return undefined;
  }
  if (catalog !== undefined) {
    return catalog.find((entry) => entry.id === id);
  }
  return hasOwn(PROVIDERS, id) ? PROVIDERS[id as BuiltinProviderId] : undefined;
}

/**
 * The catalog entry of `id`; callers never index {@link PROVIDERS} by hand.
 *
 * Always returns an entry: an unknown id (a persisted selection whose provider
 * has left the feed, say) yields a freshly synthesised `source: 'custom'`
 * fallback rather than throwing. This is the graceful-degradation path — use
 * {@link findProviderInfo} when real membership is what matters.
 */
export function providerInfo(id: ProviderId, catalog?: readonly ProviderInfo[]): ProviderInfo {
  const found = findProviderInfo(id, catalog);
  if (found !== undefined) {
    return found;
  }
  return {
    id,
    label: id,
    requiresKey: true,
    usesSettings: false,
    models: [],
    dialect: 'openai',
    headerStyle: 'default',
    source: 'custom',
  };
}

/** Catalog entries in dropdown order; with a feed, {@link buildProviderCatalog}. */
export function providerCatalog(feed?: ModelsDevFeed): readonly ProviderInfo[] {
  return buildProviderCatalog(feed);
}

/** Prefix of every per-provider SecretStorage key. */
export const PROVIDER_SECRET_KEY_PREFIX = 'baiton.orchestrator.key.';

/**
 * The SecretStorage key holding `id`'s API key, or undefined for a blank id or
 * a builtin provider that needs none (`copilot`).
 *
 * This is the legacy-key compatibility guarantee: `google`/`opencode`/`mistral`/
 * `openai` keep resolving to `baiton.orchestrator.key.<id>` exactly as before,
 * and a feed-derived provider gets a key of the same shape.
 */
export function providerSecretKey(id: ProviderId): string | undefined {
  if (typeof id !== 'string' || id.trim().length === 0) {
    return undefined;
  }
  const builtin = hasOwn(PROVIDERS, id) ? PROVIDERS[id as BuiltinProviderId] : undefined;
  if (builtin !== undefined && !builtin.requiresKey) {
    return undefined;
  }
  return `${PROVIDER_SECRET_KEY_PREFIX}${id}`;
}

/**
 * The pre-multi-provider single-key secret, written by
 * `setOrchestratorApiKey` in src/activation/setApiKey.ts. Migrated once into
 * the `openai` slot by the host glue; kept here so the migration and the
 * catalog cannot drift.
 */
export const LEGACY_API_KEY_SECRET = 'baiton.orchestrator.apiKey';

/** The active provider + model pair, as persisted and as sent to the webview. */
export interface ModelSelection {
  provider: ProviderId;
  model: string;
}

/** `workspaceState` key the active selection is persisted under. */
export const MODEL_SELECTION_KEY = 'baiton.orchestrator.selection';

/** The first model listed for `id`, or undefined when the catalog lists none. */
export function defaultModelFor(id: ProviderId, catalog?: readonly ProviderInfo[]): string | undefined {
  return findProviderInfo(id, catalog)?.models[0];
}

/**
 * Read an untrusted value (a `workspaceState` blob written by an older
 * build, or a webview `selectModel` payload) as a {@link ModelSelection}.
 * Returns undefined for anything that is not an object with a non-blank string
 * `provider` and a non-empty string `model`; the provider is trimmed. Pure;
 * never throws.
 *
 * Catalog membership is deliberately NOT checked here: a persisted selection
 * whose provider or model is no longer in the catalog is preserved and reported
 * as custom/stale by the router, never dropped at parse time.
 */
export function normalizeModelSelection(value: unknown): ModelSelection | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  if (!isProviderIdLike(raw['provider'])) {
    return undefined;
  }
  if (typeof raw['model'] !== 'string') {
    return undefined;
  }
  const model = raw['model'].trim();
  if (model.length === 0) {
    return undefined;
  }
  return { provider: raw['provider'].trim(), model };
}

// --- availability vocabulary (multi-provider orchestrator) ------------------
//
// These are the exact strings the host-side provider router reports as a
// disabled provider's `reason` (src/activation/providerRouter.ts). Keeping
// them in the catalog lets the Chat webview render them without duplicating
// wording: the webview todo imports this module rather than restating the
// text. The module stays import-free — these are strings and pure functions
// only, no `vscode` and no modelClient dependency.

/**
 * The user-facing reason shown when provider `id` has no API key stored. An id
 * absent from the resolved catalog names itself rather than throwing.
 */
export function providerNeedsKeyReason(id: ProviderId, catalog?: readonly ProviderInfo[]): string {
  return `Set an API key for ${providerInfo(id, catalog).label} to use it.`;
}

/** The user-facing reason shown when `openai` has no `baiton.orchestrator.endpoint`. */
export const PROVIDER_NEEDS_ENDPOINT_REASON =
  'Set baiton.orchestrator.endpoint to use OpenAI / Custom.';

/**
 * The user-facing reason shown when GitHub Copilot is unavailable in the
 * current window (no Copilot Chat extension, or signed out).
 */
export const COPILOT_UNAVAILABLE_REASON =
  'GitHub Copilot is not available in this window. Install and sign in to GitHub Copilot Chat.';

/**
 * Structural equality of two {@link ModelSelection}s: both undefined, or both
 * defined with equal `provider` and `model`. Pure; never throws. Backed by
 * the router's `select` so a repeat of the active selection is a no-op.
 */
export function sameModelSelection(
  a: ModelSelection | undefined,
  b: ModelSelection | undefined,
): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  return a.provider === b.provider && a.model === b.model;
}
