import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * The `.baiton/.gitignore` contents written by the Initialize command
 * (Requirement 1.2).
 *
 * The file excludes, relative to the `.baiton/` directory:
 * - `.lock`                    — the (deferred) lock file, never versioned.
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
 * `.baiton/` root (`.lock`, `chat.jsonl`, `runs/`, `worktrees/`) so an
 * identically named file deeper in the tree is not swept up unintentionally.
 * The Legacy patterns use a wildcard segment to cover every `specs/<slug>/`
 * folder.
 */

/** The literal text written to `.baiton/.gitignore`, including a trailing newline. */
export const GITIGNORE_CONTENTS = [
  '# Baiton-owned files that must never be committed.',
  '/.lock',
  '/chat.jsonl',
  '/chat/',
  '/runs/',
  '/worktrees/',
  'plans/*/chat/',
  'plans/*/runs.jsonl',
  '# Legacy specs/ documents.',
  'specs/*/chat.jsonl',
  'specs/*/chat/',
  'specs/*/runs.jsonl',
  '',
].join('\n');

/** Outcome of {@link refreshGitignore}. */
export type GitignoreRefresh = 'unchanged' | 'rewritten';

/**
 * Bring `.baiton/.gitignore` up to date with {@link GITIGNORE_CONTENTS}.
 *
 * The Initialize command writes the file once, but the exclusion list grows
 * as new Baiton-owned artifacts appear (for example the per-session `chat/`
 * folders). A workspace initialized by an older build would otherwise keep a
 * stale ignore list until Initialize is rerun by hand, so activation calls
 * this to rewrite the file whenever its contents differ from the canonical
 * text. A missing `.baiton/` directory is not created here: an uninitialized
 * folder is left alone.
 */
export async function refreshGitignore(baitonDir: string): Promise<GitignoreRefresh> {
  const gitignorePath = path.join(baitonDir, '.gitignore');
  let current: string | undefined;
  try {
    current = await fs.readFile(gitignorePath, 'utf8');
  } catch {
    current = undefined;
  }
  if (current === GITIGNORE_CONTENTS) {
    return 'unchanged';
  }
  await fs.writeFile(gitignorePath, GITIGNORE_CONTENTS, 'utf8');
  return 'rewritten';
}
