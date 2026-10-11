import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';

import { createGitService } from '../src/git/gitService';
import type { GitWorktreeService } from '../src/git';
import type { RunQueue, PlanStore, ResultWatcherFactory } from '../src/engine/runQueue';
import { createPlanBranchWriter, type PlanBranchWriter } from '../src/engine/planBranchWriter';
import { landPhaseWorktree, phaseBranchFor, phaseWorktreeDirFor } from '../src/engine/phaseWorktree';
import { createPlanStore } from '../src/activation/planStore';
import { createPhaseQueues, createRunQueueSeam, type PhaseQueues } from '../src/activation/engineFacade';
import { GITIGNORE_CONTENTS } from '../src/config/gitignore';
import type { HostTerminal, TerminalHost, CreateTerminalOptions } from '../src/engine/terminalHost';
import type { ResultWatcher, Unsubscribe } from '../src/engine/resultWatcher';
import type { Adapter, LaunchRequest, LaunchSpec, ProbeResult } from '../src/adapter';
import { recoverJournal, type ProcessControl } from '../src/engine/recovery';
import { parseJournal, appendStart, planJournalPathFor } from '../src/journal';
import { parsePlan } from '../src/model/parser';
import { approvalHash } from '../src/model/hash';
import { isOk } from '../src/model/result';
import type { PhaseState } from '../src/model/phaseState';
import type { Stage } from '../src/model/stage';
import type { Role } from '../src/model/role';
import { documentKindFor, unlandedPhases } from '../src/engine/phaseWorktree';
import { submitPr as submitPrFlow } from '../src/engine/submitPr';
import type { CreatePrInput, PrTool } from '../src/engine/prTool';
import { createToolRegistry } from '../src/orchestrator/registry';
import { GuardContext } from '../src/orchestrator/guard';
import type { ToolServices } from '../src/orchestrator/toolServices';
import {
  OpenAiModelClient,
  UnreachableEndpointError,
  type ChatMessage,
  type ToolSpec,
} from '../src/orchestrator/modelClient';

/**
 * Offline, deterministic integration coverage for Plan → Execute → Review over
 * a single legacy phase against
 * a REAL temporary git repository, using a STUBBED sub-agent (no Claude CLI, no
 * terminal, no network beyond a local mock HTTP server) that writes
 * schema-conformant `result.json` files. The real engine pieces — the run
 * queue, git service, run journal, and the serializer-backed plan store — are
 * wired together; only the agent boundary (adapter probe/launch, terminal, and
 * the result watcher) is stubbed.
 *
 * Coverage (mapped to requirements):
 *   1. Approval branch creation from a resolved base_commit + the
 *      `plan(<slug>): approve` commit (Req 16.3, 16.5, 17.1).
 *   2. Plan → planned, `phases/<id>/plan.md` persisted, metadata commit between stages
 *      (Req 17.1).
 *   3. Execute requires a clean tree (Req 17.2); a dirty tree outside the
 *      document folder is refused (Req 17.3). On completion: phase executed, `phases/<id>/execute-1.md`
 *      persisted, and one `plan(<slug>): <id> execute attempt 1` commit carrying
 *      a `Run-Id:` trailer (Req 17.4), findable via findCommitByRunId (Req 21.5).
 *   4. Review → done, `phases/<id>/review-1.md` persisted; the non-executor post-run reset
 *      leaves gitignored files untouched (Req 15.5).
 *   5. Crash replay: a result-less journal entry whose Run-Id commit landed is
 *      reconciled by recoverJournal, replaying the lost state write (Req 21.5).
 *   6. Model endpoint against a mock server: the tools/tool_calls round trip
 *      (Req 7.1) and a connection failure → UnreachableEndpointError (Req 7.6).
 *
 * Validates: Requirements 25.2, 15.5, 16.3, 16.5, 17.1, 17.2, 17.4, 21.5, 7.1, 7.6
 */

// ---------------------------------------------------------------------------
// Temp git repo helpers
// ---------------------------------------------------------------------------

/** Run git synchronously in `cwd`, throwing on non-zero exit. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** Write a file at `repo/relPath`, creating parent directories as needed. */
function writeRepoFile(repo: string, relPath: string, contents: string): void {
  const full = path.join(repo, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents, 'utf8');
}

/** Read a file at `repo/relPath`. */
function readRepoFile(repo: string, relPath: string): string {
  return fs.readFileSync(path.join(repo, relPath), 'utf8');
}

/** Legacy plan fixture: its `` item exercises the preserved on-disk format. */
const SLUG = 'demo-legacy';
const PHASE_ID = 'T01';

/** Legacy plan fixture path. */
const LEGACY_SPEC_REL = `.baiton/specs/${SLUG}/spec.md`;

/** The initial legacy `spec.md`: one pending, approvable, unblocked item. */
function initialLegacySpec(): string {
  return [
    '---',
    'version: 1',
    'status: draft',
    'base: main',
    'base_commit:',
    'branch:',
    'approved_rev:',
    '---',
    '',
    '# OVERVIEW',
    '',
    'Build a tiny greeting module.',
    '',
    '# TODOS',
    '',
    `- [pending] ${PHASE_ID} Add a greeting function (files: src/greeting.ts)`,
    '',
  ].join('\n');
}

/**
 * Legacy plan fixture: create a temp repo with the initial document committed on `main`, a
 * local identity, a `.gitignore` that ignores the runs directory and a scratch
 * gitignored file, and `main` as the base branch. Returns the repo path.
 */
