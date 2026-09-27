# Plan T13

## Steps

1. Create src/model/runTreeModel.ts with the module doc and vocabulary

   New host-free module (NO `vscode` import, like every other file in src/model/). Open with a JSDoc block in the style of src/model/treeModel.ts: explain that `buildRunTree` turns the run manifests listed by `RunStore.list()` — plus the optional fact of which stage is in flight right now — into the ordered nodes the Runs view (`baiton.runsView`) renders, that the Active/Complete split reuses `isRunComplete` from the run store and never re-implements it, that labels/descriptions/tooltips and `contextValue`s are built here once so the tree and the `view/item/context` `when` clauses in package.json cannot disagree, and that the module is pure and never throws.

   Imports (type-only where possible):
   ```ts
   import type { RunMode } from './mode';
   import type { RunManifest, RunStage, RunState } from '../engine/runStore';
   import { isRunComplete } from '../engine/runStore';
   ```
   (`src/model/todoActions.ts` already imports from `../engine/transitions`, so a model -> engine import of a pure core is established practice; runStore imports only `../model/stage`, `../model/mode`, `../model/result`, `../schema` and `./resultFlow`, never the `src/model` barrel, so there is no import cycle.)

   Declare the vocabulary:
   ```ts
   export type RunAction = 'cancel' | 'viewDiff' | 'merge';
   export const RUN_ACTIONS: readonly RunAction[] = ['cancel', 'viewDiff', 'merge'] as const;
   export type RunGroupKind = 'active' | 'complete';
   /** Max chars of a statement shown on a node label; the cut char becomes an ellipsis. */
   export const RUN_LABEL_MAX_CHARS = 80;
   /** Max chars of a failure message quoted in an outcome label. */
   export const RUN_OUTCOME_MESSAGE_MAX_CHARS = 60;
   /** The stage in flight for the run the pipeline is driving right now. */
   export interface LiveRunStageFact { runId: string; stage: RunStage; attempt: number }
   ```

   Files: `src/model/runTreeModel.ts`

2. Add the node interfaces to src/model/runTreeModel.ts

   Two exported interfaces, each field carrying a one-line JSDoc comment in the style of `TodoNode`/`SpecNode`:

   ```ts
   export interface RunNode {
     /** The run id, which is also its directory name under `.baiton/runs/`. */
     runId: string;
     /** The mode the run runs as; never 'spec'. */
     mode: RunMode;
     /** The confirmed work statement, whitespace-collapsed (NOT truncated). */
     statement: string;
     /** The node's label: `statement` truncated to RUN_LABEL_MAX_CHARS. */
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
   ```

   Files: `src/model/runTreeModel.ts`

