/**
 * The Spec_Draft runner: the harness writes the spec, the orchestrator only
 * gathers the requirements.
 *
 * The orchestrator's `draft_spec(slug, requirements)` tool hands a requirements
 * document to this runner. It launches the `spec-writer` role on the
 * `spec-draft` stage under a fresh run id — the same Brief → terminal →
 * `result.json` handoff every other stage uses — and, when a schema-valid
 * result lands, renders it into `.baiton/specs/<slug>/spec.md` and commits it.
 *
 * It deliberately does NOT go through {@link RunQueue}: the queue is todo-scoped
 * (every request names a `todoId` and resolves a lifecycle transition), and a
 * spec draft has neither a todo nor a spec to transition. It does reuse the
 * queue's one-stage-per-repository guarantee, from both sides: the runner
 * refuses to start while the queue is running, and the queue refuses to start
 * while the runner is drafting (through `RunQueueDeps.isExternallyBusy`).
 *
 * Like the queue it probes the adapter before launching, journals a start and a
 * completion record to `.baiton/specs/<slug>/runs.jsonl`, and leaves a failed
 * run's `.baiton/runs/<runId>/` directory in place for inspection.
 *
 * Everything host-specific is injected — adapter, terminal host, result-watcher
 * factory, git, the per-role model lookup and the completion sink — so the
 * runner is unit-testable without `vscode`.
 */
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync } from 'fs';
import * as path from 'path';
import type { Adapter } from '../adapter';
import type { Role } from '../model/role';
import type { SpecDraftResult } from '../schema';
import { appendCompletion, appendStart } from '../journal';
import { renderSpec, writeAndCommit, type RenderSpecTodo } from '../orchestrator/specWriteTools';
import type { ToolServices } from '../orchestrator/toolServices';
import { launchStage } from './launcher';
import { awaitStageResult } from './resultFlow';
import type { ResultWatcherFactory } from './runQueue';
import type { HostTerminal, TerminalHost } from './terminalHost';

/** The stage and role a spec draft always runs as. */
const SPEC_DRAFT_STAGE = 'spec-draft' as const;
const SPEC_WRITER_ROLE: Role = 'spec-writer';

/** One request to draft a spec from a requirements document. */
export interface SpecDraftRequest {
  /** The slug the new spec will live under; must not already exist. */
  slug: string;
  /** The requirements document the orchestrator assembled with the user. */
  requirements: string;
}

/** How a spec draft ended, reported to the completion sink. */
export type SpecDraftOutcome =
  | {
      ok: true;
      slug: string;
      runId: string;
      /** How many todos the spec writer produced. */
      todoCount: number;
      /** Repository-relative path of the written spec. */
      specPath: string;
      /** The commit the spec landed in. */
      commit: string;
    }
  | { ok: false; slug: string; runId?: string; message: string };

/** Why a draft never started; nothing was written and no run directory exists. */
export type SpecDraftRefusal =
  | { kind: 'busy'; message: string }
  | { kind: 'duplicate-slug'; message: string }
  | { kind: 'invalid-slug'; message: string }
  | { kind: 'probe-failed'; message: string }
  | { kind: 'launch-failed'; message: string };

/** What `start` resolves with: the run id once launched, or why it was refused. */
export type SpecDraftStart =
  | { ok: true; runId: string; completed: Promise<SpecDraftOutcome> }
  | { ok: false; error: SpecDraftRefusal };

/** Everything the runner needs, all injectable for testing. */
export interface SpecDraftDeps {
  /** Absolute workspace root; the terminal cwd and run-directory base. */
  workspaceRoot: string;
  /** Absolute `.baiton/specs/` directory. */
  specsDir: string;
  adapter: Adapter;
  terminalHost: TerminalHost;
  watcherFactory: ResultWatcherFactory;
  /**
   * The services {@link writeAndCommit} needs (`git` for the commit,
   * `baitonDir` for path composition). Reusing the tool services keeps the
   * draft commit identical in shape to every other spec-folder write.
   */
  services: ToolServices;
  /** Per-role model, resolved from config; selects the adapter `--model`. */
  modelForRole(role: Role): { model: string; effort?: string };
  /** True while the todo-scoped run queue has a stage in flight. */
  isQueueRunning(): boolean;
  /** Run-id generator; defaults to a slug/time composite. */
  newRunId?: (slug: string) => string;
  /** Session-id generator for the launch `--session-id`; defaults to a uuid. */
  newSessionId?: () => string;
  /** Called once the draft reaches its outcome (chat feedback + refresh). */
  onComplete?: (outcome: SpecDraftOutcome) => void;
  /** Surfaces an invalid `result.json` while the run stays open (Req 12.6). */
  report?: (message: string) => void;
}

/** The runner the `draft_spec` tool dispatches into. */
export interface SpecDraftRunner {
  /**
   * Launch a spec draft. Resolves as soon as the sub-agent is running (or was
   * refused) so the chat turn is not blocked; `completed` resolves later with
   * the outcome, which is also handed to `onComplete`.
   */
  start(req: SpecDraftRequest): Promise<SpecDraftStart>;
  /** Whether a draft is currently in flight (the queue consults this). */
  isRunning(): boolean;
}

/** Create a {@link SpecDraftRunner} bound to the injected dependencies. */
export function createSpecDraftRunner(deps: SpecDraftDeps): SpecDraftRunner {
  return new DefaultSpecDraftRunner(deps);
}

class DefaultSpecDraftRunner implements SpecDraftRunner {
  private readonly deps: SpecDraftDeps;
  private running = false;

  constructor(deps: SpecDraftDeps) {
    this.deps = deps;
  }

  isRunning(): boolean {
    return this.running;
  }

