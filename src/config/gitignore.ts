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
 * - `specs/<slug>/chat.jsonl` — each spec's legacy single transcript.
 * - `specs/<slug>/chat/`      — each spec conversation's chat sessions.
 * - `specs/<slug>/runs.jsonl` — each spec's run journal.
 *
 * Patterns are anchored with a leading `/` where they must match only at the
 * `.baiton/` root (`.lock`, `chat.jsonl`, `runs/`) so an identically named file
 * deeper in the tree is not swept up unintentionally. The per-spec patterns use
 * a wildcard segment to cover every `specs/<slug>/` folder.
 */

/** The literal text written to `.baiton/.gitignore`, including a trailing newline. */
export const GITIGNORE_CONTENTS = [
  '# Baiton-owned files that must never be committed.',
  '/.lock',
  '/chat.jsonl',
  '/chat/',
  '/runs/',
  'specs/*/chat.jsonl',
  'specs/*/chat/',
  'specs/*/runs.jsonl',
  '',
].join('\n');
