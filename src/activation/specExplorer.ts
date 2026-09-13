/**
 * The Spec_Explorer tree provider (task 10.1; design "SpecExplorer
 * TreeDataProvider", "SpecExplorer inline actions", "SpecExplorer refresh";
 * Requirements 2, 3, 4, 5, 6, 18.2, 18.4).
 *
 * This is the thin `vscode` glue over the host-free tree model. On each refresh
 * it:
 *   1. runs {@link listSpecs} — the only new `fs` reach — to read each present
 *      `.baiton/specs/<slug>/spec.md` in ascending slug order (Req 2.1, 6.5);
 *   2. obtains each spec's approval fact from the {@link SpecStore} (never
 *      recomputed here, Req 2.4);
 *   3. builds the ordered nodes with {@link buildSpecTree}, reusing the pure
 *      `parseSpec`/`validateSpec`/`isBlocked` cores (Req 18.1);
 *   4. maps each `SpecNode`/`TodoNode`/`ErrorNode` to a `TreeItem`.
 *
 * A `FileSystemWatcher` over `.baiton/specs/**` (create/change/delete) drives a
 * ~500 ms debounced/coalescing refresh that re-derives everything from disk
 * with no pre-event cache: one root per present `spec.md`, dropping roots for
 * removed files (Req 6.1–6.6).
 *
 * Click-to-open reveals a spec's `spec.md` and sets it as the Chat_View active
 * spec through an injected sink; when `spec.md` cannot be opened, an error is
 * surfaced and the active spec is left unchanged (Req 2.6, 2.7). Inline actions
 * are attached via `contextValue`s and invoke the existing `baiton.*` commands
 * with the CodeLens argument order; the `view/item/context` `when` clauses in
 * `package.json` (task 14.1) hide them under Restricted Mode (Req 5, 5.6, 5.7).
 */
import * as vscode from 'vscode';
import * as path from 'path';
import type { SpecStore } from '../engine';
import {
  buildSpecTree,
  type SpecNode,
  type TodoNode,
  type ErrorNode,
  type SpecStatus,
} from '../model/treeModel';
import { todoContextValue } from '../model/todoActions';
import { specContextValue } from '../model/specActions';
import { parseJournal, type JournalEntry } from '../journal';
import { listSpecs } from './specLister';
import type { Surface } from './surface';

/**
 * A sink the explorer notifies when the user clicks a spec root: the Chat_View
 * active spec follows the explorer selection (Req 2.6, design "ChatController").
 * Wired to the {@link ChatController} in task 12.1; supplied as `undefined`
 * until then so the provider stays usable without the chat surface.
 */
export type SetActiveSpec = (slug: string | undefined) => void;

/** The command id the tree item click invokes to open a spec's `spec.md`. */
const OPEN_SPEC_COMMAND = 'baiton.specExplorer.openSpec';

/** The debounce window for coalescing filesystem events into one refresh (Req 6.2). */
const REFRESH_DEBOUNCE_MS = 500;

/**
 * The `contextValue`s the `view/item/context` menu contributions match on to
 * surface the inline actions (design "SpecExplorer inline actions"). A todo
 * node's contextValue is `baiton.todo` plus one token per legal action (built
 * by {@link todoContextValue}); a valid spec root's is `baiton.spec` plus one
 * token per legal action (built by {@link specContextValue}), so it offers
 * Approve, Submit PR or Show PR only when that action is legal. An invalid or
 * unreadable root keeps the fixed error context value below and offers none.
 */
const CONTEXT_ERROR = 'baiton.specError';

/**
 * One node in the tree: a spec root, a todo child, or an error child. This is
 * the element VS Code hands the `view/item/context` command handlers, so the
 * inline-action wiring (task 14.2) reads `node.slug`/`node.id` off it to invoke
 * `baiton.*` with the CodeLens argument order (design "SpecExplorer inline
 * actions"). Exported for that wiring and its {@link treeNodeTarget} helper.
 */
export type TreeNode =
  | { kind: 'spec'; node: SpecNode }
  | { kind: 'todo'; node: TodoNode }
  | { kind: 'error'; node: ErrorNode };

/**
 * The `[slug]` or `[slug, todoId]` a `view/item/context` action forwards to the
 * matching `baiton.*` command from a clicked {@link TreeNode} (Req 5.2, 5.5,
 * 18.4). A spec root yields `[slug]` (Approve/Submit PR/Show PR); a todo yields `[slug, todoId]`
 * (Plan/Execute/Review/Re-plan/Stop); an error child has no action.
 */
