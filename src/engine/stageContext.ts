/**
 * The per-stage Brief context assembler (Requirement 18.3; design "Correctness
 * Properties", Property 15).
 *
 * Every todo-level stage runs with a Brief that carries exactly what that role
 * needs and nothing else, so a sub-agent never has to open `spec.md`, another
 * todo's artifacts, or the whole repository to find its inputs:
 *
 *   - plan        — the OVERVIEW, the target todo's own line, and the execution
 *                   summary of each `after` target (not their plans: what a
 *                   dependency intended is not what it did).
 *   - plan-review — the OVERVIEW, the todo line, and the plan under review.
 *   - execute     — the todo line and the plan. No OVERVIEW: the plan is written
 *                   to be implementable on its own. From the second attempt on
 *                   (or when resuming) the latest review is included so the
 *                   executor knows what to fix.
 *   - review      — the todo line, the plan, the latest execution summary, and
 *                   the commit the execution landed in, so the reviewer inspects
 *                   that commit with git instead of reading the tree.
 *
 * Content from any todo that is neither the target nor one of its `after`
 * targets is never included — the confinement guarantee Property 15 asserts
 * (Req 18.3).
 *
 * Pure: every artifact is passed in by the caller, so this module performs no
 * `fs` or `vscode` access. The run queue reads the artifacts through the
 * `SpecStore` seam and supplies them here.
 */
import type { ParsedSpec } from '../model/parser';

/** The four todo-level stages a Brief context is built for. */
export type ContextStage = 'plan' | 'plan-review' | 'execute' | 'review';

/**
 * Everything {@link buildStageContext} may draw on. Which fields are consulted
 * is decided entirely by `stage`; a field a stage does not consult is ignored,
 * which is what keeps each role's context minimal.
 */
export interface StageContextInput {
  /** The stage whose context is being assembled; selects the sections. */
  stage: ContextStage;
  /** The parsed spec, for the OVERVIEW and the target todo's raw line. */
  spec: ParsedSpec;
  /** The target todo id. */
  todoId: string;
  /**
   * `plan` only: the latest execution-summary artifact text of the target's
   * `after` targets, keyed by todo id. Entries for any other todo are never
   * read; an `after` target with no entry simply contributes nothing.
   */
  afterExecutes?: Readonly<Record<string, string>>;
  /** The todo's plan artifact text (`plan-review`, `execute`, `review`). */
  plan?: string;
  /** `execute`: the latest review artifact text, included from attempt 2 on. */
  latestReview?: string;
  /** `review`: the latest execution-summary artifact text. */
  latestExecute?: string;
  /** `review`: the commit the execution landed in, when it is known. */
  executeCommit?: string;
  /** `execute`: the 1-based attempt index; attempt >= 2 carries the review. */
  attempt?: number;
  /** `execute`: true when the run resumes a prior executor session (Req 13.2). */
  resume?: boolean;
}

/**
 * Assemble the Brief context for one stage as Markdown. Pure; the caller
 * supplies every artifact. Sections are emitted in a fixed order per stage and
 * artifacts are embedded verbatim — they are the source of truth downstream and
 * are never parsed back.
 */
export function buildStageContext(input: StageContextInput): string {
  switch (input.stage) {
    case 'plan':
      return join(planSections(input));
    case 'plan-review':
      return join(planReviewSections(input));
    case 'execute':
      return join(executeSections(input));
    case 'review':
      return join(reviewSections(input));
    default:
      return assertNever(input.stage);
  }
}

/**
 * Plan: the OVERVIEW, the target todo's line, and — only for the target's
 * `after` targets, in the order the todo declares them — their execution
 * summaries (Req 18.3).
 */
function planSections(input: StageContextInput): string[] {
  const sections = [`# OVERVIEW\n\n${input.spec.overview}`];
  const target = findTodo(input);
  if (target === undefined) {
    // No such todo: the context is just the OVERVIEW. There is deliberately no
    // fabricated todo line and no `after` content.
    return sections;
  }
  sections.push(todoSection(input));

  const executes = input.afterExecutes ?? {};
  for (const depId of target.after) {
    const summary = executes[depId];
    if (summary === undefined || summary.trim() === '') {
      continue;
    }
    sections.push(`## After target ${depId}\n\n${summary.trim()}`);
  }
  return sections;
}

/** Plan review: the OVERVIEW, the todo line, and the plan under review. */
function planReviewSections(input: StageContextInput): string[] {
  return [
    `# OVERVIEW\n\n${input.spec.overview}`,
    todoSection(input),
    planSection(input),
  ];
}

/**
 * Execute: the todo line and the plan — deliberately no OVERVIEW, because the
 * plan is written to be implementable on its own. A retry (attempt >= 2) or a
 * resumed session also carries the latest review so the executor knows what it
 * has to fix.
 */
function executeSections(input: StageContextInput): string[] {
  const sections = [todoSection(input), planSection(input)];
  const retry = (input.attempt ?? 1) >= 2 || input.resume === true;
  if (retry && input.latestReview !== undefined && input.latestReview.trim() !== '') {
    sections.push(`# Latest review\n\n${input.latestReview.trim()}`);
  }
  return sections;
}

/**
 * Review: the todo line, the plan, the execution summary, and the commit the
 * execution landed in so the reviewer reads that commit rather than the tree.
 */
function reviewSections(input: StageContextInput): string[] {
  const sections = [todoSection(input), planSection(input)];
  sections.push(
    input.latestExecute !== undefined && input.latestExecute.trim() !== ''
      ? `# Execution\n\n${input.latestExecute.trim()}`
      : '# Execution\n\nNo execution summary is on file for this todo.',
  );
  const commit = input.executeCommit?.trim();
  sections.push(
    commit !== undefined && commit !== ''
      ? `# Execute commit\n\nThe execution landed in commit \`${commit}\`. Inspect it with \`git show ${commit}\`.`
      : '# Execute commit\n\nThe execute commit is unknown; fall back to the files named in the execution summary.',
  );
  return sections;
}

/** The target todo's own raw line, verbatim from the spec. */
function todoSection(input: StageContextInput): string {
  const target = findTodo(input);
  if (target === undefined) {
    return `# Todo\n\nThe todo "${input.todoId}" is not present in the spec.`;
  }
  return `# Todo\n\n${input.spec.rawLines[target.lineIndex]}`;
}

/** The todo's plan, delimited so the role can see exactly where it ends. */
function planSection(input: StageContextInput): string {
  const plan = input.plan?.trim();
  return plan !== undefined && plan !== ''
    ? `# Plan\n\n${plan}`
    : '# Plan\n\nNo plan is on file for this todo.';
}

/** The target todo, or `undefined` when the spec does not carry that id. */
function findTodo(input: StageContextInput): ParsedSpec['todos'][number] | undefined {
  return input.spec.todos.find((t) => t.id === input.todoId);
}

/** Join sections with a blank line and a trailing newline. */
function join(sections: string[]): string {
  return sections.join('\n\n') + '\n';
}

/** Exhaustiveness guard for the stage switch. */
function assertNever(value: never): never {
  throw new Error(`unhandled context stage: ${String(value)}`);
}
