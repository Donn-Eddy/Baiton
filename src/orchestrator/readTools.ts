/**
 * The orchestrator's read tools (Requirement 9.1).
 *
 * These let the orchestrator inspect the repository so it can propose accurate
 * work: list and read specs, list files by glob, read a file or a bounded line
 * range, search file contents, and read `git status`, `git diff` and
 * `git log`. None of them are mutating, so the guard runs them directly; each
 * resolves any path argument through {@link GuardContext.resolveReadPath} so
 * symlinks are followed and a path escaping the repo root is rejected with no
 * read (Req 9.2, 9.3), and every textual result is passed through
 * {@link GuardContext.boundRead} so it is truncated to the fixed cap with a
 * truncation flag (Req 9.4).
 *
 * Each tool is a factory closing over {@link ToolServices}; none imports
 * `vscode`, so the whole read surface is testable against a temp repo.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { Tool, ToolContext, ToolResult } from './guard';
import { matchesGlob, walkFiles } from './glob';
import { ToolServices } from './toolServices';

/** The spec-relative directory holding one folder per spec. */
const SPECS_SUBDIR = 'specs';

/** Build every read tool for the registry. */
export function createReadTools(services: ToolServices): Tool[] {
  return [
    listSpecsTool(services),
    readSpecTool(services),
    listFilesTool(services),
    readFileTool(services),
    searchTool(services),
    gitStatusTool(services),
    gitDiffTool(services),
    gitLogTool(services),
  ];
}

/**
 * `list_specs` — the slugs of every spec under `.baiton/specs/`, each being a
 * directory that contains a `spec.md`.
 */
function listSpecsTool(services: ToolServices): Tool {
  return {
    name: 'list_specs',
    description: 'List the slugs of every spec under .baiton/specs/ that contains a spec.md.',
    mutating: false,
    schema: { type: 'object', properties: {}, additionalProperties: false },
    async run(): Promise<ToolResult> {
      const specsDir = path.join(services.baitonDir, SPECS_SUBDIR);
      let entries: import('fs').Dirent[];
      try {
        entries = await fs.readdir(specsDir, { withFileTypes: true });
      } catch {
        // No specs directory yet: an empty list, not an error.
        return { ok: true, data: { specs: [] } };
      }
      const slugs: string[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        const specFile = path.join(specsDir, entry.name, 'spec.md');
        try {
          await fs.access(specFile);
          slugs.push(entry.name);
        } catch {
          // A directory without a spec.md is not a spec.
        }
      }
      slugs.sort();
      return { ok: true, data: { specs: slugs } };
    },
  };
}

/** `read_spec` — the raw `spec.md` text for a slug, bounded to the read cap. */
function readSpecTool(services: ToolServices): Tool {
  return {
    name: 'read_spec',
    description: "Read the raw spec.md text for a given spec slug, bounded to the read cap.",
    mutating: false,
    schema: {
      type: 'object',
      properties: { slug: { type: 'string' } },
      required: ['slug'],
      additionalProperties: false,
    },
    async run(args: unknown, tc: ToolContext): Promise<ToolResult> {
      const slug = readString(args, 'slug');
      if (slug === undefined) {
        return { ok: false, error: 'read_spec requires a string "slug"' };
      }
      const specFile = path.join(
        services.baitonDir,
        SPECS_SUBDIR,
        slug,
        'spec.md',
      );
      const resolved = await tc.ctx.resolveReadPath(specFile);
      if (!resolved.ok) {
        return { ok: false, error: resolved.error.message };
      }
      let text: string;
      try {
        text = await fs.readFile(resolved.resolved, 'utf8');
      } catch {
        return { ok: false, error: `spec "${slug}" was not found` };
      }
      const bounded = tc.ctx.boundRead(text);
      return {
        ok: true,
        data: { slug, text: bounded.text, truncated: bounded.truncated },
      };
    },
  };
}

