/**
 * TypeScript shapes for the structured output a Sub_Agent writes to its
 * `result.json` for each stage (design "Stage result schemas").
 *
 * These mirror the JSON Schemas in {@link ./schemas} one-for-one; the schemas
 * are the runtime source of truth (validated with Ajv) and these interfaces are
 * the compile-time view the rest of the codebase programs against.
 */

/** One todo the spec writer proposes, in dependency order. */
export interface SpecDraftTodo {
  /** The todo title — a title only; never a lifecycle state (Req 9.7). */
  title: string;
  /**
   * The 1-based positions, in this same list, of the todos this one depends on.
   * Positions (not ids) because the writer does not assign ids; the extension
   * maps each position to the `T##` id it assigns.
   */
  after?: string[];
  /** Repository-relative files this todo is expected to start from. */
  files?: string[];
}

/** The spec writer's structured output (Spec_Draft stage). */
export interface SpecDraftResult {
  /** The spec's OVERVIEW prose. */
  overview: string;
  /** The dependency-ordered todo list. */
  todos: SpecDraftTodo[];
}

/** A single planned step in a {@link PlanResult}. */
export interface PlanStep {
  /** Short imperative title for the step. */
  title: string;
  /** Fuller explanation of what the step does. */
  detail: string;
  /** Repository-relative files the step is expected to touch. */
  files: string[];
}

/** The planner's structured output (Plan stage). */
export interface PlanResult {
  /** Ordered plan steps. */
  steps: PlanStep[];
  /** Known risks the plan carries. */
  risks: string[];
  /** Acceptance checks that define "done" for the todo. */
  acceptance: string[];
}

/** Severity of a review finding. */
export type FindingSeverity = 'must' | 'should';

/** A finding raised by the plan-reviewer. */
export interface PlanReviewFinding {
  /** Whether the finding must be addressed or is a suggestion. */
  severity: FindingSeverity;
  /** The finding text. */
  text: string;
}

/**
 * The plan-reviewer's structured output (Plan_Review stage).
 *
 * A `findings` verdict requires a non-empty {@link findings} list; a `pass`
 * verdict carries an empty list (Req 12.9).
 */
export interface PlanReviewResult {
  /** Overall verdict for the plan under review. */
  verdict: 'pass' | 'findings';
  /** Findings; non-empty exactly when `verdict === 'findings'`. */
  findings: PlanReviewFinding[];
}

/** The executor's structured output (Execute stage). */
export interface ExecuteResult {
  /** Human-readable summary of what was done. */
  summary: string;
  /** Repository-relative files the execution changed. */
  files_changed: string[];
  /** Shell commands the executor ran. */
  commands_run: string[];
  /** Additional notes for the reviewer or user. */
  notes: string[];
}

/** A finding raised by the reviewer, located in a file. */
export interface ReviewFinding {
  /** Whether the finding must be addressed or is a suggestion. */
  severity: FindingSeverity;
  /** Repository-relative file the finding points at. */
  file: string;
  /** 1-based line the finding points at. */
  line: number;
  /** The finding text. */
  text: string;
}

/** Test outcome reported by the reviewer. */
export interface ReviewTests {
  /** Whether tests were run. */
  ran: boolean;
  /** Whether the tests passed. */
  passed: boolean;
  /** Tail of the test output for context. */
  output_tail: string;
}

/**
 * The reviewer's structured output (Review stage).
 *
 * A `findings` verdict requires a non-empty {@link findings} list; a `pass`
 * verdict carries an empty list (Req 12.9).
 */
export interface ReviewResult {
  /** Overall verdict for the executed work. */
  verdict: 'pass' | 'findings';
  /** Findings; non-empty exactly when `verdict === 'findings'`. */
  findings: ReviewFinding[];
  /** Test run outcome. */
  tests: ReviewTests;
}

/** Union of every stage result shape. */
/** The pr-writer's result: the pull request title and body (Req 8 "PR"). */
export interface PrResult {
  title: string;
  body: string;
}

export type StageResult =
  | SpecDraftResult
  | PlanResult
  | PlanReviewResult
  | ExecuteResult
  | ReviewResult
  | PrResult;
