import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  DEFAULT_DISCOVERY_TIMEOUT_MS,
  capabilitiesFromEntries,
} from './adapter';
import type {
  Adapter,
  AgentCapabilities,
  DiscoveryContext,
  LaunchRequest,
  LaunchSpec,
  ProbeResult,
} from './adapter';
import { fetchModelsDev } from '../orchestrator/modelsDev';
import type { ModelsDevFeed } from '../orchestrator/modelsDev';
import type { ModelEntry } from '../orchestrator/modelCatalog';
import { isOk } from '../model/result';
import type { Result } from '../model/result';
import type { Role } from '../model/role';
import {
  DEFAULT_PERMISSION_MODE,
  PermissionMode,
  claudeRelayFlags,
  permissionFlags,
  runDirGrant,
} from './permissions';
import { roleProfile } from './roleProfile';

/** The Claude CLI executable name; resolved on the host PATH. */
const CLAUDE_BIN = 'claude';

/**
 * Curated Claude models exposed in the config panel dropdown.
 * Deliberately advisory: the "Other…" escape allows typing any unlisted model.
 * MUST include 'claude-sonnet-5' (the defaultConfig() default).
 */
export const CLAUDE_MODELS: readonly string[] = [
  'claude-sonnet-5',
  'claude-opus-5-5',
  'claude-fable-5-1',
  'claude-haiku-4-5-20251001',
] as const;

/**
 * Reasoning effort levels supported by `claude --effort` — the CLI's own
 * `--effort <low|medium|high|xhigh|max>` vocabulary (`claude --help`), which
 * Requirement 14.1 only sketched as `low|medium|high`. Capability-level: the
 * local model catalog discloses per-model subsets on {@link ModelEntry.efforts}.
 */
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/**
 * The models.dev provider id the Claude CLI's models come from: discovery
 * reads only this provider's `claude-*` entries out of the feed.
 */
export const ANTHROPIC_PROVIDER_ID = 'anthropic';

/**
 * Only feed ids carrying this prefix are Claude CLI `--model` values; other
 * providers may list Anthropic models under prefixed ids (`anthropic/claude-*`)
 * and must never be picked up.
 */
export const CLAUDE_MODEL_ID_PREFIX = 'claude-';

/**
 * The `defaultConfig()` default (`claude-sonnet-5`) which must stay selectable
 * in every discovered claude list. NOTE: src/adapter/index.ts keeps its own
 * module-private `CLAUDE_DEFAULT_MODEL` copy for the snapshot overlay — the
 * two constants must move together if `defaultConfig()`'s default ever
 * changes. Deliberately NOT named `CLAUDE_DEFAULT_MODEL` to avoid an
 * ambiguous binding clash with index.ts (which re-exports this module).
 */
export const CLAUDE_REQUIRED_MODEL: string = CLAUDE_MODELS[0];

/**
 * Extract the Claude CLI's model list from a parsed models.dev feed.
 *
 * Pure and total: never throws, never mutates the input, returns the entries
 * in feed order. Only the provider whose id is {@link ANTHROPIC_PROVIDER_ID}
 * (case/whitespace-tolerant) is consulted; every other provider is ignored,
 * even when its ids look like Claude ids. A kept model is one whose id, after
 * trimming, starts with {@link CLAUDE_MODEL_ID_PREFIX}; blank ids and repeats
 * are skipped, first occurrence wins. Each entry is built the
 * conditional-own-key way `normalizeModelEntry` uses in
 * src/orchestrator/modelCatalog.ts: always `{ id, provider }`, plus
 * `label` only when the feed's `name` is a non-empty string different from
 * the id. No per-model `efforts`/`defaultEffort` (claude's levels are
 * capability-level) and no `custom` flag. Returns `[]` when the feed has no
 * usable anthropic provider or lists no `claude-*` id — the caller then keeps
 * the curated {@link CLAUDE_MODELS}.
 */
