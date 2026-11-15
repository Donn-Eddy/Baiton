/**
 * The services every orchestrator tool is built against (design "Orchestrator:
 * tool registry and guard").
 *
 * A tool is a pure factory `(services) => Tool`: it closes over these injected
 * dependencies and never imports `vscode`, so the whole registry is
 * constructable and testable outside a VS Code host. The activation layer
 * assembles a {@link ToolServices} from its real git service and VS-Code-backed
 * seams; a test assembles one from a temp repo and stubs.
 */
import * as fs from 'fs';
import { GitService } from '../git';
import type { RepoTopology } from '../model/validator';
import type { InterventionSeam } from './interventions';
import { formatPlanRef, normalizeRepoPath, parsePlanRef, createPlanRepoSeam } from './planRepos';
import { planRepoGuard, GuardContext, ToolContext } from './guard';
import {
  Clock,
  ConfirmSeam,
  DraftPlanSeam,
  IdGenerator,
  LandPhaseOutcome,
  LandPhaseRequest,
  RunPipelineSeam,
  RunQueueSeam,
  PlanRepoSeam,
  PlanRepoTarget,
  SubAgentSeam,
} from './seams';

/** The git settings the approval flow needs (remote to fetch, base branch). */
export interface ToolGitSettings {
  /** The git remote to fetch during approval (config `git.remote`). */
  remote: string;
  /** The default base branch a plan branches from (config `git.base`). */
  base: string;
}

/**
 * The dependency bundle passed to each tool factory.
 *
 * - `repoRoot`  — absolute repository root, matching the guard's `repoRoot`.
 * - `baitonDir` — absolute `.baiton/` directory at the repo root; `plans/`
 *                 (and legacy `specs/`) and `runs/` live under it.
 * - `git`       — the single git service seam (status/diff/log/approval git).
 * - `confirm`   — the yes/no confirmation seam `approve_plan`, `draft_plan` and
 *                 `submit_pr` gate on (Req 10.1); in the real host it is
 *                 `confirmSeamFrom(interventionSeam)`, so those confirmations
 *                 surface as inline chat cards. `ask_user` asks through the
 *                 `intervention` seam below directly.
 * - `intervention` — the richer human-in-the-loop seam `ask_user` asks its
 *                 questions through (question / confirm / permission).
 * - `runQueue`  — the serialized run-queue seam `run` dispatches into (Req 10.3).
 * - `draftPlan` — the plan-draft runner seam `draft_plan` dispatches into.
 * - `runPipeline` — the plan-less run pipeline seam `start_run` and
 *                 `investigate` dispatch into.
 * - `landPhase` — the seam `land_phase` merges a done phase's branch through.
 * - `subAgents` — the seam `spawn_subagent` and `send_to_subagent` go through
 *                 (optional; both tools report unavailable without it).
 * - `clock`     — wall clock for transcript timestamps.
 * - `ids`       — identifier source (reserved for tool-generated ids).
 * - `gitSettings` — the remote and base branch approval fetches/resolves from.
 * - `gitSettingsFor` — optional settings lookup for a non-owner plan repo.
 */
export interface ToolServices {
  /** The conversation's OWNING repo root; read containment and file enumeration come from the GuardContext bound to the stage target repo. */
  repoRoot: string;
  /** The conversation's OWNING repo `.baiton/`; plan tools continue to read owner plans. */
  baitonDir: string;
  git: GitService;
  confirm: ConfirmSeam;
  /**
   * The human-in-the-loop seam every richer ask goes through (question /
   * confirm / permission). `ask_user` asks through it directly; `confirm`
   * above is the narrow yes/no adapter over the same seam
   * (`confirmSeamFrom`). Optional so a host that has not wired the chat still
   * builds a registry — `ask_user` then reports itself unavailable, and a host
   * that supplies only `confirm` keeps working unchanged.
   */
  intervention?: InterventionSeam;
  runQueue: RunQueueSeam;
  /**
   * The plan-draft runner the `draft_plan` tool hands an agreed request to.
   * Optional so a host that has not wired the stage engine still builds a
   * registry; `draft_plan` then reports it as unavailable.
   */
  draftPlan?: DraftPlanSeam;
  /** Addresses plans in every discovered `.baiton/` repo. A single-repo host passes `singleRepoPlanRepos`. */
  planRepos: PlanRepoSeam;
  /**
   * The plan-less run pipeline the `start_run` and `investigate` tools dispatch
   * into. Optional so a host that has not wired the run pipeline still builds a
   * registry; both tools then report themselves as unavailable and dispatch
   * nothing.
   */
  runPipeline?: RunPipelineSeam;
  /**
   * The seam `land_phase` merges a done phase's branch into the plan branch through. Optional so a host that has not wired per-phase worktrees still builds a registry; `land_phase` then reports itself unavailable.
   */
  landPhase?: PlanLandPhaseSeam;
  /**
   * The seam spawn_subagent and send_to_subagent go through. Optional so a host that has not wired sub-agents still builds a registry; both tools then report themselves unavailable.
   */
  subAgents?: SubAgentSeam;
  clock: Clock;
  ids: IdGenerator;
  gitSettings: ToolGitSettings;
  /** Remote and base for a non-owner plan repo; callers fall back to `gitSettings` when absent. */
  gitSettingsFor?: (repoRoot: string) => ToolGitSettings;
  /**
   * Submit the plan's pull request (design section 8 "PR"): Verify, the
   * pr-writer stage, push, create-or-reuse, record. Optional so a host that
   * has not wired the PR flow still builds a registry; the `submit_pr` tool
   * then reports it as unavailable.
   */
  submitPr?: (slug: string, planRepoRoot?: string) => Promise<SubmitPrOutcome>;
}

