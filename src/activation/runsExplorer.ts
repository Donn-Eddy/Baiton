/**
 * The Runs view tree provider and its three commands (design "dispatch modes",
 * todo T16).
 *
 * This is the thin `vscode` glue over the host-free run tree model in
 * `src/model/runTreeModel.ts`, modelled on `specExplorer.ts`. On each refresh it
 * lists the run manifests from the {@link RunStore}, asks the run pipeline which
 * stage (if any) is in flight, and hands both to {@link buildRunTree}, which
 * derives every label, description, tooltip and `contextValue`. NOTHING about
 * which action is legal for which run state is decided here: `legalRunActions`
 * owns that rule, and the `view/item/context` `when` clauses in `package.json`
 * match the very tokens `runContextValue` emits, so the tree and the menu cannot
 * disagree.
 *
 * Two things drive a repaint:
 *   1. a `FileSystemWatcher` over `.baiton/runs/*\/run.json`, debounced
 *      ~{@link RUNS_REFRESH_DEBOUNCE_MS} so a burst of manifest writes coalesces;
 *   2. every `RunPipeline` change event, applied immediately — a
 *      `stage-started` must repaint the spinner without waiting out a debounce.
 *
 * The three command handlers live below the class with every host call injected
 * ({@link RunsCommandDeps}), so they are unit-testable without a host;
 * `commands.ts` only registers them and supplies the `showDiff`/`confirm` seams.
 */
import * as vscode from 'vscode';
import { mergeRunWorktree } from '../engine';
import type { RunManifest, RunStore } from '../engine';
import type { LiveRunStage, RunPipelineEvent } from '../engine/runPipeline';
import type { GitWorktreeService } from '../git';
import {
  buildRunTree,
  type LiveRunStageFact,
  type RunGroupNode,
  type RunNode,
} from '../model';
import type { Surface } from './surface';

/**
 * The Runs tree view id contributed in `package.json`. Exported so a test can
 * pin contribution parity, exactly as `CONFIG_VIEW_ID` does for the config panel.
 */
export const RUNS_VIEW_ID = 'baiton.runsView';

/** The debounce window for coalescing manifest filesystem events into one refresh. */
export const RUNS_REFRESH_DEBOUNCE_MS = 500;

/**
 * One node in the Runs tree: a group heading (Active / Complete) or one run.
 * This is the element VS Code hands the `view/item/context` command handlers,
 * so the wiring reads the run id off it through {@link runNodeTarget}.
 */
export type RunTreeNode =
  | { kind: 'group'; node: RunGroupNode }
  | { kind: 'run'; node: RunNode };

/**
 * The run id a `view/item/context` action forwards to a `baiton.runs.*` command
 * from a clicked {@link RunTreeNode} — the analogue of `treeNodeTarget`. A group
 * heading has no action, so it yields `undefined`.
 */
export function runNodeTarget(node: RunTreeNode): string | undefined {
  return node.kind === 'run' ? node.node.runId : undefined;
}

/**
 * The facts the Runs view needs from the run pipeline: a structural subset of
 * `RunPipeline` (which satisfies it without a cast) so a test can pass a
 * fake without building a whole pipeline.
 */
export interface RunsPipelineFacts {
  onChange(listener: (event: RunPipelineEvent) => void): () => void;
  currentStage(): LiveRunStage | undefined;
  currentRunId(): string | undefined;
  cancel(): boolean;
}

/**
 * The Runs {@link vscode.TreeDataProvider}. Construct it, {@link start} it,
 * register it as a tree data provider, and push it onto the subscriptions.
 */
