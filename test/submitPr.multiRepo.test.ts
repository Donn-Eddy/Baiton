import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createGitService } from '../src/git/gitService';
import { submitPr, prDiffFileNameFor } from '../src/engine/submitPr';
import type { PrRepoSettings, PrRepoTarget, SubmitPrDeps } from '../src/engine/submitPr';
import type { CreatePrInput, PrTool, PullRequest } from '../src/engine/prTool';
import type { ResultWatcherFactory } from '../src/engine/runQueue';
import type { CreateTerminalOptions, HostTerminal, TerminalHost } from '../src/engine/terminalHost';
import type { ResultWatcher, Unsubscribe } from '../src/engine/resultWatcher';
import type { Adapter, LaunchRequest, LaunchSpec, ProbeResult } from '../src/adapter';
import type { Result } from '../src/model/result';
import { parsePlan } from '../src/model/parser';
import { approvalHash } from '../src/model/hash';
import { setFrontmatterKey } from '../src/model/writer';
import { formatPrsValue } from '../src/engine/prTool';

const SLUG = 'multi';
const BRANCH = `baiton/${SLUG}`;
const DRAFT = { title: 'Shared PR title', body: 'Shared PR description.' };

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function write(root: string, relative: string, content: string): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

interface Repo { root: string; remote: string; }
interface World {
  owner: Repo;
  child: Repo;
  planPath: string;
  originalPlan: string;
  ownerGit: ReturnType<typeof createGitService>;
  childGit: ReturnType<typeof createGitService>;
  ownerPushes: () => number;
}

function initRepo(root: string): Repo {
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-multi-remote-'));
  git(remote, 'init', '-q', '--bare');
  fs.mkdirSync(root, { recursive: true });
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Baiton Test');
  git(root, 'config', 'user.email', 'baiton-test@example.com');
  git(root, 'checkout', '-q', '-b', 'main');
  git(root, 'remote', 'add', 'origin', remote);
  return { root, remote };
}

function planDocument(baseCommit: string, phases: readonly { id: string; title: string; repo?: string }[], approvedRev = ''): string {
  return [
    '---',
    `name: ${SLUG}`,
    'status: approved',
    'mode: manual',
    'base: main',
    `base_commit: ${baseCommit}`,
    `branch: ${BRANCH}`,
    `approved_rev: ${approvedRev}`,
    'pr:',
    '---',
    '',
    '# Endstate',
    'Complete the owner and child changes.',
    '',
    '# What needs changing',
    'Ship the changes.',
    '',
    '# Limitations & constraints',
    'Keep each repo isolated.',
    '',
    '# PHASES',
    ...phases.map(({ id, title, repo }) => `- [done] ${id} ${title}${repo === undefined ? '' : ` (repo: ${repo})`}`),
    '',
  ].join('\n');
}

