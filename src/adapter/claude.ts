import { execFile } from 'child_process';
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
  'claude-opus-5',
  'claude-haiku-5',
] as const;

/** Reasoning effort levels supported by `claude --effort` (Requirement 14.1). */
export const CLAUDE_EFFORTS = ['low', 'medium', 'high'] as const;

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

/** Optional construction options of {@link ClaudeAdapter}; every field has a default. */
export interface ClaudeAdapterOptions {
  /** The feed fetcher used by {@link ClaudeAdapter.discoverModels}; defaults to `fetchModelsDev`. */
  readonly fetchFeed?: ClaudeFeedFetcher;
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

  /**
   * @param mode the permission mode; the read-only `acceptEdits` fallback is a
   *   config flip here (Requirement 15.7) and changes no other plumbing.
   * @param options optional injections; the default `fetchFeed` is
   *   {@link fetchModelsDev} over the global `fetch` — the module's only
   *   network path — and tests inject a fake instead of touching the network.
   *   Both parameters are optional, so `createAdapterRegistry()`'s
   *   `new ClaudeAdapter(mode)` compiles unchanged.
   */
  constructor(private readonly mode: PermissionMode = DEFAULT_PERMISSION_MODE, options: ClaudeAdapterOptions = {}) {
    this.fetchFeed = options.fetchFeed ?? ((o) => fetchModelsDev({ timeoutMs: o.timeoutMs }));
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
   * Discover claude's model list from the models.dev `anthropic` provider
   * (contract of `Adapter.discoverModels`). Never rejects: the whole body is
   * wrapped so any internal error resolves `undefined`, which means "keep the
   * curated builtin list" — returning the curated list here would instead
   * falsely mark it refreshed. The fetch (when `ctx.feed` is absent) is raced
   * against `ctx.signal` and bounded by
   * `min(ctx.timeoutMs, DEFAULT_DISCOVERY_TIMEOUT_MS)`; the loser of the race
   * (or a failed fetch, an empty extraction, or an already-aborted signal)
   * resolves `undefined`. When discovered entries exist the default
   * {@link CLAUDE_REQUIRED_MODEL} is guaranteed present exactly once —
   * mirroring the `mergePreservingExisting` step `agentCapabilities()` in
   * src/adapter/index.ts already applies — and the result carries exactly
   * `models`/`efforts`/`modelEntries`: snapshot provenance
   * (`source`/`fetchedAt`)
   * is owned by the `CatalogStore`, and claude has no `modelLink`. No secret,
   * env var or credential is read anywhere in this path; only ids and labels
   * leave the host.
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
      const withDefault: ModelEntry[] = [...entries];
      if (!withDefault.some((entry) => entry.id === CLAUDE_REQUIRED_MODEL)) {
        // Curated, not user config: no `custom` flag (unlike
        // mergePreservingExisting's appended user values).
        withDefault.push({ id: CLAUDE_REQUIRED_MODEL });
      }
      // Deliberately NO source/stale/staleReason/fetchedAt/modelLink: the
      // CatalogStore.applyResult stamps provenance, and claude has no modelLink.
      return capabilitiesFromEntries(withDefault, { efforts: [...CLAUDE_EFFORTS] });
    } catch {
      return undefined;
    }
  }

  /**
   * Race `promise` against `signal`: resolves `undefined` on the signal's
   * `abort` event, else resolves `promise`'s value (or `undefined` when
   * `promise` rejects). The `abort` listener is ALWAYS removed, and the losing
   * promise's rejection is consumed here, so no unhandled rejection ever
   * escapes to unrelated suites.
   */
  private raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T | undefined> {
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
