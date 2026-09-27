/**
 * Run manifest store (host-free core).
 *
 * One manifest per spec-less run, at `.baiton/runs/<run-id>/run.json`. A
 * spec-less run has no spec and no todo, so the run id stands in for a todo id
 * everywhere the spec pipeline would use one: nothing in this module ever
 * touches `.baiton/specs/`.
 *
 * The run directory also holds the run's journal (`runs.jsonl`) and the stage
 * artifacts the run persists (`plan.md`, `execute-<n>.md`, `review-<n>.md`,
 * `finding.md`). A *launch* of a stage gets its own sibling directory named
 * `<run-id>.<stage>.<n>` under the same `.baiton/runs/`, holding that launch's
 * brief, result and ask files — which is why a run id may never contain a dot
 * (see {@link isRunId}) and why {@link RunStore.list} skips any directory whose
 * name parses as a launch id.
 *
 * Every expected failure is a returned {@link Result} carrying a
 * {@link RunStoreError}, never a throw, mirroring `ConfigDocumentError` in
 * `src/config/configDocument.ts`. Writes go through a temp file and a
 * `renameSync`, so a crash mid-write never leaves a truncated manifest.
 *
 * {@link RunStore.update} is read-modify-write with no locking: two concurrent
 * writers could lose an update. That is acceptable because the run pipeline
 * runs one stage per repository and is the only writer, and the atomic rename
 * still guarantees no reader ever sees a partial manifest.
 *
 * No `vscode` import, sync `fs` like its engine neighbours (`launcher.ts`,
 * `resultFlow.ts`, `askRelay.ts`), so it is unit testable against temp dirs.
 */
