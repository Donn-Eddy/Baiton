/**
 * Command, CodeLens, and chat-orchestrator wiring for the VS Code surface
 * (task 15.2; design "Activation and VS Code surface").
 *
 * This is the thin `vscode` glue that connects the pure cores and seams to the
 * editor. It registers:
 *
 *   - `baiton.initialize` — scaffold `.baiton/` over the resolved workspace,
 *     surfacing success or a rollback failure (Req 1.1). It resolves the
 *     workspace independently of the full activation gate so it still runs in an
 *     as-yet-uninitialized folder (where config load fails by design).
 *   - The per-stage triggers `baiton.plan` / `baiton.execute` / `baiton.review`
 *     / `baiton.replan` / `baiton.stop`, dispatched through the run queue via
 *     {@link dispatchTrigger} (Req 10.3, 19.1). Each write/dispatch is gated
 *     under Restricted Mode and that stage's role executable (Req 14.5, 22.1,
 *     22.2).
 *   - `baiton.approve` — the approve/re-approve action through the orchestrator
 *     `approve_spec` control tool (Req 5.3, 10.3).
 *   - `baiton.submitPr` / `baiton.showPr` — open a pull request for a spec, and
 *     re-open the URL a completed submit already recorded in its frontmatter.
 *   - `baiton.viewPlan` — open a todo's persisted plan (`todos/<id>/plan.md`)
 *     so the user can read it, and edit it before Execute.
 *   - `baiton.openChat` / `baiton.chat` — reveal and focus the Chat_View, whose
 *     {@link ChatController} runs the real host-side tool loop against the model
 *     client and the guarded registry (Req 1.3, 9.1, 13). `baiton.chat` is kept
 *     as an alias of the new Open Chat command.
 *   - `baiton.setOrchestratorApiKey` — store the orchestrator API key in
 *     SecretStorage (Req 17).
 *   - The Spec_Explorer tree view (with its filesystem watcher) whose inline
 *     actions forward to the same `baiton.plan/execute/review/replan/stop/
 *     approve` commands with `[slug, todoId]` / `[slug]` (Req 2, 5, 6, 18.4).
 *   - A {@link vscode.CodeLensProvider} over a spec's `# TODOS` lines exposing
 *     the stage triggers inline per todo.
 *
 * Probe-failure, invalid-result, git, and recovery errors are surfaced through
 * the shared {@link Surface}: chat/tool errors as tool results, command
 * failures as notifications, and everything to the output channel (Req 5.3,
 * 10.3, 14.5, 19.1; design "Error Handling").
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { isErr } from '../model/result';
import { parseSpec } from '../model/parser';
import { legalActions, type TodoAction } from '../model/todoActions';
import type { Role } from '../model/role';
import type { Stage } from '../model/stage';
import { initialize } from '../config';
import type { Config } from '../config';
import { createGitService } from '../git';
import {
  createPrTool,
  createRunQueue,
  createSpecDraftRunner,
  DEFAULT_PR_TOOL,
  isPrToolSelection,
  resolveProviderExecutable,
  selectProvider,
  submitPr,
} from '../engine';
import type {
  DispatchResult,
  RunQueue,
  SpecDraftOutcome,
  SubmitPrError,
  TerminalHost,
} from '../engine';
import { latestStart, parseJournal } from '../journal';
import {
  GuardContext,
  OpenAiModelClient,
  assembleToolSpecs,
  createToolRegistry,
  systemClock,
} from '../orchestrator';
import type {
  ConfirmSeam,
  OrchestratorPhase,
  SubmitPrOutcome,
  ToolRegistry,
  ToolServices,
  ToolSpec,
} from '../orchestrator';
import { createAdapterRegistry } from '../adapter';
import type { Adapter, AdapterRegistry } from '../adapter';
import type { WorkspaceContext } from './workspace';
import type { AgentExecutables } from './executable';
import { Surface } from './surface';
import { createSpecStore } from './specStore';
import { createVscodeTerminalHost } from './vscodeTerminalHost';
import { createVscodeResultWatcherFactory } from './vscodeResultWatcher';
import {
  createRunQueueSeam,
  dispatchTrigger,
  STAGE_ROLE,
  type EngineTrigger,
} from './engineFacade';
import { ChatController } from './chatController';
import type { OrchestratorConfig } from './chatController';
import { CHAT_VIEW_ID, ChatWebviewProvider } from './chatWebview';
import { SpecExplorer, treeNodeTarget, type TreeNode } from './specExplorer';
import { openChat } from './openChat';
import { planPath } from './specLister';
import { setOrchestratorApiKey } from './setApiKey';
import { revealConfigPanel } from './openConfigPanelView';

/** The extension settings namespace (matches `src/extension.ts`). */
const SETTINGS_NS = 'baiton';

/** The Spec_Explorer tree view id contributed in `package.json` (task 14.1). */
const SPEC_EXPLORER_VIEW_ID = 'baiton.specExplorer';

/** The command ids contributed in `package.json`. */
export const COMMANDS = {
  initialize: 'baiton.initialize',
  plan: 'baiton.plan',
  execute: 'baiton.execute',
  review: 'baiton.review',
  replan: 'baiton.replan',
  stop: 'baiton.stop',
  view: 'baiton.view',
  approve: 'baiton.approve',
  submitPr: 'baiton.submitPr',
  showPr: 'baiton.showPr',
  viewPlan: 'baiton.viewPlan',
  chat: 'baiton.chat',
  openChat: 'baiton.openChat',
  setApiKey: 'baiton.setOrchestratorApiKey',
  openConfigPanel: 'baiton.openConfigPanel',
} as const;

/** The minimal activation state the command layer consumes. */
export interface CommandActivation {
  workspace: WorkspaceContext<vscode.Uri>;
  /**
   * The live configuration. Replaced wholesale on config save; all reads must
   * go through this object rather than a captured/destructured copy.
   */
  config: Config;
  /**
   * The live agent executables resolution table. Replaced wholesale when
   * role agents change on config save; all reads must go through this object.
   */
  executables: AgentExecutables;
}

/**
 * The wired command surface, held so `deactivate` can dispose the queue's
 * terminals and the output channel via the returned disposables.
 */
export interface CommandSurface {
  /** All registrations, pushed onto `context.subscriptions`. */
  disposables: vscode.Disposable[];
  /** Slugs with a stage currently in flight, for the in-flight note. */
  runningSlugs(): readonly string[];
}

/**
 * Register every command, the CodeLens provider, and the chat entry against the
 * resolved activation state. Returns the disposables for the caller to own.
 *
 * The `baiton.initialize` command is registered unconditionally so it works
 * before `.baiton/` exists; the stage triggers, approve, and chat are wired
 * against the run queue and tool registry built from `activation`.
 */
