import { execFile } from 'child_process';
import type { Adapter, LaunchRequest, LaunchSpec, ProbeResult } from './adapter';
import { AGENT_BINARY } from './adapter';
import type { Role } from '../model/role';
import { isReadOnlyRole } from './permissions';

/** The opencode CLI executable name, sourced from the canonical binary map (Requirement 14.1). */
const OPENCODE_BIN = AGENT_BINARY.opencode;

/** How long to wait for `opencode --version` before giving up (ms). */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * The environment variable opencode reads a JSON config document from and
 * merges as a local config layer. Verified against opencode 1.18.31.
 */
export const OPENCODE_CONFIG_ENV_VAR = 'OPENCODE_CONFIG_CONTENT';

/**
 * The Baiton-owned `--agent` name for the read-only roles (spec-writer,
 * planner, plan-reviewer, pr-writer): may write only its own run directory and
 * may not run commands.
 */
export const OPENCODE_READONLY_AGENT = 'baiton-readonly';

/**
 * The Baiton-owned `--agent` name for the reviewer: the read-only edit scope
 * plus command execution (Requirement 15.2).
 */
export const OPENCODE_REVIEWER_AGENT = 'baiton-reviewer';

/**
 * The Baiton-owned `--agent` name for the executor: unrestricted edits and
 * command execution (Requirement 15.3).
 */
export const OPENCODE_EXECUTOR_AGENT = 'baiton-executor';

/**
 * Opencode model list: empty by design because opencode models are arbitrary
 * `provider/model` identifiers configured by the user or provider.
 * An empty list signals free-text rendering in the config panel.
 */
export const OPENCODE_MODELS: readonly string[] = [];

/**
 * Opencode effort list: empty by design because effort maps to user-configured
 * `--variant` values. An empty list signals free-text rendering in the config panel.
 */
export const OPENCODE_EFFORTS: readonly string[] = [];

/** Documentation URL for opencode model selection rendered inline in the config panel. */
export const OPENCODE_MODEL_DOC_URL = 'https://opencode.ai/docs/go/';

/** The Baiton-owned `--agent` name a role launches under. */
export function opencodeAgentName(role: Role): string {
  if (role === 'executor') {
    return OPENCODE_EXECUTOR_AGENT;
  }
  if (isReadOnlyRole(role)) {
    return OPENCODE_READONLY_AGENT;
  }
  return OPENCODE_REVIEWER_AGENT;
}

/**
 * The per-run write grant expressed as an opencode `edit` permission map:
 * every path is denied except the run's own artifact directory (Requirement
 * 15.4). opencode's write/edit/patch tools all ask the `edit` permission with
 * the worktree-relative file path, matched against these glob keys.
 */
function runDirEditPermission(runId: string): Record<string, string> {
  return { '*': 'deny', [`.baiton/runs/${runId}/**`]: 'allow' };
}

/**
 * Build the JSON config document passed to opencode through
 * {@link OPENCODE_CONFIG_ENV_VAR} for one launch.
 *
 * It defines exactly one Baiton-owned primary agent — the one named by
 * `--agent` — so the per-role permission row (Requirement 15.1–15.4) is
 * enforced by opencode itself rather than merely asked for in the brief, and
 * so the launch never depends on the user's own agent definitions.
 */
export function opencodeConfigContent(role: Role, runId: string): string {
  const name = opencodeAgentName(role);
  const permission =
    role === 'executor'
      ? { edit: 'allow', bash: 'allow' }
      : {
          edit: runDirEditPermission(runId),
          bash: role === 'reviewer' ? 'allow' : 'deny',
        };

  return JSON.stringify({
    agent: {
      [name]: {
        description: `Baiton ${role}: ${
          role === 'executor'
            ? 'implements the plan and writes its run result file.'
            : 'reads the repo and writes only its run result file.'
        }`,
        mode: 'primary',
        permission,
      },
    },
  });
}

