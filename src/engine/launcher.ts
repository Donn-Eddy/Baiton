/**
 * The Brief writer + terminal launcher (Requirements 11.1–11.5, 17.5).
 *
 * {@link launchStage} performs the fixed handoff for one stage:
 *
 *   1. Resolve the run directory under the workspace root and the absolute
 *      `brief.md` / `result.json` paths.
 *   2. Write the Brief with its sections in the required order (Req 11.3) via
 *      {@link writeBrief}.
 *   3. Create the terminal with the adapter's `shellPath`/`shellArgs` and `cwd`
 *      at the workspace root, with no intervening shell (Req 11.1, 11.2), using
 *      the injected {@link TerminalHost} seam.
 *   4. Hand the one-line initial prompt `Read <brief path> and do what it says.`
 *      to the CLI as its positional argument (Req 11.4).
 *
 * When `relayAsks` is set the launcher also creates the run's optional
 * `asks/` directory and hands the adapter an ask-relay descriptor naming it,
 * so harness permission asks can be relayed into the chat (Auto mode).
 * With the flag omitted the launch is byte-identical to the previous
 * behaviour.
 *
 * If resolving the workspace root or writing the Brief fails, it halts before
 * creating any terminal and returns a {@link Result} error; the caller leaves
 * the todo's state unchanged (Req 11.5). All git-forbidding executor guidance
 * lives in the Brief (Req 17.5), carried by the role instructions.
 *
 * The launcher is host-independent: the adapter computes launch args, the
 * `TerminalHost` seam creates the terminal, and node `fs`/`path` handle the
 * Brief. The activation layer wires a `vscode`-backed `TerminalHost` later.
 */
import { mkdirSync } from 'fs';
import * as path from 'path';
import type { Stage } from '../model/stage';
import type { Role } from '../model/role';
import { Result, err, ok } from '../model/result';
import type { Adapter, LaunchSpec } from '../adapter';
import { AdapterLaunchError } from '../adapter';
import { writeBrief } from './brief';
import { askRelayDescriptor, ensureAsksDir } from './askRelay';
import type { HostTerminal, TerminalHost } from './terminalHost';
import type { AskRelayDescriptor } from '../adapter';

/** The file name of the Brief inside a run directory (Req 11.2). */
export const BRIEF_FILE_NAME = 'brief.md';

/** The file name of the Result_File inside a run directory (Req 11.3). */
export const RESULT_FILE_NAME = 'result.json';

/** Everything {@link launchStage} needs to write the Brief and launch. */
export interface LaunchStageInput {
  /** Absolute path of the workspace root; the terminal `cwd` (Req 11.2). */
  workspaceRoot: string;
  /** The run id; names the `.baiton/runs/<run-id>/` directory (Req 11.2). */
  runId: string;
  /** The stage being dispatched (selects the schema section of the Brief). */
  stage: Stage;
  /** The role being launched (selects the Brief's opening instructions). */
  role: Role;
  /** The model identifier passed through to the adapter. */
  model: string;
  /** Optional reasoning effort passed through to the adapter. */
  effort?: string;
  /** True to resume a prior session (executor continuation) (Req 13). */
  resume: boolean;
  /** The Claude `--session-id` UUID for a fresh launch (Req 3.1). */
  sessionId: string;
  /** The prior Session_Id to resume with `--resume <id>` (Req 3.2). */
  resumeSessionId?: string;
  /** Optional markdown context written into the Brief after the role section. */
  briefContext?: string;
  /**
   * True to relay this run's harness asks through `.baiton/runs/<run-id>/asks/`
   * (Auto mode + inline permission cards). Default false keeps the previous
   * launch behaviour.
   */
  relayAsks?: boolean;
}

/** What a successful launch produced (Req 11.1–11.4). */
export interface LaunchStageOutput {
  /** The created terminal, so the caller can watch/dispose it (task 10.2). */
  terminal: HostTerminal;
  /** Absolute path of the written Brief. */
  briefPath: string;
  /** Absolute path of the Result_File the Sub_Agent must write. */
  resultPath: string;
  /** The exact initial prompt sent to the terminal (Req 11.4). */
  initialPrompt: string;
  /** The launch spec the terminal was created from (Req 11.1). */
  launchSpec: LaunchSpec;
  /** The ask-relay descriptor handed to the adapter, when the relay was enabled. */
  relay?: AskRelayDescriptor;
}

/**
 * Why a launch was halted before the Sub_Agent ran (Req 11.5). Both variants
 * mean no terminal was created and the caller must leave the todo unchanged.
 *
 * - `root-resolution` — the workspace root could not be resolved.
 * - `launch-args`     — the adapter refused the request (e.g. a model/effort
 *                       pair the CLI rejects); `message` says what to fix.
 * - `brief-write`     — writing `brief.md` failed; `path` names the target.
 */
export type LaunchError =
  | { kind: 'root-resolution'; message: string }
  | { kind: 'launch-args'; message: string }
  | { kind: 'brief-write'; path: string; message: string };

/**
 * Build the exact initial prompt for a Brief path (Req 11.4). Exported so the
 * activation layer and tests can assert the wording verbatim.
 */
export function initialPromptFor(briefPath: string): string {
  return `Read ${briefPath} and do what it says.`;
}

/**
 * The dependencies {@link launchStage} needs, injected so the function stays
 * host-independent: the adapter (launch args), the terminal host (creation),
 * and the brief writer (defaulted to the real `fs`-backed {@link writeBrief},
 * overridable in tests).
 */
