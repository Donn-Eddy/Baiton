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
import { Clock, ConfirmSeam, DraftSpecSeam, IdGenerator, RunQueueSeam } from './seams';

/** The git settings the approval flow needs (remote to fetch, base branch). */
export interface ToolGitSettings {
  /** The git remote to fetch during approval (config `git.remote`). */
  remote: string;
  /** The default base branch a spec branches from (config `git.base`). */
  base: string;
}

/**
 * The dependency bundle passed to each tool factory.
 *
 * - `repoRoot`  — absolute repository root, matching the guard's `repoRoot`.
 * - `baitonDir` — absolute `.baiton/` directory at the repo root; `specs/` and
 *                 `runs/` live under it.
 * - `git`       — the single git service seam (status/diff/log/approval git).
 * - `confirm`   — the UI confirmation seam `approve_spec` uses (Req 10.1).
 * - `runQueue`  — the serialized run-queue seam `run` dispatches into (Req 10.3).
 * - `draftSpec` — the spec-draft runner seam `draft_spec` dispatches into.
 * - `clock`     — wall clock for transcript timestamps.
 * - `ids`       — identifier source (reserved for tool-generated ids).
 * - `gitSettings` — the remote and base branch approval fetches/resolves from.
 */
export interface ToolServices {
  repoRoot: string;
  baitonDir: string;
  git: GitService;
  confirm: ConfirmSeam;
  runQueue: RunQueueSeam;
  /**
   * The spec-draft runner the `draft_spec` tool hands an agreed requirements
   * document to. Optional so a host that has not wired the stage engine still
   * builds a registry; `draft_spec` then reports it as unavailable.
   */
  draftSpec?: DraftSpecSeam;
  clock: Clock;
  ids: IdGenerator;
  gitSettings: ToolGitSettings;
  /**
   * Submit the spec's pull request (design section 8 "PR"): Verify, the
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
