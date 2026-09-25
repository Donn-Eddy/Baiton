/**
 * The models.dev feed client (host-free core).
 *
 * This module turns https://models.dev/api.json?type=all into generic
 * provider/model records: the feed vocabulary ({@link FeedProvider},
 * {@link FeedModel}), the pure {@link parseModelsDevFeed} that normalizes the
 * feed's snake_case shape into that vocabulary, and {@link fetchModelsDev},
 * the fetch with an injected transport and timeout. It carries no `vscode`
 * import, touches no host API and spawns nothing, so the host glue and the
 * unit tests both consume this same contract — like
 * src/orchestrator/modelCatalog.ts and src/orchestrator/providers.ts.
 */

import type { Result } from '../model/result';
import { ok, err } from '../model/result';

/** The models.dev feed endpoint. */
export const MODELS_DEV_URL = 'https://models.dev/api.json?type=all';

/** Context and output token limits of one feed model. */
export interface FeedModelLimits {
  /** The model's total context window in tokens, when disclosed. */
  readonly context?: number;
  /** The model's maximum output tokens, when disclosed. */
  readonly output?: number;
}

/** Per-token costs (USD per million tokens) of one feed model. */
export interface FeedModelCost {
  /** Cost of input tokens, when disclosed. */
  readonly input?: number;
  /** Cost of output tokens, when disclosed. */
  readonly output?: number;
  /** Cost of cached-read tokens, when disclosed. */
  readonly cacheRead?: number;
  /** Cost of cache-write tokens, when disclosed. */
  readonly cacheWrite?: number;
}

/** One model in the models.dev feed, after normalization to camelCase. */
export interface FeedModel {
  /** The model id, exactly as the feed spells it. */
  readonly id: string;
  /** Human label; falls back to the id when the feed omits it. */
  readonly name: string;
  /** The feed's `reasoning` flag; `false` when missing. */
  readonly reasoning: boolean;
  /** The feed's `tool_call` flag; `false` when missing. */
  readonly toolCall: boolean;
  /** The feed's `attachment` flag; `false` when missing. */
  readonly attachment: boolean;
  /** The feed's `limit` object, when at least one limit is numeric. */
  readonly limits?: FeedModelLimits;
  /** The feed's `cost` object, when at least one cost is numeric. */
  readonly cost?: FeedModelCost;
  /** The feed's `release_date`, when a non-empty string. */
  readonly releaseDate?: string;
}

/** One provider in the models.dev feed, after normalization. */
export interface FeedProvider {
  /** The provider id: the feed's record id or, failing that, the object key. */
  readonly id: string;
  /** Human label; falls back to the provider id when the feed omits it. */
  readonly name: string;
  /** The provider's API base URL, when the feed discloses one. */
  readonly api?: string;
  /** The environment variables the provider reads; `[]` when none disclosed. */
  readonly env: readonly string[];
  /** The provider's SDK package name, when disclosed. */
  readonly npm?: string;
  /** The provider's documentation URL, when disclosed. */
  readonly doc?: string;
  /** The provider's models, in feed order; `[]` when the feed's block is unusable. */
  readonly models: readonly FeedModel[];
}

/** The parsed models.dev feed: every provider, in feed order. */
export type ModelsDevFeed = readonly FeedProvider[];

// --- private defensive helpers (mirroring modelCatalog.ts) -------------------

/** An unknown value as a non-empty trimmed string, or undefined. */
function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** An unknown value as an array of non-empty trimmed strings, filtered element-wise. */
function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  for (const item of value) {
    const trimmed = optionalString(item);
    if (trimmed !== undefined) {
      out.push(trimmed);
    }
  }
  return out;
}

/** An unknown value as a finite number, rejecting NaN/Infinity/strings, or undefined. */
function optionalNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

/** An unknown value as a plain non-null object record, or undefined. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

// --- pure parser --------------------------------------------------------------

/**
 * Parse one feed model record (an already-parsed JSON object) into a
 * {@link FeedModel}. Returns undefined when the record has no usable id.
 * `key` is the fallback id when the record omits or blanks its own.
 */
