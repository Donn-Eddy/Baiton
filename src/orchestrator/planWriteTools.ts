/**
 * The orchestrator's plan-writing tools (Requirements 9.5–9.10, 17.1, 23.5).
 *
 * The orchestrator refines plan and legacy document files through these tools and never edits
 * source (Req 8.1). All four are mutating, so the guard requires an
 * idempotency key, replays a seen key unchanged, and disables them under
 * Restricted Mode; each resolves its target through
 * {@link GuardContext.resolveMutatingPath} so the write can only land under
 * `.baiton/plans/` or legacy `.baiton/specs/` (Req 8.1, 8.2).
 *
 * The `draft_plan` control tool hands the request to the plan-writer harness,
 * and the plan-draft runner in `src/engine/planDraft.ts` renders and commits
 * new plans. These tools refine plans and legacy spec documents after they exist.
 *
 * - `update_overview(slug, text)` rewrites the preamble, leaving frontmatter
 *   and phases untouched.
 * - `add_phase` / `edit_phase` / `remove_phase` change exactly one phase line and
 *   never take a phase state as an argument (Req 9.6, 9.7). `edit_phase` and
 *   `remove_phase` refuse a phase whose state is `done`, `failed`, or a running
 *   state (`planning`/`executing`/`reviewing`) (Req 9.8).
 *
 * Every write under either document root is committed on the plan branch as
 * `plan(<slug>): <id> <what>` before any subsequent stage, using the git
 * service seam (Req 17.1). A phase-scoped write uses that phase's id; a
 * plan-scoped write (overview) uses the slug as the `<id>` field.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { DocumentKind, parsePlan, phaseIdPattern, phaseIdPrefix } from '../model/parser';
import { PhaseState } from '../model/phaseState';
import { resolveDocument } from '../storage/documentLocation';
import { Tool, ToolContext, ToolResult } from './guard';
import { ToolServices } from './toolServices';

/** The states a phase cannot be edited or removed from (Req 9.8). */
const PROTECTED_STATES: ReadonlySet<PhaseState> = new Set<PhaseState>([
  'done',
  'failed',
  'planning',
  'executing',
  'reviewing',
]);

/** Build every plan-writing tool for the registry. */
export function createPlanWriteTools(services: ToolServices): Tool[] {
  return [
    updateOverviewTool(services),
    addPhaseTool(services),
    editPhaseTool(services),
    removePhaseTool(services),
  ];
}

/**
 * `update_overview(slug, text)` — replace the plan preamble (or legacy OVERVIEW)
 * with `text`, leaving frontmatter and every phase line unchanged.
 */
function updateOverviewTool(services: ToolServices): Tool {
  return {
    name: 'update_overview',
    description: "Rewrite a plan's preamble (Endstate, What needs changing, Limitations & constraints; or a legacy spec's OVERVIEW), leaving frontmatter and phases untouched.",
    mutating: true,
    steps: ['gather', 'drive'],
    schema: {
      type: 'object',
      properties: { slug: { type: 'string' }, text: { type: 'string' } },
      required: ['slug', 'text'],
      additionalProperties: false,
    },
    async run(args: unknown, tc: ToolContext): Promise<ToolResult> {
      const slug = readString(args, 'slug');
      const text = readString(args, 'text');
      if (slug === undefined || text === undefined) {
        return { ok: false, error: 'update_overview requires a string "slug" and a string "text"' };
      }
      const loaded = await loadPlanForWrite(services, slug, tc);
      if (!loaded.ok) {
        return loaded.error;
      }
      const rewritten = loaded.kind === 'plan'
        ? replacePreamble(loaded.content, text)
        // Legacy: retain the OVERVIEW section edit for existing spec.md files.
        : replaceOverview(loaded.content, text);
      if (rewritten === undefined) {
        return {
          ok: false,
          error: loaded.kind === 'plan'
            ? `plan "${slug}" has no preamble/PHASES structure to update`
            : `plan "${slug}" has no preamble/PHASES (or legacy OVERVIEW/TODOS) structure to update`,
        };
      }
      const write = await writeAndCommit(services, loaded.absolute, rewritten, slug, slug, 'update overview');
      if (!write.ok) {
        return write;
      }
      return { ok: true, data: { slug, commit: write.commit } };
    },
  };
}

