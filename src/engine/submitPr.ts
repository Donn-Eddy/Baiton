/**
 * Submit PR (design section 8, "PR"; section 11 journal "PR steps").
 *
 * {@link submitPr} is the per-spec counterpart of the per-todo run queue. In
 * order it:
 *
 *   1. Reads the spec and refuses unless every todo is `done`, the approval
 *      hash is current, the spec carries `branch`/`base_commit`, that branch
 *      is checked out, and the tree is clean.
 *   2. Runs `git.verify` when configured; a failure halts with its output.
 *   3. Launches the pr-writer like any stage — Brief, terminal, result
 *      watcher — with a context section naming the spec folder and a
 *      `diff.patch` of the cumulative change from `base_commit`, journaled
 *      under the pseudo todo id {@link PR_TODO_ID}.
 *   4. On a valid `{title, body}` result: commits the persisted draft, pushes
 *      the branch with upstream set, reuses an open PR for that head or creates one, writes `pr:` and
 *      `status: pr` into the frontmatter, and commits the metadata. Each of
 *      push / create / record is journaled so recovery can tell how far it got.
 *
 * Host-independent like the queue: the adapter, terminal host, watcher
 * factory, git service and PR tool are injected.
 */
import { exec } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { Adapter } from '../adapter';
import type { GitService } from '../git';
import { appendCompletion, appendStart, parseJournal } from '../journal';
import type { PrCompletion, RunResultKind } from '../journal';
import { approvalHash } from '../model/hash';
import { parseSpec } from '../model/parser';
import type { Role } from '../model/role';
import { setFrontmatterKey } from '../model/writer';
import type { PrResult } from '../schema';
import { launchStage } from './launcher';
import { describePrToolError, type PrTool, type PullRequest } from './prTool';
import { awaitStageResult, type RunOutcome } from './resultFlow';
import type { ResultWatcherFactory } from './runQueue';
import type { HostTerminal, TerminalHost } from './terminalHost';

/** The journal `todoId` a PR run is recorded under; no todo carries this id. */
export const PR_TODO_ID = 'PR';

/** The cumulative diff file written into the run directory for the writer. */
export const PR_DIFF_FILE_NAME = 'diff.patch';

/** Runs a shell command (the Verify step); resolves its combined output. */
export type CommandRunner = (
  command: string,
  cwd: string,
) => Promise<{ ok: boolean; output: string }>;

export interface SubmitPrDeps {
  workspaceRoot: string;
  /** The `.baiton/specs` directory. */
  specsDir: string;
  adapter: Adapter;
  terminalHost: TerminalHost;
  watcherFactory: ResultWatcherFactory;
  git: GitService;
  pr: PrTool;
  /** The remote the branch is pushed to (`git.remote`). */
  remote: string;
  /** The `git.verify` command, when configured. */
  verify?: string;
  runCommand?: CommandRunner;
  modelForRole(role: Role): { model: string; effort?: string };
  /** Surfaces an invalid-result detail while the terminal stays open. */
  reportInvalid?: (detail: string) => void;
  clock?: () => number;
  newSessionId?: () => string;
}

export type SubmitPrError =
  | { kind: 'not-ready'; message: string }
  | { kind: 'dirty-tree'; message: string }
  | { kind: 'verify-failed'; message: string; output: string }
  | { kind: 'probe-failed'; message: string }
  | { kind: 'launch-failed'; message: string }
  | { kind: 'outcome'; outcome: RunOutcome; message: string }
  | { kind: 'reset-failed'; message: string }
  | { kind: 'push-failed'; message: string }
  | { kind: 'create-failed'; message: string }
  | { kind: 'record-failed'; message: string };

export type SubmitPrResult =
  | { ok: true; pr: PullRequest; reused: boolean; title: string }
  | { ok: false; error: SubmitPrError };

/** What the readiness check established about the spec. */
interface ReadySpec {
  content: string;
  branch: string;
  base: string;
  baseCommit: string;
}