export class RunsExplorer implements vscode.TreeDataProvider<RunTreeNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<RunTreeNode | undefined>();
  /** Fired to tell VS Code to re-query the tree. */
  public readonly onDidChangeTreeData = this.emitter.event;

  /** The current groups, recomputed on each refresh (always exactly two). */
  private groups: RunGroupNode[] = [];

  private readonly disposables: vscode.Disposable[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * @param store    the run manifest store, already bound to the workspace root.
   * @param runsDir  the absolute `.baiton/runs` directory (`runsRootDir(repoRoot)`).
   * @param pipeline the live-stage facts and the cancel entry point.
   * @param surface  the shared notification surface for listing failures.
   */
  constructor(
    private readonly store: RunStore,
    private readonly runsDir: string,
    private readonly pipeline: RunsPipelineFacts,
    private readonly surface: Surface,
  ) {}

  /**
   * Watch `.baiton/runs/*\/run.json`, subscribe to the pipeline, and run the
   * first refresh. Returns `this` so the caller can register it as a tree data
   * provider and push it onto their subscriptions.
   *
   * It deliberately does NOT publish the `baiton.restricted` context key the
   * Runs menus negate: `SpecExplorer.start()` already publishes it, and a second
   * writer of the same key would be redundant.
   */
  public start(): this {
    const pattern = new vscode.RelativePattern(this.runsDir, '*/run.json');
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    watcher.onDidCreate(() => this.scheduleRefresh(), undefined, this.disposables);
    watcher.onDidChange(() => this.scheduleRefresh(), undefined, this.disposables);
    watcher.onDidDelete(() => this.scheduleRefresh(), undefined, this.disposables);
    this.disposables.push(watcher);

    // Pipeline events are authoritative and must not be debounced away: a
    // `stage-started` repaints the spinner immediately.
    this.disposables.push(
      new vscode.Disposable(this.pipeline.onChange(() => this.refreshNow())),
    );

    this.refreshNow();
    return this;
  }

  /** Dispose the watcher, the pipeline subscription, and any pending timer. */
  public dispose(): void {
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
    this.emitter.dispose();
  }

  // --- TreeDataProvider ----------------------------------------------------

  public getChildren(element?: RunTreeNode): RunTreeNode[] {
    if (element === undefined) {
      // Exactly two groups, Active first, both always present.
      return this.groups.map((node) => ({ kind: 'group', node }) as const);
    }
    if (element.kind === 'group') {
      return element.node.runs.map((node) => ({ kind: 'run', node }) as const);
    }
    // Run nodes are leaves.
    return [];
  }

  public getTreeItem(element: RunTreeNode): vscode.TreeItem {
    return element.kind === 'group' ? groupItem(element.node) : runItem(element.node);
  }

  // --- refresh -------------------------------------------------------------

  /** Schedule a coalesced refresh ~500 ms after the latest filesystem event. */
  private scheduleRefresh(): void {
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      this.refreshNow();
    }, RUNS_REFRESH_DEBOUNCE_MS);
  }

  /**
   * Re-derive the whole tree and repaint. Synchronous — `RunStore.list()` reads
   * the manifests synchronously — so there is no ordering guard to keep. Public
   * because the command handlers repaint after a cancel or a merge.
   */
  public refreshNow(): void {
    const live = this.liveFact();
    this.groups =
      live !== undefined ? buildRunTree(this.safeList(), live) : buildRunTree(this.safeList());
    this.emitter.fire(undefined);
  }

  /**
   * The manifests, or `[]` with a logged line: `list()` rethrows a non-ENOENT
   * readdir failure, and an unreadable runs directory must not break the view.
   */
  private safeList(): RunManifest[] {
    try {
      return this.store.list();
    } catch (e) {
      this.surface.log(`Baiton: could not list runs: ${describe(e)}.`);
      return [];
    }
  }

  /** The stage in flight right now, reduced to the model's fact; undefined when idle. */
  private liveFact(): LiveRunStageFact | undefined {
    const stage = this.pipeline.currentStage();
    return stage === undefined
      ? undefined
      : { runId: stage.runId, stage: stage.stage, attempt: stage.attempt };
  }
}

/** A group heading item: the label, the run count, and an Active/Complete icon. */
function groupItem(node: RunGroupNode): vscode.TreeItem {
  const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
  item.contextValue = node.contextValue;
  item.description = String(node.runs.length);
  item.iconPath = new vscode.ThemeIcon(node.kind === 'active' ? 'play-circle' : 'history');
  return item;
}

/**
 * A run item. Every user-visible string and the `contextValue` come straight off
 * the model node — none of them is rebuilt here. There is deliberately no
 * `item.command`: click-to-open is not part of this view; an investigate run's
 * finding is surfaced by the chat promote card.
 */
function runItem(node: RunNode): vscode.TreeItem {
  const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
  item.id = node.runId;
  item.description = node.description;
  item.tooltip = node.tooltip;
  item.contextValue = node.contextValue;
  item.iconPath = new vscode.ThemeIcon(runIconId(node));
  return item;
}

