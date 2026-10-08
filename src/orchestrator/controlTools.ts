/**
 * The orchestrator's control tools (Requirements 10.1–10.7, 5.2, 5.5,
 * 16.1–16.6, 17.1).
 *
 * - `ask_user(question, options?, allow_free_text?, placeholder?)` (neither
 *   mutating nor dispatch) — ask the user a question through the intervention
 *   seam and return their answer as the tool result. The call blocks until the
 *   card is answered; a decline (including Stop) comes back as a refusal.
 * - `approve_spec(slug)` (mutating) — confirm in the UI first (Req 10.1); on a
 *   decline or cancel leave the spec unchanged (Req 10.2). On a fresh approval
 *   it checks the tree is clean except the spec's own folder (Req 16.1, 16.2),
 *   fetches the remote and resolves the base branch to a commit, recording it
 *   as `base_commit` (Req 16.3, 16.4), creates the spec branch from that
 *   commit, checks it out (Req 16.5, 16.6), records `branch` and `status:
 *   approved`, computes the Approval_Hash into `approved_rev` (Req 5.2), and
 *   commits `spec(<slug>): approve` (Req 16.5). A re-approval (the spec already
 *   carries an `approved_rev`) recomputes the Approval_Hash into `approved_rev`
 *   and leaves every todo's state unchanged (Req 5.5).
 * - `draft_spec(slug, requirements)` (dispatch) — hand an agreed requirements
 *   document to the spec-writer harness, which drafts the spec's OVERVIEW and
 *   todo list and writes `.baiton/specs/<slug>/spec.md`. Confirms a summary of
 *   the requirements through the confirm seam first; a decline drafts nothing.
 *   Returns as soon as the sub-agent is running, carrying its run id.
 * - `start_run(mode, statement, files, reproduction?)` (dispatch) — start one
 *   spec-less bug/quick/refactor run. It raises the confirm card (mode,
 *   one-line statement, guessed files, target branch) through the intervention
 *   seam, returns as soon as the run is launched, and writes nothing on a
 *   decline.
 * - `investigate(question, files)` (dispatch) — start one read-only
 *   investigation. It raises the same confirm card (mode, the question as the
 *   one-line statement, guessed files, target branch) through the intervention
 *   seam, returns as soon as the run is launched, and writes nothing on a
 *   decline.
 * - `run(slug, todo, stage)` (dispatch) — dispatch exactly one legal stage
 *   transition (`plan`, `execute` or `review`) through the run-queue seam and
 *   block until it reaches a terminal outcome; refuse when a stage is already
 *   running (Req 10.4) or the transition is illegal (Req 10.5). `plan-review`
 *   is not a standalone trigger — it runs inside the Plan action's review
 *   rounds — so the tool does not offer it and rejects it outright.
 * - `land_todo(slug, todo)` (mutating, no confirm) — refuses unless the todo is
 *   `done`, merges its branch into the spec branch through the land seam, and
 *   reports the merge commit or `already landed`.
 * - `submit_pr(slug)` (mutating) — run Verify then the PR stage once every todo
 *   is done and landed.
 *
 * - `spawn_subagent(task)` and `send_to_subagent(chat_id, message)` (neither
 *   mutating nor dispatch) — start a sub-agent chat and wait for its first
 *   reply, or send it a follow-up. They go through the sub-agent seam, need a
 *   calling chat, and `spawn_subagent` is refused at depth
 *   {@link MAX_SUBAGENT_DEPTH}. They are on every phase and on both tool
 *   surfaces; `ask_user`, `run` and the read tools are the only other
 *   sub-agent tools.
 *
 * Each tool declares the orchestrator phases it belongs to (Req 11.1):
 * `draft_spec` only while gathering requirements, `run`, `land_todo` and `submit_pr` only
 * while driving an approved spec, `approve_spec` in both, and `ask_user` in all
 * three — a run-mode conversation agrees the work through it too.
 * `start_run` and `investigate` belong only to the `run` phase, so they are
 * unavailable in a Spec conversation, exactly as `draft_spec`, `run` and
 * `submit_pr` are unavailable in a run-mode one.
 *
 * Every extension write under the spec folder is committed on the spec branch
 * as `spec(<slug>): <id> <what>` before any subsequent stage (Req 17.1); the
 * approval commit uses the fixed `spec(<slug>): approve` message the design
 * mandates (Req 16.5).
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { approvalHash } from '../model/hash';
import { parseSpec } from '../model/parser';
import { validateSpec } from '../model/validator';
import { RunMode, isRunMode } from '../model/mode';
import { Stage, isStage } from '../model/stage';
import { setFrontmatterKey } from '../model/writer';
import { Tool, ToolContext, ToolResult } from './guard';
import type { InterventionOption } from './interventions';
import { MAX_SUBAGENT_DEPTH } from './seams';
import { ToolServices } from './toolServices';

/** Build every control tool for the registry. */
export function createControlTools(services: ToolServices): Tool[] {
  return [
    askUserTool(services),
    draftSpecTool(services),
    startRunTool(services),
    investigateTool(services),
    approveSpecTool(services),
    runTool(services),
    landTodoTool(services),
    submitPrTool(services),
    spawnSubAgentTool(services),
    sendToSubAgentTool(services),
  ];
}

