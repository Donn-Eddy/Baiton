/**
 * System-prompt builder (host-free core, Requirement 11).
 *
 * A pure function of the conversation kind and the current spec content. It
 * produces the instruction text prepended to a conversation's messages,
 * derived from tech-sheet sections 5 (the spec file) and 7 (the chat
 * orchestrator). It carries no `vscode` import so it is directly unit-testable
 * without a host.
 *
 * The prompt always states the orchestrator's role (never edits source, writes
 * only through the spec-writing tools, reads only through the read tools;
 * Req 11.1), the ask-then-propose-then-`create_spec`-after-agreement flow
 * (Req 11.2), the section-5 todo grammar (Req 11.3) and the section-5
 * frontmatter rules (Req 11.4). For a spec conversation it appends the current
 * `spec.md` content when supplied (Req 11.5) and builds without it, without
 * error, when absent (Req 11.7).
 */

/** Which conversation the prompt is being built for. */
export type ConversationKind =
  | { kind: 'workspace' }
  | { kind: 'spec'; slug: string };

/** The eight allowed todo lifecycle states, per tech-sheet section 5. */
const TODO_STATES = [
  'pending',
  'planning',
  'planned',
  'executing',
  'executed',
  'reviewing',
  'done',
  'failed',
] as const;

/** The allowed frontmatter `status` values, per tech-sheet section 5. */
const STATUS_VALUES = ['draft', 'approved', 'in-progress', 'review', 'pr', 'done'] as const;

/** The allowed frontmatter `mode` values, per tech-sheet section 5. */
const MODE_VALUES = ['manual', 'auto'] as const;

/** The frontmatter keys the extension owns and writes, per tech-sheet section 5. */
const EXTENSION_WRITTEN_KEYS = ['base', 'base_commit', 'branch', 'approved_rev', 'pr'] as const;

/** The section-7 role text: what the orchestrator is and is not allowed to do (Req 11.1). */
const ROLE_TEXT = [
  'You are the Baiton chat orchestrator. You author and drive spec files for spec-driven development.',
  'You never edit source code. Your only writes go through the spec-writing tools, which touch `.baiton/specs/**` and nothing else.',
  'You inspect the repository only through the read tools (for example `list_specs`, `read_spec`, `list_files`, `read_file`, `search`, `git_status`, `git_diff`, `git_log`); you never modify files directly.',
].join('\n');

/**
 * The new-spec flow: gather requirements, get agreement, then hand them to the
 * spec-writer harness through `draft_spec`. The orchestrator never proposes the
 * todos itself — a configured sub-agent studies the repository and drafts them.
 */
const FLOW_TEXT = [
  'New spec flow:',
  '1. When the user describes work, inspect the repository with the read tools and ask clarifying questions until you understand what is wanted.',
  '2. Write a short requirements document covering the goal, the constraints, the acceptance criteria, and the files of interest.',
  '3. Get the user to agree to that document. Revise it until they do.',
  '4. Once they agree, call `draft_spec` with a slug and the agreed requirements document.',
  '5. Then tell the user the draft is being written by the configured harness, and that they can watch it in the spec-writer terminal and see the spec appear in the Spec Explorer once it lands.',
  'You never propose the todo list yourself. `draft_spec` hands the requirements to the spec-writer agent, which studies the repository and drafts the OVERVIEW and todos.',
  'After a draft lands you may refine it with `update_overview`, `add_todo`, `edit_todo` and `remove_todo`.',
].join('\n');

/**
 * How the orchestrator writes: answer-first, no restatement, no summarising of
 * tool output the user can expand for themselves, and one question at a time.
 */
const STYLE_TEXT = [
  'Style:',
  '- Answer first. Lead with the answer or the action taken, then add only the detail that changes what the user does next.',
  "- Do not restate the user's request back to them, and do not open with a preamble about what you are about to do.",
  '- Do not summarize tool output. Each tool call is shown in the chat as a row the user can expand, so describe a result only when it changes your answer.',
  '- Keep replies to a few sentences. The one exception is a requirements document, which you present in full.',
  '- Ask one clarifying question at a time, and wait for the answer before asking the next.',
].join('\n');

/** The section-5 todo line grammar (Req 11.3). */
const TODO_GRAMMAR_TEXT = [
  'Todo line grammar (tech-sheet section 5):',
  '- Each todo line has the shape `- [<state>] <id> <title>`, optionally followed by ` (<hints>)` as the last thing on the line.',
  `- \`state\` is one of: ${TODO_STATES.join(', ')}.`,
  '- `id` is `T` followed by two or more digits (for example `T01`), unique in the file, and never renumbered.',
  '- `hints` are groups separated by `;`. `after T01, T02` lists dependency ids. `files: a, b` lists starting files.',
  '- A trailing parenthesis that does not parse as hints is part of the title.',
].join('\n');

/** The section-5 frontmatter rules (Req 11.4). */
const FRONTMATTER_TEXT = [
  'Spec frontmatter rules (tech-sheet section 5):',
  '- Frontmatter is a flat `key: value` block, one key per line, with no nesting.',
  `- \`status\` is one of: ${STATUS_VALUES.join(', ')}.`,
  `- \`mode\` is one of: ${MODE_VALUES.join(', ')}.`,
  `- The keys ${EXTENSION_WRITTEN_KEYS.map((k) => `\`${k}\``).join(', ')} are written by the extension, not by you.`,
].join('\n');

/**
 * Build the system prompt for a conversation.
 *
 * @param kind The conversation this prompt is for (workspace or a spec).
 * @param specContent The current `spec.md` content for a spec conversation, when
 *   available. Ignored for a workspace conversation. When absent for a spec
 *   conversation the prompt is built without it and no error is raised (Req 11.7).
 * @returns The assembled system-prompt text.
 */
export function buildSystemPrompt(kind: ConversationKind, specContent?: string): string {
  const sections: string[] = [ROLE_TEXT, FLOW_TEXT, STYLE_TEXT, TODO_GRAMMAR_TEXT, FRONTMATTER_TEXT];

  if (kind.kind === 'spec' && specContent !== undefined) {
    sections.push(['Current spec file content:', '', specContent].join('\n'));
  }

  return sections.join('\n\n');
}
