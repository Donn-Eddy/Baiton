/**
 * The plan-draft runner: the harness writes the plan, and the orchestrator
 * gathers the request. The `draft_plan(slug, request)` tool hands
 * that request to this runner, which launches the `plan-writer` role on
 * the `plan-draft` stage and writes a schema-valid result to
 * `.baiton/plans/<slug>/plan.md`.
 *
 * It deliberately does not go through {@link RunQueue}: that queue is
 * phase-scoped and resolves lifecycle transitions. This runner drafts a whole
 * plan, but shares the queue's one-stage-per-repository guarantee in both
 * directions.
 *
 * Like the queue it probes the adapter before launching, journals a start and
 * completion record to `.baiton/plans/<slug>/runs.jsonl`, and leaves a failed
 * run's `.baiton/runs/<runId>/` directory in place for inspection.
 *
 * Host-specific dependencies are injected so the runner is unit-testable
 * without `vscode`.
 */
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync } from 'fs';
import { writeFile } from 'fs/promises';
import * as path from 'path';
import type { Adapter } from '../adapter';
import type { Role } from '../model/role';
import type { PlanDraftResult } from '../schema';
import { appendCompletion, appendStart } from '../journal';
import { gitCommitErrorMessage } from '../orchestrator/planWriteTools';
import type { ToolServices } from '../orchestrator/toolServices';
import { locationFor } from '../storage/documentLocation';
import { launchStage } from './launcher';
import { awaitStageResult } from './resultFlow';
import type { ResultWatcherFactory } from './runQueue';
import type { HostTerminal, TerminalHost } from './terminalHost';

/** The stage and role a plan draft always runs as. */
const PLAN_DRAFT_STAGE = 'plan-draft' as const;
const PLAN_WRITER_ROLE: Role = 'plan-writer';

/** One request to draft a plan from a requirements document. */
export interface PlanDraftRequest {
  /** The slug the new plan will live under; must not already exist. */
  slug: string;
  /** The requirements document the orchestrator assembled with the user. */
  requirements: string;
}

/** How a plan draft ended, reported to the completion sink. */
export type PlanDraftOutcome =
  | {
      ok: true;
      slug: string;
      runId: string;
      /** How many phases the plan writer produced. */
      phaseCount: number;
      /** Repository-relative path of the written plan. */
      planPath: string;
      /** The commit the plan landed in. */
      commit: string;
    }
  | { ok: false; slug: string; runId?: string; message: string };

/** Why a draft never started; nothing was written and no run directory exists. */
export type PlanDraftRefusal =
  | { kind: 'busy'; message: string }
  | { kind: 'duplicate-slug'; message: string }
  | { kind: 'invalid-slug'; message: string }
  | { kind: 'unknown-agent'; message: string }
  | { kind: 'probe-failed'; message: string }
  | { kind: 'launch-failed'; message: string };

/** What `start` resolves with: the run id once launched, or why it was refused. */
export type PlanDraftStart =
  | { ok: true; runId: string; completed: Promise<PlanDraftOutcome> }
  | { ok: false; error: PlanDraftRefusal };

/** Everything the runner needs, all injectable for testing. */
export interface PlanDraftDeps {
  /** Absolute workspace root; the terminal cwd and run-directory base. */
  workspaceRoot: string;
  terminalHost: TerminalHost;
  watcherFactory: ResultWatcherFactory;
  /**
   * The services the runner needs (`git` for the commit and `baitonDir` for
   * the plan and journal paths).
   */
  services: ToolServices;
  /** Per-role model, resolved from config; selects the adapter `--model`. */
  modelForRole(role: Role): { model: string; effort?: string };
  /**
   * Per-role adapter, selected from the role's configured `agent` id;
   * `undefined` when that id is not a known agent (Requirement 14.1).
   */
  adapterForRole(role: Role): Adapter | undefined;
  /** True while a phase-scoped run queue has a stage in flight. */
  isQueueRunning(): boolean;
  /** Run-id generator; defaults to a slug/time composite. */
  newRunId?: (slug: string) => string;
  /** Session-id generator for the launch `--session-id`; defaults to a uuid. */
  newSessionId?: () => string;
  /** Called once the draft reaches its outcome (chat feedback + refresh). */
  onComplete?: (outcome: PlanDraftOutcome) => void;
  /** Surfaces an invalid `result.json` while the run stays open (Req 12.6). */
  report?: (message: string) => void;
}

/** The runner the `draft_plan` tool dispatches into. */
export interface PlanDraftRunner {
  /**
   * Launch a plan draft. Resolves as soon as the sub-agent is running (or was
   * refused) so the chat turn is not blocked; `completed` resolves later with
   * the outcome, which is also handed to `onComplete`.
   */
  start(req: PlanDraftRequest): Promise<PlanDraftStart>;
  /** Whether a draft is currently in flight (the queue consults this). */
  isRunning(): boolean;
}

