/**
 * System-prompt builder (host-free core, Requirement 11).
 *
 * A pure function of the conversation kind and the current spec content. It
 * produces the instruction text prepended to a conversation's messages,
 * derived from tech-sheet sections 5 (the spec file) and 7 (the chat
 * orchestrator). It carries no `vscode` import so it is directly unit-testable
 * without a host.
 *
 * The prompt always states the orchestrator's role and scope — its two jobs,
 * what it never does itself, and how to treat a tool refusal (Req 11.1) — the
 * section-5 todo grammar (Req 11.3) and the section-5 frontmatter rules
 * (Req 11.4). The rest depends on the conversation's {@link OrchestratorPhase}
 * (Req 11.1):
 *
 * - **gather** — a Workspace conversation, or a spec still in `draft`: the
 *   ask-then-agree-then-`draft_spec` flow (Req 11.2).
 * - **drive** — a spec whose `status` has moved past `draft`: the next-legal-
 *   stage table, one todo at a time, and `submit_pr` when every todo is done.
 *
 * The phase is derived from the spec content itself through {@link phaseFor},
 * which the activation layer also calls to pick the tool surface it advertises,
 * so the prompt and the tools it may use always describe the same job.
 *
 * For a spec conversation the prompt appends the current `spec.md` content when
 * supplied (Req 11.5) and builds without it, without error, when absent
 * (Req 11.7).
 */
import { parseSpec } from '../model/parser';
import { OrchestratorPhase } from './guard';

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

/**
 * The frontmatter `status` values that mean the spec is being driven rather
 * than still being written (Req 11.1). A spec with any of these is in the
 * `drive` phase; `draft`, an unknown value, or no status at all is `gather`.
 */
const DRIVE_STATUSES: readonly string[] = [
  'approved',
  'in-progress',
  'review',
  'pr',
  'done',
] as const;

/**
 * The phase a conversation is in (Req 11.1). A workspace conversation is always
 * `gather`. A spec conversation is `drive` only when its frontmatter `status`
 * parses to one of {@link DRIVE_STATUSES}; missing, unparseable or `draft`
 * content is `gather`, so the orchestrator falls back to the phase that can
 * still write the spec rather than to the one that dispatches stages.
 */
export function phaseFor(kind: ConversationKind, specContent?: string): OrchestratorPhase {
  if (kind.kind !== 'spec' || specContent === undefined) {
    return 'gather';
  }
  const status = (parseSpec(specContent).frontmatter.get('status') ?? '').trim();
  return DRIVE_STATUSES.includes(status) ? 'drive' : 'gather';
}

/**
 * The things the orchestrator never does itself (Req 11.1). Exported so the
 * prohibitions can be asserted verbatim: each is a separate sentence because
 * the failure they exist to prevent is the orchestrator deciding that one
 * particular job ("just this once, review the plan myself") is its own.
 */
export const PROHIBITION_LINES: readonly string[] = [
  'You do not write specs.',
  'You do not write plans.',
  'You do not review plans.',
  'You do not execute plans.',
  'You do not review executions.',
  'A configured coding agent does each of those when you dispatch it.',
] as const;

/**
 * The scope text: the orchestrator's two jobs, in plain words, followed by the
 * work that is not its own (Req 11.1). Present in every phase.
 */
export const SCOPE_TEXT = [
  'You have exactly two jobs.',
  '1. Help the user create a spec. Ask clarifying questions until you and the user agree on what the work is, then hand the agreed requirements to the spec writer with `draft_spec`.',
  '2. Drive an approved spec to completion. Dispatch each stage with `run` until every todo is done, then finish with `submit_pr`.',
  'That is the whole job. Everything else belongs to someone else:',
  ...PROHIBITION_LINES,
].join('\n');

/**
 * How to treat a refusal from any tool (Req 11.1). A refusal is an answer for
 * the user, not a puzzle to route around: the orchestrator quotes it and stops
 * rather than diagnosing it, trying a different stage, or reading source files
 * to work out what happened.
 */
export const REFUSAL_TEXT = [
  'When a tool refuses:',
  '- Quote the refusal to the user and stop.',
  '- Do not diagnose it. Do not try a different stage. Do not read files to work around it.',
  '- The user decides what happens next.',
].join('\n');

/**
 * The drive-phase text: the next legal stage for each todo state, that `run`
 * blocks until its stage finishes, that only one todo is driven at a time, and
 * what to offer once every todo is done (Req 11.1).
 */
export const DRIVE_TEXT = [
  'This spec is approved. Your job here is to drive it to completion, one todo at a time.',
  'The next legal stage follows the todo\'s current state:',
  '- `pending` -> `run` the `plan` stage.',
  '- `planned` -> `run` the `execute` stage.',
  '- `executed` -> `run` the `review` stage.',
  '- A review that sends the todo back -> `run` the `execute` stage again.',
  '`run` blocks until the stage finishes and returns its outcome. There is nothing to poll, watch or read afterwards: when it returns, the stage is over and the spec file already reflects it.',
  'Drive one todo at a time. Take the next todo only when the one before it is `done`.',
  'You do not read the plan, the diff, or any source file to check the work. The plan reviewer and the execution reviewer do that; the user has View plan and the repository for the rest.',
  'When every todo is `done`, tell the user and offer to `submit_pr`.',
].join('\n');

/** The section-7 role text: what the orchestrator is and is not allowed to do (Req 11.1). */
const ROLE_TEXT = [
  'You are the Baiton chat orchestrator. You help the user create spec files and you drive approved specs to completion.',
  'You never edit source code. Your only writes go through the spec-writing tools, which touch `.baiton/specs/**` and nothing else.',
  'You inspect the repository only through the read tools you have been given for this conversation, and never through any other means; you never modify files directly.',
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
 *   available. Ignored for a workspace conversation. It also decides the phase
 *   (Req 11.1). When absent for a spec conversation the prompt is built without
 *   it, in the `gather` phase, and no error is raised (Req 11.7).
 * @returns The assembled system-prompt text.
 */
export function buildSystemPrompt(kind: ConversationKind, specContent?: string): string {
  const phase = phaseFor(kind, specContent);
  const sections: string[] = [ROLE_TEXT, SCOPE_TEXT, REFUSAL_TEXT];

  // The phase decides which job the prompt describes: gathering requirements
  // for a new (or still draft) spec, or driving an approved one (Req 11.1).
  sections.push(phase === 'drive' ? DRIVE_TEXT : FLOW_TEXT);
  sections.push(STYLE_TEXT, TODO_GRAMMAR_TEXT, FRONTMATTER_TEXT);

  if (kind.kind === 'spec' && specContent !== undefined) {
    sections.push(['Current spec file content:', '', specContent].join('\n'));
  }

  return sections.join('\n\n');
}
