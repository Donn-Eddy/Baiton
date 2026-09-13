/**
 * The planner-context assembler (Requirement 18.3; design "Correctness
 * Properties", Property 15).
 *
 * When Plan runs on a todo, the planner is given a strictly confined view of
 * the spec: exactly the OVERVIEW section, the target todo's own line, and the
 * plans and execution summaries of that todo's `after` targets — and nothing
 * from any other todo (Req 18.3). This module builds that confined context text
 * as a pure function so the confinement rule is directly property-testable.
 *
 * It is pure: all artifacts (the per-todo plan text and execution-summary text
 * of `after` targets) are passed in by the caller, so the function performs no
 * `fs` or `vscode` access. The run queue's activation wiring reads the actual
 * artifacts from the run directories and supplies them here.
 */
import type { ParsedSpec } from '../model/parser';

/**
 * The plan and execution-summary artifacts of the todos an assemble may draw
 * on, keyed by todo id. Only the entries for the target todo's `after` targets
 * are ever consulted; entries for any other todo are ignored, which is what
 * keeps the assembled context confined (Req 18.3).
 */
export interface PlannerArtifacts {
  /** Plan text per todo id (the recorded plan artifact of an `after` target). */
  readonly plans: Record<string, string>;
  /** Execution-summary text per todo id (the exec summary of an `after` target). */
  readonly execSummaries: Record<string, string>;
}

/**
 * Assemble the planner's confined context for `todoId`. The returned Markdown
 * contains exactly, and in this order (Req 18.3):
 *
 *   1. The spec OVERVIEW section.
 *   2. The target todo's own line.
 *   3. For each of the target todo's `after` targets (in the todo's declared
 *      order), that target's plan and execution summary, when present.
 *
 * No content from any todo that is neither the target nor one of its `after`
 * targets is ever included — that is the confinement guarantee Property 15
 * asserts. When the todo does not exist in the spec the function returns just
 * the OVERVIEW (there is no todo line to include).
 *
 * Pure: it neither reads nor writes the filesystem; the caller supplies every
 * artifact through {@link PlannerArtifacts}.
 */
export function buildPlannerContext(
  spec: ParsedSpec,
  todoId: string,
  artifacts: PlannerArtifacts,
): string {
  const sections: string[] = [];

  // 1. The OVERVIEW section (always included).
  sections.push(`# OVERVIEW\n\n${spec.overview}`);

  const target = spec.todos.find((t) => t.id === todoId);
  if (target === undefined) {
    // No such todo: the context is just the OVERVIEW. There is deliberately no
    // fabricated todo line and no `after` content.
    return sections.join('\n\n') + '\n';
  }

  // 2. The target todo's own raw line, verbatim from the spec.
  const targetLine = spec.rawLines[target.lineIndex];
  sections.push(`# Todo\n\n${targetLine}`);

  // 3. The plans and execution summaries of the target's `after` targets only,
  //    in the order the todo declares them. An `after` id with no matching plan
  //    or summary simply contributes nothing — never another todo's content.
  for (const depId of target.after) {
    const plan = artifacts.plans[depId];
    const summary = artifacts.execSummaries[depId];
    if (plan === undefined && summary === undefined) {
      continue;
    }
    const parts: string[] = [`## After target ${depId}`];
    if (plan !== undefined) {
      parts.push(`### Plan\n\n${plan}`);
    }
    if (summary !== undefined) {
      parts.push(`### Execution summary\n\n${summary}`);
    }
    sections.push(parts.join('\n\n'));
  }

  return sections.join('\n\n') + '\n';
}
