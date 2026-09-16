/**
 * The orchestrator's control tools (Requirements 10.1–10.7, 5.2, 5.5,
 * 16.1–16.6, 17.1).
 *
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
 * - `run(slug, todo, stage)` (dispatch) — dispatch exactly one legal stage
 *   transition through the run-queue seam; refuse when a stage is already
 *   running (Req 10.4) or the transition is illegal (Req 10.5).
 * - `read_artifact(slug, todo, name)` (read) — return a persisted plan / plan-
 *   review / execute / review artifact, or a not-found error (Req 10.6, 10.7).
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
import { isStage } from '../model/stage';
import { setFrontmatterKey } from '../model/writer';
import { Tool, ToolContext, ToolResult } from './guard';
import { ToolServices } from './toolServices';

/** Build every control tool for the registry. */
export function createControlTools(services: ToolServices): Tool[] {
  return [
    draftSpecTool(services),
    approveSpecTool(services),
    runTool(services),
    readArtifactTool(services),
    submitPrTool(services),
  ];
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

/** `approve_spec(slug)` — approve (or re-approve) a spec (Req 16, 5.2, 5.5). */
function approveSpecTool(services: ToolServices): Tool {
  return {
    name: 'approve_spec',
    description: 'Approve or re-approve a spec: create its branch and record the approval hash.',
    mutating: true,
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
 * run-queue seam. Not a file mutation, but a dispatch, so the guard disables it
 * under Restricted Mode (Req 22.2). Before dispatching any stage it validates
 * the spec and refuses every stage while the spec is invalid, surfacing the
 * current validation errors until the spec parses without error (Req 4.9).
 * Refuses when a stage is already running (Req 10.4) or the transition is
 * illegal (Req 10.5).
 */
function runTool(services: ToolServices): Tool {
  return {
    name: 'run',
    description: 'Dispatch one legal stage transition (plan, plan-review, execute, review) for a todo.',
    mutating: false,
    dispatch: true,
    schema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        todo: { type: 'string' },
        stage: {
          type: 'string',
          enum: ['plan', 'plan-review', 'execute', 'review'],
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
      if (!isStage(stage) || stage === 'pr') {
        // The PR stage is per spec, not per todo: `submit_pr` runs it.
        return { ok: false, error: `run "stage" must be one of plan, plan-review, execute, review: ${stage}` };
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
          return { ok: false, error: 'a stage is already running for this repository; try again after it finishes' };
        case 'illegal':
          return { ok: false, error: `stage "${stage}" is not allowed for todo "${todo}": ${outcome.reason}` };
        default:
          return { ok: false, error: 'run dispatch returned an unknown outcome' };
      }
    },
  };
}

/**
 * `read_artifact(slug, todo, name)` — read a persisted stage artifact for a
 * todo. `name` is the artifact file name (e.g. `plan.md`, `plan-review-1.md`,
 * `execute-1.md`, `review-1.md`). Returns the bounded text (Req 10.6) or a
 * not-found error (Req 10.7). Artifacts live in the todo's own folder under the
 * spec, `specs/<slug>/todos/<todo>/`, so one todo's artifacts never collide
 * with another's (Req 24.3).
 */
function readArtifactTool(services: ToolServices): Tool {
  return {
    name: 'read_artifact',
    description: "Read a persisted stage artifact (plan, plan-review, execute or review) for a todo.",
    mutating: false,
    schema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        todo: { type: 'string' },
        name: { type: 'string' },
      },
      required: ['slug', 'todo', 'name'],
      additionalProperties: false,
    },
    async run(args: unknown, tc: ToolContext): Promise<ToolResult> {
      const slug = readString(args, 'slug');
      const todo = readString(args, 'todo');
      const name = readString(args, 'name');
      if (slug === undefined || todo === undefined || name === undefined) {
        return { ok: false, error: 'read_artifact requires a string "slug", "todo", and "name"' };
      }
      if (!isSlug(slug) || !isSlug(todo) || !isArtifactName(name)) {
        return { ok: false, error: 'read_artifact arguments contain an invalid slug, todo id, or artifact name' };
      }

      const artifactFile = path.join(
        services.baitonDir,
        'specs',
        slug,
        'todos',
        todo,
        name,
      );
      const resolved = await tc.ctx.resolveReadPath(artifactFile);
      if (!resolved.ok) {
        return { ok: false, error: resolved.error.message };
      }
      let text: string;
      try {
        text = await fs.readFile(resolved.resolved, 'utf8');
      } catch {
        return {
          ok: false,
          error: `artifact "${name}" for todo "${todo}" in spec "${slug}" was not found`,
        };
      }
      const bounded = tc.ctx.boundRead(text);
      return {
        ok: true,
        data: { slug, todo, name, text: bounded.text, truncated: bounded.truncated },
      };
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
 * `submit_pr(slug)` — run Verify then the PR stage (design section 8). Like
 * approval it confirms in the UI first: the flow pushes a branch and opens a
 * pull request, which are outward-facing.
 */
function submitPrTool(services: ToolServices): Tool {
  return {
    name: 'submit_pr',
    description:
      'Submit the pull request for a spec whose todos are all done: run verify, draft the PR with the pr-writer, push the branch and open (or reuse) the PR.',
    mutating: true,
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

/** A slug/todo id is a simple directory-safe name (no separators/traversal). */
function isSlug(slug: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(slug) && slug !== '.' && slug !== '..';
}

/** An artifact name is a simple markdown file name with no path separators. */
function isArtifactName(name: string): boolean {
  return /^[A-Za-z0-9._-]+\.md$/.test(name) && !name.includes('..');
}

/** Read a required string field from an args object, or undefined. */
function readString(args: unknown, key: string): string | undefined {
  if (typeof args !== 'object' || args === null) {
    return undefined;
  }
  const value = (args as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/** Render a caught git error into a user-facing message. */
function gitErrorMessage(e: unknown): string {
  if (typeof e === 'object' && e !== null && 'command' in e) {
    const ge = e as { command: string; stderr?: string };
    return `${ge.command} failed${ge.stderr ? `: ${ge.stderr.trim()}` : ''}`;
  }
  return e instanceof Error ? e.message : String(e);
}