function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-integ-'));
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.name', 'Baiton Test');
  git(repo, 'config', 'user.email', 'baiton-test@example.com');
  git(repo, 'checkout', '-q', '-b', 'main');

  // A source file the executor will modify; committed so the tree starts clean.
  writeRepoFile(repo, 'src/greeting.ts', 'export const version = 0;\n');
  // Ignore the runs directory (sub-agent scratch) and a scratch gitignored file
  // whose survival across the post-run reset we assert (Req 15.5).
  writeRepoFile(repo, '.gitignore', ['.baiton/runs/', 'scratch.local', ''].join('\n'));
  // Without this the `/worktrees/` directory would dirty the main checkout.
  writeRepoFile(repo, '.baiton/.gitignore', GITIGNORE_CONTENTS);
  writeRepoFile(repo, LEGACY_SPEC_REL, initialLegacySpec());
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'initial commit');
  return repo;
}

// ---------------------------------------------------------------------------
// Stubbed agent boundary: adapter, terminal, result watcher + sub-agent
// ---------------------------------------------------------------------------

/** A stub adapter: probe always ok, launch is inert (no real CLI). */
class StubAdapter implements Adapter {
  readonly id = 'claude' as const;
  readonly acceptsSessionId = true;
  async probe(): Promise<ProbeResult> {
    return { version: '0.0.0-stub', ok: true };
  }
  launch(_req: LaunchRequest): LaunchSpec {
    return { shellPath: 'true', shellArgs: [] };
  }
  attach(_req: { role: Role; runId: string; sessionId: string }): LaunchSpec {
    return { shellPath: 'true', shellArgs: [] };
  }
}

/** A stub terminal that only records disposal; it runs no process. */
class StubTerminal implements HostTerminal {
  public disposeCount = 0;
  readonly processId = Promise.resolve<number | undefined>(4321);
  sendText(_text: string): void {
    /* inert */
  }
  dispose(): void {
    this.disposeCount += 1;
  }
  show(): void {
    /* inert */
  }
}

/** A stub terminal host that hands back {@link StubTerminal}s. */
class StubTerminalHost implements TerminalHost {
  public readonly created: StubTerminal[] = [];
  createTerminal(_options: CreateTerminalOptions): HostTerminal {
    const t = new StubTerminal();
    this.created.push(t);
    return t;
  }
}

/**
 * A stub {@link ResultWatcher} the harness drives directly. It mirrors the real
 * watcher's `onResult`/`onTerminalClose`/`dispose` seam.
 */
class StubResultWatcher implements ResultWatcher {
  public disposeCount = 0;
  private resultListeners: Array<(raw: string) => void> = [];
  private closeListeners: Array<(exitCode: number | undefined) => void> = [];

  onResult(listener: (rawContents: string) => void): Unsubscribe {
    this.resultListeners.push(listener);
    return () => {
      this.resultListeners = this.resultListeners.filter((l) => l !== listener);
    };
  }
  onTerminalClose(listener: (exitCode: number | undefined) => void): Unsubscribe {
    this.closeListeners.push(listener);
    return () => {
      this.closeListeners = this.closeListeners.filter((l) => l !== listener);
    };
  }
  dispose(): void {
    this.disposeCount += 1;
    this.resultListeners = [];
    this.closeListeners = [];
  }
  emitResult(raw: string): void {
    for (const l of [...this.resultListeners]) {
      l(raw);
    }
  }
  emitClose(exitCode: number | undefined): void {
    for (const l of [...this.closeListeners]) {
      l(exitCode);
    }
  }
}

/** Schema-conformant `result.json` bodies per stage. */
function planResultJson(): string {
  return JSON.stringify({
    steps: [{ title: 'Add greeting', detail: 'write a greeting fn', files: ['src/greeting.ts'] }],
    risks: [],
    acceptance: ['a greeting function exists'],
  });
}

function executeResultJson(): string {
  return JSON.stringify({
    summary: 'added the greeting function',
    files_changed: ['src/greeting.ts'],
    commands_run: ['npm test'],
    notes: [],
  });
}

/** A passing review result (empty findings required for a `pass` verdict). */
function reviewPassResultJson(): string {
  return JSON.stringify({
    verdict: 'pass',
    findings: [],
    tests: { ran: true, passed: true, output_tail: 'ok' },
  });
}

/**
 * The stubbed sub-agent factory. When the queue creates a watcher for a
 * launched stage it invokes the sub-agent: the sub-agent writes the stage's
 * schema-conformant `result.json` (and, for Execute, makes a working-tree
 * source change first so the queue's execute commit captures it with a
 * `Run-Id:` trailer), then fires `onResult` on the next tick so the result
 * flow validates and persists it.
 */
class StubSubAgentFactory implements ResultWatcherFactory {
  public readonly watchers: StubResultWatcher[] = [];
  /** Run-ids the factory saw a launch for, in order. */
  public readonly runIds: string[] = [];

  create(input: {
    slug: string;
    runId: string;
    resultPath: string;
    terminal: HostTerminal;
  }): ResultWatcher {
    const watcher = new StubResultWatcher();
    this.watchers.push(watcher);
    this.runIds.push(input.runId);

    // Infer the stage from the default run-id composite
    // (`<slug>-<phase>-<stage>-<attempt>-<time>`).
    const stage = inferStage(input.runId, input.slug);

    // Defer to the next tick so the queue has registered its onResult listener
    // (the watcher factory is called before awaitStageResult subscribes).
    setImmediate(() => {
      if (stage === 'execute') {
        // The executor changes the working tree before emitting its result so
        // the queue's execute commit captures the change with the Run-Id
        // trailer (Req 17.4).
        // Stages run in the phase's worktree: `<worktree>/.baiton/runs/<run-id>/result.json`.
        const stageRoot = path.resolve(path.dirname(input.resultPath), '..', '..', '..');
        writeRepoFile(stageRoot, 'src/greeting.ts', 'export const version = 1;\nexport const hello = () => "hi";\n');
      }
      // The sub-agent writes its schema-conformant result.json under its own
      // run directory. The queue's result flow re-reads it via onResult.
      const body = resultFor(stage);
      fs.mkdirSync(path.dirname(input.resultPath), { recursive: true });
      fs.writeFileSync(input.resultPath, body, 'utf8');
      watcher.emitResult(body);
    });

    return watcher;
  }
}