function makeWorld(
  phases: readonly { id: string; title: string; repo?: string }[] = [
    { id: 'P01', title: 'Owner change' },
    { id: 'P02', title: 'API change', repo: 'packages/api' },
  ],
  childBranch = true,
): World {
  const owner = initRepo(fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-multi-owner-')));
  write(owner.root, '.gitignore', 'packages/\n');
  write(owner.root, '.baiton/.gitignore', 'runs/\n');
  write(owner.root, 'src/owner.ts', 'export const owner = 0;\n');
  git(owner.root, 'add', '-A');
  git(owner.root, 'commit', '-q', '-m', 'owner base');
  const ownerBase = git(owner.root, 'rev-parse', 'HEAD').trim();
  git(owner.root, 'checkout', '-q', '-b', BRANCH);
  const draftPlan = planDocument(ownerBase, phases);
  const originalPlan = planDocument(ownerBase, phases, approvalHash(parsePlan(draftPlan)));
  const planPath = path.join(owner.root, '.baiton', 'plans', SLUG, 'plan.md');
  write(owner.root, path.relative(owner.root, planPath), originalPlan);
  write(owner.root, 'src/owner.ts', 'export const owner = 1;\n');
  git(owner.root, 'add', '-A');
  git(owner.root, 'commit', '-q', '-m', 'owner phase changes');

  const child = initRepo(path.join(owner.root, 'packages', 'api'));
  write(child.root, 'src/api.ts', 'export const api = 0;\n');
  git(child.root, 'add', '-A');
  git(child.root, 'commit', '-q', '-m', 'child base');
  if (childBranch) {
    git(child.root, 'checkout', '-q', '-b', BRANCH);
    write(child.root, 'src/api.ts', 'export const api = 1;\n');
    git(child.root, 'add', '-A');
    git(child.root, 'commit', '-q', '-m', 'child phase changes');
  }

  const realOwnerGit = createGitService(owner.root);
  let ownerPushes = 0;
  const ownerGit = new Proxy(realOwnerGit, {
    get(target, property) {
      if (property === 'push') return async (remote: string, branch: string) => {
        ownerPushes += 1;
        return realOwnerGit.push(remote, branch);
      };
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return {
    owner, child, planPath, originalPlan, ownerGit, childGit: createGitService(child.root),
    ownerPushes: () => ownerPushes,
  };
}

class FakePrTool implements PrTool {
  public existing: PullRequest | undefined;
  public readonly created: CreatePrInput[] = [];
  public readonly lookedUp: string[] = [];
  public failCreate = false;
  constructor(private readonly url: string) {}
  async findOpenByHead(branch: string): Promise<PullRequest | undefined> {
    this.lookedUp.push(branch);
    return this.existing;
  }
  async create(input: CreatePrInput): Promise<PullRequest> {
    this.created.push(input);
    if (this.failCreate) throw new Error('creation rejected');
    return { url: this.url };
  }
}

class StubAdapter implements Adapter {
  readonly id = 'claude' as const;
  readonly acceptsSessionId = true;
  readonly launches: LaunchRequest[] = [];
  async probe(): Promise<ProbeResult> { return { version: 'stub', ok: true }; }
  launch(req: LaunchRequest): LaunchSpec { this.launches.push(req); return { shellPath: 'true', shellArgs: [] }; }
  attach(): LaunchSpec { return { shellPath: 'true', shellArgs: [] }; }
}

class StubTerminal implements HostTerminal {
  readonly processId = Promise.resolve<number | undefined>(123);
  dispose(): void {}
  sendText(): void {}
  show(): void {}
}

class StubTerminalHost implements TerminalHost {
  readonly created: Array<{ terminal: StubTerminal; options: CreateTerminalOptions }> = [];
  createTerminal(options: CreateTerminalOptions): HostTerminal {
    const terminal = new StubTerminal();
    this.created.push({ terminal, options });
    return terminal;
  }
}

class StubWatcher implements ResultWatcher {
  private resultListeners: Array<(raw: string) => void> = [];
  private closeListeners: Array<(code: number | undefined) => void> = [];
  onResult(listener: (raw: string) => void): Unsubscribe { this.resultListeners.push(listener); return () => undefined; }
  onTerminalClose(listener: (code: number | undefined) => void): Unsubscribe { this.closeListeners.push(listener); return () => undefined; }
  dispose(): void {}
  emitResult(raw: string): void { for (const listener of this.resultListeners) listener(raw); }
  emitClose(code?: number): void { for (const listener of this.closeListeners) listener(code); }
}

class StubWatcherFactory implements ResultWatcherFactory {
  readonly created: Array<{ watcher: StubWatcher; resultPath: string }> = [];
  create(input: { resultPath: string }): ResultWatcher {
    const watcher = new StubWatcher();
    this.created.push({ watcher, resultPath: input.resultPath });
    return watcher;
  }
}

interface Harness {
  world: World;
  deps: SubmitPrDeps;
  adapter: StubAdapter;
  terminals: StubTerminalHost;
  watchers: StubWatcherFactory;
  ownerPr: FakePrTool;
  childPr: FakePrTool;
}

function harness(world: World, options: { phaseTarget?: SubmitPrDeps['phaseTarget']; settingsError?: string } = {}): Harness {
  const adapter = new StubAdapter();
  const terminals = new StubTerminalHost();
  const watchers = new StubWatcherFactory();
  const ownerPr = new FakePrTool('https://example.test/owner/pull/1');
  const childPr = new FakePrTool('https://example.test/api/pull/2');
  const childTarget: PrRepoTarget = { name: 'packages/api', root: world.child.root, isOwner: false, git: world.childGit };
  const repoSettings = async (): Promise<Result<PrRepoSettings, string>> => options.settingsError === undefined
    ? { ok: true, value: { remote: 'origin', base: 'main', pr: childPr } }
    : { ok: false, error: options.settingsError };
  const deps: SubmitPrDeps = {
    workspaceRoot: world.owner.root,
    baitonDir: path.join(world.owner.root, '.baiton'),
    terminalHost: terminals,
    watcherFactory: watchers,
    git: world.ownerGit,
    pr: ownerPr,
    remote: 'origin',
    modelForRole: () => ({ model: 'stub-model' }),
    adapterForRole: () => adapter,
    newSessionId: () => 'multi-pr-session',
    clock: () => 1_700_000_000_001,
    phaseTarget: options.phaseTarget ?? (async (_slug, phaseId) => {
      const target = phaseId === 'P02' || phaseId === 'P01' && parsePlan(fs.readFileSync(world.planPath, 'utf8')).phases.length === 1 && parsePlan(fs.readFileSync(world.planPath, 'utf8')).phases[0].repo !== undefined
        ? childTarget
        : { name: '.', root: world.owner.root, isOwner: true, git: world.ownerGit };
      return { ok: true, value: target };
    }),
    repoSettings: async (target) => target.name === 'packages/api' ? repoSettings() : { ok: false, error: 'unexpected target' },
  };
  return { world, deps, adapter, terminals, watchers, ownerPr, childPr };
}

async function awaitWatcher(h: Harness, count = 1): Promise<StubWatcher> {
  const deadline = Date.now() + 10_000;
  while (h.watchers.created.length < count && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.strictEqual(h.watchers.created.length, count, 'one pr-writer watcher per submission');
  return h.watchers.created[count - 1].watcher;
}

async function draftAndFinish(h: Harness, promise: ReturnType<typeof submitPr>, count = 1): Promise<Awaited<ReturnType<typeof submitPr>>> {
  (await awaitWatcher(h, count)).emitResult(JSON.stringify(DRAFT));
  return promise;
}

function readPlan(world: World): ReturnType<typeof parsePlan> {
  return parsePlan(fs.readFileSync(world.planPath, 'utf8'));
}

describe('submitPr multi-repo flow', () => {
  it('uses one writer draft and records a PR for owner and child repos', async () => {
    const h = harness(makeWorld());
    const pending = submitPr(SLUG, h.deps);
    const result = await draftAndFinish(h, pending);
    assert.strictEqual(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.strictEqual(h.terminals.created.length, 1);
    assert.strictEqual(h.watchers.created.length, 1);
    assert.strictEqual(result.prs.length, 2);
    assert.deepStrictEqual(h.ownerPr.lookedUp, [BRANCH]);
    assert.deepStrictEqual(h.childPr.lookedUp, [BRANCH]);
    assert.strictEqual(h.ownerPr.created.length, 1);
    assert.strictEqual(h.childPr.created.length, 1);
    assert.deepStrictEqual(
      { base: h.childPr.created[0].base, head: h.childPr.created[0].head },
      { base: 'main', head: BRANCH },
    );
    assert.ok(h.childPr.created[0].body.endsWith('Part of plan `multi`, which opens one PR per repo: ., packages/api.'));

    const runDir = path.dirname(h.watchers.created[0].resultPath);
    assert.match(fs.readFileSync(path.join(runDir, 'diff.patch'), 'utf8'), /owner = 1/);
    const childDiff = fs.readFileSync(path.join(runDir, prDiffFileNameFor('packages/api')), 'utf8');
    assert.match(childDiff, /api = 1/);
    const plan = readPlan(h.world);
    assert.strictEqual(plan.frontmatter.get('status'), 'pr');
    assert.strictEqual(plan.frontmatter.get('pr'), 'https://example.test/owner/pull/1');
    assert.deepStrictEqual(Object.entries(JSON.parse(plan.frontmatter.get('prs') ?? '{}')), [
      ['.', 'https://example.test/owner/pull/1'],
      ['packages/api', 'https://example.test/api/pull/2'],
    ]);
    assert.match(git(h.world.owner.remote, 'branch', '--list', BRANCH), /baiton\/multi/);
    assert.match(git(h.world.child.remote, 'branch', '--list', BRANCH), /baiton\/multi/);
  });

  it('refuses resubmitting a multi-repo plan whose PRs are all merged', async () => {
    const h = harness(makeWorld());
    const pending = submitPr(SLUG, h.deps);
    const first = await draftAndFinish(h, pending);
    assert.strictEqual(first.ok, true, JSON.stringify(first));
    if (!first.ok) return;

    const calls: Array<{ urls: string[]; repoForUrl: Map<string, string> }> = [];
    h.deps.prsMerged = async (urls, repoForUrl) => {
      calls.push({ urls: [...urls], repoForUrl: new Map(repoForUrl) });
      return true;
    };
    const planBefore = fs.readFileSync(h.world.planPath, 'utf8');
    const commitBefore = git(h.world.owner.root, 'log', '-1', '--format=%s').trim();
    const ownerLookups = h.ownerPr.lookedUp.length;
    const childLookups = h.childPr.lookedUp.length;
    const ownerCreates = h.ownerPr.created.length;
    const childCreates = h.childPr.created.length;

    const result = await submitPr(SLUG, h.deps);
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.strictEqual(result.error.kind, 'not-ready');
      assert.match(result.error.message, /already been merged/);
    }
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0].urls, [
      'https://example.test/owner/pull/1',
      'https://example.test/api/pull/2',
    ]);
    assert.strictEqual(calls[0].repoForUrl.get('https://example.test/owner/pull/1'), '.');
    assert.strictEqual(calls[0].repoForUrl.get('https://example.test/api/pull/2'), 'packages/api');
    assert.strictEqual(h.watchers.created.length, 1);
    assert.strictEqual(h.ownerPr.lookedUp.length, ownerLookups);
    assert.strictEqual(h.childPr.lookedUp.length, childLookups);
    assert.strictEqual(h.ownerPr.created.length, ownerCreates);
    assert.strictEqual(h.childPr.created.length, childCreates);
    assert.strictEqual(fs.readFileSync(h.world.planPath, 'utf8'), planBefore);
    assert.strictEqual(git(h.world.owner.root, 'log', '-1', '--format=%s').trim(), commitBefore);
  });

  it('records a partial result and retry submits only the failed child repo', async () => {
    const h = harness(makeWorld());
    h.childPr.failCreate = true;
    const firstPending = submitPr(SLUG, h.deps);
    const first = await draftAndFinish(h, firstPending);
    assert.strictEqual(first.ok, false);
    if (first.ok || first.error.kind !== 'partial') return;
    assert.deepStrictEqual(first.error.prs.map((pr) => pr.repo), ['.']);
    assert.deepStrictEqual(first.error.failures.map((failure) => failure.repo), ['packages/api']);
    assert.strictEqual(readPlan(h.world).frontmatter.get('status'), 'pr-partial');
    assert.strictEqual(readPlan(h.world).frontmatter.get('prs'), formatPrsValue([{ repo: '.', url: 'https://example.test/owner/pull/1' }]));
    assert.strictEqual(git(h.world.owner.root, 'log', '-1', '--format=%s').trim(), 'plan(multi): pr (partial)');

    const ownerCreated = h.ownerPr.created.length;
    const ownerPushes = h.world.ownerPushes();
    h.childPr.failCreate = false;
    const secondPending = submitPr(SLUG, h.deps);
    const second = await draftAndFinish(h, secondPending, 2);
    assert.strictEqual(second.ok, true, JSON.stringify(second));
    if (!second.ok) return;
    assert.strictEqual(h.ownerPr.created.length, ownerCreated);
    assert.strictEqual(h.ownerPr.lookedUp.length, 1);
    assert.strictEqual(h.world.ownerPushes(), ownerPushes);
    assert.strictEqual(h.childPr.created.length, 2);
    assert.deepStrictEqual(h.childPr.lookedUp, [BRANCH, BRANCH]);
    assert.strictEqual(readPlan(h.world).frontmatter.get('status'), 'pr');
    assert.deepStrictEqual(Object.entries(JSON.parse(readPlan(h.world).frontmatter.get('prs') ?? '{}')), [
      ['.', 'https://example.test/owner/pull/1'],
      ['packages/api', 'https://example.test/api/pull/2'],
    ]);
  });

  it('keeps the partial retry when merged state is unknown', async () => {
    for (const checker of [
      async () => false,
      async () => { throw new Error('offline'); },
    ]) {
      const h = harness(makeWorld());
      h.childPr.failCreate = true;
      const firstPending = submitPr(SLUG, h.deps);
      const first = await draftAndFinish(h, firstPending);
      assert.strictEqual(first.ok, false);
      if (first.ok || first.error.kind !== 'partial') return;
      assert.strictEqual(readPlan(h.world).frontmatter.get('status'), 'pr-partial');

      h.deps.prsMerged = checker;
      h.childPr.failCreate = false;
      const retryPending = submitPr(SLUG, h.deps);
      const retry = await draftAndFinish(h, retryPending, 2);
      assert.strictEqual(retry.ok, true, JSON.stringify(retry));
      assert.strictEqual(readPlan(h.world).frontmatter.get('status'), 'pr');
      assert.strictEqual(h.ownerPr.lookedUp.length, 1);
      assert.strictEqual(h.ownerPr.created.length, 1);
      assert.strictEqual(h.childPr.lookedUp.length, 2);
      assert.strictEqual(h.childPr.created.length, 2);
    }
  });

  it('refuses a pr-partial plan when its recorded PR is merged', async () => {
    const h = harness(makeWorld());
    h.childPr.failCreate = true;
    const firstPending = submitPr(SLUG, h.deps);
    const first = await draftAndFinish(h, firstPending);
    assert.strictEqual(first.ok, false);
    if (first.ok || first.error.kind !== 'partial') return;

    h.deps.prsMerged = async () => true;
    const before = fs.readFileSync(h.world.planPath, 'utf8');
    const ownerLookups = h.ownerPr.lookedUp.length;
    const childLookups = h.childPr.lookedUp.length;
    const ownerCreates = h.ownerPr.created.length;
    const childCreates = h.childPr.created.length;
    const result = await submitPr(SLUG, h.deps);
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.strictEqual(result.error.kind, 'not-ready');
      assert.match(result.error.message, /already been merged/);
    }
    assert.strictEqual(h.watchers.created.length, 1);
    assert.strictEqual(h.ownerPr.lookedUp.length, ownerLookups);
    assert.strictEqual(h.childPr.lookedUp.length, childLookups);
    assert.strictEqual(h.ownerPr.created.length, ownerCreates);
    assert.strictEqual(h.childPr.created.length, childCreates);
    assert.strictEqual(fs.readFileSync(h.world.planPath, 'utf8'), before);
  });

  it('submits a child-only plan and chooses the child URL as primary', async () => {
    const h = harness(makeWorld([{ id: 'P01', title: 'API only', repo: 'packages/api' }]));
    const pending = submitPr(SLUG, h.deps);
    const result = await draftAndFinish(h, pending);
    assert.strictEqual(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.strictEqual(h.ownerPr.lookedUp.length, 0);
    assert.strictEqual(h.childPr.created.length, 1);
    assert.strictEqual(result.pr.url, 'https://example.test/api/pull/2');
    assert.strictEqual(readPlan(h.world).frontmatter.get('pr'), 'https://example.test/api/pull/2');
    assert.strictEqual(readPlan(h.world).frontmatter.has('prs'), false);
  });

  it('preflights child branch and settings before launching or pushing', async () => {
    const missingBranch = harness(makeWorld(undefined, false));
    const missing = await submitPr(SLUG, missingBranch.deps);
    assert.strictEqual(missing.ok, false);
    if (!missing.ok) {
      assert.strictEqual(missing.error.kind, 'not-ready');
      assert.match(missing.error.message, /packages\/api/);
    }
    assert.strictEqual(missingBranch.terminals.created.length, 0);
    assert.strictEqual(missingBranch.world.ownerPushes(), 0);

    const settings = harness(makeWorld(), { settingsError: 'remote missing' });
    const settingsResult = await submitPr(SLUG, settings.deps);
    assert.strictEqual(settingsResult.ok, false);
    if (!settingsResult.ok) {
      assert.strictEqual(settingsResult.error.kind, 'not-ready');
      assert.match(settingsResult.error.message, /packages\/api/);
      assert.match(settingsResult.error.message, /remote missing/);
    }
    assert.strictEqual(settings.terminals.created.length, 0);
    assert.strictEqual(settings.world.ownerPushes(), 0);
    assert.strictEqual(git(settings.world.child.remote, 'branch', '--list', BRANCH).trim(), '');
  });

  it('keeps owner-only plans free of prs metadata with or without explicit target resolution', async () => {
    for (const explicit of [false, true]) {
      const world = makeWorld([{ id: 'P01', title: 'Owner only' }]);
      const phaseTarget = explicit
        ? async (): Promise<{ ok: true; value: PrRepoTarget }> => ({
          ok: true,
          value: { name: '.', root: world.owner.root, isOwner: true, git: world.ownerGit },
        })
        : undefined;
      const h = harness(world, { phaseTarget });
      const pending = submitPr(SLUG, h.deps);
      const result = await draftAndFinish(h, pending);
      assert.strictEqual(result.ok, true, JSON.stringify(result));
      if (!result.ok) continue;
      assert.strictEqual(result.prs.length, 1);
      assert.strictEqual(readPlan(world).frontmatter.has('prs'), false);
      const expected = setFrontmatterKey(setFrontmatterKey(world.originalPlan, 'pr', 'https://example.test/owner/pull/1'), 'status', 'pr');
      assert.strictEqual(fs.readFileSync(world.planPath, 'utf8'), expected);
    }
  });
});