function parseFeedModel(value: unknown, key: string): FeedModel | undefined {
  const record = asRecord(value);
  if (record === undefined) {
    return undefined;
  }
  const id = optionalString(record['id']) ?? optionalString(key);
  if (id === undefined) {
    return undefined;
  }
  const model: {
    id: string;
    name: string;
    reasoning: boolean;
    toolCall: boolean;
    attachment: boolean;
    limits?: FeedModelLimits;
    cost?: FeedModelCost;
    releaseDate?: string;
  } = {
    id,
    name: optionalString(record['name']) ?? id,
    reasoning: record['reasoning'] === true,
    toolCall: record['tool_call'] === true,
    attachment: record['attachment'] === true,
  };

  const limitRecord = asRecord(record['limit']);
  if (limitRecord !== undefined) {
    const context = optionalNumber(limitRecord['context']);
    const output = optionalNumber(limitRecord['output']);
    if (context !== undefined || output !== undefined) {
      const limits: { context?: number; output?: number } = {};
      if (context !== undefined) {
        limits.context = context;
      }
      if (output !== undefined) {
        limits.output = output;
      }
      model.limits = limits;
    }
  }

  const costRecord = asRecord(record['cost']);
  if (costRecord !== undefined) {
    const input = optionalNumber(costRecord['input']);
    const output = optionalNumber(costRecord['output']);
    const cacheRead = optionalNumber(costRecord['cache_read']);
    const cacheWrite = optionalNumber(costRecord['cache_write']);
    if (input !== undefined || output !== undefined || cacheRead !== undefined || cacheWrite !== undefined) {
      const cost: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } = {};
      if (input !== undefined) {
        cost.input = input;
      }
      if (output !== undefined) {
        cost.output = output;
      }
      if (cacheRead !== undefined) {
        cost.cacheRead = cacheRead;
      }
      if (cacheWrite !== undefined) {
        cost.cacheWrite = cacheWrite;
      }
      model.cost = cost;
    }
  }

  const releaseDate = optionalString(record['release_date']);
  if (releaseDate !== undefined) {
    model.releaseDate = releaseDate;
  }
  return model;
}

/**
 * Parse one feed provider record into a {@link FeedProvider}. `key` is the
 * fallback id when the record omits or blanks its own. Returns undefined when
 * neither yields a usable id.
 */
function parseFeedProvider(value: unknown, key: string): FeedProvider | undefined {
  const record = asRecord(value);
  if (record === undefined) {
    return undefined;
  }
  const id = optionalString(record['id']) ?? optionalString(key);
  if (id === undefined) {
    return undefined;
  }
  const provider: {
    id: string;
    name: string;
    api?: string;
    env: readonly string[];
    npm?: string;
    doc?: string;
    models: readonly FeedModel[];
  } = {
    id,
    name: optionalString(record['name']) ?? id,
    env: stringArray(record['env']),
    models: [],
  };
  const api = optionalString(record['api']);
  if (api !== undefined) {
    provider.api = api;
  }
  const npm = optionalString(record['npm']);
  if (npm !== undefined) {
    provider.npm = npm;
  }
  const doc = optionalString(record['doc']);
  if (doc !== undefined) {
    provider.doc = doc;
  }

  // `models` may be an object keyed by model id or an array; anything else
  // contributes no models (the provider itself is still kept).
  const rawModels = record['models'];
  if (Array.isArray(rawModels)) {
    for (const item of rawModels) {
      const recordItem = asRecord(item);
      if (recordItem === undefined) {
        continue;
      }
      const model = parseFeedModel(recordItem, optionalString(recordItem['id']) ?? '');
      if (model !== undefined) {
        (provider.models as FeedModel[]).push(model);
      }
    }
  } else if (asRecord(rawModels) !== undefined) {
    for (const [modelKey, item] of Object.entries(rawModels as Record<string, unknown>)) {
      const model = parseFeedModel(item, modelKey);
      if (model !== undefined) {
        (provider.models as FeedModel[]).push(model);
      }
    }
  }
  return provider;
}

