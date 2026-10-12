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
import { GitService } from '../git';
import type { InterventionSeam } from './interventions';
import {
  Clock,
  ConfirmSeam,
  DraftPlanSeam,
  IdGenerator,
  LandPhaseSeam,
  RunPipelineSeam,
  RunQueueSeam,
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
  landPhase?: LandPhaseSeam;
  /**
   * The seam spawn_subagent and send_to_subagent go through. Optional so a host that has not wired sub-agents still builds a registry; both tools then report themselves unavailable.
   */
  subAgents?: SubAgentSeam;
  clock: Clock;
  ids: IdGenerator;
  gitSettings: ToolGitSettings;
  /**
   * Submit the plan's pull request (design section 8 "PR"): Verify, the
   * pr-writer stage, push, create-or-reuse, record. Optional so a host that
   * has not wired the PR flow still builds a registry; the `submit_pr` tool
   * then reports it as unavailable.
   */
  submitPr?: (slug: string) => Promise<SubmitPrOutcome>;
}

/** The `submit_pr` tool's view of the flow's result. */
export type SubmitPrOutcome =
  | { ok: true; url: string; reused: boolean; title: string }
  | { ok: false; error: string };
