import * as vscode from 'vscode';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import {
  MINIMUM_VSCODE_VERSION,
  engineVersionAtLeast,
  unsupportedEngineMessage,
  resolveWorkspace,
  resolveAgentExecutables,
  type WorkspaceContext,
  type WorkspaceFolder,
  type ExecutableLookup,
  type OverrideGetter,
  type AgentExecutables,
} from './activation';
import { isErr } from './model/result';
import { loadConfig } from './config';
import type { Config } from './config';
import { createGitService } from './git';
import type { GitService } from './git';
import { recoverJournal } from './engine';
import type { ProcessControl } from './engine';
import { writeTodoState } from './model/writer';
import type { TodoState } from './model/todoState';
import { Surface } from './activation/surface';
import {
  registerCommands,
  registerInitializeCommand,
  registerConfigPanelCommand,
  resolveBaitonDirForCommands,
  type CommandSurface,
  type FolderScopedApplyConfig,
} from './activation/commands';
import { registerConfigPanel } from './activation/configPanel';
import { agentCapabilities, createAdapterRegistry } from './adapter';
import {
  createConfigRefresh,
  FOLDER_MISMATCH_NOTE,
  NOT_ACTIVATED_NOTE,
} from './activation/configRefresh';
import { ROLES } from './model/role';

/**
 * Extension entry point — the thin `vscode`-backed shell over the pure
 * activation cores (task 15.1; design "Activation and workspace resolution").
 *
 * Activation order (design "Activation / host"):
 *   1. Engine-version guard — refuse below {@link MINIMUM_VSCODE_VERSION} with a
 *      message (Req 23.3).
 *   2. Workspace resolution — a single folder, or the one multi-root folder
 *      containing `.baiton/`; refuse on zero or more than one (Req 22.3–22.5).
 *   3. Trust / restricted read — `vscode.workspace.isTrusted` becomes the
 *      context's `restricted` flag; under Restricted Mode all writes and
 *      dispatch are disabled (Req 22.1, 22.2).
 *   4. Config load — validate `.baiton/config.json` (task 5.1's `loadConfig`),
 *      then resolve one executable per distinct agent id named in
 *      `config.roles` (Req 22.7, 22.8, 14.5).
 *   5. Crash recovery — reconcile every result-less journal entry per spec
 *      (task 11.2's `recoverJournal`).
 *
 * Command registration (the `Baiton: Initialize` command, CodeLens, the chat
 * orchestrator entry, and the per-stage triggers) is wired in task 15.2 and is
 * intentionally deferred here — this shell establishes the workspace context
 * they all depend on.
 *
 * The extension state resolved here is stashed on the context for the command
 * layer to pick up once it lands.
 */

/** The extension settings namespace read for executable overrides (Req 22.7). */
const SETTINGS_NS = 'baiton';

/**
 * The resolved activation state shared with the command layer (task 15.2). Held
 * on the extension host so later wiring reads a single source of truth for the
 * workspace context, loaded config, and per-agent executable resolution.
 */
export interface ActivationState {
  /** The resolved workspace the extension operates on (Req 22.3–22.5). */
  readonly workspace: WorkspaceContext<vscode.Uri>;
  /**
   * The validated configuration loaded from `.baiton/config.json`.
   * Replaced wholesale by the refresh step on config save; must never be
   * destructured into a long-lived local.
   */
  config: Config;
  /**
   * One resolution per distinct agent id referenced by `config.roles` (Req
   * 22.7, 22.8, 14.5). Replaced wholesale by the refresh step when roles
   * change on config save; must never be destructured into a long-lived local.
   */
  executables: AgentExecutables;
}

/** The single resolved activation state, exposed for the command layer (task 15.2). */
let activationState: ActivationState | undefined;
/** The active command surface, retained to probe in-flight runs for config refresh notes. */
let commandSurface: CommandSurface | undefined;
/** Guard ensuring the gated half of activation runs at most once to prevent duplicate command registrations. */
let wired = false;