/**
 * Parse an already-parsed models.dev feed into {@link ModelsDevFeed}.
 *
 * Pure, total, never throws: every malformed input — including `null`,
 * non-objects and empty objects — returns a `Result` rather than raising.
 * Accepts the real feed shape (an object keyed by provider id, `models` a
 * nested object keyed by model id) and, defensively, a top-level array of
 * provider records. Providers whose `models` end up empty are KEPT; source
 * order is preserved throughout. Name mapping is part of the contract:
 * `tool_call` → `toolCall`, `release_date` → `releaseDate`, `limit` →
 * `limits`, `cost.cache_read` → `cost.cacheRead`, `cost.cache_write` →
 * `cost.cacheWrite`.
 */
export function parseModelsDevFeed(raw: unknown): Result<ModelsDevFeed, string> {
  if (Array.isArray(raw)) {
    const providers: FeedProvider[] = [];
    for (const item of raw) {
      const provider = parseFeedProvider(item, '');
      if (provider !== undefined) {
        providers.push(provider);
      }
    }
    if (providers.length === 0) {
      return err('models.dev feed contained no providers');
    }
    return ok(providers);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return err('models.dev feed is not an object');
  }
  const providers: FeedProvider[] = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const provider = parseFeedProvider(value, key);
    if (provider !== undefined) {
      providers.push(provider);
    }
  }
  if (providers.length === 0) {
    return err('models.dev feed contained no providers');
  }
  return ok(providers);
}

// --- fetch with injected transport ---------------------------------------------

/** The structural subset of a fetch `Response` this module needs. */
export interface FeedResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

/** The injected transport: a structural `fetch` taking an explicit init. */
export type FeedFetch = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<FeedResponse>;

/** Options of {@link fetchModelsDev}; everything is injectable for tests. */
export interface FetchModelsDevOptions {
  /** The feed URL; defaults to {@link MODELS_DEV_URL}. */
  url?: string;
  /** The transport; defaults to the runtime's global `fetch`. */
  fetch?: FeedFetch;
  /** Abort timeout in milliseconds; defaults to 10_000. */
  timeoutMs?: number;
}

/**
 * A thrown or rejected value as a concise message, tolerating any shape
 * (Error, string, arbitrary object, undefined) without throwing itself.
 */
function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

/**
 * Fetch and parse the models.dev feed.
 *
 * Never throws or rejects: every path returns a `Result` whose error strings
 * are human-readable (they become the `staleReason` of the `models.dev`
 * snapshot via `CatalogStore.applyResult`). The transport is injected —
 * `fetch` defaults to a defensive read of the global `fetch` — and an
 * `AbortController` timer aborts the request after `timeoutMs`; the timer is
 * always cleared so no test leaks a pending timer.
 */
export async function fetchModelsDev(options: FetchModelsDevOptions = {}): Promise<Result<ModelsDevFeed, string>> {
  const url = options.url ?? MODELS_DEV_URL;
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (options.fetch === undefined && (globalThis as { fetch?: FeedFetch }).fetch === undefined) {
    return err('models.dev fetch is unavailable in this runtime');
  }
  const fetchFn: FeedFetch =
    options.fetch ?? ((globalThis as { fetch?: FeedFetch }).fetch as FeedFetch);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: FeedResponse;
    try {
      response = await fetchFn(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    } catch (error) {
      if (controller.signal.aborted) {
        return err(`models.dev request timed out after ${timeoutMs}ms`);
      }
      return err(`models.dev request failed: ${errorMessage(error)}`);
    }
    if (!response.ok || response.status < 200 || response.status > 299) {
      return err(`models.dev returned HTTP ${response.status}`);
    }
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      return err(`models.dev request failed: ${errorMessage(error)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return err('models.dev returned invalid JSON');
    }
    return parseModelsDevFeed(parsed);
  } finally {
    clearTimeout(timer);
  }
}
