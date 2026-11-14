import * as assert from 'assert';
import * as fc from 'fast-check';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { submitPr } from '../src/engine/submitPr';
import type { SubmitPrDeps, PrRepoTarget, SubmitPrResult } from '../src/engine/submitPr';
import type { GitService } from '../src/git';
import type { CreatePrInput, PrTool, PullRequest } from '../src/engine/prTool';
import type { ResultWatcherFactory } from '../src/engine/runQueue';
import type { CreateTerminalOptions, HostTerminal, TerminalHost } from '../src/engine/terminalHost';
import type { ResultWatcher, Unsubscribe } from '../src/engine/resultWatcher';
import type { Adapter, LaunchRequest, LaunchSpec, ProbeResult } from '../src/adapter';
import type { Role } from '../src/model/role';
import { parseJournal } from '../src/journal';
import { parsePlan } from '../src/model/parser';
import { approvalHash } from '../src/model/hash';
import type { Result } from '../src/model/result';
import { isPartialPrStatus, planPrStatus, planPrsMerged, recordedPrUrls, reposToSubmit } from '../src/engine/transitions';
import type { PrState } from '../src/engine/prTool';

const casesArb = fc.uniqueArray(fc.integer({ min: 0, max: 1000 }), { minLength: 1, maxLength: 8 }).chain((ids) =>
  fc.tuple(
    fc.array(fc.boolean(), { minLength: ids.length, maxLength: ids.length }),
    fc.array(fc.boolean(), { minLength: ids.length, maxLength: ids.length }),
  ).map(([recordedMask, successMask]) => ({ ids, recordedMask, successMask })),
);

describe('plan PR status helpers', () => {
  it('reports complete, partial and absent PR state from recorded and new outcomes', () => {
    fc.assert(
      fc.property(casesArb, ({ ids, recordedMask, successMask }) => {
        const touched = ids.map((id) => `repo-${id}`);
        const recorded = new Set(touched.filter((_, i) => recordedMask[i]));
        const outcomes = touched.flatMap((repo, i) => recordedMask[i] ? [] : [{ repo, ok: successMask[i] }]);
        const hasPr = touched.map((_, i) => recordedMask[i] || successMask[i]);
        const count = hasPr.filter(Boolean).length;
        const expected = count === 0 ? undefined : count === touched.length ? 'pr' : 'pr-partial';

        assert.strictEqual(planPrStatus(touched, recorded, outcomes), expected);
        assert.deepStrictEqual(reposToSubmit(touched, recorded), touched.filter((_, i) => !recordedMask[i]));
        if (touched.length === 1) assert.notStrictEqual(planPrStatus(touched, recorded, outcomes), 'pr-partial');
      }),
      { numRuns: 300 },
    );
  });

  it('recognizes only a trimmed pr-partial status as retryable', () => {
    assert.strictEqual(isPartialPrStatus(' pr-partial '), true);
    assert.strictEqual(isPartialPrStatus('pr'), false);
    assert.strictEqual(isPartialPrStatus(undefined), false);
  });

  it('collects recorded request URLs in stable order', () => {
    assert.deepStrictEqual(recordedPrUrls(undefined, undefined), []);
    assert.deepStrictEqual(recordedPrUrls(' https://h/o/r/pull/1 ', undefined), ['https://h/o/r/pull/1']);
    assert.deepStrictEqual(recordedPrUrls('', ''), []);
    assert.deepStrictEqual(
      recordedPrUrls(
        'https://h/o/r/pull/1',
        '{"a":"https://h/o/a/pull/2","b":"https://h/o/r/pull/1"}',
      ),
      ['https://h/o/r/pull/1', 'https://h/o/a/pull/2'],
    );
    assert.deepStrictEqual(recordedPrUrls(undefined, '{"a":"u1","b":"u2"}'), ['u1', 'u2']);
    assert.deepStrictEqual(recordedPrUrls(undefined, 'not json'), []);
    assert.deepStrictEqual(recordedPrUrls(undefined, '{"a":3,"b":"u"}'), ['u']);
  });

  it('requires every recorded request to be observed as merged', () => {
    assert.strictEqual(planPrsMerged([], new Map()), false);
    assert.strictEqual(planPrsMerged(['u'], new Map([['u', 'merged']])), true);
    assert.strictEqual(planPrsMerged(['u', 'v'], new Map([['u', 'merged'], ['v', 'open']])), false);
    assert.strictEqual(planPrsMerged(['u', 'v'], new Map([['u', 'merged'], ['v', 'closed']])), false);
    assert.strictEqual(planPrsMerged(['u', 'v'], new Map([['u', 'merged'], ['v', 'unknown']])), false);
    assert.strictEqual(planPrsMerged(['u', 'v'], new Map([['u', 'merged']])), false);
    assert.strictEqual(
      planPrsMerged(['u', 'v'], new Map([['u', 'merged'], ['v', 'merged'], ['extra', 'open']])),
      true,
    );
  });

  it('matches the all-merged rule for generated request states', () => {
    const mergedCasesArb = fc.uniqueArray(fc.integer({ min: 0, max: 1000 }), { maxLength: 8 }).chain((ids) =>
      fc.array(fc.option(fc.constantFrom<PrState>('open', 'merged', 'closed', 'unknown'), { nil: undefined }), {
        minLength: ids.length,
        maxLength: ids.length,
      }).map((states) => ({ ids, states })),
    );

    fc.assert(
      fc.property(mergedCasesArb, ({ ids, states }) => {
        const urls = ids.map((id) => `https://h/o/r/pull/${id}`);
        const observed = new Map<string, PrState>();
        urls.forEach((url, index) => {
          const state = states[index];
          if (state !== undefined) observed.set(url, state);
        });

        assert.strictEqual(planPrsMerged(urls, observed), states.length > 0 && states.every((state) => state === 'merged'));
      }),
      { numRuns: 300 },
    );
  });

  it('returns the unique trimmed non-empty set of generated recorded URLs', () => {
    fc.assert(
      fc.property(fc.array(fc.string()), (inputs) => {
        const pr = inputs[0];
        const prs = JSON.stringify(Object.fromEntries(inputs.slice(1).map((url, index) => [String(index), url])));
        const recorded = recordedPrUrls(pr, prs);
        const expected = new Set(inputs.map((url) => url.trim()).filter((url) => url.length > 0));

        assert.strictEqual(new Set(recorded).size, recorded.length);
        assert.ok(recorded.every((url) => url.length > 0 && url.trim() === url));
        assert.deepStrictEqual(new Set(recorded), expected);
      }),
      { numRuns: 300 },
    );
  });
});