export async function submitPr(slug: string, deps: SubmitPrDeps): Promise<SubmitPrResult> {
  const specPath = path.join(deps.specsDir, slug, 'spec.md');
  const journalPath = path.join(deps.specsDir, slug, 'runs.jsonl');

  // 1. Readiness (Req 8 "PR": every todo done, approval current, on branch).
  const ready = await checkReady(slug, specPath, deps);
  if (!ready.ok) {
    return ready;
  }
  const { branch, base, baseCommit } = ready.value;

  // 2. Verify, when configured; failure halts with the output shown.
  if (deps.verify !== undefined && deps.verify.trim().length > 0) {
    const run = deps.runCommand ?? defaultRunCommand;
    const verified = await run(deps.verify, deps.workspaceRoot);
    if (!verified.ok) {
      return fail({
        kind: 'verify-failed',
        message: `verify command failed: ${deps.verify}`,
        output: verified.output,
      });
    }
  }

  // 3. Probe the adapter before launching, as every stage does (Req 14.2).
  const probe = await deps.adapter.probe();
  if (!probe.ok) {
    return fail({ kind: 'probe-failed', message: `adapter probe failed: ${probe.reason ?? 'unknown reason'}` });
  }

  // 4. Launch the pr-writer with the cumulative diff and spec folder as context.
  const clock = deps.clock ?? Date.now;
  const attempt = countPrStarts(journalPath) + 1;
  const runId = `${slug}-pr-${attempt}-${clock()}`;
  const sessionId = (deps.newSessionId ?? randomUUID)();
  const runDir = path.join(deps.workspaceRoot, '.baiton', 'runs', runId);
  const diffPath = path.join(runDir, PR_DIFF_FILE_NAME);
  try {
    mkdirSync(runDir, { recursive: true });
    writeFileSync(diffPath, await deps.git.diff(baseCommit, 'HEAD'), 'utf8');
  } catch (e) {
    return fail({ kind: 'launch-failed', message: `could not write the cumulative diff: ${errorMessage(e)}` });
  }

  const { model, effort } = deps.modelForRole('pr-writer');
  const startHead = await safe(() => deps.git.head(), '');
  const launched = launchStage(
    {
      workspaceRoot: deps.workspaceRoot,
      runId,
      stage: 'pr',
      role: 'pr-writer',
      model,
      effort,
      resume: false,
      sessionId,
      briefContext: prContext({
        specDir: path.join(deps.specsDir, slug),
        diffPath,
        base,
        branch,
      }),
    },
    { adapter: deps.adapter, terminalHost: deps.terminalHost },
  );
  if (!launched.ok) {
    return fail({ kind: 'launch-failed', message: `stage launch failed: ${launched.error.message}` });
  }
  const { terminal, resultPath } = launched.value;

  const terminalPid = await resolvePid(terminal);
  appendStart(journalPath, {
    runId,
    todoId: PR_TODO_ID,
    stage: 'pr',
    attempt,
    startHead,
    inputRev: '',
    ...(terminalPid !== undefined ? { terminalPid } : {}),
    sessionId,
  });

  const watcher = deps.watcherFactory.create({ slug, runId, resultPath, terminal });
  const outcome = await awaitStageResult(
    { workspaceRoot: deps.workspaceRoot, slug, stage: 'pr', terminal, watcher },
    { reportInvalid: deps.reportInvalid },
  );

  if (outcome.kind !== 'completed') {
    appendCompletion(journalPath, { runId, result: outcome.kind as RunResultKind });
    return fail({ kind: 'outcome', outcome, message: `PR stage ${outcome.kind}; nothing was pushed` });
  }
  const draft = outcome.structured as PrResult;

  // Commit the persisted draft (`pr.md`) before the reset below, as the queue
  // commits a stage's metadata before restoring the tree; otherwise the
  // untracked artifact would be cleaned away. A no-op commit is tolerated.
  await safe(() => deps.git.commit(`spec(${slug}): pr draft`), undefined);

  // The writer is read-only; restore the tree like every non-execute stage.
  const reset = await deps.git.resetWorkingTree();
  if (!reset.ok) {
    appendCompletion(journalPath, { runId, result: 'completed' });
    return fail({
      kind: 'reset-failed',
      message: `working tree was not restored: ${reset.error.command} exited ${String(reset.error.exitCode)}`,
    });
  }

  // 5. Push, create-or-reuse, record — journaled step by step.
  const steps: PrCompletion = { push: false, create: false, record: false };
  const complete = (): void => appendCompletion(journalPath, { runId, result: 'completed', pr: steps });

  try {
    await deps.git.push(deps.remote, branch);
    steps.push = true;
  } catch (e) {
    complete();
    return fail({ kind: 'push-failed', message: `push of ${branch} to ${deps.remote} was rejected: ${errorMessage(e)}` });
  }

  let pr: PullRequest;
  let reused = false;
  try {
    const existing = await deps.pr.findOpenByHead(branch);
    if (existing !== undefined) {
      pr = existing;
      reused = true;
    } else {
      pr = await deps.pr.create({ base, head: branch, title: draft.title, body: draft.body });
    }
    steps.create = true;
  } catch (e) {
    complete();
    return fail({ kind: 'create-failed', message: `could not create the pull request: ${describePrToolError(e)}` });
  }

  try {
    let content = await fsp.readFile(specPath, 'utf8');
    content = setFrontmatterKey(content, 'pr', pr.url);
    content = setFrontmatterKey(content, 'status', 'pr');
    await fsp.writeFile(specPath, content, 'utf8');
    await deps.git.commit(`spec(${slug}): pr`);
    steps.record = true;
  } catch (e) {
    complete();
    return fail({ kind: 'record-failed', message: `pull request ${pr.url} exists but recording it failed: ${errorMessage(e)}` });
  }

  complete();
  return { ok: true, pr, reused, title: draft.title };
}