export function registerCommands(
  context: vscode.ExtensionContext,
  activation: CommandActivation,
  surface: Surface,
): CommandSurface {
  const disposables: vscode.Disposable[] = [];
  const { workspace } = activation;
  /**
   * Accessor for the live configuration. The config object is replaced wholesale
   * on save and must be re-read per call, never hoisted.
   */
  const cfg = (): Config => activation.config;
  const repoRoot = workspace.root.fsPath;
  const baitonDir = workspace.baitonDir.fsPath;
  const specsDir = vscode.Uri.joinPath(workspace.baitonDir, 'specs').fsPath;

  // --- shared seams -------------------------------------------------------
  const git = createGitService(repoRoot);
  const specStore = createSpecStore(specsDir, git);
  // Roles may mix agents, so each dispatch site selects its adapter from the
  // role's configured `agent` id instead of sharing one instance (Req 14.1).
  const adapters = createAdapterRegistry();
  const terminalHost = createVscodeTerminalHost();
  const watcherFactory = createVscodeResultWatcherFactory();

  // The run journal is per spec (`.baiton/specs/<slug>/runs.jsonl`, Req 21), so
  // one serialized queue is built per slug — each bound to its own journal —
  // and cached. Manual mode runs one stage per trigger and the queue itself
  // refuses a second while one is running (Req 19.1, 20.1). Every refusal/halt
  // is surfaced through the shared Surface (Req 5.3, 10.3, 14.5, 19.1).
  const queues = new Map<string, RunQueue>();
  const queueForSlug = (slug: string): RunQueue => {
    const existing = queues.get(slug);
    if (existing !== undefined) {
      return existing;
    }
    const journalPath = vscode.Uri.joinPath(
      workspace.baitonDir,
      'specs',
      slug,
      'runs.jsonl',
    ).fsPath;
    const queue = createRunQueue({
      workspaceRoot: repoRoot,
      git,
      terminalHost,
      watcherFactory,
      specStore,
      journalPath,
      modelForRole: (role) => modelForRole(cfg(), role),
      adapterForRole: (role) => adapterForRole(cfg(), adapters, role),
      report: (error) => surface.reportDispatchError(error),
      // A spec draft holds the same one-stage-per-repository lock (Req 20.1).
      isExternallyBusy: () => specDraftRunner.isRunning(),
    });
    queues.set(slug, queue);
    return queue;
  };

  // Submit PR (design section 8): the per-spec flow over the same seams as the
  // queue. One in-flight submission per spec; it also refuses while that
  // spec's queue is running a stage (one run at a time per repository).
  const prInFlight = new Set<string>();
  const submitPrForSlug = async (slug: string): Promise<SubmitPrOutcome> => {
    if (prInFlight.has(slug) || queueForSlug(slug).isRunning()) {
      return { ok: false, error: `spec "${slug}" already has a run in progress` };
    }
    const selection = cfg().pr?.tool ?? DEFAULT_PR_TOOL;
    if (!isPrToolSelection(selection)) {
      return { ok: false, error: `unsupported pr.tool "${selection}" in config.json; use "auto", "gh" or "glab"` };
    }
    const remote = readGitSettings().remote;
    let remoteUrl = '';
    try {
      remoteUrl = await git.remoteUrl(remote);
    } catch {
      return { ok: false, error: `git remote "${remote}" is not configured; add it before submitting a PR` };
    }
    const kind = selectProvider(selection, remoteUrl);
    const executable = resolveProviderExecutable(kind, { override: readPrToolPath() });
    if (executable === undefined) {
      return {
        ok: false,
        error:
          `the "${kind}" CLI was not found on PATH or in the usual install directories; ` +
          `install it or set "baiton.pr.toolPath" to its location`,
      };
    }
    prInFlight.add(slug);
    try {
      const result = await submitPr(slug, {
        workspaceRoot: repoRoot,
        specsDir,
        terminalHost,
        watcherFactory,
        git,
        pr: createPrTool({ kind, executable, repoRoot }),
        remote,
        verify: cfg().git.verify,
        modelForRole: (role) => modelForRole(cfg(), role),
        adapterForRole: (role) => adapterForRole(cfg(), adapters, role),
        reportInvalid: (detail) => surface.warn(`Baiton: ${detail}`),
      });
      if (result.ok) {
        return { ok: true, url: result.pr.url, reused: result.reused, title: result.title };
      }
      return { ok: false, error: describeSubmitPrError(result.error) };
    } finally {
      prInFlight.delete(slug);
    }
  };

  // The spec-draft runner (design "the harness writes the spec"): the
  // orchestrator gathers requirements and calls `draft_spec`, which dispatches
  // here. It is spec-scoped, so it runs beside the todo-scoped queues rather
  // than through one, and the two exclude each other so only one stage runs per
  // repository. Its completion sink is bound after the ChatController exists.
  let reportDraftOutcome: (outcome: SpecDraftOutcome) => void = () => {};
  const draftServices = buildToolServices(
    repoRoot,
    baitonDir,
    git,
    queueForSlug,
    specsDir,
    submitPrForSlug,
  );
  const specDraftRunner = createSpecDraftRunner({
    workspaceRoot: repoRoot,
    specsDir,
    terminalHost,
    watcherFactory,
    services: draftServices,
    modelForRole: (role) => modelForRole(cfg(), role),
    adapterForRole: (role) => adapterForRole(cfg(), adapters, role),
    isQueueRunning: () => [...queues.values()].some((q) => q.isRunning()),
    onComplete: (outcome) => reportDraftOutcome(outcome),
    report: (detail) => surface.warn(`Baiton: ${detail}`),
  });

  // The tool registry (read + spec-write + control tools) over the same seams
  // (Req 10.1–10.7). Restricted Mode disables writes/dispatch inside the guard.
  const registry = createToolRegistry({
    ...buildToolServices(repoRoot, baitonDir, git, queueForSlug, specsDir, submitPrForSlug),
    draftSpec: {
      draft: async (req) => {
        const started = await specDraftRunner.start(req);
        if (started.ok) {
          return { kind: 'started', runId: started.runId };
        }
        return started.error.kind === 'busy'
          ? { kind: 'busy' }
          : { kind: 'refused', reason: started.error.message };
      },
    },
  });
  const modelClient = buildModelClient(context);

  // Assemble the tool definitions advertised to the model, validating every
  // registered tool's `description` (Req 10.3, 10.5). If assembly is rejected —
  // any description empty, too short, or equal to its name — no definitions are
  // sent to the model: the chat still opens but advertises an empty tool set,
  // and the reason is surfaced (Req 10.5).
  const assembled = assembleToolSpecs(registry.definitions());
  let tools: ToolSpec[];
  if (isErr(assembled)) {
    tools = [];
    surface.error(
      `Baiton chat: tool "${assembled.error.tool}" ${assembled.error.reason}; ` +
        'no tools were advertised to the orchestrator.',
    );
  } else {
    tools = assembled.value;
  }

  // The orchestrator has two jobs, and each advertises its own tool surface
  // (Req 11.1): gathering requirements for a new or draft spec, or driving an
  // approved one. Validation above ran once over the whole registry, so these
  // only select from the specs it already accepted; a rejected assembly leaves
  // both phases empty. The controller picks one per send, and the registry
  // refuses an out-of-phase call even if the model names it anyway.
  const specsByName = new Map(tools.map((spec) => [spec.name, spec]));
  const toolsByPhase = new Map<OrchestratorPhase, ToolSpec[]>([
    ['gather', specsForPhase(registry, specsByName, 'gather')],
    ['drive', specsForPhase(registry, specsByName, 'drive')],
  ]);

  // `baiton.initialize` is registered separately (and unconditionally) so it
  // works before `.baiton/` exists; see {@link registerInitializeCommand}.

  // --- per-stage triggers + control actions (Req 10.3, 19.1, 22.1, 22.2) --
  disposables.push(
    registerStageCommand(COMMANDS.plan, 'plan', activation, specsDir, queueForSlug, surface),
    registerStageCommand(COMMANDS.execute, 'execute', activation, specsDir, queueForSlug, surface),
    registerStageCommand(COMMANDS.review, 'review', activation, specsDir, queueForSlug, surface),
    registerActionCommand(COMMANDS.replan, 'replan', activation, specsDir, queueForSlug, surface),
    registerActionCommand(COMMANDS.stop, 'stop', activation, specsDir, queueForSlug, surface),
    registerViewCommand(
      activation,
      specsDir,
      repoRoot,
      queueForSlug,
      (role) => adapterForRole(cfg(), adapters, role),
      terminalHost,
      surface,
    ),
  );

  // --- approve / re-approve (Req 5.3, 10.3) -------------------------------
  // The tree's Approve inline action and the palette both invoke this command;
  // the tree passes the clicked node, the palette passes a slug string or
  // nothing, so normalize the first argument to a slug (Req 5.5, 18.4).
  disposables.push(
    vscode.commands.registerCommand(
      COMMANDS.approve,
      (arg?: TreeNode | string) => runApprove(registry, workspace, surface, slugArg(arg)),
    ),
  );

  // --- submit PR (design section 8 "PR") ----------------------------------
  disposables.push(
    vscode.commands.registerCommand(
      COMMANDS.submitPr,
      (arg?: TreeNode | string) =>
        runSubmitPr(activation, specsDir, surface, submitPrForSlug, slugArg(arg)),
    ),
  );

  // --- show PR (design section 8 "PR") ------------------------------------
  // Once a spec records a `pr:` URL its root swaps Submit PR for Show PR, which
  // only opens that URL in the browser; read-only, so it is not gated on
  // Restricted Mode.
  disposables.push(
    vscode.commands.registerCommand(
      COMMANDS.showPr,
      (arg?: TreeNode | string) => runShowPr(specsDir, surface, slugArg(arg)),
    ),
  );

  // --- view plan ----------------------------------------------------------
  // Opens the todo's persisted plan for reading or editing. Like Show PR it
  // only opens something already on disk, so it is not gated on Restricted
  // Mode or on a role executable.
  disposables.push(
    vscode.commands.registerCommand(
      COMMANDS.viewPlan,
      async (a?: TreeNode | string, b?: string) => {
        const { slug, todoId } = todoArgs(a, b);
        await runViewPlan(specsDir, surface, slug, todoId);
      },
    ),
  );

  // --- chat: tool loop, webview and controller (Req 1.3, 9.1, 13, 18.3) ---
  // The Chat_View webview provider owns the browser context; the ChatController
  // binds it to the tool loop, per-conversation transcripts, and the reused
  // registry/confirm seams. Both are wired against the assembled tool set.
  const chatWebview = new ChatWebviewProvider(context.extensionUri);
  const confirm = buildConfirmSeam();
  const chatController = new ChatController({
    webview: chatWebview,
    client: modelClient,
    registry,
    toolsFor: (phase) => toolsByPhase.get(phase) ?? [],
    guardContext: () => guardContextFor(workspace),
    confirm,
    baitonDir,
    specsDir,
    roundBound: () => readRoundBound(),
    config: readOrchestratorConfig(),
    triggerFix: (action) => triggerFix(action),
    log: (message) => surface.log(message),
    confirmDelete: async (message: string) =>
      (await vscode.window.showWarningMessage(message, { modal: true }, 'Delete')) === 'Delete',
    // The last active session per conversation scope is remembered in
    // workspaceState, so a window reload reopens the session the user was in.
    sessionMemory: {
      get: (scope: string) =>
        context.workspaceState.get<string>(`baiton.chat.session.${scope}`),
      set: async (scope: string, sessionId: string) => {
        await context.workspaceState.update(`baiton.chat.session.${scope}`, sessionId);
      },
    },
  });
  // Re-start the controller on every fresh webview resolve so a reopen or a
  // window reload reloads the current conversation into the new webview
  // (Req 8.8).
  // Bind the spec-draft completion sink now that the controller exists: a
  // finished draft records a system note on the Workspace_Conversation and
  // refreshes the view so the new spec appears in the selector.
  reportDraftOutcome = (outcome) => {
    const message = outcome.ok
      ? `Spec \`${outcome.slug}\` drafted with ${outcome.todoCount} todo${outcome.todoCount === 1 ? '' : 's'}.`
      : `Drafting spec \`${outcome.slug}\` failed: ${outcome.message}`;
    if (!outcome.ok) {
      surface.warn(`Baiton: ${message}`);
    }
    void chatController.noteSystem(message);
  };
  chatWebview.onResolve(() => chatController.start());
  disposables.push(
    vscode.window.registerWebviewViewProvider(
      CHAT_VIEW_ID,
      chatWebview,
      ChatWebviewProvider.registration,
    ),
    chatWebview,
  );

  // The legacy `baiton.chat` command now reveals the Chat_View rather than
  // running the old single-completion prompt; both it and the new
  // `baiton.openChat` command focus the webview through the stable focus
  // command (Req 1.3).
  disposables.push(
    vscode.commands.registerCommand(COMMANDS.chat, () => openChat()),
    vscode.commands.registerCommand(COMMANDS.openChat, () => openChat()),
    vscode.commands.registerCommand(COMMANDS.setApiKey, () =>
      setOrchestratorApiKey(context.secrets),
    ),
  );

  // --- spec explorer tree provider + active-spec tracking (Req 2, 6, 7) ---
  // The explorer's root click sets the Chat_View active spec through the
  // controller's sink; the controller also follows the active editor when it is
  // a `spec.md` (Req 7.4, 7.5).
  const explorer = new SpecExplorer(
    specsDir,
    specStore,
    surface,
    workspace.restricted,
    (slug) => chatController.setActiveSpec(slug),
  ).start();
  disposables.push(
    vscode.window.registerTreeDataProvider(SPEC_EXPLORER_VIEW_ID, explorer),
    explorer,
  );

  // Follow the active editor: when it is a spec's `spec.md`, make that spec the
  // active conversation; other editors leave the active spec unchanged (Req 7.5).
  disposables.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor === undefined) {
        return;
      }
      const slug = slugFromSpecUri(editor.document.uri);
      if (slug !== undefined) {
        chatController.setActiveSpec(slug);
      }
    }),
  );

  // --- CodeLens over spec todos ------------------------------------------
  disposables.push(
    vscode.languages.registerCodeLensProvider(
      { pattern: '**/.baiton/specs/*/spec.md' },
      new SpecCodeLensProvider(specsDir),
    ),
  );

  return {
    disposables,
    runningSlugs: () => {
      const running = [...queues.entries()]
        .filter(([, q]) => q.isRunning())
        .map(([slug]) => slug);
      if (specDraftRunner.isRunning()) {
        running.push('(spec draft)');
      }
      return running;
    },
  };
}

