/**
 * Submit PR (design section 8, "PR"; section 11 journal "PR steps").
 *
 * {@link submitPr} is the plan-level counterpart of the phase run queue. In
 * order it:
 *
 *   1. Reads the resolved plan and refuses unless every phase is `done` and landed (no phase branch remains), the approval
 *      hash is current, the plan carries `branch`/`base_commit`, that branch
 *      is checked out, and the tree is clean.
 *   2. Runs `git.verify` when configured; a failure halts with its output.
 *   3. Groups done phases by target repo and launches one pr-writer with a
 *      diff for each repo that still needs a PR.
 *   4. On a valid `{title, body}` result, pushes each repo branch and creates
 *      or reuses one PR per repo. The owner plan records `pr` when all touched
 *      repos succeeded and `pr-partial` when at least one succeeded. Verify
 *      and the clean-tree check run only in the owner; child repos need not
 *      have their plan branch checked out or a clean main checkout.
 *
 * Host-independent like the queue: the per-role adapter lookup, terminal host,
 * watcher factory, git service and PR tool are injected.
 */
import { exec } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { Adapter } from '../adapter';
import type { GitService } from '../git';
import { appendCompletion, appendStart, planJournalPathFor, readPlanJournal } from '../journal';
import type { PrCompletion, RunResultKind } from '../journal';
import { approvalHash } from '../model/hash';
import { isPartialPrStatus, planPrStatus, reposToSubmit } from './transitions';
import { PR_PARTIAL_STATUS } from '../model/planActions';
import type { Result } from '../model/result';
import { parsePlan } from '../model/parser';
import type { Role } from '../model/role';
import { setFrontmatterKey } from '../model/writer';
import { resolveDocument, type DocumentLocation } from '../storage/documentLocation';
import type { PrResult } from '../schema';
import { launchStage } from './launcher';
import {
  describePrToolError,
  formatPrsValue,
  parsePrsValue,
  type PrTool,
  type PullRequest,
} from './prTool';
import { planBranchFor } from './phaseWorktree';
import { awaitStageResult, type RunOutcome } from './resultFlow';
import type { ResultWatcherFactory } from './runQueue';
import type { HostTerminal, TerminalHost } from './terminalHost';

/** The phase id used to record a PR run in the journal. */
export const PR_PHASE_ID = 'PR';

/** The cumulative diff file written into the run directory for the writer. */
export const PR_DIFF_FILE_NAME = 'diff.patch';

/** A non-owner repo a phase targets, as submitPr needs it. */
export interface PrRepoTarget {
  name: string;
  root: string;
  isOwner: boolean;
  git: GitService;
}

/** Remote, base and PR tool for one target repo. */
export interface PrRepoSettings {
  remote: string;
  base: string;
  pr: PrTool;
}

/** A successful PR submission for one repo. */
export interface RepoPrSuccess {
  repo: string;
  isOwner: boolean;
  branch: string;
  base: string;
  pr: PullRequest;
  reused: boolean;
}

/** A failed PR submission for one repo. */
export interface RepoPrFailure {
  repo: string;
  isOwner: boolean;
  branch: string;
  base: string;
  error: SubmitPrError;
}

/** Runs a shell command (the Verify step); resolves its combined output. */
export type CommandRunner = (
  command: string,
  cwd: string,
) => Promise<{ ok: boolean; output: string }>;

export interface SubmitPrDeps {
  workspaceRoot: string;
  /** The `.baiton` directory. */
  baitonDir: string;
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
  /**
   * Per-role adapter, selected from the role's configured `agent` id;
   * `undefined` when that id is not a known agent (Requirement 14.1).
   */
  adapterForRole(role: Role): Adapter | undefined;
  /** Surfaces an invalid-result detail while the terminal stays open. */
  reportInvalid?: (detail: string) => void;
  /**
   * The phase ids of `slug` whose branch still exists (not yet landed); the readiness check refuses while any remain.
   */
  unlandedPhases?: (slug: string) => Promise<readonly string[]>;
  /** Resolve one phase's repo target; absent means every phase targets the owner. */
  phaseTarget?: (slug: string, phaseId: string) => Promise<Result<PrRepoTarget, string>>;
  /** Resolve remote/base/provider settings for a child target repo. */
  repoSettings?: (target: PrRepoTarget) => Promise<Result<PrRepoSettings, string>>;
  clock?: () => number;
  newSessionId?: () => string;
}