const PR_STATUS_SLUG = 'recorded';
const PR_STATUS_BRANCH = `baiton/${PR_STATUS_SLUG}`;
const PR_STATUS_URL = 'https://example.test/pull/81';
const PR_STATUS_CHILD_URL = 'https://example.test/api/pull/82';
const PR_STATUS_DRAFT = { title: 'Submit the plan', body: 'A fake PR draft.' };

type FakeCall =
  | { op: 'commit'; message: string }
  | { op: 'push'; remote: string; branch: string };

interface FakeCommit {
  message: string;
  snapshot: string;
}

class FakeGit {
  readonly localLog: FakeCommit[] = [];
  readonly remoteDoc = new Map<string, string>();
  readonly remoteTipIndex = new Map<string, number>();
  readonly ownCalls: FakeCall[] = [];
  failPushAt: number | undefined;
  failCommitMatching: RegExp | undefined;
  private pushes = 0;

  readonly service = new Proxy(this, {
    get: (target, property, receiver) => {
      if (property === 'service') return receiver;
      const value = Reflect.get(target, property, receiver) as unknown;
      if (value !== undefined) return typeof value === 'function' ? value.bind(target) : value;
      return () => { throw new Error(`FakeGit received unexpected GitService.${String(property)} call`); };
    },
  }) as unknown as GitService;

  constructor(
    private readonly documentPath: string,
    private readonly calls: FakeCall[],
  ) {}

  async currentBranch(): Promise<string> { return PR_STATUS_BRANCH; }
  async isCleanExceptPlanFolder(): Promise<boolean> { return true; }
  async diff(): Promise<string> { return 'fake diff'; }
  async head(): Promise<string> { return 'head-0'; }
  async resetWorkingTree(): Promise<{ ok: true; value: undefined }> { return { ok: true, value: undefined }; }
  async branchHead(): Promise<string> { return 'child-tip'; }
  async resolveBaseCommit(): Promise<string> { return 'base0'; }