/**
 * `ask_user(question, options?, allow_free_text?, placeholder?)` — ask the user
 * a question through the intervention seam and block until the card is
 * answered; their answer comes back as the tool result. Neither mutating nor a
 * dispatch, so it stays usable under Restricted Mode. Every argument is
 * validated before the seam is touched, so a malformed call never raises a
 * card; a decline (including a Stop-driven one) comes back as a refusal.
 */
function askUserTool(services: ToolServices): Tool {
  return {
    name: 'ask_user',
    description:
      'Ask the user a question and wait for their answer: offer a short list of options, accept a typed reply, or both. Use this instead of ending your turn with a question.',
    mutating: false,
    phases: ['gather', 'drive', 'run'],
    subagent: true,
    schema: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        options: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              label: { type: 'string' },
              detail: { type: 'string' },
            },
            required: ['id', 'label'],
            additionalProperties: false,
          },
        },
        allow_free_text: { type: 'boolean' },
        placeholder: { type: 'string' },
      },
      required: ['question'],
      additionalProperties: false,
    },
    async run(args: unknown, _tc: ToolContext): Promise<ToolResult> {
      const question = readString(args, 'question');
      if (question === undefined || question.trim().length === 0) {
        return { ok: false, error: 'ask_user requires a non-empty string "question"' };
      }
      const optionsRead = readOptions(args);
      if (!optionsRead.ok) {
        return { ok: false, error: optionsRead.error };
      }
      const options = optionsRead.options;

      const freeRead = readBoolean(args, 'allow_free_text');
      if (!freeRead.ok) {
        return { ok: false, error: freeRead.error };
      }
      const allowFreeText = freeRead.value;
      const placeholder = readString(args, 'placeholder');

      if (services.intervention === undefined) {
        return { ok: false, error: 'ask_user is not available in this host' };
      }

      const answer = await services.intervention.ask({
        kind: 'question',
        prompt: question.trim(),
        ...(options.length > 0 ? { options } : {}),
        ...(allowFreeText !== undefined ? { allowFreeText } : {}),
        ...(placeholder !== undefined ? { placeholder } : {}),
      });

      switch (answer.kind) {
        case 'option':
          return {
            ok: true,
            data: {
              answer: 'option',
              optionId: answer.optionId,
              label:
                answer.label ??
                options.find((o) => o.id === answer.optionId)?.label,
            },
          };
        case 'text':
          return { ok: true, data: { answer: 'text', text: answer.text } };
        case 'declined':
          return {
            ok: false,
            error:
              'the question was not answered' +
              (answer.reason ? `: ${answer.reason}` : ''),
          };
        default:
          return { ok: false, error: 'ask_user received an approval instead of an answer' };
      }
    },
  };
}

/**
 * `draft_spec(slug, requirements)` — dispatch the spec-writer harness to turn an
 * agreed requirements document into a spec.
 *
 * The orchestrator gathers the requirements with the user and never proposes
 * the todos itself; the configured spec-writer agent studies the repository and
 * drafts them. Like every dispatch tool it is disabled under Restricted Mode.
 * The user confirms a summary of the requirements before anything launches; a
 * decline leaves the repository untouched.
 */
function draftSpecTool(services: ToolServices): Tool {
  return {
    name: 'draft_spec',
    description:
      'Hand an agreed requirements document to the spec-writer agent, which studies the repository and drafts the spec (overview and todos) for a new slug.',
    mutating: false,
    phases: ['gather'],
    dispatch: true,
    schema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        requirements: { type: 'string' },
      },
      required: ['slug', 'requirements'],
      additionalProperties: false,
    },
    async run(args: unknown, tc: ToolContext): Promise<ToolResult> {
      const slug = readString(args, 'slug');
      const requirements = readString(args, 'requirements');
      if (slug === undefined || requirements === undefined) {
        return {
          ok: false,
          error: 'draft_spec requires a string "slug" and a string "requirements"',
        };
      }
      if (!isSlug(slug)) {
        return { ok: false, error: `invalid slug: ${slug}` };
      }
      if (requirements.trim().length === 0) {
        return { ok: false, error: 'draft_spec "requirements" must not be empty' };
      }
      if (services.draftSpec === undefined) {
        return { ok: false, error: 'draft_spec is not available in this host' };
      }

      // The draft creates the spec folder, so resolve the target through the
      // guard: it may only ever land under `.baiton/specs/` (Req 8.1, 8.2).
      const resolved = await tc.ctx.resolveMutatingPath(specPath(services, slug));
      if (!resolved.ok) {
        return { ok: false, error: resolved.error.message };
      }
      // A draft only ever creates a spec; it never overwrites one.
      if (await exists(resolved.resolved)) {
        return { ok: false, error: `spec "${slug}" already exists` };
      }

      const confirmed = await services.confirm.confirm(
        draftConfirmation(slug, requirements),
      );
      if (!confirmed) {
        return {
          ok: false,
          error: `drafting spec "${slug}" was declined; nothing was written`,
        };
      }

      const outcome = await services.draftSpec.draft({ slug, requirements });
      switch (outcome.kind) {
        case 'started':
          return { ok: true, data: { runId: outcome.runId } };
        case 'busy':
          return {
            ok: false,
            error: 'a stage is already running for this repository; try again after it finishes',
          };
        case 'refused':
          return { ok: false, error: `the spec draft did not start: ${outcome.reason}` };
        default:
          return { ok: false, error: 'draft_spec dispatch returned an unknown outcome' };
      }
    },
  };
}

/**
 * The confirmation message shown before a draft launches: the slug plus a
 * bounded summary of the requirements so the user sees what the spec writer is
 * being handed.
 */