export function claudeModelsFromFeed(feed: ModelsDevFeed): readonly ModelEntry[] {
  const provider = feed.find((candidate) => candidate.id.trim().toLowerCase() === ANTHROPIC_PROVIDER_ID);
  if (provider === undefined) {
    return [];
  }
  const entries: ModelEntry[] = [];
  const seen = new Set<string>();
  for (const model of provider.models) {
    const id = model.id.trim();
    if (!id.startsWith(CLAUDE_MODEL_ID_PREFIX)) {
      continue;
    }
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    const entry: { id: string; label?: string; provider: string } = {
      id,
      provider: ANTHROPIC_PROVIDER_ID,
    };
    if (typeof model.name === 'string' && model.name.length > 0 && model.name !== id) {
      entry.label = model.name;
    }
    entries.push(entry);
  }
  return entries;
}

/**
 * The catalog `surface` the Claude Code CLI writes its own picker list under;
 * a file carrying any other surface is never read as a claude model list.
 */
export const CLAUDE_CATALOG_SURFACE = 'cc';

/**
 * Where the CLI keeps its model catalog, relative to the claude config dir:
 * `<config dir>/cache/model-catalog/*-cc.json`.
 */
export const CLAUDE_CATALOG_DIR_SEGMENTS: readonly string[] = ['cache', 'model-catalog'];

/** True when `value` is a non-null, non-array object — the untyped-JSON guard. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Extract the Claude CLI's model list from one parsed local model-catalog file
 * (`$CLAUDE_CONFIG_DIR`/`~/.claude/cache/model-catalog/<uuid>-<hash>-cc.json`,
 * version 2).
 *
 * Pure and total: never throws, never mutates the input. The shape read is
 * `{ version, fetchedAt, staleAt, catalog: { id, surface: 'cc', state?,
 * config: { models: [{ id, name, short_name?, section: 'main'|'overflow',
 * thinking: { type: 'effort', effort_options: [{ id, name, badge? }] } |
 * { type: 'none' } }] } } }`.
 *
 * `catalog.surface` MUST be `cc`; a missing `version` and a missing
 * `catalog.state` are tolerated. Models are emitted in two ordered passes —
 * every `section: 'main'` element in file order, then every remaining element
 * (`overflow`, an absent or an unknown section) in file order — so the CLI's
 * own primary picker list leads. Only ids that, trimmed, start with
 * {@link CLAUDE_MODEL_ID_PREFIX} are kept; blank ids are skipped and a repeated
 * id is emitted once, first occurrence winning (a `main` duplicate therefore
 * beats an `overflow` one).
 *
 * Each entry is built the conditional-own-key way `normalizeModelEntry` uses in
 * src/orchestrator/modelCatalog.ts: always `{ id }`, plus `label` only when
 * `name` is a non-empty string different from the id, plus `efforts` and
 * `defaultEffort` from `thinking`. A `thinking.type: 'effort'` model's
 * `efforts` is its `effort_options` ids in file order (de-duplicated,
 * first-seen) and its `defaultEffort` is the first option whose
 * `badge.message === 'Default'`; effort ids are NOT validated against
 * {@link CLAUDE_EFFORTS} — the catalog is the authority, so an unknown future
 * level passes through. `thinking.type: 'none'`, an absent `thinking` and any
 * other shape yield an explicit empty `efforts` own key (which the webview
 * reads as "this model has no levels", distinct from "unknown") and no
 * `defaultEffort`. No `provider`, no `custom`, no provenance key is emitted.
 *
 * ONLY ids, labels and effort names are read out of the file: the catalog's
 * `description`, `notice`, `capabilities`, `min_claude_code_version`,
 * `fast_mode` and `settings_vocabulary` are never projected, so nothing else of
 * it can leave the host. A catalog past its `staleAt` is deliberately still
 * used — it is the CLI's own last-known-good picker list, and re-fetching it is
 * the CLI's job, not Baiton's.
 *
 * Returns `[]` for anything unusable: a non-object input, a non-`cc` or missing
 * surface, a missing or non-array `catalog.config.models`, or a models array
 * with no `claude-*` id. The caller then falls back to the models.dev feed.
 */