  async commit(message: string): Promise<void> {
    const call: FakeCall = { op: 'commit', message };
    this.addCall(call);
    if (this.failCommitMatching?.test(message)) {
      throw Object.assign(new Error('boom'), { command: 'git commit', exitCode: 1, stderr: 'boom' });
    }
    this.localLog.push({ message, snapshot: fs.readFileSync(this.documentPath, 'utf8') });
  }

  async push(remote: string, branch: string): Promise<void> {
    this.addCall({ op: 'push', remote, branch });
    this.pushes += 1;
    if (this.failPushAt === this.pushes) throw new Error('push rejected');
    const latest = this.localLog[this.localLog.length - 1]?.snapshot ?? fs.readFileSync(this.documentPath, 'utf8');
    this.remoteDoc.set(branch, latest);
    this.remoteTipIndex.set(branch, this.localLog.length);
  }

  private addCall(call: FakeCall): void {
    this.ownCalls.push(call);
    this.calls.push(call);
  }
}

class FakePrTool implements PrTool {
  existing: PullRequest | undefined;
  failCreate = false;
  readonly lookedUp: string[] = [];
  readonly created: CreatePrInput[] = [];

  constructor(private readonly url: string) {}

  async findOpenByHead(branch: string): Promise<PullRequest | undefined> {
    this.lookedUp.push(branch);
    return this.existing;
  }

  async create(input: CreatePrInput): Promise<PullRequest> {
    this.created.push(input);
    if (this.failCreate) throw new Error('create rejected');
    return { url: this.url };
  }
}

class PrStatusAdapter implements Adapter {
  readonly id = 'claude' as const;
  readonly acceptsSessionId = true;
  launch(_request: LaunchRequest): LaunchSpec { return { shellPath: 'true', shellArgs: [] }; }
  attach(_request: { role: Role; runId: string; sessionId: string }): LaunchSpec {
    return { shellPath: 'true', shellArgs: [] };
  }
  async probe(): Promise<ProbeResult> { return { version: 'stub', ok: true }; }
}

class PrStatusTerminal implements HostTerminal {
  readonly processId = Promise.resolve<number | undefined>(1);
  sendText(): void {}
  dispose(): void {}
  show(): void {}
}

class PrStatusTerminalHost implements TerminalHost {
  createTerminal(_options: CreateTerminalOptions): HostTerminal { return new PrStatusTerminal(); }
}

class PrStatusWatcher implements ResultWatcher {
  private resultListeners: Array<(raw: string) => void> = [];
  onResult(listener: (raw: string) => void): Unsubscribe {
    this.resultListeners.push(listener);
    return () => undefined;
  }
  onTerminalClose(_listener: (code: number | undefined) => void): Unsubscribe { return () => undefined; }
  dispose(): void {}
  emitResult(raw: string): void { for (const listener of [...this.resultListeners]) listener(raw); }
}

class PrStatusWatcherFactory implements ResultWatcherFactory {
  readonly watchers: PrStatusWatcher[] = [];
  create(_input: { resultPath: string }): ResultWatcher {
    const watcher = new PrStatusWatcher();
    this.watchers.push(watcher);
    return watcher;
  }
}

interface PrStatusHarness {
  workspaceRoot: string;
  baitonDir: string;
  documentPath: string;
  calls: FakeCall[];
  owner: FakeGit;
  child: FakeGit;
  ownerPr: FakePrTool;
  childPr: FakePrTool;
  watchers: PrStatusWatcherFactory;
  deps: SubmitPrDeps;
}

function prStatusPlan(phases: readonly { id: string; title: string; repo?: string }[], approvedRev = ''): string {
  return [
    '---',
    `name: ${PR_STATUS_SLUG}`,
    'status: approved',
    'mode: manual',
    'base: main',
    'base_commit: base0',
    `branch: ${PR_STATUS_BRANCH}`,
    `approved_rev: ${approvedRev}`,
    'pr:',
    '---',
    '',
    '# Endstate',
    'All changes are complete.',
    '',
    '# What needs changing',
    'Submit the changes.',
    '',
    '# Limitations & constraints',
    'Use fake service seams.',
    '',
    '# PHASES',
    ...phases.map(({ id, title, repo }) => `- [done] ${id} ${title}${repo === undefined ? '' : ` (repo: ${repo})`}`),
    '',
  ].join('\n');
}