import {
  type Dirent,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs';
import * as path from 'path';

import { type Stage, isStage } from '../model/stage';
import { type RunMode, isRunMode } from '../model/mode';
import { Result, ok, err } from '../model/result';
import { persistencePathForStage } from '../schema';
import type { ArtifactWriter } from './resultFlow';

/**
 * The lifecycle state of one run. `confirmed` is where a run starts (the user
 * confirmed the composer's proposal); `answered` is where an `investigate` run
 * ends; `merged` is where a code run ends once its worktree branch landed.
 */
export type RunState =
  | 'confirmed'
  | 'planning'
  | 'planned'
  | 'executing'
  | 'executed'
  | 'reviewing'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'answered'
  | 'merged';

/** All run states, in lifecycle order. */
export const RUN_STATES: readonly RunState[] = [
  'confirmed',
  'planning',
  'planned',
  'executing',
  'executed',
  'reviewing',
  'done',
  'failed',
  'cancelled',
  'answered',
  'merged',
] as const;

/** Whether an arbitrary string is a known {@link RunState}. */
export function isRunState(value: string): value is RunState {
  return (RUN_STATES as readonly string[]).includes(value);
}

/**
 * Whether a state is terminal: the Runs view's Active/Complete split, and
 * exactly the states that stamp `completedAt` on the manifest.
 */
export function isRunComplete(state: RunState): boolean {
  return (
    state === 'done' ||
    state === 'failed' ||
    state === 'cancelled' ||
    state === 'answered' ||
    state === 'merged'
  );
}

/** The stages a spec-less run can launch — a subset of the pipeline's stages. */
export type RunStage = Extract<Stage, 'plan' | 'execute' | 'review' | 'investigate'>;

/** All stages a run can launch, in pipeline order. */
export const RUN_STAGES: readonly RunStage[] = [
  'plan',
  'execute',
  'review',
  'investigate',
] as const;

/** Whether an arbitrary string is a stage a run can launch. */
export function isRunStage(value: string): value is RunStage {
  return isStage(value) && (RUN_STAGES as readonly string[]).includes(value);
}

/**
 * How many times each stage has been launched for a run. The four keys are
 * exhaustive over {@link RunStage}: adding a stage there breaks the build where
 * the zeroed record is constructed, so no counter can be silently forgotten.
 */
export interface RunAttempts extends Record<RunStage, number> {
  plan: number;
  execute: number;
  review: number;
  investigate: number;
}

/**
 * How a run ended. Named `RunOutcomeRecord` because `src/engine/resultFlow.ts`
 * already exports `RunOutcome` — a different thing, one stage's result —
 * through the same `src/engine/index.ts` barrel.
 */
export type RunOutcomeRecord =
  | { kind: 'verdict'; verdict: 'pass' | 'findings' }
  | { kind: 'finding'; finding: string }
  | { kind: 'cancelled' }
  | { kind: 'failed'; message: string };

/** The manifest schema version this build reads and writes. */
export const RUN_MANIFEST_VERSION = 1;

/** The whole persisted state of one spec-less run. */
export interface RunManifest {
  /** Manifest schema version; always {@link RUN_MANIFEST_VERSION} here. */
  version: number;
  /** The run id, which is also its directory's name. Never contains a dot. */
  id: string;
  /** The mode the run actually runs as; never `spec`. */
  mode: RunMode;
  /** What the composer's Mode select said when the run was confirmed. */
  composerMode: RunMode;
  /** True when the orchestrator proposed a mode other than `composerMode`. */
  explicitMode: boolean;
  /** The user's statement of the work, as confirmed. */
  statement: string;
  /** The files the composer attached to the run, repository-relative. */
  files: string[];
  /** Reproduction steps, when the mode collected them (`bug`). */
  reproduction?: string;
  /** The branch checked out when the run started. */
  baseBranch: string;
  /** That branch's head commit at that moment (the merge-time `base-moved` check). */
  baseHead: string;
  /** The run's own branch, `baiton/<mode>/<run-id>`. */
  branch: string;
  /**
   * Repository-relative worktree dir (`.baiton/worktrees/<run-id>`); absent for
   * an `investigate` run, which is read-only and has no worktree.
   */
  worktreeDir?: string;
  /** Where the run is in its lifecycle. */
  state: RunState;
  /** Per-stage launch counters. */
  attempts: RunAttempts;
  /** How the run ended; absent while it is still active. */
  outcome?: RunOutcomeRecord;
  /** ISO-8601 creation timestamp; never changes. */
  createdAt: string;
  /** ISO-8601 timestamp of the last manifest write. */
  updatedAt: string;
  /** ISO-8601 timestamp of the first move into a complete state. */
  completedAt?: string;
}

/** Every expected failure of the run store, classified. */
export type RunStoreError =
  | { kind: 'invalid-id'; runId: string; message: string }
  | { kind: 'duplicate'; runId: string; path: string; message: string }
  | { kind: 'absent'; runId: string; path: string; message: string }
  | { kind: 'unparseable'; runId: string; path: string; message: string }
  | { kind: 'invalid'; runId: string; path: string; message: string }
  | { kind: 'io'; runId: string; path: string; message: string };

/** The manifest's file name inside a run directory. */
export const RUN_MANIFEST_FILE = 'run.json';

/** The journal's file name inside a run directory. */
export const RUN_JOURNAL_FILE = 'runs.jsonl';

/** The directory every run and every launch directory lives under. */
export function runsRootDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.baiton', 'runs');
}

/** One run's directory. */
export function runDirFor(workspaceRoot: string, runId: string): string {
  return path.join(runsRootDir(workspaceRoot), runId);
}

/** One run's manifest path. */
export function runManifestPathFor(workspaceRoot: string, runId: string): string {
  return path.join(runDirFor(workspaceRoot, runId), RUN_MANIFEST_FILE);
}

/**
 * One run's journal path. The run id is the journal's subject id, exactly as
 * `specDraft.ts` passes the spec slug as its `todoId`.
 */
export function runJournalPathFor(workspaceRoot: string, runId: string): string {
  return path.join(runDirFor(workspaceRoot, runId), RUN_JOURNAL_FILE);
}

/** The absolute worktree directory a code run checks its branch out into. */
export function runWorktreeDirFor(workspaceRoot: string, runId: string): string {
  return path.join(workspaceRoot, '.baiton', 'worktrees', runId);
}

