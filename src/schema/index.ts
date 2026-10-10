/**
 * Stage result schemas, their Ajv validators, and the stage → schema and
 * stage → persistence-path mappings (Requirements 12.2, 12.9, 24.3).
 *
 * The extension validates a Sub_Agent's `result.json` against the schema for
 * the stage that produced it and, on success, persists the artifact under the
 * document at the stage's defined path. A `findings` verdict with an empty findings
 * list is invalid for both review stages (enforced inside the schemas, Req
 * 12.9).
 */
import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import type { Stage } from '../model/stage';
import type { DocumentKind } from '../model/parser';
import { Result, err, ok } from '../model/result';
import {
  executeSchema,
  investigateSchema,
  planReviewSchema,
  planSchema,
  prSchema,
  reviewSchema,
  planDraftSchema,
} from './schemas';
import type {
  ExecuteResult,
  InvestigateResult,
  PlanResult,
  PlanReviewResult,
  PrResult,
  ReviewResult,
  PlanDraftResult,
  StageResult,
} from './types';

export * from './types';
export {
  planDraftSchema,
  planSchema,
  planReviewSchema,
  executeSchema,
  reviewSchema,
  prSchema,
  investigateSchema,
} from './schemas';

/**
 * Shared Ajv instance. `allErrors` so a validation failure reports every
 * problem (surfaced to the user, Req 12.4); `strictTuples`/keyword strictness
 * is relaxed because the review schemas use `if`/`then`/`else` to constrain the
 * findings list against the verdict.
 */
const ajv = new Ajv({ allErrors: true, strict: false });

const validatePlanDraft = ajv.compile(planDraftSchema);
const validatePlan = ajv.compile(planSchema);
const validatePlanReview = ajv.compile(planReviewSchema);
const validateExecute = ajv.compile(executeSchema);
const validateReview = ajv.compile(reviewSchema);
const validatePr = ajv.compile(prSchema);
const validateInvestigate = ajv.compile(investigateSchema);

/** Stage → compiled Ajv validator (Req 12.2). */
const VALIDATORS: Record<Stage, ValidateFunction> = {
  'plan-draft': validatePlanDraft as ValidateFunction,
  plan: validatePlan as ValidateFunction,
  'plan-review': validatePlanReview as ValidateFunction,
  execute: validateExecute as ValidateFunction,
  review: validateReview as ValidateFunction,
  pr: validatePr as ValidateFunction,
  investigate: validateInvestigate as ValidateFunction,
};

/** Stage → its JSON Schema (the brief carries this to the Sub_Agent). */
export const STAGE_SCHEMAS: Record<Stage, object> = {
  'plan-draft': planDraftSchema,
  plan: planSchema,
  'plan-review': planReviewSchema,
  execute: executeSchema,
  review: reviewSchema,
  pr: prSchema,
  investigate: investigateSchema,
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

/** Typed convenience wrapper for the Plan_Draft stage. */
export function validatePlanDraftResult(
  value: unknown,
): Result<PlanDraftResult, SchemaError[]> {
  return validateStageResult('plan-draft', value) as Result<
    PlanDraftResult,
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

/** Typed convenience wrapper for the Investigate stage. */
export function validateInvestigateResult(
  value: unknown,
): Result<InvestigateResult, SchemaError[]> {
  return validateStageResult('investigate', value) as Result<
    InvestigateResult,
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
  return (
    stage !== 'plan' &&
    stage !== 'pr' &&
    stage !== 'plan-draft' &&
    stage !== 'investigate'
  );
}

/**
 * The plan-relative persistence path for a stage's artifact.
 *
 * Phase stages persist under `phases/<phaseId>/` for plans and the legacy
 * `todos/<phaseId>/` layout for Legacy documents (Req 24.3). The plan-scoped
 * stages ignore the phase id and stay at the document root: `plan-draft` →
 * `plan.md` (or Legacy `spec.md`), `pr` →
 * `pr.md`.
 *
 * `investigate` is run-scoped: its `finding.md` is relative to the run
 * directory, and it ignores both the phase id and the index.
 *
 * Omitting the phase id for a phase-level stage throws, as does omitting the
 * round/attempt index `n` for a numbered stage: neither artifact has a
 * well-defined location without it. The separator is always `/`; callers join
 * the result onto an absolute directory with `path.join`, which normalises it.
 */
export function persistencePathForStage(
  stage: Stage,
  phaseId?: string,
  n?: number,
  kind: DocumentKind = 'plan',
): string {
  switch (stage) {
    case 'plan-draft':
      // Legacy documents retain spec.md; plans use plan.md.
      return kind === 'plan' ? 'plan.md' : 'spec.md';
    case 'plan':
      return `${phaseArtifactDir(stage, phaseId, kind)}/plan.md`;
    case 'plan-review':
      return `${phaseArtifactDir(stage, phaseId, kind)}/plan-review-${requireIndex(stage, n)}.md`;
    case 'execute':
      return `${phaseArtifactDir(stage, phaseId, kind)}/execute-${requireIndex(stage, n)}.md`;
    case 'review':
      return `${phaseArtifactDir(stage, phaseId, kind)}/review-${requireIndex(stage, n)}.md`;
    case 'pr':
      // The PR draft persists once per document, at its root (Req 8 "PR").
      return 'pr.md';
    case 'investigate':
      // An investigate run persists one finding, at the root of its run
      // directory; it is run-scoped, so the phase id and index are unused.
      return 'finding.md';
    default:
      return assertNever(stage);
  }
}

/**
 * A phase id is part of a filesystem path, so it must be a single, plain path
 * segment. Ids come from the document, but the path is built from
 * file data, so the shape is enforced here rather than assumed.
 */
const PHASE_ID_SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * The plan-relative directory holding one phase's artifacts, validated as a
 * single path segment so a malformed id can never escape the document folder.
 */
function phaseArtifactDir(stage: Stage, phaseId: string | undefined, kind: DocumentKind): string {
  if (
    phaseId === undefined ||
    !PHASE_ID_SEGMENT.test(phaseId) ||
    phaseId === '.' ||
    phaseId === '..'
  ) {
    throw new Error(
      `stage "${stage}" persists a phase artifact and requires a plain phase id, got ${String(phaseId)}`,
    );
  }
  // Legacy documents keep the todos/<id>/ layout for compatibility.
  return `${kind === 'plan' ? 'phases' : 'todos'}/${phaseId}`;
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