/** The codicon id for a run: a spinner while a stage is in flight, else its outcome. */
function runIconId(node: RunNode): string {
  if (node.stage !== undefined) {
    return 'sync~spin';
  }
  switch (node.state) {
    case 'merged':
      return 'git-merge';
    case 'done':
      return 'check';
    case 'answered':
      return 'lightbulb';
    case 'cancelled':
      return 'circle-slash';
    case 'failed':
      return 'error';
    default:
      return 'circle-outline';
  }
}

// --- commands --------------------------------------------------------------

/**
 * Everything the three `baiton.runs.*` handlers touch, injected so each handler
 * is unit-testable without a host: `commands.ts` supplies the two host seams
 * (`showDiff`, `confirm`) as one-liners and holds no decision logic of its own.
 */
export interface RunsCommandDeps {
  repoRoot: string;
  store: RunStore;
  git: GitWorktreeService;
  pipeline: RunsPipelineFacts;
  surface: Surface;
  /** True while the workspace is untrusted (Restricted Mode). */
  restricted: () => boolean;
  /** Show a unified diff to the user; supplied by commands.ts. */
  showDiff: (title: string, diff: string) => Promise<void>;
  /** Modal yes/no; supplied by commands.ts. */
  confirm: (message: string, action: string) => Promise<boolean>;
  /** Repaint the view after a state change. */
  refresh: () => void;
}

/**
 * Cancel the stage in flight for a run. Restricted Mode refuses it: cancelling
 * disposes a terminal, which is an action on the workspace.
 *
 * Only the run the pipeline is actually driving can be cancelled — the pipeline
 * runs one run at a time — and the worktree and the branch are deliberately left
 * on disk, exactly as `RunPipeline.cancel()` leaves them, so a cancelled run can
 * still be inspected and diffed.
 *
 * The manifest reaches `cancelled` asynchronously: `RunPipeline` writes it once
 * the disposed terminal makes `awaitStageResult` resolve `closed`, and the view
 * repaints again off the pipeline's `completed` event. The {@link refresh} here
 * is therefore only the immediate spinner-clearing paint, not the final one.
 */
export async function runRunsCancel(
  deps: RunsCommandDeps,
  runId: string | undefined,
): Promise<void> {
  if (deps.restricted()) {
    deps.surface.warn(
      'Baiton is read-only in Restricted Mode: trust this workspace to cancel a run.',
    );
    return;
  }
  const target = runId ?? deps.pipeline.currentRunId();
  if (target === undefined) {
    deps.surface.warn('Baiton: no run is in flight.');
    return;
  }
  if (deps.pipeline.currentRunId() !== target) {
    deps.surface.warn(`Baiton: run ${target} has no stage in flight to cancel.`);
    return;
  }
  const disposed = deps.pipeline.cancel();
  if (!disposed) {
    // The stage finished between `currentRunId()` and `cancel()`: nothing was
    // disposed, so this must not report a cancellation.
    deps.surface.warn(`Baiton: run ${target} has no stage in flight to cancel.`);
    return;
  }
  deps.surface.log(`Baiton: cancel run ${target}; its worktree and branch are kept.`);
  deps.refresh();
}

/** A commit abbreviated for a user-facing label; short shas are left alone. */
export function shortSha(sha: string): string {
  return sha.length > 7 ? sha.slice(0, 7) : sha;
}

/** The diff range a run's View diff opens: `<base commit>..<branch>`. */
export function runDiffRange(manifest: RunManifest): string {
  return `${shortSha(manifest.baseHead)}..${manifest.branch}`;
}

/**
 * Open the diff of a run's branch against the base commit it started from.
 *
 * Read-only, so it is NOT gated on Restricted Mode — the same reasoning as
 * `baiton.showPr` and `baiton.viewPlan`.
 */
