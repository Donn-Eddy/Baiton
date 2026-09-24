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

/** One orchestrator inference provider, keyed by its stable id. */
export type ProviderId = 'copilot' | 'google' | 'opencode' | 'mistral' | 'openai';

/** Dropdown order, top to bottom. */
export const PROVIDER_IDS: readonly ProviderId[] = ['copilot', 'google', 'opencode', 'mistral', 'openai'] as const;

/** True when `value` is one of the known {@link ProviderId} strings. */
export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value);
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
 * The provider catalog, one record per {@link ProviderId}.
 *
 * Base URLs are the prefix `completionsUrl()` (src/orchestrator/modelClient.ts)
 * appends `/chat/completions` to: `normalizeBase` strips every trailing slash
 * first, so the Google base's trailing slash is harmless rather than required —
 * do not add `/chat/completions` by hand.
 */
export const PROVIDERS: Readonly<Record<ProviderId, ProviderInfo>> = {
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

/** The catalog entry of `id`; callers never index {@link PROVIDERS} by hand. */
export function providerInfo(id: ProviderId): ProviderInfo {
  return PROVIDERS[id];
}

/** Catalog entries in dropdown order. */
export function providerCatalog(): readonly ProviderInfo[] {
  return PROVIDER_IDS.map((id) => PROVIDERS[id]);
}

/** Prefix of every per-provider SecretStorage key. */
export const PROVIDER_SECRET_KEY_PREFIX = 'baiton.orchestrator.key.';

/**
 * The SecretStorage key holding `id`'s API key, or undefined for a provider
 * that needs none (`copilot`).
 */
export function providerSecretKey(id: ProviderId): string | undefined {
  return PROVIDERS[id].requiresKey ? `${PROVIDER_SECRET_KEY_PREFIX}${id}` : undefined;
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

/** The first built-in model for `id`, or undefined when the catalog lists none. */
export function defaultModelFor(id: ProviderId): string | undefined {
  return PROVIDERS[id].models[0];
}

/**
 * Read an untrusted value (a `workspaceState` blob written by an older
 * build, or a webview `selectModel` payload) as a {@link ModelSelection}.
 * Returns undefined for anything that is not an object with a known
 * `provider` and a non-empty string `model`. Pure; never throws.
 */
export function normalizeModelSelection(value: unknown): ModelSelection | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  if (!isProviderId(raw['provider'])) {
    return undefined;
  }
  if (typeof raw['model'] !== 'string') {
    return undefined;
  }
  const model = raw['model'].trim();
  if (model.length === 0) {
    return undefined;
  }
  return { provider: raw['provider'], model };
}

// --- availability vocabulary (multi-provider orchestrator) ------------------
//
// These are the exact strings the host-side provider router reports as a
// disabled provider's `reason` (src/activation/providerRouter.ts). Keeping
// them in the catalog lets the Chat webview render them without duplicating
// wording: the webview todo imports this module rather than restating the
// text. The module stays import-free — these are strings and pure functions
// only, no `vscode` and no modelClient dependency.

/** The user-facing reason shown when provider `id` has no API key stored. */
export function providerNeedsKeyReason(id: ProviderId): string {
  return `Set an API key for ${PROVIDERS[id].label} to use it.`;
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
