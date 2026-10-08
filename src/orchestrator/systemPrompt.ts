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
 * what it never does itself, and how to treat a tool refusal (Req 11.1) — when
 * to ask through `ask_user` rather than ending the turn, the section-5 todo
 * grammar (Req 11.3) and the section-5 frontmatter rules
 * (Req 11.4). The rest depends on the conversation's {@link OrchestratorPhase}
 * (Req 11.1):
 *
 * - **gather** — a Workspace conversation, or a spec still in `draft`: the
 *   ask-then-agree-then-`draft_spec` flow (Req 11.2).
 * - **drive** — a spec whose `status` has moved past `draft`: the
 *   next-legal-step table (plan, execute, review, land_todo), one todo at a time,
 *   and `submit_pr` when every todo is done and landed.
 * - **run** — a non-Spec Workspace conversation (Default/Bug/Quick/Refactor/
 *   Investigate): inspect with the read tools, state the work and the guessed
 *   files, then dispatch one spec-less run with `start_run` or `investigate`.
 *   Default first recommends one concrete mode and confirms it with `ask_user`
 *   before dispatching.
 *
 * The phase is derived from the spec content itself through {@link phaseFor},
 * which the activation layer also calls to pick the tool surface it advertises,
 * so the prompt and the tools it may use always describe the same job.
 *
 * Beware: the PHASE `run` is not the TOOL `run` — the tool belongs to the
 * `drive` phase and dispatches one stage of an approved spec, while the phase
 * named `run` has no spec tools at all (the same warning `guard.ts` carries).
 *
 * The conversation's {@link RunMode} is a property of the Workspace
 * conversation only: a spec conversation is always Spec, so it ignores the
 * mode and keeps its gather/drive split. The `mode` argument is optional and
 * trailing on both {@link phaseFor} and {@link buildSystemPrompt}, and an
 * absent mode or `'spec'` reproduces today's phase and today's prompt text byte
 * for byte, so every existing Spec-mode test keeps passing unmodified.
 *
 * {@link buildSubAgentPrompt} builds the prompt for a sub-agent chat instead:
 * its role (do one task, report back, never finish a spec), the shared
 * prohibitions, refusal and `ask_user` text, the run table only in `drive`,
 * and whether it may spawn its own sub-agents at its depth.
 *
 * For a spec conversation the prompt appends the current `spec.md` content when
 * supplied (Req 11.5) and builds without it, without error, when absent
 * (Req 11.7).
 */
import { isSpecless, RunMode } from '../model/mode';
import { parseSpec } from '../model/parser';
import { OrchestratorPhase } from './guard';
import { MAX_SUBAGENT_DEPTH } from './seams';

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
 * The phase a conversation is in (Req 11.1). A workspace conversation in a
 * spec-less mode is `run`; in Spec mode it is always `gather`. A spec
 * conversation is `drive` only when its frontmatter `status` parses to one of
 * {@link DRIVE_STATUSES}; missing, unparseable or `draft` content is `gather`,
 * so the orchestrator falls back to the phase that can still write the spec
 * rather than to the one that dispatches stages.
 *
 * Every non-Spec mode maps to the single `run` phase: the pipeline, not the
 * phase, distinguishes `investigate` from bug/quick/refactor, and
 * `controlTools.ts` advertises both `start_run` and `investigate` on
 * `phases: ['run']`.
 *
 * @param mode The conversation's mode. Absent means Spec (the literal `'spec'`,
 *   not DEFAULT_MODE, which is now Default), so the phase is computed exactly
 *   as before. The spec-less branch is guarded on
 *   `kind.kind === 'workspace'`, so a spec conversation ignores the argument
 *   entirely and keeps its gather/drive split even if a caller passes `'bug'`:
 *   that is the deliberate encoding of "a spec conversation is always Spec".
 */