export function claudeModelsFromCatalog(json: unknown): readonly ModelEntry[] {
  if (!isRecord(json)) {
    return [];
  }
  const catalog = json['catalog'];
  if (!isRecord(catalog)) {
    return [];
  }
  const surface = catalog['surface'];
  if (typeof surface !== 'string' || surface.trim() !== CLAUDE_CATALOG_SURFACE) {
    return [];
  }
  const config = catalog['config'];
  if (!isRecord(config)) {
    return [];
  }
  const models = config['models'];
  if (!Array.isArray(models)) {
    return [];
  }

  const entries: ModelEntry[] = [];
  const seen = new Set<string>();

  const push = (element: unknown): void => {
    if (!isRecord(element)) {
      return;
    }
    const rawId = element['id'];
    if (typeof rawId !== 'string') {
      return;
    }
    const id = rawId.trim();
    if (id.length === 0 || !id.startsWith(CLAUDE_MODEL_ID_PREFIX) || seen.has(id)) {
      return;
    }
    seen.add(id);
    const entry: { id: string; label?: string; efforts: readonly string[]; defaultEffort?: string } = {
      id,
      efforts: [],
    };
    const name = element['name'];
    if (typeof name === 'string' && name.length > 0 && name !== id) {
      entry.label = name;
    }
    const thinking = element['thinking'];
    if (isRecord(thinking) && thinking['type'] === 'effort' && Array.isArray(thinking['effort_options'])) {
      const efforts: string[] = [];
      const effortSeen = new Set<string>();
      let defaultEffort: string | undefined;
      for (const option of thinking['effort_options']) {
        if (!isRecord(option)) {
          continue;
        }
        const rawOptionId = option['id'];
        if (typeof rawOptionId !== 'string') {
          continue;
        }
        const optionId = rawOptionId.trim();
        if (optionId.length === 0) {
          continue;
        }
        if (!effortSeen.has(optionId)) {
          effortSeen.add(optionId);
          efforts.push(optionId);
        }
        const badge = option['badge'];
        if (defaultEffort === undefined && isRecord(badge) && badge['message'] === 'Default') {
          defaultEffort = optionId;
        }
      }
      entry.efforts = efforts;
      if (defaultEffort !== undefined && efforts.includes(defaultEffort)) {
        entry.defaultEffort = defaultEffort;
      }
    }
    entries.push(entry);
  };

  for (const element of models) {
    if (isRecord(element) && element['section'] === 'main') {
      push(element);
    }
  }
  for (const element of models) {
    if (!(isRecord(element) && element['section'] === 'main')) {
      push(element);
    }
  }
  return entries;
}

/** How long to wait for `claude --version` before giving up (ms). */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * Build the `--append-system-prompt <text>` pair carrying the role profile's
 * plain-language constraints. The flag is additive: it leaves Claude Code's
 * own system prompt intact and appends Baiton's policy statement, so the
 * profile is delivered without replacing anything the CLI relies on.
 */
export function claudeSystemPromptFlags(role: Role): string[] {
  return ['--append-system-prompt', roleProfile(role).systemPrompt];
}

/**
 * The injectable feed fetcher seam: resolves the parsed models.dev `Result`.
 * The default is {@link fetchModelsDev}, the module's ONLY network path, so
 * tests inject a fake here instead of touching the network.
 */
export type ClaudeFeedFetcher = (options: { timeoutMs: number }) => Promise<Result<ModelsDevFeed, string>>;

/**
 * The injectable local-catalog reader seam: resolves the parsed JSON of the
 * freshest local `*-cc.json` model catalog (largest `fetchedAt`), or
 * `undefined` when there is none, the directory is unreadable, or no file
 * parses into a `cc` catalog. NEVER rejects — every failure is `undefined`.
 * The default is {@link defaultReadLocalCatalog}; tests inject
 * `async () => undefined` to keep the feed path hermetic.
 */
export type ClaudeCatalogReader = () => Promise<unknown | undefined>;