function prStatusHarness(
  phases: readonly { id: string; title: string; repo?: string }[] = [{ id: 'P01', title: 'Owner change' }],
  targetByPhase?: ReadonlyMap<string, 'owner' | 'child'>,
): PrStatusHarness {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-prstatus-'));
  const baitonDir = path.join(workspaceRoot, '.baiton');
  const documentPath = path.join(baitonDir, 'plans', PR_STATUS_SLUG, 'plan.md');
  fs.mkdirSync(path.dirname(documentPath), { recursive: true });
  const draftPlan = prStatusPlan(phases);
  const content = prStatusPlan(phases, approvalHash(parsePlan(draftPlan)));
  fs.writeFileSync(documentPath, content, 'utf8');

  const calls: FakeCall[] = [];
  const owner = new FakeGit(documentPath, calls);
  const child = new FakeGit(documentPath, calls);
  const ownerPr = new FakePrTool(PR_STATUS_URL);
  const childPr = new FakePrTool(PR_STATUS_CHILD_URL);
  const watchers = new PrStatusWatcherFactory();
  const adapter = new PrStatusAdapter();
  const deps: SubmitPrDeps = {
    workspaceRoot,
    baitonDir,
    terminalHost: new PrStatusTerminalHost(),
    watcherFactory: watchers,
    git: owner.service,
    pr: ownerPr,
    remote: 'origin',
    modelForRole: () => ({ model: 'stub-model' }),
    adapterForRole: () => adapter,
    newSessionId: () => 'session-prstatus',
    clock: () => 1_700_000_000_000,
    ...(targetByPhase === undefined ? {} : {
      phaseTarget: async (_slug: string, phaseId: string): Promise<Result<PrRepoTarget, string>> => {
        const targetKind = targetByPhase.get(phaseId);
        if (targetKind === undefined) return { ok: false, error: `missing target ${phaseId}` };
        if (targetKind === 'owner') {
          return { ok: true, value: { name: '.', root: workspaceRoot, isOwner: true, git: owner.service } };
        }
        return { ok: true, value: { name: 'packages/api', root: path.join(workspaceRoot, 'packages/api'), isOwner: false, git: child.service } };
      },
      repoSettings: async (): Promise<Result<{ remote: string; base: string; pr: PrTool }, string>> => ({
        ok: true,
        value: { remote: 'origin', base: 'main', pr: childPr },
      }),
    }),
  };

  return { workspaceRoot, baitonDir, documentPath, calls, owner, child, ownerPr, childPr, watchers, deps };
}

async function prStatusDraft(h: PrStatusHarness, resultIndex = 0): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (h.watchers.watchers.length <= resultIndex && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(h.watchers.watchers.length > resultIndex, 'submitPr created a result watcher');
  h.watchers.watchers[resultIndex].emitResult(JSON.stringify(PR_STATUS_DRAFT));
}

function recordedPlan(h: PrStatusHarness): ReturnType<typeof parsePlan> {
  return parsePlan(fs.readFileSync(h.documentPath, 'utf8'));
}

function journalCompletion(h: PrStatusHarness, index = -1): ReturnType<typeof parseJournal>[number] {
  const journalPath = path.join(h.baitonDir, 'plans', PR_STATUS_SLUG, 'runs.jsonl');
  const entries = parseJournal(journalPath);
  return entries[index < 0 ? entries.length + index : index];
}

function assertRecordFailed(result: SubmitPrResult, url: string): void {
  assert.strictEqual(result.ok, false);
  if (!result.ok) {
    assert.strictEqual(result.error.kind, 'record-failed');
    assert.ok(result.error.message.includes(url));
  }
}

