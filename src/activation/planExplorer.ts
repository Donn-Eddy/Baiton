/**
 * The Plan Explorer tree provider for plan documents and phases.
 *
 * The explorer lists both document roots: `.baiton/plans/<slug>/plan.md` and
 * the legacy `.baiton/specs/<slug>/spec.md`. `listPlans` and `resolveDocument`
 * prefer the plans root when a slug exists in both locations. Refreshes derive
 * the tree from disk, approval state, plan journals, and phase plans.
 *
 * A watcher over `{plans,specs}/**` coalesces filesystem changes; `specs` is
 * the legacy document root. Root clicks open the resolved plan document and
 * update the active plan. Inline actions use the existing command arguments
 * and are hidden in Restricted Mode through package.json context clauses.
 */
import * as vscode from 'vscode';
import { resolveDocument } from '../storage/documentLocation';
import type { PlanStore } from '../engine';
import {
  buildPlanTree,
  type PlanNode,
  type PhaseNode,
  type ErrorNode,
  type PlanStatus,
} from '../model/treeModel';
import { phaseContextValue } from '../model/phaseActions';
import { planContextValue } from '../model/planActions';
import { readPlanJournal, type JournalEntry } from '../journal';
import { listPlans, listPhasePlans } from './planLister';
import type { Surface } from './surface';

/**
 * A sink the explorer notifies when the user clicks a plan root: the Chat_View
 * active plan follows the explorer selection. The sink is optional when no chat
 * surface is wired.
 */
export type SetActivePlan = (slug: string | undefined) => void;

/** The command id a tree item invokes to open the resolved plan document. */
const OPEN_PLAN_COMMAND = 'baiton.planExplorer.openPlan';

/** The debounce window for coalescing filesystem events into one refresh (Req 6.2). */
const REFRESH_DEBOUNCE_MS = 500;

/**
 * The `contextValue`s the `view/item/context` menu contributions match on to
 * surface the inline actions (inline tree actions). A phase
 * node's contextValue is `baiton.phase` plus one token per legal action (built
 * by {@link phaseContextValue}); a valid plan root's is `baiton.planRoot` plus one
 * token per legal action (built by {@link planContextValue}), so it offers
 * Approve, Submit PR or Show PR only when that action is legal. An invalid or
 * unreadable root keeps the fixed error context value below and offers none.
 */
const CONTEXT_ERROR = 'baiton.planError';

/**
 * One node in the tree: a plan root, a phase child, or an error child. This is
 * the element VS Code hands to the `view/item/context` command handlers, which read `node.slug`/`node.id` off it to invoke
 * `baiton.*` with the CodeLens argument order (design "PlanExplorer inline
 * actions"). Exported for that wiring and its {@link treeNodeTarget} helper.
 */
export type TreeNode =
  | { kind: 'plan'; node: PlanNode }
  | { kind: 'phase'; node: PhaseNode }
  | { kind: 'error'; node: ErrorNode };

/**
 * The `[slug]` or `[slug, phaseId]` a `view/item/context` action forwards to the
 * matching `baiton.*` command from a clicked {@link TreeNode} (Req 5.2, 5.5,
 * 18.4). A plan root yields `[slug]` (Approve/Submit PR/Show PR); a phase yields `[slug, phaseId]`
 * (Plan/Execute/Review/Re-plan/Stop); an error child has no action.
 */
export function treeNodeTarget(node: TreeNode): string[] | undefined {
  switch (node.kind) {
    case 'plan':
      return [node.node.slug];
    case 'phase':
      return [node.node.slug, node.node.id];
    case 'error':
      return undefined;
  }
}

/**
 * The Plan Explorer {@link vscode.TreeDataProvider}. Construct it, register it
 * as a tree data provider, register the open-plan command it emits, and start
 * its watcher; dispose the returned {@link PlanExplorer.dispose} on teardown.
 */
export class PlanExplorer
  implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable
{
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
  /** Fired to tell VS Code to re-query the tree (Req 6.1). */
  public readonly onDidChangeTreeData = this.emitter.event;

  /** The current roots, recomputed from disk on each refresh (no cache, Req 6.3). */
  private roots: PlanNode[] = [];