/** Optional construction options of {@link ClaudeAdapter}; every field has a default. */
export interface ClaudeAdapterOptions {
  /** The feed fetcher used by {@link ClaudeAdapter.discoverModels}; defaults to `fetchModelsDev`. */
  readonly fetchFeed?: ClaudeFeedFetcher;
  /**
   * The local model-catalog reader used by {@link ClaudeAdapter.discoverModels};
   * defaults to {@link defaultReadLocalCatalog} over the real filesystem.
   */
  readonly readLocalCatalog?: ClaudeCatalogReader;
}

/**
 * The single first-pass adapter for the Claude Code CLI. It owns exactly three
 * things — the readiness probe, per-role launch argument construction, and the
 * continue flag — and nothing else (Requirement 14.1).
 *
 * Permissions are the claude translation of the Baiton role profiles
 * (`roleProfile.ts`): `permissionFlags` turns the profile's write scope and
 * shell bit into `--allowedTools`/`--permission-mode`, and
 * {@link claudeSystemPromptFlags} delivers the same policy in prose via
 * `--append-system-prompt` so the model is told the rule, not merely blocked
 * by it.
 */
export class ClaudeAdapter implements Adapter {
  readonly id = 'claude' as const;

  /**
   * claude is the only CLI that honours Baiton's pre-assigned session id:
   * `--session-id <uuid>` on a fresh launch makes the journal's `sessionId`
   * the session's real id, so `--resume <id>` finds it later.
   */
  readonly acceptsSessionId = true;

  /** The feed fetcher used by {@link ClaudeAdapter.discoverModels}. */
  private readonly fetchFeed: ClaudeFeedFetcher;

  /** The local model-catalog reader used by {@link ClaudeAdapter.discoverModels}. */
  private readonly readLocalCatalog: ClaudeCatalogReader;

  /**
   * @param mode the permission mode; the read-only `acceptEdits` fallback is a
   *   config flip here (Requirement 15.7) and changes no other plumbing.
   * @param options optional injections; the default `fetchFeed` is
   *   {@link fetchModelsDev} over the global `fetch` — the module's only
   *   network path — and tests inject a fake instead of touching the network.
   *   The default `readLocalCatalog` is {@link defaultReadLocalCatalog} over
   *   the real `~/.claude/cache/model-catalog`, so a test asserting the feed
   *   path must inject `async () => undefined` to stay hermetic. Both
   *   parameters are optional, so `createAdapterRegistry()`'s
   *   `new ClaudeAdapter(mode)` compiles unchanged.
   */
  constructor(private readonly mode: PermissionMode = DEFAULT_PERMISSION_MODE, options: ClaudeAdapterOptions = {}) {
    this.fetchFeed = options.fetchFeed ?? ((o) => fetchModelsDev({ timeoutMs: o.timeoutMs }));
    this.readLocalCatalog = options.readLocalCatalog ?? defaultReadLocalCatalog;
  }

  /**
   * Run `claude --version` and report readiness (Requirements 14.2–14.4). A
   * clean exit with a version string is `ok: true`; any failure is `ok: false`
   * with a non-empty reason.
   */
  async probe(): Promise<ProbeResult> {
    try {
      const version = await this.runVersion();
      const trimmed = version.trim();
      if (trimmed.length === 0) {
        return {
          version: '',
          ok: false,
          reason: `${CLAUDE_BIN} --version produced no version output`,
        };
      }
      return { version: trimmed, ok: true };
    } catch (e) {
      return {
        version: '',
        ok: false,
        reason: describeProbeError(e),
      };
    }
  }