/** Read the activation state resolved by {@link activate}, if any. */
export function getActivationState(): ActivationState | undefined {
  return activationState;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  activationState = undefined;
  commandSurface = undefined;
  wired = false;

  // 1. Engine-version guard (Req 23.2, 23.3). Refuse below the minimum with a
  //    message naming the minimum required version, and activate no further.
  if (!engineVersionAtLeast(vscode.version, MINIMUM_VSCODE_VERSION)) {
    void vscode.window.showErrorMessage(unsupportedEngineMessage(vscode.version));
    return;
  }

  // The shared user-facing surface (output channel + notifications). Created
  // once and reused by the command layer and recovery (design "Error Handling").
  const surface = new Surface();
  context.subscriptions.push(surface.outputChannel);

  // Register `Baiton: Initialize` before the activation gate so it still works
  // in an as-yet-uninitialized folder (where config load fails by design)
  // (Req 1.1). It resolves its own workspace independently of the gate below.
  context.subscriptions.push(registerInitializeCommand(surface));

  // The host-free hot-reload seam for the config panel (T08).
  const applyConfig = createConfigRefresh({
    state: () => activationState,
    resolveExecutables: (agents) => resolveAgentExecutables(agents, pathLookup, settingsOverride),
    completeActivation: () => completeActivation(context, surface),
    runningSlugs: () => commandSurface?.runningSlugs() ?? [],
    log: (m) => surface.log(m),
  });

  // Scope the seam to the activated workspace folder: resolveBaitonDirForCommands
  // resolves its root independently, which in multi-root workspaces could differ
  // from the activated folder. Comparing baitonDir prevents applying folder A's
  // config to an extension activated against folder B.
  const scopedApplyConfig: FolderScopedApplyConfig = async (
    baitonDir: string,
    config: Config,
  ): Promise<readonly string[]> => {
    const current = getActivationState();
    if (current !== undefined && baitonDir !== current.workspace.baitonDir.fsPath) {
      return [FOLDER_MISMATCH_NOTE];
    }
    const notes = await applyConfig(config);
    const post = getActivationState();
    if (post !== undefined && baitonDir !== post.workspace.baitonDir.fsPath) {
      return [FOLDER_MISMATCH_NOTE];
    }
    return notes;
  };

  // Register the Config Panel WebviewView provider and the reveal command
  // ahead of the gate as well. `activate` returns early on a workspace-resolution
  // or config-load failure, and the view's error state plus Reset to defaults
  // is exactly what repairs an absent or unparseable `.baiton/config.json`.
  context.subscriptions.push(
    registerConfigPanel({
      extensionUri: context.extensionUri,
      resolveBaitonDir: resolveBaitonDirForCommands,
      agentIds: createAdapterRegistry().ids,
      capabilities: agentCapabilities(),
      log: (m) => surface.log(m),
      applyConfig: scopedApplyConfig,
    }),
  );
  context.subscriptions.push(registerConfigPanelCommand());

  // Run the gated half of activation. Failures at initial activation keep using showErrorMessage.
  void completeActivation(context, surface);
}

/**
 * Run the gated half of activation (workspace resolution, trust read, config load,
 * executable resolution, crash recovery, command registration).
 *
 * Guarded by `wired` so it runs at most once during a window's lifecycle,
 * preventing duplicate command registrations.
 */