/**
 * Register the `baiton.initialize` command on its own, so activation can wire
 * it even when the full gate (workspace resolution → config load) fails — an
 * uninitialized folder has no `.baiton/config.json`, yet Initialize must still
 * create it (Req 1.1). Returns the disposable for the caller to own.
 */
export function registerInitializeCommand(surface: Surface): vscode.Disposable {
  return vscode.commands.registerCommand(COMMANDS.initialize, () =>
    runInitialize(surface),
  );
}

/**
 * Folder-scoped hot-reload seam for the config panel command (T08).
 * Closes over the panel's resolved baitonDir before calling the underlying ApplyConfig.
 */
export type FolderScopedApplyConfig = (
  baitonDir: string,
  config: Config,
) => Promise<readonly string[]> | readonly string[];

/**
 * Register the `baiton.openConfigPanel` command ahead of the activation gate.
 * Reveals and focuses the Configuration webview view in the Baiton container (T11).
 */
export function registerConfigPanelCommand(): vscode.Disposable {
  return vscode.commands.registerCommand(COMMANDS.openConfigPanel, () =>
    revealConfigPanel(),
  );
}

// --- Initialize -----------------------------------------------------------

/**
 * Run the Initialize command. It resolves the workspace root independently of
 * the full activation gate — a single folder, or the one multi-root folder — so
 * it works in a folder that has no `.baiton/` yet (Req 1.1, 22.3, 22.4). On zero
 * or more than one candidate it refuses with a message (Req 1.4). Success and
 * rollback failure are both surfaced (Req 1.5).
 */