/** Create a {@link PlanDraftRunner} bound to the injected dependencies. */
export function createPlanDraftRunner(deps: PlanDraftDeps): PlanDraftRunner {
  return new DefaultPlanDraftRunner(deps);
}

class DefaultPlanDraftRunner implements PlanDraftRunner {
  private readonly deps: PlanDraftDeps;
  private running = false;

  constructor(deps: PlanDraftDeps) {
    this.deps = deps;
  }

  isRunning(): boolean {
    return this.running;
  }

  async start(req: PlanDraftRequest): Promise<PlanDraftStart> {
    if (!isSlug(req.slug)) {
      return refuse({
        kind: 'invalid-slug',
        message: `"${req.slug}" is not a valid plan slug`,
      });
    }
    // One stage per repository, from both directions (Req 20.1).
    if (this.running || this.deps.isQueueRunning()) {
      return refuse({
        kind: 'busy',
        message: 'a stage is already running for this repository; try again after it finishes',
      });
    }
    const baitonDir = this.deps.services.baitonDir;
    // Only an existing document blocks a retry; failed runs can leave their
    // plan directory and journal behind without preventing another draft.
    if (existsSync(locationFor(baitonDir, req.slug, 'plan').documentPath)) {
      return refuse({
        kind: 'duplicate-slug',
        message: `plan "${req.slug}" already exists`,
      });
    }
    if (existsSync(locationFor(baitonDir, req.slug, 'legacy-spec').documentPath)) {
      return refuse({
        kind: 'duplicate-slug',
        message: `legacy spec "${req.slug}" already exists`,
      });
    }

    // Resolve the plan-writer's configured adapter before probing (Req 14.1).
    const adapter = this.deps.adapterForRole(PLAN_WRITER_ROLE);
    if (adapter === undefined) {
      return refuse({
        kind: 'unknown-agent',
        message: 'role "plan-writer" is configured with an unsupported agent; update "roles.plan-writer.agent" in .baiton/config.json',
      });
    }

    // Probe the adapter before launching, exactly as the queue does (Req 14.2).
    const probe = await adapter.probe();
    if (!probe.ok) {
      return refuse({
        kind: 'probe-failed',
        message: `adapter probe failed: ${probe.reason ?? 'unknown reason'}`,
      });
    }

    const runId = (this.deps.newRunId ?? defaultRunId)(req.slug);
    const sessionId = (this.deps.newSessionId ?? defaultSessionId)();
    const { model, effort } = this.deps.modelForRole(PLAN_WRITER_ROLE);

    const launched = launchStage(
      {
        workspaceRoot: this.deps.workspaceRoot,
        runId,
        stage: PLAN_DRAFT_STAGE,
        role: PLAN_WRITER_ROLE,
        model,
        ...(effort !== undefined ? { effort } : {}),
        resume: false,
        sessionId,
        briefContext: requirementsContext(req.requirements),
      },
      { adapter, terminalHost: this.deps.terminalHost },
    );
    if (!launched.ok) {
      return refuse({
        kind: 'launch-failed',
        message: `plan draft launch failed: ${launched.error.message}`,
      });
    }

    this.running = true;
    const completed = this.awaitAndWrite(req, runId, sessionId, launched.value);
    return { ok: true, runId, completed };
  }

  /**
   * Await the plan writer's result, then render and commit `plan.md`. Journals
   * the start before waiting and the completion once the outcome is known. A
   * failed run keeps its `.baiton/runs/<runId>/` directory for inspection.
   */
  private async awaitAndWrite(
    req: PlanDraftRequest,
    runId: string,
    sessionId: string,
    launched: { terminal: HostTerminal; resultPath: string },
  ): Promise<PlanDraftOutcome> {
    const { terminal, resultPath } = launched;
    const planDir = locationFor(this.deps.services.baitonDir, req.slug, 'plan').dir;
    const journalPath = path.join(planDir, 'runs.jsonl');

    let outcome: PlanDraftOutcome;
    try {
      // The journal belongs to this plan draft and is created before waiting.
      mkdirSync(planDir, { recursive: true });
      appendStart(journalPath, {
        runId,
        // A plan draft has no individual phase yet, so its slug is the journal subject.
        phaseId: req.slug,
        stage: PLAN_DRAFT_STAGE,
        attempt: 1,
        startHead: '',
        inputRev: '',
        sessionId,
      });

      const result = await awaitStageResult(
        {
          workspaceRoot: this.deps.workspaceRoot,
          slug: req.slug,
          stage: PLAN_DRAFT_STAGE,
          terminal,
          watcher: this.deps.watcherFactory.create({
            slug: req.slug,
            runId,
            resultPath,
            terminal,
          }),
        },
        {
          // The plan file is rendered from the structured result below, not
          // written as the generic JSON-in-markdown stage artifact.
          writeArtifact: () => {},
          reportInvalid: (detail) => this.deps.report?.(detail),
        },
      );

      if (result.kind !== 'completed') {
        outcome = {
          ok: false,
          slug: req.slug,
          runId,
          message: `the plan writer did not produce a result (${result.kind})`,
        };
      } else {
        outcome = await this.writePlan(req.slug, runId, result.structured as PlanDraftResult);
      }
    } catch (e) {
      outcome = {
        ok: false,
        slug: req.slug,
        runId,
        message: `the plan draft failed: ${describe(e)}`,
      };
    } finally {
      this.running = false;
    }

    appendCompletion(journalPath, {
      runId,
      result: outcome.ok ? 'completed' : 'invalid_output',
      ...(outcome.ok ? { commit: outcome.commit } : {}),
    });
    this.deps.onComplete?.(outcome);
    return outcome;
  }

