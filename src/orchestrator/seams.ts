/**
 * Injectable seams for the orchestrator tools (design "Orchestrator: tool
 * registry and guard", "Stage engine").
 *
 * The concrete tools implemented in this package must stay unit-testable
 * without a `vscode` host, so every effect they cannot express as a pure
 * filesystem/git operation is reached through one of these narrow interfaces
 * rather than by importing `vscode` directly. The activation layer supplies
 * real implementations backed by the VS Code API; a test supplies stubs.
 *
 * - {@link ConfirmSeam} — the UI confirmation `approve_plan` requires before it
 *   changes anything (Req 10.1); a decline/cancel leaves the plan unchanged
 *   (Req 10.2). This is now the narrow yes/no adapter over `InterventionSeam` in
 *   `./interventions` (built with `confirmSeamFrom`); hosts should prefer the
 *   intervention seam for new asks.
 * - {@link RunQueueSeam} — the run queues the `run` tool dispatches into
 *   (Req 10.3–10.5), backed by per-phase queues, one per (slug, phase). Each
 *   phase's stages run in its own worktree, and different phases run
 *   concurrently. The stage engine owns the real queues; the tool only asks
 *   for one stage and reports what it answers.
 * - {@link LandPhaseSeam} — the seam `land_phase` merges a done phase's branch
 *   into its plan branch through; the engine serializes it with state commits.
 * - {@link SubAgentSeam} — the seam `spawn_subagent` and `send_to_subagent` go
 *   through; the sub-agent runner creates the child chat and runs its turns.
 * - {@link RunPipelineSeam} — the plan-less run pipeline the `start_run` and
 *   `investigate` dispatch tools start a run through. The stage engine owns the
 *   real pipeline; the tools only ask it to start a run and report what it
 *   answers.
 * - {@link Clock} and {@link IdGenerator} — the wall clock and run-id source,
 *   injected so transcript timestamps and any generated identifiers are
 *   deterministic under test.
 */
import { RunMode } from '../model/mode';
import type { ToolCaller } from './guard';
import { Stage } from '../model/stage';

/**
 * A yes/no confirmation prompt shown to the user. `approve_plan` calls this
 * before performing any git or frontmatter change and proceeds only on an
 * affirmative answer (Req 10.1, 10.2).
 *
 * This is now the narrow yes/no adapter over `InterventionSeam` in
 * `./interventions` (built with `confirmSeamFrom`); hosts should prefer the
 * intervention seam for new asks.
 */
export interface ConfirmSeam {
  /**
   * Ask the user to confirm an action described by `message`. Resolves `true`
   * only when the user affirmatively confirms; a decline, a cancel, or a
   * dismissed prompt resolves `false`.
   */
  confirm(message: string): Promise<boolean>;
}

/**
 * The stage a `run` dispatch targets, resolved to the role the stage engine
 * launches for it. The tool passes the raw request; the engine owns role
 * mapping, briefs, terminals and journaling.
 */
export interface RunDispatchRequest {
  slug: string;
  phaseId: string;
  stage: Stage;
}

/**
 * The answer the run queue gives the `run` tool. The queue either accepts the
 * dispatch (`dispatched`), refuses because a stage is already running (or
 * being dispatched) for this phase (`busy`, Req 10.4), or refuses because the
 * requested stage is not allowed (`illegal`, Req 10.5) — an illegal transition
 * for the phase's current state, or another queue reason such as deps-unlanded,
 * carried in `reason`. The tool maps
 * this answer to a {@link ToolResult}; it never inspects queue internals.
 */
export type RunDispatchOutcome =
  | { kind: 'dispatched'; runId: string }
  | { kind: 'busy' }
  | { kind: 'illegal'; reason: string };

/**
 * The per-phase run queue seam (Req 10.3–10.5, 20). The stage
 * engine implements this; the `run` tool depends only on `dispatch`.
 */
export interface RunQueueSeam {
  /**
   * Dispatch exactly one stage. Returns `dispatched` with a run id when the
   * queue was idle and the transition is legal, `busy` when a stage is already
   * running for this phase, or `illegal` when the stage is not allowed from the phase's current
   * state.
   */
  dispatch(req: RunDispatchRequest): Promise<RunDispatchOutcome>;
}

/** One request to land a done phase's branch into its plan branch. */
export interface LandPhaseRequest {
  slug: string;
  phaseId: string;
}

/**
 * What the land seam answers `land_phase`. `landed` carries the plan branch's head after the merge (`noop` when the branch was already contained, `cleanup` any non-fatal worktree/branch removal warnings); `already-landed` means no phase branch exists; `refused` carries the named reason (wrong branch checked out, dirty tree, conflict, a stage still running, a git failure).
 */