async function completeActivation(
  context: vscode.ExtensionContext,
  surface: Surface,
): Promise<readonly string[]> {
  if (wired) {
    return [];
  }

  // 2. Workspace resolution (Req 22.3–22.5). Read the real workspace folders,
  //    probe each for a `.baiton/` directory, and resolve the single root.
  const folders = readWorkspaceFolders();
  // 3. Trust / restricted read (Req 22.1, 22.2). Restricted Mode = untrusted.
  const trusted = vscode.workspace.isTrusted;

  const resolved = resolveWorkspace<vscode.Uri>(folders, trusted, baitonDirOf);
  if (isErr(resolved)) {
    void vscode.window.showErrorMessage(resolved.error.message);
    return [NOT_ACTIVATED_NOTE(resolved.error.message)];
  }
  const workspace = resolved.value;

  // 4. Config load (task 5.1). A refusal surfaces the offending detail; without
  //    a valid config the extension does not proceed to recovery/dispatch.
  const configResult = await loadConfig(workspace.baitonDir.fsPath);
  if (isErr(configResult)) {
    void vscode.window.showErrorMessage(configResult.error.message);
    return [`Configuration saved, but could not be activated: ${configResult.error.message}`];
  }
  const config = configResult.value;

  // Locate every configured agent's executable on PATH with a per-agent
  // settings override (Req 22.7). Roles may name different agents, so
  // resolution is per distinct agent id and a miss disables dispatch only for
  // the roles that use it (Req 22.8, 14.5) — the workspace still opens for
  // browsing.
  const executables = resolveAgentExecutables(
    ROLES.map((role) => config.roles[role].agent),
    pathLookup,
    settingsOverride,
  );
  for (const failure of executables.errors) {
    void vscode.window.showWarningMessage(failure.message);
  }

  // 5. Crash recovery (task 11.2, Req 21.3–21.7). Reconcile each spec's
  //    result-less journal entries. Skipped under Restricted Mode, which
  //    forbids the state writes recovery replays (Req 22.1).
  if (!workspace.restricted) {
    await runCrashRecovery(workspace, surface);
  }

  const state: ActivationState = { workspace, config, executables };
  activationState = state;

  // Wire the command surface: per-stage triggers, approve/re-approve, the chat
  // orchestrator entry, and the spec CodeLens, all against the run queue and
  // tool registry built from this activation state (task 15.2). Writes and
  // dispatch stay gated under Restricted Mode and per-role executable
  // resolution (Req 22.1, 22.2, 14.5).
  commandSurface = registerCommands(
    context,
    state,
    surface,
  );
  context.subscriptions.push(...commandSurface.disposables);
  wired = true;

  // Reveal the stage/approve/chat commands in the palette only once activation
  // has resolved a workspace and wired the surface (the `when` clauses in
  // `package.json` gate on this context key).
  void vscode.commands.executeCommand('setContext', 'baiton.activated', true);

  context.subscriptions.push(new vscode.Disposable(() => {
    activationState = undefined;
    commandSurface = undefined;
    wired = false;
    void vscode.commands.executeCommand('setContext', 'baiton.activated', false);
  }));

  return [];
}

export function deactivate(): void {
  activationState = undefined;
  commandSurface = undefined;
  wired = false;
}

// --- vscode-backed seams over the pure activation cores -------------------

/**
 * Read the real workspace folders and, for each, whether it contains a
 * `.baiton/` directory (the multi-root disambiguator, Req 22.4). The presence
 * check is a synchronous filesystem probe on the host, which is where the
 * `extensionKind: "workspace"` extension runs (Req 22.6).
 */
function readWorkspaceFolders(): WorkspaceFolder<vscode.Uri>[] {
  const folders = vscode.workspace.workspaceFolders ?? [];
  return folders.map((folder) => ({
    uri: folder.uri,
    hasBaitonDir: hasBaitonDir(folder.uri),
  }));
}

/** Whether `<folder>/.baiton` exists and is a directory. */
function hasBaitonDir(folder: vscode.Uri): boolean {
  try {
    return fs.statSync(baitonDirOf(folder).fsPath).isDirectory();
  } catch {
    return false;
  }
}

/** Derive `<root>/.baiton` for the workspace context (design "WorkspaceContext"). */
function baitonDirOf(root: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(root, '.baiton');
}

/**
 * The PATH lookup seam for {@link resolveExecutable}. A value containing a path
 * separator is treated as an explicit path and checked for existence +
 * executability; a bare name is searched across each `PATH` entry (honouring
 * `PATHEXT` on Windows). Returns the resolved absolute path or `undefined`.
 */