function draftConfirmation(slug: string, requirements: string): string {
  const trimmed = requirements.trim();
  const summary =
    trimmed.length > 1200 ? `${trimmed.slice(0, 1200)}\n…` : trimmed;
  return (
    `Draft spec "${slug}" from these requirements? ` +
    'The configured spec-writer agent will study the repository and write the ' +
    `overview and todos.\n\n${summary}`
  );
}

/** Whether a path exists on disk. */
async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * `start_run(mode, statement, files, reproduction?)` — start one spec-less
 * bug/quick/refactor run through the run-pipeline seam.
 *
 * Every argument is validated before the card is raised and before the seam is
 * touched, so a malformed call asks nothing and dispatches nothing. A decline
 * writes nothing and dispatches nothing. Unlike `run`, the tool returns as soon
 * as the run is launched — it does not block on the run finishing. It is a
 * dispatch tool, so the guard disables it under Restricted Mode (Req 22.2).
 */
function startRunTool(services: ToolServices): Tool {
  return {
    name: 'start_run',
    description:
      'Start a spec-less run (bug, quick or refactor): hand a one-line statement of the work and the files involved to the planner, which plans, executes and reviews it on its own branch.',
    mutating: false,
    phases: ['run'],
    dispatch: true,
    schema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['bug', 'quick', 'refactor'] },
        statement: { type: 'string' },
        files: { type: 'array', items: { type: 'string' } },
        reproduction: { type: 'string' },
      },
      required: ['mode', 'statement', 'files'],
      additionalProperties: false,
    },
    async run(args: unknown, _tc: ToolContext): Promise<ToolResult> {
      const mode = readString(args, 'mode');
      if (mode === undefined || !isRunMode(mode) || !RUN_TOOL_MODES.includes(mode)) {
        return {
          ok: false,
          error:
            `start_run "mode" must be one of bug, quick, refactor: ${mode}. ` +
            'Use investigate for a read-only question, and the spec tools for spec work.',
        };
      }

      const statementRead = readOneLine(args, 'statement', 'start_run');
      if (!statementRead.ok) {
        return { ok: false, error: statementRead.error };
      }
      const statement = statementRead.value;

      const filesRead = readFileList(args, 'start_run');
      if (!filesRead.ok) {
        return { ok: false, error: filesRead.error };
      }
      const files = filesRead.files;

      let reproduction: string | undefined;
      if (typeof args === 'object' && args !== null) {
        const raw = (args as Record<string, unknown>)['reproduction'];
        if (raw !== undefined) {
          if (typeof raw !== 'string' || raw.trim().length === 0) {
            return {
              ok: false,
              error: 'start_run "reproduction" must be a non-empty string when given',
            };
          }
          reproduction = raw.trim();
        }
      }

      if (services.runPipeline === undefined) {
        return { ok: false, error: 'start_run is not available in this host' };
      }

      const branch = await targetBranch(services);
      const detail = [
        `Mode: ${mode}`,
        `Work: ${statement}`,
        `Files: ${files.length > 0 ? files.join(', ') : '(none guessed)'}`,
        ...(reproduction !== undefined ? [`Reproduction: ${reproduction}`] : []),
        `Target branch: ${branch}`,
        'The run works on its own branch and worktree; nothing outside .baiton/runs/ and .baiton/worktrees/ changes until you merge it.',
      ].join('\n');
      const confirmed = await askConfirmCard(services, `Start a ${mode} run?`, detail);
      if (!confirmed) {
        return { ok: false, error: `starting the ${mode} run was declined; nothing was written` };
      }

      const outcome = await services.runPipeline.start({
        mode,
        statement,
        files,
        ...(reproduction !== undefined ? { reproduction } : {}),
      });
      switch (outcome.kind) {
        case 'started':
          return {
            ok: true,
            data: {
              runId: outcome.runId,
              mode,
              ...(outcome.branch !== undefined ? { branch: outcome.branch } : {}),
            },
          };
        case 'busy':
          return {
            ok: false,
            error: 'a stage is already running for this repository; try again after it finishes',
          };
        case 'refused':
          return { ok: false, error: `the run did not start: ${outcome.reason}` };
        default:
          return { ok: false, error: 'start_run dispatch returned an unknown outcome' };
      }
    },
  };
}

/**
 * `investigate(question, files)` — start one read-only investigation through
 * the run-pipeline seam.
 *
 * Arguments are validated before the card and before the seam, so a malformed
 * call asks nothing and dispatches nothing; a decline writes nothing. The tool
 * returns as soon as the run is launched rather than blocking on the finding.
 * It is a dispatch tool, so the guard disables it under Restricted Mode
 * (Req 22.2).
 */