describe('submitPr record step reaches the pushed branch', () => {
  it('pushes the recorded owner PR URL and status to the remote branch', async () => {
    const h = prStatusHarness();
    const pending = submitPr(PR_STATUS_SLUG, h.deps);
    await prStatusDraft(h);
    const result = await pending;

    assert.strictEqual(result.ok, true, JSON.stringify(result));
    // Regression: before the record push, the remote snapshot stayed approved.
    const remote = parsePlan(h.owner.remoteDoc.get(PR_STATUS_BRANCH) ?? '');
    assert.strictEqual(remote.frontmatter.get('status'), 'pr');
    assert.strictEqual(remote.frontmatter.get('pr'), PR_STATUS_URL);
    const tipIndex = h.owner.remoteTipIndex.get(PR_STATUS_BRANCH) ?? 0;
    assert.strictEqual(h.owner.localLog[tipIndex - 1]?.message, `plan(${PR_STATUS_SLUG}): pr`);
    const commitDraft = h.owner.ownCalls.findIndex((call) => call.op === 'commit' && call.message.endsWith(': pr draft'));
    const firstPush = h.owner.ownCalls.findIndex((call) => call.op === 'push');
    const recordCommit = h.owner.ownCalls.findIndex((call) => call.op === 'commit' && call.message === `plan(${PR_STATUS_SLUG}): pr`);
    let lastPush = -1;
    h.owner.ownCalls.forEach((call, index) => { if (call.op === 'push') lastPush = index; });
    assert.ok(commitDraft < firstPush && firstPush < recordCommit && recordCommit < lastPush);
    assert.deepStrictEqual(journalCompletion(h).pr, { push: true, create: true, record: true });
  });

  it('reports a rejected owner record push while keeping the local record', async () => {
    const h = prStatusHarness();
    h.owner.failPushAt = 2;
    const pending = submitPr(PR_STATUS_SLUG, h.deps);
    await prStatusDraft(h);
    assertRecordFailed(await pending, PR_STATUS_URL);
    assert.strictEqual(recordedPlan(h).frontmatter.get('status'), 'pr');
    assert.deepStrictEqual(journalCompletion(h).pr, { push: true, create: true, record: false });
  });

  it('reports a rejected owner record commit and performs no later push', async () => {
    const h = prStatusHarness();
    h.owner.failCommitMatching = /: pr$/;
    const pending = submitPr(PR_STATUS_SLUG, h.deps);
    await prStatusDraft(h);
    assertRecordFailed(await pending, PR_STATUS_URL);
    assert.strictEqual(h.owner.ownCalls[h.owner.ownCalls.length - 1]?.op, 'commit');
    assert.deepStrictEqual(journalCompletion(h).pr, { push: true, create: true, record: false });
  });

  it('recovers from a rejected record push without creating an empty record commit', async () => {
    const h = prStatusHarness();
    h.owner.failPushAt = 2;
    const firstPending = submitPr(PR_STATUS_SLUG, h.deps);
    await prStatusDraft(h, 0);
    assertRecordFailed(await firstPending, PR_STATUS_URL);
    const recordCommitCount = h.owner.localLog.filter((entry) => entry.message === `plan(${PR_STATUS_SLUG}): pr`).length;

    h.owner.failPushAt = undefined;
    h.ownerPr.existing = { url: PR_STATUS_URL };
    const retryPending = submitPr(PR_STATUS_SLUG, h.deps);
    await prStatusDraft(h, 1);
    const retry = await retryPending;
    assert.strictEqual(retry.ok, true, JSON.stringify(retry));
    assert.strictEqual(h.owner.localLog.filter((entry) => entry.message === `plan(${PR_STATUS_SLUG}): pr`).length, recordCommitCount);
    assert.strictEqual(parsePlan(h.owner.remoteDoc.get(PR_STATUS_BRANCH) ?? '').frontmatter.get('status'), 'pr');
  });

  it('pushes grouped owner and child PR URLs on the owner record commit', async () => {
    const h = prStatusHarness(
      [{ id: 'P01', title: 'Owner change' }, { id: 'P02', title: 'API change', repo: 'packages/api' }],
      new Map([['P01', 'owner'], ['P02', 'child']]),
    );
    const pending = submitPr(PR_STATUS_SLUG, h.deps);
    await prStatusDraft(h);
    const result = await pending;
    assert.strictEqual(result.ok, true, JSON.stringify(result));

    const remote = parsePlan(h.owner.remoteDoc.get(PR_STATUS_BRANCH) ?? '');
    assert.strictEqual(remote.frontmatter.get('status'), 'pr');
    assert.strictEqual(remote.frontmatter.get('pr'), PR_STATUS_URL);
    assert.deepStrictEqual(JSON.parse(remote.frontmatter.get('prs') ?? '{}'), {
      '.': PR_STATUS_URL,
      'packages/api': PR_STATUS_CHILD_URL,
    });
    const ownerCalls = h.owner.ownCalls;
    const recordCommit = ownerCalls.findIndex((call) => call.op === 'commit' && call.message === `plan(${PR_STATUS_SLUG}): pr`);
    assert.strictEqual(ownerCalls[ownerCalls.length - 1]?.op, 'push');
    assert.ok(recordCommit >= 0 && recordCommit < ownerCalls.length - 1);
  });

  it('records a partial grouped result remotely and retries only the failed repo', async () => {
    const h = prStatusHarness(
      [{ id: 'P01', title: 'Owner change' }, { id: 'P02', title: 'API change', repo: 'packages/api' }],
      new Map([['P01', 'owner'], ['P02', 'child']]),
    );
    h.childPr.failCreate = true;
    const firstPending = submitPr(PR_STATUS_SLUG, h.deps);
    await prStatusDraft(h, 0);
    const first = await firstPending;
    assert.strictEqual(first.ok, false);
    if (first.ok) return;
    assert.strictEqual(first.error.kind, 'partial');
    const remotePartial = parsePlan(h.owner.remoteDoc.get(PR_STATUS_BRANCH) ?? '');
    assert.strictEqual(remotePartial.frontmatter.get('status'), 'pr-partial');
    const partialTip = h.owner.remoteTipIndex.get(PR_STATUS_BRANCH) ?? 0;
    assert.strictEqual(h.owner.localLog[partialTip - 1]?.message, `plan(${PR_STATUS_SLUG}): pr (partial)`);

    const ownerCreates = h.ownerPr.created.length;
    const ownerLookups = h.ownerPr.lookedUp.length;
    const ownerPushes = h.owner.ownCalls.filter((call) => call.op === 'push').length;
    h.childPr.failCreate = false;
    const retryPending = submitPr(PR_STATUS_SLUG, h.deps);
    await prStatusDraft(h, 1);
    const retry = await retryPending;
    assert.strictEqual(retry.ok, true, JSON.stringify(retry));
    assert.strictEqual(h.ownerPr.created.length, ownerCreates);
    assert.strictEqual(h.ownerPr.lookedUp.length, ownerLookups);
    assert.strictEqual(h.owner.ownCalls.filter((call) => call.op === 'push').length, ownerPushes + 1);
    const remoteFinal = parsePlan(h.owner.remoteDoc.get(PR_STATUS_BRANCH) ?? '');
    assert.strictEqual(remoteFinal.frontmatter.get('status'), 'pr');
  });

  it('reports a failed grouped owner record push with the primary PR URL', async () => {
    const h = prStatusHarness(
      [{ id: 'P01', title: 'Owner change' }, { id: 'P02', title: 'API change', repo: 'packages/api' }],
      new Map([['P01', 'owner'], ['P02', 'child']]),
    );
    h.owner.failPushAt = 2;
    const pending = submitPr(PR_STATUS_SLUG, h.deps);
    await prStatusDraft(h);
    assertRecordFailed(await pending, PR_STATUS_URL);
    assert.deepStrictEqual(journalCompletion(h).pr, { push: true, create: true, record: false });
  });

  it('does not push the owner branch for a child-only plan', async () => {
    const h = prStatusHarness(
      [{ id: 'P01', title: 'API change', repo: 'packages/api' }],
      new Map([['P01', 'child']]),
    );
    const pending = submitPr(PR_STATUS_SLUG, h.deps);
    await prStatusDraft(h);
    const result = await pending;
    assert.strictEqual(result.ok, true, JSON.stringify(result));
    assert.strictEqual(h.owner.ownCalls.filter((call) => call.op === 'push').length, 0);
    assert.strictEqual(h.child.ownCalls.filter((call) => call.op === 'push').length, 1);
  });
});