3. Implement the derivation helpers in src/model/runTreeModel.ts

   All exported (the Runs-view glue and the tests use them directly), all total — no throws, no I/O:

   1. `export function runStatementText(statement: string): string` — `statement.replace(/\s+/g, ' ').trim()`; returns `''` for blank input.

   2. `export function runStatementLabel(statement: string, max = RUN_LABEL_MAX_CHARS): string` — one-lines via `runStatementText`, then, mirroring `deriveTitle` in src/orchestrator/sessionStore.ts, returns `flat.length > max ? flat.slice(0, max - 1) + '…' : flat`; when the one-lined statement is empty returns the literal `'(no statement)'` so a node is never label-less.

   3. `export function runStageFor(manifest: RunManifest, live?: LiveRunStageFact): { stage: RunStage; attempt: number } | undefined` — returns `{ stage: live.stage, attempt: live.attempt }` when `live !== undefined && live.runId === manifest.id && !isRunComplete(manifest.state)`, else `undefined`. The live fact is the ONLY source of a running stage: the state alone is not enough, because an `investigate` run stays `confirmed` while its stage runs (see the `driveInvestigate` comment in src/engine/runPipeline.ts) and `planned`/`executed` are active-but-idle. Document that.

   4. `export function runOutcomeLabel(manifest: RunManifest): string` — switch on `manifest.state`:
      - `'merged'` -> `'merged'`;
      - `'answered'` -> `'answered'`;
      - `'cancelled'` -> `'cancelled'`;
      - `'done'` -> `manifest.outcome?.kind === 'verdict' && manifest.outcome.verdict === 'pass' ? 'review passed' : 'done'`;
      - `'failed'` -> `outcome.kind === 'failed'` gives `` `failed: ${oneLine(outcome.message, RUN_OUTCOME_MESSAGE_MAX_CHARS)}` ``; `outcome.kind === 'verdict' && verdict === 'findings'` gives `'review reported findings'`; anything else (including a missing outcome) gives `'failed'`;
      - default (an active state, asked for defensively) -> `manifest.state`.
      Use a private `oneLine(text, max)` copied in shape from src/orchestrator/autoMode.ts (collapse whitespace, trim, append `'…'` past `max`).

   5. `export interface RunActionInput { state: RunState; hasWorktree: boolean; stageRunning: boolean }` and `export function legalRunActions(input: RunActionInput): RunAction[]` — rules, documented in the JSDoc, in the deterministic order cancel, viewDiff, merge:
      - `cancel` when `!isRunComplete(state) && stageRunning` — the OVERVIEW's "Cancel while a stage is running"; an active-but-idle run (`confirmed`/`planned`/`executed` with no live stage) offers nothing, because there is no terminal to dispose;
      - `viewDiff` when `isRunComplete(state) && hasWorktree && state !== 'merged'` — a merged run's worktree and branch are gone (`runWorktree` removes them), and an `investigate` run has no `worktreeDir` at all, so neither offers a diff;
      - `merge` when `state === 'done' && hasWorktree` — only a run whose review passed is offered for merge; `failed` and `cancelled` runs keep their branch and offer View diff alone.

   6. `export function runContextValue(kind: RunGroupKind, actions: readonly RunAction[]): string` — `` `baiton.run.${kind}` `` plus `actions.map((a) => ' ' + a).join('')`, exactly the space-separated token shape `specContextValue`/`todoContextValue` produce, so the `view/item/context` `when` clauses can match `viewItem =~ /\bcancel\b/`, `/\bviewDiff\b/`, `/\bmerge\b/`. Document that pairing in the JSDoc.

   7. A private `buildTooltip(manifest, stage)` producing the newline-joined lines: `` `${manifest.mode} run ${manifest.id}` ``, the full one-lined statement (skipped when empty), `` `Branch: ${manifest.branch} (from ${manifest.baseBranch})` ``, `` `State: ${manifest.state}` ``, `` `Stage: ${stage.stage} (attempt ${stage.attempt})` `` when a stage is live, and `` `Outcome: ${runOutcomeLabel(manifest)}` `` when the run is complete.

   Files: `src/model/runTreeModel.ts`