/**
 * The opencode CLI adapter (Requirement 14.1).
 *
 * Per-role permissioning is Baiton-owned rather than borrowed from opencode's
 * built-in `plan`/`build` agents. Each launch exports
 * `OPENCODE_CONFIG_CONTENT` — a JSON config document opencode merges as a
 * local config layer — defining one primary agent (`baiton-readonly`,
 * `baiton-reviewer` or `baiton-executor`) whose `permission.edit` map denies
 * every path except `.baiton/runs/<run-id>/**`, and whose `permission.bash` is
 * denied for read-only roles. `--agent <name>` then selects it. This replaces
 * the earlier `--agent plan` mapping, which was silently broken: opencode's
 * built-in `plan` agent carries a read-only system prompt, so the model refused
 * to write `result.json`, exited 0, and the stage was recorded as
 * `closed (exit 0)`. Overriding `agent.plan.permission` does not help — the
 * refusal comes from the prompt, not the permission layer. `--auto` is
 * deliberately not used to approximate acceptEdits because it auto-approves
 * everything (opencode's own help calls it "dangerous!").
 *
 * One deliberate degrade from the Claude adapter remains, documented here
 * rather than silently implied to be enforced: opencode mints its own session
 * id on a fresh run and exposes no flag to pre-assign one, so `launch()`
 * ignores `req.sessionId` when `req.resume` is false.
 */
export class OpencodeAdapter implements Adapter {
  readonly id = 'opencode' as const;

  /**
   * opencode mints its own session id and has no flag to pre-assign one, so
   * Baiton's journal `sessionId` names no session it knows and `run -s <id>`
   * would target a session that does not exist.
   */
  readonly acceptsSessionId = false;

  /**
   * Run `opencode --version` and report readiness (Requirements 14.2–14.4). A
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
          reason: `${OPENCODE_BIN} --version produced no version output`,
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
   * Fresh launch: `opencode run -m <model> --agent <baiton-*> [--variant
   * <effort>] -i "<prompt>"` with `OPENCODE_CONFIG_CONTENT` in the environment
   * carrying that agent's definition (`req.sessionId` is deliberately dropped,
   * see the class doc comment). Resume: `-s <resumeSessionId>` when a prior
   * Session_Id is known, falling back to `-c` when it is not (Requirements
   * 13.2, 13.3).
   */
  launch(req: LaunchRequest): LaunchSpec {
    const args: string[] = ['run'];

    if (req.resume) {
      if (req.resumeSessionId !== undefined && req.resumeSessionId.length > 0) {
        args.push('-s', req.resumeSessionId);
      } else {
        args.push('-c');
      }
    }

    args.push('-m', req.model);
    args.push('--agent', opencodeAgentName(req.role));
    if (req.effort !== undefined && req.effort.length > 0) {
      args.push('--variant', req.effort);
    }
    args.push('-i');
    args.push(req.prompt);

    return {
      shellPath: OPENCODE_BIN,
      shellArgs: args,
      env: { [OPENCODE_CONFIG_ENV_VAR]: opencodeConfigContent(req.role, req.runId) },
    };
  }

  /**
   * Build the args to reopen an existing session with no prompt: `opencode
   * run -s <id> --agent <baiton-*> -i` (Requirements 3.3, 3.4), with the same
   * `OPENCODE_CONFIG_CONTENT` grant the original launch carried so the agent
   * name still resolves and the run-dir scope still applies.
   */
  attach(req: { role: Role; runId: string; sessionId: string }): LaunchSpec {
    const args: string[] = [
      'run',
      '-s',
      req.sessionId,
      '--agent',
      opencodeAgentName(req.role),
      '-i',
    ];

    return {
      shellPath: OPENCODE_BIN,
      shellArgs: args,
      env: { [OPENCODE_CONFIG_ENV_VAR]: opencodeConfigContent(req.role, req.runId) },
    };
  }

  /** Execute `opencode --version`, resolving stdout or rejecting on failure. */
  private runVersion(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      execFile(
        OPENCODE_BIN,
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
    return `${OPENCODE_BIN} was not found on PATH`;
  }
  if (e instanceof Error && e.message.length > 0) {
    return `${OPENCODE_BIN} --version failed: ${e.message}`;
  }
  return `${OPENCODE_BIN} --version failed`;
}