export type LandPhaseOutcome =
  | { kind: 'landed'; commit: string; noop: boolean; cleanup: readonly string[] }
  | { kind: 'already-landed' }
  | { kind: 'refused'; reason: string };

/** The seam `land_phase` lands through; the engine serializes it with state commits via the plan-branch writer. */
export interface LandPhaseSeam {
  land(req: LandPhaseRequest): Promise<LandPhaseOutcome>;
}

/** The deepest a sub-agent may nest: a top-level chat is depth 0, its sub-agent 1, that sub-agent's sub-agent 2. A caller already at this depth cannot spawn. */
export const MAX_SUBAGENT_DEPTH = 2;

export interface SpawnSubAgentRequest { task: string; caller: ToolCaller; }
export type SpawnSubAgentOutcome =
  | { kind: 'replied'; chatId: string; reply: string }
  | { kind: 'refused'; reason: string };

export interface SendToSubAgentRequest { chatId: string; message: string; caller: ToolCaller; }
export type SendToSubAgentOutcome =
  | { kind: 'replied'; reply: string }
  | { kind: 'refused'; reason: string };

/** The seam spawn_subagent and send_to_subagent go through. The sub-agent runner implements it: spawn creates the child chat, runs its first turn and resolves with its final assistant text; send re-enters the child's loop with a follow-up and resolves with that turn's final text. */
export interface SubAgentSeam {
  spawn(req: SpawnSubAgentRequest): Promise<SpawnSubAgentOutcome>;
  send(req: SendToSubAgentRequest): Promise<SendToSubAgentOutcome>;
}

/** One request to draft a plan from an agreed request. */
export interface DraftPlanRequest {
  /** The slug the new plan will be created under. */
  slug: string;
  /** The agreed request the orchestrator assembled with the user. */
  requirements: string;
}

/**
 * The answer the plan-draft runner gives the `draft_plan` tool. `started`
 * carries the run id so the model can tell the user where to watch; `busy`
 * means a plan-less run (or another draft) is in flight; `refused` carries the
 * reason the draft never launched (a duplicate slug, a failed adapter probe, a
 * failed launch).
 */
export type DraftPlanOutcome =
  | { kind: 'started'; runId: string }
  | { kind: 'busy' }
  | { kind: 'refused'; reason: string };

/**
 * The plan-draft runner seam the `draft_plan` tool dispatches into. The stage
 * engine implements it (`createPlanDraftRunner`); the tool only asks it to
 * start a draft and reports what it answers. It resolves as soon as the
 * sub-agent is running, so the chat turn is never blocked on the draft.
 */
export interface DraftPlanSeam {
  draft(req: DraftPlanRequest): Promise<DraftPlanOutcome>;
}

/** One confirmed plan-less dispatch from a run-mode conversation. */
export interface StartRunRequest {
  /** The mode the run executes as; never plan. */
  mode: RunMode;
  /** The one-line statement of the work (or the question, for investigate). */
  statement: string;
  /** The repository-relative files the orchestrator guessed are involved. */
  files: string[];
  /** How to reproduce the defect; only a Bug run supplies it. */
  reproduction?: string;
}

/**
 * The answer the run pipeline gives `start_run`/`investigate`. `started`
 * carries the run id (and the branch the run was created on, when the host
 * knows it) so the model can tell the user where to watch; `busy` means the
 * plan draft or another plan-less run is in flight; `refused` carries the reason the run never launched.
 */
export type StartRunOutcome =
  | { kind: 'started'; runId: string; branch?: string }
  | { kind: 'busy' }
  | { kind: 'refused'; reason: string };

/**
 * The plan-less run pipeline seam the dispatch tools start a run through. The
 * stage engine implements it over `createRunPipeline(...).start`; the tools
 * only ask it to start a run and report what it answers. It resolves as soon
 * as the run is launched, so the chat turn is never blocked on the run.
 *
 * The seam is deliberately narrower than `RunPipelineRequest` in
 * src/engine/runPipeline.ts: the pipeline also wants `composerMode` and
 * `explicitMode`, which only the host knows (the composer's Mode select). The
 * host adapter fills those in; a tool never guesses them.
 */
export interface RunPipelineSeam {
  start(req: StartRunRequest): Promise<StartRunOutcome>;
}

/** A wall clock, injected so transcript timestamps are deterministic in tests. */
export interface Clock {
  /** The current time as an ISO-8601 string. */
  now(): string;
}

/** A generator for identifiers, injected so ids are deterministic in tests. */
export interface IdGenerator {
  /** A fresh, unique identifier. */
  next(): string;
}

/** The default clock: the real system time as an ISO-8601 string. */
export const systemClock: Clock = {
  now: () => new Date().toISOString(),
};