  private readonly disposables: vscode.Disposable[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  /** Guards against overlapping async refreshes clobbering `roots` out of order. */
  private refreshSeq = 0;

  /**
   * @param baitonDir     absolute `.baiton/` directory; both document roots are scanned under it.
   * @param planStore    supplies each plan's approval fact (Req 2.4).
   * @param surface      the shared notification surface for open failures (Req 2.7).
   * @param restricted   whether the workspace is in Restricted Mode; sets the
   *                     `baiton.restricted` context key the inline-action
   *                     `when` clauses negate to hide actions (Req 5.6, 5.7).
   * @param setActivePlan sink notified on a root click; optional when no chat surface is wired.
   */
  constructor(
    private readonly baitonDir: string,
    private readonly planStore: PlanStore,
    private readonly surface: Surface,
    private readonly restricted: boolean,
    private readonly setActivePlan?: SetActivePlan,
  ) {}

  /**
   * Register the open-plan command and a `FileSystemWatcher` over
   * `{plans,specs}/**` (specs is the legacy root), then run the first refresh. Returns `this` so callers
   * can register it as a tree data provider and push it onto their
   * subscriptions.
   */
  public start(): this {
    // Publish the restricted-mode context key the inline-action `when` clauses
    // negate, so all actions hide under Restricted Mode and show otherwise
    // (Req 5.6, 5.7).
    void vscode.commands.executeCommand(
      'setContext',
      'baiton.restricted',
      this.restricted,
    );

    this.disposables.push(
      vscode.commands.registerCommand(OPEN_PLAN_COMMAND, (slug: string) =>
        this.openPlan(slug),
      ),
    );

    // The watcher observes both document roots; specs is the legacy root; each
    // event schedules a single coalesced refresh (Req 6.1, 6.2, 6.4).
    const pattern = new vscode.RelativePattern(this.baitonDir, '{plans,specs}/**');
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    watcher.onDidCreate(() => this.scheduleRefresh(), undefined, this.disposables);
    watcher.onDidChange(() => this.scheduleRefresh(), undefined, this.disposables);
    watcher.onDidDelete(() => this.scheduleRefresh(), undefined, this.disposables);
    this.disposables.push(watcher);

    void this.refresh();
    return this;
  }

  /** Dispose the watcher, the command, and any pending debounce timer. */
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

  public getChildren(element?: TreeNode): TreeNode[] {
    if (element === undefined) {
      // Roots: one per present plan, in the lister's ascending-slug order.
      return this.roots.map((node) => ({ kind: 'plan', node }));
    }
    if (element.kind === 'plan') {
      const children = element.node.children;
      if (children.kind === 'errors') {
        return children.errors.map((node) => ({ kind: 'error', node }));
      }
      return children.phases.map((node) => ({ kind: 'phase', node }));
    }
    // Phase and error nodes are leaves.
    return [];
  }

  public getTreeItem(element: TreeNode): vscode.TreeItem {
    switch (element.kind) {
      case 'plan':
        return this.planItem(element.node);
      case 'phase':
        return this.phaseItem(element.node);
      case 'error':
        return this.errorItem(element.node);
    }
  }

  // --- refresh -------------------------------------------------------------

  /** Schedule a coalesced refresh ~500 ms after the latest event (Req 6.2). */
  private scheduleRefresh(): void {
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.refresh();
    }, REFRESH_DEBOUNCE_MS);
  }

  /**
   * Re-derive the whole tree from disk (Req 6.3): list the plan documents, read each
   * plan's approval fact from the store, and build the nodes. A later refresh
   * that started after this one wins, so a slow earlier scan cannot overwrite a
   * fresher result.
   */
  private async refresh(): Promise<void> {
    const seq = ++this.refreshSeq;
    const listed = await listPlans(this.baitonDir);
    const inputs = await Promise.all(
      listed.map(async (entry) => ({
        slug: entry.slug,
        raw: entry.raw,
        readError: entry.readError,
        // The approval fact comes from the store, never recomputed here (Req 2.4).
        approved: await this.approvalFor(entry.slug),
        // Phase ids with a recorded Session_Id, from the plan's own journal
        // (Req 4.4); a plan with no journals reads back as no entries.
        sessions: sessionSet(readPlanJournal(this.baitonDir, entry.slug)),
        // Phase ids whose plan is on file, which gates the View plan action.
        plans: await listPhasePlans(this.baitonDir, entry.slug),
      })),
    );
    if (seq !== this.refreshSeq) {
      // A newer refresh superseded this one while we awaited; drop this result.
      return;
    }
    this.roots = buildPlanTree(inputs);
    this.emitter.fire(undefined);
  }

  /** The store's approval fact for a plan, treating a probe failure as unapproved. */
  private async approvalFor(slug: string): Promise<boolean> {
    try {
      return await this.planStore.isApproved(slug);
    } catch {
      return false;
    }
  }

  // --- TreeItem mapping ----------------------------------------------------

  /**
   * A plan root item: `<slug>` plus its status (or an unset indication), an
   * approved marker, and an invalid marker (Req 2.2, 2.3, 2.4, 2.5, 3.1).
   * Clicking it opens the plan's `plan.md` and sets it active (Req 2.6).
   */
  private planItem(node: PlanNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.slug,
      vscode.TreeItemCollapsibleState.Collapsed,
    );
    item.description = this.planDescription(node);
    // `baiton.planRoot` plus one token per legal action; the `view/item/context`
    // `when` clauses in `package.json` match those tokens with `\b<action>\b`
    // so the tree and the menu cannot disagree.
    item.contextValue = node.invalid ? CONTEXT_ERROR : planContextValue(node.actions);
    item.iconPath = new vscode.ThemeIcon(node.invalid ? 'warning' : 'file');
    item.tooltip = this.planTooltip(node);
    item.command = {
      command: OPEN_PLAN_COMMAND,
      title: 'Open Plan',
      arguments: [node.slug],
    };
    return item;
  }

  /** The `<status> · approved · invalid` description shown beside a plan root. */
  private planDescription(node: PlanNode): string {
    const parts: string[] = [statusLabel(node.status)];
    if (node.approved) {
      parts.push('approved');
    }
    if (node.invalid) {
      parts.push('invalid');
    }
    return parts.join(' · ');
  }

  /** A tooltip spelling out the plan's derived facts. */
  private planTooltip(node: PlanNode): string {
    const lines = [
      `Plan: ${node.slug}`,
      `Status: ${statusLabel(node.status)}`,
      `Approved: ${node.approved ? 'yes' : 'no'}`,
      `Valid: ${node.invalid ? 'no' : 'yes'}`,
    ];
    if (node.prUrl !== undefined) {
      lines.push(`PR: ${node.prUrl}`);
    }
    return lines.join('\n');
  }

  /**
   * A phase child item: `<id> <title>` with its state and, when derived-blocked,
   * a blocked marker (Req 4.1, 4.2, 4.3, 4.4, 4.5). Inline actions attach via
   * the `baiton.phase` context value (inline tree actions).
   */
  private phaseItem(node: PhaseNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      `${node.id} ${node.title}`,
      vscode.TreeItemCollapsibleState.None,
    );
    item.description = node.blocked ? `${node.state} · blocked` : node.state;
    // `baiton.phase` plus one token per legal action (Req 4.1); the
    // `view/item/context` `when` clauses in `package.json` match on those
    // tokens with `\b<action>\b` so the tree and the menu cannot disagree.
    item.contextValue = phaseContextValue(node.actions);
    item.iconPath = new vscode.ThemeIcon(node.blocked ? 'circle-slash' : 'circle-outline');
    item.tooltip = `${node.id} ${node.title}\nState: ${node.state}\nBlocked: ${node.blocked ? 'yes' : 'no'}`;
    return item;
  }

  /**
   * An error child item under an invalid or unreadable plan: the reason and the
   * 1-based line it applies to (Req 3.2, 3.3, 6.6).
   */
  private errorItem(node: ErrorNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      `Line ${node.line}: ${node.reason}`,
      vscode.TreeItemCollapsibleState.None,
    );
    item.iconPath = new vscode.ThemeIcon('error');
    item.tooltip = `${node.reason} (line ${node.line})`;
    return item;
  }

  // --- click-to-open -------------------------------------------------------

  /**
   * Open the resolved plan document and set it as the Chat_View active plan (Req 2.6).
   * When the file cannot be opened, surface an error and leave the active plan
   * unchanged (Req 2.7).
   */
  private async openPlan(slug: string): Promise<void> {
    const documentPath = resolveDocument(this.baitonDir, slug).documentPath;
    try {
      const doc = await vscode.workspace.openTextDocument(documentPath);
      await vscode.window.showTextDocument(doc, { preview: false });
    } catch (e) {
      this.surface.error(
        `Baiton: could not open plan "${slug}": ${describe(e)}.`,
      );
      return; // Leave the active plan unchanged (Req 2.7).
    }
    this.setActivePlan?.(slug);
  }
}

/** The label for a plan's status: the set value, or an unset indication (Req 2.3). */
function statusLabel(status: PlanStatus): string {
  return status.kind === 'set' ? status.value : 'no status';
}

/**
 * The set of phase ids a parsed journal records a Session_Id for (Req 4.4). A
 * missing `runs.jsonl` parses back as an empty entry array, so this naturally
 * yields an empty set.
 */
function sessionSet(entries: JournalEntry[]): Set<string> {
  const sessions = new Set<string>();
  for (const entry of entries) {
    if (entry.sessionId !== undefined) {
      // JournalEntry.todoId is a persisted field name.
      sessions.add(entry.todoId); // legacy journal field name
    }
  }
  return sessions;
}

/** A short, safe description of a thrown value for a user-facing message. */
function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
