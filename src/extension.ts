import * as vscode from 'vscode';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import {
  MINIMUM_VSCODE_VERSION,
  engineVersionAtLeast,
  unsupportedEngineMessage,
  resolveWorkspace,
  canonicalizeRoot,
  resolveAgentExecutables,
  resolveExecutable,
  discoverRepos,
  reposWithBaiton,
  type WorkspaceContext,
  type RepoSet,
  type DiscoveryFs,
  type DiscoveryFolder,
  type WorkspaceRepos,
  type ExecutableLookup,
  type OverrideGetter,
  type AgentExecutables,
} from './activation';
import { isErr } from './model/result';
import { loadConfig, refreshGitignore } from './config';
import type { Config } from './config';
import { createGitServiceRegistry } from './git';
import type { GitServiceRegistry } from './git';
import type { GitService } from './git';
import { recoverJournal } from './engine';
import { planJournalPaths } from './journal';
import type { ProcessControl } from './engine';
import { writePhaseState } from './model/writer';
import type { PhaseState } from './model/phaseState';
import { Surface } from './activation/surface';
import {
  COMMANDS,
  registerCommands,
  registerInitializeCommand,
  registerConfigPanelCommand,
  resolveBaitonDirForCommands,
  type CommandSurface,
  type FolderScopedApplyConfig,
} from './activation/commands';
import { registerConfigPanel } from './activation/configPanel';
import { AGENT_BINARY, agentCapabilities, createAdapterRegistry } from './adapter';
import { registerUsageView } from './activation/usageView';
import { USAGE_CLI_AGENT } from './activation/usageViewSeams';
import type { UsageCliName } from './usage';
import { CatalogStore } from './orchestrator/modelCatalog';
import { ModelDiscoveryService, builtinCatalogFetches } from './activation/modelDiscovery';
import {
  createConfigRefresh,
  FOLDER_MISMATCH_NOTE,
  NOT_ACTIVATED_NOTE,
} from './activation/configRefresh';
import { ROLES } from './model/role';
import { listDocumentSlugs, resolveDocument } from './storage/documentLocation';

/**
 * Extension entry point — the thin `vscode`-backed shell over the pure
 * activation cores (task 15.1; design "Activation and workspace resolution").
 *
 * Activation order (design "Activation / host"):
 *   1. Engine-version guard — refuse below {@link MINIMUM_VSCODE_VERSION} with a
 *      message (Req 23.3).
 *   2. Repo discovery — walk every folder; primary = single folder, or first
 *      `.baiton/` repo in a multi-root workspace (Req 22.3–22.5).
 *   3. Trust / restricted read — `vscode.workspace.isTrusted` becomes the
 *      context's `restricted` flag; under Restricted Mode all writes and
 *      dispatch are disabled (Req 22.1, 22.2).
 *   4. Config load — validate `.baiton/config.json` (task 5.1's `loadConfig`),
 *      then resolve one executable per distinct agent id named in
 *      `config.roles` (Req 22.7, 22.8, 14.5).
 *   5. Crash recovery — reconcile every result-less journal entry per plan
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
  /** Discovered repos for later multi-repo activation and command phases. */
  readonly repos: RepoSet;
  /** Successfully loaded configs keyed by stable repo name. */
  readonly repoConfigs: ReadonlyMap<string, Config>;
  /** A memoized git service bound to each repo root. */
  readonly git: GitServiceRegistry;
}

/** The single resolved activation state, exposed for the command layer (task 15.2). */
let activationState: ActivationState | undefined;
/** The active command surface, retained to probe in-flight runs for config refresh notes. */
let commandSurface: CommandSurface | undefined;
/** Guard ensuring the gated half of activation runs at most once to prevent duplicate command registrations. */
let wired = false;
/** The window's model catalog store, built before the activation gate. */
let modelCatalogStore: CatalogStore | undefined;
/** The window's model discovery service, built before the activation gate. */
let modelDiscovery: ModelDiscoveryService | undefined;

