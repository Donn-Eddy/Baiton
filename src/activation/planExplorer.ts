/**
 * The Plan Explorer tree provider for plan documents and phases.
 *
 * The explorer lists both document roots: `.baiton/plans/<slug>/plan.md` and
 * the legacy `.baiton/specs/<slug>/spec.md`. `listPlans` and `resolveDocument`
 * prefer the plans root when a slug exists in both locations. Refreshes derive
 * the tree from disk, approval state, plan journals, and phase plans. Completed
 * also includes `pr`/`pr-partial` plans whose recorded requests all read merged,
 * derived through an injected checker and never persisted.
 *
 * A watcher over `{plans,specs}/**` coalesces filesystem changes; the legacy
 * `specs` root is the legacy document root. The three top-level roots are
 * Active, Pending, and Completed groups, with plans beneath them. Multiple
 * repository sources are labeled by owner, while phase labels identify a
 * distinct target repo. Plan clicks open the owning repository's document and
 * update the active plan when that source is actionable. Inline actions are
 * hidden in Restricted Mode through package.json context clauses.
 */
import * as vscode from 'vscode';
import { resolveDocument } from '../storage/documentLocation';
import type { PlanStore } from '../engine';
import { parsePrsValue } from '../engine/prTool';
import { recordedPrUrls } from '../engine/transitions';
import { parsePlan } from '../model/parser';
import {
  buildPlanGroups,
  buildPlanTree,
  type PlanGroupNode,
  type PlanNode,
  type PhaseNode,
  type ErrorNode,
  type PlanStatus,
} from '../model/treeModel';
import { phaseContextValue } from '../model/phaseActions';
import { planContextValue, PR_PARTIAL_STATUS, PR_STATUS } from '../model/planActions';
import { readPlanJournal, type JournalEntry } from '../journal';
import type { RepoTopology } from '../model/validator';
import {
  listPlans,
  listPlansAcrossRepos,
  listPhasePlans,
  type RepoListedPlan,
} from './planLister';
import type { Surface } from './surface';

/**
 * A sink the explorer notifies when the user clicks a plan root: the Chat_View
 * active plan follows the explorer selection. The sink is optional when no chat
 * surface is wired.
 */
export type SetActivePlan = (slug: string | undefined) => void;

/** A repository source for listing plan documents and their approval facts. */
export interface PlanRepoSource {
  repo: string;
  baitonDir: string;
  topology?: RepoTopology;
  isApproved(slug: string): Promise<boolean>;
  /** False for repos whose commands are not yet repo-aware. */
  actionable: boolean;
}

/** Optional multi-repository sources for the Plan Explorer. */
export interface PlanExplorerOptions {
  sources?: () => readonly PlanRepoSource[];
  /**
   * Consulted at most once per owning repo + slug + URL set per explorer
   * instance; refresh never awaits it. It is only called for plans whose
   * trimmed status is `pr`/`pr-partial` and whose recorded URL set is non-empty.
   */
  prsMerged?: PrsMergedChecker;
}

/** What the explorer asks the PR-state checker about one plan. */
export interface PrsMergedQuery {
  slug: string;
  /** The repository that owns the plan document; undefined for the primary (single-source) repo. */
  repo?: string;
  /** The recorded URL set: `recordedPrUrls(pr, prs)`, non-empty. */
  urls: readonly string[];
  /** For URLs recorded under `prs:`, the repo key they were recorded for; URLs absent here belong to the owning repo. */
  repoForUrl: ReadonlyMap<string, string>;
}

/** Resolves true only when every recorded request reads merged; may reject (treated as not merged). */
export type PrsMergedChecker = (query: PrsMergedQuery) => Promise<boolean>;

interface ResolvedPlanRepoSource {
  repo?: string;
  baitonDir: string;
  topology?: RepoTopology;
  isApproved(slug: string): Promise<boolean>;
  actionable: boolean;
}

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
 * One node in the tree: a group heading, a plan root, a phase child, or an
 * error child. Group and error nodes have no action target; plan and phase
 * nodes supply the slug/id arguments used by `baiton.*` command handlers.
 * Exported for that wiring and its {@link treeNodeTarget} helper.
 */