export type SubmitPrError =
  | { kind: 'not-ready'; message: string }
  | { kind: 'dirty-tree'; message: string }
  | { kind: 'verify-failed'; message: string; output: string }
  | { kind: 'unknown-agent'; message: string }
  | { kind: 'probe-failed'; message: string }
  | { kind: 'launch-failed'; message: string }
  | { kind: 'outcome'; outcome: RunOutcome; message: string }
  | { kind: 'reset-failed'; message: string }
  | { kind: 'push-failed'; message: string }
  | { kind: 'create-failed'; message: string }
  | { kind: 'partial'; message: string; prs: readonly RepoPrSuccess[]; failures: readonly RepoPrFailure[] }
  | { kind: 'record-failed'; message: string };

export type SubmitPrResult =
  | { ok: true; pr: PullRequest; reused: boolean; title: string; prs: readonly RepoPrSuccess[] }
  | { ok: false; error: SubmitPrError };

/** What the readiness check established about the plan. */
interface ReadyPlan {
  content: string;
  branch: string;
  base: string;
  baseCommit: string;
  status: string;
  pr: string | undefined;
  recorded: Map<string, string>;
  phaseIds: string[];
}

/** A distinct target repository and its phases, with the owner first. */
export interface PrRepoGroup {
  target: PrRepoTarget;
  phaseIds: string[];
}

/** Group phases by canonical repo root, retaining phase order within each group. */
export function groupPhasesByRepo(
  phases: readonly { id: string }[],
  targets: ReadonlyMap<string, PrRepoTarget>,
): PrRepoGroup[] {
  const byRoot = new Map<string, PrRepoGroup>();
  for (const phase of phases) {
    const target = targets.get(phase.id);
    if (target === undefined) continue;
    const root = path.resolve(target.root);
    const group = byRoot.get(root);
    if (group === undefined) byRoot.set(root, { target, phaseIds: [phase.id] });
    else {
      if (target.isOwner && !group.target.isOwner) group.target = target;
      group.phaseIds.push(phase.id);
    }
  }
  return [...byRoot.values()].sort((a, b) => Number(b.target.isOwner) - Number(a.target.isOwner));
}

/** Child-repo diff filename, stable and safe for a filesystem path. */
export function prDiffFileNameFor(repoName: string): string {
  return `diff.${repoName.replace(/[^A-Za-z0-9._-]+/g, '_')}.patch`;
}

/** Add the repo footer used to distinguish PRs for one multi-repo plan. */
export function prBodyFor(body: string, slug: string, _repo: string, allRepos: readonly string[]): string {
  if (allRepos.length <= 1) return body;
  return `${body}\n\n---\nPart of plan \`${slug}\`, which opens one PR per repo: ${allRepos.join(', ')}.`;
}

export async function submitPr(slug: string, deps: SubmitPrDeps): Promise<SubmitPrResult> {
  const location = resolveDocument(deps.baitonDir, slug);
  const documentPath = location.documentPath;
  const journalPath = planJournalPathFor(deps.baitonDir, slug);

  const ready = await checkReady(slug, documentPath, deps);
  if (!ready.ok) {
    return ready;
  }
  const { value } = ready;
  const targets = new Map<string, PrRepoTarget>();
  for (const phaseId of value.phaseIds) {
    if (deps.phaseTarget === undefined) {
      targets.set(phaseId, { name: '.', root: deps.workspaceRoot, isOwner: true, git: deps.git });
    } else {
      let target: Result<PrRepoTarget, string>;
      try {
        target = await deps.phaseTarget(slug, phaseId);
      } catch (e) {
        return fail({ kind: 'not-ready', message: `could not resolve repo for phase ${phaseId}: ${errorMessage(e)}` });
      }
      if (!target.ok) return fail({ kind: 'not-ready', message: target.error });
      targets.set(phaseId, target.value);
    }
  }
  const groups = groupPhasesByRepo(value.phaseIds.map((id) => ({ id })), targets);
  if (groups.length === 0) {
    return fail({ kind: 'not-ready', message: `plan "${slug}" has no resolvable phase repos` });
  }

  // Preserve the established owner-only path exactly, including its early
  // journal completions and single-diff writer context.
  if (groups.length === 1 && groups[0].target.isOwner) {
    return submitOwnerPr(slug, deps, location, documentPath, journalPath, value, groups[0].target.name);
  }
  return submitGroupedPr(slug, deps, location, documentPath, journalPath, value, groups);
}