function investigateTool(services: ToolServices): Tool {
  return {
    name: 'investigate',
    description:
      'Answer a question about the repository with a read-only investigation: the investigator studies the named files and writes a one-line finding, the files it looked at, and suggested next steps.',
    mutating: false,
    phases: ['run'],
    dispatch: true,
    schema: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        files: { type: 'array', items: { type: 'string' } },
      },
      required: ['question', 'files'],
      additionalProperties: false,
    },
    async run(args: unknown, _tc: ToolContext): Promise<ToolResult> {
      const questionRead = readOneLine(args, 'question', 'investigate');
      if (!questionRead.ok) {
        return { ok: false, error: questionRead.error };
      }
      const question = questionRead.value;

      const filesRead = readFileList(args, 'investigate');
      if (!filesRead.ok) {
        return { ok: false, error: filesRead.error };
      }
      const files = filesRead.files;

      if (services.runPipeline === undefined) {
        return { ok: false, error: 'investigate is not available in this host' };
      }

      const branch = await targetBranch(services);
      const detail = [
        'Mode: investigate',
        `Question: ${question}`,
        `Files: ${files.length > 0 ? files.join(', ') : '(none guessed)'}`,
        `Target branch: ${branch}`,
        'Read-only: no branch, no worktree and no commit. The only write is the finding under .baiton/runs/.',
      ].join('\n');
      const confirmed = await askConfirmCard(services, 'Investigate this question?', detail);
      if (!confirmed) {
        return { ok: false, error: 'the investigation was declined; nothing was written' };
      }

      // The pipeline's manifest stores the question as the run's `statement`.
      const outcome = await services.runPipeline.start({
        mode: 'investigate',
        statement: question,
        files,
      });
      switch (outcome.kind) {
        case 'started':
          return {
            ok: true,
            data: {
              runId: outcome.runId,
              mode: 'investigate',
              ...(outcome.branch !== undefined ? { branch: outcome.branch } : {}),
            },
          };
        case 'busy':
          return {
            ok: false,
            error: 'a stage is already running for this repository; try again after it finishes',
          };
        case 'refused':
          return { ok: false, error: `the investigation did not start: ${outcome.reason}` };
        default:
          return { ok: false, error: 'investigate dispatch returned an unknown outcome' };
      }
    },
  };
}

/** `approve_spec(slug)` — approve (or re-approve) a spec (Req 16, 5.2, 5.5). */
function approveSpecTool(services: ToolServices): Tool {
  return {
    name: 'approve_spec',
    description: 'Approve or re-approve a spec: create its branch and record the approval hash.',
    mutating: true,
    phases: ['gather', 'drive'],
    schema: {
      type: 'object',
      properties: { slug: { type: 'string' } },
      required: ['slug'],
      additionalProperties: false,
    },
    async run(args: unknown, tc: ToolContext): Promise<ToolResult> {
      const slug = readString(args, 'slug');
      if (slug === undefined) {
        return { ok: false, error: 'approve_spec requires a string "slug"' };
      }
      if (!isSlug(slug)) {
        return { ok: false, error: `invalid slug: ${slug}` };
      }

      const specFile = specPath(services, slug);
      const resolved = await tc.ctx.resolveMutatingPath(specFile);
      if (!resolved.ok) {
        return { ok: false, error: resolved.error.message };
      }
      let content: string;
      try {
        content = await fs.readFile(resolved.resolved, 'utf8');
      } catch {
        return { ok: false, error: `spec "${slug}" was not found` };
      }

      // Req 10.1: confirm in the UI before performing any change. A decline or
      // cancel leaves the spec unchanged (Req 10.2).
      const confirmed = await services.confirm.confirm(
        `Approve spec "${slug}"? This creates its branch from the resolved base commit and records the approval.`,
      );
      if (!confirmed) {
        return {
          ok: false,
          error: `approval of spec "${slug}" was declined; the spec is unchanged`,
        };
      }

      const spec = parseSpec(content);
      const alreadyApproved = (spec.frontmatter.get('approved_rev') ?? '').trim() !== '';

      // A re-approval only recomputes the Approval_Hash into `approved_rev` and
      // leaves every todo state (and the branch) unchanged (Req 5.5).
      if (alreadyApproved) {
        return reapprove(services, resolved.resolved, content, spec, slug);
      }

      return freshApprove(services, resolved.resolved, content, spec, slug);
    },
  };
}

/**
 * A fresh approval: clean-tree check, fetch/resolve/record base_commit, create
 * and check out the branch, record branch/status/approved_rev, and commit
 * `spec(<slug>): approve` (Req 16.1–16.5, 5.2).
 */
async function freshApprove(
  services: ToolServices,
  absolute: string,
  content: string,
  spec: ReturnType<typeof parseSpec>,
  slug: string,
): Promise<ToolResult> {
  // Req 16.1/16.2: clean only if every change is confined to the spec folder.
  let clean: boolean;
  try {
    clean = await services.git.isCleanExceptSpecFolder(slug);
  } catch (e) {
    return { ok: false, error: gitErrorMessage(e) };
  }
  if (!clean) {
    return {
      ok: false,
      error:
        `approval refused: the working tree has changes outside .baiton/specs/${slug}/. ` +
        'Commit or revert them first; the spec is unchanged.',
    };
  }

  // Req 16.3/16.4: fetch the remote and resolve the base branch to a commit.
  // The base branch comes from the spec frontmatter when set, else config.
  const baseBranch = (spec.frontmatter.get('base') ?? '').trim() || services.gitSettings.base;
  let baseCommit: string;
  try {
    await services.git.fetch(services.gitSettings.remote);
    baseCommit = await services.git.resolveBaseCommit(baseBranch);
  } catch (e) {
    return {
      ok: false,
      error: `approval halted: could not fetch/resolve base "${baseBranch}": ${gitErrorMessage(e)}. The spec is unchanged.`,
    };
  }

  // Req 16.5: create the spec branch from the resolved base commit and check it
  // out. The branch name is derived from the slug.
  const branch = `baiton/${slug}`;
  try {
    await services.git.createSpecBranch(branch, baseCommit);
    await services.git.checkout(branch);
  } catch (e) {
    return {
      ok: false,
      error: `approval halted: could not create/checkout branch "${branch}": ${gitErrorMessage(e)}`,
    };
  }

  // Record the approval metadata into the frontmatter (managed keys only), then
  // compute the Approval_Hash over the resulting content and record it as
  // `approved_rev` (Req 5.2). The hash is computed on the content whose managed
  // keys have been set; approvalHash ignores frontmatter, so ordering is safe.
  let updated = content;
  updated = setFrontmatterKey(updated, 'base', baseBranch);
  updated = setFrontmatterKey(updated, 'base_commit', baseCommit);
  updated = setFrontmatterKey(updated, 'branch', branch);
  updated = setFrontmatterKey(updated, 'status', 'approved');
  const hash = approvalHash(parseSpec(updated));
  updated = setFrontmatterKey(updated, 'approved_rev', hash);

  // Persist and commit the carried-over spec folder as `spec(<slug>): approve`
  // (Req 16.5). The branch was created from base_commit and checked out; the
  // spec folder is written here so it lands on the new branch.
  try {
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, updated, 'utf8');
    const commit = await services.git.commit(`spec(${slug}): approve`);
    return {
      ok: true,
      data: { slug, branch, base_commit: baseCommit, approved_rev: hash, commit },
    };
  } catch (e) {
    return { ok: false, error: `approval halted while committing: ${gitErrorMessage(e)}` };
  }
}