/** Infer the stage embedded in a default run-id composite. */
function inferStage(runId: string, slug: string): Stage {
  const suffix = runId.slice(slug.length + 1);
  if (suffix.startsWith('pr-')) return 'pr';
  const match = /^(?:P|T)\d+-(plan-review|plan|execute|review)-/.exec(suffix);
  return (match?.[1] as Stage | undefined) ?? 'review';
}

/** The schema-conformant body for a stage. */
function resultFor(stage: Stage): string {
  switch (stage) {
    case 'plan':
      return planResultJson();
    case 'execute':
      return executeResultJson();
    case 'review':
      return reviewPassResultJson();
    case 'pr':
      return JSON.stringify({ title: 'Add greeting support', body: 'Implements the greeting plan.' });
    default:
      return planResultJson();
  }
}

/** The model each role runs (inert for the stub). */
function modelForRole(_role: Role): { model: string; effort?: string } {
  return { model: 'stub-model' };
}

// ---------------------------------------------------------------------------
// Harness assembly
// ---------------------------------------------------------------------------

interface Harness {
  repo: string;
  legacySpecsDir: string;
  git: GitWorktreeService;
  writer: PlanBranchWriter;
  store: PlanStore;
  queues: PhaseQueues;
  queue: RunQueue;
  factory: StubSubAgentFactory;
  terminalHost: StubTerminalHost;
  journalPath: string;
}

/** Wire a harness over `repo` the way commands.ts does: per-phase queues, one shared writer. */
function wireHarness(repo: string, factory: ResultWatcherFactory): Harness {
  const legacySpecsDir = path.join(repo, '.baiton', 'specs');
  const gitService = createGitService(repo);
  const writer = createPlanBranchWriter({ baitonDir: path.dirname(legacySpecsDir), git: gitService });
  const store = createPlanStore(path.dirname(legacySpecsDir), gitService, writer);
  const terminalHost = new StubTerminalHost();
  const queues = createPhaseQueues({
    workspaceRoot: repo,
    baitonDir: path.dirname(legacySpecsDir),
    git: gitService,
    planWriter: writer,
    planStore: store,
    terminalHost,
    watcherFactory: factory,
    adapterForRole: () => new StubAdapter(),
    modelForRole,
  });
  return {
    repo,
    legacySpecsDir,
    git: gitService,
    writer,
    store,
    queues,
    queue: queues.queueFor(SLUG, PHASE_ID),
    factory: factory as unknown as StubSubAgentFactory,
    terminalHost,
    journalPath: planJournalPathFor(path.dirname(legacySpecsDir), SLUG),
  };
}

/** Build a fully-wired harness over a fresh temp repo. */
function makeHarness(): Harness {
  return wireHarness(makeRepo(), new StubSubAgentFactory());
}

/** Approve the legacy plan fixture directly through the git service. */
async function approvePlan(h: Harness): Promise<{ baseCommit: string; branch: string; approveCommit: string }> {
  // Clean-except-plan-folder check (Req 16.1) — the tree is clean here.
  assert.strictEqual(await h.git.isCleanExceptPlanFolder(SLUG), true);
  // Fetch is a no-op locally (no remote); resolve the base to base_commit
  // (Req 16.3) and create + check out the branch from it (Req 16.5).
  const baseCommit = await h.git.resolveBaseCommit('main');
  const branch = `baiton/${SLUG}`;
  await h.git.createPlanBranch(branch, baseCommit);
  await h.git.checkout(branch);

  // Record approval metadata into the legacy document, then compute the Approval_Hash into
  // approved_rev and commit `plan(<slug>): approve` (Req 16.5, 17.1).
  const documentAbs = path.join(h.repo, LEGACY_SPEC_REL);
  let content = fs.readFileSync(documentAbs, 'utf8');
  content = setKey(content, 'base_commit', baseCommit);
  content = setKey(content, 'branch', branch);
  content = setKey(content, 'status', 'approved');
  const hash = approvalHash(parsePlan(content));
  content = setKey(content, 'approved_rev', hash);
  fs.writeFileSync(documentAbs, content, 'utf8');
  const approveCommit = await h.git.commit(`plan(${SLUG}): approve`);
  return { baseCommit, branch, approveCommit };
}

/** Set an existing frontmatter key's value in the leading `---` block. */
function setKey(content: string, key: string, value: string): string {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') {
    throw new Error('document has no frontmatter');
  }
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      break;
    }
    const sep = lines[i].indexOf(':');
    if (sep !== -1 && lines[i].slice(0, sep).trim() === key) {
      lines[i] = `${key}: ${value}`;
      return lines.join('\n');
    }
  }
  throw new Error(`frontmatter key "${key}" not found`);
}

/** The current state of the single legacy phase. */
async function stateOf(h: Harness): Promise<PhaseState | undefined> {
  return h.store.currentState(SLUG, PHASE_ID);
}

