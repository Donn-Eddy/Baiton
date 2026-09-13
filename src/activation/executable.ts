/**
 * Agent executable resolution (Requirements 22.7, 22.8, 14.5; design
 * "Activation / host").
 *
 * The extension runs on the workspace host so CLIs spawn where the files are
 * (Req 22.6). For each agent it must locate that agent's executable on the host
 * PATH, and must allow the executable path to be overridden in settings
 * (Req 22.7). If the executable cannot be located on PATH and no override is
 * configured, the extension must not dispatch a stage and must surface that the
 * executable was not found (Req 22.8, 14.5).
 *
 * The resolution is kept as a pure function with two injected seams — a PATH
 * lookup (`lookup`) and a settings-override getter (`override`) — so it is
 * unit-testable without touching the real filesystem or `vscode` settings
 * (task 15.3). The thin `vscode`-backed shell wires `lookup` to a real
 * PATH search and `override` to `vscode.workspace.getConfiguration`.
 *
 * Precedence: a configured override wins over PATH. An override that names a
 * file which does not exist is itself a "not found" — the shell's `lookup` is
 * used to verify an override path too, so a stale override does not silently
 * fall through to PATH.
 *
 * Roles may configure different agents (Requirement 14.1), so activation
 * resolves one executable per *distinct* agent id referenced by
 * `config.roles` via {@link resolveAgentExecutables}, which wraps the
 * single-agent {@link resolveExecutable} core above. A per-role dispatch gate
 * is derived from that table rather than from a single global flag: a stale
 * or missing executable disables dispatch only for the roles configured with
 * that agent, not for the whole extension.
 */
import { Result, ok, err, isErr } from '../model/result';
import { AGENT_BINARY, isAgentId } from '../adapter';

/**
 * Locates an executable for the given agent, either as an absolute/override
 * path (checked for existence) or by name on PATH. Returns the resolved
 * absolute path when found, or `undefined` when not found. Never throws — a
 * lookup error is reported as "not found".
 *
 * The shell implements this with a real PATH walk (respecting `PATHEXT` on
 * Windows) for a bare name, and an existence + executability check for a path
 * that already contains a separator.
 */
export type ExecutableLookup = (nameOrPath: string) => string | undefined;

/**
 * Reads the configured executable-path override for an agent, or `undefined`
 * when none is set (Req 22.7). The shell reads this from the extension's
 * settings (e.g. `baiton.agents.<agent>.path`). An empty or whitespace-only
 * setting is treated as unset by {@link resolveExecutable}.
 */
export type OverrideGetter = (agent: string) => string | undefined;

/**
 * The outcome of resolving one agent's executable.
 *
 * - `found` carries the resolved absolute `path` and whether it came from a
 *   settings `override` (true) or a PATH lookup (false).
 * - When resolution fails, the error explains that no executable was found and
 *   that dispatch must not proceed (Req 22.8, 14.5).
 */
export interface ResolvedExecutable {
  /** The agent whose executable was resolved. */
  readonly agent: string;
  /** The resolved absolute executable path. */
  readonly path: string;
  /** True when the path came from a settings override rather than PATH. */
  readonly override: boolean;
}

/**
 * Why an agent's executable could not be resolved (Req 22.8, 14.5). Both
 * variants signal "no dispatch": the caller must not launch a stage. Each
 * carries a user-facing `message`.
 *
 * - `override-missing` — a settings override was configured but the file it
 *   names does not exist / is not executable; `overridePath` is what was tried.
 * - `not-on-path`      — no override was configured and the executable was not
 *   found on PATH.
 * - `unknown-agent`    — the configured `agent` id is not one this build
 *   supports, so no executable name is known for it; the roles using it
 *   cannot dispatch.
 */
export type ExecutableError =
  | { kind: 'override-missing'; agent: string; overridePath: string; message: string }
  | { kind: 'not-on-path'; agent: string; message: string }
  | { kind: 'unknown-agent'; agent: string; message: string };