/**
 * A re-approval: recompute the Approval_Hash into `approved_rev` and commit the
 * metadata change, leaving every todo state and the branch unchanged (Req 5.5).
 */
async function reapprove(
  services: ToolServices,
  absolute: string,
  content: string,
  spec: ReturnType<typeof parseSpec>,
  slug: string,
): Promise<ToolResult> {
  const hash = approvalHash(spec);
  const updated = setFrontmatterKey(content, 'approved_rev', hash);
  if (updated === content) {
    // The hash was already current; nothing to write or commit.
    return { ok: true, data: { slug, approved_rev: hash, commit: undefined, unchanged: true } };
  }
  try {
    await fs.writeFile(absolute, updated, 'utf8');
    const commit = await services.git.commit(`spec(${slug}): ${slug} re-approve`);
    return { ok: true, data: { slug, approved_rev: hash, commit } };
  } catch (e) {
    return { ok: false, error: `re-approval halted while committing: ${gitErrorMessage(e)}` };
  }
}

/**
 * `run(slug, todo, stage)` — dispatch one legal stage transition through the
 * run-queue seam and resolve with its terminal outcome. Not a file mutation,
 * but a dispatch, so the guard disables it under Restricted Mode (Req 22.2).
 * Before dispatching any stage it validates the spec and refuses every stage
 * while the spec is invalid, surfacing the current validation errors until the
 * spec parses without error (Req 4.9). Refuses when a stage is already running for that todo
 * (Req 10.4) or the transition is illegal (Req 10.5).
 *
 * The stage enum is exactly `plan | execute | review` (Req 11.1). `plan-review`
 * runs inside the Plan action's own review rounds and `pr` is spec-scoped
 * (`submit_pr` runs it), so neither is a value this tool accepts: both are
 * rejected here with a message naming the three legal stages, before the queue
 * seam is reached.
 */
function runTool(services: ToolServices): Tool {
  return {
    name: 'run',
    description:
      'Dispatch one stage for one todo (plan, execute or review) and wait for it: the call blocks until the stage finishes and returns its outcome.',
    mutating: false,
    phases: ['drive'],
    subagent: true,
    dispatch: true,
    concurrent: true,
    schema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        todo: { type: 'string' },
        stage: {
          type: 'string',
          enum: ['plan', 'execute', 'review'],
        },
      },
      required: ['slug', 'todo', 'stage'],
      additionalProperties: false,
    },
    async run(args: unknown, tc: ToolContext): Promise<ToolResult> {
      const slug = readString(args, 'slug');
      const todo = readString(args, 'todo');
      const stage = readString(args, 'stage');
      if (slug === undefined || todo === undefined || stage === undefined) {
        return { ok: false, error: 'run requires a string "slug", "todo", and "stage"' };
      }
      if (!isRunnableStage(stage)) {
        // `plan-review` runs inside the Plan action's review rounds and is not
        // a standalone trigger; `pr` is per spec, not per todo (`submit_pr`
        // runs it); `spec-draft` belongs to `draft_spec`. None of them reach
        // the queue from here.
        return {
          ok: false,
          error:
            `run "stage" must be one of plan, execute, review: ${stage}. ` +
            'plan-review runs inside the plan stage, and the PR stage is run by submit_pr.',
        };
      }
      if (!isSlug(slug)) {
        return { ok: false, error: `invalid slug: ${slug}` };
      }

      // Req 4.9: while the spec is invalid, refuse to start any stage and
      // surface the current validation errors. The spec is re-read and
      // re-validated on every dispatch so the refusal lifts only once the spec
      // parses without error. A spec that cannot be read is treated as a
      // not-found refusal rather than a dispatch.
      const specFile = specPath(services, slug);
      const resolved = await tc.ctx.resolveReadPath(specFile);
      if (!resolved.ok) {
        return { ok: false, error: resolved.error.message };
      }
      let content: string;
      try {
        content = await fs.readFile(resolved.resolved, 'utf8');
      } catch {
        return { ok: false, error: `spec "${slug}" was not found` };
      }
      const errors = validateSpec(parseSpec(content), content);
      if (errors.length > 0) {
        const detail = errors
          .map((e) => `line ${e.line}: ${e.reason}`)
          .join('; ');
        return {
          ok: false,
          error:
            `spec "${slug}" is invalid; no stage can run until it is fixed. ` +
            `Validation errors: ${detail}`,
        };
      }

      const outcome = await services.runQueue.dispatch({ slug, todoId: todo, stage });
      switch (outcome.kind) {
        case 'dispatched':
          return { ok: true, data: { slug, todo, stage, runId: outcome.runId } };
        case 'busy':
          return {
            ok: false,
            error: `a stage is already running for todo "${todo}" of spec "${slug}"; wait for it to finish before dispatching another stage for this todo (other todos can run meanwhile)`,
          };
        case 'illegal':
          return { ok: false, error: `stage "${stage}" is not allowed for todo "${todo}": ${outcome.reason}` };
        default:
          return { ok: false, error: 'run dispatch returned an unknown outcome' };
      }
    },
  };
}