/** Read the activation state resolved by {@link activate}, if any. */
export function getActivationState(): ActivationState | undefined {
  return activationState;
}

/**
 * The window's model catalog store, the single source of truth for refreshed
 * model lists. The config panel reads it through the `getCapabilities` seam
 * wired in {@link activate}; the provider router reads it later.
 */
export function getModelCatalogStore(): CatalogStore | undefined {
  return modelCatalogStore;
}

/** The window's model discovery service, if activation got far enough to build it. */
export function getModelDiscovery(): ModelDiscoveryService | undefined {
  return modelDiscovery;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  activationState = undefined;
  commandSurface = undefined;
  wired = false;
  modelCatalogStore = undefined;
  modelDiscovery = undefined;

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
  context.subscriptions.push(surface.apiOutputChannel);

  // Register `Baiton: Initialize` before the activation gate so it still works
  // in an as-yet-uninitialized folder (where config load fails by design)
  // (Req 1.1). It resolves its own workspace independently of the gate below.
  context.subscriptions.push(registerInitializeCommand(surface));

  // The host-free hot-reload seam for the config panel.
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
  const adapterRegistry = createAdapterRegistry();

  // The model catalog and its discovery service, also ahead of the gate: model
  // lists must refresh (and `Baiton: Refresh Model Lists` must work) even in an
  // as-yet-uninitialized folder, where workspace resolution or config load
  // fails by design. The store rehydrates the persisted snapshots and seeds the
  // curated builtins in its constructor; the discovery service only ever calls
  // `applyResult`.
  //
  // Ordering matters: the store is built and seeded (rehydrated `cached`
  // snapshots, else the curated `builtinCatalogFetches()`) BEFORE
  // `registerConfigPanel`, so the panel's first `load()` already shows the last
  // known-good lists, and every later `applyResult` reaches an open panel as
  // `optionsChanged` without touching in-progress edits.
  const catalogStore = new CatalogStore({
    memento: context.globalState,
    builtins: builtinCatalogFetches(),
    log: (m) => surface.log(m),
  });
  const discovery = new ModelDiscoveryService({
    store: catalogStore,
    registry: adapterRegistry,
    // A closure, not a hoisted value: the workspace is resolved later, in
    // `completeActivation()`, so every refresh re-reads the current root.
    cwd: () => getActivationState()?.workspace.root.fsPath,
    log: (m) => surface.log(m),
    apiLog: surface.apiLog,
  });
  modelCatalogStore = catalogStore;
  modelDiscovery = discovery;

  context.subscriptions.push(
    registerConfigPanel({
      extensionUri: context.extensionUri,
      resolveBaitonDir: resolveBaitonDirForCommands,
      agentIds: adapterRegistry.ids,
      capabilities: agentCapabilities(),
      // The live table: read per load/refresh, never frozen, so every
      // `applyResult` the discovery service lands reaches an open panel.
      getCapabilities: () => agentCapabilities(catalogStore.table()),
      onDidChangeCapabilities: (listener) => {
        const sub = discovery.onDidChange(() => listener());
        return new vscode.Disposable(() => sub.dispose());
      },
      log: (m) => surface.log(m),
      applyConfig: scopedApplyConfig,
    }),
  );
  context.subscriptions.push(registerConfigPanelCommand());
  // The Usage view is registered ahead of the activation gate so it works in an
  // uninitialised folder and in Restricted Mode; nothing is read until it is expanded.
  context.subscriptions.push(
    registerUsageView({
      extensionUri: context.extensionUri,
      log: (m) => surface.log(m),
      resolveExecutable: resolveUsageCli,
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMANDS.refreshModels, () =>
      discovery.refresh().then(() => undefined),
    ),
  );
  context.subscriptions.push(
    new vscode.Disposable(() => {
      discovery.dispose();
      modelDiscovery = undefined;
      modelCatalogStore = undefined;
    }),
  );
  context.subscriptions.push(
    discovery.onDidChange((table) => {
      surface.log(`Baiton: model catalog updated (${Object.keys(table).join(', ')}).`);
    }),
  );

  // Activation never awaits discovery: every failure degrades to a
  // stale-marked previous list or to the curated builtin one, and no discovery
  // failure may surface an error message or change what `activate()` returns.
  void discovery.refresh();

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

  // 2. Repo discovery (Req 22.3–22.5). The folder roots are canonicalized at
  //    ingress, and the pure walker skips Git internals and Baiton's state.
  const repos = await discoverWorkspaceRepos();
  if (repos.truncated) {
    surface.log('Baiton repo discovery hit its depth or entry bound; some nested repos may not have been found.');
  }
  // 3. Trust / restricted read (Req 22.1, 22.2). Restricted Mode = untrusted.
  const trusted = vscode.workspace.isTrusted;

  const resolved = resolveWorkspace<vscode.Uri>(repos, trusted, (fsPath) => vscode.Uri.file(fsPath));
  if (isErr(resolved)) {
    void vscode.window.showErrorMessage(resolved.error.message);
    return [NOT_ACTIVATED_NOTE(resolved.error.message)];
  }
  const workspaceRepos: WorkspaceRepos<vscode.Uri> = resolved.value;
  const workspace = workspaceRepos.primary;

  // 4. Config load (task 5.1). A refusal surfaces the offending detail; without
  //    a valid config the extension does not proceed to recovery/dispatch.
  const configResult = await loadConfig(workspace.baitonDir.fsPath);
  if (isErr(configResult)) {
    void vscode.window.showErrorMessage(configResult.error.message);
    return [`Configuration saved, but could not be activated: ${configResult.error.message}`];
  }
  const config = configResult.value;
  const repoConfigs = new Map<string, Config>([[workspace.repo.name, config]]);

  // Child repo configurations are useful to later phases, but a broken child
  // must not prevent the primary workspace from activating.
  for (const repo of reposWithBaiton(repos)) {
    if (repo.name === workspace.repo.name) {
      continue;
    }
    const childConfigResult = await loadConfig(repo.baitonDir!);
    if (isErr(childConfigResult)) {
      surface.warn(
        `Baiton could not load ${repo.name}/.baiton/config.json: ${childConfigResult.error.message}`,
      );
      continue;
    }
    repoConfigs.set(repo.name, childConfigResult.value);
  }

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

  // 5. Crash recovery (task 11.2, Req 21.3–21.7). Reconcile each plan's
  //    result-less journal entries. Skipped under Restricted Mode, which
  //    forbids the state writes recovery replays (Req 22.1).
  const git = createGitServiceRegistry();
  if (!workspace.restricted) {
    await runCrashRecovery(repos, git, surface);
  }

  // Keep `.baiton/.gitignore` current with the canonical exclusion list so a
  // workspace initialized by an older build does not start tracking newer
  // Baiton-owned artifacts (e.g. per-session chat transcripts). Skipped under
  // Restricted Mode, which forbids workspace writes (Req 22.1).
  if (!workspace.restricted) {
    for (const repo of reposWithBaiton(repos)) {
      try {
        await refreshGitignore(repo.baitonDir!);
      } catch (e) {
        surface.warn(
          `Baiton could not refresh ${repo.name}/.baiton/.gitignore: ${describe(e)}.`,
        );
      }
    }
  }

  const state: ActivationState = { workspace, config, executables, repos, repoConfigs, git };
  activationState = state;

  // Wire the command surface: per-stage triggers, approve/re-approve, the chat
  // orchestrator entry, and the plan CodeLens, all against the run queue and
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
  modelCatalogStore = undefined;
  modelDiscovery = undefined;
}

// --- vscode-backed seams over the pure activation cores -------------------

/** Discover repos under all opened folders using the injected filesystem seam. */
async function discoverWorkspaceRepos(): Promise<RepoSet> {
  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  const folders: DiscoveryFolder[] = workspaceFolders.map((folder) => ({
    name: folder.name,
    root: folder.uri.scheme === 'file'
      ? canonicalizeRoot(folder.uri.fsPath)
      : folder.uri.fsPath,
  }));
  const nonFileRoots = new Set(
    workspaceFolders
      .filter((folder) => folder.uri.scheme !== 'file')
      .map((folder) => path.resolve(folder.uri.fsPath)),
  );
  const nodeDiscoveryFs: DiscoveryFs = {
    readdir: async (dir) => {
      if (nonFileRoots.has(path.resolve(dir))) {
        return [];
      }
      return (await fsp.readdir(dir, { withFileTypes: true })).map((entry) => ({
        name: entry.name,
        kind: entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : 'other',
      }));
    },
  };
  return discoverRepos(folders, nodeDiscoveryFs);
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

/** Resolves a usage CLI honouring `baiton.agents.<agent>.path` (agy is the antigravity agent). */
const resolveUsageCli = (cli: UsageCliName): string | undefined => {
  const agent = USAGE_CLI_AGENT[cli];
  const r = resolveExecutable(agent, AGENT_BINARY[agent], pathLookup, settingsOverride);
  return isErr(r) ? undefined : r.value.path;
};

// --- crash recovery wiring (task 11.2 seam) -------------------------------

/**
 * Run crash recovery for every plan found by listDocumentSlugs under
 * `.baiton/plans/` or the legacy `.baiton/specs/` root. Each plan owns a
 * plan-level journal plus per-phase journals, merged by readPlanJournal. The
 * recovery uses the git seam, a `process`-backed {@link ProcessControl}, and a
 * serializer-backed plan writer. A failure for one plan is contained so the
 * rest still reconcile.
 */
async function runCrashRecovery(
  repos: RepoSet,
  gitRegistry: GitServiceRegistry,
  surface: Surface,
): Promise<void> {
  for (const repo of reposWithBaiton(repos)) {
    try {
      const repoRoot = repo.root;
      const baitonDir = repo.baitonDir!;
      const git = gitRegistry.forRepo(repoRoot);
      const slugs = listDocumentSlugs(baitonDir);

      for (const slug of slugs) {
        if (!planJournalPaths(baitonDir, slug).some((p) => fs.existsSync(p))) {
          continue;
        }
        try {
          await recoverJournal({
            slug,
            baitonDir,
            git,
            process: hostProcessControl,
            planStore: { writeState: makeRecoveryWriteState(baitonDir, slug, git) },
          });
        } catch (e) {
          surface.warn(
            `Baiton crash recovery for ${repo.name} plan "${slug}" did not complete: ${describe(e)}.`,
          );
        }
      }
    } catch (e) {
      surface.warn(`Baiton crash recovery for ${repo.name} did not complete: ${describe(e)}.`);
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
 * write through (Req 21.5, 21.7). Re-reads the plan document, applies the
 * minimal state-box edit via the pure {@link writePhaseState} serializer, writes
 * the result back, and commits the change on the plan branch (Req 17.1).
 * Resolves `false` when the serializer aborts (the target could not be located)
 * so recovery records a `no-op` rather than claiming a state change (Req 6.5).
 *
 * The recovery `note` is not persisted here: the serializer writes only the
 * state box (Req 6.1), and recovery notes are advisory.
 */
function makeRecoveryWriteState(
  baitonDir: string,
  slug: string,
  git: GitService,
): (slug: string, phaseId: string, state: PhaseState, note?: string) => Promise<boolean> {
  return async (_slug: string, phaseId: string, state: PhaseState): Promise<boolean> => {
    const documentPath = resolveDocument(baitonDir, slug).documentPath;
    let current: string;
    try {
      current = await fsp.readFile(documentPath, 'utf8');
    } catch {
      return false;
    }
    const written = writePhaseState(current, phaseId, state);
    if (isErr(written)) {
      return false;
    }
    if (written.value === current) {
      return false;
    }
    try {
      await fsp.writeFile(documentPath, written.value, 'utf8');
      await git.commit(`plan(${slug}): ${phaseId} recover ${state}`);
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