/** `list_files(glob)` — repository-relative paths matching a glob pattern. */
function listFilesTool(services: ToolServices): Tool {
  return {
    name: 'list_files',
    description: 'List repository-relative file paths matching the given glob pattern.',
    mutating: false,
    schema: {
      type: 'object',
      properties: { glob: { type: 'string' } },
      required: ['glob'],
      additionalProperties: false,
    },
    async run(args: unknown, tc: ToolContext): Promise<ToolResult> {
      const glob = readString(args, 'glob');
      if (glob === undefined) {
        return { ok: false, error: 'list_files requires a string "glob"' };
      }
      const all = await walkFiles(services.repoRoot);
      const matched = all.filter((rel) => matchesGlob(rel, glob));
      const bounded = tc.ctx.boundRead(matched.join('\n'));
      const files = bounded.text === '' ? [] : bounded.text.split('\n');
      return { ok: true, data: { files, truncated: bounded.truncated } };
    },
  };
}

/**
 * `read_file(path, range?)` — a file's text, or a 1-based inclusive line range
 * of it, bounded to the read cap. The path resolves through the guard so a
 * symlink escaping the repo root is rejected (Req 9.2, 9.3).
 */
function readFileTool(_services: ToolServices): Tool {
  return {
    name: 'read_file',
    description: "Read a file's text, or an optional 1-based inclusive line range of it.",
    mutating: false,
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        range: {
          type: 'array',
          items: { type: 'integer' },
          minItems: 2,
          maxItems: 2,
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    async run(args: unknown, tc: ToolContext): Promise<ToolResult> {
      const requested = readString(args, 'path');
      if (requested === undefined) {
        return { ok: false, error: 'read_file requires a string "path"' };
      }
      const range = readRange(args);
      if (range === 'invalid') {
        return {
          ok: false,
          error: 'read_file "range" must be a [startLine, endLine] pair of 1-based integers',
        };
      }
      const resolved = await tc.ctx.resolveReadPath(requested);
      if (!resolved.ok) {
        return { ok: false, error: resolved.error.message };
      }
      let text: string;
      try {
        text = await fs.readFile(resolved.resolved, 'utf8');
      } catch {
        return { ok: false, error: `file not found or unreadable: ${requested}` };
      }
      if (range !== undefined) {
        text = sliceLines(text, range[0], range[1]);
      }
      const bounded = tc.ctx.boundRead(text);
      return {
        ok: true,
        data: { path: requested, text: bounded.text, truncated: bounded.truncated },
      };
    },
  };
}

/**
 * `search(pattern, glob?)` — lines matching a regular expression across the
 * files an optional glob selects (all files when omitted). Each match reports
 * the file, 1-based line number and line text; the joined output is bounded to
 * the read cap (Req 9.4).
 */
function searchTool(services: ToolServices): Tool {
  return {
    name: 'search',
    description: 'Search repository file contents for lines matching a regular expression.',
    mutating: false,
    schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        glob: { type: 'string' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    async run(args: unknown, tc: ToolContext): Promise<ToolResult> {
      const pattern = readString(args, 'pattern');
      if (pattern === undefined) {
        return { ok: false, error: 'search requires a string "pattern"' };
      }
      const glob = readString(args, 'glob');
      let regex: RegExp;
      try {
        regex = new RegExp(pattern);
      } catch {
        return { ok: false, error: `search "pattern" is not a valid regular expression: ${pattern}` };
      }

      const all = await walkFiles(services.repoRoot);
      const candidates = glob === undefined ? all : all.filter((rel) => matchesGlob(rel, glob));

      const matches: { file: string; line: number; text: string }[] = [];
      for (const rel of candidates) {
        const abs = path.join(services.repoRoot, rel);
        // Re-check containment through the guard so a candidate that resolves
        // outside the repo (e.g. via an existing symlinked ancestor) is skipped.
        const resolved = await tc.ctx.resolveReadPath(abs);
        if (!resolved.ok) {
          continue;
        }
        let content: string;
        try {
          content = await fs.readFile(resolved.resolved, 'utf8');
        } catch {
          continue;
        }
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            matches.push({ file: rel, line: i + 1, text: lines[i] });
          }
        }
      }

      const rendered = matches
        .map((m) => `${m.file}:${m.line}:${m.text}`)
        .join('\n');
      const bounded = tc.ctx.boundRead(rendered);
      return {
        ok: true,
        data: { matches, rendered: bounded.text, truncated: bounded.truncated },
      };
    },
  };
}