4. Implement buildRunNode and buildRunTree in src/model/runTreeModel.ts

   ```ts
   export function buildRunNode(manifest: RunManifest, live?: LiveRunStageFact): RunNode
   export function buildRunTree(manifests: readonly RunManifest[], live?: LiveRunStageFact): RunGroupNode[]
   ```

   `buildRunNode`:
   - `const complete = isRunComplete(manifest.state);`
   - `const stage = runStageFor(manifest, live);`
   - `const hasWorktree = manifest.worktreeDir !== undefined;`
   - `const actions = legalRunActions({ state: manifest.state, hasWorktree, stageRunning: stage !== undefined });`
   - description: when `stage` is present -> `` `${manifest.mode} · ${stage.stage}` `` plus `` ` (attempt ${stage.attempt})` `` when `stage.attempt > 1`; else when `complete` -> `` `${manifest.mode} · ${runOutcomeLabel(manifest)}` ``; else -> `` `${manifest.mode} · ${manifest.state}` ``.
   - `outcomeLabel` set only when `complete` (spread it conditionally, the way runStore.ts spreads its optional fields, so the key is absent rather than `undefined`; same for `stage`, `attempt`, `worktreeDir`).
   - `contextValue: runContextValue(complete ? 'complete' : 'active', actions)`.

   `buildRunTree` returns EXACTLY two groups, always both present even when empty, Active first:
   ```ts
   const active: RunNode[] = []; const done: RunNode[] = [];
   for (const manifest of manifests) {
     const node = buildRunNode(manifest, live);
     (node.complete ? done : active).push(node);
   }
   return [
     { kind: 'active', label: 'Active', contextValue: 'baiton.runGroup.active', runs: active },
     { kind: 'complete', label: 'Complete', contextValue: 'baiton.runGroup.complete', runs: done },
   ];
   ```
   Document that input order is preserved inside each group and never re-sorted — `RunStore.list()` already returns manifests newest first, exactly as `buildSpecTree` leaves ordering to its lister — and that the function never throws for any manifest shape.

   Files: `src/model/runTreeModel.ts`

5. Export the module from the src/model barrel

   In src/model/index.ts append `export * from './runTreeModel';` after the existing `export * from './treeModel';` line (keep it beside the other tree/action modules; the surrounding order is result, todoState, stage, mode, role, managedKey, parser, hash, validator, writer, treeModel, todoActions, specActions). Confirm with `npm run compile` that no exported name collides with the barrel's existing surface — `RunMode` comes from './mode' and must NOT be re-declared here; the new names are RunAction, RUN_ACTIONS, RunGroupKind, RunNode, RunGroupNode, LiveRunStageFact, RunActionInput, buildRunNode, buildRunTree, runStageFor, runOutcomeLabel, runStatementText, runStatementLabel, legalRunActions, runContextValue, RUN_LABEL_MAX_CHARS, RUN_OUTCOME_MESSAGE_MAX_CHARS.

   Files: `src/model/index.ts`

