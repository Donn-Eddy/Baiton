/**
 * Host-free tree model for the Runs view (`baiton.runsView`).
 *
 * `buildRunTree` turns the run manifests listed by `RunStore.list()` — plus the
 * optional fact of which stage is in flight right now — into the ordered nodes
 * the Runs view renders. It splits them into exactly two groups, Active and
 * Complete, and the split REUSES `isRunComplete` from the run store rather than
 * re-implementing it (a second copy of that rule would let the view and the
 * store disagree about when a run has ended).
 *
 * Labels, descriptions, tooltips and `contextValue`s are all derived here, once:
 * the tree items and the `view/item/context` `when` clauses in `package.json`
 * read the same `baiton.run.<group> <action>…` tokens `runContextValue`
 * produces, so the buttons a node offers and the actions `legalRunActions`
 * considers legal cannot drift apart.
 *
 * This module carries no `vscode` import and does no I/O, so it is directly
 * unit-testable without a host. Every function here is total: no input manifest
 * shape makes it throw.
 */
import type { RunMode } from './mode';
import type { RunManifest, RunStage, RunState } from '../engine/runStore';
import { isRunComplete } from '../engine/runStore';

/**
 * A user-facing action on a run: `cancel` disposes the terminal of the stage in
 * flight, `viewDiff` opens the run branch's diff against its base, and `merge`
 * lands the branch.
 */
export type RunAction = 'cancel' | 'viewDiff' | 'merge';

/** All run actions, in the deterministic order `legalRunActions` emits them. */
export const RUN_ACTIONS: readonly RunAction[] = ['cancel', 'viewDiff', 'merge'] as const;

/** Which of the tree's two top-level groups a node belongs to. */
export type RunGroupKind = 'active' | 'complete';

/** Max chars of a statement shown on a node label; the cut char becomes an ellipsis. */
export const RUN_LABEL_MAX_CHARS = 80;

/** Max chars of a failure message quoted in an outcome label. */
export const RUN_OUTCOME_MESSAGE_MAX_CHARS = 60;

/** The stage in flight for the run the pipeline is driving right now. */
export interface LiveRunStageFact {
  runId: string;
  stage: RunStage;
  attempt: number;
}

/** One run's node under the Active or Complete group. */
export interface RunNode {
  /** The run id, which is also its directory name under `.baiton/runs/`. */
  runId: string;
  /** The mode the run runs as; never 'spec'. */
  mode: RunMode;
  /** The confirmed work statement, whitespace-collapsed (NOT truncated). */
  statement: string;
  /** The node's label: `statement` truncated to {@link RUN_LABEL_MAX_CHARS}. */
  label: string;
  /** The run's own branch (`manifest.branch`). */
  branch: string;
  /** The branch the run was started from (`manifest.baseBranch`). */
  baseBranch: string;
  /** The manifest state, verbatim. */
  state: RunState;
  /** Equals `isRunComplete(state)`; decides the group the node lands in. */
  complete: boolean;
  /** The stage in flight for this run, when one is; undefined otherwise. */
  stage?: RunStage;
  /** That stage's 1-based attempt number; present exactly when `stage` is. */
  attempt?: number;
  /** The `<mode> · <stage|state|outcome>` line shown beside the label. */
  description: string;
  /** The human outcome text; present exactly when `complete`. */
  outcomeLabel?: string;
  /** A multi-line tooltip spelling out the run's derived facts. */
  tooltip: string;
  /** Whether the run has a worktree on file (false for an investigate run). */
  hasWorktree: boolean;
  /** The repository-relative worktree dir, when the manifest records one. */
  worktreeDir?: string;
  /** The legal actions; equals `legalRunActions({...})` over this node's facts. */
  actions: RunAction[];
  /** Equals `runContextValue(groupKind, actions)`. */
  contextValue: string;
}

/** One of the tree's two top-level groups. */
export interface RunGroupNode {
  /** Which group this is. */
  kind: RunGroupKind;
  /** 'Active' or 'Complete'. */
  label: string;
  /** 'baiton.runGroup.active' / 'baiton.runGroup.complete'. */
  contextValue: string;
  /** The group's runs, in input order. */
  runs: RunNode[];
}

