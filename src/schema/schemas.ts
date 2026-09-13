/**
 * JSON Schemas for the four stage results (design "Stage result schemas").
 *
 * These are the runtime source of truth: the brief carries the matching schema
 * to the Sub_Agent and the extension validates the returned `result.json`
 * against it with Ajv (Req 12.2). The schemas are strict — additional
 * properties are rejected so a malformed result cannot slip through.
 *
 * For both review stages a `findings` verdict requires a non-empty findings
 * list, expressed as an `if`/`then` so Ajv rejects the empty-findings case
 * directly (Req 12.9); a `pass` verdict requires an empty findings list.
 */
import type { JSONSchemaType } from 'ajv';
import type {
  ExecuteResult,
  PlanResult,
  PlanReviewResult,
  PrResult,
  ReviewResult,
  SpecDraftResult,
} from './types';

/**
 * Spec_Draft stage schema: the OVERVIEW prose plus a dependency-ordered todo
 * list. Each todo carries a title and, optionally, the 1-based positions of the
 * earlier todos it depends on and the files it starts from. Strict, like every
 * other stage schema — an unknown property is rejected.
 */
export const specDraftSchema: JSONSchemaType<SpecDraftResult> = {
  type: 'object',
  additionalProperties: false,
  required: ['overview', 'todos'],
  properties: {
    overview: { type: 'string' },
    todos: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title'],
        properties: {
          title: { type: 'string', minLength: 1 },
          after: { type: 'array', items: { type: 'string' }, nullable: true },
          files: { type: 'array', items: { type: 'string' }, nullable: true },
        },
      },
    },
  },
};

/** Plan stage schema. */
export const planSchema: JSONSchemaType<PlanResult> = {
  type: 'object',
  additionalProperties: false,
  required: ['steps', 'risks', 'acceptance'],
  properties: {
    steps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'detail', 'files'],
        properties: {
          title: { type: 'string' },
          detail: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    risks: { type: 'array', items: { type: 'string' } },
    acceptance: { type: 'array', items: { type: 'string' } },
  },
};

/**
 * Plan_Review stage schema. A `findings` verdict requires at least one finding;
 * a `pass` verdict requires none (Req 12.9).
 */
export const planReviewSchema: JSONSchemaType<PlanReviewResult> = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'findings'],
  properties: {
    verdict: { type: 'string', enum: ['pass', 'findings'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'text'],
        properties: {
          severity: { type: 'string', enum: ['must', 'should'] },
          text: { type: 'string' },
        },
      },
    },
  },
  if: { properties: { verdict: { const: 'findings' } } },
  then: { properties: { findings: { minItems: 1 } } },
  else: { properties: { findings: { maxItems: 0 } } },
};

/** Execute stage schema. */
export const executeSchema: JSONSchemaType<ExecuteResult> = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'files_changed', 'commands_run', 'notes'],
  properties: {
    summary: { type: 'string' },
    files_changed: { type: 'array', items: { type: 'string' } },
    commands_run: { type: 'array', items: { type: 'string' } },
    notes: { type: 'array', items: { type: 'string' } },
  },
};

/**
 * Review stage schema. A `findings` verdict requires at least one finding; a
 * `pass` verdict requires none (Req 12.9).
 */
export const reviewSchema: JSONSchemaType<ReviewResult> = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'findings', 'tests'],
  properties: {
    verdict: { type: 'string', enum: ['pass', 'findings'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'file', 'line', 'text'],
        properties: {
          severity: { type: 'string', enum: ['must', 'should'] },
          file: { type: 'string' },
          line: { type: 'integer' },
          text: { type: 'string' },
        },
      },
    },
    tests: {
      type: 'object',
      additionalProperties: false,
      required: ['ran', 'passed', 'output_tail'],
      properties: {
        ran: { type: 'boolean' },
        passed: { type: 'boolean' },
        output_tail: { type: 'string' },
      },
    },
  },
  if: { properties: { verdict: { const: 'findings' } } },
  then: { properties: { findings: { minItems: 1 } } },
  else: { properties: { findings: { maxItems: 0 } } },
};

/** The PR stage result: a non-empty title and a body (Req 8 "PR"). */
export const prSchema: JSONSchemaType<PrResult> = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'body'],
  properties: {
    title: { type: 'string', minLength: 1 },
    body: { type: 'string' },
  },
};