6. Write test/runRreeModel tests at test/runTreeModel.test.ts

   Plain mocha + `assert` (`import * as assert from 'assert';`), no fs and no git — the module is pure. Import the model from `'../src/model/runTreeModel'` and `isRunComplete`, `RUN_STATES`, `type RunManifest` from `'../src/engine/runStore'`. Add a local builder:
   ```ts
   function manifest(overrides: Partial<RunManifest> = {}): RunManifest {
     return {
       version: 1, id: 'bug-20260926-120000-a1b2', mode: 'bug', composerMode: 'bug',
       explicitMode: false, statement: 'Fix the crash on empty input', files: ['src/a.ts'],
       baseBranch: 'main', baseHead: 'abc1234', branch: 'baiton/bug/bug-20260926-120000-a1b2',
       worktreeDir: '.baiton/worktrees/bug-20260926-120000-a1b2', state: 'planning',
       attempts: { plan: 1, execute: 0, review: 0, investigate: 0 },
       createdAt: '2026-09-26T12:00:00.000Z', updatedAt: '2026-09-26T12:00:00.000Z',
       ...overrides,
     };
   }
   ```
   Cases, grouped in nested `describe`s (`buildRunTree`, `descriptions and labels`, `runOutcomeLabel`, `legalRunActions and contextValue`, `runStageFor`):
   1. `buildRunTree([])` returns exactly two groups, Active then Complete, both empty, with contextValues `baiton.runGroup.active`/`baiton.runGroup.complete`.
   2. Active/Complete split agrees with `isRunComplete` for EVERY state in `RUN_STATES` (loop: build one manifest per state, assert the node lands in the group `isRunComplete(state)` predicts and that `node.complete === isRunComplete(state)`).
   3. Input order is preserved inside each group (three runs, mixed states).
   4. A node carries mode, statement, branch, baseBranch, state and worktreeDir from the manifest verbatim.
   5. `label` one-lines a multi-line statement and truncates past `RUN_LABEL_MAX_CHARS` with a trailing `'…'` of exactly `RUN_LABEL_MAX_CHARS` length; a blank statement yields `'(no statement)'`; `statement` itself stays untruncated.
   6. Active description with a live stage: `'bug · execute'` for attempt 1 and `'bug · execute (attempt 2)'` for attempt 2.
   7. Active description without a live stage falls back to `'<mode> · <state>'` (e.g. a `planned` run, and a `confirmed` investigate run with no live fact).
   8. `runStageFor` returns the live stage only when `live.runId` matches the manifest id, and returns undefined for a complete run even when a live fact names it.
   9. A `confirmed` investigate run WITH a matching live investigate fact reports `stage: 'investigate'` and description `'investigate · investigate'` — pins that the live fact, not the state, drives the stage.
   10. `runOutcomeLabel` per ending: `done` + verdict pass -> `'review passed'`; `done` with no outcome -> `'done'`; `failed` + `{kind:'failed',message}` -> `'failed: <message>'` with a long message one-lined and truncated with `'…'`; `failed` + verdict findings -> `'review reported findings'`; `cancelled` -> `'cancelled'`; `answered` -> `'answered'`; `merged` -> `'merged'`.
   11. `outcomeLabel` is present exactly on complete nodes (`assert.ok(!('outcomeLabel' in node))` for an active one) and the complete description is `'<mode> · <outcomeLabel>'`.
   12. `legalRunActions`: cancel only when active AND a stage is running; no cancel for an active-but-idle run; no cancel for a complete run even with a stale live fact.
   13. `legalRunActions`: `done` + worktree -> `['viewDiff','merge']`; `failed`/`cancelled` + worktree -> `['viewDiff']`; `merged` -> `[]`; `answered` with no `worktreeDir` -> `[]` (the investigate case); complete + worktree order is always viewDiff before merge.
   14. `runContextValue` shape: `'baiton.run.active cancel'`, `'baiton.run.complete viewDiff merge'`, and `'baiton.run.complete'` with no actions; assert each token matches its `\b<token>\b` regex (`/\bcancel\b/`, `/\bviewDiff\b/`, `/\bmerge\b/`) and that an active node's contextValue does NOT match `/\bmerge\b/`.
   15. `node.contextValue` equals `runContextValue(group, node.actions)` for a sampled node of each group — the tree and the helper cannot drift.
   16. Tooltip contains the mode and run id, the full statement, `Branch: … (from main)`, `State: …`, `Stage: execute (attempt 2)` when live, and `Outcome: review passed` when complete — and omits the Stage line when idle and the Outcome line when active.
   17. Totality: `buildRunTree` does not throw for a manifest with an empty `files` array, no `worktreeDir`, no `outcome` in a complete state, and a statement of only whitespace.

   Files: `test/runTreeModel.test.ts`

7. Verify

   Run `npm run compile`, `npm run lint`, `npx mocha test/runTreeModel.test.ts` and the full `npm test`. Do not modify any existing test file; `git status --porcelain` must show exactly `M src/model/index.ts`, `?? src/model/runTreeModel.ts`, `?? test/runTreeModel.test.ts`. Note in the summary the passing/pending counts and that they moved only by the new cases. Nothing in package.json, src/activation/ or any view glue is touched by this todo — the `baiton.runsView` contribution, the watcher and the commands come later; this todo delivers the pure model those will consume.

   Files: `src/model/runTreeModel.ts`, `src/model/index.ts`, `test/runTreeModel.test.ts`

## Risks