async function runInitialize(surface: Surface): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const root = resolveCommandRoot(folders);
  if (root === undefined) {
    surface.error(
      'Baiton: Initialize requires exactly one workspace folder (or one multi-root folder with a .baiton/ directory).',
    );
    return;
  }

  const baitonDir = vscode.Uri.joinPath(root, '.baiton').fsPath;
  const result = await initialize(baitonDir);
  if (isErr(result)) {
    surface.error(`Baiton: Initialize failed: ${result.error.message}`);
    return;
  }
  const detail = result.value.createdConfig
    ? 'created .baiton/ with a default config.json'
    : 'ensured .baiton/ layout (existing config.json left unchanged)';
  surface.info(`Baiton: Initialize ${detail}.`);
}

/**
 * Resolve the `.baiton` directory for commands using the same rule as Initialize:
 * the single workspace folder, or the one multi-root folder with a `.baiton/` directory.
 * Returns `undefined` if there are 0 or ambiguous workspace folders.
 */
export function resolveBaitonDirForCommands(): string | undefined {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const root = resolveCommandRoot(folders);
  if (root === undefined) {
    return undefined;
  }
  return vscode.Uri.joinPath(root, '.baiton').fsPath;
}

/**
 * Resolve the folder to initialize or configure: the single folder when there
 * is exactly one, or the one multi-root folder that already contains a `.baiton/`
 * when several are open (Req 22.3, 22.4). Returns `undefined` on zero folders or
 * an ambiguous multi-root (Req 1.4, 22.5).
 */
export function resolveCommandRoot(
  folders: readonly vscode.WorkspaceFolder[],
): vscode.Uri | undefined {
  if (folders.length === 0) {
    return undefined;
  }
  if (folders.length === 1) {
    return folders[0].uri;
  }
  const withBaiton = folders.filter((f) =>
    directoryExists(vscode.Uri.joinPath(f.uri, '.baiton').fsPath),
  );
  return withBaiton.length === 1 ? withBaiton[0].uri : undefined;
}

/** Whether an absolute path exists and is a directory. */
function directoryExists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// --- stage / action triggers ----------------------------------------------

/** A per-slug run-queue accessor: builds (and caches) the queue for a spec. */
type QueueForSlug = (slug: string) => RunQueue;

/** Register a stage-trigger command (plan/execute/review). */
function registerStageCommand(
  commandId: string,
  stage: Stage,
  activation: CommandActivation,
  specsDir: string,
  queueForSlug: QueueForSlug,
  surface: Surface,
): vscode.Disposable {
  return vscode.commands.registerCommand(
    commandId,
    (a?: TreeNode | string, b?: string) => {
      const { slug, todoId } = todoArgs(a, b);
      return runStage(activation, specsDir, queueForSlug, surface, stage, slug, todoId);
    },
  );
}