  /**
   * Build the terminal launch for one stage.
   *
   * Fresh launch: `claude --session-id <id> --model <m> [--effort <e>]
    * <permission flags> <run-dir grant> [--settings <inline JSON>]
    * --append-system-prompt <profile prompt> -- "<prompt>"` (Requirement 3.1).
    * On resume, `--resume <resumeSessionId>` leads the arguments when a prior
    * Session_Id is known, falling back to the continue flag `-c` when it is
    * not (Requirements 3.2, 13.2, 13.3, 15.1–15.4). Every role is additionally
    * granted write access to its own `.baiton/runs/<run-id>/` directory
    * (Requirement 15.4).
    *
    * When the request carries a `file-v1` ask-relay descriptor, the pair
    * `--settings <inline JSON>` is inserted after the run-dir grant, carrying
    * the verified `PreToolUse` ask-relay hook (see `permissions.ts`); with no
    * descriptor (or an unknown relay protocol) the argv is byte-identical to
    * the plain launch above. `attach()` deliberately takes no relay: re-opening
    * a finished session must not re-arm the hook.
    */
  launch(req: LaunchRequest): LaunchSpec {
    const args: string[] = [];

    if (req.resume) {
      if (req.resumeSessionId !== undefined && req.resumeSessionId.length > 0) {
        args.push('--resume', req.resumeSessionId);
      } else {
        args.push('-c');
      }
    } else {
      args.push('--session-id', req.sessionId);
    }

    args.push('--model', req.model);
    if (req.effort !== undefined && req.effort.length > 0) {
      args.push('--effort', req.effort);
    }

    args.push(...permissionFlags(req.role, this.mode));
    args.push(...runDirGrant(req.runId));
    args.push(...claudeRelayFlags(req.relay));
    args.push(...claudeSystemPromptFlags(req.role));
    // `--add-dir` and `--allowedTools` are variadic; without the `--`
    // end-of-options marker the CLI swallows the prompt as another value and
    // starts with no initial message.
    args.push('--', req.prompt);

    return { shellPath: CLAUDE_BIN, shellArgs: args };
  }

  /**
   * Build the args to reopen an existing session with no prompt: `claude
   * --resume <id> <permission flags> <run-dir grant> --append-system-prompt
   * <profile prompt>` (Requirement 3.3, 3.4).
   */
  attach(req: { role: Role; runId: string; sessionId: string }): LaunchSpec {
    const args: string[] = ['--resume', req.sessionId];
    args.push(...permissionFlags(req.role, this.mode));
    args.push(...runDirGrant(req.runId));
    args.push(...claudeSystemPromptFlags(req.role));

    return { shellPath: CLAUDE_BIN, shellArgs: args };
  }

