/**
 * Spec lister (Requirements 2.1, 6.5, 6.6).
 *
 * `listSpecs` is the only new filesystem reach for the Spec_Explorer: it scans
 * `.baiton/specs/*&#47;spec.md`, reads each present spec's raw `spec.md` text, and
 * returns one {@link ListedSpec} per spec in ascending slug order. The
 * host-free tree model (`buildSpecTree`) turns these listed specs plus each
 * spec's approval fact from the `SpecStore` into the nodes the tree renders.
 *
 * Tolerance: a spec whose `spec.md` cannot be read is returned with `readError`
 * set and `raw` left undefined rather than throwing, so one unreadable spec
 * does not drop the rest of the tree (Req 6.6). A missing specs directory
 * yields an empty list rather than an error (Req 2.1). This module uses node
 * `fs` directly and carries no `vscode` import, so it is testable against a
 * temp repo.
 */
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * One spec listed off disk: its slug and either the raw `spec.md` contents or a
 * read failure. Consumed as the lister-supplied half of the tree model's
 * `SpecInput` (the other half, the approval fact, comes from the `SpecStore`).
 */
export interface ListedSpec {
  /** The `<slug>` directory segment under `.baiton/specs/`. */
  slug: string;
  /** The `spec.md` contents; undefined when the file could not be read (Req 6.6). */
  raw?: string;
  /** Why the file could not be read/parsed, when applicable (Req 6.6). */
  readError?: string;
}

/**
 * Scan `.baiton/specs/*&#47;spec.md` and return one entry per spec whose
 * directory holds a `spec.md`, in ascending slug order (Req 2.1, 6.5).
 *
 * @param specsDir The `.baiton/specs` directory to scan.
 * @returns The listed specs in ascending slug order. A missing or unreadable
 *   `specsDir` yields `[]`; an individual spec whose `spec.md` cannot be read is
 *   returned with `readError` set and `raw` undefined (Req 6.6).
 */
export async function listSpecs(specsDir: string): Promise<ListedSpec[]> {
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(specsDir, { withFileTypes: true });
  } catch {
    // No specs directory yet (or it is unreadable): an empty list, not an
    // error — the explorer shows zero roots (Req 2.1).
    return [];
  }

  // Collect the slugs of directories, sorted ascending, before reading so the
  // returned order is deterministic regardless of readdir order (Req 2.1, 6.5).
  const slugs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const listed: ListedSpec[] = [];
  for (const slug of slugs) {
    const specFile = path.join(specsDir, slug, 'spec.md');
    let raw: string;
    try {
      raw = await fs.readFile(specFile, 'utf8');
    } catch (err) {
      // A directory without a readable `spec.md` is only a spec when the file
      // is present but unreadable/unparseable: surface it with a read error so
      // its root can be flagged invalid while the rest of the tree survives
      // (Req 6.6). A directory with no `spec.md` at all is not a spec (Req 2.1).
      if (isNotFound(err)) {
        continue;
      }
      listed.push({ slug, readError: describeError(err) });
      continue;
    }
    listed.push({ slug, raw });
  }
  return listed;
}

/** Whether a caught filesystem error is a "file does not exist" error. */
function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === 'ENOENT'
  );
}

/** A human-readable reason for a read failure, for the tree's error child. */
function describeError(err: unknown): string {
  if (err instanceof Error && err.message) {
    return err.message;
  }
  return 'spec.md could not be read';
}
