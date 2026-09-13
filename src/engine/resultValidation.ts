/**
 * Pure parse + validate + write-confinement helpers for the Result watcher
 * (Requirements 12.2, 12.3, 12.9, 24.1, 24.2).
 *
 * These are deliberately free of `fs`, `vscode`, and any watcher/terminal seam
 * so they are directly testable. The stateful watcher flow in
 * {@link ./resultFlow} composes them.
 */
import * as path from 'path';
import type { Stage } from '../model/stage';
import { Result, err, ok } from '../model/result';
import {
  type SchemaError,
  type StageResult,
  validateStageResult,
} from '../schema';

/**
 * Why a Result_File was rejected (Req 12.3, 12.9). Both variants mean the
 * artifact is not persisted, the terminal stays open, and the todo state is
 * left unchanged (Req 12.6).
 *
 * - `malformed-json` — the file contents were not well-formed JSON (Req 12.3).
 * - `schema`         — the parsed value failed the stage schema, including the
 *                      empty-findings case for the review stages (Req 12.9).
 */
export type ResultValidationError =
  | { kind: 'malformed-json'; message: string }
  | { kind: 'schema'; errors: SchemaError[] };

/**
 * Parse a Result_File's raw contents and validate the parsed value against the
 * stage's schema (Req 12.2, 12.3, 12.9).
 *
 * Pure: parses the string and delegates schema checking to
 * {@link validateStageResult}; it never touches the filesystem. Malformed JSON
 * yields `malformed-json`; a well-formed value that fails the schema yields
 * `schema` carrying every violation so the caller can surface exactly what was
 * invalid (Req 12.6).
 */
export function parseAndValidateResult(
  stage: Stage,
  rawContents: string,
): Result<StageResult, ResultValidationError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContents);
  } catch (cause) {
    return err({
      kind: 'malformed-json',
      message: `result is not well-formed JSON: ${errorMessage(cause)}`,
    });
  }

  const validated = validateStageResult(stage, parsed);
  if (!validated.ok) {
    return err({ kind: 'schema', errors: validated.error });
  }
  return ok(validated.value);
}

/**
 * Render a {@link ResultValidationError} as a single user-facing line stating
 * what was invalid (Req 12.6, 24.4). Kept alongside the validator so the
 * wording stays in one place and is assertable in tests.
 */
export function describeValidationError(error: ResultValidationError): string {
  if (error.kind === 'malformed-json') {
    return error.message;
  }
  const detail = error.errors
    .map((e) => `${e.instancePath === '' ? '(root)' : e.instancePath}: ${e.message}`)
    .join('; ');
  return `result does not conform to the stage schema: ${detail}`;
}

/**
 * The single write location a sub-agent is permitted under `.baiton/`: exactly
 * its own `runs/<run-id>/result.json` (Req 24.1). Returns the absolute path,
 * computed from the workspace root and run id.
 */
export function allowedResultPath(workspaceRoot: string, runId: string): string {
  return path.join(workspaceRoot, '.baiton', 'runs', runId, 'result.json');
}

/**
 * Whether a write `target` a sub-agent attempts under `.baiton/` is permitted:
 * true if and only if it is exactly that sub-agent's own
 * `runs/<run-id>/result.json` (Req 24.1, 24.2).
 *
 * Both paths are normalized (and, on case-insensitive platforms, the compare
 * stays case-sensitive by design — `.baiton/` paths are lowercase) before the
 * exact-equality check, so a sibling run's result, the brief, a nested path, or
 * a traversal such as `runs/<run-id>/../<other>/result.json` is denied. Any
 * path that does not resolve under `.baiton/` at all is likewise not this
 * confinement's concern and returns false.
 */
export function isAllowedSubAgentWrite(
  workspaceRoot: string,
  runId: string,
  target: string,
): boolean {
  const allowed = path.resolve(allowedResultPath(workspaceRoot, runId));
  const resolvedTarget = path.resolve(
    path.isAbsolute(target) ? target : path.join(workspaceRoot, target),
  );
  return resolvedTarget === allowed;
}

/** Extract a user-facing message from an unknown thrown value. */
function errorMessage(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message;
  }
  return String(cause);
}