/**
 * Collapse whitespace and trim, then append an ellipsis past `max` — the shape
 * `oneLine` has in `src/orchestrator/autoMode.ts`.
 */
function oneLine(text: string, max: number): string {
  const collapsed = text.trim().replace(/\s+/g, ' ');
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max)}…`;
}

/**
 * A statement reduced to a single line: whitespace collapsed and trimmed, never
 * truncated. Blank input yields `''`.
 */
export function runStatementText(statement: string): string {
  return statement.replace(/\s+/g, ' ').trim();
}

/**
 * A statement as a tree item label: one-lined, then truncated to `max` chars
 * total with the last char an ellipsis — the same reduction `deriveTitle` in
 * `src/orchestrator/sessionStore.ts` applies to a session title. A statement
 * that one-lines to empty yields `'(no statement)'` so a node is never
 * label-less and so stays clickable.
 */
export function runStatementLabel(statement: string, max = RUN_LABEL_MAX_CHARS): string {
  const flat = runStatementText(statement);
  if (flat.length === 0) {
    return '(no statement)';
  }
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The stage in flight for one run, or `undefined` when none is.
 *
 * The live fact is the ONLY source of a running stage: the manifest state alone
 * is not enough. An `investigate` run stays `confirmed` while its single stage
 * runs (see `driveInvestigate` in `src/engine/runPipeline.ts`), and `planned` /
 * `executed` are active-but-idle states with no terminal behind them. A live
 * fact naming a run that has already completed is stale and ignored.
 */
export function runStageFor(
  manifest: RunManifest,
  live?: LiveRunStageFact,
): { stage: RunStage; attempt: number } | undefined {
  if (live !== undefined && live.runId === manifest.id && !isRunComplete(manifest.state)) {
    return { stage: live.stage, attempt: live.attempt };
  }
  return undefined;
}

/**
 * The human outcome text for a complete run. Asked for an active state it
 * simply returns that state, so no caller can produce an empty label.
 */
export function runOutcomeLabel(manifest: RunManifest): string {
  switch (manifest.state) {
    case 'merged':
      return 'merged';
    case 'answered':
      return 'answered';
    case 'cancelled':
      return 'cancelled';
    case 'done':
      return manifest.outcome?.kind === 'verdict' && manifest.outcome.verdict === 'pass'
        ? 'review passed'
        : 'done';
    case 'failed': {
      const outcome = manifest.outcome;
      if (outcome?.kind === 'failed') {
        return `failed: ${oneLine(outcome.message, RUN_OUTCOME_MESSAGE_MAX_CHARS)}`;
      }
      if (outcome?.kind === 'verdict' && outcome.verdict === 'findings') {
        return 'review reported findings';
      }
      return 'failed';
    }
    default:
      return manifest.state;
  }
}

/** The derived facts a run's legal actions are computed from. */
export interface RunActionInput {
  /** The manifest state. */
  state: RunState;
  /** Whether the manifest records a worktree dir. */
  hasWorktree: boolean;
  /** Whether a stage is in flight for this run right now. */
  stageRunning: boolean;
}

/**
 * The legal actions for a run, in the deterministic order cancel, viewDiff,
 * merge. Rules:
 *
 *   - `cancel` while the run is active AND a stage is in flight: an
 *     active-but-idle run (`confirmed` / `planned` / `executed` with no live
 *     stage) offers nothing, because there is no terminal to dispose;
 *   - `viewDiff` on a complete run that still has a worktree and is not
 *     `merged`: merging removes the worktree and the branch (`runWorktree`), and
 *     an `investigate` run never had a `worktreeDir`, so neither offers a diff;
 *   - `merge` only on a `done` run with a worktree — a run whose review passed.
 *     `failed` and `cancelled` runs keep their branch and offer View diff alone.
 */
export function legalRunActions(input: RunActionInput): RunAction[] {
  const actions: RunAction[] = [];
  const complete = isRunComplete(input.state);
  if (!complete && input.stageRunning) {
    actions.push('cancel');
  }
  if (complete && input.hasWorktree && input.state !== 'merged') {
    actions.push('viewDiff');
  }
  if (input.state === 'done' && input.hasWorktree) {
    actions.push('merge');
  }
  return actions;
}

/**
 * Builds the tree item `contextValue` for a run: `baiton.run.<group>` followed
 * by one space-separated token per legal action, e.g.
 * `baiton.run.complete viewDiff merge`. This is exactly the token shape
 * `specContextValue` and `todoContextValue` produce, so the
 * `view/item/context` `when` clauses in `package.json` match on them with
 * `viewItem =~ /\bcancel\b/`, `/\bviewDiff\b/` and `/\bmerge\b/`.
 */
export function runContextValue(kind: RunGroupKind, actions: readonly RunAction[]): string {
  return `baiton.run.${kind}` + actions.map((a) => ' ' + a).join('');
}

/** The newline-joined tooltip lines for one run. */
function buildTooltip(
  manifest: RunManifest,
  stage: { stage: RunStage; attempt: number } | undefined,
): string {
  const statement = runStatementText(manifest.statement);
  const lines = [`${manifest.mode} run ${manifest.id}`];
  if (statement.length > 0) {
    lines.push(statement);
  }
  lines.push(`Branch: ${manifest.branch} (from ${manifest.baseBranch})`);
  lines.push(`State: ${manifest.state}`);
  if (stage !== undefined) {
    lines.push(`Stage: ${stage.stage} (attempt ${stage.attempt})`);
  }
  if (isRunComplete(manifest.state)) {
    lines.push(`Outcome: ${runOutcomeLabel(manifest)}`);
  }
  return lines.join('\n');
}

/**
 * Builds one run's node from its manifest and the optional live-stage fact.
 * Optional fields are spread conditionally, the way `runStore.ts` spreads its
 * own, so an absent fact leaves the key absent rather than `undefined`.
 */
export function buildRunNode(manifest: RunManifest, live?: LiveRunStageFact): RunNode {
  const complete = isRunComplete(manifest.state);
  const stage = runStageFor(manifest, live);
  const hasWorktree = manifest.worktreeDir !== undefined;
  const actions = legalRunActions({
    state: manifest.state,
    hasWorktree,
    stageRunning: stage !== undefined,
  });
  const outcomeLabel = complete ? runOutcomeLabel(manifest) : undefined;

  const description =
    stage !== undefined
      ? `${manifest.mode} · ${stage.stage}` +
        (stage.attempt > 1 ? ` (attempt ${stage.attempt})` : '')
      : complete
        ? `${manifest.mode} · ${outcomeLabel as string}`
        : `${manifest.mode} · ${manifest.state}`;

  return {
    runId: manifest.id,
    mode: manifest.mode,
    statement: runStatementText(manifest.statement),
    label: runStatementLabel(manifest.statement),
    branch: manifest.branch,
    baseBranch: manifest.baseBranch,
    state: manifest.state,
    complete,
    ...(stage !== undefined ? { stage: stage.stage, attempt: stage.attempt } : {}),
    description,
    ...(outcomeLabel !== undefined ? { outcomeLabel } : {}),
    tooltip: buildTooltip(manifest, stage),
    hasWorktree,
    ...(manifest.worktreeDir !== undefined ? { worktreeDir: manifest.worktreeDir } : {}),
    actions,
    contextValue: runContextValue(complete ? 'complete' : 'active', actions),
  };
}

/**
 * Builds the Runs view's tree: EXACTLY two groups, Active first then Complete,
 * both always present even when empty, so the view never loses a heading.
 *
 * Input order is preserved inside each group and never re-sorted —
 * `RunStore.list()` already returns manifests newest first, exactly as
 * `buildSpecTree` leaves ordering to its lister. Never throws, for any manifest
 * shape.
 */
export function buildRunTree(
  manifests: readonly RunManifest[],
  live?: LiveRunStageFact,
): RunGroupNode[] {
  const active: RunNode[] = [];
  const done: RunNode[] = [];
  for (const manifest of manifests) {
    const node = buildRunNode(manifest, live);
    (node.complete ? done : active).push(node);
  }
  return [
    { kind: 'active', label: 'Active', contextValue: 'baiton.runGroup.active', runs: active },
    { kind: 'complete', label: 'Complete', contextValue: 'baiton.runGroup.complete', runs: done },
  ];
}
