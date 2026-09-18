import { execFile } from 'child_process';
import type { Adapter, LaunchRequest, LaunchSpec, ProbeResult } from './adapter';
import { AGENT_BINARY, AdapterLaunchError } from './adapter';
import type { Role } from '../model/role';
import { isReadOnlyRole, runDirGrant } from './permissions';

/** The antigravity CLI executable name, sourced from the canonical binary map (Requirement 14.1). */
const ANTIGRAVITY_BIN = AGENT_BINARY.antigravity;

/**
 * Reasoning effort levels offered in the config panel dropdown (Requirement
 * 14.1): the union of the per-family suffixes in {@link ANTIGRAVITY_MODELS}.
 * Whether a given pair is accepted is decided per family by
 * {@link antigravityModelFlags}.
 */
export const ANTIGRAVITY_EFFORTS = ['low', 'medium', 'high'] as const;

/** How long to wait for `agy --version` before giving up (ms). */
const PROBE_TIMEOUT_MS = 10_000;

/** The agy `--mode` value used for read-only roles. */
export const ANTIGRAVITY_PLAN_MODE = 'plan';

/** The agy `--mode` value used for write-capable roles. */
export const ANTIGRAVITY_ACCEPT_EDITS_MODE = 'accept-edits';

/**
 * The agy model catalogue, as listed by `agy models` (v1.2.2), keyed by the
 * bare family name Baiton config uses. agy has no separate effort control
 * for most models: for Gemini the effort is baked into the model id as a
 * suffix (`gemini-3.8-flash-medium`) and `--effort` is only accepted, and in
 * fact required, alongside the *bare* family id. Claude and GPT-OSS ids take
 * no effort at all and agy rejects `--effort` for them outright.
 *
 * `efforts` lists the suffixes agy offers for a family; an empty list means
 * the id is fixed and effort is not configurable. Refresh from `agy models`
 * when agy adds a model. The catalogue's keys are also the model dropdown
 * the config panel offers for antigravity (see `agentCapabilities()`), with
 * "Other…" for anything newer.
 */
export const ANTIGRAVITY_MODELS: Readonly<Record<string, readonly string[]>> = {
  'gemini-3.8-flash': ['low', 'medium', 'high'],
  'gemini-3.7-flash': ['low', 'medium', 'high'],
  'gemini-3.6-flash': ['low', 'medium', 'high'],
  'gemini-3.1-pro': ['low', 'high'],
  'claude-sonnet-4-6': [],
  'claude-opus-4-6-thinking': [],
  'gpt-oss-120b-medium': [],
};

/**
 * Resolve a config `model` + `effort` pair to the `--model <id>` agy needs
 * (Requirement 14.1). The adapter is model-aware: a bare Gemini family plus
 * an effort maps to the suffixed id (`gemini-3.8-flash` + `medium` →
 * `gemini-3.8-flash-medium`); an already-suffixed id passes through when its
 * effort agrees or is unset; a fixed id (Claude, GPT-OSS) passes through and
 * any effort is dropped as a documented degrade; an id agy does not list
 * passes through verbatim, with `--effort` if set, so a newer agy can still
 * validate it itself.
 *
 * Throws {@link AdapterLaunchError} when agy is known to reject the pair: a
 * bare Gemini family with no effort or an effort it does not offer, or a
 * suffixed Gemini id whose suffix contradicts the configured effort.
 */
/** Own-key lookup into the catalogue (a model named `__proto__` must not hit the prototype). */
function catalogueEfforts(id: string): readonly string[] | undefined {
  return Object.prototype.hasOwnProperty.call(ANTIGRAVITY_MODELS, id) ? ANTIGRAVITY_MODELS[id] : undefined;
}