export async function runRunsViewDiff(
  deps: RunsCommandDeps,
  runId: string | undefined,
): Promise<void> {
  if (runId === undefined) {
    deps.surface.warn('Baiton: no run selected.');
    return;
  }
  const read = deps.store.read(runId);
  if (!read.ok) {
    // The store's messages are already user-facing and end in a period.
    deps.surface.error(`Baiton: ${read.error.message}`);
    return;
  }
  const manifest = read.value;
  if (manifest.worktreeDir === undefined) {
    deps.surface.warn(`Baiton: run ${runId} has no worktree, so there is no diff to show.`);
    return;
  }
  if ((await deps.git.branchHead(manifest.branch)) === undefined) {
    // The case after a merge cleaned the branch up.
    deps.surface.warn(`Baiton: the branch ${manifest.branch} for run ${runId} no longer exists.`);
    return;
  }
  let text: string;
  try {
    text = await deps.git.diff(manifest.baseHead, manifest.branch);
  } catch (e) {
    deps.surface.error(
      `Baiton: could not diff ${manifest.branch} against ${manifest.baseHead}: ${describe(e)}.`,
    );
    return;
  }
  if (text.trim() === '') {
    deps.surface.info(`Baiton: run ${runId} changed nothing on ${manifest.branch}.`);
    return;
  }
  // `git diff A B` is exactly the `A..B` comparison the range names.
  const range = runDiffRange(manifest);
  deps.surface.log(`Baiton: diff for run ${runId}: ${range}.`);
  await deps.showDiff(`${manifest.mode} run ${runId}: ${range}`, text);
}

/**
 * Merge a run's branch into its base branch, then record the run as `merged`.
 *
 * This never touches the run pipeline: a mergeable run is complete, so there is
 * no terminal behind it and no one-stage-per-repository lock to take. The state
 * rule is re-checked here as defence in depth only — `legalRunActions` remains
 * its single definition, and the `when` clauses re-encode none of it.
 */
export async function runRunsMerge(
  deps: RunsCommandDeps,
  runId: string | undefined,
): Promise<void> {
  if (deps.restricted()) {
    deps.surface.warn(
      'Baiton is read-only in Restricted Mode: trust this workspace to merge a run.',
    );
    return;
  }
  if (runId === undefined) {
    deps.surface.warn('Baiton: no run selected.');
    return;
  }
  const read = deps.store.read(runId);
  if (!read.ok) {
    deps.surface.error(`Baiton: ${read.error.message}`);
    return;
  }
  const manifest = read.value;
  if (manifest.state !== 'done' || manifest.worktreeDir === undefined) {
    deps.surface.warn(
      `Baiton: run ${runId} is ${manifest.state}; only a run whose review passed can be merged.`,
    );
    return;
  }

  const confirmed = await deps.confirm(
    `Merge ${manifest.branch} into ${manifest.baseBranch}? ` +
      "The run's worktree and branch are removed afterwards.",
    'Merge',
  );
  if (!confirmed) {
    return;
  }

  const merged = await mergeRunWorktree(
    { workspaceRoot: deps.repoRoot, git: deps.git },
    {
      runId,
      mode: manifest.mode,
      baseBranch: manifest.baseBranch,
      baseHead: manifest.baseHead,
      branch: manifest.branch,
      statement: manifest.statement,
    },
  );
  if (!merged.ok) {
    // Every refusal already names its reason; nothing is written to the manifest.
    // The machine-readable token goes to the log next to the user's prose.
    deps.surface.log(`Baiton: merge refused for run ${runId} (${merged.error.reason}).`);
    deps.surface.warn(`Baiton: ${merged.error.message}`);
    deps.refresh();
    return;
  }

  // The merge has landed. A failed manifest write is reported but never undone:
  // re-running the merge would then refuse with `base-moved`.
  const updated = deps.store.update(runId, { state: 'merged' });
  if (!updated.ok) {
    deps.surface.warn(
      `Baiton: ${merged.value.branch} was merged, but run ${runId} could not be recorded as ` +
        `merged: ${updated.error.message}`,
    );
  }
  // `mergeRunWorktree` did the removal as its cleanup step; this only reports it.
  deps.surface.log(
    `Baiton: removed the worktree and branch ${merged.value.branch} for run ${runId}.`,
  );
  deps.surface.info(
    `Baiton: merged ${merged.value.branch} into ${merged.value.baseBranch} as ${merged.value.commit}.`,
  );
  for (const warning of merged.value.cleanup) {
    deps.surface.warn(`Baiton: ${warning}`);
  }
  deps.refresh();
}

/** A short, safe description of a thrown value for a user-facing message. */
function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