/** Count commits whose subject matches `subject` (first line) reachable from HEAD. */
function commitSubjects(repo: string): string[] {
  return git(repo, 'log', '--format=%s')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// The mock model server (Req 7)
// ---------------------------------------------------------------------------

interface CapturedRequest {
  authorization: string | undefined;
  body: unknown;
}

interface MockServer {
  url: string;
  captured: CapturedRequest[];
  close(): Promise<void>;
}

/** Stand up a local chat-completions mock server. */
async function startMockServer(
  responder: (body: unknown) => { status?: number; headers?: http.OutgoingHttpHeaders; body: string },
): Promise<MockServer> {
  const captured: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = raw;
      }
      captured.push({ authorization: req.headers.authorization, body: parsed });
      const { status = 200, headers = { 'content-type': 'application/json' }, body } = responder(parsed);
      res.writeHead(status, headers);
      res.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    captured,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Integration: Plan → Execute → Review over a legacy document', () => {
  const repos: string[] = [];

  afterEach(() => {
    while (repos.length > 0) {
      const repo = repos.pop()!;
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  /** Build a harness and register its repo for cleanup. */
  function harness(): Harness {
    const h = makeHarness();
    repos.push(h.repo);
    return h;
  }

  it('runs the full Plan → Execute → Review flow with approval, commits, reset and crash replay', async () => {
    const h = harness();

    // -- Approval (Req 16.3, 16.5, 17.1) -----------------------------------
    const { baseCommit, branch, approveCommit } = await approvePlan(h);

    assert.match(baseCommit, /^[0-9a-f]{40}$/, 'base commit resolved to a full sha');
    assert.strictEqual(await h.git.currentBranch(), branch, 'checked out the plan branch');
    // The branch was created from the resolved base commit.
    const branchBase = git(h.repo, 'merge-base', branch, baseCommit).trim();
    assert.strictEqual(branchBase, baseCommit, 'plan branch descends from base_commit');
    // The approve commit exists with the fixed message (Req 16.5).
    assert.strictEqual(await h.git.head(), approveCommit, 'approve commit is HEAD');
    assert.strictEqual(
      git(h.repo, 'log', '-1', '--format=%s').trim(),
      `plan(${SLUG}): approve`,
      'approval commit carries the fixed plan(<slug>): approve message',
    );
    assert.strictEqual(await h.store.isApproved(SLUG), true, 'the document reports approved');

    // -- Plan → planned, plan.md, metadata commits between stages (Req 17.1) --
    const headBeforePlan = await h.git.head();
    const planResult = await h.queue.dispatch({
      slug: SLUG,
      phaseId: PHASE_ID,
      action: 'plan',
      role: 'planner',
      attempt: 1,
      resume: false,
    });
    assert.strictEqual(planResult.ok, true, 'plan dispatch succeeded');
    assert.strictEqual(await stateOf(h), 'planned', 'phase transitioned to planned');
    // Legacy fixture artifacts remain under their existing document folder.
    const planArtifact = path.join(
      h.repo, '.baiton', 'specs', SLUG, 'todos', PHASE_ID, 'plan.md',
    );
    assert.ok(fs.existsSync(planArtifact), "plan.md persisted under the phase's folder");
    // Between plan start and finish the queue wrote the running (`planning`) and
    // terminal (`planned`) metadata commits (Req 17.1).
    const headAfterPlan = await h.git.head();
    assert.notStrictEqual(headAfterPlan, headBeforePlan, 'metadata was committed during plan');
    const planSubjects = commitSubjects(h.repo);
    assert.ok(
      planSubjects.includes(`plan(${SLUG}): ${PHASE_ID} planning`),
      'a planning metadata commit landed',
    );
    assert.ok(
      planSubjects.includes(`plan(${SLUG}): ${PHASE_ID} planned`),
      'a planned metadata commit landed',
    );

    // The stages ran in the phase's worktree, on the phase branch.
    const wt = phaseWorktreeDirFor(h.repo, SLUG, PHASE_ID);
    assert.ok(fs.existsSync(wt), 'the phase worktree exists after Plan');
    assert.strictEqual(
      git(wt, 'rev-parse', '--abbrev-ref', 'HEAD').trim(),
      phaseBranchFor(SLUG, PHASE_ID, 'legacy-spec'),
      'the worktree is on the phase branch',
    );
    assert.strictEqual(phaseBranchFor(SLUG, PHASE_ID, 'legacy-spec'), 'baiton-todo/demo-legacy/T01');
    const wtGit = createGitService(wt);

    // -- Dirty-tree refusal for Execute (Req 17.2/17.3) --------------------
    // A change outside the document folder makes the tree dirty; Execute is refused.
    writeRepoFile(wt, 'src/greeting.ts', 'export const version = 99; // dirty\n');
    const dirtyResult = await h.queue.dispatch({
      slug: SLUG,
      phaseId: PHASE_ID,
      action: 'execute',
      role: 'executor',
      attempt: 1,
      resume: false,
    });
    assert.strictEqual(dirtyResult.ok, false, 'execute refused on a dirty tree');
    assert.ok(!dirtyResult.ok && dirtyResult.error.kind === 'dirty-tree', 'refusal reason is dirty-tree');
    assert.strictEqual(await stateOf(h), 'planned', 'state unchanged after a dirty-tree refusal');
    // Restore a clean tree before the real execute.
    const reset = await wtGit.resetWorkingTree();
    assert.ok(isOk(reset), 'reset restored a clean tree');
    assert.strictEqual((await wtGit.status()).clean, true, 'the worktree is clean again');

    // -- Execute → executed, execute-1.md, Run-Id commit (Req 17.4, 21.5) --
    const executeResult = await h.queue.dispatch({
      slug: SLUG,
      phaseId: PHASE_ID,
      action: 'execute',
      role: 'executor',
      attempt: 1,
      resume: false,
    });
    assert.strictEqual(executeResult.ok, true, 'execute dispatch succeeded');
    assert.strictEqual(await stateOf(h), 'executed', 'phase transitioned to executed');
    const executeArtifact = path.join(
      h.repo, '.baiton', 'specs', SLUG, 'todos', PHASE_ID, 'execute-1.md',
    );
    assert.ok(
      fs.existsSync(executeArtifact),
      "execute-1.md persisted under the phase's folder",
    );

    // Exactly one execute commit with the expected message.
    const executeSubject = `plan(${SLUG}): ${PHASE_ID} execute attempt 1`;
    const phaseBranch = phaseBranchFor(SLUG, PHASE_ID, 'legacy-spec');
    const phaseSubjects = git(h.repo, 'log', '--format=%s', phaseBranch).split('\n');
    assert.strictEqual(
      phaseSubjects.filter((s) => s === executeSubject).length,
      1,
      'exactly one execute commit landed on the phase branch',
    );
    assert.strictEqual(
      commitSubjects(h.repo).filter((s) => s === executeSubject).length,
      0,
      'the plan branch has no execute commit before landing',
    );

    // The execute commit carries the Run-Id trailer and is findable by run id.
    const executeRunId = h.factory.runIds.find((id) => id.includes('-execute-'));
    assert.ok(executeRunId, 'the execute run-id was recorded');
    const executeCommit = await wtGit.findCommitByRunId(executeRunId!);
    assert.ok(executeCommit, 'findCommitByRunId located the execute commit (Req 21.5)');
    const executeBody = git(wt, 'log', '-1', executeCommit!, '--format=%B').trim();
    assert.ok(
      executeBody.split('\n').some((l) => l === `Run-Id: ${executeRunId}`),
      'the execute commit body carries a Run-Id trailer line',
    );
    // The executor's source change was captured by the execute commit.
    assert.ok(
      readRepoFile(wt, 'src/greeting.ts').includes('hello'),
      'the executor worktree change was committed',
    );
    assert.strictEqual(
      readRepoFile(h.repo, 'src/greeting.ts'),
      'export const version = 0;\n',
      'the main checkout is untouched until landing',
    );

    // -- Review → done, review-1.md, post-run reset keeps gitignored files --
    // Create a gitignored scratch file whose survival across the reset we
    // assert (Req 15.5). It must survive `git checkout -- . && git clean -fd`.
    const scratchAbs = path.join(wt, 'scratch.local');
    fs.writeFileSync(scratchAbs, 'keep me\n', 'utf8');

    const reviewResult = await h.queue.dispatch({
      slug: SLUG,
      phaseId: PHASE_ID,
      action: 'review',
      role: 'reviewer',
      attempt: 1,
      resume: false,
    });
    assert.strictEqual(reviewResult.ok, true, 'review dispatch succeeded');
    assert.strictEqual(await stateOf(h), 'done', 'phase transitioned to done on a pass verdict');
    const reviewArtifact = path.join(
      h.repo, '.baiton', 'specs', SLUG, 'todos', PHASE_ID, 'review-1.md',
    );
    assert.ok(
      fs.existsSync(reviewArtifact),
      "review-1.md persisted under the phase's folder",
    );
    // The non-executor post-run reset ran but left the gitignored file (Req 15.5).
    assert.ok(fs.existsSync(scratchAbs), 'gitignored scratch file survived the post-run reset');
    assert.strictEqual(fs.readFileSync(scratchAbs, 'utf8'), 'keep me\n', 'its contents are intact');

    // -- Land the phase into the plan branch ---------------------------------
    const landed = await h.writer.apply(SLUG, () =>
      landPhaseWorktree({ workspaceRoot: h.repo, git: h.git }, { slug: SLUG, phaseId: PHASE_ID }),
    );
    assert.ok(landed.ok, `land succeeded: ${JSON.stringify(landed)}`);
    assert.ok(
      readRepoFile(h.repo, 'src/greeting.ts').includes('hello'),
      'the main checkout now has the executor change',
    );
    assert.strictEqual(git(h.repo, 'branch', '--list', phaseBranch).trim(), '', 'the phase branch is gone');
    assert.ok(!fs.existsSync(wt), 'the worktree is gone');
    assert.strictEqual(commitSubjects(h.repo)[0], `plan(${SLUG}): land ${PHASE_ID}`);
  });

  it('reverts to pending on a closed terminal, then Plan succeeds on the next dispatch (Req 1.1, 1.4)', async () => {
    // A watcher factory whose first stage closes before any result (exit 1);
    // its second stage (the retried Plan) succeeds normally.
    class CloseThenSucceedFactory implements ResultWatcherFactory {
      public calls = 0;
      public readonly watchers: StubResultWatcher[] = [];

      create(input: {
        slug: string;
        runId: string;
        resultPath: string;
        terminal: HostTerminal;
      }): ResultWatcher {
        const watcher = new StubResultWatcher();
        this.watchers.push(watcher);
        this.calls += 1;
        const isFirstCall = this.calls === 1;

        setImmediate(() => {
          if (isFirstCall) {
            // The CLI exited before writing a result; the terminal closes.
            watcher.emitClose(1);
            return;
          }
          const body = planResultJson();
          fs.mkdirSync(path.dirname(input.resultPath), { recursive: true });
          fs.writeFileSync(input.resultPath, body, 'utf8');
          watcher.emitResult(body);
        });

        return watcher;
      }
    }

    const repo = makeRepo();
    repos.push(repo);
    const h = wireHarness(repo, new CloseThenSucceedFactory());

    await approvePlan(h);

    // First Plan dispatch: the terminal closes before a result, so the stage
    // halts with `closed` and the phase reverts to its From_State (`pending`).
    const firstPlan = await h.queue.dispatch({
      slug: SLUG,
      phaseId: PHASE_ID,
      action: 'plan',
      role: 'planner',
      attempt: 1,
      resume: false,
    });
    assert.strictEqual(firstPlan.ok, false, 'the closed stage is refused, not a success');
    assert.ok(
      !firstPlan.ok && firstPlan.error.kind === 'outcome' && firstPlan.error.outcome.kind === 'closed',
      'the refusal reports the closed outcome',
    );
    assert.strictEqual(await stateOf(h), 'pending', 'phase reverted to pending, its From_State');
    assert.ok(
      fs.existsSync(phaseWorktreeDirFor(h.repo, SLUG, PHASE_ID)),
      'a failed stage never removes the worktree',
    );
    const subjects = commitSubjects(h.repo);
    assert.ok(
      subjects.some((s) => s === `plan(${SLUG}): ${PHASE_ID} pending (closed (exit 1))`),
      'the revert commit names the closed exit code',
    );

    // Plan succeeds on the next dispatch against the same (reverted) phase.
    const secondPlan = await h.queue.dispatch({
      slug: SLUG,
      phaseId: PHASE_ID,
      action: 'plan',
      role: 'planner',
      attempt: 1,
      resume: false,
    });
    assert.strictEqual(secondPlan.ok, true, 'plan succeeds once retried');
    assert.strictEqual(await stateOf(h), 'planned', 'phase transitioned to planned on retry');
    assert.ok(fs.existsSync(phaseWorktreeDirFor(h.repo, SLUG, PHASE_ID)), 'the retry reused the worktree');
  });

  it('replays a lost state write on crash recovery when the Run-Id commit landed (Req 21.5)', async () => {
    const h = harness();
    await approvePlan(h);

    // Wedge the phase into a running state and land an execute commit carrying
    // the crash run's Run-Id trailer, but journal ONLY the START record — the
    // shape a crash leaves behind (a result-less entry whose work landed).
    const crashRunId = 'crash-run-replay-01';
    assert.strictEqual(await h.store.writeState(SLUG, PHASE_ID, 'executing'), true);
    writeRepoFile(h.repo, 'src/greeting.ts', 'export const version = 2;\nexport const hello = () => "hi";\n');
    await h.git.commit(`plan(${SLUG}): ${PHASE_ID} execute attempt 1`, { 'Run-Id': crashRunId });
    appendStart(h.journalPath, {
      runId: crashRunId,
      phaseId: PHASE_ID,
      stage: 'execute',
      attempt: 1,
      startHead: await h.git.head(),
      inputRev: await h.store.inputRev(SLUG, PHASE_ID),
      terminalPid: 999999, // a dead pid
    });

    // Sanity: the journal entry is result-less before recovery, and the phase is
    // wedged in `executing`.
    const beforeEntry = parseJournal(h.journalPath).find((e) => e.runId === crashRunId);
    assert.ok(beforeEntry && beforeEntry.result === undefined, 'the crash entry is result-less');
    assert.strictEqual(await stateOf(h), 'executing', 'phase is wedged in executing before recovery');

    // A process seam reporting the recorded pid as dead, paired with the real
    // git seam so findCommitByRunId locates the landed commit.
    const processSeam: ProcessControl = {
      isAlive: () => false,
      kill: () => {
        /* never called for a dead pid */
      },
    };
    const outcomes = await recoverJournal({
      slug: SLUG,
      journalPath: h.journalPath,
      git: h.git,
      process: processSeam,
      planStore: h.store,
    });
    const replayed = outcomes.find((o) => o.runId === crashRunId);
    assert.ok(replayed, 'recovery produced an outcome for the crash run');
    assert.strictEqual(replayed!.action, 'replayed-state', 'the lost state write was replayed (Req 21.5)');
    assert.strictEqual(
      replayed!.commit,
      await h.git.findCommitByRunId(crashRunId),
      'recovery reported the landed Run-Id commit',
    );
    // The phase is no longer wedged: recovery replayed the execute success state.
    assert.strictEqual(await stateOf(h), 'executed', 'recovery restored the executed state');
  });

  it('exercises the model endpoint: tools/tool_calls round trip and connection failure (Req 7.1, 7.6)', async () => {
    // -- tools / tool_calls round trip (Req 7.1) ---------------------------
    const mock = await startMockServer(() => ({
      body: JSON.stringify({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                { id: 'call_1', type: 'function', function: { name: 'read_plan', arguments: '{"slug":"demo"}' } },
              ],
            },
          },
        ],
      }),
    }));
    try {
      const client = new OpenAiModelClient({
        getEndpoint: () => mock.url,
        getModel: () => 'stub-model',
        getApiKey: () => 'stub-key',
      });
      const tools: ToolSpec[] = [
        {
          name: 'read_plan',
          description: 'Read a plan',
          parameters: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
        },
      ];
      const messages: ChatMessage[] = [{ role: 'user', content: 'read the demo plan' }];
      const result = await client.complete({ messages, tools, signal: new AbortController().signal });

      // The tools array went out on the wire as an OpenAI function tool.
      const sent = mock.captured[0].body as {
        tools?: Array<{ type: string; function: { name: string } }>;
      };
      assert.strictEqual(mock.captured[0].authorization, 'Bearer stub-key');
      assert.ok(Array.isArray(sent.tools) && sent.tools.length === 1, 'tools array sent on the wire');
      assert.strictEqual(sent.tools![0].function.name, 'read_plan', 'the tool round-tripped by name');
      // The tool_calls round-tripped back into the parsed result.
      assert.deepStrictEqual(result.tool_calls, [
        { id: 'call_1', name: 'read_plan', arguments: '{"slug":"demo"}' },
      ]);
    } finally {
      await mock.close();
    }

    // -- connection failure → UnreachableEndpointError (Req 7.6) -----------
    // Reserve a port then close it so nothing is listening.
    const idle = http.createServer();
    await new Promise<void>((resolve) => idle.listen(0, '127.0.0.1', resolve));
    const { port } = idle.address() as AddressInfo;
    await new Promise<void>((resolve) => idle.close(() => resolve()));

    const unreachable = new OpenAiModelClient({
      getEndpoint: () => `http://127.0.0.1:${port}`,
      getModel: () => 'stub-model',
      getApiKey: () => 'stub-key',
    });
    await assert.rejects(
      unreachable.complete({
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        signal: new AbortController().signal,
      }),
      (err: unknown) => {
        assert.ok(err instanceof UnreachableEndpointError, 'connection failure mapped to UnreachableEndpointError');
        return true;
      },
    );
  });
});