const pathLookup: ExecutableLookup = (nameOrPath: string): string | undefined => {
  if (nameOrPath.includes(path.sep) || (path.posix.sep !== path.sep && nameOrPath.includes(path.posix.sep))) {
    return isExecutableFile(nameOrPath) ? path.resolve(nameOrPath) : undefined;
  }

  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter((d) => d.length > 0);
  const exts = executableExtensions();
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, nameOrPath + ext);
      if (isExecutableFile(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
};

/** On Windows, the executable extensions from `PATHEXT`; elsewhere just `''`. */
function executableExtensions(): string[] {
  if (process.platform !== 'win32') {
    return [''];
  }
  const pathext = process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD';
  return ['', ...pathext.split(';').map((e) => e.trim()).filter((e) => e.length > 0)];
}

/** Whether `candidate` names an existing regular file the process can execute. */
function isExecutableFile(candidate: string): boolean {
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) {
      return false;
    }
    if (process.platform === 'win32') {
      // Windows has no execute bit; existence as a file (with a PATHEXT match)
      // is sufficient.
      return true;
    }
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The settings-override seam for {@link resolveExecutable} (Req 22.7). Reads
 * `baiton.agents.<agent>.path` from the workspace configuration; an unset or
 * blank value is reported as no override.
 */
const settingsOverride: OverrideGetter = (agent: string): string | undefined => {
  const cfg = vscode.workspace.getConfiguration(SETTINGS_NS);
  const value = cfg.get<string>(`agents.${agent}.path`);
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
};

// --- crash recovery wiring (task 11.2 seam) -------------------------------

/**
 * Run crash recovery over every spec's `runs.jsonl` on activation (Req 21.3–
 * 21.7). Each spec folder under `.baiton/specs/` owns its own journal, so we
 * reconcile them one spec at a time, wiring the git seam, a `process`-backed
 * {@link ProcessControl}, and a serializer-backed spec-write seam. A failure
 * for one spec is contained so the rest still reconcile.
 */
async function runCrashRecovery(
  workspace: WorkspaceContext<vscode.Uri>,
  surface: Surface,
): Promise<void> {
  const repoRoot = workspace.root.fsPath;
  const specsDir = path.join(workspace.baitonDir.fsPath, 'specs');
  const git = createGitService(repoRoot);

  let slugs: string[];
  try {
    const entries = await fsp.readdir(specsDir, { withFileTypes: true });
    slugs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    // No specs directory yet (freshly initialized or uninitialized): nothing to
    // reconcile.
    return;
  }

  for (const slug of slugs) {
    const journalPath = path.join(specsDir, slug, 'runs.jsonl');
    if (!fs.existsSync(journalPath)) {
      continue;
    }
    try {
      await recoverJournal({
        slug,
        journalPath,
        git,
        process: hostProcessControl,
        specStore: { writeState: makeRecoveryWriteState(repoRoot, slug, git) },
      });
    } catch (e) {
      surface.warn(
        `Baiton crash recovery for spec "${slug}" did not complete: ${describe(e)}.`,
      );
    }
  }
}

/**
 * The host process-control seam recovery uses to terminate a still-live
 * recorded sub-agent pid (Req 21.4). Liveness probes with signal `0`; any
 * failure (no such process, or not permitted) is reported as not alive, and the
 * kill is best-effort.
 */
const hostProcessControl: ProcessControl = {
  isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      // EPERM means the process exists but we may not signal it — still alive.
      return isObjectWithCode(e) && e.code === 'EPERM';
    }
  },
  kill(pid: number): void {
    try {
      process.kill(pid);
    } catch {
      // Best-effort: an already-dead pid or a failed signal is swallowed so
      // reconciliation continues.
    }
  },
};

/**
 * Build the serializer-backed `writeState` seam recovery replays a lost state
 * write through (Req 21.5, 21.7). Re-reads the spec's `spec.md`, applies the
 * minimal state-box edit via the pure {@link writeTodoState} serializer, writes
 * the result back, and commits the change on the spec branch (Req 17.1).
 * Resolves `false` when the serializer aborts (the target could not be located)
 * so recovery records a `no-op` rather than claiming a state change (Req 6.5).
 *
 * The recovery `note` is not persisted here: the serializer writes only the
 * state box (Req 6.1), and recovery notes are advisory.
 */
function makeRecoveryWriteState(
  repoRoot: string,
  slug: string,
  git: GitService,
): (slug: string, todoId: string, state: TodoState, note?: string) => Promise<boolean> {
  const specPath = path.join(repoRoot, '.baiton', 'specs', slug, 'spec.md');
  return async (_slug: string, todoId: string, state: TodoState): Promise<boolean> => {
    let current: string;
    try {
      current = await fsp.readFile(specPath, 'utf8');
    } catch {
      return false;
    }
    const written = writeTodoState(current, todoId, state);
    if (isErr(written)) {
      return false;
    }
    if (written.value === current) {
      return false;
    }
    try {
      await fsp.writeFile(specPath, written.value, 'utf8');
      await git.commit(`spec(${slug}): ${todoId} recover ${state}`);
      return true;
    } catch {
      return false;
    }
  };
}

/** Whether a value is an object carrying a string `code` (a Node system error). */
function isObjectWithCode(value: unknown): value is { code: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    typeof (value as { code: unknown }).code === 'string'
  );
}

/** A short, safe description of a thrown value for a user-facing message. */
function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