/**
 * `add_phase(slug, id, title, after?, files?)` — append a new `pending` phase line.
 * A state is never accepted (Req 9.7); the phase is created `pending`. The id
 * must be a fresh id with this document kind's prefix.
 */
function addPhaseTool(services: ToolServices): Tool {
  return {
    name: 'add_phase',
    description: 'Append a new pending phase line to a plan with an id (P## for a plan, T## for a legacy spec), title and optional hints.',
    mutating: true,
    steps: ['gather', 'drive'],
    schema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        id: { type: 'string' },
        title: { type: 'string' },
        after: { type: 'array', items: { type: 'string' } },
        files: { type: 'array', items: { type: 'string' } },
      },
      required: ['slug', 'id', 'title'],
      additionalProperties: false,
    },
    async run(args: unknown, tc: ToolContext): Promise<ToolResult> {
      const slug = readString(args, 'slug');
      const id = readString(args, 'id');
      const title = readString(args, 'title');
      const after = readStringArray(args, 'after') ?? [];
      const files = readStringArray(args, 'files') ?? [];
      if (slug === undefined || id === undefined || title === undefined) {
        return { ok: false, error: 'add_phase requires a string "slug", "id", and "title"' };
      }
      const loaded = await loadPlanForWrite(services, slug, tc);
      if (!loaded.ok) {
        return loaded.error;
      }
      if (!phaseIdPattern(loaded.kind).test(id)) {
        return { ok: false, error: `add_phase "id" must be "${phaseIdPrefix(loaded.kind)}" followed by two or more digits: ${id}` };
      }
      const plan = parsePlan(loaded.content, loaded.kind);
      if (plan.phases.some((phase) => phase.id === id)) {
        return { ok: false, error: `add_phase: phase "${id}" already exists in plan "${slug}"` };
      }
      const line = renderPhaseLine('pending', id, title, after, files);
      const updated = appendPhaseLine(loaded.content, line, loaded.kind);
      const write = await writeAndCommit(services, loaded.absolute, updated, slug, id, `add ${id}`);
      if (!write.ok) {
        return write;
      }
      return { ok: true, data: { slug, id, commit: write.commit } };
    },
  };
}

/**
 * `edit_phase(slug, id, title?, after?, files?)` — rewrite a phase's title and/or
 * hints, preserving its existing state (a state is never an argument, Req 9.7).
 * Refuses when the phase is in a protected state (Req 9.8).
 */
function editPhaseTool(services: ToolServices): Tool {
  return {
    name: 'edit_phase',
    description: "Rewrite a phase's title and hints, preserving its state; refuses protected states.",
    mutating: true,
    steps: ['gather', 'drive'],
    schema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        id: { type: 'string' },
        title: { type: 'string' },
        after: { type: 'array', items: { type: 'string' } },
        files: { type: 'array', items: { type: 'string' } },
      },
      required: ['slug', 'id'],
      additionalProperties: false,
    },
    async run(args: unknown, tc: ToolContext): Promise<ToolResult> {
      const slug = readString(args, 'slug');
      const id = readString(args, 'id');
      if (slug === undefined || id === undefined) {
        return { ok: false, error: 'edit_phase requires a string "slug" and "id"' };
      }
      const loaded = await loadPlanForWrite(services, slug, tc);
      if (!loaded.ok) {
        return loaded.error;
      }
      const plan = parsePlan(loaded.content, loaded.kind);
      const phase = plan.phases.find((item) => item.id === id);
      if (phase === undefined) {
        return { ok: false, error: `edit_phase: phase "${id}" was not found in plan "${slug}"` };
      }
      if (PROTECTED_STATES.has(phase.state)) {
        return {
          ok: false,
          error: `edit_phase refused: phase "${id}" is in a protected state (${phase.state})`,
        };
      }

      const title = readString(args, 'title') ?? phase.title;
      const after = readStringArray(args, 'after') ?? phase.after;
      const files = readStringArray(args, 'files') ?? phase.files;
      // Preserve the existing state; only the title and hints may change.
      const newLine = renderPhaseLine(phase.state, id, title, after, files);
      const updated = replaceLine(loaded.content, phase.lineIndex, newLine);
      const write = await writeAndCommit(services, loaded.absolute, updated, slug, id, `edit ${id}`);
      if (!write.ok) {
        return write;
      }
      return { ok: true, data: { slug, id, commit: write.commit } };
    },
  };
}