/** `git_status` — the working-tree status via the git service seam. */
function gitStatusTool(services: ToolServices): Tool {
  return {
    name: 'git_status',
    description: 'Report the working-tree status: whether it is clean and any pending changes.',
    mutating: false,
    schema: { type: 'object', properties: {}, additionalProperties: false },
    async run(): Promise<ToolResult> {
      try {
        const status = await services.git.status();
        return {
          ok: true,
          data: { clean: status.clean, changes: status.changes },
        };
      } catch (e) {
        return { ok: false, error: gitErrorMessage(e) };
      }
    },
  };
}

/**
 * `git_diff(ref?)` — the diff between an optional ref and the working tree.
 * With no ref, diffs the working tree against `HEAD`; with a ref, against that
 * ref. The diff text is bounded to the read cap (Req 9.4).
 */
function gitDiffTool(services: ToolServices): Tool {
  return {
    name: 'git_diff',
    description: 'Show the diff between the working tree and an optional ref (defaults to HEAD).',
    mutating: false,
    schema: {
      type: 'object',
      properties: { ref: { type: 'string' } },
      additionalProperties: false,
    },
    async run(args: unknown, tc: ToolContext): Promise<ToolResult> {
      const ref = readString(args, 'ref');
      try {
        // Diff the working tree against the given ref (or HEAD when omitted).
        const diff = await services.git.diffAgainstWorkingTree(ref);
        const bounded = tc.ctx.boundRead(diff);
        return { ok: true, data: { diff: bounded.text, truncated: bounded.truncated } };
      } catch (e) {
        return { ok: false, error: gitErrorMessage(e) };
      }
    },
  };
}

/**
 * `git_log(n)` — the most recent `n` commits as `<sha> <subject>` lines, bounded
 * to the read cap. `n` defaults to a small window and is clamped to a positive
 * integer.
 */
function gitLogTool(services: ToolServices): Tool {
  return {
    name: 'git_log',
    description: 'List the most recent commits as "<sha> <subject>" lines, bounded to the read cap.',
    mutating: false,
    schema: {
      type: 'object',
      properties: { n: { type: 'integer', minimum: 1 } },
      additionalProperties: false,
    },
    async run(args: unknown, tc: ToolContext): Promise<ToolResult> {
      const n = readPositiveInt(args, 'n') ?? 20;
      try {
        const raw = await services.git.log(n);
        const bounded = tc.ctx.boundRead(raw);
        const entries = bounded.text === '' ? [] : bounded.text.split('\n');
        return { ok: true, data: { entries, truncated: bounded.truncated } };
      } catch (e) {
        return { ok: false, error: gitErrorMessage(e) };
      }
    },
  };
}

/** Read a required string field from an args object, or undefined. */
function readString(args: unknown, key: string): string | undefined {
  if (typeof args !== 'object' || args === null) {
    return undefined;
  }
  const value = (args as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/** Read an optional positive-integer field, or undefined when absent/invalid. */
function readPositiveInt(args: unknown, key: string): number | undefined {
  if (typeof args !== 'object' || args === null) {
    return undefined;
  }
  const value = (args as Record<string, unknown>)[key];
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1) {
    return value;
  }
  return undefined;
}

/**
 * Read an optional `range` argument as a 1-based inclusive `[start, end]` pair.
 * Returns `undefined` when absent, `'invalid'` when present but malformed, or
 * the validated pair otherwise.
 */
function readRange(args: unknown): [number, number] | undefined | 'invalid' {
  if (typeof args !== 'object' || args === null) {
    return undefined;
  }
  const value = (args as Record<string, unknown>).range;
  if (value === undefined) {
    return undefined;
  }
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !value.every((v) => typeof v === 'number' && Number.isInteger(v) && v >= 1)
  ) {
    return 'invalid';
  }
  const [start, end] = value as [number, number];
  if (end < start) {
    return 'invalid';
  }
  return [start, end];
}

/** Slice `text` to the 1-based inclusive line range `[start, end]`. */
function sliceLines(text: string, start: number, end: number): string {
  const lines = text.split('\n');
  // Clamp to the file's bounds; an out-of-range request yields the overlap.
  return lines.slice(start - 1, end).join('\n');
}

/** Render a caught git error into a user-facing message. */
function gitErrorMessage(e: unknown): string {
  if (typeof e === 'object' && e !== null && 'command' in e) {
    const ge = e as { command: string; stderr?: string };
    return `git command failed: ${ge.command}${ge.stderr ? `\n${ge.stderr}` : ''}`;
  }
  return e instanceof Error ? e.message : String(e);
}
