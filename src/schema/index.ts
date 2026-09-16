/**
 * Stage result schemas, their Ajv validators, and the stage → schema and
 * stage → persistence-path mappings (Requirements 12.2, 12.9, 24.3).
 *
 * The extension validates a Sub_Agent's `result.json` against the schema for
 * the stage that produced it and, on success, persists the artifact under the
 * spec at the stage's defined path. A `findings` verdict with an empty findings
 * list is invalid for both review stages (enforced inside the schemas, Req
 * 12.9).
 */
import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import type { Stage } from '../model/stage';
import { Result, err, ok } from '../model/result';
import {
  executeSchema,
  planReviewSchema,
  planSchema,
  prSchema,
  reviewSchema,
  specDraftSchema,
} from './schemas';
import type {
  ExecuteResult,
  PlanResult,
  PlanReviewResult,
  PrResult,
  ReviewResult,
  SpecDraftResult,
  StageResult,
} from './types';

export * from './types';
export {
  specDraftSchema,
  planSchema,
  planReviewSchema,
  executeSchema,
  reviewSchema,
  prSchema,
} from './schemas';

/**
 * Shared Ajv instance. `allErrors` so a validation failure reports every
 * problem (surfaced to the user, Req 12.4); `strictTuples`/keyword strictness
 * is relaxed because the review schemas use `if`/`then`/`else` to constrain the
 * findings list against the verdict.
 */
const ajv = new Ajv({ allErrors: true, strict: false });

const validateSpecDraft = ajv.compile(specDraftSchema);
const validatePlan = ajv.compile(planSchema);
const validatePlanReview = ajv.compile(planReviewSchema);
const validateExecute = ajv.compile(executeSchema);
const validateReview = ajv.compile(reviewSchema);
const validatePr = ajv.compile(prSchema);

/** Stage → compiled Ajv validator (Req 12.2). */
const VALIDATORS: Record<Stage, ValidateFunction> = {
  'spec-draft': validateSpecDraft as ValidateFunction,
  plan: validatePlan as ValidateFunction,
  'plan-review': validatePlanReview as ValidateFunction,
  execute: validateExecute as ValidateFunction,
  review: validateReview as ValidateFunction,
  pr: validatePr as ValidateFunction,
};

/** Stage → its JSON Schema (the brief carries this to the Sub_Agent). */
export const STAGE_SCHEMAS: Record<Stage, object> = {
  'spec-draft': specDraftSchema,
  plan: planSchema,
  'plan-review': planReviewSchema,
  execute: executeSchema,
  review: reviewSchema,
  pr: prSchema,
};

/** Return the JSON Schema for a stage (the brief embeds it). */
export function schemaForStage(stage: Stage): object {
  return STAGE_SCHEMAS[stage];
}

/**
 * A single schema violation, flattened from Ajv into a location + message so
 * callers can surface exactly what was invalid without depending on Ajv types.
 */
export interface SchemaError {
  /** JSON Pointer to the offending location (empty string = document root). */
  instancePath: string;
  /** Human-readable explanation of the failure. */
  message: string;
}

/** Flatten Ajv's error objects into {@link SchemaError}s. */
function toSchemaErrors(errors: ErrorObject[] | null | undefined): SchemaError[] {
  if (!errors || errors.length === 0) {
    return [{ instancePath: '', message: 'unknown validation error' }];
  }
  return errors.map((e) => ({
    instancePath: e.instancePath,
    message: e.message ?? 'invalid',
  }));
}

/**
 * Validate an already-parsed JSON value against a stage's schema.
 *
 * On success the value is narrowed to the stage's result type; on failure the
 * flattened schema errors are returned (Req 12.2, 12.9). This does not parse
 * JSON — callers handle malformed JSON (Req 12.3) before calling here.
 */
export function validateStageResult(
  stage: Stage,
  value: unknown,
): Result<StageResult, SchemaError[]> {
  const validate = VALIDATORS[stage];
  if (validate(value)) {
    return ok(value as StageResult);
  }
  return err(toSchemaErrors(validate.errors));
}

/** Typed convenience wrapper for the Spec_Draft stage. */
export function validateSpecDraftResult(
  value: unknown,
): Result<SpecDraftResult, SchemaError[]> {
  return validateStageResult('spec-draft', value) as Result<
    SpecDraftResult,
    SchemaError[]
  >;
}

/** Typed convenience wrapper for the Plan stage. */
export function validatePlanResult(
  value: unknown,
): Result<PlanResult, SchemaError[]> {
  return validateStageResult('plan', value) as Result<PlanResult, SchemaError[]>;
}

