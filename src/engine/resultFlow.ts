/**
 * The Result watcher → validation → artifact flow (Requirements 12.1–12.9,
 * 24.1, 24.2, 24.4).
 *
 * {@link awaitStageResult} runs the completion detection for one launched
 * stage. It subscribes to the injected {@link ResultWatcher} and resolves with
 * a {@link RunOutcome} exactly once the run reaches a terminal outcome:
 *
 *   - A `result.json` that parses and validates against the stage schema →
 *     persist the artifact at the stage's path under the spec, dispose the
 *     terminal, and resolve `completed` (Req 12.2, 12.4, 12.5, 24.3).
 *   - A `result.json` that is malformed JSON or fails the schema → keep the
 *     terminal open, leave the todo state unchanged, surface what was invalid,
 *     and keep waiting; a rewrite is re-validated by the same watcher (Req
 *     12.3, 12.6, 12.7, 24.4). The outcome does not resolve on an invalid
 *     result — the run stays open for the sub-agent to correct it.
 *   - The terminal closes before any valid result → resolve `closed` (Req
 *     12.8).
 *
 * The flow is host-independent: file appearance/rewrite and terminal-close
 * arrive through the {@link ResultWatcher} seam, artifact persistence goes
 * through an injected writer (defaulted to the real `fs` shell), and
 * parse/validate is the pure {@link parseAndValidateResult}. The activation
 * layer wires a `vscode`-backed watcher and the queue consumes the outcome.
 */
import { mkdirSync, writeFileSync } from 'fs';
import * as path from 'path';
import type { Stage } from '../model/stage';
import type { TodoState } from '../model/todoState';
import type {
  ExecuteResult,
  PlanResult,
  PlanReviewResult,
  ReviewResult,
  StageResult,
} from '../schema';
import { persistencePathForStage } from '../schema';
import type { HostTerminal } from './terminalHost';
import type { ResultWatcher } from './resultWatcher';
import {
  describeValidationError,
  parseAndValidateResult,
} from './resultValidation';

/**
 * The terminal outcome of a launched stage (design "Stage engine", `RunOutcome`).
 *
 * The `attempt`/`journal`/`commit` bookkeeping the queue layers on top (task
 * 11) is out of scope here; this flow produces only the completion signal.
 *
 * - `completed`      — a valid result landed and its artifact was persisted;
 *                      `structured` is the validated result and `artifactPath`
 *                      the absolute path it was written to.
 * - `closed`         — the terminal closed before any valid result (Req 12.8);
 *                      `exitCode` is the host-reported code when known.
 * - `invalid_output` — reserved for the caller/queue; this flow does not resolve
 *                      with it because an invalid result keeps the run open for a
 *                      rewrite (Req 12.7). It is part of the union so the queue
 *                      and journal can record a run abandoned while invalid.
 * - `cancelled`      — reserved for the queue's `stop()` path (task 11); not
 *                      produced here.
 * - `control-applied`— a control action (`replan`/`stop`) that launched no
 *                      sub-agent and produced no stage result; it only rewrote
 *                      the todo's lifecycle state to `state`. Produced by the
 *                      queue, never by this flow.
 */
export type RunOutcome =
  | { kind: 'completed'; structured: StageResult; artifactPath: string }
  | { kind: 'invalid_output'; detail: string }
  | { kind: 'closed'; exitCode: number | undefined }
  | { kind: 'cancelled' }
  | { kind: 'control-applied'; state: TodoState };

/** Persists an artifact's text to an absolute path; the `fs` seam. */
export type ArtifactWriter = (artifactPath: string, contents: string) => void;

/** Surfaces a validation failure to the user (Req 12.6, 24.4); the notify seam. */
export type ValidationReporter = (detail: string) => void;

/** Everything {@link awaitStageResult} needs to run one stage's completion flow. */
export interface AwaitStageResultInput {
  /** Absolute path of the workspace root; resolves the spec artifact path. */
  workspaceRoot: string;
  /** The spec slug whose folder receives the persisted artifact (Req 24.3). */
  slug: string;
  /** The stage being awaited; selects the schema and persistence path. */
  stage: Stage;
  /**
   * The todo whose artifact folder receives the result (`todos/<todoId>/`);
   * required for the four todo-level stages, ignored by `spec-draft` and `pr`
   * (Req 24.3).
   */
  todoId?: string;
  /**
   * The 1-based round/attempt index for numbered artifacts (`plan-review-<n>`,
   * `execute-<n>`, `review-<n>`); ignored for `plan` (Req 24.3).
   */
  index?: number;
  /** The launched sub-agent's terminal, disposed on a valid result (Req 12.5). */
  terminal: HostTerminal;
  /** The watcher over this run's `result.json` and terminal (Req 12.1, 12.8). */
  watcher: ResultWatcher;
}