  /** Render the drafted plan and commit it under the plans folder. */
  private async writePlan(
    slug: string,
    runId: string,
    structured: PlanDraftResult,
  ): Promise<PlanDraftOutcome> {
    const phases: RenderPlanPhase[] = structured.phases.map((phase) => ({
      title: phase.title,
      ...(phase.after !== undefined ? { after: phase.after } : {}),
      ...(phase.files !== undefined ? { files: phase.files } : {}),
    }));
    const content = renderPlan(slug, {
      endstate: structured.endstate,
      changes: structured.changes,
      constraints: structured.constraints,
    }, phases);
    const absolute = locationFor(this.deps.services.baitonDir, slug, 'plan').documentPath;
    try {
      mkdirSync(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, content, 'utf8');
    } catch (e) {
      return { ok: false, slug, runId, message: `failed to write plan file: ${describe(e)}` };
    }
    let commit: string;
    try {
      commit = await this.deps.services.git.commit(`plan(${slug}): ${slug} draft plan`);
    } catch (e) {
      return { ok: false, slug, runId, message: gitCommitErrorMessage(e) };
    }
    return {
      ok: true,
      slug,
      runId,
      phaseCount: phases.length,
      planPath: `.baiton/plans/${slug}/plan.md`,
      commit,
    };
  }
}

/** Phase data used to render a plan-draft result. */
export interface RenderPlanPhase {
  title: string;
  after?: string[];
  files?: string[];
}

/** The prose sections that precede the phases in a plan. */
export interface PlanPreamble {
  endstate: string;
  changes: string;
  constraints: string;
}

/** Render a complete draft plan with sequential `P##` ids and pending phases. */
export function renderPlan(
  slug: string,
  preamble: PlanPreamble,
  phases: readonly (string | RenderPlanPhase)[],
): string {
  const idFor = (index: number): string => `P${String(index + 1).padStart(2, '0')}`;
  const lines = [
    '---',
    'version: 1',
    `name: ${slug}`,
    'status: draft',
    'mode: manual',
    'base:',
    'base_commit:',
    'branch:',
    'approved_rev:',
    '---',
    '',
    '# Endstate',
    '',
    preamble.endstate.replace(/\s+$/, ''),
    '',
    '# What needs changing',
    '',
    preamble.changes.replace(/\s+$/, ''),
    '',
    '# Limitations & constraints',
    '',
    preamble.constraints.replace(/\s+$/, ''),
    '',
    '# PHASES',
    '',
  ];

  phases.forEach((input, index) => {
    const phase = typeof input === 'string' ? { title: input } : input;
    const after = resolvePhaseAfter(phase.after ?? [], index, idFor);
    const files = (phase.files ?? []).filter((file) => file.trim().length > 0);
    const groups: string[] = [];
    if (after.length > 0) groups.push(`after ${after.join(', ')}`);
    if (files.length > 0) groups.push(`files: ${files.join(', ')}`);
    const hint = groups.length > 0 ? ` (${groups.join('; ')})` : '';
    lines.push(`- [pending] ${idFor(index)} ${phase.title.trim()}${hint}`);
  });
  lines.push('');
  return lines.join('\n');
}

/** Map valid earlier 1-based positions to assigned phase ids, dropping repeats. */
function resolvePhaseAfter(
  positions: readonly string[],
  index: number,
  idFor: (index: number) => string,
): string[] {
  const out: string[] = [];
  for (const raw of positions) {
    const position = Number.parseInt(raw.trim(), 10);
    if (!Number.isInteger(position) || position < 1 || position > index) continue;
    const id = idFor(position - 1);
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * The Brief's context section for a plan draft: the requirements document the
 * orchestrator and the user agreed on, verbatim.
 */
export function requirementsContext(requirements: string): string {
  return ['## Requirements', '', requirements.trim()].join('\n');
}

/** A refusal, shaped as a {@link PlanDraftStart}. */
function refuse(error: PlanDraftRefusal): PlanDraftStart {
  return { ok: false, error };
}

/** The default run id: the slug, the stage, and the wall clock. */
function defaultRunId(slug: string): string {
  return `${slug}-plan-draft-${Date.now().toString(36)}`;
}

/** The default session id. */
function defaultSessionId(): string {
  return randomUUID();
}

/** A slug is a simple directory-safe name (no separators or traversal). */
function isSlug(slug: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(slug) && slug !== '.' && slug !== '..';
}

/** A short description of a thrown value. */
function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
