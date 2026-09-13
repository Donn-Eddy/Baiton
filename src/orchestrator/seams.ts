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
 * - {@link ConfirmSeam} — the UI confirmation `approve_spec` requires before it
 *   changes anything (Req 10.1); a decline/cancel leaves the spec unchanged
 *   (Req 10.2).
 * - {@link RunQueueSeam} — the per-repository serialized run queue the `run`
 *   tool dispatches into (Req 10.3–10.5). The stage engine owns the real queue
 *   (task 11); the tool only asks it to dispatch one stage and reports what it
 *   answers.
 * - {@link Clock} and {@link IdGenerator} — the wall clock and run-id source,
 *   injected so transcript timestamps and any generated identifiers are
 *   deterministic under test.
 */
import { Stage } from '../model/stage';

/**
 * A yes/no confirmation prompt shown to the user. `approve_spec` calls this
 * before performing any git or frontmatter change and proceeds only on an
 * affirmative answer (Req 10.1, 10.2).
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
  todoId: string;
  stage: Stage;
}

/**
 * The answer the run queue gives the `run` tool. The queue either accepts the
 * dispatch (`dispatched`), refuses because a stage is already running
 * (`busy`, Req 10.4), or refuses because the requested stage is not a legal
 * transition for the todo's current state (`illegal`, Req 10.5). The tool maps
 * this answer to a {@link ToolResult}; it never inspects queue internals.
 */
export type RunDispatchOutcome =
  | { kind: 'dispatched'; runId: string }
  | { kind: 'busy' }
  | { kind: 'illegal'; reason: string };

/**
 * The per-repository serialized run queue seam (Req 10.3–10.5, 20). The stage
 * engine implements this; the `run` tool depends only on `dispatch`.
 */
export interface RunQueueSeam {
  /**
   * Dispatch exactly one stage. Returns `dispatched` with a run id when the
   * queue was idle and the transition is legal, `busy` when a stage is already
   * running, or `illegal` when the stage is not allowed from the todo's current
   * state.
   */
  dispatch(req: RunDispatchRequest): Promise<RunDispatchOutcome>;
}

/** One request to draft a spec from an agreed requirements document. */
export interface DraftSpecRequest {
  /** The slug the new spec will be created under. */
  slug: string;
  /** The requirements document the orchestrator assembled with the user. */
  requirements: string;
}

/**
 * The answer the spec-draft runner gives the `draft_spec` tool. `started`
 * carries the run id so the model can tell the user where to watch; `busy`
 * means a stage is already running for the repository; `refused` carries the
 * reason the draft never launched (a duplicate slug, a failed adapter probe, a
 * failed launch).
 */
export type DraftSpecOutcome =
  | { kind: 'started'; runId: string }
  | { kind: 'busy' }
  | { kind: 'refused'; reason: string };

/**
 * The spec-draft runner seam the `draft_spec` tool dispatches into. The stage
 * engine implements it (`createSpecDraftRunner`); the tool only asks it to
 * start a draft and reports what it answers. It resolves as soon as the
 * sub-agent is running, so the chat turn is never blocked on the draft.
 */
export interface DraftSpecSeam {
  draft(req: DraftSpecRequest): Promise<DraftSpecOutcome>;
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
