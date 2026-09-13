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
 */
import { Result, ok, err } from '../model/result';

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
 */
export type ExecutableError =
  | { kind: 'override-missing'; agent: string; overridePath: string; message: string }
  | { kind: 'not-on-path'; agent: string; message: string };

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

/** Run the injected lookup, treating any thrown error as "not found". */
function safeLookup(lookup: ExecutableLookup, nameOrPath: string): string | undefined {
  try {
    return lookup(nameOrPath);
  } catch {
    return undefined;
  }
}
