import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * The `.baiton/.gitignore` contents written by the Initialize command
 * (Requirement 1.2).
 *
 * The file excludes, relative to the `.baiton/` directory:
 * - `.lock`                    — the (deferred) lock file, never versioned.
 * - `config.local.json`        — the personal, gitignored config overlay the
 *                                Config Panel and Initialize write; the
 *                                committed `config.json` baseline stays tracked.
 * - `.config*json.*.tmp`       — sibling temp files `writeJsonAtomic` renames
 *                                over the config, ignored so an interrupted
 *                                write never appears in git status.
 * - `chat.jsonl`               — the legacy single workspace transcript, kept
 *                                so a pre-sessions checkout stays ignored until
 *                                it is migrated away.
 * - `chat/`                     — the workspace conversation's chat sessions.
 * - `runs/`                    — all per-run artifacts (briefs, results).
 * - `worktrees/`              — all per-run git worktrees (`.baiton/worktrees/<run-id>/`).
 * - `plans/<slug>/chat/`      — each plan conversation's chat sessions.
 * - `plans/<slug>/runs.jsonl` — each plan's run journal.
 * - `specs/<slug>/...`        — Legacy spec artifacts.
 *
 * Patterns are anchored with a leading `/` where they must match only at the
 * `.baiton/` root (`.lock`, `config.local.json`, `.config*json.*.tmp`,
 * `chat.jsonl`, `runs/`, `worktrees/`) so an identically named file deeper in
 * the tree is not swept up unintentionally.
 * The Legacy patterns use a wildcard segment to cover every `specs/<slug>/`
 * folder.
 */

/** The literal text written to `.baiton/.gitignore`, including a trailing newline. */
export const GITIGNORE_CONTENTS = [
  '# Baiton-owned files that must never be committed.',
  '/.lock',
  '/config.local.json',
  '/.config*json.*.tmp',
  '/chat.jsonl',
  '/chat/',
  '/runs/',
  '/worktrees/',
  'plans/*/chat/',
  'plans/*/runs.jsonl',
  '# Legacy specs/ documents.',
  // Legacy: preserve chat and journal files created under the former root.
  'specs/*/chat.jsonl',
  // Legacy: keep the former per-document chat directory ignored.
  'specs/*/chat/',
  // Legacy: keep the former per-document journal ignored.
  'specs/*/runs.jsonl',
  '',
].join('\n');

/**
 * Ignore lines written by older Baiton builds that should be removed during
 * refresh instead of being retained as user additions. Every entry was
 * written by an older Baiton build.
 */
export const RETIRED_GITIGNORE_LINES: readonly string[] = [
  // This obsolete pattern was written by an older build.
  '/chat/*',
];

/** Outcome of {@link refreshGitignore}. */
export type GitignoreRefresh = 'unchanged' | 'rewritten';

/**
 * Merge the canonical exclusions into `.baiton/.gitignore`, preserving lines
 * outside the canonical set.
 *
 * The Initialize command writes the file once, but the exclusion list grows
 * as new Baiton-owned artifacts appear (for example the per-session `chat/`
 * folders). A workspace initialized by an older build would otherwise keep a
 * stale ignore list until Initialize is rerun by hand, so activation merges
 * the required lines while preserving user additions. A missing `.baiton/`
 * directory is not created here: an uninitialized folder is left alone.
 */
export function mergeGitignore(current: string | undefined): string {
  if (current === undefined) {
    return GITIGNORE_CONTENTS;
  }

  const managed = new Set(GITIGNORE_CONTENTS.split('\n').filter((line) => line.length > 0));
  const retired = new Set(RETIRED_GITIGNORE_LINES);
  const kept = current.split(/\r?\n/).filter((line) => {
    const comparison = line.replace(/\s+$/, '');
    return !managed.has(comparison) && !retired.has(comparison);
  });

  while (kept.length > 0 && kept[0].trim().length === 0) {
    kept.shift();
  }
  while (kept.length > 0 && kept[kept.length - 1].trim().length === 0) {
    kept.pop();
  }

  if (kept.length === 0) {
    return GITIGNORE_CONTENTS;
  }
  return `${GITIGNORE_CONTENTS}\n${kept.join('\n')}\n`;
}

export async function refreshGitignore(baitonDir: string): Promise<GitignoreRefresh> {
  const gitignorePath = path.join(baitonDir, '.gitignore');
  let current: string | undefined;
  try {
    current = await fs.readFile(gitignorePath, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw cause;
    }
  }
  const next = mergeGitignore(current);
  if (next === current) {
    return 'unchanged';
  }
  await fs.writeFile(gitignorePath, next, 'utf8');
  return 'rewritten';
}