/**
 * The injectable dependencies of {@link awaitStageResult}. Defaults wire the
 * real `fs` writer; tests override both to observe persistence and reporting
 * without touching the filesystem.
 */
export interface AwaitStageResultDeps {
  /** Persists the validated artifact; defaults to a `writeFileSync` shell. */
  writeArtifact?: ArtifactWriter;
  /** Surfaces validation failures; defaults to a no-op (the queue/UI wires one). */
  reportInvalid?: ValidationReporter;
}

/**
 * Compose the absolute path an accepted stage artifact is persisted to, under
 * the spec folder, from the stage's naming rule (Req 24.3). Exported so the
 * queue and tests can assert the destination without re-deriving it.
 */
export function artifactPathFor(
  workspaceRoot: string,
  slug: string,
  stage: Stage,
  todoId?: string,
  index?: number,
): string {
  const relative = persistencePathForStage(stage, todoId, index);
  return path.join(workspaceRoot, '.baiton', 'specs', slug, relative);
}

/**
 * The per-stage Markdown renderers (Req 24.3).
 *
 * The persisted `.md` artifact — not the structured JSON — is what later stages
 * read: a brief carries a plan or an execution summary into the next sub-agent
 * verbatim, with no parse-back. Each renderer is therefore a pure, exported
 * function producing prose a sub-agent can act on directly. The structured
 * result stays in the run directory's `result.json` for the journal and for
 * anyone who wants the machine-readable form.
 */

/**
 * The plan artifact: a heading, the ordered steps (title, detail and the files
 * each step touches), then the risks and acceptance checks. This is the file the
 * executor's brief carries verbatim, and the file the user edits before Execute.
 */
export function renderPlanArtifact(todoId: string, plan: PlanResult): string {
  const steps = plan.steps.map((step, i) => {
    const detail = indentContinuation(step.detail);
    const files =
      step.files.length > 0 ? step.files.map((f) => `\`${f}\``).join(', ') : '(none)';
    return `${i + 1}. ${step.title}\n\n${detail}\n\n   Files: ${files}`;
  });
  return [
    `# Plan ${todoId}`,
    '## Steps',
    steps.length > 0 ? steps.join('\n\n') : '(no steps)',
    '## Risks',
    bullets(plan.risks),
    '## Acceptance',
    bullets(plan.acceptance),
  ].join('\n\n') + '\n';
}

/**
 * The plan-review artifact: the verdict and the findings the plan reviewer
 * raised, each with its severity.
 */
export function renderPlanReviewArtifact(
  todoId: string,
  result: PlanReviewResult,
): string {
  const findings = result.findings.map((f) => `- **${f.severity}** — ${f.text}`);
  return [
    `# Plan review ${todoId}`,
    `Verdict: **${result.verdict}**`,
    '## Findings',
    findings.length > 0 ? findings.join('\n') : '- (none)',
  ].join('\n\n') + '\n';
}

/**
 * The execute artifact: what the executor did, which files it changed, which
 * commands it ran, and its notes. The reviewer's brief carries this verbatim.
 */
export function renderExecuteArtifact(
  todoId: string,
  result: ExecuteResult,
): string {
  return [
    `# Execute ${todoId}`,
    '## Summary',
    result.summary,
    '## Files changed',
    bullets(result.files_changed.map((f) => `\`${f}\``)),
    '## Commands run',
    bullets(result.commands_run.map((c) => `\`${c}\``)),
    '## Notes',
    bullets(result.notes),
  ].join('\n\n') + '\n';
}

/**
 * The review artifact: the verdict, the located findings, and the test outcome
 * the reviewer reported.
 */
export function renderReviewArtifact(
  todoId: string,
  result: ReviewResult,
): string {
  const findings = result.findings.map(
    (f) => `- **${f.severity}** \`${f.file}\`:${f.line} — ${f.text}`,
  );
  const tests = result.tests;
  const testLines = [
    `- ran: ${String(tests.ran)}`,
    `- passed: ${String(tests.passed)}`,
    tests.output_tail.trim().length > 0
      ? `\n\`\`\`\n${tests.output_tail}\n\`\`\``
      : '',
  ]
    .filter((l) => l !== '')
    .join('\n');
  return [
    `# Review ${todoId}`,
    `Verdict: **${result.verdict}**`,
    '## Findings',
    findings.length > 0 ? findings.join('\n') : '- (none)',
    '## Tests',
    testLines,
  ].join('\n\n') + '\n';
}