describe('Integration: plan and legacy document flows through the control tools', () => {
  const repos: string[] = [];

  afterEach(() => {
    while (repos.length > 0) {
      fs.rmSync(repos.pop()!, { recursive: true, force: true });
    }
  });

  async function driveThroughTools(kind: 'plan' | 'legacy-spec'): Promise<void> {
    const slug = kind === 'plan' ? 'greeting-plan' : 'greeting-legacy';
    const phaseId = kind === 'plan' ? 'P01' : 'T01';
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-control-flow-'));
    const remote = `${repo}-remote.git`;
    repos.push(repo, remote);
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.name', 'Baiton Test');
    git(repo, 'config', 'user.email', 'baiton-test@example.com');
    git(repo, 'checkout', '-q', '-b', 'main');
    writeRepoFile(repo, 'src/greeting.ts', 'export const version = 0;\n');
    writeRepoFile(repo, '.gitignore', ['.baiton/runs/', 'scratch.local', ''].join('\n'));
    writeRepoFile(repo, '.baiton/.gitignore', GITIGNORE_CONTENTS);

    const documentPath = kind === 'plan'
      ? `.baiton/plans/${slug}/plan.md`
      : `.baiton/specs/${slug}/spec.md`;
    const document = kind === 'plan'
      ? [
          '---', 'version: 1', 'status: draft', 'base: main', 'base_commit:', 'branch:', 'approved_rev:', '---', '',
          '# Endstate', 'The greeting module exposes a greeting function.', '',
          '# What needs changing', 'Update src/greeting.ts.', '',
          '# Limitations & constraints', 'Keep the public API small.', '',
          '# PHASES', `- [pending] ${phaseId} Add a greeting function (files: src/greeting.ts)`, '',
        ].join('\n')
      : [
          '---', 'version: 1', 'status: draft', 'base: main', 'base_commit:', 'branch:', 'approved_rev:', '---', '',
          '# OVERVIEW', 'The greeting module needs a greeting function.', '',
          '# TODOS', `- [pending] ${phaseId} Add a greeting function (files: src/greeting.ts)`, '',
        ].join('\n');
    writeRepoFile(repo, documentPath, document);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'initial commit');
    const baseCommit = git(repo, 'rev-parse', 'HEAD').trim();

    fs.mkdirSync(remote, { recursive: true });
    git(remote, 'init', '-q', '--bare');
    git(repo, 'remote', 'add', 'origin', remote);
    git(repo, 'push', '-q', 'origin', 'main');

    const baitonDir = path.join(repo, '.baiton');
    const gitService = createGitService(repo);
    const writer = createPlanBranchWriter({ baitonDir, git: gitService });
    const store = createPlanStore(baitonDir, gitService, writer);
    const terminalHost = new StubTerminalHost();
    const watcherFactory = new StubSubAgentFactory();
    const adapterForRole = () => new StubAdapter();
    const queues = createPhaseQueues({
      workspaceRoot: repo,
      baitonDir,
      git: gitService,
      planWriter: writer,
      planStore: store,
      terminalHost,
      watcherFactory,
      adapterForRole,
      modelForRole,
      clock: () => 1_700_000_000_000,
      newSessionId: () => 'session-control-flow',
    });
    const createdPrs: CreatePrInput[] = [];
    const pr: PrTool = {
      findOpenByHead: async () => undefined,
      create: async (input) => {
        createdPrs.push(input);
        return { url: 'https://example.test/pull/42', number: 42 };
      },
    };
    const services: ToolServices = {
      repoRoot: repo,
      baitonDir,
      git: gitService,
      confirm: { confirm: async () => true },
      runQueue: createRunQueueSeam(queues.queueFor, baitonDir, adapterForRole),
      landPhase: {
        land: async ({ slug: targetSlug, phaseId: targetPhaseId }) =>
          writer.apply(targetSlug, async () => {
            const kindForTarget = documentKindFor(repo, targetSlug);
            const phaseBranch = phaseBranchFor(targetSlug, targetPhaseId, kindForTarget);
            if ((await gitService.branchHead(phaseBranch)) === undefined) {
              return { kind: 'already-landed' as const };
            }
            const landed = await landPhaseWorktree(
              { workspaceRoot: repo, git: gitService },
              { slug: targetSlug, phaseId: targetPhaseId, kind: kindForTarget },
            );
            return landed.ok
              ? {
                  kind: 'landed' as const,
                  commit: landed.value.commit,
                  noop: landed.value.noop,
                  cleanup: landed.value.cleanup,
                }
              : { kind: 'refused' as const, reason: landed.error.message };
          }),
      },
      submitPr: async (targetSlug) => {
        const submitted = await submitPrFlow(targetSlug, {
          workspaceRoot: repo,
          baitonDir,
          terminalHost,
          watcherFactory,
          git: gitService,
          pr,
          remote: 'origin',
          modelForRole,
          adapterForRole,
          unlandedPhases: (value) => unlandedPhases({ workspaceRoot: repo, git: gitService }, value),
          clock: () => 1_700_000_000_000,
          newSessionId: () => 'session-pr',
        });
        return submitted.ok
          ? { ok: true, url: submitted.pr.url, reused: submitted.reused, title: submitted.title }
          : { ok: false, error: submitted.error.message };
      },
      clock: { now: () => '2026-01-01T00:00:00.000Z' },
      ids: { next: () => 'control-flow-id' },
      gitSettings: { remote: 'origin', base: 'main' },
    };
    const registry = createToolRegistry(services);
    const guard = new GuardContext({ repoRoot: repo, baitonDir, restricted: false });
    let callIndex = 0;
    const call = (
      name: string,
      args: unknown,
      step: 'gather' | 'drive',
    ) => registry.call(name, args, `control-flow-${++callIndex}`, guard, step);

    const approved = await call('approve_plan', { slug }, 'gather');
    assert.strictEqual(approved.ok, true, JSON.stringify(approved));
    assert.strictEqual(await gitService.currentBranch(), `baiton/${slug}`);
    assert.ok(commitSubjects(repo).includes(`plan(${slug}): approve`));

    for (const [stage, expectedState] of [
      ['plan', 'planned'],
      ['execute', 'executed'],
      ['review', 'done'],
    ] as const) {
      const result = await call('run', { slug, phase: phaseId, stage }, 'drive');
      assert.strictEqual(result.ok, true, `${stage} dispatch: ${JSON.stringify(result)}`);
      assert.strictEqual(await store.currentState(slug, phaseId), expectedState);
    }

    const artifactSubdir = kind === 'plan' ? 'phases' : 'todos';
    const documentDir = path.dirname(path.join(repo, documentPath));
    const phaseDir = path.join(documentDir, artifactSubdir, phaseId);
    for (const artifact of ['plan.md', 'execute-1.md', 'review-1.md']) {
      assert.ok(fs.existsSync(path.join(phaseDir, artifact)), `${artifact} exists for ${kind}`);
    }
    const phaseBranch = phaseBranchFor(slug, phaseId, kind);
    assert.strictEqual(
      phaseBranch,
      kind === 'plan'
        ? `baiton-phase/${slug}/${phaseId}`
        : `baiton-todo/${slug}/${phaseId}`,
    );
    assert.notStrictEqual(await gitService.branchHead(phaseBranch), undefined);
    const phaseWorktree = phaseWorktreeDirFor(repo, slug, phaseId);
    assert.ok(readRepoFile(phaseWorktree, 'src/greeting.ts').includes('hello'));

    const refused = await call('submit_pr', { slug }, 'drive');
    assert.strictEqual(refused.ok, false);
    if (!refused.ok) assert.match(refused.error, /unlanded/i);
    assert.strictEqual(createdPrs.length, 0);

    const landed = await call('land_phase', { slug, phase: phaseId }, 'drive');
    assert.strictEqual(landed.ok, true, JSON.stringify(landed));
    if (landed.ok) assert.strictEqual((landed.data as { landed: boolean }).landed, true);
    assert.strictEqual(await gitService.branchHead(phaseBranch), undefined);
    assert.ok(commitSubjects(repo).includes(`plan(${slug}): land ${phaseId}`));
    assert.ok(readRepoFile(repo, 'src/greeting.ts').includes('hello'));

    const alreadyLanded = await call('land_phase', { slug, phase: phaseId }, 'drive');
    assert.strictEqual(alreadyLanded.ok, true);
    if (alreadyLanded.ok) assert.strictEqual((alreadyLanded.data as { landed: boolean }).landed, false);

    const submitted = await call('submit_pr', { slug }, 'drive');
    assert.strictEqual(submitted.ok, true, JSON.stringify(submitted));
    assert.strictEqual(createdPrs.length, 1);
    assert.strictEqual(createdPrs[0].head, `baiton/${slug}`);
    assert.strictEqual(createdPrs[0].base, 'main');
    assert.strictEqual(
      git(remote, 'show-ref', '--verify', `refs/heads/baiton/${slug}`).trim().split(/\s+/)[1],
      `refs/heads/baiton/${slug}`,
    );
    const finalDocument = readRepoFile(repo, documentPath);
    assert.ok(finalDocument.includes('pr: https://example.test/pull/42'));
    assert.ok(finalDocument.includes('status: pr'));

    const newSubjects = git(repo, 'log', '--format=%s', `${baseCommit}..HEAD`)
      .trim().split('\n').filter(Boolean);
    assert.ok(newSubjects.length > 0);
    assert.ok(newSubjects.every((subject) => subject.startsWith(`plan(${slug}):`)), newSubjects.join('\n'));
    assert.ok(newSubjects.includes(`plan(${slug}): approve`));
    assert.ok(newSubjects.includes(`plan(${slug}): land ${phaseId}`));
    assert.ok(newSubjects.includes(`plan(${slug}): pr`));

    const otherRoot = kind === 'plan' ? 'specs' : 'plans';
    assert.strictEqual(
      fs.existsSync(path.join(baitonDir, otherRoot)),
      false,
      `${kind} flow writes nothing under .baiton/${otherRoot}/`,
    );
  }

  it('drives a new plan through approve, run, land and submit_pr', async () => {
    await driveThroughTools('plan');
  });

  it('drives a legacy document through approve, run, land and submit_pr', async () => {
    await driveThroughTools('legacy-spec');
  });
});