  async start(req: SpecDraftRequest): Promise<SpecDraftStart> {
    if (!isSlug(req.slug)) {
      return refuse({
        kind: 'invalid-slug',
        message: `"${req.slug}" is not a valid spec slug`,
      });
    }
    // One stage per repository, from both directions (Req 20.1).
    if (this.running || this.deps.isQueueRunning()) {
      return refuse({
        kind: 'busy',
        message: 'a stage is already running for this repository; try again after it finishes',
      });
    }
    // A draft only ever creates a spec; it never overwrites one. The folder
    // alone does not count — a failed draft leaves its journal behind, and a
    // retry must still be allowed.
    if (existsSync(path.join(this.deps.specsDir, req.slug, 'spec.md'))) {
      return refuse({
        kind: 'duplicate-slug',
        message: `spec "${req.slug}" already exists`,
      });
    }

    // Probe the adapter before launching, exactly as the queue does (Req 14.2).
    const probe = await this.deps.adapter.probe();
    if (!probe.ok) {
      return refuse({
        kind: 'probe-failed',
        message: `adapter probe failed: ${probe.reason ?? 'unknown reason'}`,
      });
    }

    const runId = (this.deps.newRunId ?? defaultRunId)(req.slug);
    const sessionId = (this.deps.newSessionId ?? defaultSessionId)();
    const { model, effort } = this.deps.modelForRole(SPEC_WRITER_ROLE);

    const launched = launchStage(
      {
        workspaceRoot: this.deps.workspaceRoot,
        runId,
        stage: SPEC_DRAFT_STAGE,
        role: SPEC_WRITER_ROLE,
        model,
        ...(effort !== undefined ? { effort } : {}),
        resume: false,
        sessionId,
        briefContext: requirementsContext(req.requirements),
      },
      { adapter: this.deps.adapter, terminalHost: this.deps.terminalHost },
    );
    if (!launched.ok) {
      return refuse({
        kind: 'launch-failed',
        message: `spec draft launch failed: ${launched.error.message}`,
      });
    }

    this.running = true;
    const completed = this.awaitAndWrite(req, runId, sessionId, launched.value);
    return { ok: true, runId, completed };
  }

  /**
   * Await the spec writer's result, then render and commit `spec.md`. Journals
   * the start before waiting and the completion once the outcome is known. A
   * failed run keeps its `.baiton/runs/<runId>/` directory for inspection.
   */
  private async awaitAndWrite(
    req: SpecDraftRequest,
    runId: string,
    sessionId: string,
    launched: { terminal: HostTerminal; resultPath: string },
  ): Promise<SpecDraftOutcome> {
    const { terminal, resultPath } = launched;
    const specDir = path.join(this.deps.specsDir, req.slug);
    const journalPath = path.join(specDir, 'runs.jsonl');

    let outcome: SpecDraftOutcome;
    try {
      // The run journal lives in the spec's own folder, which does not exist
      // until the draft lands; create it so the start record has somewhere to go.
      mkdirSync(specDir, { recursive: true });
      appendStart(journalPath, {
        runId,
        // A spec draft is spec-scoped: it has no todo, so the slug stands in as
        // the journal's subject id.
        todoId: req.slug,
        stage: SPEC_DRAFT_STAGE,
        attempt: 1,
        startHead: '',
        inputRev: '',
        sessionId,
      });

      const result = await awaitStageResult(
        {
          workspaceRoot: this.deps.workspaceRoot,
          slug: req.slug,
          stage: SPEC_DRAFT_STAGE,
          terminal,
          watcher: this.deps.watcherFactory.create({
            slug: req.slug,
            runId,
            resultPath,
            terminal,
          }),
        },
        {
          // The spec file is rendered from the structured result below, not
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
          message: `the spec writer did not produce a result (${result.kind})`,
        };
      } else {
        outcome = await this.writeSpec(req.slug, runId, result.structured as SpecDraftResult);
      }
    } catch (e) {
      outcome = {
        ok: false,
        slug: req.slug,
        runId,
        message: `the spec draft failed: ${describe(e)}`,
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

  /** Render the drafted spec and commit it under the spec folder (Req 17.1). */
  private async writeSpec(
    slug: string,
    runId: string,
    structured: SpecDraftResult,
  ): Promise<SpecDraftOutcome> {
    const todos: RenderSpecTodo[] = structured.todos.map((t) => ({
      title: t.title,
      ...(t.after !== undefined ? { after: t.after } : {}),
      ...(t.files !== undefined ? { files: t.files } : {}),
    }));
    const content = renderSpec(slug, structured.overview, todos);
    const absolute = path.join(this.deps.specsDir, slug, 'spec.md');
    const write = await writeAndCommit(
      this.deps.services,
      absolute,
      content,
      slug,
      slug,
      'draft spec',
    );
    if (!write.ok) {
      return { ok: false, slug, runId, message: write.error };
    }
    return {
      ok: true,
      slug,
      runId,
      todoCount: todos.length,
      specPath: `.baiton/specs/${slug}/spec.md`,
      commit: write.commit,
    };
  }
}

/**
 * The Brief's context section for a spec draft: the requirements document the
 * orchestrator and the user agreed on, verbatim.
 */
export function requirementsContext(requirements: string): string {
  return ['## Requirements', '', requirements.trim()].join('\n');
}

/** A refusal, shaped as a {@link SpecDraftStart}. */
function refuse(error: SpecDraftRefusal): SpecDraftStart {
  return { ok: false, error };
}

/** The default run id: the slug, the stage, and the wall clock. */
function defaultRunId(slug: string): string {
  return `${slug}-spec-draft-${Date.now().toString(36)}`;
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