/**
 * Render a validated stage result as the Markdown artifact persisted under the
 * spec. The four todo-level stages get the per-stage renderers above; the two
 * spec-scoped stages (`spec-draft`, `pr`) keep the structured JSON, because
 * their callers render their own file from the structured result and only ever
 * consume this as a record of what the sub-agent returned.
 */
export function renderArtifact(
  stage: Stage,
  structured: StageResult,
  todoId?: string,
): string {
  const id = todoId ?? '';
  switch (stage) {
    case 'plan':
      return renderPlanArtifact(id, structured as PlanResult);
    case 'plan-review':
      return renderPlanReviewArtifact(id, structured as PlanReviewResult);
    case 'execute':
      return renderExecuteArtifact(id, structured as ExecuteResult);
    case 'review':
      return renderReviewArtifact(id, structured as ReviewResult);
    default: {
      const json = JSON.stringify(structured, null, 2);
      return `# ${stage} result\n\n\`\`\`json\n${json}\n\`\`\`\n`;
    }
  }
}

/** Render a list as Markdown bullets, or a `(none)` bullet when empty. */
function bullets(items: readonly string[]): string {
  return items.length > 0 ? items.map((i) => `- ${i}`).join('\n') : '- (none)';
}

/**
 * Indent a step's detail so it stays inside its numbered list item, keeping the
 * rendered plan valid Markdown however many lines the detail runs to.
 */
function indentContinuation(detail: string): string {
  return detail
    .split('\n')
    .map((line) => (line.trim() === '' ? '' : `   ${line}`))
    .join('\n');
}

/**
 * Watch one launched stage's `result.json` and resolve with its terminal
 * outcome (Req 12.1–12.9, 24.3, 24.4).
 *
 * Resolves `completed` on the first valid result (artifact persisted, terminal
 * disposed) or `closed` if the terminal closes first. An invalid result does
 * not resolve the promise: it is surfaced and the flow keeps waiting for a
 * rewrite through the same watcher (Req 12.7). The watcher is disposed on every
 * resolving path.
 */
export function awaitStageResult(
  input: AwaitStageResultInput,
  deps: AwaitStageResultDeps = {},
): Promise<RunOutcome> {
  const writeArtifact = deps.writeArtifact ?? defaultWriteArtifact;
  const reportInvalid = deps.reportInvalid ?? (() => {});

  return new Promise<RunOutcome>((resolve) => {
    let settled = false;

    const finish = (outcome: RunOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      // Tear down both subscriptions before resolving so a late file or close
      // event cannot fire after the run has reached its terminal outcome.
      input.watcher.dispose();
      resolve(outcome);
    };

    // A result appeared or was rewritten (Req 12.1, 12.7). Re-validate every
    // time; an invalid result leaves the run open for the next rewrite.
    input.watcher.onResult((rawContents) => {
      if (settled) {
        return;
      }
      const validated = parseAndValidateResult(input.stage, rawContents);
      if (!validated.ok) {
        // Invalid → keep the terminal open, leave state, surface what was
        // invalid, and wait for a rewrite (Req 12.3, 12.6, 12.7, 24.4).
        reportInvalid(describeValidationError(validated.error));
        return;
      }

      // Valid → persist the artifact under the spec at the stage path, then
      // dispose the terminal (Req 12.4, 12.5, 24.3).
      const artifactPath = artifactPathFor(
        input.workspaceRoot,
        input.slug,
        input.stage,
        input.todoId,
        input.index,
      );
      writeArtifact(
        artifactPath,
        renderArtifact(input.stage, validated.value, input.todoId),
      );
      input.terminal.dispose();
      finish({
        kind: 'completed',
        structured: validated.value,
        artifactPath,
      });
    });

    // The terminal closed before a valid result → `closed` (Req 12.8). If a
    // valid result already settled the run, `finish` is a no-op.
    input.watcher.onTerminalClose((exitCode) => {
      finish({ kind: 'closed', exitCode });
    });
  });
}

/**
 * The default artifact writer: a thin `writeFileSync` shell that first creates
 * the artifact's directory, since a todo-level artifact lands in a per-todo
 * `todos/<todoId>/` folder that may not exist yet (Req 24.3).
 */
function defaultWriteArtifact(artifactPath: string, contents: string): void {
  mkdirSync(path.dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, contents, 'utf8');
}