/** Register a control-action command (replan/stop). */
function registerActionCommand(
  commandId: string,
  action: 'replan' | 'stop',
  activation: CommandActivation,
  specsDir: string,
  queueForSlug: QueueForSlug,
  surface: Surface,
): vscode.Disposable {
  return vscode.commands.registerCommand(
    commandId,
    async (a?: TreeNode | string, b?: string) => {
      // replan/stop launch no sub-agent (they dispatch through the facade with
      // a placeholder role), so they are gated on Restricted Mode alone —
      // gating `stop` on a binary being present would block cancelling a run
      // whose CLI has gone missing.
      if (!ensureNotRestricted(activation, surface)) {
        return;
      }
      const { slug: slugArg, todoId: todoArg } = todoArgs(a, b);
      const target = await resolveTarget(specsDir, slugArg, todoArg, surface);
      if (target === undefined) {
        return;
      }
      // Stop cancels the running stage and clears the queue rather than
      // enqueuing behind it — dispatching a `stop` action would wait for the
      // busy stage to finish, defeating the cancellation — but only when the
      // todo IS the Live_Run; otherwise there is nothing running to cancel and
      // the transition table's revert path applies instead (Req 2.1, 2.2, 2.3,
      // 20.4–20.6).
      if (action === 'stop') {
        const queue = queueForSlug(target.slug);
        if (queue.currentRun()?.todoId === target.todoId) {
          queue.stop();
          surface.log(`Baiton: stop ${target.slug}/${target.todoId}`);
          return;
        }
        const trigger: EngineTrigger = {
          kind: 'action',
          slug: target.slug,
          todoId: target.todoId,
          action: 'stop',
        };
        const result = await dispatchAndReport(queue, specsDir, trigger, surface);
        if (!result.ok && result.error.kind === 'illegal-transition') {
          // The queue's reporter already surfaced the generic transition-table
          // message; this friendlier wording is the one Req 2.3 asks for.
          surface.warn(`Baiton: nothing to stop for ${target.slug}/${target.todoId}`);
        }
        return;
      }
      const trigger: EngineTrigger = {
        kind: 'action',
        slug: target.slug,
        todoId: target.todoId,
        action,
      };
      await dispatchAndReport(queueForSlug(target.slug), specsDir, trigger, surface);
    },
  );
}

/**
 * Register the View command (Req 3.3, 3.4, 3.5). Unlike the stage/action
 * commands it is not gated by Restricted Mode — it writes nothing. The
 * executable check happens inside {@link runView} once the role a session's
 * recorded stage maps to is known, rather than here.
 */
function registerViewCommand(
  activation: CommandActivation,
  specsDir: string,
  repoRoot: string,
  queueForSlug: QueueForSlug,
  adapterForRole: (role: Role) => Adapter | undefined,
  terminalHost: TerminalHost,
  surface: Surface,
): vscode.Disposable {
  return vscode.commands.registerCommand(
    COMMANDS.view,
    async (a?: TreeNode | string, b?: string) => {
      const { slug: slugArg, todoId: todoArg } = todoArgs(a, b);
      const target = await resolveTarget(specsDir, slugArg, todoArg, surface);
      if (target === undefined) {
        return;
      }
      runView(activation, target.slug, target.todoId, specsDir, repoRoot, queueForSlug, adapterForRole, terminalHost, surface);
    },
  );
}

/**
 * View a todo's sub-agent session (Req 3.3, 3.4, 3.5, 3.6): reveal the
 * Live_Run's terminal when the todo is currently running; otherwise attach to
 * the Session_Id the journal's most recent start recorded for it, launching a
 * new terminal at the workspace root; otherwise warn that no session is
 * recorded. The role passed to `attach` comes from the stage recorded on that
 * journal entry via the shared {@link STAGE_ROLE} table (Req 3.6). The
 * executable check runs here, once that role is known, gating on the *same*
 * role `attach` uses — a mixed-agent config can view a session whose agent is
 * installed even while another role's agent is missing. The adapter used is
 * that role's *currently* configured agent, which may differ from the agent
 * that created the session if the config changed since (a known limitation of
 * mixed-agent configs).
 */
function runView(
  activation: CommandActivation,
  slug: string,
  todoId: string,
  specsDir: string,
  repoRoot: string,
  queueForSlug: QueueForSlug,
  adapterForRole: (role: Role) => Adapter | undefined,
  terminalHost: TerminalHost,
  surface: Surface,
): void {
  const live = queueForSlug(slug).currentRun();
  if (live?.todoId === todoId) {
    live.terminal.show();
    return;
  }

  const journalPath = path.join(specsDir, slug, 'runs.jsonl');
  const entry = latestStart(parseJournal(journalPath), todoId);
  if (entry?.sessionId === undefined) {
    surface.warn(`Baiton: no session recorded for ${slug}/${todoId}`);
    return;
  }

  const role = STAGE_ROLE[entry.stage];
  if (!ensureExecutable(activation, surface, role)) {
    return;
  }
  const adapter = adapterForRole(role);
  if (adapter === undefined) {
    surface.warn(`Baiton: role "${role}" is configured with an unsupported agent; update "roles.${role}.agent" in .baiton/config.json`);
    return;
  }

  const spec = adapter.attach({
    role,
    runId: entry.runId,
    sessionId: entry.sessionId,
  });
  const terminal = terminalHost.createTerminal({
    name: `Baiton view ${slug}/${todoId}`,
    shellPath: spec.shellPath,
    shellArgs: spec.shellArgs,
    cwd: repoRoot,
    ...(spec.env !== undefined ? { env: spec.env } : {}),
  });
  terminal.show();
}

/** Dispatch a stage trigger, gated under Restricted Mode and the stage's role executable. */
async function runStage(
  activation: CommandActivation,
  specsDir: string,
  queueForSlug: QueueForSlug,
  surface: Surface,
  stage: Stage,
  slugArg: string | undefined,
  todoArg: string | undefined,
): Promise<void> {
  if (!ensureCanDispatch(activation, surface, STAGE_ROLE[stage])) {
    return;
  }
  const target = await resolveTarget(specsDir, slugArg, todoArg, surface);
  if (target === undefined) {
    return;
  }
  const trigger: EngineTrigger = {
    kind: 'stage',
    slug: target.slug,
    todoId: target.todoId,
    stage,
  };
  await dispatchAndReport(queueForSlug(target.slug), specsDir, trigger, surface);
}

/**
 * Gate a write/dispatch under Restricted Mode alone (Req 22.1, 22.2), with no
 * executable check. Used by the control actions (replan/stop), which launch
 * no sub-agent, so gating them on a binary being present would be actively
 * wrong — you want to be able to cancel a run and clear the queue even when
 * the CLI has gone missing. Reused by {@link ensureCanDispatch} for its
 * Restricted Mode half, so there is one copy of the wording.
 */
function ensureNotRestricted(activation: CommandActivation, surface: Surface): boolean {
  if (activation.workspace.restricted) {
    surface.warn(
      'Baiton is read-only in Restricted Mode: trust this workspace to run stages.',
    );
    return false;
  }
  return true;
}

/**
 * Gate a stage/submit-PR dispatch under Restricted Mode (Req 22.1, 22.2) and
 * that `role`'s configured agent executable (Req 22.8, 14.5). Surfaces the
 * reason and returns whether to proceed.
 */
function ensureCanDispatch(activation: CommandActivation, surface: Surface, role: Role): boolean {
  return ensureNotRestricted(activation, surface) && ensureExecutable(activation, surface, role);
}

/**
 * Gate a command on `role`'s configured agent executable alone — false when
 * that agent's executable is missing with no override (Req 22.8, 14.5). The
 * message names both the role and the agent/binary at fault. Reused by
 * {@link ensureCanDispatch} and the View command, which is not gated by
 * Restricted Mode because it writes nothing (Req 3.3–3.5).
 */