/** Typed convenience wrapper for the Plan_Review stage. */
export function validatePlanReviewResult(
  value: unknown,
): Result<PlanReviewResult, SchemaError[]> {
  return validateStageResult('plan-review', value) as Result<
    PlanReviewResult,
    SchemaError[]
  >;
}

/** Typed convenience wrapper for the Execute stage. */
export function validateExecuteResult(
  value: unknown,
): Result<ExecuteResult, SchemaError[]> {
  return validateStageResult('execute', value) as Result<
    ExecuteResult,
    SchemaError[]
  >;
}

/** Typed convenience wrapper for the Review stage. */
export function validateReviewResult(
  value: unknown,
): Result<ReviewResult, SchemaError[]> {
  return validateStageResult('review', value) as Result<
    ReviewResult,
    SchemaError[]
  >;
}

/**
 * Whether a stage's persisted artifact is numbered with the run's attempt/round
 * index. Plan persists once as `plan.md`; the other three are numbered
 * (`plan-review-<n>.md`, `execute-<n>.md`, `review-<n>.md`) (Req 24.3).
 */
export function validatePrResult(
  value: unknown,
): Result<PrResult, SchemaError[]> {
  return validateStageResult('pr', value) as Result<PrResult, SchemaError[]>;
}

export function stageArtifactIsNumbered(stage: Stage): boolean {
  return stage !== 'plan' && stage !== 'pr' && stage !== 'spec-draft';
}

/**
 * The spec-relative persistence path for a stage's artifact.
 *
 * The four todo-level stages persist under a per-todo folder so one todo's
 * artifacts can never overwrite another's: `todos/<todoId>/plan.md`,
 * `todos/<todoId>/plan-review-<n>.md`, `todos/<todoId>/execute-<n>.md`,
 * `todos/<todoId>/review-<n>.md` (Req 24.3). The two spec-scoped stages ignore
 * the todo id and stay at the spec root: `spec-draft` → `spec.md`, `pr` →
 * `pr.md`.
 *
 * Omitting the todo id for a todo-level stage throws, as does omitting the
 * round/attempt index `n` for a numbered stage: neither artifact has a
 * well-defined location without it. The separator is always `/`; callers join
 * the result onto an absolute directory with `path.join`, which normalises it.
 */
export function persistencePathForStage(
  stage: Stage,
  todoId?: string,
  n?: number,
): string {
  switch (stage) {
    case 'spec-draft':
      // The spec draft persists once per spec, as the spec file itself.
      return 'spec.md';
    case 'plan':
      return `${todoArtifactDir(stage, todoId)}/plan.md`;
    case 'plan-review':
      return `${todoArtifactDir(stage, todoId)}/plan-review-${requireIndex(stage, n)}.md`;
    case 'execute':
      return `${todoArtifactDir(stage, todoId)}/execute-${requireIndex(stage, n)}.md`;
    case 'review':
      return `${todoArtifactDir(stage, todoId)}/review-${requireIndex(stage, n)}.md`;
    case 'pr':
      // The PR draft persists once per spec, at the spec root (Req 8 "PR").
      return 'pr.md';
    default:
      return assertNever(stage);
  }
}

/**
 * A todo id is part of a filesystem path, so it must be a single, plain path
 * segment. Ids come from the spec (`T` plus digits), but the path is built from
 * file data, so the shape is enforced here rather than assumed.
 */
const TODO_ID_SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * The spec-relative directory holding one todo's artifacts, validated as a
 * single path segment so a malformed id can never escape the spec folder.
 */
function todoArtifactDir(stage: Stage, todoId: string | undefined): string {
  if (
    todoId === undefined ||
    !TODO_ID_SEGMENT.test(todoId) ||
    todoId === '.' ||
    todoId === '..'
  ) {
    throw new Error(
      `stage "${stage}" persists a per-todo artifact and requires a plain todo id, got ${String(todoId)}`,
    );
  }
  return `todos/${todoId}`;
}

/** Validate and return the 1-based index a numbered stage artifact requires. */
function requireIndex(stage: Stage, n: number | undefined): number {
  if (n === undefined || !Number.isInteger(n) || n < 1) {
    throw new Error(
      `stage "${stage}" persists a numbered artifact and requires an integer index >= 1`,
    );
  }
  return n;
}

/** Exhaustiveness guard for the stage switch. */
function assertNever(value: never): never {
  throw new Error(`unhandled stage: ${String(value)}`);
}