export interface PlanLandPhaseRequest extends LandPhaseRequest {
  /** Absolute owning-repo root; omitted for the conversation's own repo. */
  repoRoot?: string;
}

export interface PlanLandPhaseSeam {
  land(req: PlanLandPhaseRequest): Promise<LandPhaseOutcome>;
}

/** A resolved plan address and the repo-specific services used by plan tools. */
export interface ResolvedPlan {
  slug: string;
  repoPath: string;
  isOwner: boolean;
  root: string;
  baitonDir: string;
  git: GitService;
  topology: RepoTopology | undefined;
  guard: GuardContext;
  label: string;
}

/** Match the canonical document slug grammar used by the plan tools. */
export function isPlanSlug(slug: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(slug) && slug !== '.' && slug !== '..';
}

/** Build the mandatory seam for a host that knows only its conversation repo. */
export function singleRepoPlanRepos(
  repoRoot: string,
  git: GitService,
  restricted: () => boolean = () => false,
): PlanRepoSeam {
  return createPlanRepoSeam({
    repos: () => undefined,
    ownerRoot: repoRoot,
    restricted,
    gitFor: () => git,
    exists: (p) => fs.promises.access(p).then(() => true, () => false),
  });
}

/** Resolve a bare or qualified plan reference through the shared repo seam. */
export async function resolvePlanAddress(
  services: ToolServices,
  rawSlug: string,
  planRepo: string | undefined,
  tc: ToolContext,
  opts: { mutating: boolean },
): Promise<{ ok: true; plan: ResolvedPlan } | { ok: false; error: string }> {
  const parsed = parsePlanRef(rawSlug);
  if (!parsed.ok) return { ok: false, error: `invalid slug: ${rawSlug}` };
  const ref = parsed.ref;
  if (ref.repo !== undefined && planRepo !== undefined && normalizeRepoPath(ref.repo) !== normalizeRepoPath(planRepo)) {
    return { ok: false, error: `plan_repo "${planRepo}" conflicts with qualified slug "${rawSlug}"` };
  }
  if (!isPlanSlug(ref.slug)) return { ok: false, error: `invalid slug: ${rawSlug}` };
  const repo = planRepo ?? ref.repo;
  const located = await services.planRepos.locate(ref.slug, repo);
  let target: PlanRepoTarget | undefined;
  switch (located.kind) {
    case 'invalid':
      return { ok: false, error: located.error };
    case 'ambiguous':
      return {
        ok: false,
        error: `plan "${ref.slug}" exists in more than one repo; pass "plan_repo" or use a qualified slug: ${located.repos.map((r) => formatPlanRef(r, ref.slug)).join(', ')}`,
      };
    case 'found':
      target = located.target;
      break;
    case 'missing':
      if (repo !== undefined) {
        const resolved = services.planRepos.target(repo);
        if (!resolved.ok) return { ok: false, error: resolved.error };
        target = resolved.target;
      }
      break;
  }

  const ownerTarget = target === undefined || target.info.path === '.'
    ? services.planRepos.target('.')
    : undefined;
  const ownerTopology = target?.info.path === '.'
    ? target.topology
    : ownerTarget?.ok === true
      ? ownerTarget.target.topology
      : undefined;
  const plan: ResolvedPlan = target === undefined || target.info.path === '.'
    ? {
        slug: ref.slug,
        repoPath: '.',
        isOwner: true,
        root: services.repoRoot,
        baitonDir: services.baitonDir,
        git: services.git,
        topology: ownerTopology !== undefined && ownerTopology.repos.length > 1 ? ownerTopology : undefined,
        guard: tc.ctx,
        label: ref.slug,
      }
    : {
        slug: ref.slug,
        repoPath: target.info.path,
        isOwner: false,
        root: target.root,
        baitonDir: target.baitonDir,
        git: target.git,
        topology: target.topology.repos.length > 1 ? target.topology : undefined,
        guard: planRepoGuard(tc.ctx, target),
        label: formatPlanRef(target.info.path, ref.slug),
      };
  if (opts.mutating && !plan.isOwner && (tc.ctx.restricted || plan.guard.restricted)) {
    return { ok: false, error: 'plan writes are disabled in Restricted Mode' };
  }
  return { ok: true, plan };
}

/** Whether the plan seam exposes only the conversation repo. */
export function isSingleRepo(services: ToolServices): boolean {
  return services.planRepos.owners().length <= 1 && services.planRepos.list().length <= 1;
}

/** The `submit_pr` tool's view of the flow's result. */
export type SubmitPrOutcome =
  | { ok: true; url: string; reused: boolean; title: string; prs?: readonly { repo: string; url: string; reused: boolean }[] }
  | { ok: false; error: string };
