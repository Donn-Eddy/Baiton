import { execFile } from 'child_process';
import type { Adapter, LaunchRequest, LaunchSpec, ProbeResult } from './adapter';
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

  /**
   * @param mode the permission mode; the read-only `acceptEdits` fallback is a
   *   config flip here (Requirement 15.7) and changes no other plumbing.
   */
  constructor(private readonly mode: PermissionMode = DEFAULT_PERMISSION_MODE) {}

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