function ensureExecutable(activation: CommandActivation, surface: Surface, role: Role): boolean {
  // Reads through live activation object so role-agent changes and re-resolved executables take effect immediately.
  const agent = activation.config.roles[role].agent;
  const failure = activation.executables.errorFor(agent);
  if (failure !== undefined) {
    surface.warn(`Baiton cannot dispatch the "${role}" stage: ${failure.message}`);
    return false;
  }
  return true;
}

/**
 * Dispatch a trigger and surface a successful acknowledgement; a refusal is
 * already reported through the queue's reporter. Returns the result so a
 * caller (the Stop command) can react to a specific refusal kind of its own.
 */
async function dispatchAndReport(
  queue: RunQueue,
  specsDir: string,
  trigger: EngineTrigger,
  surface: Surface,
): Promise<DispatchResult> {
  const result = await dispatchTrigger(queue, specsDir, trigger);
  if (result.ok) {
    surface.log(
      `Baiton: ${describeTrigger(trigger)} → ${result.outcome.kind}`,
    );
  }
  return result;
}

/** A short description of a trigger for the running log. */
function describeTrigger(trigger: EngineTrigger): string {
  const what = trigger.kind === 'stage' ? trigger.stage : trigger.action;
  return `${what} ${trigger.slug}/${trigger.todoId}`;
}

// --- approve ---------------------------------------------------------------

/**
 * Run the approve/re-approve action through the `approve_spec` control tool.
 * The guard disables it under Restricted Mode (Req 22.1); the tool confirms in
 * the UI and, on a fresh approval, creates the branch and records the approval
 * (Req 10.1, 16). A missing slug prompts the user.
 */
async function runApprove(
  registry: ToolRegistry,
  workspace: WorkspaceContext<vscode.Uri>,
  surface: Surface,
  slugArg: string | undefined,
): Promise<void> {
  const slug = slugArg ?? (await promptForSlug(workspace, 'Spec slug to approve'));
  if (slug === undefined) {
    return;
  }
  const ctx = guardContextFor(workspace);
  const callId = `approve-${slug}-${Date.now()}`;
  // `approve_spec` belongs to both orchestrator phases; a spec approved from
  // the UI is by definition still being gathered rather than driven (Req 11.1).
  const result = await registry.call('approve_spec', { slug }, callId, ctx, 'gather');
  if (result.ok) {
    surface.info(`Baiton: approved spec "${slug}".`);
  } else {
    surface.warn(`Baiton: ${result.error}`);
  }
}

/**
 * The validated {@link ToolSpec}s to advertise in one orchestrator phase
 * (Req 11.1): the already-validated specs of the tools the registry lists for
 * that phase, in registry order. Selecting from `validated` keeps description
 * validation a single pass over the whole registry (Req 10.3–10.5).
 */
function specsForPhase(
  registry: ToolRegistry,
  validated: Map<string, ToolSpec>,
  phase: OrchestratorPhase,
): ToolSpec[] {
  const specs: ToolSpec[] = [];
  for (const tool of registry.definitionsFor(phase)) {
    const spec = validated.get(tool.name);
    if (spec !== undefined) {
      specs.push(spec);
    }
  }
  return specs;
}

// --- submit PR -------------------------------------------------------------

/**
 * Run the Submit PR flow for a spec, gated like a stage dispatch (Restricted
 * Mode, executable). The tree passes its node, the palette a slug or nothing.
 * Success offers to open the PR; a halt is surfaced with its reason.
 */
async function runSubmitPr(
  activation: CommandActivation,
  specsDir: string,
  surface: Surface,
  submit: (slug: string) => Promise<SubmitPrOutcome>,
  slugArg: string | undefined,
): Promise<void> {
  if (!ensureCanDispatch(activation, surface, 'pr-writer')) {
    return;
  }
  const slug = slugArg ?? (await pickSpecSlug(specsDir));
  if (slug === undefined) {
    return;
  }
  const answer = await vscode.window.showWarningMessage(
    `Submit a pull request for spec "${slug}"? This pushes its branch and opens the PR.`,
    { modal: true },
    'Submit PR',
  );
  if (answer !== 'Submit PR') {
    return;
  }
  surface.log(`Baiton: submit PR ${slug}`);
  const outcome = await submit(slug);
  if (!outcome.ok) {
    surface.error(`Baiton: ${outcome.error}`);
    return;
  }
  const verb = outcome.reused ? 'reused' : 'opened';
  surface.log(`Baiton: ${verb} PR ${outcome.url} for "${slug}"`);
  const open = await vscode.window.showInformationMessage(
    `Baiton: ${verb} pull request for "${slug}": ${outcome.title}`,
    'Open PR',
  );
  if (open === 'Open PR') {
    void vscode.env.openExternal(vscode.Uri.parse(outcome.url));
  }
}

// --- show PR ---------------------------------------------------------------

/**
 * Open the pull request a spec already recorded, from the tree's Show PR inline
 * action or the palette. The URL is read from the spec's frontmatter `pr` key on
 * disk rather than from the clicked node, so the palette path works and the URL
 * is always the current on-disk value. A spec without a recorded PR is a
 * warning, not an error: the user has simply not submitted one yet.
 */
async function runShowPr(
  specsDir: string,
  surface: Surface,
  slugArg: string | undefined,
): Promise<void> {
  const slug = slugArg ?? (await pickSpecSlug(specsDir));
  if (slug === undefined) {
    return;
  }
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(specsDir, slug, 'spec.md'), 'utf8');
  } catch (e) {
    surface.error(
      `Baiton: could not read spec "${slug}": ${e instanceof Error ? e.message : String(e)}.`,
    );
    return;
  }
  const url = parseSpec(raw).frontmatter.get('pr')?.trim();
  if (url === undefined || url === '') {
    surface.warn(
      `Baiton: spec "${slug}" has no recorded pull request; submit one first.`,
    );
    return;
  }
  void vscode.env.openExternal(vscode.Uri.parse(url));
}

// --- view plan -------------------------------------------------------------

/**
 * Open a todo's persisted plan (`todos/<id>/plan.md`) in an editor, from the
 * tree's View plan inline action, the CodeLens, or the palette. The palette
 * path picks a spec and then one of its planned todos. A todo with no plan on
 * file is a warning, not an error: the user has simply not planned it yet.
 *
 * The plan is opened as an ordinary editable document on purpose — edits the
 * user makes before Execute are picked up by the executor's brief, and land in
 * the `executing` state commit (which stages the whole spec folder).
 */