export function antigravityModelFlags(model: string, effort: string | undefined): string[] {
  const hasEffort = effort !== undefined && effort.length > 0;
  const wanted = hasEffort ? effort : undefined;

  // Bare family known to the catalogue.
  const efforts = catalogueEfforts(model);
  if (efforts !== undefined) {
    if (efforts.length === 0) {
      // Fixed id: agy rejects --effort for it, so the effort is dropped.
      return ['--model', model];
    }
    if (wanted === undefined) {
      throw new AdapterLaunchError(
        `agy model "${model}" requires an effort (one of: ${efforts.join(', ')}); set "effort" for the role`,
      );
    }
    if (!efforts.includes(wanted)) {
      throw new AdapterLaunchError(
        `agy model "${model}" does not offer effort "${wanted}" (available: ${efforts.join(', ')})`,
      );
    }
    return ['--model', `${model}-${wanted}`];
  }

  // Suffixed Gemini id: split off a trailing effort and check it against the
  // family's catalogue entry.
  const dash = model.lastIndexOf('-');
  if (dash > 0) {
    const family = model.slice(0, dash);
    const suffix = model.slice(dash + 1);
    const familyEfforts = catalogueEfforts(family);
    if (familyEfforts !== undefined && familyEfforts.includes(suffix)) {
      if (wanted !== undefined && wanted !== suffix) {
        throw new AdapterLaunchError(
          `agy model "${model}" already fixes the effort to "${suffix}", which conflicts with the role's effort "${wanted}"; use "${family}" with an effort or drop the effort`,
        );
      }
      return ['--model', model];
    }
  }

  // Unknown to the catalogue: pass through and let agy validate.
  return wanted !== undefined ? ['--model', model, '--effort', wanted] : ['--model', model];
}

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
 *
 *    CONSEQUENCE — read-only roles on agy are effectively unsupported.
 *    `--mode plan` is a whole-session read-only mode with no per-path escape:
 *    `agy --help` (v1.2.2) offers only `--mode accept-edits|plan`, no
 *    permission/allow-list flag, and no config-content environment layer to
 *    define a custom agent with one (`agy agent`/`agents` only lists agents).
 *    So a spec-writer, planner, plan-reviewer or pr-writer run on agy is
 *    expected to REFUSE to write its own `.baiton/runs/<run-id>/result.json`,
 *    exit 0, and be recorded by the queue as `closed (exit 0)` with the todo
 *    reverted. `--add-dir` widens the visible workspace; it does not lift plan
 *    mode's edit ban. This mirrors exactly the opencode bug fixed by moving
 *    that adapter off the built-in `--agent plan` onto Baiton-owned agents
 *    declared in `OPENCODE_CONFIG_CONTENT` (see src/adapter/opencode.ts);
 *    opencode had an env-var config layer to fix it with, agy does not. Use
 *    claude (or opencode) for read-only roles until agy grows a scoped write
 *    grant; the args below are deliberately left unchanged because there is no
 *    correct alternative to emit.
 * 3. Unlike opencode, agy DOES support `--add-dir`, so the Requirement 15.4
 *    per-run grant is emitted normally via `runDirGrant(req.runId)` — this is
 *    not a degrade.
 * 4. `--dangerously-skip-permissions` is deliberately never emitted.
 * 6. agy has no standalone effort control for most models: Gemini efforts
 *    are model-id suffixes and Claude/GPT-OSS ids take none, and agy exits
 *    with "invalid model selection" when `--effort` is passed with either.
 *    `launch()` therefore maps model+effort through
 *    {@link antigravityModelFlags}: a bare Gemini family gains the effort as
 *    a suffix, a fixed id drops the effort, an unknown id passes through.
 *    Pairs agy is known to reject throw `AdapterLaunchError` so the stage is
 *    refused before a terminal opens.
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
   * antigravity mints its own session id and has no flag to pre-assign one,
   * so Baiton's journal `sessionId` is not resumable with it.
   */
  readonly acceptsSessionId = false;

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
   * Fresh launch: `agy --model <m> [--effort <e>] --mode <plan|accept-edits>` where
   * `<m>`/`<e>` come from {@link antigravityModelFlags} (model-aware mapping;
   * throws `AdapterLaunchError` for pairs agy rejects). Full shape: `agy --model <m> [--effort <e>] --mode <plan|accept-edits>
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

    args.push(...antigravityModelFlags(req.model, req.effort));

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