async function checkReady(
  slug: string,
  specPath: string,
  deps: SubmitPrDeps,
): Promise<{ ok: true; value: ReadySpec } | { ok: false; error: SubmitPrError }> {
  let content: string;
  try {
    content = await fsp.readFile(specPath, 'utf8');
  } catch {
    return fail({ kind: 'not-ready', message: `spec "${slug}" was not found` });
  }
  const spec = parseSpec(content);

  const status = (spec.frontmatter.get('status') ?? '').trim();
  if (status === 'done') {
    return fail({ kind: 'not-ready', message: `spec "${slug}" is already done` });
  }

  const recorded = (spec.frontmatter.get('approved_rev') ?? '').trim();
  if (recorded === '' || recorded !== approvalHash(spec)) {
    return fail({
      kind: 'not-ready',
      message: `spec "${slug}" is not approved or its approval is stale; re-approve first`,
    });
  }

  if (spec.todos.length === 0) {
    return fail({ kind: 'not-ready', message: `spec "${slug}" has no todos` });
  }
  const notDone = spec.todos.filter((t) => t.state !== 'done').map((t) => `${t.id} (${t.state})`);
  if (notDone.length > 0) {
    return fail({
      kind: 'not-ready',
      message: `every todo must be done before submitting a PR; still open: ${notDone.join(', ')}`,
    });
  }

  const branch = (spec.frontmatter.get('branch') ?? '').trim();
  const baseCommit = (spec.frontmatter.get('base_commit') ?? '').trim();
  const base = (spec.frontmatter.get('base') ?? '').trim();
  if (branch === '' || baseCommit === '' || base === '') {
    return fail({
      kind: 'not-ready',
      message: `spec "${slug}" is missing branch/base/base_commit metadata; approve it first`,
    });
  }

  const current = await safe(() => deps.git.currentBranch(), '');
  if (current !== branch) {
    return fail({
      kind: 'not-ready',
      message: `spec "${slug}" lives on branch ${branch} but ${current || 'no branch'} is checked out`,
    });
  }

  if (!(await safe(() => deps.git.isCleanExceptSpecFolder(slug), false))) {
    return fail({ kind: 'dirty-tree', message: 'a clean working tree is required to submit a PR' });
  }

  return { ok: true, value: { content, branch, base, baseCommit } };
}

/** The pr-writer's Brief context: where to read and what the PR targets. */
export function prContext(input: {
  specDir: string;
  diffPath: string;
  base: string;
  branch: string;
}): string {
  return [
    `The spec is \`${path.join(input.specDir, 'spec.md')}\`; its OVERVIEW and todo list describe the work.`,
    `The plans (\`plan.md\`) and execution summaries (\`execute-<n>.md\`) for each todo are in \`${input.specDir}\`.`,
    `The cumulative diff of branch \`${input.branch}\` against base \`${input.base}\` is at \`${input.diffPath}\`.`,
    'Draft the pull request from these; the extension pushes the branch and opens the PR itself.',
  ].join('\n\n');
}

function countPrStarts(journalPath: string): number {
  let count = 0;
  for (const entry of parseJournal(journalPath)) {
    if (entry.stage === 'pr') {
      count += 1;
    }
  }
  return count;
}

function defaultRunCommand(command: string, cwd: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    exec(command, { cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: error === null, output: `${stdout}${stderr}` });
    });
  });
}

function fail(error: SubmitPrError): { ok: false; error: SubmitPrError } {
  return { ok: false, error };
}

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

async function resolvePid(terminal: HostTerminal): Promise<number | undefined> {
  try {
    return await terminal.processId;
  } catch {
    return undefined;
  }
}

function errorMessage(e: unknown): string {
  if (typeof e === 'object' && e !== null && 'command' in e) {
    const ge = e as { command: string; stderr?: string };
    return `${ge.command} failed${ge.stderr ? `: ${ge.stderr.trim()}` : ''}`;
  }
  return e instanceof Error ? e.message : String(e);
}
