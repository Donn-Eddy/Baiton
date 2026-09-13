/**
 * Per-role instruction text that leads the Brief (Requirement 11.3).
 *
 * The Brief opens with the role instructions for the stage, telling the
 * Sub_Agent what work to perform. These are plain prose (Markdown) composed by
 * {@link buildBrief} ahead of the absolute `result.json` path, the stage JSON
 * schema, and the final write-and-stop instruction. The executor's instructions
 * additionally forbid committing, stashing, or changing branches
 * (Requirement 17.5) — the extension owns all git operations.
 *
 * Kept as a pure lookup so the brief writer stays testable without a VS Code
 * host.
 */
import type { Role } from '../model/role';

/**
 * The single instruction every executor Brief must carry: the extension owns
 * git, so the executor must never commit, stash, or switch branches
 * (Requirement 17.5). Exported so tests and callers can assert its presence
 * verbatim.
 */
export const EXECUTOR_NO_GIT_INSTRUCTION =
  'Do not commit, stash, or change branches. The extension manages all git ' +
  'operations; leave your changes in the working tree.';

/**
 * The spec writer's instructions: study the repository read-only, turn the
 * supplied requirements into an OVERVIEW and a dependency-ordered todo list,
 * and write the result JSON. The todo grammar rules are spelled out here
 * because the writer supplies titles and positional dependencies while the
 * extension assigns the `T##` ids. Exported so tests can assert the wording.
 */
export const SPEC_WRITER_INSTRUCTION = [
  'You are the spec writer. Read the requirements in the context below, study ' +
    'the repository read-only to understand how the work fits the existing ' +
    'code, and turn the requirements into a spec: one OVERVIEW and a ' +
    'dependency-ordered list of todos. Do not modify any source files; the ' +
    'only file you write is your result file.',
  '',
  'Todo rules:',
  '- A todo carries a title only. Never write a lifecycle state, and never ' +
    'assign an id — the extension assigns `T01`, `T02`, ... in the order you ' +
    'list them.',
  '- Order the list so every todo comes after the todos it depends on.',
  '- `after` lists the 1-based positions, in this same list, of the earlier ' +
    'todos this one depends on (for example `["1", "2"]`). A position must be ' +
    'smaller than this todo\'s own position.',
  '- `files` lists the repository-relative files the todo starts from.',
  '- Each todo should be a single, reviewable unit of work with a clear ' +
    'finish line.',
].join('\n');

/** The role-specific instruction body that opens the Brief. */
const ROLE_INSTRUCTIONS: Record<Role, string> = {
  'spec-writer': SPEC_WRITER_INSTRUCTION,
  planner:
    'You are the planner. Read the provided OVERVIEW and todo, study the ' +
    'relevant code read-only, and produce a concrete implementation plan for ' +
    'this single todo. Do not modify any source files.',
  'plan-reviewer':
    'You are the plan reviewer. Read the proposed plan and the relevant code ' +
    'read-only, and judge whether the plan is complete and correct for this ' +
    'single todo. Do not modify any source files.',
  executor:
    'You are the executor. Implement this single todo by editing the ' +
    'workspace files to satisfy the plan. Run whatever you need to verify ' +
    `your work.\n\n${EXECUTOR_NO_GIT_INSTRUCTION}`,
  reviewer:
    'You are the reviewer. Read the implementation and the relevant code, run ' +
    'checks as needed, and judge whether the todo was implemented correctly. ' +
    'Do not modify any source files outside your run directory.',
  'pr-writer':
    'You are the PR writer. Read the spec, its plans and execution summaries, ' +
    'and the cumulative diff named in the context, then draft a pull request ' +
    'title (one line, imperative) and body (markdown: what changed, why, how ' +
    'it was verified). Do not modify any source files.',
};

/** The instruction body for a role (the opening section of the Brief). */
export function roleInstructions(role: Role): string {
  return ROLE_INSTRUCTIONS[role];
}