/** The branch name a run of `mode` works on. */
export function runBranchFor(mode: RunMode, runId: string): string {
  return `baiton/${mode}/${runId}`;
}

/**
 * Whether a string is a usable run id: alphanumeric plus hyphens, starting
 * alphanumeric, and crucially containing NO dot. Launch directories are
 * siblings of run directories named `<run-id>.<stage>.<n>`, so a dot in a run
 * id would make that name — and `list()`'s run/launch split — ambiguous.
 */
export function isRunId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(value);
}

/** The alphabet a run id's random suffix is drawn from. */
const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * Allocate a run id: `<mode>-<stamp>-<suffix4>`, e.g.
 * `bug-20260926-141501-a1b2`. The stamp is the ISO clock reduced exactly the
 * way `SessionStore.create` reduces it, so ids sort by creation time. The
 * result always satisfies {@link isRunId}.
 */
export function newRunId(
  mode: RunMode,
  now: () => string = () => new Date().toISOString(),
  random: () => number = Math.random,
): string {
  const stamp = now()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z?$/, '')
    .replace('T', '-')
    .slice(0, 15);
  let suffix = '';
  for (let i = 0; i < 4; i++) {
    const draw = random();
    const index = Number.isFinite(draw) ? Math.floor(Math.abs(draw) * ID_ALPHABET.length) : 0;
    suffix += ID_ALPHABET.charAt(index % ID_ALPHABET.length);
  }
  return `${mode}-${stamp}-${suffix}`;
}

/**
 * The id one stage launch runs under. This is what is handed to `launchStage`
 * as its `runId`, so the stage's brief, result and ask files land in
 * `.baiton/runs/<run-id>.<stage>.<n>/` and the role profiles' relative run-dir
 * grants are reused unchanged.
 */
export function launchIdFor(runId: string, stage: RunStage, attempt: number): string {
  return `${runId}.${stage}.${attempt}`;
}

/** A launch id split back into its three parts. */
export interface ParsedLaunchId {
  runId: string;
  stage: RunStage;
  attempt: number;
}

/**
 * Parse a launch id, or `undefined` when the string is not one. The split is
 * unambiguous because a run id may contain no dot and the only multi-word stage
 * name, `plan-review`, is hyphenated rather than dotted — and is not a run
 * stage anyway.
 */
export function parseLaunchId(value: string): ParsedLaunchId | undefined {
  const parts = value.split('.');
  if (parts.length !== 3) {
    return undefined;
  }
  const [runId, stage, attempt] = parts;
  if (!isRunId(runId) || !isRunStage(stage) || !/^[1-9][0-9]*$/.test(attempt)) {
    return undefined;
  }
  const n = Number(attempt);
  if (!Number.isFinite(n)) {
    return undefined;
  }
  return { runId, stage, attempt: n };
}

/**
 * Whether a directory name under `.baiton/runs/` is one run's stage launch
 * rather than a run of its own. {@link RunStore.list} uses it to skip launch
 * directories, and the Runs-view watcher to ignore their file events.
 */
export function isRunLaunchDirName(name: string): boolean {
  return parseLaunchId(name) !== undefined;
}

/** Whether a value is a plain (non-array) object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether a value is a non-empty string. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Whether a value is absent or a string (the optional-string fields). */
function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

/** Validate one manifest's `outcome`, returning its message on failure. */
function parseOutcome(value: unknown): Result<RunOutcomeRecord, string> {
  if (!isPlainObject(value)) {
    return err('outcome must be an object');
  }
  switch (value.kind) {
    case 'verdict':
      return value.verdict === 'pass' || value.verdict === 'findings'
        ? ok({ kind: 'verdict', verdict: value.verdict })
        : err('outcome.verdict must be "pass" or "findings"');
    case 'finding':
      return typeof value.finding === 'string'
        ? ok({ kind: 'finding', finding: value.finding })
        : err('outcome.finding must be a string');
    case 'cancelled':
      return ok({ kind: 'cancelled' });
    case 'failed':
      return typeof value.message === 'string'
        ? ok({ kind: 'failed', message: value.message })
        : err('outcome.message must be a string');
    default:
      return err(`unknown outcome kind ${JSON.stringify(value.kind)}`);
  }
}