async function runViewPlan(
  specsDir: string,
  surface: Surface,
  slugArg: string | undefined,
  todoArg: string | undefined,
): Promise<void> {
  const slug = slugArg ?? (await pickSpecSlug(specsDir));
  if (slug === undefined) {
    surface.warn('Baiton: no spec selected.');
    return;
  }
  const todoId = todoArg ?? (await pickPlannedTodoId(specsDir, slug, surface));
  if (todoId === undefined || todoId.trim().length === 0) {
    surface.warn('Baiton: no todo selected.');
    return;
  }
  const file = planPath(specsDir, slug, todoId);
  if (!fs.existsSync(file)) {
    surface.warn(
      `Baiton: no plan on file for "${todoId}" in spec "${slug}"; run Plan first.`,
    );
    return;
  }
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(doc);
  } catch (e) {
    surface.error(
      `Baiton: could not open the plan for "${todoId}": ${e instanceof Error ? e.message : String(e)}.`,
    );
  }
}

/**
 * Present the todos of a spec that have a plan on file, for the palette path of
 * View plan. A spec with no planned todo warns and selects nothing.
 */
async function pickPlannedTodoId(
  specsDir: string,
  slug: string,
  surface: Surface,
): Promise<string | undefined> {
  const ids = plannedTodoIds(specsDir, slug);
  if (ids.length === 0) {
    surface.warn(`Baiton: spec "${slug}" has no plan on file; run Plan first.`);
    return undefined;
  }
  return vscode.window.showQuickPick(ids, { placeHolder: 'Select a todo' });
}

