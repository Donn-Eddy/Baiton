import { execFile } from 'child_process';
import type { Adapter, LaunchRequest, LaunchSpec, ProbeResult } from './adapter';
import { AGENT_BINARY } from './adapter';
import type { Role } from '../model/role';
import { isReadOnlyRole } from './permissions';

/** The opencode CLI executable name, sourced from the canonical binary map (Requirement 14.1). */
const OPENCODE_BIN = AGENT_BINARY.opencode;

/** How long to wait for `opencode --version` before giving up (ms). */
const PROBE_TIMEOUT_MS = 10_000;

/** The opencode `--agent` profile used for read-only roles. */
export const OPENCODE_PLAN_AGENT = 'plan';

/** The opencode `--agent` profile used for write-capable roles. */
export const OPENCODE_BUILD_AGENT = 'build';

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
export const OPENCODE_MODEL_DOC_URL = 'https://opencode.ai/docs/models/';

/** Build the `--agent <name>` flag pair for a role. */
export function opencodeAgentFlags(role: Role): string[] {
  return ['--agent', isReadOnlyRole(role) ? OPENCODE_PLAN_AGENT : OPENCODE_BUILD_AGENT];
}

/**
 * The opencode CLI adapter (Requirement 14.1).
 *
 * Two deliberate degrades from the Claude adapter, both documented here rather
 * than silently implied to be enforced:
 *
 * 1. opencode has no `--add-dir` flag and no granular allow-list, so this
 *    adapter cannot emit the per-run write grant that Requirement 15.4 /
 *    `runDirGrant()` expresses for claude. The run-dir scoping is unenforced
 *    for opencode roles and is relied on only via the brief. `--auto` is
 *    deliberately not used to approximate acceptEdits because it auto-approves
 *    everything (opencode's own help calls it "dangerous!"). Per-role
 *    permissioning is expressed only through `--agent <name>`, whose profiles
 *    are user-configured in opencode, so the mapping is best-effort.
 * 2. opencode mints its own session id on a fresh run and exposes no flag to
 *    pre-assign one, so `launch()` ignores `req.sessionId` when `req.resume`
 *    is false.
 */
export class OpencodeAdapter implements Adapter {
  readonly id = 'opencode' as const;

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
   * Fresh launch: `opencode run -m <model> --agent <plan|build> [--variant
   * <effort>] -i "<prompt>"` (`req.sessionId` is deliberately dropped, see the
   * class doc comment). Resume: `-s <resumeSessionId>` when a prior Session_Id
   * is known, falling back to `-c` when it is not (Requirements 13.2, 13.3).
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
    args.push(...opencodeAgentFlags(req.role));
    if (req.effort !== undefined && req.effort.length > 0) {
      args.push('--variant', req.effort);
    }
    args.push('-i');
    args.push(req.prompt);

    return { shellPath: OPENCODE_BIN, shellArgs: args };
  }

  /**
   * Build the args to reopen an existing session with no prompt: `opencode
   * run -s <id> --agent <plan|build> -i` (Requirements 3.3, 3.4).
   *
   * `req.runId` is accepted to satisfy the {@link Adapter} signature but
   * unused: there is no `--add-dir` to grant it with.
   */
  attach(req: { role: Role; runId: string; sessionId: string }): LaunchSpec {
    const args: string[] = ['run', '-s', req.sessionId, ...opencodeAgentFlags(req.role), '-i'];

    return { shellPath: OPENCODE_BIN, shellArgs: args };
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
