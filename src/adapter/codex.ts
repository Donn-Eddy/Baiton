import { execFile } from 'child_process';
import type { Adapter, LaunchRequest, LaunchSpec, ProbeResult } from './adapter';
import { AGENT_BINARY } from './adapter';
import type { Role } from '../model/role';
import { isReadOnlyRole, runDirGrant } from './permissions';

/** The codex CLI executable name, sourced from the canonical binary map (Requirement 14.1). */
const CODEX_BIN = AGENT_BINARY.codex;

/** How long to wait for `codex --version` before giving up (ms). */
const PROBE_TIMEOUT_MS = 10_000;

/** The codex `--sandbox` value used for read-only roles. */
export const CODEX_READ_ONLY_SANDBOX = 'read-only';

/** The codex `--sandbox` value used for write-capable roles. */
export const CODEX_WORKSPACE_WRITE_SANDBOX = 'workspace-write';

/** The codex `--ask-for-approval` value used for every role. */
export const CODEX_ASK_FOR_APPROVAL = 'on-request';

/** Build the `--sandbox <read-only|workspace-write> --ask-for-approval on-request` flags for a role. */
export function codexPermissionFlags(role: Role): string[] {
  return [
    '--sandbox',
    isReadOnlyRole(role) ? CODEX_READ_ONLY_SANDBOX : CODEX_WORKSPACE_WRITE_SANDBOX,
    '--ask-for-approval',
    CODEX_ASK_FOR_APPROVAL,
  ];
}

/** The config key codex's generic `--config` override uses to set reasoning effort. */
export const CODEX_EFFORT_CONFIG_KEY = 'model_reasoning_effort';

/** Build the `--config model_reasoning_effort=<effort>` flag pair, or `[]` when effort is unset. */
export function codexEffortFlags(effort: string | undefined): string[] {
  if (effort === undefined || effort.length === 0) {
    return [];
  }
  return ['--config', `${CODEX_EFFORT_CONFIG_KEY}=${effort}`];
}

/**
 * The codex CLI adapter (Requirement 14.1). Flags verified against
 * `codex-cli` v0.154.0 via `codex --version`/`codex --help`/`codex resume
 * --help`.
 *
 * Deliberate degrades from the Claude adapter, documented here rather than
 * silently implied to be enforced:
 *
 * 1. codex mints its own session UUID on a fresh run and exposes no flag to
 *    pre-assign one, so `launch()` ignores `req.sessionId` when `req.resume`
 *    is false; the journal's recorded session id will not match codex's
 *    actual session for a fresh launch.
 * 2. The interactive form `codex [OPTIONS] [PROMPT]` is used, NOT the `codex
 *    exec` subcommand, because `exec` is a non-interactive one-shot that
 *    exits — the wrong shape for a terminal the user watches and interjects
 *    in.
 * 3. codex has no reasoning-effort flag; effort is degraded onto
 *    `--config model_reasoning_effort=<effort>`, codex's generic config
 *    override.
 * 4. Resume with no known prior id uses `codex resume --last` and DROPS the
 *    prompt: `codex resume --last <text>` binds `<text>` to the SESSION_ID
 *    positional, not PROMPT, so passing the prompt there would silently be
 *    read as a session name and the resume would target a session that does
 *    not exist.
 * 5. Read-only roles get `--sandbox read-only`, which is a whole-session
 *    sandbox rather than claude's scoped `Write(.baiton/runs/**)` allow-list.
 *    The Requirement 15.4 run-dir grant is still emitted via `--add-dir`, but
 *    it may not make the run dir writable under `read-only`; the documented
 *    fallback if that proves true is to widen read-only roles to
 *    `--sandbox workspace-write`, a one-constant change at
 *    `CODEX_READ_ONLY_SANDBOX`'s use site.
 * 6. `--dangerously-bypass-approvals-and-sandbox`,
 *    `--dangerously-bypass-hook-trust`, `--approve-for-me`,
 *    `--sandbox danger-full-access` and `--ask-for-approval never` are
 *    deliberately never emitted.
 */
export class CodexAdapter implements Adapter {
  readonly id = 'codex' as const;

  /**
   * Run `codex --version` and report readiness (Requirements 14.2–14.4). A
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
          reason: `${CODEX_BIN} --version produced no version output`,
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
   * Fresh launch: `codex --model <m> [--config model_reasoning_effort=<e>]
   * --sandbox <read-only|workspace-write> --ask-for-approval on-request
   * --add-dir <run-dir> -- "<prompt>"` (`req.sessionId` is deliberately
   * dropped, see the class doc comment). Resume: `resume <resumeSessionId>`
   * leads the arguments when a prior Session_Id is known, falling back to
   * `resume --last` (with no prompt) when it is not (Requirements 13.2, 13.3,
   * 15.1–15.4). Every role is additionally granted write access to its own
   * `.baiton/runs/<run-id>/` directory (Requirement 15.4).
   */
  launch(req: LaunchRequest): LaunchSpec {
    const args: string[] = [];
    let droppedPrompt = false;

    if (req.resume) {
      if (req.resumeSessionId !== undefined && req.resumeSessionId.length > 0) {
        args.push('resume', req.resumeSessionId);
      } else {
        args.push('resume', '--last');
        droppedPrompt = true;
      }
    }

    args.push('--model', req.model);
    args.push(...codexEffortFlags(req.effort));
    args.push(...codexPermissionFlags(req.role));
    args.push(...runDirGrant(req.runId));

    if (!droppedPrompt) {
      args.push('--', req.prompt);
    }

    return { shellPath: CODEX_BIN, shellArgs: args };
  }

  /**
   * Build the args to reopen an existing session with no prompt: `codex
   * resume <id> --sandbox <read-only|workspace-write> --ask-for-approval
   * on-request --add-dir <run-dir>` (Requirements 3.3, 3.4).
   */
  attach(req: { role: Role; runId: string; sessionId: string }): LaunchSpec {
    const args: string[] = [
      'resume',
      req.sessionId,
      ...codexPermissionFlags(req.role),
      ...runDirGrant(req.runId),
    ];

    return { shellPath: CODEX_BIN, shellArgs: args };
  }

  /** Execute `codex --version`, resolving stdout or rejecting on failure. */
  private runVersion(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      execFile(
        CODEX_BIN,
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
    return `${CODEX_BIN} was not found on PATH`;
  }
  if (e instanceof Error && e.message.length > 0) {
    return `${CODEX_BIN} --version failed: ${e.message}`;
  }
  return `${CODEX_BIN} --version failed`;
}