export function treeNodeTarget(node: TreeNode): string[] | undefined {
  switch (node.kind) {
    case 'spec':
      return [node.node.slug];
    case 'todo':
      return [node.node.slug, node.node.id];
    case 'error':
      return undefined;
  }
}

/**
 * The Spec_Explorer {@link vscode.TreeDataProvider}. Construct it, register it
 * as a tree data provider, register the open-spec command it emits, and start
 * its watcher; dispose the returned {@link SpecExplorer.dispose} on teardown.
 */
export class SpecExplorer
  implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable
{
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
  /** Fired to tell VS Code to re-query the tree (Req 6.1). */
  public readonly onDidChangeTreeData = this.emitter.event;

  /** The current roots, recomputed from disk on each refresh (no cache, Req 6.3). */
  private roots: SpecNode[] = [];

  private readonly disposables: vscode.Disposable[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  /** Guards against overlapping async refreshes clobbering `roots` out of order. */
  private refreshSeq = 0;

  /**
   * @param specsDir     absolute `.baiton/specs/` directory to scan (Req 2.1).
   * @param specStore    supplies each spec's approval fact (Req 2.4).
   * @param surface      the shared notification surface for open failures (Req 2.7).
   * @param restricted   whether the workspace is in Restricted Mode; sets the
   *                     `baiton.restricted` context key the inline-action
   *                     `when` clauses negate to hide actions (Req 5.6, 5.7).
   * @param setActiveSpec sink notified on a root click; may be `undefined`
   *                      until the Chat_View lands (task 12.1).
   */
  constructor(
    private readonly specsDir: string,
    private readonly specStore: SpecStore,
    private readonly surface: Surface,
    private readonly restricted: boolean,
    private readonly setActiveSpec?: SetActiveSpec,
  ) {}

  /**
   * Register the open-spec command and a `FileSystemWatcher` over
   * `.baiton/specs/**`, then run the first refresh. Returns `this` so callers
   * can register it as a tree data provider and push it onto their
   * subscriptions.
   */
  public start(): this {
    // Publish the restricted-mode context key the inline-action `when` clauses
    // negate, so all actions hide under Restricted Mode and show otherwise
    // (Req 5.6, 5.7; design "SpecExplorer inline actions").
    void vscode.commands.executeCommand(
      'setContext',
      'baiton.restricted',
      this.restricted,
    );

    this.disposables.push(
      vscode.commands.registerCommand(OPEN_SPEC_COMMAND, (slug: string) =>
        this.openSpec(slug),
      ),
    );

    // The watcher fires on create/change/delete under the specs tree; each
    // event schedules a single coalesced refresh (Req 6.1, 6.2, 6.4).
    const pattern = new vscode.RelativePattern(this.specsDir, '**');
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
      // Roots: one per present spec, in the lister's ascending-slug order.
      return this.roots.map((node) => ({ kind: 'spec', node }));
    }
    if (element.kind === 'spec') {
      const children = element.node.children;
      if (children.kind === 'errors') {
        return children.errors.map((node) => ({ kind: 'error', node }));
      }
      return children.todos.map((node) => ({ kind: 'todo', node }));
    }
    // Todo and error nodes are leaves.
    return [];
  }

