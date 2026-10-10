/** Filesystem, serializer and git implementation of the engine's PlanStore seam. */
import * as fsp from 'fs/promises';
import * as path from 'path';
import { approvalHash, computeInputRev, isBlocked as deriveBlocked } from '../model/hash';
import { parsePlan, type ParsedPlan } from '../model/parser';
import { writePhaseState } from '../model/writer';
import { isErr } from '../model/result';
import type { PhaseState } from '../model/phaseState';
import type { Stage } from '../model/stage';
import type { GitWorktreeService } from '../git';
import { createPlanBranchWriter, type PlanBranchWriter, type PlanStore } from '../engine';
import { persistencePathForStage, stageArtifactIsNumbered } from '../schema';
import { resolveDocument } from '../storage/documentLocation';
import { readPlanJournal, type JournalEntry } from '../journal';

/** Build a PlanStore rooted at a repository's `.baiton` directory. */
export function createPlanStore(
  baitonDir: string,
  git: GitWorktreeService,
  writer: PlanBranchWriter = createPlanBranchWriter({ baitonDir, git }),
): PlanStore {
  const locate = (slug: string) => resolveDocument(baitonDir, slug);

  const readPlan = async (slug: string): Promise<ParsedPlan | undefined> => {
    try {
      return parsePlan(await fsp.readFile(locate(slug).documentPath, 'utf8'));
    } catch {
      return undefined;
    }
  };

  return {
    async currentState(slug, phaseId): Promise<PhaseState | undefined> {
      return (await readPlan(slug))?.phases.find((phase) => phase.id === phaseId)?.state;
    },

    readPlan,

    async readArtifact(slug, phaseId, stage): Promise<string | undefined> {
      const location = locate(slug);
      const numbered = stageArtifactIsNumbered(stage);
      const relative = persistencePathForStage(stage, phaseId, numbered ? 1 : undefined, location.kind);
      const artifactDir = path.dirname(path.join(location.dir, relative));
      const fileName = stageArtifactIsNumbered(stage)
        ? await latestNumbered(artifactDir, stage)
        : baseName(relative);
      if (fileName === undefined) return undefined;
      try {
        return await fsp.readFile(path.join(artifactDir, fileName), 'utf8');
      } catch {
        return undefined;
      }
    },

    async latestExecuteCommit(slug, phaseId): Promise<string | undefined> {
      let commit: string | undefined;
      for (const entry of readPlanJournal(baitonDir, slug)) {
        if (entry.stage === 'execute' && entry.todoId === phaseId && entry.result === 'completed' && entry.commit !== undefined) {
          commit = entry.commit;
        }
      }
      return commit;
    },

    async isApproved(slug): Promise<boolean> {
      const plan = await readPlan(slug);
      if (plan === undefined) return false;
      const recorded = (plan.frontmatter.get('approved_rev') ?? '').trim();
      return recorded !== '' && recorded === approvalHash(plan);
    },

    async isBlocked(slug, phaseId): Promise<boolean> {
      const plan = await readPlan(slug);
      if (plan === undefined) return false;
      const phase = plan.phases.find((item) => item.id === phaseId);
      return phase === undefined ? false : deriveBlocked(phase, plan.phases);
    },

    async inputRev(slug, phaseId): Promise<string> {
      const plan = await readPlan(slug);
      return plan === undefined ? '' : computeInputRev(plan, phaseId);
    },

    async inputRevMatches(slug, phaseId): Promise<boolean> {
      const plan = await readPlan(slug);
      if (plan === undefined) return false;
      const current = computeInputRev(plan, phaseId);
      const recorded = recordedPlanInputRev(readPlanJournal(baitonDir, slug), phaseId);
      return recorded === undefined || recorded === current;
    },

    async writeState(slug, phaseId, state, note): Promise<boolean> {
      return writer.apply(slug, async (scope) => {
        let current: string;
        try {
          current = await fsp.readFile(scope.location.documentPath, 'utf8');
        } catch {
          return false;
        }
        const written = writePhaseState(current, phaseId, state);
        if (isErr(written) || written.value === current) return false;
        try {
          await fsp.writeFile(scope.location.documentPath, written.value, 'utf8');
          await scope.commit(`plan(${slug}): ${phaseId} ${what(state, note)}`);
          return true;
        } catch {
          return false;
        }
      });
    },

    async persistArtifact(slug, artifactPath, contents): Promise<void> {
      await writer.apply(slug, async () => {
        await fsp.mkdir(path.dirname(artifactPath), { recursive: true });
        await fsp.writeFile(artifactPath, contents, 'utf8');
      });
    },
  };
}

async function latestNumbered(dir: string, stage: Stage): Promise<string | undefined> {
  let names: string[];
  try { names = await fsp.readdir(dir); } catch { return undefined; }
  const pattern = new RegExp(`^${stage}-(\\d+)\\.md$`);
  let best: { name: string; n: number } | undefined;
  for (const name of names) {
    const match = pattern.exec(name);
    if (match === null) continue;
    const n = Number(match[1]);
    if (best === undefined || n > best.n) best = { name, n };
  }
  return best?.name;
}

function baseName(relativePath: string): string {
  const parts = relativePath.split('/');
  return parts[parts.length - 1];
}

function recordedPlanInputRev(entries: JournalEntry[], phaseId: string): string | undefined {
  let latest: string | undefined;
  for (const entry of entries) {
    if (entry.stage === 'plan' && entry.todoId === phaseId) latest = entry.inputRev;
  }
  return latest;
}

function what(state: PhaseState, note?: string): string {
  return note !== undefined && note.length > 0 ? `${state} (${note})` : state;
}
