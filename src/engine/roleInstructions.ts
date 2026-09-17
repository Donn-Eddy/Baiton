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
 * The four todo-level roles are briefed with a Context section carrying exactly
 * their inputs (see `stageContext.ts`, Req 18.3), so each of them is told the
 * same thing: work from the Context, and do not go looking for `spec.md`, the
 * `.baiton/specs` tree, or another todo's artifacts. That keeps one todo's run
 * confined to its own inputs and keeps the Brief small.
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
/**
 * The executor's finish line, stated in the Role section at the very top of the
 * Brief rather than only in the "Result file"/"When you are done" sections at
 * the bottom. A long plan pushes those sections hundreds of lines down, and an
 * executor that has finished the code but never wrote `result.json` is recorded
 * as `closed` and reverted — the work is kept, but the attempt is thrown away.
 * Exported so tests and callers can assert its presence verbatim.
 */
export const EXECUTOR_RESULT_FILE_INSTRUCTION =
  'The todo is not complete until the result file named in the "Result file" ' +
  'section of this brief exists: writing that file is the last step of the ' +
  'work, not an optional report about it.';

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

/**
 * The sentence every todo-level role carries: the Brief's Context section is
 * the complete input, so the sub-agent must not go hunting through the spec
 * tree (Req 18.3). Exported so tests and callers can assert it verbatim.
 */
export const CONTEXT_IS_COMPLETE_INSTRUCTION =
  'Everything you need is in the Context section of this brief. Do not read ' +
  '`spec.md`, anything under `.baiton/specs`, or any other todo\'s artifacts; ' +
  'the Context is the complete and authoritative statement of your inputs.';

/** The role-specific instruction body that opens the Brief. */
const ROLE_INSTRUCTIONS: Record<Role, string> = {
  'spec-writer': SPEC_WRITER_INSTRUCTION,
  planner: [
    'You are the planner. The Context section gives you the spec OVERVIEW, the ' +
      'one todo you are planning, and the execution summaries of the todos it ' +
      'depends on. Study the code named there read-only and produce a concrete ' +
      'implementation plan for this single todo. Do not modify any source files.',
    '',
    'Write the plan so an executor can implement it from the plan alone, with ' +
      'no OVERVIEW and no access to the spec: name the exact files to change, ' +
      'the concrete edits to make in each, and the checks that decide the todo ' +
      'is done. Prefer specifics — function and symbol names, the shape of new ' +
      'code — over restating the goal.',
    '',
    CONTEXT_IS_COMPLETE_INSTRUCTION,
  ].join('\n'),
  'plan-reviewer': [
    'You are the plan reviewer. The Context section gives you the spec ' +
      'OVERVIEW, the todo, and the proposed plan. Read the code the plan names ' +
      'read-only and judge whether the plan is complete and correct for this ' +
      'single todo, and whether an executor could implement it from the plan ' +
      'alone. Do not modify any source files.',
    '',
    CONTEXT_IS_COMPLETE_INSTRUCTION,
  ].join('\n'),
  executor: [
    'You are the executor. The Context section gives you the todo and its ' +
      'plan — and, when this is a retry, the review that sent it back. ' +
      'Implement this single todo by editing the workspace files to satisfy ' +
      'the plan. Run whatever you need to verify your work.',
    '',
    EXECUTOR_RESULT_FILE_INSTRUCTION,
    '',
    CONTEXT_IS_COMPLETE_INSTRUCTION,
    '',
    EXECUTOR_NO_GIT_INSTRUCTION,
  ].join('\n'),
  reviewer: [
    'You are the reviewer. The Context section gives you the todo, its plan, ' +
      'the executor\'s summary, and the commit the execution landed in. ' +
      'Inspect that commit with git — `git show <commit>` — rather than ' +
      'reading the whole tree, and judge whether the todo was implemented ' +
      'correctly against its plan. Run checks as needed. Do not modify any ' +
      'source files outside your run directory.',
    '',
    CONTEXT_IS_COMPLETE_INSTRUCTION,
  ].join('\n'),
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