  public getTreeItem(element: TreeNode): vscode.TreeItem {
    switch (element.kind) {
      case 'spec':
        return this.specItem(element.node);
      case 'todo':
        return this.todoItem(element.node);
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
   * Re-derive the whole tree from disk (Req 6.3): list the specs, read each
   * spec's approval fact from the store, and build the nodes. A later refresh
   * that started after this one wins, so a slow earlier scan cannot overwrite a
   * fresher result.
   */
  private async refresh(): Promise<void> {
    const seq = ++this.refreshSeq;
    const listed = await listSpecs(this.specsDir);
    const inputs = await Promise.all(
      listed.map(async (spec) => ({
        slug: spec.slug,
        raw: spec.raw,
        readError: spec.readError,
        // The approval fact comes from the store, never recomputed here (Req 2.4).
        approved: await this.approvalFor(spec.slug),
        // Todo ids with a recorded Session_Id, from the spec's own journal
        // (Req 4.4); a missing `runs.jsonl` reads back as no entries.
        sessions: sessionSet(parseJournal(path.join(this.specsDir, spec.slug, 'runs.jsonl'))),
      })),
    );
    if (seq !== this.refreshSeq) {
      // A newer refresh superseded this one while we awaited; drop this result.
      return;
    }
    this.roots = buildSpecTree(inputs);
    this.emitter.fire(undefined);
  }

  /** The store's approval fact for a spec, treating a probe failure as unapproved. */
  private async approvalFor(slug: string): Promise<boolean> {
    try {
      return await this.specStore.isApproved(slug);
    } catch {
      return false;
    }
  }

  // --- TreeItem mapping ----------------------------------------------------

  /**
   * A spec root item: `<slug>` plus its status (or an unset indication), an
   * approved marker, and an invalid marker (Req 2.2, 2.3, 2.4, 2.5, 3.1).
   * Clicking it opens the spec's `spec.md` and sets it active (Req 2.6).
   */
  private specItem(node: SpecNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.slug,
      vscode.TreeItemCollapsibleState.Collapsed,
    );
    item.description = this.specDescription(node);
    // `baiton.spec` plus one token per legal action; the `view/item/context`
    // `when` clauses in `package.json` match those tokens with `\b<action>\b`
    // so the tree and the menu cannot disagree.
    item.contextValue = node.invalid ? CONTEXT_ERROR : specContextValue(node.actions);
    item.iconPath = new vscode.ThemeIcon(node.invalid ? 'warning' : 'file');
    item.tooltip = this.specTooltip(node);
    item.command = {
      command: OPEN_SPEC_COMMAND,
      title: 'Open Spec',
      arguments: [node.slug],
    };
    return item;
  }

  /** The `<status> · approved · invalid` description shown beside a spec root. */
  private specDescription(node: SpecNode): string {
    const parts: string[] = [statusLabel(node.status)];
    if (node.approved) {
      parts.push('approved');
    }
    if (node.invalid) {
      parts.push('invalid');
    }
    return parts.join(' · ');
  }

  /** A tooltip spelling out the spec's derived facts. */
  private specTooltip(node: SpecNode): string {
    const lines = [
      `Spec: ${node.slug}`,
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
   * A todo child item: `<id> <title>` with its state and, when derived-blocked,
   * a blocked marker (Req 4.1, 4.2, 4.3, 4.4, 4.5). Inline actions attach via
   * the `baiton.todo` context value (design "SpecExplorer inline actions").
   */
  private todoItem(node: TodoNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      `${node.id} ${node.title}`,
      vscode.TreeItemCollapsibleState.None,
    );
    item.description = node.blocked ? `${node.state} · blocked` : node.state;
    // `baiton.todo` plus one token per legal action (Req 4.1); the
    // `view/item/context` `when` clauses in `package.json` match on those
    // tokens with `\b<action>\b` so the tree and the menu cannot disagree.
    item.contextValue = todoContextValue(node.actions);
    item.iconPath = new vscode.ThemeIcon(node.blocked ? 'circle-slash' : 'circle-outline');
    item.tooltip = `${node.id} ${node.title}\nState: ${node.state}\nBlocked: ${node.blocked ? 'yes' : 'no'}`;
    return item;
  }

  /**
   * An error child item under an invalid or unreadable spec: the reason and the
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
   * Open a spec's `spec.md` and set it as the Chat_View active spec (Req 2.6).
   * When the file cannot be opened, surface an error and leave the active spec
   * unchanged (Req 2.7).
   */
  private async openSpec(slug: string): Promise<void> {
    const specPath = path.join(this.specsDir, slug, 'spec.md');
    try {
      const doc = await vscode.workspace.openTextDocument(specPath);
      await vscode.window.showTextDocument(doc, { preview: false });
    } catch (e) {
      this.surface.error(
        `Baiton: could not open spec "${slug}": ${describe(e)}.`,
      );
      return; // Leave the active spec unchanged (Req 2.7).
    }
    this.setActiveSpec?.(slug);
  }
}

/** The label for a spec's status: the set value, or an unset indication (Req 2.3). */
function statusLabel(status: SpecStatus): string {
  return status.kind === 'set' ? status.value : 'no status';
}

/**
 * The set of todo ids a parsed journal records a Session_Id for (Req 4.4). A
 * missing `runs.jsonl` parses back as an empty entry array, so this naturally
 * yields an empty set.
 */
function sessionSet(entries: JournalEntry[]): Set<string> {
  const sessions = new Set<string>();
  for (const entry of entries) {
    if (entry.sessionId !== undefined) {
      sessions.add(entry.todoId);
    }
  }
  return sessions;
}

/** A short, safe description of a thrown value for a user-facing message. */
function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