export type TreeNode =
  | { kind: 'group'; node: PlanGroupNode }
  | { kind: 'plan'; node: PlanNode }
  | { kind: 'phase'; node: PhaseNode }
  | { kind: 'error'; node: ErrorNode };

/**
 * The `[slug]` or `[slug, phaseId]` a `view/item/context` action forwards to the
 * matching `baiton.*` command from a clicked {@link TreeNode} (Req 5.2, 5.5,
 * 18.4). A plan root yields `[slug]` (Approve/Submit PR/Show PR), a phase
 * yields `[slug, phaseId]` (Plan/Execute/Review/Re-plan/Stop), and group or
 * error nodes have no action.
 */
export function treeNodeTarget(node: TreeNode): string[] | undefined {
  switch (node.kind) {
    case 'group':
      return undefined;
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

  /** The three roots are always present; their plans are recomputed on refresh (Req 6.3). */
  private groups: PlanGroupNode[] = buildPlanGroups([]);

  private readonly disposables: vscode.Disposable[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  /** Guards against overlapping async refreshes clobbering groups out of order. */
  private refreshSeq = 0;
  private sourceSnapshot: readonly ResolvedPlanRepoSource[] | undefined;
  /** Per-session PR completeness memo, keyed by owning repo + slug + URL set; holds in-flight checks too. */
  private readonly prsMergedMemo = new Map<string, { merged?: boolean }>();
  /** Plans (repo + slug) whose PR check failure has already been logged this session. */
  private readonly prsMergedLogged = new Set<string>();
  private disposed = false;

  /**
   * @param baitonDir     absolute `.baiton/` directory; both document roots are scanned under it.
   * @param planStore    supplies each plan's approval fact (Req 2.4).
   * @param surface      the shared notification surface for open failures (Req 2.7).
   * @param restricted   whether the workspace is in Restricted Mode; sets the
   *                     `baiton.restricted` context key the inline-action
   *                     `when` clauses negate to hide actions (Req 5.6, 5.7).
   * @param setActivePlan sink notified on a root click; optional when no chat surface is wired.
   * @param options      optional repository sources for multi-repository listings.
   */
  constructor(
    private readonly baitonDir: string,
    private readonly planStore: PlanStore,
    private readonly surface: Surface,
    private readonly restricted: boolean,
    private readonly setActivePlan?: SetActivePlan,
    private readonly options: PlanExplorerOptions = {},
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
      vscode.commands.registerCommand(OPEN_PLAN_COMMAND, (slug: string, repo?: string) =>
        this.openPlan(slug, repo),
      ),
    );

    // Each existing source is watched; a repo whose .baiton appears later is
    // picked up after reload. All events share one coalesced refresh.
    for (const source of this.sources()) {
      const pattern = new vscode.RelativePattern(source.baitonDir, '{plans,specs}/**');
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      watcher.onDidCreate(() => this.scheduleRefresh(), undefined, this.disposables);
      watcher.onDidChange(() => this.scheduleRefresh(), undefined, this.disposables);
      watcher.onDidDelete(() => this.scheduleRefresh(), undefined, this.disposables);
      this.disposables.push(watcher);
    }

    void this.refresh();
    return this;
  }

  /** Dispose the watcher, the command, and any pending debounce timer. */
  public dispose(): void {
    this.disposed = true;
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
      // The roots are always Active, Pending, Completed, even before refresh.
      return this.groups.map((node) => ({ kind: 'group', node }) as const);
    }
    if (element.kind === 'group') {
      // The lister's ascending-slug order is preserved inside each group.
      return element.node.plans.map((node) => ({ kind: 'plan', node }) as const);
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
      case 'group':
        return this.groupItem(element.node);
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
    const sources = this.sources();
    const showRepoLabels = this.showRepoLabels;
    const multiSource = showRepoLabels;
    const listed = multiSource
      ? await listPlansAcrossRepos(sources.map((source) => ({
        repo: source.repo as string,
        baitonDir: source.baitonDir,
        topology: source.topology,
      })))
      : await listPlans(this.baitonDir);
    const inputs = await Promise.all(
      listed.map(async (entry) => {
        const repoEntry = multiSource ? entry as RepoListedPlan : undefined;
        const source = multiSource
          ? sources.find((candidate) => candidate.repo === repoEntry?.repo) ?? sources[0]
          : sources[0];
        const ownerBaitonDir = repoEntry?.baitonDir ?? this.baitonDir;
        return {
          slug: entry.slug,
          raw: entry.raw,
          readError: entry.readError,
          // The approval fact comes from the owning source, never recomputed here.
          approved: await this.approvalFor(entry.slug, source),
          prsMerged: this.prsMergedFor(
            entry.slug,
            source.repo,
            entry.readError === undefined ? entry.raw : undefined,
          ),
          // Journals and phase plans are always read from the owning repository.
          sessions: sessionSet(readPlanJournal(ownerBaitonDir, entry.slug)),
          plans: await listPhasePlans(ownerBaitonDir, entry.slug),
          ...(showRepoLabels && source.repo !== undefined ? { repo: source.repo } : {}),
          topology: source.topology,
          actionable: source.actionable,
        };
      }),
    );
    if (seq !== this.refreshSeq) {
      // A newer refresh superseded this one while we awaited; drop this result.
      return;
    }
    this.groups = buildPlanGroups(buildPlanTree(inputs));
    this.emitter.fire(undefined);
  }

  /** Derive merged PR completeness without waiting for network or CLI work. */
  private prsMergedFor(slug: string, repo: string | undefined, raw: string | undefined): boolean {
    const checker = this.options.prsMerged;
    if (checker === undefined || raw === undefined) return false;

    let frontmatter: Map<string, string>;
    try {
      frontmatter = parsePlan(raw).frontmatter;
    } catch {
      return false;
    }
    const status = frontmatter.get('status')?.trim();
    if (status !== PR_STATUS && status !== PR_PARTIAL_STATUS) return false;

    const prs = frontmatter.get('prs');
    const urls = recordedPrUrls(frontmatter.get('pr'), prs);
    if (urls.length === 0) return false;

    const key = [repo ?? '', slug, ...urls].join('\u0000');
    const existing = this.prsMergedMemo.get(key);
    if (existing !== undefined) return existing.merged === true;

    const repoForUrl = new Map([...parsePrsValue(prs)].map(([name, url]) => [url.trim(), name]));
    const entry: { merged?: boolean } = {};
    this.prsMergedMemo.set(key, entry);

    let check: Promise<boolean>;
    try {
      check = Promise.resolve(checker({
        slug,
        ...(repo !== undefined ? { repo } : {}),
        urls,
        repoForUrl,
      }));
    } catch (e) {
      check = Promise.reject(e);
    }
    void check.then(
      (merged) => {
        entry.merged = merged === true;
        if (entry.merged && !this.disposed) void this.refresh();
      },
      (e: unknown) => {
        entry.merged = false;
        this.logPrsMergedFailure(slug, repo, e);
      },
    );
    return false;
  }

  /** Log a failed PR lookup once per plan without raising a notification. */
  private logPrsMergedFailure(slug: string, repo: string | undefined, e: unknown): void {
    const id = `${repo ?? ''}\u0000${slug}`;
    if (this.prsMergedLogged.has(id) || this.disposed) return;
    this.prsMergedLogged.add(id);
    try {
      this.surface.log(
        `Baiton: could not read PR state for plan "${slug}"${repo === undefined ? '' : ` in ${repo}`}: ${describe(e)}.`,
      );
    } catch {
      // Logging must never escape.
    }
  }

  /** The source's approval fact for a plan, treating a probe failure as unapproved. */
  private async approvalFor(slug: string, source: ResolvedPlanRepoSource): Promise<boolean> {
    try {
      return await source.isApproved(slug);
    } catch {
      return false;
    }
  }

  /** Configured sources, or the legacy primary-repository source. */
  private sources(): readonly ResolvedPlanRepoSource[] {
    const configured = this.options.sources?.();
    if (configured !== undefined && configured.length > 0) {
      this.sourceSnapshot = configured;
      return this.sourceSnapshot;
    }
    this.sourceSnapshot = [{
      baitonDir: this.baitonDir,
      isApproved: (slug) => this.planStore.isApproved(slug),
      actionable: true,
    }];
    return this.sourceSnapshot;
  }

  private get showRepoLabels(): boolean {
    return (this.sourceSnapshot ?? this.sources()).length > 1;
  }

  // --- TreeItem mapping ----------------------------------------------------

  /** A stable, action-free group heading with its plan count. */
  private groupItem(node: PlanGroupNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.label,
      node.kind === 'completed'
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.Expanded,
    );
    item.id = node.contextValue;
    item.contextValue = node.contextValue;
    item.description = String(node.plans.length);
    const icon = node.kind === 'active'
      ? 'play-circle'
      : node.kind === 'pending'
        ? 'circle-large-outline'
        : 'pass';
    item.iconPath = new vscode.ThemeIcon(icon);
    return item;
  }

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
      arguments: node.repo === undefined ? [node.slug] : [node.slug, node.repo],
    };
    if (node.repo !== undefined) {
      item.id = `${node.repo}:${node.slug}`;
    }
    return item;
  }

  /** The `<status> · approved · invalid` description shown beside a plan root. */
  private planDescription(node: PlanNode): string {
    const parts: string[] = [];
    if (node.repo !== undefined) {
      parts.push(node.repo);
    }
    parts.push(statusLabel(node.status));
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
      ...(node.repo !== undefined ? [`Repo: ${node.repo}`] : []),
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
    const phaseDescription = node.blocked ? `${node.state} · blocked` : node.state;
    item.description = node.repo === undefined
      ? phaseDescription
      : `${phaseDescription} · ${node.repo}`;
    // `baiton.phase` plus one token per legal action (Req 4.1); the
    // `view/item/context` `when` clauses in `package.json` match on those
    // tokens with `\b<action>\b` so the tree and the menu cannot disagree.
    item.contextValue = phaseContextValue(node.actions);
    item.iconPath = new vscode.ThemeIcon(node.blocked ? 'circle-slash' : 'circle-outline');
    item.tooltip = `${node.id} ${node.title}\nState: ${node.state}\nBlocked: ${node.blocked ? 'yes' : 'no'}` +
      (node.repo !== undefined ? `\nRepo: ${node.repo}` : '');
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
  private async openPlan(slug: string, repo?: string): Promise<void> {
    const sources = this.sources();
    const source = sources.find((candidate) => candidate.repo === repo) ??
      sources.find((candidate) => candidate.baitonDir === this.baitonDir) ?? {
        baitonDir: this.baitonDir,
        isApproved: (name: string) => this.planStore.isApproved(name),
        actionable: true,
      };
    const documentPath = resolveDocument(source.baitonDir, slug).documentPath;
    try {
      const doc = await vscode.workspace.openTextDocument(documentPath);
      await vscode.window.showTextDocument(doc, { preview: false });
    } catch (e) {
      this.surface.error(
        `Baiton: could not open plan "${slug}"${repo === undefined ? '' : ` in ${repo}`}: ${describe(e)}.`,
      );
      return; // Leave the active plan unchanged (Req 2.7).
    }
    if (source.actionable) {
      this.setActivePlan?.(slug);
    }
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
      // JournalEntry.phaseId is a persisted field name.
      sessions.add(entry.phaseId); // legacy journal field name
    }
  }
  return sessions;
}

/** A short, safe description of a thrown value for a user-facing message. */
function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