- Import direction: src/model/runTreeModel.ts imports RunManifest/RunStage/RunState/isRunComplete from src/engine/runStore.ts. That is model -> engine, which src/model/todoActions.ts already does (it imports ../engine/transitions), and runStore imports only ../model/stage, ../model/mode, ../model/result, ../schema and ./resultFlow — never the src/model barrel — so adding the export to src/model/index.ts creates no cycle. If a lint rule or the compiler objects, keep the value import (isRunComplete) and re-check rather than duplicating the predicate: re-implementing the Active/Complete rule here would let the view and the store disagree.
- Name collisions in the src/model barrel: the barrel already re-exports RunMode (from ./mode) and, transitively in tests, the engine's RunOutcome/RunStage names live in src/engine/index.ts. Keep the new names exactly as listed (RunAction, RunNode, RunGroupNode, RunActionInput, …), do not re-export RunManifest or RunStage from this module, and let `npm run compile` be the check.
- The action rules are a decision this plan fixes, not a quotation of the spec: cancel only while a stage is live; viewDiff on any complete run that still has a worktree and is not merged; merge only on a `done` run. If the later Runs-view todo needs merge on a `failed` run as well, that is a one-line change in legalRunActions plus its test — keep the rule in this one function so the package.json `when` clauses never encode it.
- An `investigate` run stays in state `confirmed` while its single stage runs (see driveInvestigate in src/engine/runPipeline.ts), so deriving the running stage from the state would mislabel it and would wrongly deny Cancel. The live-stage fact must be the only source, and the test for it (case 9) is what pins that.
- `statement` is user/model text: it may be multi-line or very long. Every label, description and tooltip line must go through the one-lining helper, or a newline in a manifest would break the tree item's single-line rendering. The `(no statement)` fallback keeps a node clickable when the statement collapses to empty.

## Acceptance

- src/model/runTreeModel.ts exists, carries no `vscode` import, and exports buildRunTree, buildRunNode, runStageFor, legalRunActions, runContextValue, runOutcomeLabel, runStatementText, runStatementLabel, RunNode, RunGroupNode, RunGroupKind, RunAction, RUN_ACTIONS, RunActionInput, LiveRunStageFact, RUN_LABEL_MAX_CHARS and RUN_OUTCOME_MESSAGE_MAX_CHARS.
- src/model/index.ts re-exports './runTreeModel' and `npm run compile` is clean (no name collides with the existing barrel surface).
- buildRunTree always returns exactly two groups, Active first then Complete, both present when empty, with contextValues baiton.runGroup.active and baiton.runGroup.complete, and preserves input order inside each group.
- For every state in RUN_STATES a run lands in the group isRunComplete(state) predicts, and node.complete === isRunComplete(state); the predicate is imported from the run store, not re-implemented.
- Each run node carries mode, one-lined statement, truncated label, branch, baseBranch, state, hasWorktree/worktreeDir, and either a live stage+attempt (active) or an outcomeLabel (complete); the description reads `<mode> · <stage>[ (attempt n)]`, `<mode> · <state>` or `<mode> · <outcome>` accordingly.
- runOutcomeLabel returns 'review passed', 'review reported findings', 'failed: <message>', 'cancelled', 'answered' and 'merged' for the corresponding state/outcome pairs, with a long failure message one-lined and truncated.
- legalRunActions offers cancel only for an active run with a live stage, viewDiff for a complete run with a worktree that is not merged, merge only for a `done` run with a worktree, nothing for a merged or an answered (worktree-less investigate) run, always in the order cancel, viewDiff, merge.
- runContextValue produces `baiton.run.<active|complete>` plus one space-separated token per action, each token matching its `\b<token>\b` regex, and every node's contextValue equals runContextValue(its group, its actions).
- test/runTreeModel.test.ts covers the cases listed in the plan and passes under `npx mocha test/runTreeModel.test.ts`.
- `npm test` passes with only the new cases added to the counts, `npm run lint` reports nothing beyond the pre-existing warning at src/orchestrator/webviewProtocol.ts:591, and `git status --porcelain` shows only `M src/model/index.ts`, `?? src/model/runTreeModel.ts`, `?? test/runTreeModel.test.ts`.