  /**
   * Discover claude's model list, preferring the CLI's own local model catalog
   * over the models.dev feed (contract of `Adapter.discoverModels`). The
   * precedence is: local catalog → models.dev `anthropic` provider →
   * `undefined`. The curated {@link CLAUDE_MODELS} is NEVER returned here —
   * `undefined` means "keep the curated builtin list", and returning it would
   * instead falsely mark it refreshed.
   *
   * The catalog leg calls the injected {@link ClaudeCatalogReader} (no network,
   * no credential; see {@link claudeModelsFromCatalog} for what is read out of
   * the file) and, when it yields at least one `claude-*` id, resolves from it
   * WITHOUT reading `ctx.feed` or calling the feed fetcher at all. Only an
   * unusable catalog — missing, unreadable, malformed, a non-`cc` surface, or no
   * `claude-*` id — falls through to the feed leg.
   *
   * Per-model effort levels come from the catalog, so the capability-level
   * `efforts` on that leg is the ordered union of the entries' own levels; the
   * feed leg discloses no per-model levels and keeps the capability-level
   * {@link CLAUDE_EFFORTS}.
   *
   * Never rejects: the whole body is wrapped so any internal error (including a
   * reader that throws synchronously or returns a rejected promise) resolves
   * `undefined` or falls through. Both legs are raced against `ctx.signal` and
   * bounded by `min(ctx.timeoutMs, DEFAULT_DISCOVERY_TIMEOUT_MS)`; the loser of
   * the race, a failed fetch, an empty extraction and an already-aborted signal
   * all resolve `undefined`. When entries exist the default
   * {@link CLAUDE_REQUIRED_MODEL} is guaranteed present exactly once —
   * mirroring the `mergePreservingExisting` step `agentCapabilities()` in
   * src/adapter/index.ts already applies — and the result carries exactly
   * `models`/`efforts`/`modelEntries`: snapshot provenance
   * (`source`/`fetchedAt`)
   * is owned by the `CatalogStore`, and claude has no `modelLink`. No secret or
   * credential is read anywhere in this path, and no env var other than
   * `CLAUDE_CONFIG_DIR`; only ids, labels and effort names leave the host.
   */
  async discoverModels(ctx: DiscoveryContext): Promise<AgentCapabilities | undefined> {
    try {
      if (ctx.signal?.aborted === true) {
        return undefined;
      }
      const timeoutMs = Math.min(
        ctx.timeoutMs > 0 ? ctx.timeoutMs : DEFAULT_DISCOVERY_TIMEOUT_MS,
        DEFAULT_DISCOVERY_TIMEOUT_MS,
      );

      // Leg 1 — the CLI's own local catalog. `Promise.resolve().then(...)` so a
      // reader throwing synchronously is caught by the race, not the outer try.
      const raw = await this.raceTimeout(
        this.raceAbort(
          Promise.resolve().then(() => this.readLocalCatalog()),
          ctx.signal,
        ),
        timeoutMs,
      );
      const local = raw === undefined ? [] : claudeModelsFromCatalog(raw);
      if (local.length > 0) {
        if (ctx.signal?.aborted) {
          return undefined;
        }
        return this.capabilitiesFor(local);
      }

      // An abort that ended the catalog leg must not go on to start the feed.
      if (ctx.signal?.aborted) {
        return undefined;
      }

      // Leg 2 — the models.dev feed, unchanged.
      let feed: ModelsDevFeed | undefined = ctx.feed;
      if (feed === undefined) {
        const result = await this.raceAbort(this.fetchFeed({ timeoutMs }), ctx.signal);
        if (result === undefined || !isOk(result)) {
          if (result !== undefined && !isOk(result)) {
            ctx.log?.(result.error);
          }
          return undefined;
        }
        feed = result.value;
      }
      if (ctx.signal?.aborted) {
        return undefined;
      }
      const entries = claudeModelsFromFeed(feed);
      if (entries.length === 0) {
        return undefined;
      }
      return this.capabilitiesFor(entries);
    } catch {
      return undefined;
    }
  }

  /**
   * The tail shared by both discovery legs: guarantee
   * {@link CLAUDE_REQUIRED_MODEL} exactly once (appended last, with no `custom`
   * flag — it is curated, not user config) and build the capabilities. The
   * capability-level `efforts` is the ordered first-seen union of the entries'
   * own levels when ANY entry carries levels (the catalog leg — which
   * `capabilitiesFromEntries` computes itself when no `efforts` option is
   * passed), else the CLI-wide {@link CLAUDE_EFFORTS} (the feed leg).
   * Deliberately NO source/stale/staleReason/fetchedAt/modelLink: the
   * CatalogStore.applyResult stamps provenance, and claude has no modelLink.
   */
  private capabilitiesFor(entries: readonly ModelEntry[]): AgentCapabilities {
    const withDefault: ModelEntry[] = [...entries];
    if (!withDefault.some((entry) => entry.id === CLAUDE_REQUIRED_MODEL)) {
      withDefault.push({ id: CLAUDE_REQUIRED_MODEL });
    }
    const carriesLevels = entries.some((entry) => (entry.efforts ?? []).length > 0);
    return carriesLevels
      ? capabilitiesFromEntries(withDefault)
      : capabilitiesFromEntries(withDefault, { efforts: [...CLAUDE_EFFORTS] });
  }

  /**
   * Race `promise` against `signal`: resolves `undefined` on the signal's
   * `abort` event (or immediately when the signal is already aborted on entry
   * — a fetcher may abort synchronously, and no event will fire again), else
   * resolves `promise`'s value (or `undefined` when `promise` rejects). The
   * `abort` listener is ALWAYS removed, and the losing promise's rejection is
   * consumed here, so no unhandled rejection ever escapes to unrelated suites.
   */
  private raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T | undefined> {
    if (signal?.aborted === true) {
      // The signal completed before this race began (an injected fetcher can
      // abort synchronously): no `abort` EVENT will ever fire again, so no
      // listener is installed — the promise is merely consumed so a losing
      // rejection can never be unhandled, and the caller resolves undefined.
      promise.catch(() => undefined);
      return Promise.resolve(undefined);
    }
    if (signal === undefined) {
      return promise;
    }
    return new Promise<T | undefined>((resolve) => {
      const onAbort = (): void => {
        signal.removeEventListener('abort', onAbort);
        resolve(undefined);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        () => {
          signal.removeEventListener('abort', onAbort);
          resolve(undefined);
        },
      );
    });
  }