export interface LaunchDeps {
  /** The adapter already selected for `input.role` by the caller — not a global one (Req 14.1). */
  adapter: Adapter;
  terminalHost: TerminalHost;
  /** Writes the Brief and returns its text; throws on write failure (Req 11.5). */
  writeBriefFn?: typeof writeBrief;
}

/**
 * Write the Brief and launch the Sub_Agent for one stage (Req 11.1–11.5).
 *
 * On success the terminal has been created at the workspace root running the
 * adapter's `shellPath`/`shellArgs` and has been sent the initial prompt. On a
 * root-resolution or brief-write failure it returns an error before creating
 * any terminal, leaving state to the caller (Req 11.5).
 */
export function launchStage(
  input: LaunchStageInput,
  deps: LaunchDeps,
): Result<LaunchStageOutput, LaunchError> {
  const writeBriefFn = deps.writeBriefFn ?? writeBrief;

  // 1. Resolve the workspace root and the run directory paths. A missing or
  //    non-absolute root halts the stage without launching (Req 11.5).
  const rootCheck = resolveRoot(input.workspaceRoot);
  if (!rootCheck.ok) {
    return rootCheck;
  }
  const root = rootCheck.value;

  const runDir = path.join(root, '.baiton', 'runs', input.runId);
  const briefPath = path.join(runDir, BRIEF_FILE_NAME);
  const resultPath = path.join(runDir, RESULT_FILE_NAME);

  // Ask relay: only when explicitly enabled, so an unset flag produces a
  // launch request byte-identical to the previous behaviour.
  const relay = input.relayAsks === true ? askRelayDescriptor(root, input.runId) : undefined;

  // 2. Build the launch args. An adapter that cannot express the request in
  //    the CLI's argv (e.g. an agy model/effort pair agy rejects) halts here,
  //    before the run directory or Brief exist, with no terminal created.
  let launchSpec: LaunchSpec;
  try {
    launchSpec = deps.adapter.launch({
      role: input.role,
      model: input.model,
      effort: input.effort,
      prompt: initialPromptFor(briefPath),
      runId: input.runId,
      resume: input.resume,
      sessionId: input.sessionId,
      resumeSessionId: input.resumeSessionId,
      ...(relay ? { relay } : {}),
    });
  } catch (cause) {
    if (cause instanceof AdapterLaunchError) {
      return err({ kind: 'launch-args', message: cause.message });
    }
    throw cause;
  }

  // 3. Ensure the run directory exists, then write the Brief (sections in the
  //    required order, Req 11.3). A mkdir or write failure halts before
  //    launching, with no terminal created (Req 11.5).
  try {
    mkdirSync(runDir, { recursive: true });
    if (relay) {
      ensureAsksDir(root, input.runId);
    }
    writeBriefFn(briefPath, {
      stage: input.stage,
      role: input.role,
      resultPath,
      ...(input.briefContext !== undefined ? { context: input.briefContext } : {}),
    });
  } catch (cause) {
    return err({
      kind: 'brief-write',
      path: briefPath,
      message: `failed to write brief: ${errorMessage(cause)}`,
    });
  }

  // 4. Create the terminal with the adapter's launch args and cwd at the
  //    workspace root, no intervening shell (Req 11.1, 11.2).
  const terminal = deps.terminalHost.createTerminal({
    name: `Baiton ${input.stage} ${input.runId}`,
    shellPath: launchSpec.shellPath,
    shellArgs: launchSpec.shellArgs,
    cwd: root,
    env: launchSpec.env,
  });

  // 5. The one-line initial prompt (Req 11.4) is the CLI's positional
  //    argument (see `launchSpec.shellArgs`), which the CLI submits itself on
  //    startup. It is deliberately not also sent via `sendText`: a second copy
  //    arriving during TUI startup is treated as a paste and left unsent in
  //    the composer.
  const initialPrompt = initialPromptFor(briefPath);

  return ok({
    terminal,
    briefPath,
    resultPath,
    initialPrompt,
    launchSpec,
    ...(relay ? { relay } : {}),
  });
}

/**
 * Validate the workspace root: it must be a non-empty absolute path. Returning
 * a Result (rather than throwing) lets the caller surface a root-resolution
 * failure and leave state unchanged (Req 11.5).
 *
 * The root is expected to be canonical already — it is symlink-resolved once at
 * activation ingress (see `canonicalizeRoot` in `src/activation/workspace.ts`) —
 * so this deliberately validates only shape and does not realpath. Resolving
 * here instead would make the brief's paths canonical while the run queue and
 * result validation still compared against the raw root, introducing a second
 * spelling mismatch inside Baiton itself.
 */
function resolveRoot(
  workspaceRoot: string,
): Result<string, LaunchError> {
  if (typeof workspaceRoot !== 'string' || workspaceRoot.trim().length === 0) {
    return err({
      kind: 'root-resolution',
      message: 'workspace root is empty',
    });
  }
  if (!path.isAbsolute(workspaceRoot)) {
    return err({
      kind: 'root-resolution',
      message: `workspace root is not an absolute path: ${workspaceRoot}`,
    });
  }
  return ok(workspaceRoot);
}

/** Extract a user-facing message from an unknown thrown value. */
function errorMessage(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message;
  }
  return String(cause);
}