/** Whether a settings value is a usable, non-blank override path. */
function hasOverride(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Resolve an agent's executable, preferring a settings override over a PATH
 * lookup (Req 22.7).
 *
 * - When an override is configured, verify it via `lookup`; a stale override
 *   that resolves to nothing is `override-missing` (it does **not** fall
 *   through to PATH, so the user's explicit choice is not silently ignored).
 * - Otherwise search PATH by the agent's executable name; a miss is
 *   `not-on-path`.
 *
 * A failure result means the extension must not dispatch a stage for this agent
 * (Req 22.8, 14.5); the caller surfaces the message.
 */
export function resolveExecutable(
  agent: string,
  executableName: string,
  lookup: ExecutableLookup,
  override: OverrideGetter,
): Result<ResolvedExecutable, ExecutableError> {
  const configured = override(agent);
  if (hasOverride(configured)) {
    const resolved = safeLookup(lookup, configured.trim());
    if (resolved !== undefined) {
      return ok({ agent, path: resolved, override: true });
    }
    return err({
      kind: 'override-missing',
      agent,
      overridePath: configured.trim(),
      message:
        `The configured executable path for "${agent}" (${configured.trim()}) was not found ` +
        `or is not executable. Baiton will not dispatch a stage until it is corrected.`,
    });
  }

  const onPath = safeLookup(lookup, executableName);
  if (onPath !== undefined) {
    return ok({ agent, path: onPath, override: false });
  }
  return err({
    kind: 'not-on-path',
    agent,
    message:
      `The "${executableName}" executable for agent "${agent}" was not found on PATH and no ` +
      `override path is configured. Baiton will not dispatch a stage until it is available.`,
  });
}

/**
 * The set of supported agent ids, as a message fragment (e.g. "claude,
 * opencode, antigravity, codex"). Built from `AGENT_BINARY`'s keys rather than
 * a literal so a future agent id cannot drift out of sync with the message.
 */
const SUPPORTED_AGENTS = Object.keys(AGENT_BINARY).join(', ');

/** The per-role, per-agent config key an `unknown-agent` message points the user at. */
function unknownAgentMessage(agent: string): string {
  return (
    `"${agent}" is not a supported agent id; use one of ${SUPPORTED_AGENTS} in ` +
    `"roles.<role>.agent" in .baiton/config.json.`
  );
}

/**
 * The resolved table of one {@link resolveExecutable} outcome per distinct
 * agent id asked for by {@link resolveAgentExecutables}.
 *
 * Exactly one of `get`/`errorFor` answers for an agent that was resolved (the
 * other is `undefined`); both are `undefined` for an agent that was never
 * asked for at all — that third case is distinct from a resolution failure,
 * which callers must not confuse with "failed".
 */
export interface AgentExecutables {
  /** The resolved executable for `agent`, or `undefined` if it failed or was never asked for. */
  get(agent: string): ResolvedExecutable | undefined;
  /** The resolution failure for `agent`, or `undefined` if it resolved or was never asked for. */
  errorFor(agent: string): ExecutableError | undefined;
  /** Every resolution failure, in first-seen agent order, for surfacing once at activation. */
  readonly errors: readonly ExecutableError[];
  /** The distinct agent ids that were asked for, in first-seen order. */
  readonly agents: readonly string[];
}

/**
 * Resolve one executable per *distinct* agent id in `agents` (Requirements
 * 22.7, 22.8, 14.5). Several roles normally share one agent, so `agents` is
 * de-duplicated preserving first-seen order before any PATH lookup runs — a
 * PATH walk per role would be wasted work and would duplicate warnings.
 *
 * An id `isAgentId` rejects is recorded as an `unknown-agent` error without
 * consulting `lookup`/`override`. A recognised id is resolved via the
 * single-agent {@link resolveExecutable} core, keyed by its binary name from
 * `AGENT_BINARY`. The override seam is already keyed by agent
 * (`baiton.agents.<agent>.path`), so each agent gets its own override key for
 * free.
 */
export function resolveAgentExecutables(
  agents: readonly string[],
  lookup: ExecutableLookup,
  override: OverrideGetter,
): AgentExecutables {
  const distinct: string[] = [];
  const seen = new Set<string>();
  for (const agent of agents) {
    if (!seen.has(agent)) {
      seen.add(agent);
      distinct.push(agent);
    }
  }

  const resolved = new Map<string, ResolvedExecutable>();
  const failed = new Map<string, ExecutableError>();
  for (const agent of distinct) {
    if (!isAgentId(agent)) {
      failed.set(agent, { kind: 'unknown-agent', agent, message: unknownAgentMessage(agent) });
      continue;
    }
    const result = resolveExecutable(agent, AGENT_BINARY[agent], lookup, override);
    if (isErr(result)) {
      failed.set(agent, result.error);
    } else {
      resolved.set(agent, result.value);
    }
  }

  return {
    get(agent: string): ResolvedExecutable | undefined {
      return resolved.get(agent);
    },
    errorFor(agent: string): ExecutableError | undefined {
      return failed.get(agent);
    },
    errors: distinct.map((agent) => failed.get(agent)).filter((e): e is ExecutableError => e !== undefined),
    agents: distinct,
  };
}

/** Run the injected lookup, treating any thrown error as "not found". */
function safeLookup(lookup: ExecutableLookup, nameOrPath: string): string | undefined {
  try {
    return lookup(nameOrPath);
  } catch {
    return undefined;
  }
}