/** Validate one manifest's `attempts`, returning its message on failure. */
function parseAttempts(value: unknown): Result<RunAttempts, string> {
  if (!isPlainObject(value)) {
    return err('attempts must be an object');
  }
  const counters: Partial<Record<RunStage, number>> = {};
  for (const stage of RUN_STAGES) {
    const n = value[stage];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
      return err(`attempts.${stage} must be a non-negative integer`);
    }
    counters[stage] = n;
  }
  return ok(counters as RunAttempts);
}

/**
 * Parse and validate a manifest from its file text, returning a *freshly
 * constructed* {@link RunManifest} so unknown keys are dropped and the value is
 * exactly the declared shape. Free of `fs` so the Runs-view watcher and the
 * tests can validate a string on its own.
 */
export function parseRunManifest(text: string): Result<RunManifest, string> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return err(`not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!isPlainObject(raw)) {
    return err('manifest must be a JSON object');
  }
  if (raw.version !== RUN_MANIFEST_VERSION) {
    return err(`unsupported manifest version ${String(raw.version)}`);
  }
  if (typeof raw.id !== 'string' || !isRunId(raw.id)) {
    return err(`id ${JSON.stringify(raw.id)} is not a valid run id`);
  }
  if (typeof raw.mode !== 'string' || !isRunMode(raw.mode)) {
    return err(`mode ${JSON.stringify(raw.mode)} is not a known mode`);
  }
  if (raw.mode === 'spec') {
    return err('mode "spec" has no run manifest');
  }
  if (typeof raw.composerMode !== 'string' || !isRunMode(raw.composerMode)) {
    return err(`composerMode ${JSON.stringify(raw.composerMode)} is not a known mode`);
  }
  if (typeof raw.explicitMode !== 'boolean') {
    return err('explicitMode must be a boolean');
  }
  for (const field of ['statement', 'baseBranch', 'baseHead', 'branch'] as const) {
    if (!isNonEmptyString(raw[field])) {
      return err(`${field} must be a non-empty string`);
    }
  }
  if (!Array.isArray(raw.files) || raw.files.some((f) => typeof f !== 'string')) {
    return err('files must be an array of strings');
  }
  for (const field of ['reproduction', 'worktreeDir', 'completedAt'] as const) {
    if (!isOptionalString(raw[field])) {
      return err(`${field} must be a string when present`);
    }
  }
  if (typeof raw.state !== 'string' || !isRunState(raw.state)) {
    return err(`state ${JSON.stringify(raw.state)} is not a known run state`);
  }
  const attempts = parseAttempts(raw.attempts);
  if (!attempts.ok) {
    return err(attempts.error);
  }
  let outcome: RunOutcomeRecord | undefined;
  if (raw.outcome !== undefined) {
    const parsed = parseOutcome(raw.outcome);
    if (!parsed.ok) {
      return err(parsed.error);
    }
    outcome = parsed.value;
  }
  for (const field of ['createdAt', 'updatedAt'] as const) {
    if (!isNonEmptyString(raw[field])) {
      return err(`${field} must be a non-empty string`);
    }
  }

  return ok({
    version: RUN_MANIFEST_VERSION,
    id: raw.id,
    mode: raw.mode,
    composerMode: raw.composerMode,
    explicitMode: raw.explicitMode,
    statement: raw.statement as string,
    files: raw.files as string[],
    ...(raw.reproduction !== undefined ? { reproduction: raw.reproduction as string } : {}),
    baseBranch: raw.baseBranch as string,
    baseHead: raw.baseHead as string,
    branch: raw.branch as string,
    ...(raw.worktreeDir !== undefined ? { worktreeDir: raw.worktreeDir as string } : {}),
    state: raw.state,
    attempts: attempts.value,
    ...(outcome !== undefined ? { outcome } : {}),
    createdAt: raw.createdAt as string,
    updatedAt: raw.updatedAt as string,
    ...(raw.completedAt !== undefined ? { completedAt: raw.completedAt as string } : {}),
  });
}

/** Render a manifest's file text, matching `writeJsonAtomic`'s formatting. */
export function serializeRunManifest(manifest: RunManifest): string {
  return JSON.stringify(manifest, null, 2) + '\n';
}

/** How a {@link RunStore} is bound to a workspace and a clock. */
export interface RunStoreOptions {
  /** Absolute workspace root; `.baiton/runs/` is resolved under it. */
  workspaceRoot: string;
  /** ISO-8601 clock for timestamps; injected for deterministic tests. */
  now?: () => string;
}

/** Everything a new run's manifest needs that is not derived or defaulted. */
export interface NewRunInput {
  id: string;
  mode: RunMode;
  composerMode: RunMode;
  explicitMode: boolean;
  statement: string;
  files: string[];
  reproduction?: string;
  baseBranch: string;
  baseHead: string;
  /** Repository-relative worktree dir; omitted for an investigate run. */
  worktreeDir?: string;
}

/**
 * The mutable fields of a manifest. Everything absent here — `id`, `version`,
 * `mode`, `composerMode`, `explicitMode`, `statement`, `files`,
 * `reproduction`, `baseBranch`, `baseHead`, `branch`, `createdAt` — is written
 * once by {@link RunStore.create} and never changes.
 */
export interface RunUpdate {
  state?: RunState;
  outcome?: RunOutcomeRecord;
  attempts?: Partial<RunAttempts>;
  worktreeDir?: string;
}

/** Describe a caught value for an error message. */
function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Whether a caught filesystem error is a missing path. */
function isNotFound(e: unknown): boolean {
  return (e as { code?: string } | null)?.code === 'ENOENT';
}

/** Reads and writes run manifests under one workspace's `.baiton/runs/`. */
export class RunStore {
  private readonly workspaceRoot: string;
  private readonly now: () => string;

  constructor(options: RunStoreOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** One run's manifest path. */
  public manifestPath(runId: string): string {
    return runManifestPathFor(this.workspaceRoot, runId);
  }

  /** One run's directory. */
  public dirFor(runId: string): string {
    return runDirFor(this.workspaceRoot, runId);
  }

  /** One run's absolute worktree directory. */
  public worktreeDirFor(runId: string): string {
    return runWorktreeDirFor(this.workspaceRoot, runId);
  }

  /** Whether a run's manifest exists on disk. */
  public exists(runId: string): boolean {
    return existsSync(this.manifestPath(runId));
  }

  /** Write a new run's manifest, refusing a bad id, a spec mode, or a re-create. */
  public create(input: NewRunInput): Result<RunManifest, RunStoreError> {
    if (!isRunId(input.id)) {
      return err({
        kind: 'invalid-id',
        runId: input.id,
        message:
          `${JSON.stringify(input.id)} is not a valid run id: use letters, digits and ` +
          'hyphens only (a dot would collide with a launch directory name).',
      });
    }
    if (input.mode === 'spec') {
      return err({
        kind: 'invalid-id',
        runId: input.id,
        message:
          'mode "spec" has no run manifest: a spec conversation dispatches draft_spec, not a run.',
      });
    }
    if (this.exists(input.id)) {
      return err({
        kind: 'duplicate',
        runId: input.id,
        path: this.manifestPath(input.id),
        message: `A run manifest already exists at ${this.manifestPath(input.id)}.`,
      });
    }

    const stamp = this.now();
    const manifest: RunManifest = {
      version: RUN_MANIFEST_VERSION,
      id: input.id,
      mode: input.mode,
      composerMode: input.composerMode,
      explicitMode: input.explicitMode,
      statement: input.statement,
      files: input.files,
      ...(input.reproduction !== undefined ? { reproduction: input.reproduction } : {}),
      baseBranch: input.baseBranch,
      baseHead: input.baseHead,
      branch: runBranchFor(input.mode, input.id),
      ...(input.worktreeDir !== undefined ? { worktreeDir: input.worktreeDir } : {}),
      state: 'confirmed',
      attempts: { plan: 0, execute: 0, review: 0, investigate: 0 },
      createdAt: stamp,
      updatedAt: stamp,
    };

    const written = this.writeManifest(manifest);
    return written.ok ? ok(manifest) : err(written.error);
  }

  /** Read and validate one run's manifest, classifying every failure. */
  public read(runId: string): Result<RunManifest, RunStoreError> {
    if (!isRunId(runId)) {
      return err({
        kind: 'invalid-id',
        runId,
        message: `${JSON.stringify(runId)} is not a valid run id.`,
      });
    }
    const file = this.manifestPath(runId);
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (e) {
      if (isNotFound(e)) {
        return err({
          kind: 'absent',
          runId,
          path: file,
          message: `No run manifest at ${file}.`,
        });
      }
      return err({
        kind: 'io',
        runId,
        path: file,
        message: `Could not read the run manifest at ${file}: ${describe(e)}.`,
      });
    }
    const parsed = parseRunManifest(text);
    if (!parsed.ok) {
      return err({
        kind: parsed.error.startsWith('not valid JSON') ? 'unparseable' : 'invalid',
        runId,
        path: file,
        message: `The run manifest at ${file} is unusable: ${parsed.error}.`,
      });
    }
    return ok(parsed.value);
  }

  /**
   * Read-modify-write one run's mutable fields. `attempts` merges key by key
   * over the current counters rather than replacing them, `updatedAt` always
   * moves, and `completedAt` is stamped the first time the resulting state is
   * complete (a patch back to an active state clears it again).
   */
  public update(runId: string, patch: RunUpdate): Result<RunManifest, RunStoreError> {
    const current = this.read(runId);
    if (!current.ok) {
      return err(current.error);
    }
    const before = current.value;
    const state = patch.state ?? before.state;
    const stamp = this.now();
    const worktreeDir = patch.worktreeDir ?? before.worktreeDir;
    const outcome = patch.outcome ?? before.outcome;
    const completedAt = isRunComplete(state) ? (before.completedAt ?? stamp) : undefined;

    const next: RunManifest = {
      ...before,
      ...(worktreeDir !== undefined ? { worktreeDir } : {}),
      state,
      attempts: { ...before.attempts, ...(patch.attempts ?? {}) },
      ...(outcome !== undefined ? { outcome } : {}),
      updatedAt: stamp,
      ...(completedAt !== undefined ? { completedAt } : {}),
    };
    if (completedAt === undefined) {
      delete next.completedAt;
    }

    const written = this.writeManifest(next);
    return written.ok ? ok(next) : err(written.error);
  }

  /**
   * Count one more launch of a stage and return the launch id it runs under.
   * This is the one call the run pipeline makes per stage launch.
   */
  public bumpAttempt(
    runId: string,
    stage: RunStage,
  ): Result<{ manifest: RunManifest; attempt: number; launchId: string }, RunStoreError> {
    const current = this.read(runId);
    if (!current.ok) {
      return err(current.error);
    }
    const attempt = current.value.attempts[stage] + 1;
    const updated = this.update(runId, { attempts: { [stage]: attempt } });
    if (!updated.ok) {
      return err(updated.error);
    }
    return ok({ manifest: updated.value, attempt, launchId: launchIdFor(runId, stage, attempt) });
  }

  /**
   * Every run with a readable manifest, newest first. Launch directories,
   * directories with no manifest, and manifests that fail to parse are skipped
   * silently: a half-written or foreign file must never break the Runs view.
   * `read()` still classifies the failure per run when a caller wants it.
   */
  public list(): RunManifest[] {
    const root = runsRootDir(this.workspaceRoot);
    let entries: Dirent[];
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch (e) {
      if (isNotFound(e)) {
        return [];
      }
      throw e;
    }
    const manifests: RunManifest[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || isRunLaunchDirName(entry.name) || !isRunId(entry.name)) {
        continue;
      }
      if (!existsSync(path.join(root, entry.name, RUN_MANIFEST_FILE))) {
        continue;
      }
      const read = this.read(entry.name);
      if (read.ok) {
        manifests.push(read.value);
      }
    }
    manifests.sort((a, b) =>
      a.createdAt === b.createdAt
        ? b.id.localeCompare(a.id)
        : a.createdAt < b.createdAt
          ? 1
          : -1,
    );
    return manifests;
  }

  /**
   * Write a manifest through a temp file and a rename, so a crash mid-write
   * never leaves a truncated `run.json` — the same atomic-by-replace shape as
   * `writeJsonAtomic` in `src/config/loadConfig.ts` and `writeResponseAtomic`
   * in `src/engine/askRelay.ts`.
   */
  private writeManifest(manifest: RunManifest): Result<void, RunStoreError> {
    const file = this.manifestPath(manifest.id);
    const dir = path.dirname(file);
    const tmp = path.join(dir, `.${RUN_MANIFEST_FILE}.${process.pid}.${Date.now()}.tmp`);
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(tmp, serializeRunManifest(manifest), 'utf8');
    } catch (e) {
      return err({
        kind: 'io',
        runId: manifest.id,
        path: file,
        message: `Could not write the run manifest at ${file}: ${describe(e)}.`,
      });
    }
    try {
      renameSync(tmp, file);
    } catch (e) {
      // Best-effort cleanup of the temp file; surface the original error.
      try {
        rmSync(tmp, { force: true });
      } catch {
        // Ignore: the rename failure is what the caller needs to see.
      }
      return err({
        kind: 'io',
        runId: manifest.id,
        path: file,
        message: `Could not write the run manifest at ${file}: ${describe(e)}.`,
      });
    }
    return ok(undefined);
  }
}

/** Construct a {@link RunStore}; the factory the shells call. */
export function createRunStore(options: RunStoreOptions): RunStore {
  return new RunStore(options);
}

/**
 * A placeholder todo id, used only to reach `persistencePathForStage`'s file
 * naming: the per-todo stages validate their todo id before building the path,
 * and only the basename of the result is meaningful for a run.
 */
const RUN_ARTIFACT_TODO_ID = '_';

/**
 * The file name a run's stage artifact is persisted under: `plan.md`,
 * `execute-<n>.md`, `review-<n>.md`, `finding.md`. Derived from
 * `persistencePathForStage` so the naming rule stays in one place; a numbered
 * stage given no attempt throws through that function's own index check.
 */
export function runArtifactFileName(stage: RunStage, attempt?: number): string {
  return path.basename(persistencePathForStage(stage, RUN_ARTIFACT_TODO_ID, attempt));
}

/** The absolute path a run's stage artifact is persisted at. */
export function runArtifactPathFor(
  workspaceRoot: string,
  runId: string,
  stage: RunStage,
  attempt?: number,
): string {
  return path.join(runDirFor(workspaceRoot, runId), runArtifactFileName(stage, attempt));
}

/** Where a run's stage artifact goes, and the writer that puts it there. */
export interface RunArtifactTarget {
  /** Absolute path the rendered artifact lands at. */
  path: string;
  /** The writer handed to `awaitStageResult`; its path argument is ignored. */
  write: ArtifactWriter;
}

/**
 * The artifact writer a run's stage launch hands to `awaitStageResult`.
 *
 * `awaitStageResult` composes its own destination with `artifactPathFor(root,
 * slug, ...)` under `.baiton/specs/<slug>/`, and a run has no slug — so this
 * writer ignores the path it is handed and writes into the run directory
 * instead. That also means the `artifactPath` on the `RunOutcome` it resolves
 * with is the unused spec-relative path: {@link RunArtifactTarget.path} is the
 * one the caller journals and shows the user.
 */
export function runArtifactWriter(
  workspaceRoot: string,
  runId: string,
  stage: RunStage,
  attempt?: number,
): RunArtifactTarget {
  const target = runArtifactPathFor(workspaceRoot, runId, stage, attempt);
  return {
    path: target,
    write: (_artifactPath: string, contents: string) => {
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, contents, 'utf8');
    },
  };
}