/**
 * Set a managed frontmatter key, inserting it into the `---` block when the key
 * is absent so approval can record keys a user-authored spec omitted. When the
 * key already exists, {@link writeFrontmatterKey} rewrites only its value; the
 * returned content is byte-identical when the value was already current.
 */
/**
 * `land_todo(slug, todo)` — merge a done todo's branch into the spec branch and
 * remove its worktree. Refuses any todo that is not `done` before the seam.
 */
function landTodoTool(services: ToolServices): Tool {
  return {
    name: 'land_todo',
    description:
      'Land a done todo: merge its branch into the spec branch and remove its worktree. Returns the merge commit, or reports that the todo is already landed.',
    mutating: true,
    phases: ['drive'],
    schema: {
      type: 'object',
      properties: { slug: { type: 'string' }, todo: { type: 'string' } },
      required: ['slug', 'todo'],
      additionalProperties: false,
    },
    async run(args: unknown, tc: ToolContext): Promise<ToolResult> {
      const slug = readString(args, 'slug');
      const todo = readString(args, 'todo');
      if (slug === undefined || todo === undefined) {
        return { ok: false, error: 'land_todo requires a string "slug" and "todo"' };
      }
      if (!isSlug(slug)) {
        return { ok: false, error: `invalid slug: ${slug}` };
      }
      if (!isSlug(todo)) {
        return { ok: false, error: `invalid todo id: ${todo}` };
      }
      const resolved = await tc.ctx.resolveMutatingPath(specPath(services, slug));
      if (!resolved.ok) {
        return { ok: false, error: resolved.error.message };
      }
      let content: string;
      try {
        content = await fs.readFile(resolved.resolved, 'utf8');
      } catch {
        return { ok: false, error: `spec "${slug}" was not found` };
      }
      const entry = parseSpec(content).todos.find((t) => t.id === todo);
      if (entry === undefined) {
        return { ok: false, error: `todo "${todo}" was not found in spec "${slug}"` };
      }
      if (entry.state !== 'done') {
        return {
          ok: false,
          error: `todo "${todo}" is ${entry.state}; only a done todo can be landed. Run its remaining stages first.`,
        };
      }
      if (services.landTodo === undefined) {
        return { ok: false, error: 'land_todo is not available in this host' };
      }
      const outcome = await services.landTodo.land({ slug, todoId: todo });
      switch (outcome.kind) {
        case 'landed':
          return {
            ok: true,
            data: {
              slug,
              todo,
              landed: true,
              commit: outcome.commit,
              ...(outcome.noop ? { noop: true } : {}),
              ...(outcome.cleanup.length > 0 ? { cleanup: [...outcome.cleanup] } : {}),
            },
          };
        case 'already-landed':
          return { ok: true, data: { slug, todo, landed: false, message: 'already landed' } };
        case 'refused':
          return { ok: false, error: `landing todo "${todo}" of spec "${slug}" was refused: ${outcome.reason}` };
        default:
          return { ok: false, error: 'land_todo returned an unknown outcome' };
      }
    },
  };
}

/**
 * `submit_pr(slug)` — run Verify then the PR stage (design section 8). Like
 * approval it confirms in the UI first: the flow pushes a branch and opens a
 * pull request, which are outward-facing.
 */
function submitPrTool(services: ToolServices): Tool {
  return {
    name: 'submit_pr',
    description:
      'Submit the pull request for a spec whose todos are all done and landed: run verify, draft the PR with the pr-writer, push the branch and open (or reuse) the PR.',
    mutating: true,
    phases: ['drive'],
    schema: {
      type: 'object',
      properties: { slug: { type: 'string' } },
      required: ['slug'],
      additionalProperties: false,
    },
    async run(args: unknown, tc: ToolContext): Promise<ToolResult> {
      const slug = readString(args, 'slug');
      if (slug === undefined) {
        return { ok: false, error: 'submit_pr requires a string "slug"' };
      }
      if (!isSlug(slug)) {
        return { ok: false, error: `invalid slug: ${slug}` };
      }
      const resolved = await tc.ctx.resolveMutatingPath(specPath(services, slug));
      if (!resolved.ok) {
        return { ok: false, error: resolved.error.message };
      }
      if (services.submitPr === undefined) {
        return { ok: false, error: 'submit_pr is not available in this host' };
      }
      const confirmed = await services.confirm.confirm(
        `Submit a pull request for spec "${slug}"? This pushes its branch and opens the PR.`,
      );
      if (!confirmed) {
        return { ok: false, error: `submitting the PR for spec "${slug}" was declined; nothing was pushed` };
      }
      const outcome = await services.submitPr(slug);
      if (!outcome.ok) {
        return { ok: false, error: outcome.error };
      }
      return { ok: true, data: { slug, url: outcome.url, reused: outcome.reused, title: outcome.title } };
    },
  };
}

