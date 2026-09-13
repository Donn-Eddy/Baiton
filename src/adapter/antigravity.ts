import { execFile } from 'child_process';
import type { Adapter, LaunchRequest, LaunchSpec, ProbeResult } from './adapter';
import { AGENT_BINARY } from './adapter';
import type { Role } from '../model/role';
import { isReadOnlyRole, runDirGrant } from './permissions';

/** The antigravity CLI executable name, sourced from the canonical binary map (Requirement 14.1). */
const ANTIGRAVITY_BIN = AGENT_BINARY.antigravity;

/** How long to wait for `agy --version` before giving up (ms). */
const PROBE_TIMEOUT_MS = 10_000;

/** The agy `--mode` value used for read-only roles. */
export const ANTIGRAVITY_PLAN_MODE = 'plan';

/** The agy `--mode` value used for write-capable roles. */
export const ANTIGRAVITY_ACCEPT_EDITS_MODE = 'accept-edits';

/** Build the `--mode <plan|accept-edits>` flag pair for a role. */
export function antigravityModeFlags(role: Role): string[] {
  return ['--mode', isReadOnlyRole(role) ? ANTIGRAVITY_PLAN_MODE : ANTIGRAVITY_ACCEPT_EDITS_MODE];
}

/**
 * The antigravity (`agy`) CLI adapter (Requirement 14.1). Flags verified
 * against `agy` v1.2.2 via `agy --version`/`agy --help`.
 *
 * Deliberate degrades from the Claude adapter, documented here rather than
 * silently implied to be enforced:
 *
 * 1. agy mints its own conversation id on a fresh run and exposes no flag to
 *    pre-assign one, so `launch()` ignores `req.sessionId` when `req.resume`
 *    is false; the journal's recorded session id will not match agy's actual
 *    conversation for a fresh launch.
 * 2. agy has no scoped write allow-list like claude's `Write(.baiton/runs/**)`,
 *    so read-only roles rely on `--mode plan` refusing edits outright rather
 *    than a scoped write allowance. There is no `readOnlyFallbackToAcceptEdits`
 *    -style flip because `plan` is agy's only non-edit mode.
 * 3. Unlike opencode, agy DOES support `--add-dir`, so the Requirement 15.4
 *    per-run grant is emitted normally via `runDirGrant(req.runId)` — this is
 *    not a degrade.
 * 4. `--dangerously-skip-permissions` is deliberately never emitted.
 * 5. Unlike claude, opencode, and codex, agy receives NO role-profile system
 *    prompt (`src/adapter/roleProfile.ts`). `agy` 1.2.2 exposes `--agent
 *    <name>` and an `agy agents` listing, but the listing printed nothing on
 *    the development host and the agent-definition format is undocumented in
 *    `--help`, so there is no verified way to deliver the profile's prose.
 *    The consequence is concrete: for an antigravity role the Brief
 *    (`src/engine/roleInstructions.ts`) is the ONLY place the constraints are
 *    stated — which is why `EXECUTOR_NO_GIT_INSTRUCTION` stays in the brief
 *    even though the executor profile now repeats it.
 *    TODO: investigate `agy --agent` / `agy agents` and, if agents can be
 *    defined, translate the role profile here the way the opencode adapter
 *    does.
 */
export class AntigravityAdapter implements Adapter {
  readonly id = 'antigravity' as const;

  /**
   * Run `agy --version` and report readiness (Requirements 14.2–14.4). A
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
          reason: `${ANTIGRAVITY_BIN} --version produced no version output`,
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
   * Fresh launch: `agy --model <m> [--effort <e>] --mode <plan|accept-edits>
   * --add-dir <run-dir> --prompt-interactive "<prompt>"` (`req.sessionId` is
   * deliberately dropped, see the class doc comment). Resume:
   * `--conversation <resumeSessionId>` leads the arguments when a prior
   * Session_Id is known, falling back to `-c` when it is not (Requirements
   * 13.2, 13.3, 15.1–15.4). Every role is additionally granted write access
   * to its own `.baiton/runs/<run-id>/` directory (Requirement 15.4).
   */
  launch(req: LaunchRequest): LaunchSpec {
    const args: string[] = [];

    if (req.resume) {
      if (req.resumeSessionId !== undefined && req.resumeSessionId.length > 0) {
        args.push('--conversation', req.resumeSessionId);
      } else {
        args.push('-c');
      }
    }

    args.push('--model', req.model);
    if (req.effort !== undefined && req.effort.length > 0) {
      args.push('--effort', req.effort);
    }

    args.push(...antigravityModeFlags(req.role));
    args.push(...runDirGrant(req.runId));
    args.push('--prompt-interactive', req.prompt);

    return { shellPath: ANTIGRAVITY_BIN, shellArgs: args };
  }

  /**
   * Build the args to reopen an existing session with no prompt: `agy
   * --conversation <id> --mode <plan|accept-edits> --add-dir <run-dir>`
   * (Requirements 3.3, 3.4).
   */
  attach(req: { role: Role; runId: string; sessionId: string }): LaunchSpec {
    const args: string[] = [
      '--conversation',
      req.sessionId,
      ...antigravityModeFlags(req.role),
      ...runDirGrant(req.runId),
    ];

    return { shellPath: ANTIGRAVITY_BIN, shellArgs: args };
  }

  /** Execute `agy --version`, resolving stdout or rejecting on failure. */
  private runVersion(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      execFile(
        ANTIGRAVITY_BIN,
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
    return `${ANTIGRAVITY_BIN} was not found on PATH`;
  }
  if (e instanceof Error && e.message.length > 0) {
    return `${ANTIGRAVITY_BIN} --version failed: ${e.message}`;
  }
  return `${ANTIGRAVITY_BIN} --version failed`;
}