async function submitOwnerPr(
  slug: string,
  deps: SubmitPrDeps,
  location: DocumentLocation,
  documentPath: string,
  journalPath: string,
  ready: ReadyPlan,
  repoName: string,
): Promise<SubmitPrResult> {
  const { branch, base, baseCommit } = ready;

  if (deps.verify !== undefined && deps.verify.trim().length > 0) {
    const run = deps.runCommand ?? defaultRunCommand;
    const verified = await run(deps.verify, deps.workspaceRoot);
    if (!verified.ok) {
      return fail({ kind: 'verify-failed', message: `verify command failed: ${deps.verify}`, output: verified.output });
    }
  }
  const adapter = deps.adapterForRole('pr-writer');
  if (adapter === undefined) {
    return fail({ kind: 'unknown-agent', message: 'role "pr-writer" is configured with an unsupported agent; update "roles.pr-writer.agent" in .baiton/config.json' });
  }
  const probe = await adapter.probe();
  if (!probe.ok) return fail({ kind: 'probe-failed', message: `adapter probe failed: ${probe.reason ?? 'unknown reason'}` });

  const clock = deps.clock ?? Date.now;
  const attempt = countPrStarts(deps.baitonDir, slug) + 1;
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
  const launched = launchStage({
    workspaceRoot: deps.workspaceRoot, runId, stage: 'pr', role: 'pr-writer', model, effort,
    resume: false, sessionId, briefContext: prContext({ location, diffPath, base, branch }),
  }, { adapter, terminalHost: deps.terminalHost });
  if (!launched.ok) return fail({ kind: 'launch-failed', message: `stage launch failed: ${launched.error.message}` });
  const { terminal, resultPath } = launched.value;
  const terminalPid = await resolvePid(terminal);
  appendStart(journalPath, {
    runId, phaseId: PR_PHASE_ID, stage: 'pr', attempt, startHead, inputRev: '',
    ...(terminalPid !== undefined ? { terminalPid } : {}), sessionId,
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
  await safe(() => deps.git.commit(`plan(${slug}): pr draft`), undefined);
  const reset = await deps.git.resetWorkingTree();
  if (!reset.ok) {
    appendCompletion(journalPath, { runId, result: 'completed' });
    return fail({ kind: 'reset-failed', message: `working tree was not restored: ${reset.error.command} exited ${String(reset.error.exitCode)}` });
  }

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
    let content = await fsp.readFile(documentPath, 'utf8');
    content = setFrontmatterKey(content, 'pr', pr.url);
    content = setFrontmatterKey(content, 'status', 'pr');
    await fsp.writeFile(documentPath, content, 'utf8');
    await deps.git.commit(`plan(${slug}): pr`);
    steps.record = true;
  } catch (e) {
    complete();
    return fail({ kind: 'record-failed', message: `pull request ${pr.url} exists but recording it failed: ${errorMessage(e)}` });
  }
  complete();
  const repo = { repo: repoName, isOwner: true, branch, base, pr, reused };
  return { ok: true, pr, reused, title: draft.title, prs: [repo] };
}

interface PreparedRepo extends PrRepoGroup {
  branch: string;
  base: string;
  baseCommit: string;
  remote: string;
  prTool: PrTool;
}

async function submitGroupedPr(
  slug: string,
  deps: SubmitPrDeps,
  location: DocumentLocation,
  documentPath: string,
  journalPath: string,
  ready: ReadyPlan,
  groups: readonly PrRepoGroup[],
): Promise<SubmitPrResult> {
  const touchedNames = groups.map((group) => group.target.name);
  const recorded = isPartialPrStatus(ready.status) ? ready.recorded : new Map<string, string>();
  const toSubmit = new Set(reposToSubmit(touchedNames, new Set(recorded.keys())));
  const branchFor = (group: PrRepoGroup): string => group.target.isOwner ? ready.branch : planBranchFor(slug);
  const prepared: PreparedRepo[] = [];
  for (const group of groups) {
    if (!toSubmit.has(group.target.name)) continue;
    if (group.target.isOwner) {
      prepared.push({
        ...group, branch: ready.branch, base: ready.base, baseCommit: ready.baseCommit,
        remote: deps.remote, prTool: deps.pr,
      });
      continue;
    }
    if (deps.repoSettings === undefined) {
      return fail({ kind: 'not-ready', message: `repo ${group.target.name} has no configured PR settings` });
    }
    let settings: Result<PrRepoSettings, string>;
    try {
      settings = await deps.repoSettings(group.target);
    } catch (e) {
      return fail({ kind: 'not-ready', message: `repo ${group.target.name} settings could not be resolved: ${errorMessage(e)}` });
    }
    if (!settings.ok) return fail({ kind: 'not-ready', message: `repo ${group.target.name}: ${settings.error}` });
    const branch = planBranchFor(slug);
    let head: string | undefined;
    try {
      head = await (group.target.git as GitService & { branchHead(ref: string): Promise<string | undefined> }).branchHead(branch);
    } catch (e) {
      return fail({ kind: 'not-ready', message: `could not inspect plan branch ${branch} in repo ${group.target.name}: ${errorMessage(e)}` });
    }
    if (head === undefined) {
      return fail({ kind: 'not-ready', message: `phase(s) ${group.phaseIds.join(', ')} target repo ${group.target.name} but its plan branch ${branch} does not exist; land those phases first` });
    }
    let baseCommit: string;
    try {
      baseCommit = await group.target.git.resolveBaseCommit(settings.value.base);
    } catch (e) {
      return fail({ kind: 'not-ready', message: `could not resolve base ${settings.value.base} in repo ${group.target.name}: ${errorMessage(e)}` });
    }
    prepared.push({
      ...group, branch, base: settings.value.base, baseCommit,
      remote: settings.value.remote, prTool: settings.value.pr,
    });
  }

  if (prepared.length === 0) {
    const successes = groups.map((group) => ({
      repo: group.target.name, isOwner: group.target.isOwner, branch: branchFor(group),
      base: group.target.isOwner ? ready.base : '', pr: { url: recorded.get(group.target.name) ?? '' }, reused: true,
    }));
    return recordGroupedPr(slug, deps, documentPath, touchedNames, recorded, successes, [], '');
  }

  if (deps.verify !== undefined && deps.verify.trim().length > 0) {
    const run = deps.runCommand ?? defaultRunCommand;
    const verified = await run(deps.verify, deps.workspaceRoot);
    if (!verified.ok) return fail({ kind: 'verify-failed', message: `verify command failed: ${deps.verify}`, output: verified.output });
  }
  const adapter = deps.adapterForRole('pr-writer');
  if (adapter === undefined) {
    return fail({ kind: 'unknown-agent', message: 'role "pr-writer" is configured with an unsupported agent; update "roles.pr-writer.agent" in .baiton/config.json' });
  }
  const probe = await adapter.probe();
  if (!probe.ok) return fail({ kind: 'probe-failed', message: `adapter probe failed: ${probe.reason ?? 'unknown reason'}` });

  const clock = deps.clock ?? Date.now;
  const attempt = countPrStarts(deps.baitonDir, slug) + 1;
  const runId = `${slug}-pr-${attempt}-${clock()}`;
  const sessionId = (deps.newSessionId ?? randomUUID)();
  const runDir = path.join(deps.workspaceRoot, '.baiton', 'runs', runId);
  const contextRepos: { repo: string; diffPath: string; base: string; branch: string }[] = [];
  try {
    mkdirSync(runDir, { recursive: true });
    for (const repo of prepared) {
      const diffPath = path.join(runDir, repo.target.isOwner ? PR_DIFF_FILE_NAME : prDiffFileNameFor(repo.target.name));
      const diff = repo.target.isOwner
        ? await deps.git.diff(repo.baseCommit, 'HEAD')
        : await repo.target.git.diff(repo.baseCommit, repo.branch);
      writeFileSync(diffPath, diff, 'utf8');
      contextRepos.push({ repo: repo.target.name, diffPath, base: repo.base, branch: repo.branch });
    }
  } catch (e) {
    return fail({ kind: 'launch-failed', message: `could not write a repo diff: ${errorMessage(e)}` });
  }
  const { model, effort } = deps.modelForRole('pr-writer');
  const startHead = await safe(() => deps.git.head(), '');
  const launched = launchStage({
    workspaceRoot: deps.workspaceRoot, runId, stage: 'pr', role: 'pr-writer', model, effort,
    resume: false, sessionId, briefContext: prContext({ location, diffPath: contextRepos[0].diffPath, base: contextRepos[0].base, branch: contextRepos[0].branch, repos: contextRepos }),
  }, { adapter, terminalHost: deps.terminalHost });
  if (!launched.ok) return fail({ kind: 'launch-failed', message: `stage launch failed: ${launched.error.message}` });
  const { terminal, resultPath } = launched.value;
  const terminalPid = await resolvePid(terminal);
  appendStart(journalPath, {
    runId, phaseId: PR_PHASE_ID, stage: 'pr', attempt, startHead, inputRev: '',
    ...(terminalPid !== undefined ? { terminalPid } : {}), sessionId,
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
  await safe(() => deps.git.commit(`plan(${slug}): pr draft`), undefined);
  const reset = await deps.git.resetWorkingTree();
  if (!reset.ok) {
    appendCompletion(journalPath, { runId, result: 'completed' });
    return fail({ kind: 'reset-failed', message: `working tree was not restored: ${reset.error.command} exited ${String(reset.error.exitCode)}` });
  }

  const successesByName = new Map<string, RepoPrSuccess>();
  for (const group of groups) {
    const url = recorded.get(group.target.name);
    if (url !== undefined && !toSubmit.has(group.target.name)) {
      successesByName.set(group.target.name, {
        repo: group.target.name, isOwner: group.target.isOwner, branch: branchFor(group),
        base: group.target.isOwner ? ready.base : '', pr: { url }, reused: true,
      });
    }
  }
  const failures: RepoPrFailure[] = [];
  let allPushed = true;
  let allCreated = true;
  for (const repo of prepared) {
    try {
      await repo.target.git.push(repo.remote, repo.branch);
    } catch (e) {
      allPushed = false;
      allCreated = false;
      failures.push({
        repo: repo.target.name, isOwner: repo.target.isOwner, branch: repo.branch, base: repo.base,
        error: { kind: 'push-failed', message: `push of ${repo.branch} to ${repo.remote} was rejected: ${errorMessage(e)}` },
      });
      continue;
    }
    try {
      const existing = await repo.prTool.findOpenByHead(repo.branch);
      const reused = existing !== undefined;
      const pr = existing ?? await repo.prTool.create({
        base: repo.base, head: repo.branch, title: draft.title,
        body: prBodyFor(draft.body, slug, repo.target.name, touchedNames),
      });
      successesByName.set(repo.target.name, {
        repo: repo.target.name, isOwner: repo.target.isOwner, branch: repo.branch,
        base: repo.base, pr, reused,
      });
    } catch (e) {
      allCreated = false;
      failures.push({
        repo: repo.target.name, isOwner: repo.target.isOwner, branch: repo.branch, base: repo.base,
        error: { kind: 'create-failed', message: `could not create the pull request: ${describePrToolError(e)}` },
      });
    }
  }
  const prs = groups.flatMap((group) => {
    const success = successesByName.get(group.target.name);
    return success === undefined ? [] : [success];
  });
  const steps: PrCompletion = { push: allPushed, create: allCreated, record: false };
  const status = planPrStatus(touchedNames, new Set(recorded.keys()), [
    ...prs.map((pr) => ({ repo: pr.repo, ok: true })),
    ...failures.map((failure) => ({ repo: failure.repo, ok: false })),
  ]);
  const complete = (): void => appendCompletion(journalPath, { runId, result: 'completed', pr: steps });
  if (status === undefined) {
    complete();
    return failures.length > 0 ? fail(failures[0].error) : fail({ kind: 'create-failed', message: 'no pull requests were opened' });
  }
  const recordedUrls = new Map(prs.map((pr) => [pr.repo, pr.pr.url] as const));
  const orderedPrs = groups.flatMap((group) => {
    const url = recordedUrls.get(group.target.name);
    return url === undefined ? [] : [{ repo: group.target.name, url }];
  });
  const result = await recordGroupedPr(slug, deps, documentPath, touchedNames, recorded, prs, failures, draft.title, complete, steps, orderedPrs);
  return result;
}

async function recordGroupedPr(
  slug: string,
  deps: SubmitPrDeps,
  documentPath: string,
  touchedNames: readonly string[],
  recorded: ReadonlyMap<string, string>,
  prs: readonly RepoPrSuccess[],
  failures: readonly RepoPrFailure[],
  title: string,
  complete?: () => void,
  steps?: PrCompletion,
  orderedPrs?: readonly { repo: string; url: string }[],
): Promise<SubmitPrResult> {
  const status = planPrStatus(touchedNames, new Set(recorded.keys()), prs.map((pr) => ({ repo: pr.repo, ok: true })));
  if (status === undefined) {
    complete?.();
    return failures.length > 0 ? fail(failures[0].error) : fail({ kind: 'create-failed', message: 'no pull requests were opened' });
  }
  const primary = prs.find((pr) => pr.isOwner) ?? prs[0];
  if (primary === undefined) {
    complete?.();
    return fail({ kind: 'record-failed', message: `plan "${slug}" has no PR URL to record` });
  }
  try {
    let content = await fsp.readFile(documentPath, 'utf8');
    content = setFrontmatterKey(content, 'pr', primary.pr.url);
    if (touchedNames.length > 1) {
      const urls = orderedPrs ?? prs.map((pr) => ({ repo: pr.repo, url: pr.pr.url }));
      content = setFrontmatterKey(content, 'prs', formatPrsValue(urls));
    }
    content = setFrontmatterKey(content, 'status', status);
    await fsp.writeFile(documentPath, content, 'utf8');
    await deps.git.commit(status === PR_PARTIAL_STATUS ? `plan(${slug}): pr (partial)` : `plan(${slug}): pr`);
    if (steps !== undefined) steps.record = true;
  } catch (e) {
    complete?.();
    return fail({ kind: 'record-failed', message: `pull request ${primary.pr.url} exists but recording it failed: ${errorMessage(e)}` });
  }
  complete?.();
  if (status === 'pr-partial') {
    const failedText = failures.map((failure) => `${failure.repo}: ${failure.error.message}`).join('; ');
    return fail({
      kind: 'partial',
      message: `opened ${prs.length} of ${touchedNames.length} pull requests for plan "${slug}"; failed: ${failedText}. Submit PR again to retry only the failed repos.`,
      prs,
      failures,
    });
  }
  return { ok: true, pr: primary.pr, reused: primary.reused, title, prs };
}

async function checkReady(
  slug: string,
  documentPath: string,
  deps: SubmitPrDeps,
): Promise<{ ok: true; value: ReadyPlan } | { ok: false; error: SubmitPrError }> {
  let content: string;
  try {
    content = await fsp.readFile(documentPath, 'utf8');
  } catch {
    return fail({ kind: 'not-ready', message: `plan "${slug}" was not found` });
  }
  const plan = parsePlan(content);

  const status = (plan.frontmatter.get('status') ?? '').trim();
  if (status === 'done') {
    return fail({ kind: 'not-ready', message: `plan "${slug}" is already done` });
  }

  const recorded = (plan.frontmatter.get('approved_rev') ?? '').trim();
  if (recorded === '' || recorded !== approvalHash(plan)) {
    return fail({
      kind: 'not-ready',
      message: `plan "${slug}" is not approved or its approval is stale; re-approve first`,
    });
  }

  if (plan.phases.length === 0) {
    return fail({ kind: 'not-ready', message: `plan "${slug}" has no phases` });
  }
  const notDone = plan.phases.filter((phase) => phase.state !== 'done').map((phase) => `${phase.id} (${phase.state})`);
  if (notDone.length > 0) {
    return fail({
      kind: 'not-ready',
      message: `every phase must be done before submitting a PR; still open: ${notDone.join(', ')}`,
    });
  }

  if (deps.unlandedPhases !== undefined) {
    let unlanded: readonly string[];
    try {
      unlanded = await deps.unlandedPhases(slug);
    } catch (e) {
      return fail({ kind: 'not-ready', message: `could not list the unlanded phases of plan "${slug}": ${errorMessage(e)}` });
    }
    if (unlanded.length > 0) {
      return fail({
        kind: 'not-ready',
        message: `every phase must be landed before submitting a PR; still unlanded: ${unlanded.join(', ')}. Land each phase with land_phase, then try again.`,
      });
    }
  }

  const branch = (plan.frontmatter.get('branch') ?? '').trim();
  const baseCommit = (plan.frontmatter.get('base_commit') ?? '').trim();
  const base = (plan.frontmatter.get('base') ?? '').trim();
  if (branch === '' || baseCommit === '' || base === '') {
    return fail({
      kind: 'not-ready',
      message: `plan "${slug}" is missing branch/base/base_commit metadata; approve it first`,
    });
  }

  const current = await safe(() => deps.git.currentBranch(), '');
  if (current !== branch) {
    return fail({
      kind: 'not-ready',
      message: `plan "${slug}" lives on branch ${branch} but ${current || 'no branch'} is checked out`,
    });
  }

  if (!(await safe(() => deps.git.isCleanExceptPlanFolder(slug), false))) {
    return fail({ kind: 'dirty-tree', message: 'a clean working tree is required to submit a PR' });
  }

  return {
    ok: true,
    value: {
      content,
      branch,
      base,
      baseCommit,
      status,
      pr: plan.frontmatter.get('pr'),
      recorded: parsePrsValue(plan.frontmatter.get('prs')),
      phaseIds: plan.phases.map((phase) => phase.id),
    },
  };
}

/** The pr-writer's Brief context: where to read and what the PR targets. */
export function prContext(input: {
  location: DocumentLocation;
  diffPath: string;
  base: string;
  branch: string;
  repos?: readonly { repo: string; diffPath: string; base: string; branch: string }[];
}): string {
  const repos = input.repos;
  if (repos !== undefined && !(repos.length <= 1 && repos[0]?.repo === '.')) {
    return [
      `The plan document is \`${input.location.documentPath}\`; its preamble and phase list describe the work.`,
      `Each phase's plan and execution summaries live in its own folder: \`${input.location.artifactsDir}/<phase-id>/plan.md\` and \`execute-<n>.md\` beside it.`,
      ...repos.map((repo) => `Repo \`${repo.repo}\`: the diff of branch \`${repo.branch}\` against base \`${repo.base}\` is at \`${repo.diffPath}\`.`),
      'This plan opens one pull request per repo listed; write a title and body that fit all of them.',
      'Draft the pull request from these; the extension pushes the branch and opens the PR itself.',
    ].join('\n\n');
  }
  return [
    `The plan document is \`${input.location.documentPath}\`; its preamble and phase list describe the work.`,
    `Each phase's plan and execution summaries live in its own folder: \`${input.location.artifactsDir}/<phase-id>/plan.md\` and \`execute-<n>.md\` beside it.`,
    `The cumulative diff of branch \`${input.branch}\` against base \`${input.base}\` is at \`${input.diffPath}\`.`,
    'Draft the pull request from these; the extension pushes the branch and opens the PR itself.',
  ].join('\n\n');
}

function countPrStarts(baitonDir: string, slug: string): number {
  let count = 0;
  for (const entry of readPlanJournal(baitonDir, slug)) {
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