function specPath(services: ToolServices, slug: string): string {
  return path.join(services.baitonDir, 'specs', slug, 'spec.md');
}

/**
 * The three todo-scoped stages the `run` tool dispatches (Req 11.1). Every
 * other {@link Stage} — `plan-review`, `pr`, `spec-draft` — is owned by some
 * other trigger, so `run` rejects it before the queue seam.
 */
const RUNNABLE_STAGES: readonly Stage[] = ['plan', 'execute', 'review'] as const;

/** Whether `value` is a stage the `run` tool may dispatch. */
function isRunnableStage(value: string): value is Stage {
  return isStage(value) && RUNNABLE_STAGES.includes(value);
}

/** The refusal a spawn from a chat already at the nesting cap gets; shared with the sub-agent runner. */
export function subAgentDepthRefusal(depth: number): string {
  return `spawn_subagent refused: sub-agents may nest at most ${MAX_SUBAGENT_DEPTH} levels deep (MAX_SUBAGENT_DEPTH = ${MAX_SUBAGENT_DEPTH}) and this chat is already at depth ${depth}. Do the task yourself or report back to your parent.`;
}

function spawnSubAgentTool(services: ToolServices): Tool {
  return {
    name: 'spawn_subagent',
    description:
      'Start a sub-agent chat to do one task and wait for its first reply. The sub-agent has its own tool loop and transcript; returns its chat id (for send_to_subagent) and its reply.',
    mutating: false,
    concurrent: true,
    subagent: true,
    phases: ['gather', 'drive', 'run'],
    schema: {
      type: 'object',
      properties: { task: { type: 'string' } },
      required: ['task'],
      additionalProperties: false,
    },
    async run(args: unknown, tc: ToolContext): Promise<ToolResult> {
      const task = readString(args, 'task');
      if (task === undefined || task.trim() === '') {
        return { ok: false, error: 'spawn_subagent requires a non-empty string "task"' };
      }
      const caller = tc.caller;
      if (caller === undefined) {
        return { ok: false, error: 'spawn_subagent needs a calling chat; it is not available here' };
      }
      if (caller.depth >= MAX_SUBAGENT_DEPTH) {
        return { ok: false, error: subAgentDepthRefusal(caller.depth) };
      }
      if (services.subAgents === undefined) {
        return { ok: false, error: 'spawn_subagent is not available in this host' };
      }
      const outcome = await services.subAgents.spawn({ task: task.trim(), caller });
      switch (outcome.kind) {
        case 'replied':
          return { ok: true, data: { chatId: outcome.chatId, reply: outcome.reply } };
        case 'refused':
          return { ok: false, error: `the sub-agent did not start: ${outcome.reason}` };
        default:
          return { ok: false, error: 'spawn_subagent returned an unknown outcome' };
      }
    },
  };
}

function sendToSubAgentTool(services: ToolServices): Tool {
  return {
    name: 'send_to_subagent',
    description:
      'Send a follow-up message to a sub-agent chat you started with spawn_subagent and wait for its reply.',
    mutating: false,
    concurrent: true,
    subagent: true,
    phases: ['gather', 'drive', 'run'],
    schema: {
      type: 'object',
      properties: { chat_id: { type: 'string' }, message: { type: 'string' } },
      required: ['chat_id', 'message'],
      additionalProperties: false,
    },
    async run(args: unknown, tc: ToolContext): Promise<ToolResult> {
      const chatId = readString(args, 'chat_id');
      const message = readString(args, 'message');
      if (chatId === undefined || chatId.trim() === '' || message === undefined || message.trim() === '') {
        return { ok: false, error: 'send_to_subagent requires a non-empty string "chat_id" and "message"' };
      }
      const caller = tc.caller;
      if (caller === undefined) {
        return { ok: false, error: 'send_to_subagent needs a calling chat; it is not available here' };
      }
      if (services.subAgents === undefined) {
        return { ok: false, error: 'send_to_subagent is not available in this host' };
      }
      const outcome = await services.subAgents.send({
        chatId: chatId.trim(),
        message: message.trim(),
        caller,
      });
      switch (outcome.kind) {
        case 'replied':
          return { ok: true, data: { reply: outcome.reply } };
        case 'refused':
          return { ok: false, error: `sub-agent "${chatId}" did not answer: ${outcome.reason}` };
        default:
          return { ok: false, error: 'send_to_subagent returned an unknown outcome' };
      }
    },
  };
}

/** A slug/todo id is a simple directory-safe name (no separators/traversal). */
function isSlug(slug: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(slug) && slug !== '.' && slug !== '..';
}

