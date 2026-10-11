/**
 * Document storage layouts:
 * `.baiton/plans/<slug>/plan.md` with `phases/<id>/` artifacts, and the legacy
 * `.baiton/specs/<slug>/spec.md` with `todos/<id>/` artifacts (Legacy layout).
 */
import { existsSync, readdirSync, statSync } from 'fs';
import * as path from 'path';
import type { DocumentKind } from '../model/parser';

export const PLANS_SUBDIR = 'plans';
// Legacy: pre-phased-plan documents live under .baiton/specs/; read-only compatibility.
export const LEGACY_SPECS_SUBDIR = 'specs';

/** Legacy documents retain their existing spec.md filename. */
export function documentFileName(kind: DocumentKind): 'plan.md' | 'spec.md' {
  if (kind === 'plan') return 'plan.md';
  // Legacy: existing documents keep the spec.md filename.
  return 'spec.md';
}

// Legacy: artifactsSubdirName preserves the old todos/ artifact layout.
export function artifactsSubdirName(kind: DocumentKind): 'phases' | 'todos' {
  // Legacy documents retain their original artifact layout.
  if (kind === 'plan') return 'phases';
  // Legacy: existing documents keep their todos/ artifact directory.
  return 'todos';
}

export interface DocumentLocation {
  /** The plan slug. */
  slug: string;
  /** Whether this is a phased plan or a Legacy spec. */
  kind: DocumentKind;
  /** Absolute `<baitonDir>/<root>/<slug>` directory. */
  dir: string;
  /** Absolute `plan.md` path or, for a legacy document, its `spec.md` path. */
  documentPath: string;
  /** Absolute `phases/` or Legacy `todos/` directory. */
  artifactsDir: string;
  /** Repo-relative document folder pathspec, with forward slashes. */
  pathspec: string;
}

/** Compute a document location without checking the filesystem. */
export function locationFor(
  baitonDir: string,
  slug: string,
  kind: DocumentKind,
): DocumentLocation {
  const root = kind === 'plan' ? PLANS_SUBDIR : LEGACY_SPECS_SUBDIR;
  const dir = path.join(baitonDir, root, slug);
  return {
    slug,
    kind,
    dir,
    documentPath: path.join(dir, documentFileName(kind)),
    artifactsDir: path.join(dir, artifactsSubdirName(kind)),
    pathspec: `.baiton/${root}/${slug}`,
  };
}

/**
 * Resolve a slug using one rule: prefer an existing plans/.../plan.md, then
 * Legacy specs/.../spec.md, then an existing plans directory, then a Legacy
 * specs directory (including a draft without spec.md); otherwise use
 * plans for a new document. A slug in both roots always resolves to plans.
 */
export function resolveDocument(baitonDir: string, slug: string): DocumentLocation {
  const plan = locationFor(baitonDir, slug, 'plan');
  const legacy = locationFor(baitonDir, slug, 'legacy-spec');
  if (isFile(plan.documentPath)) return plan;
  if (isFile(legacy.documentPath)) return legacy;
  if (isDirectory(plan.dir)) return plan;
  if (isDirectory(legacy.dir)) return legacy;
  return plan;
}

export function phaseArtifactDir(location: DocumentLocation, phaseId: string): string {
  return path.join(location.artifactsDir, phaseId);
}

/** Return the sorted, deduplicated union of slugs found under both roots. */
export function listDocumentSlugs(baitonDir: string): string[] {
  const slugs = new Set<string>();
  for (const root of [PLANS_SUBDIR, LEGACY_SPECS_SUBDIR]) {
    try {
      for (const entry of readdirSync(path.join(baitonDir, root), { withFileTypes: true })) {
        if (entry.isDirectory()) slugs.add(entry.name);
      }
    } catch {
      // Missing or unreadable roots contribute no slugs.
    }
  }
  return [...slugs].sort();
}

function isFile(file: string): boolean {
  try { return statSync(file).isFile(); } catch { return false; }
}

function isDirectory(dir: string): boolean {
  try { return existsSync(dir) && statSync(dir).isDirectory(); } catch { return false; }
}