/** The ids, in directory order, of a spec's todos that have a `plan.md`. */
function plannedTodoIds(specsDir: string, slug: string): string[] {
  let entries: string[];
  try {
    entries = fs
      .readdirSync(path.join(specsDir, slug, 'todos'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  return entries.filter((id) => fs.existsSync(planPath(specsDir, slug, id))).sort();
}

/** Render a Submit PR halt for the user, including verify output. */
function describeSubmitPrError(error: SubmitPrError): string {
  if (error.kind === 'verify-failed') {
    const tail = error.output.trim().split('\n').slice(-20).join('\n');
    return `${error.message}\n${tail}`;
  }
  return error.message;
}

// --- CodeLens --------------------------------------------------------------

/** The lens title and command for each state-gated todo action (Req 4.2). */
const ACTION_LENS: Record<TodoAction, { title: string; command: string }> = {
  plan: { title: 'Plan', command: COMMANDS.plan },
  execute: { title: 'Execute', command: COMMANDS.execute },
  review: { title: 'Review', command: COMMANDS.review },
  replan: { title: 'Re-plan', command: COMMANDS.replan },
  stop: { title: 'Stop', command: COMMANDS.stop },
  view: { title: 'View', command: COMMANDS.view },
  viewPlan: { title: 'View plan', command: COMMANDS.viewPlan },
};

/**
 * A CodeLens provider that puts the state-gated actions inline above each todo
 * line of a spec's `spec.md`. Each todo emits exactly `legalActions(todo.state,
 * hasSession)`, so the tree and the CodeLens cannot disagree (Req 4.2, 4.3);
 * `hasSession` comes from one read of the spec's `runs.jsonl` per provide call.
 * Each lens invokes a stage/action/view command with the spec's slug and the
 * todo id, wiring the editor surface to the run queue and tools (Req 10.3).
 */
class SpecCodeLensProvider implements vscode.CodeLensProvider {
  constructor(private readonly specsDir: string) {}

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const slug = slugFromSpecUri(document.uri);
    if (slug === undefined) {
      return [];
    }
    const spec = parseSpec(document.getText());
    const journalPath = path.join(this.specsDir, slug, 'runs.jsonl');
    const sessions = sessionSet(parseJournal(journalPath));
    const lenses: vscode.CodeLens[] = [];
    for (const todo of spec.todos) {
      const line = document.lineAt(todo.lineIndex);
      const range = new vscode.Range(line.range.start, line.range.start);
      const hasPlan = fs.existsSync(planPath(this.specsDir, slug, todo.id));
      for (const action of legalActions(todo.state, sessions.has(todo.id), hasPlan)) {
        const { title, command } = ACTION_LENS[action];
        lenses.push(lens(range, title, command, slug, todo.id));
      }
    }
    return lenses;
  }
}

/** The set of todo ids the journal records a Session_Id for (Req 4.4). */
function sessionSet(entries: ReturnType<typeof parseJournal>): Set<string> {
  const sessions = new Set<string>();
  for (const entry of entries) {
    if (entry.sessionId !== undefined) {
      sessions.add(entry.todoId);
    }
  }
  return sessions;
}

/** Build one CodeLens invoking a command with `[slug, todoId]`. */
function lens(
  range: vscode.Range,
  title: string,
  command: string,
  slug: string,
  todoId: string,
): vscode.CodeLens {
  return new vscode.CodeLens(range, { title, command, arguments: [slug, todoId] });
}

/** The spec slug from a `.baiton/specs/<slug>/spec.md` URI, or `undefined`. */
function slugFromSpecUri(uri: vscode.Uri): string | undefined {
  const match = /[/\\]\.baiton[/\\]specs[/\\]([^/\\]+)[/\\]spec\.md$/.exec(uri.fsPath);
  return match ? match[1] : undefined;
}

// --- shared helpers --------------------------------------------------------

/** Build the guard context (repo root, specs dir, restricted flag) for a call. */
function guardContextFor(workspace: WorkspaceContext<vscode.Uri>): GuardContext {
  return new GuardContext({
    repoRoot: workspace.root.fsPath,
    specsDir: vscode.Uri.joinPath(workspace.baitonDir, 'specs').fsPath,
    restricted: workspace.restricted,
  });
}

/**
 * Resolve the `{slug, todoId}` a trigger acts on from the command arguments,
 * prompting the user for anything a CodeLens/palette invocation did not supply.
 */
async function resolveTarget(
  specsDir: string,
  slugArg: string | undefined,
  todoArg: string | undefined,
  surface: Surface,
): Promise<{ slug: string; todoId: string } | undefined> {
  const slug = slugArg ?? (await pickSpecSlug(specsDir));
  if (slug === undefined) {
    surface.warn('Baiton: no spec selected.');
    return undefined;
  }
  const todoId =
    todoArg ?? (await vscode.window.showInputBox({ prompt: 'Todo id (e.g. T01)' }));
  if (todoId === undefined || todoId.trim().length === 0) {
    surface.warn('Baiton: no todo id provided.');
    return undefined;
  }
  return { slug, todoId };
}

/** Present the spec slugs under `.baiton/specs/` for the user to choose from. */
async function pickSpecSlug(specsDir: string): Promise<string | undefined> {
  let slugs: string[] = [];
  try {
    slugs = fs
      .readdirSync(specsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    slugs = [];
  }
  if (slugs.length === 0) {
    return vscode.window.showInputBox({ prompt: 'Spec slug' });
  }
  return vscode.window.showQuickPick(slugs, { placeHolder: 'Select a spec' });
}

/** Prompt for a spec slug, defaulting to a quick pick of existing specs. */
async function promptForSlug(
  workspace: WorkspaceContext<vscode.Uri>,
  _prompt: string,
): Promise<string | undefined> {
  const specsDir = vscode.Uri.joinPath(workspace.baitonDir, 'specs').fsPath;
  return pickSpecSlug(specsDir);
}

/**
 * Build the {@link ToolServices} bundle for the tool registry from the real git
 * service, the run-queue seam, and a `vscode`-backed confirmation seam.
 */
function buildToolServices(
  repoRoot: string,
  baitonDir: string,
  git: ReturnType<typeof createGitService>,
  queueForSlug: QueueForSlug,
  specsDir: string,
  submitPrForSlug: (slug: string) => Promise<SubmitPrOutcome>,
): ToolServices {
  return {
    repoRoot,
    baitonDir,
    git,
    confirm: buildConfirmSeam(),
    runQueue: createRunQueueSeam(queueForSlug, specsDir),
    clock: systemClock,
    ids: { next: () => `id-${Date.now()}-${Math.random().toString(36).slice(2)}` },
    gitSettings: readGitSettings(),
    submitPr: submitPrForSlug,
  };
}

/** The configured PR CLI path override (`baiton.pr.toolPath`), empty when unset. */
function readPrToolPath(): string {
  return vscode.workspace.getConfiguration(SETTINGS_NS).get<string>('pr.toolPath') ?? '';
}

/** Read the approval git settings (remote/base) from the workspace config. */
function readGitSettings(): { remote: string; base: string } {
  const cfg = vscode.workspace.getConfiguration(SETTINGS_NS);
  return {
    remote: cfg.get<string>('git.remote') ?? 'origin',
    base: cfg.get<string>('git.base') ?? 'main',
  };
}

/**
 * Build the `vscode`-backed {@link ConfirmSeam} presented as a modal for both
 * the approve control tool (through the registry) and the Chat_View approval
 * (through the {@link ChatController}, Req 15). "Approve" confirms; any other
 * dismissal declines.
 */
function buildConfirmSeam(): ConfirmSeam {
  return {
    async confirm(message: string): Promise<boolean> {
      const answer = await vscode.window.showWarningMessage(
        message,
        { modal: true },
        'Approve',
      );
      return answer === 'Approve';
    },
  };
}

/**
 * Read the configured Round_Bound raw value (Req 9.6). The tool loop resolves
 * an unset/invalid value to its default through `resolveRoundBound`, so this
 * returns whatever the setting holds without coercion.
 */
function readRoundBound(): unknown {
  return vscode.workspace
    .getConfiguration(SETTINGS_NS)
    .get('orchestrator.roundBound');
}

/**
 * Read the configured endpoint/model for the Chat_View empty state (Req 13.5).
 * Each getter re-reads the live setting so a change made while the view is open
 * is reflected on the next render.
 */
function readOrchestratorConfig(): OrchestratorConfig {
  const cfg = () => vscode.workspace.getConfiguration(SETTINGS_NS);
  return {
    getEndpoint: () => cfg().get<string>('orchestrator.endpoint') || null,
    getModel: () => cfg().get<string>('orchestrator.model') || null,
  };
}

/**
 * Handle an inline-error fix action from the Chat_View (Req 13.4):
 * `openSettings` opens the Baiton orchestrator settings; `setApiKey` invokes
 * the Set Orchestrator API Key command.
 */
function triggerFix(action: 'openSettings' | 'setApiKey'): void {
  if (action === 'setApiKey') {
    void vscode.commands.executeCommand(COMMANDS.setApiKey);
    return;
  }
  void vscode.commands.executeCommand(
    'workbench.action.openSettings',
    `${SETTINGS_NS}.orchestrator`,
  );
}

/**
 * Normalize the first argument a stage/approve command receives into a spec
 * slug. The tree's inline actions invoke the command with the clicked
 * {@link TreeNode}; the CodeLens and palette invoke it with a slug string (or
 * nothing). A tree node yields its slug through {@link treeNodeTarget}
 * (Req 5.5, 18.4).
 */
function slugArg(arg: TreeNode | string | undefined): string | undefined {
  if (typeof arg === 'string' || arg === undefined) {
    return arg;
  }
  const target = treeNodeTarget(arg);
  return target?.[0];
}

/**
 * Normalize the arguments a per-todo stage/action command receives into
 * `{ slug, todoId }`. The tree's inline actions invoke the command with the
 * clicked {@link TreeNode} as the sole argument; the CodeLens and palette invoke
 * it with `(slug, todoId)`. A todo tree node yields both through
 * {@link treeNodeTarget} (Req 5.2, 18.4).
 */
function todoArgs(
  a: TreeNode | string | undefined,
  b: string | undefined,
): { slug?: string; todoId?: string } {
  if (a !== undefined && typeof a !== 'string') {
    const target = treeNodeTarget(a);
    return { slug: target?.[0], todoId: target?.[1] };
  }
  return { slug: a, todoId: b };
}

/**
 * Build the OpenAI-compatible model client, reading the endpoint/model from
 * settings and the API key from SecretStorage (Req 7.3, 7.4). Streaming is used
 * when the setting advertises it (Req 7.2).
 */
function buildModelClient(context: vscode.ExtensionContext): OpenAiModelClient {
  const cfg = () => vscode.workspace.getConfiguration(SETTINGS_NS);
  return new OpenAiModelClient({
    getEndpoint: () => cfg().get<string>('orchestrator.endpoint') || undefined,
    getModel: () => cfg().get<string>('orchestrator.model') || undefined,
    getApiKey: () => Promise.resolve(context.secrets.get('baiton.orchestrator.apiKey')),
    isStreaming: () => cfg().get<boolean>('orchestrator.streaming') ?? true,
    getMaxTokens: () => cfg().get('orchestrator.maxTokens'),
  });
}

/** Resolve the per-role model + effort from the loaded config (adapter `--model`). */
function modelForRole(config: Config, role: Role): { model: string; effort?: string } {
  const entry = config.roles[role];
  return {
    model: entry.model,
    ...(entry.effort !== undefined ? { effort: entry.effort } : {}),
  };
}

/**
 * Resolve the per-role adapter from the loaded config's `agent` id;
 * `undefined` when that id is not a known agent (Req 14.1).
 */
function adapterForRole(config: Config, adapters: AdapterRegistry, role: Role): Adapter | undefined {
  return adapters.get(config.roles[role].agent);
}