/** Read a required string field from an args object, or undefined. */
function readString(args: unknown, key: string): string | undefined {
  if (typeof args !== 'object' || args === null) {
    return undefined;
  }
  const value = (args as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/** The most options one ask_user card may offer; more than this is a list, not a choice. */
const MAX_ASK_USER_OPTIONS = 8;

type OptionsRead = { ok: true; options: InterventionOption[] } | { ok: false; error: string };

/** Read and validate the optional `options` array: objects with unique non-empty id/label. */
function readOptions(args: unknown): OptionsRead {
  if (typeof args !== 'object' || args === null) {
    return { ok: true, options: [] };
  }
  const raw = (args as Record<string, unknown>)['options'];
  if (raw === undefined) {
    return { ok: true, options: [] };
  }
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'ask_user "options" must be an array' };
  }
  if (raw.length > MAX_ASK_USER_OPTIONS) {
    return { ok: false, error: `ask_user accepts at most ${MAX_ASK_USER_OPTIONS} options` };
  }
  const seen = new Set<string>();
  const options: InterventionOption[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) {
      return { ok: false, error: 'each ask_user option needs a non-empty string "id" and "label"' };
    }
    const rec = entry as Record<string, unknown>;
    const id = typeof rec['id'] === 'string' ? rec['id'] : undefined;
    const label = typeof rec['label'] === 'string' ? rec['label'] : undefined;
    if (id === undefined || label === undefined || id.trim().length === 0 || label.trim().length === 0) {
      return { ok: false, error: 'each ask_user option needs a non-empty string "id" and "label"' };
    }
    if (seen.has(id.trim())) {
      return { ok: false, error: `duplicate ask_user option id: ${id.trim()}` };
    }
    seen.add(id.trim());
    const detail = typeof rec['detail'] === 'string' ? rec['detail'] : undefined;
    options.push({
      id: id.trim(),
      label: label.trim(),
      ...(detail !== undefined && detail.trim().length > 0 ? { detail } : {}),
    });
  }
  return { ok: true, options };
}

/** Read an optional boolean field; `undefined` when absent, an error when present but not a boolean. */
function readBoolean(args: unknown, key: string): { ok: true; value: boolean | undefined } | { ok: false; error: string } {
  if (typeof args !== 'object' || args === null) {
    return { ok: true, value: undefined };
  }
  const value = (args as Record<string, unknown>)[key];
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (typeof value !== 'boolean') {
    return { ok: false, error: `ask_user "${key}" must be a boolean` };
  }
  return { ok: true, value };
}

/**
 * The three build modes `start_run` accepts. `investigate` is dispatched by its
 * own tool, `spec` is the spec pipeline, and `default` only recommends one of
 * these modes, so none of them is accepted here.
 */
const RUN_TOOL_MODES: readonly RunMode[] = ['bug', 'quick', 'refactor'] as const;

/**
 * Read the `files` array of repository-relative paths. Validation is purely
 * lexical — non-empty, relative, no `..` segment — so the tool never touches
 * the filesystem; the planner brief resolves the paths. Entries are trimmed and
 * exact duplicates dropped, first-seen order preserved. An empty array is legal
 * (nothing was guessed).
 */
function readFileList(
  args: unknown,
  tool: string,
): { ok: true; files: string[] } | { ok: false; error: string } {
  const raw =
    typeof args === 'object' && args !== null
      ? (args as Record<string, unknown>)['files']
      : undefined;
  if (raw === undefined || !Array.isArray(raw)) {
    return { ok: false, error: `${tool} requires a "files" array of repository-relative paths` };
  }
  const files: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      return { ok: false, error: `each ${tool} "files" entry must be a non-empty string` };
    }
    const trimmed = entry.trim();
    if (path.isAbsolute(trimmed) || trimmed.split(/[\\/]/).includes('..')) {
      return {
        ok: false,
        error: `${tool} "files" must be repository-relative paths without "..": ${entry}`,
      };
    }
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      files.push(trimmed);
    }
  }
  return { ok: true, files };
}

/**
 * Read a required single-line string. The manifest stores a one-line
 * statement, so an embedded newline is rejected rather than silently folded.
 */
function readOneLine(
  args: unknown,
  key: string,
  tool: string,
): { ok: true; value: string } | { ok: false; error: string } {
  const raw = readString(args, key);
  if (raw === undefined || raw.trim().length === 0) {
    return { ok: false, error: `${tool} requires a non-empty string "${key}"` };
  }
  if (raw.includes('\n')) {
    return { ok: false, error: `${tool} "${key}" must be a single line` };
  }
  return { ok: true, value: raw.trim() };
}

/**
 * Raise one confirm card with the given prompt and detail. The intervention
 * seam renders them as a card when wired; a host with only the legacy confirm
 * seam gets the same text verbatim, so both paths read identically.
 */
async function askConfirmCard(
  services: ToolServices,
  prompt: string,
  detail: string,
): Promise<boolean> {
  if (services.intervention !== undefined) {
    const answer = await services.intervention.ask({ kind: 'confirm', prompt, detail });
    return answer.kind === 'approved';
  }
  return services.confirm.confirm(`${prompt}\n\n${detail}`);
}

/**
 * The branch the card names as the run's target. The card must never fail
 * because git did (a throwing stub, a detached HEAD), so a failure falls back
 * to the configured base; the pipeline re-derives the real base when it starts.
 */
async function targetBranch(services: ToolServices): Promise<string> {
  try {
    const b = (await services.git.currentBranch()).trim();
    return b === '' ? services.gitSettings.base : b;
  } catch {
    return services.gitSettings.base;
  }
}

/** Render a caught git error into a user-facing message. */
function gitErrorMessage(e: unknown): string {
  if (typeof e === 'object' && e !== null && 'command' in e) {
    const ge = e as { command: string; stderr?: string };
    return `${ge.command} failed${ge.stderr ? `: ${ge.stderr.trim()}` : ''}`;
  }
  return e instanceof Error ? e.message : String(e);
}