  /**
   * Race `promise` against a `timeoutMs` timer: resolves `undefined` when the
   * timer fires first, else `promise`'s value (or `undefined` when it rejects).
   * The timer is cleared on EVERY settle path and `unref`'d so a still-pending
   * one can never keep the host (or the mocha process) alive, and the losing
   * promise's rejection is consumed here so none escapes unhandled.
   */
  private raceTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
    return new Promise<T | undefined>((resolve) => {
      const timer = setTimeout(() => {
        promise.catch(() => undefined);
        resolve(undefined);
      }, timeoutMs);
      timer.unref?.();
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        () => {
          clearTimeout(timer);
          resolve(undefined);
        },
      );
    });
  }

  /** Execute `claude --version`, resolving stdout or rejecting on failure. */
  private runVersion(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      execFile(
        CLAUDE_BIN,
        ['--version'],
        { timeout: PROBE_TIMEOUT_MS, windowsHide: true },
        (error, stdout) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(stdout);
        },
      );
    });
  }
}

/** Turn a probe failure into a human-readable, non-empty reason. */
function describeProbeError(e: unknown): string {
  if (e && typeof e === 'object' && 'code' in e && (e as { code?: unknown }).code === 'ENOENT') {
    return `${CLAUDE_BIN} was not found on PATH`;
  }
  if (e instanceof Error && e.message.length > 0) {
    return `${CLAUDE_BIN} --version failed: ${e.message}`;
  }
  return `${CLAUDE_BIN} --version failed`;
}

/** `$CLAUDE_CONFIG_DIR` when set and non-empty, else `~/.claude`. */
function claudeConfigDir(): string {
  const env = process.env.CLAUDE_CONFIG_DIR;
  return env !== undefined && env.length > 0 ? env : path.join(os.homedir(), '.claude');
}

/** The directory holding the CLI's own `*-cc.json` model catalogs. */
export function claudeCatalogDir(): string {
  return path.join(claudeConfigDir(), ...CLAUDE_CATALOG_DIR_SEGMENTS);
}

/**
 * The default {@link ClaudeCatalogReader}: the parsed JSON of the freshest
 * `cc`-surface catalog in {@link claudeCatalogDir} (largest numeric
 * `fetchedAt`; a missing or non-finite one sorts last, ties keeping the first in
 * readdir order), or `undefined` when the directory is unreadable, holds no
 * `.json` file, or no file parses into a `cc` catalog. A single unparseable file
 * is skipped, not fatal. `staleAt` is deliberately NOT honoured — a stale
 * catalog is still the CLI's own last-known-good picker list, and refreshing it
 * is the CLI's job. Nothing but these files is read: no credential, and no env
 * var other than `CLAUDE_CONFIG_DIR`. Never rejects.
 */
async function defaultReadLocalCatalog(): Promise<unknown | undefined> {
  try {
    const dir = claudeCatalogDir();
    let best: unknown | undefined;
    let bestFetchedAt = -Infinity;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      } catch {
        continue;
      }
      if (!isRecord(parsed)) {
        continue;
      }
      const catalog = parsed['catalog'];
      if (!isRecord(catalog) || catalog['surface'] !== CLAUDE_CATALOG_SURFACE) {
        continue;
      }
      const raw = parsed['fetchedAt'];
      const fetchedAt = typeof raw === 'number' && Number.isFinite(raw) ? raw : -Infinity;
      if (best === undefined || fetchedAt > bestFetchedAt) {
        best = parsed;
        bestFetchedAt = fetchedAt;
      }
    }
    return best;
  } catch {
    return undefined;
  }
}