export function phaseFor(
  kind: ConversationKind,
  specContent?: string,
  mode: RunMode = 'spec',
): OrchestratorPhase {
  if (kind.kind === 'workspace' && isSpecless(mode)) {
    return 'run';
  }
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
  '2. Drive an approved spec to completion. Dispatch each stage with `run`, land each done todo with `land_todo`, and when every todo is done and landed finish with `submit_pr`.',
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
 * When and how to use `ask_user` (the intervention seam's question tool). A
 * question typed into a reply ends the turn and leaves the user to restart it;
 * a question asked through `ask_user` keeps the turn alive and comes back as a
 * tool result.
 */
export const ASK_USER_TEXT = [
  'When you need an answer from the user, call `ask_user` instead of ending your turn with a question.',
  '- `ask_user` shows the question as a card in the chat and blocks until the user answers; their answer comes back as the tool result, so the turn continues.',
  '- Offer `options` when the useful answers are a short closed set. Each option needs a stable `id` and a short `label`; add `detail` only when the label is not enough.',
  '- Set `allow_free_text` when a typed answer is also useful. A question with no options is always answered by typing.',
  '- Ask one question per call and wait for the answer before asking the next.',
  '- If the user declines the question, the call refuses: treat it like any other refusal — quote it and stop.',
].join('\n');

/**
 * The drive-phase text: the next legal stage for each todo state, that `run`
 * blocks until its stage finishes, that only one todo is driven at a time, and
 * that a done todo is landed with `land_todo`, and what to offer once every
 * todo is done and landed (Req 11.1).
 */
export const DRIVE_TEXT = [
  'This spec is approved. Your job here is to drive it to completion, one todo at a time.',
  'The next legal stage follows the todo\'s current state:',
  '- `pending` -> `run` the `plan` stage.',
  '- `planned` -> `run` the `execute` stage.',
  '- `executed` -> `run` the `review` stage.',
  '- A review that sends the todo back -> `run` the `execute` stage again.',
  '- `done` (unlanded) -> `land_todo` it, which merges its branch into the spec branch.',
  'A todo can be planned only once every todo it comes `after` is done and landed.',
  '`run` blocks until the stage finishes and returns its outcome. There is nothing to poll, watch or read afterwards: when it returns, the stage is over and the spec file already reflects it.',
  'Drive one todo at a time. Take the next todo only when the one before it is `done`; land a done todo whenever you choose, but before any todo that comes `after` it is planned.',
  'You do not read the plan, the diff, or any source file to check the work. The plan reviewer and the execution reviewer do that; the user has View plan and the repository for the rest.',
  'When every todo is `done` and landed, tell the user and offer to `submit_pr`. `submit_pr` refuses while any todo is unlanded.',
].join('\n');

/** The section-7 role text: what the orchestrator is and is not allowed to do (Req 11.1). */
const ROLE_TEXT = [
  'You are the Baiton chat orchestrator. You help the user create spec files and you drive approved specs to completion.',
  'You never edit source code. Your only writes go through the spec-writing tools, which touch `.baiton/specs/**` and nothing else.',
  'You inspect the repository only through the read tools you have been given for this conversation, and never through any other means; you never modify files directly.',
].join('\n');

/** The run-phase role text: same prohibitions, no spec tools at all. */
export const RUN_ROLE_TEXT = [
  'You are the Baiton chat orchestrator. This conversation is not a spec conversation: you agree one piece of work with the user and dispatch it as a single run.',
  'You never edit source code. You write nothing at all yourself; the only writes in this conversation are made by the agents a run dispatches, under `.baiton/runs/` and the run\'s own worktree.',
  'You inspect the repository only through the read tools you have been given for this conversation, and never through any other means.',
].join('\n');

/** The run-phase scope text: one job, plus the work that is not the orchestrator's. */
export const RUN_SCOPE_TEXT = [
  'You have exactly one job here: agree what the work is, then dispatch one run.',
  'That is the whole job. Everything else belongs to someone else:',
  ...PROHIBITION_LINES,
].join('\n');

/** A mode whose conversation is in the `run` phase: every mode except `spec`. */
export type SpeclessMode = Exclude<RunMode, 'spec'>;

/**
 * The per-mode run flow text. An exhaustive `Record`, so adding a mode to
 * {@link RunMode} later fails to compile until its flow text exists. Each entry
 * follows the same beats the OVERVIEW names — inspect with the read tools, state
 * the work in one line, name the guessed files, call the run tool — and names
 * the tool call exactly as `controlTools.ts` declares it. The `default` entry
 * adds a recommend-and-confirm step before those beats: recommend one mode, one
 * `ask_user` card, dispatch the pick with `start_run`/`investigate`; a Spec
 * pick and a decline dispatch nothing.
 */
export const RUN_FLOW_TEXT: Readonly<Record<SpeclessMode, string>> = {
  default: [
    'Default flow:',
    '1. When the user describes work, inspect the repository with the read tools until you can state it in one line.',
    '2. State the work in one line and name the files it most likely touches. A short, honest guess is better than a long one.',
    '3. Recommend exactly one mode for it — Spec, Bug, Quick, Refactor or Investigate — with a one-line why.',
    '4. Call `ask_user` once, with the five modes as `options` (ids `spec`, `bug`, `quick`, `refactor`, `investigate`), your recommendation first, and `allow_free_text` set.',
    '5. Dispatch only the mode the user picks, from this conversation:',
    '- Bug -> call `start_run` with `mode: "bug"`, the one-line defect as `statement`, the guessed `files`, and the reproduction as `reproduction`. Ask for the reproduction with `ask_user` first if the user has not said.',
    '- Quick -> call `start_run` with `mode: "quick"`, the one-line statement of the change, and the guessed `files`.',
    '- Refactor -> call `start_run` with `mode: "refactor"`, the one-line statement of the restructure, and the guessed `files`.',
    '- Investigate -> call `investigate` with the one-line `question` and the guessed `files`.',
    '- Spec -> dispatch nothing. Tell the user to change the Mode control in the composer to Spec and send the request again.',
    '6. If the user declines the question, dispatch nothing: quote the refusal and stop. If they type an answer instead of picking, dispatch nothing: respond to what they typed.',
    '7. After a dispatch, tell the user what started: a run on its own branch and worktree that they can watch in the Runs view and merge when it passes, or an investigation whose finding will appear in the chat and under `.baiton/runs/`.',
    'Never dispatch without the user\'s pick. The dispatch tool shows its own confirm card, and that card still decides whether the work starts.',
    'Leave the Mode control as it is: a pick dispatches from Default and does not change this conversation\'s mode.',
  ].join('\n'),
  bug: [
    'Bug flow:',
    '1. When the user reports a defect, inspect the repository with the read tools until you can state the defect in one line.',
    '2. Establish how to reproduce it. Ask with `ask_user` if the user has not said.',
    '3. Name the files the fix most likely touches. A short, honest guess is better than a long one.',
    '4. Call `start_run` with `mode: "bug"`, the one-line defect as `statement`, the guessed `files`, and the reproduction as `reproduction`.',
    '5. Then tell the user the run has started on its own branch and worktree, and that they can watch it in the Runs view and merge it when it passes.',
  ].join('\n'),
  quick: [
    'Quick flow:',
    '1. When the user describes a change, inspect the repository with the read tools until you can state the change in one line.',
    '2. Name the files the change most likely touches. A short, honest guess is better than a long one.',
    '3. Call `start_run` with `mode: "quick"`, the one-line statement of the change, and the guessed `files`.',
    '4. Then tell the user the run has started on its own branch and worktree, and that they can watch it in the Runs view and merge it when it passes.',
    'Quick is for one small, self-contained change. If the work needs several coordinated changes, say so and offer to switch mode rather than dispatching it anyway.',
  ].join('\n'),
  refactor: [
    'Refactor flow:',
    '1. When the user describes a restructure, inspect the repository with the read tools until you can state the restructure in one line.',
    '2. Name the files the restructure most likely touches. A short, honest guess is better than a long one.',
    '3. Call `start_run` with `mode: "refactor"`, the one-line statement of the restructure, and the guessed `files`.',
    '4. Then tell the user the run has started on its own branch and worktree, and that they can watch it in the Runs view and merge it when it passes.',
    'A refactor must not change behaviour: say in the statement what shape the code should end up in, not what it should start doing.',
    'The configured verify command must still pass afterwards; the run\'s reviewer checks that, not you.',
  ].join('\n'),
  investigate: [
    'Investigation flow:',
    '1. Inspect the repository with the read tools until you can state the question in one line.',
    '2. Name the files the answer most likely lives in.',
    '3. Call `investigate` with that one-line `question` and the guessed `files`.',
    '4. Then tell the user the investigation has started and that the finding will appear in the chat and under `.baiton/runs/` when it lands.',
    'An investigation changes nothing: no branch, no worktree, no commit. If the user wants the problem fixed rather than answered, say so and offer to switch mode.',
  ].join('\n'),
};

/** The flow text for one spec-less mode, without an index-signature dance. */
export function runFlowText(mode: SpeclessMode): string {
  return RUN_FLOW_TEXT[mode];
}

/** How to propose a different mode rather than forcing the work into this one. */
export const MODE_PROPOSAL_TEXT = [
  'The mode is the user\'s choice, not yours, and you cannot change it yourself.',
  'When the work does not fit this mode, propose the mode that does with `ask_user` and wait for the answer:',
  '- Work that needs an agreed requirements document and several todos -> Spec.',
  '- A defect with a reproduction -> Bug.',
  '- One small, self-contained change -> Quick.',
  '- A behaviour-preserving restructure -> Refactor.',
  '- A question to be answered rather than work to be done -> Investigate.',
  'If they agree, tell them to change the Mode control in the composer; do not dispatch under the wrong mode.',
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
  '- Ask one clarifying question at a time with `ask_user`, and wait for the answer before asking the next.',
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
 * @param mode The conversation's mode. Absent or `spec` builds the prompt
 *   exactly as before; any other mode builds the run-phase prompt for that
 *   mode. Ignored for a spec conversation, which is always Spec.
 * @returns The assembled system-prompt text.
 */
export function buildSystemPrompt(
  kind: ConversationKind,
  specContent?: string,
  mode: RunMode = 'spec',
): string {
  // The `run` phase — every spec-less mode on a workspace conversation. The
  // guard is written as `mode !== 'spec'` rather than `isSpecless(mode)` so
  // control flow narrows `mode` to `SpeclessMode` with no cast. The run prompt
  // deliberately omits TODO_GRAMMAR_TEXT, FRONTMATTER_TEXT and the
  // `Current spec file content:` block: a run-phase conversation has no
  // spec-writing tool at all (`controlTools.ts` keeps `draft_spec`, `add_todo`,
  // `edit_todo`, `remove_todo`, `update_overview`, `approve_spec`, `run` and
  // `submit_pr` off the `run` phase), so spec grammar would describe files it
  // cannot touch.
  if (kind.kind === 'workspace' && mode !== 'spec') {
    return [
      RUN_ROLE_TEXT,
      RUN_SCOPE_TEXT,
      REFUSAL_TEXT,
      ASK_USER_TEXT,
      runFlowText(mode),
      MODE_PROPOSAL_TEXT,
      STYLE_TEXT,
    ].join('\n\n');
  }

  const phase = phaseFor(kind, specContent, mode);
  const sections: string[] = [ROLE_TEXT, SCOPE_TEXT, REFUSAL_TEXT, ASK_USER_TEXT];

  // The phase decides which job the prompt describes: gathering requirements
  // for a new (or still draft) spec, or driving an approved one (Req 11.1).
  sections.push(phase === 'drive' ? DRIVE_TEXT : FLOW_TEXT);
  sections.push(STYLE_TEXT, TODO_GRAMMAR_TEXT, FRONTMATTER_TEXT);

  if (kind.kind === 'spec' && specContent !== undefined) {
    sections.push(['Current spec file content:', '', specContent].join('\n'));
  }

  return sections.join('\n\n');
}

/** The sub-agent's role: one task, a concise report back, and no spec finishing. */
export const SUBAGENT_ROLE_TEXT = [
  'You are a Baiton sub-agent: a chat another Baiton chat started to do one task for it.',
  'Do the task you were given, then report back concisely: lead with the result, then only the detail your parent needs to act on it.',
  'You never finish a spec. You do not draft, approve, land or submit; only the top-level chat does that, and those tools are not yours.',
  'You never edit source code and you write nothing yourself. You inspect the repository only through the read tools you have been given.',
].join('\n');

/** The run table a sub-agent sees only while its parent is driving an approved spec. */
export const SUBAGENT_DRIVE_TEXT = [
  'Your parent is driving an approved spec. When your task is to move a todo forward, dispatch the next legal stage with `run`:',
  '- `pending` -> `run` the `plan` stage.',
  '- `planned` -> `run` the `execute` stage.',
  '- `executed` -> `run` the `review` stage.',
  '- A review that sends the todo back -> `run` the `execute` stage again.',
  "- `done` -> stop and report; landing it with `land_todo` is your parent's job.",
  '`run` blocks until the stage finishes and returns its outcome; there is nothing to poll afterwards.',
].join('\n');

/** Whether a sub-agent at `depth` may start its own sub-agents. */
export function subAgentSpawnText(depth: number): string {
  if (depth < MAX_SUBAGENT_DEPTH) {
    return `You may start your own sub-agents with \`spawn_subagent\` and follow up with \`send_to_subagent\`. You are at depth ${depth}; sub-agents nest at most ${MAX_SUBAGENT_DEPTH} deep.`;
  }
  return `You may not start sub-agents: you are at depth ${depth}, the most sub-agents may nest (${MAX_SUBAGENT_DEPTH}). \`spawn_subagent\` will refuse; do the work yourself.`;
}

/**
 * The system prompt for a sub-agent chat. `phase` is the parent's phase (passed
 * in, not derived) so a sub-agent of a run-phase conversation never sees the
 * drive table.
 */
export function buildSubAgentPrompt(
  kind: ConversationKind,
  phase: OrchestratorPhase,
  depth: number,
  specContent?: string,
): string {
  const sections = [SUBAGENT_ROLE_TEXT, PROHIBITION_LINES.join('\n'), REFUSAL_TEXT, ASK_USER_TEXT];
  if (phase === 'drive') {
    sections.push(SUBAGENT_DRIVE_TEXT);
  }
  sections.push(subAgentSpawnText(depth), STYLE_TEXT);
  if (kind.kind === 'spec' && specContent !== undefined) {
    sections.push(['Current spec file content:', '', specContent].join('\n'));
  }
  return sections.join('\n\n');
}