/**
 * `remove_phase(slug, id)` — delete a phase line. Refuses when the phase is in a
 * protected state (Req 9.8).
 */
function removePhaseTool(services: ToolServices): Tool {
  return {
    name: 'remove_phase',
    description: 'Delete a phase line from a plan; refuses when the phase is in a protected state.',
    mutating: true,
    steps: ['gather', 'drive'],
    schema: {
      type: 'object',
      properties: { slug: { type: 'string' }, id: { type: 'string' } },
      required: ['slug', 'id'],
      additionalProperties: false,
    },
    async run(args: unknown, tc: ToolContext): Promise<ToolResult> {
      const slug = readString(args, 'slug');
      const id = readString(args, 'id');
      if (slug === undefined || id === undefined) {
        return { ok: false, error: 'remove_phase requires a string "slug" and "id"' };
      }
      const loaded = await loadPlanForWrite(services, slug, tc);
      if (!loaded.ok) {
        return loaded.error;
      }
      const plan = parsePlan(loaded.content, loaded.kind);
      const phase = plan.phases.find((item) => item.id === id);
      if (phase === undefined) {
        return { ok: false, error: `remove_phase: phase "${id}" was not found in plan "${slug}"` };
      }
      if (PROTECTED_STATES.has(phase.state)) {
        return {
          ok: false,
          error: `remove_phase refused: phase "${id}" is in a protected state (${phase.state})`,
        };
      }
      const updated = deleteLine(loaded.content, phase.lineIndex);
      const write = await writeAndCommit(services, loaded.absolute, updated, slug, id, `remove ${id}`);
      if (!write.ok) {
        return write;
      }
      return { ok: true, data: { slug, id, commit: write.commit } };
    },
  };
}

/**
 * Load a plan or legacy spec's on-disk content for a mutating write, resolving containment
 * through the guard first (Req 8.1, 8.2) and re-reading the current bytes so
 * the edit applies to the latest content (Req 6.3). Returns a discriminated
 * result carrying the absolute path and content on success, or a
 * {@link ToolResult} error to return directly.
 */
async function loadPlanForWrite(
  services: ToolServices,
  slug: string,
  tc: ToolContext,
): Promise<
  | { ok: true; absolute: string; content: string; kind: DocumentKind }
  | { ok: false; error: ToolResult }
> {
  if (!isSlug(slug)) {
    return { ok: false, error: { ok: false, error: `invalid slug: ${slug}` } };
  }
  const location = resolveDocument(services.baitonDir, slug);
  const resolved = await tc.ctx.resolveMutatingPath(location.documentPath);
  if (!resolved.ok) {
    return { ok: false, error: { ok: false, error: resolved.error.message } };
  }
  let content: string;
  try {
    content = await fs.readFile(resolved.resolved, 'utf8');
  } catch {
    return { ok: false, error: { ok: false, error: `plan "${slug}" was not found` } };
  }
  return { ok: true, absolute: resolved.resolved, content, kind: location.kind };
}

/**
 * Write `content` to the plan file and commit it on the plan branch as
 * `plan(<slug>): <id> <what>` before any subsequent stage (Req 17.1). Returns
 * the new commit sha on success, or a {@link ToolResult} error preserving the
 * failure. The parent directory is created for a fresh document.
 *
 * Exported so the plan-writing tools share one write-and-commit path.
 */
export async function writeAndCommit(
  services: ToolServices,
  absolute: string,
  content: string,
  slug: string,
  id: string,
  what: string,
): Promise<{ ok: true; commit: string } | { ok: false; error: string }> {
  try {
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content, 'utf8');
  } catch (e) {
    return { ok: false, error: `failed to write plan file: ${e instanceof Error ? e.message : String(e)}` };
  }
  try {
    const commit = await services.git.commit(`plan(${slug}): ${id} ${what}`);
    return { ok: true, commit };
  } catch (e) {
    return { ok: false, error: gitCommitErrorMessage(e) };
  }
}

/** Render a single `- [<state>] <id> <title>` phase line with optional hints. */
function renderPhaseLine(
  state: PhaseState,
  id: string,
  title: string,
  after: string[],
  files: string[],
): string {
  const groups: string[] = [];
  if (after.length > 0) {
    groups.push(`after ${after.join(', ')}`);
  }
  if (files.length > 0) {
    groups.push(`files: ${files.join(', ')}`);
  }
  const hint = groups.length > 0 ? ` (${groups.join('; ')})` : '';
  return `- [${state}] ${id} ${title.trim()}${hint}`;
}

