/**
 * A tiny, dependency-free glob matcher and repository walker for the read tools
 * `list_files(glob)` and `search(pattern, glob?)` (Req 9.1).
 *
 * The extension ships zero native modules and carries no glob dependency (Req
 * 23.1), so this module provides just enough of the common glob grammar to
 * scope those two tools: `*` (any run of non-separator characters), `**` (any
 * number of path segments, including none), `?` (a single non-separator
 * character), and literal path text. Matching is performed on repository-
 * relative, forward-slash paths.
 *
 * The walker enumerates regular files under a root, skipping the `.git`
 * directory (never a spec concern) and following no symlinked directories, so a
 * symlink cannot be used to walk outside the tree. Per-file containment is
 * still re-checked by the guard when a tool resolves a specific path.
 */
import * as fs from 'fs/promises';
import * as path from 'path';

/** Compiles a glob pattern to a `RegExp` anchored over a full relative path. */
export function globToRegExp(glob: string): RegExp {
  // Normalize separators so a Windows-style pattern still matches the
  // forward-slash relative paths the walker produces.
  const normalized = glob.replace(/\\/g, '/');
  let re = '';
  for (let i = 0; i < normalized.length; i++) {
    const c = normalized[i];
    if (c === '*') {
      if (normalized[i + 1] === '*') {
        // `**` — any number of segments. Consume an optional following slash so
        // `a/**/b` matches `a/b` as well as `a/x/y/b`.
        i++;
        if (normalized[i + 1] === '/') {
          i++;
        }
        re += '(?:[^/]+/)*';
      } else {
        // `*` — any run of non-separator characters within a single segment.
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += escapeRegexChar(c);
    }
  }
  return new RegExp(`^${re}$`);
}

/** Whether a repository-relative path matches a glob pattern. */
export function matchesGlob(relativePath: string, glob: string): boolean {
  return globToRegExp(glob).test(toPosix(relativePath));
}

/**
 * Recursively lists every regular file under `root`, returning repository-
 * relative, forward-slash paths sorted lexicographically. `.git` is skipped and
 * symlinked directories are not descended into so the walk cannot escape the
 * tree. Symlinked files are reported (as relative paths) but a caller that
 * reads them still passes through the guard's symlink-resolving containment
 * check.
 */
export async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  await walk(root, root, out);
  out.sort();
  return out;
}

/** Depth-first walk collecting relative file paths into `out`. */
async function walk(root: string, dir: string, out: string[]): Promise<void> {
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    // An unreadable directory contributes no files rather than aborting the
    // whole walk; a read tool surfaces its own errors on a specific path.
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      // Do not follow symlinks during the walk; a directory symlink could point
      // outside the tree. A symlinked file is skipped from enumeration.
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.git') {
        continue;
      }
      await walk(root, full, out);
    } else if (entry.isFile()) {
      out.push(toPosix(path.relative(root, full)));
    }
  }
}

/** Convert an OS path to forward-slash form for stable matching and output. */
function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/** Escape a single character for safe literal use inside a `RegExp`. */
function escapeRegexChar(c: string): string {
  return /[.*+?^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
}
