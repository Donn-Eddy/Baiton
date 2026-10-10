/** Lists plan documents and their per-phase planner artifacts without VS Code. */
import * as fs from 'fs/promises';
import * as path from 'path';
import type { DocumentKind } from '../model/parser';
import { listDocumentSlugs, phaseArtifactDir, resolveDocument } from '../storage/documentLocation';

export interface ListedPlan {
  slug: string;
  kind: DocumentKind;
  raw?: string;
  readError?: string;
}

/** Read each resolved document once, preserving ascending slug order. */
export async function listPlans(baitonDir: string): Promise<ListedPlan[]> {
  const listed: ListedPlan[] = [];
  for (const slug of listDocumentSlugs(baitonDir)) {
    const location = resolveDocument(baitonDir, slug);
    try {
      listed.push({ slug, kind: location.kind, raw: await fs.readFile(location.documentPath, 'utf8') });
    } catch (err) {
      if (isNotFound(err)) continue;
      listed.push({ slug, kind: location.kind, readError: describeError(err) });
    }
  }
  return listed;
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}

function describeError(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return 'the plan document could not be read';
}

/** Absolute path to the per-phase plan output (`phases/<id>/plan.md`). */
export function phasePlanPath(baitonDir: string, slug: string, phaseId: string): string {
  return path.join(phaseArtifactDir(resolveDocument(baitonDir, slug), phaseId), 'plan.md');
}

/** Phase ids whose plan artifact is on file. */
export async function listPhasePlans(baitonDir: string, slug: string): Promise<Set<string>> {
  const plans = new Set<string>();
  const artifactsDir = resolveDocument(baitonDir, slug).artifactsDir;
  let entries: string[];
  try { entries = await fs.readdir(artifactsDir); } catch { return plans; }
  await Promise.all(entries.map(async (phaseId) => {
    try {
      await fs.access(phasePlanPath(baitonDir, slug, phaseId));
      plans.add(phaseId);
    } catch {
      // This phase has no plan artifact.
    }
  }));
  return plans;
}
