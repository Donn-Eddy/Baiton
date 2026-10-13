/** Lists plan documents and their per-phase planner artifacts without VS Code. */
import * as fs from 'fs/promises';
import * as path from 'path';
import type { DocumentKind } from '../model/parser';
import type { RepoTopology } from '../model/validator';
import { listDocumentSlugs, phaseArtifactDir, resolveDocument } from '../storage/documentLocation';
import { repoTopologyFor, reposWithBaiton, type RepoSet } from './repoDiscovery';

export interface ListedPlan {
  slug: string;
  kind: DocumentKind;
  raw?: string;
  readError?: string;
}

/** A repository root whose plan documents should be listed. */
export interface PlanListingRepo {
  repo: string;
  baitonDir: string;
  topology?: RepoTopology;
}

/** A listed plan tagged with the repository that owns its document. */
export interface RepoListedPlan extends ListedPlan {
  repo: string;
  baitonDir: string;
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

/** List every repository's plans in source order, isolating failures per repository. */
export async function listPlansAcrossRepos(
  repos: readonly PlanListingRepo[],
): Promise<RepoListedPlan[]> {
  const listed: RepoListedPlan[] = [];
  for (const repo of repos) {
    try {
      const plans = await listPlans(repo.baitonDir);
      listed.push(...plans.map((plan) => ({
        ...plan,
        repo: repo.repo,
        baitonDir: repo.baitonDir,
      })));
    } catch {
      // One missing or unreadable repository must not hide the others.
    }
  }
  return listed;
}

/** Project discovered repositories with `.baiton/` directories into plan sources. */
export function planListingRepos(set: RepoSet): PlanListingRepo[] {
  return reposWithBaiton(set).map((repo) => ({
    repo: repo.name,
    baitonDir: repo.baitonDir as string,
    topology: repoTopologyFor(set, repo.name),
  }));
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