/**
 * Replace the legacy OVERVIEW section body (between `# OVERVIEW` and the next header)
 * with `text`, leaving frontmatter, the header lines and the phase section
 * untouched. Returns undefined when there is no OVERVIEW header to update.
 */
function replaceOverview(content: string, text: string): string | undefined {
  const lines = content.split('\n');
  const overviewIdx = lines.findIndex((l) => isHeader(l, 'OVERVIEW'));
  if (overviewIdx === -1) {
    return undefined;
  }
  // Legacy: the old section body runs until the next `#` header (typically `# TODOS`).
  let end = lines.length;
  for (let i = overviewIdx + 1; i < lines.length; i++) {
    if (/^#+\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const body = text.replace(/\s+$/, '');
  const rebuilt = [
    ...lines.slice(0, overviewIdx + 1),
    '',
    body,
    '',
    ...lines.slice(end),
  ];
  return rebuilt.join('\n');
}

/** Replace the plan preamble between frontmatter and `# PHASES`. */
function replacePreamble(content: string, text: string): string | undefined {
  const lines = content.split('\n');
  let bodyStart = 0;
  if (lines[0]?.trim() === '---') {
    const closing = lines.findIndex((line, idx) => idx > 0 && line.trim() === '---');
    if (closing !== -1) bodyStart = closing + 1;
  }
  const phasesIdx = lines.findIndex((line, idx) => idx >= bodyStart && isHeader(line, 'PHASES'));
  if (phasesIdx === -1) return undefined;
  return [
    ...lines.slice(0, bodyStart),
    '',
    text.replace(/\s+$/, ''),
    '',
    ...lines.slice(phasesIdx),
  ].join('\n');
}

/** Append a phase line to the kind's phase section; TODOS is legacy. */
function appendPhaseLine(content: string, phaseLine: string, kind: DocumentKind): string {
  const lines = content.split('\n');
  // Legacy: retain the old item section name for existing documents.
  const section = kind === 'plan' ? 'PHASES' : 'TODOS';
  const sectionIdx = lines.findIndex((line) => isHeader(line, section));
  if (sectionIdx === -1) {
    // Legacy: preserve the old TODOS header for existing spec.md documents.
    return `${content.replace(/\s+$/, '')}\n\n# ${section}\n\n${phaseLine}\n`;
  }
  let sectionEnd = lines.length;
  for (let index = sectionIdx + 1; index < lines.length; index++) {
    if (/^#+\s+/.test(lines[index])) {
      sectionEnd = index;
      break;
    }
  }
  // Insert after the last phase/content line, before a later section or blanks.
  let insertAt = sectionEnd;
  while (insertAt > sectionIdx + 1 && lines[insertAt - 1].trim() === '') {
    insertAt--;
  }
  lines.splice(insertAt, 0, phaseLine);
  return lines.join('\n');
}

/** Replace a single line by index. */
function replaceLine(content: string, lineIndex: number, newLine: string): string {
  const lines = content.split('\n');
  lines[lineIndex] = newLine;
  return lines.join('\n');
}

/** Delete a single line by index. */
function deleteLine(content: string, lineIndex: number): string {
  const lines = content.split('\n');
  lines.splice(lineIndex, 1);
  return lines.join('\n');
}

/** Whether a line is a `# <NAME>` header. */
function isHeader(line: string, name: string): boolean {
  const m = /^#+\s+(.*)$/.exec(line);
  return m !== null && m[1].trim() === name;
}

/** A slug is a simple directory-safe name (no separators or traversal). */
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

/** Read a string-array field, or undefined when absent/invalid. */
function readStringArray(args: unknown, key: string): string[] | undefined {
  if (typeof args !== 'object' || args === null) {
    return undefined;
  }
  const value = (args as Record<string, unknown>)[key];
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
    return value as string[];
  }
  return undefined;
}

/** Render a caught git commit error into a user-facing message. */
export function gitCommitErrorMessage(e: unknown): string {
  if (typeof e === 'object' && e !== null && 'command' in e) {
    const ge = e as { command: string; stderr?: string };
    return `commit failed: ${ge.command}${ge.stderr ? `\n${ge.stderr}` : ''}`;
  }
  return `commit failed: ${e instanceof Error ? e.message : String(e)}`;
}
