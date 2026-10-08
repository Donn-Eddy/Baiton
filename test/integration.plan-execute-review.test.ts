import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';

import { createGitService } from '../src/git/gitService';
import type { GitWorktreeService } from '../src/git';
import type { RunQueue, SpecStore, ResultWatcherFactory } from '../src/engine/runQueue';
import { createSpecBranchWriter, type SpecBranchWriter } from '../src/engine/specBranchWriter';
import { landTodoWorktree, todoBranchFor, todoWorktreeDirFor } from '../src/engine/todoWorktree';
import { createSpecStore } from '../src/activation/specStore';
import { createTodoQueues, type TodoQueues } from '../src/activation/engineFacade';
import { GITIGNORE_CONTENTS } from '../src/config/gitignore';
import type { HostTerminal, TerminalHost, CreateTerminalOptions } from '../src/engine/terminalHost';
import type { ResultWatcher, Unsubscribe } from '../src/engine/resultWatcher';
import type { Adapter, LaunchRequest, LaunchSpec, ProbeResult } from '../src/adapter';
import { recoverJournal, type ProcessControl } from '../src/engine/recovery';
import { parseJournal, appendStart, specJournalPathFor } from '../src/journal';
import { parseSpec } from '../src/model/parser';
import { approvalHash } from '../src/model/hash';
import { isOk } from '../src/model/result';
import type { TodoState } from '../src/model/todoState';
import type { Stage } from '../src/model/stage';
import type { Role } from '../src/model/role';
import {
  OpenAiModelClient,
  UnreachableEndpointError,
  type ChatMessage,
  type ToolSpec,
} from '../src/orchestrator/modelClient';

/**
 * The single offline, deterministic integration test for the first pass
 * (Task 16.1). It exercises Plan → Execute → Review over a single todo against
 * a REAL temporary git repository, using a STUBBED sub-agent (no Claude CLI, no
 * terminal, no network beyond a local mock HTTP server) that writes
 * schema-conformant `result.json` files. The real engine pieces — the run
 * queue, git service, run journal, and the serializer-backed spec store — are
 * wired together; only the agent boundary (adapter probe/launch, terminal, and
 * the result watcher) is stubbed.
 *
 * Coverage (mapped to requirements):
 *   1. Approval branch creation from a resolved base_commit + the
 *      `spec(<slug>): approve` commit (Req 16.3, 16.5, 17.1).
 *   2. Plan → planned, `todos/<id>/plan.md` persisted, metadata commit between stages
 *      (Req 17.1).
 *   3. Execute requires a clean tree (Req 17.2); a dirty tree outside the spec
 *      folder is refused (Req 17.3). On completion: todo executed, `todos/<id>/execute-1.md`
 *      persisted, and one `spec(<slug>): <id> execute attempt 1` commit carrying
 *      a `Run-Id:` trailer (Req 17.4), findable via findCommitByRunId (Req 21.5).
 *   4. Review → done, `todos/<id>/review-1.md` persisted; the non-executor post-run reset
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

/** The spec slug and its single todo used throughout the test. */
const SLUG = 'demo-spec';
const TODO_ID = 'T01';

/** Spec-relative path of the spec file. */
const SPEC_REL = `.baiton/specs/${SLUG}/spec.md`;

/** The initial spec.md content: one pending, approvable, unblocked todo. */
function initialSpec(): string {
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
    `- [pending] ${TODO_ID} Add a greeting function (files: src/greeting.ts)`,
    '',
  ].join('\n');
}

/**
 * Create an initialized temp repo with the initial spec committed on `main`, a
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
  writeRepoFile(repo, SPEC_REL, initialSpec());
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

    // Infer the stage from the run-id composite the default generator produced
    // (`<slug>-<todo>-<stage>-<attempt>-<time>`); robust enough for the test.
    const stage = inferStage(input.runId);

    // Defer to the next tick so the queue has registered its onResult listener
    // (the watcher factory is called before awaitStageResult subscribes).
    setImmediate(() => {
      if (stage === 'execute') {
        // The executor changes the working tree before emitting its result so
        // the queue's execute commit captures the change with the Run-Id
        // trailer (Req 17.4).
        // Stages run in the todo's worktree: `<worktree>/.baiton/runs/<run-id>/result.json`.
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
function inferStage(runId: string): Stage {
  if (runId.includes('-plan-review-')) {
    return 'plan-review';
  }
  if (runId.includes('-plan-')) {
    return 'plan';
  }
  if (runId.includes('-execute-')) {
    return 'execute';
  }
  return 'review';
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
  specsDir: string;
  git: GitWorktreeService;
  writer: SpecBranchWriter;
  store: SpecStore;
  queues: TodoQueues;
  queue: RunQueue;
  factory: StubSubAgentFactory;
  terminalHost: StubTerminalHost;
  journalPath: string;
}

/** Wire a harness over `repo` the way commands.ts does: per-todo queues, one shared writer. */
function wireHarness(repo: string, factory: ResultWatcherFactory): Harness {
  const specsDir = path.join(repo, '.baiton', 'specs');
  const gitService = createGitService(repo);
  const writer = createSpecBranchWriter({ specsDir, git: gitService });
  const store = createSpecStore(specsDir, gitService, writer);
  const terminalHost = new StubTerminalHost();
  const queues = createTodoQueues({
    workspaceRoot: repo,
    specsDir,
    git: gitService,
    specWriter: writer,
    specStore: store,
    terminalHost,
    watcherFactory: factory,
    adapterForRole: () => new StubAdapter(),
    modelForRole,
  });
  return {
    repo,
    specsDir,
    git: gitService,
    writer,
    store,
    queues,
    queue: queues.queueFor(SLUG, TODO_ID),
    factory: factory as unknown as StubSubAgentFactory,
    terminalHost,
    journalPath: specJournalPathFor(specsDir, SLUG),
  };
}

/** Build a fully-wired harness over a fresh temp repo. */
function makeHarness(): Harness {
  return wireHarness(makeRepo(), new StubSubAgentFactory());
}

/** Approve the spec directly through the git service (the control-tool path). */
async function approveSpec(h: Harness): Promise<{ baseCommit: string; branch: string; approveCommit: string }> {
  // Clean-except-spec-folder check (Req 16.1) — the tree is clean here.
  assert.strictEqual(await h.git.isCleanExceptSpecFolder(SLUG), true);
  // Fetch is a no-op locally (no remote); resolve the base to base_commit
  // (Req 16.3) and create + check out the branch from it (Req 16.5).
  const baseCommit = await h.git.resolveBaseCommit('main');
  const branch = `baiton/${SLUG}`;
  await h.git.createSpecBranch(branch, baseCommit);
  await h.git.checkout(branch);

  // Record approval metadata into the spec, then compute the Approval_Hash into
  // approved_rev and commit `spec(<slug>): approve` (Req 16.5, 17.1).
  const specAbs = path.join(h.repo, SPEC_REL);
  let content = fs.readFileSync(specAbs, 'utf8');
  content = setKey(content, 'base_commit', baseCommit);
  content = setKey(content, 'branch', branch);
  content = setKey(content, 'status', 'approved');
  const hash = approvalHash(parseSpec(content));
  content = setKey(content, 'approved_rev', hash);
  fs.writeFileSync(specAbs, content, 'utf8');
  const approveCommit = await h.git.commit(`spec(${SLUG}): approve`);
  return { baseCommit, branch, approveCommit };
}

/** Set an existing frontmatter key's value in the leading `---` block. */
function setKey(content: string, key: string, value: string): string {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') {
    throw new Error('spec has no frontmatter');
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

/** The current state of the single todo. */
async function stateOf(h: Harness): Promise<TodoState | undefined> {
  return h.store.currentState(SLUG, TODO_ID);
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

describe('Integration: Plan → Execute → Review over a temp git repo (Task 16.1)', () => {
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
    const { baseCommit, branch, approveCommit } = await approveSpec(h);

    assert.match(baseCommit, /^[0-9a-f]{40}$/, 'base commit resolved to a full sha');
    assert.strictEqual(await h.git.currentBranch(), branch, 'checked out the spec branch');
    // The branch was created from the resolved base commit.
    const branchBase = git(h.repo, 'merge-base', branch, baseCommit).trim();
    assert.strictEqual(branchBase, baseCommit, 'spec branch descends from base_commit');
    // The approve commit exists with the fixed message (Req 16.5).
    assert.strictEqual(await h.git.head(), approveCommit, 'approve commit is HEAD');
    assert.strictEqual(
      git(h.repo, 'log', '-1', '--format=%s').trim(),
      `spec(${SLUG}): approve`,
      'approval commit carries the fixed spec(<slug>): approve message',
    );
    assert.strictEqual(await h.store.isApproved(SLUG), true, 'spec reports approved');

    // -- Plan → planned, plan.md, metadata commits between stages (Req 17.1) --
    const headBeforePlan = await h.git.head();
    const planResult = await h.queue.dispatch({
      slug: SLUG,
      todoId: TODO_ID,
      action: 'plan',
      role: 'planner',
      attempt: 1,
      resume: false,
    });
    assert.strictEqual(planResult.ok, true, 'plan dispatch succeeded');
    assert.strictEqual(await stateOf(h), 'planned', 'todo transitioned to planned');
    // Artifact persisted at the plan path under the spec.
    const planArtifact = path.join(
      h.repo, '.baiton', 'specs', SLUG, 'todos', TODO_ID, 'plan.md',
    );
    assert.ok(fs.existsSync(planArtifact), "plan.md persisted under the todo's folder");
    // Between plan start and finish the queue wrote the running (`planning`) and
    // terminal (`planned`) metadata commits (Req 17.1).
    const headAfterPlan = await h.git.head();
    assert.notStrictEqual(headAfterPlan, headBeforePlan, 'metadata was committed during plan');
    const planSubjects = commitSubjects(h.repo);
    assert.ok(
      planSubjects.includes(`spec(${SLUG}): ${TODO_ID} planning`),
      'a planning metadata commit landed',
    );
    assert.ok(
      planSubjects.includes(`spec(${SLUG}): ${TODO_ID} planned`),
      'a planned metadata commit landed',
    );

    // The stages ran in the todo's worktree, on the todo branch.
    const wt = todoWorktreeDirFor(h.repo, SLUG, TODO_ID);
    assert.ok(fs.existsSync(wt), 'the todo worktree exists after Plan');
    assert.strictEqual(
      git(wt, 'rev-parse', '--abbrev-ref', 'HEAD').trim(),
      todoBranchFor(SLUG, TODO_ID),
      'the worktree is on the todo branch',
    );
    assert.strictEqual(todoBranchFor(SLUG, TODO_ID), 'baiton-todo/demo-spec/T01');
    const wtGit = createGitService(wt);

    // -- Dirty-tree refusal for Execute (Req 17.2/17.3) --------------------
    // A change OUTSIDE the spec folder makes the tree dirty; Execute is refused.
    writeRepoFile(wt, 'src/greeting.ts', 'export const version = 99; // dirty\n');
    const dirtyResult = await h.queue.dispatch({
      slug: SLUG,
      todoId: TODO_ID,
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
      todoId: TODO_ID,
      action: 'execute',
      role: 'executor',
      attempt: 1,
      resume: false,
    });
    assert.strictEqual(executeResult.ok, true, 'execute dispatch succeeded');
    assert.strictEqual(await stateOf(h), 'executed', 'todo transitioned to executed');
    const executeArtifact = path.join(
      h.repo, '.baiton', 'specs', SLUG, 'todos', TODO_ID, 'execute-1.md',
    );
    assert.ok(
      fs.existsSync(executeArtifact),
      "execute-1.md persisted under the todo's folder",
    );

    // Exactly one execute commit with the expected message.
    const executeSubject = `spec(${SLUG}): ${TODO_ID} execute attempt 1`;
    const todoBranch = todoBranchFor(SLUG, TODO_ID);
    const todoSubjects = git(h.repo, 'log', '--format=%s', todoBranch).split('\n');
    assert.strictEqual(
      todoSubjects.filter((s) => s === executeSubject).length,
      1,
      'exactly one execute commit landed on the todo branch',
    );
    assert.strictEqual(
      commitSubjects(h.repo).filter((s) => s === executeSubject).length,
      0,
      'the spec branch has no execute commit before landing',
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
      todoId: TODO_ID,
      action: 'review',
      role: 'reviewer',
      attempt: 1,
      resume: false,
    });
    assert.strictEqual(reviewResult.ok, true, 'review dispatch succeeded');
    assert.strictEqual(await stateOf(h), 'done', 'todo transitioned to done on a pass verdict');
    const reviewArtifact = path.join(
      h.repo, '.baiton', 'specs', SLUG, 'todos', TODO_ID, 'review-1.md',
    );
    assert.ok(
      fs.existsSync(reviewArtifact),
      "review-1.md persisted under the todo's folder",
    );
    // The non-executor post-run reset ran but left the gitignored file (Req 15.5).
    assert.ok(fs.existsSync(scratchAbs), 'gitignored scratch file survived the post-run reset');
    assert.strictEqual(fs.readFileSync(scratchAbs, 'utf8'), 'keep me\n', 'its contents are intact');

    // -- Land the todo into the spec branch ---------------------------------
    const landed = await h.writer.apply(SLUG, () =>
      landTodoWorktree({ workspaceRoot: h.repo, git: h.git }, { slug: SLUG, todoId: TODO_ID }),
    );
    assert.ok(landed.ok, `land succeeded: ${JSON.stringify(landed)}`);
    assert.ok(
      readRepoFile(h.repo, 'src/greeting.ts').includes('hello'),
      'the main checkout now has the executor change',
    );
    assert.strictEqual(git(h.repo, 'branch', '--list', todoBranch).trim(), '', 'the todo branch is gone');
    assert.ok(!fs.existsSync(wt), 'the worktree is gone');
    assert.strictEqual(commitSubjects(h.repo)[0], `spec(${SLUG}): land ${TODO_ID}`);
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

    await approveSpec(h);

    // First Plan dispatch: the terminal closes before a result, so the stage
    // halts with `closed` and the todo reverts to its From_State (`pending`).
    const firstPlan = await h.queue.dispatch({
      slug: SLUG,
      todoId: TODO_ID,
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
    assert.strictEqual(await stateOf(h), 'pending', 'todo reverted to pending, its From_State');
    assert.ok(
      fs.existsSync(todoWorktreeDirFor(h.repo, SLUG, TODO_ID)),
      'a failed stage never removes the worktree',
    );
    const subjects = commitSubjects(h.repo);
    assert.ok(
      subjects.some((s) => s === `spec(${SLUG}): ${TODO_ID} pending (closed (exit 1))`),
      'the revert commit names the closed exit code',
    );

    // Plan succeeds on the next dispatch against the same (reverted) todo.
    const secondPlan = await h.queue.dispatch({
      slug: SLUG,
      todoId: TODO_ID,
      action: 'plan',
      role: 'planner',
      attempt: 1,
      resume: false,
    });
    assert.strictEqual(secondPlan.ok, true, 'plan succeeds once retried');
    assert.strictEqual(await stateOf(h), 'planned', 'todo transitioned to planned on retry');
    assert.ok(fs.existsSync(todoWorktreeDirFor(h.repo, SLUG, TODO_ID)), 'the retry reused the worktree');
  });

  it('replays a lost state write on crash recovery when the Run-Id commit landed (Req 21.5)', async () => {
    const h = harness();
    await approveSpec(h);

    // Wedge the todo into a running state and land an execute commit carrying
    // the crash run's Run-Id trailer, but journal ONLY the START record — the
    // shape a crash leaves behind (a result-less entry whose work landed).
    const crashRunId = 'crash-run-replay-01';
    assert.strictEqual(await h.store.writeState(SLUG, TODO_ID, 'executing'), true);
    writeRepoFile(h.repo, 'src/greeting.ts', 'export const version = 2;\nexport const hello = () => "hi";\n');
    await h.git.commit(`spec(${SLUG}): ${TODO_ID} execute attempt 1`, { 'Run-Id': crashRunId });
    appendStart(h.journalPath, {
      runId: crashRunId,
      todoId: TODO_ID,
      stage: 'execute',
      attempt: 1,
      startHead: await h.git.head(),
      inputRev: await h.store.inputRev(SLUG, TODO_ID),
      terminalPid: 999999, // a dead pid
    });

    // Sanity: the journal entry is result-less before recovery, and the todo is
    // wedged in `executing`.
    const beforeEntry = parseJournal(h.journalPath).find((e) => e.runId === crashRunId);
    assert.ok(beforeEntry && beforeEntry.result === undefined, 'the crash entry is result-less');
    assert.strictEqual(await stateOf(h), 'executing', 'todo is wedged in executing before recovery');

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
      specStore: h.store,
    });
    const replayed = outcomes.find((o) => o.runId === crashRunId);
    assert.ok(replayed, 'recovery produced an outcome for the crash run');
    assert.strictEqual(replayed!.action, 'replayed-state', 'the lost state write was replayed (Req 21.5)');
    assert.strictEqual(
      replayed!.commit,
      await h.git.findCommitByRunId(crashRunId),
      'recovery reported the landed Run-Id commit',
    );
    // The todo is no longer wedged: recovery replayed the execute success state.
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
                { id: 'call_1', type: 'function', function: { name: 'read_spec', arguments: '{"slug":"demo"}' } },
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
          name: 'read_spec',
          description: 'Read a spec',
          parameters: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
        },
      ];
      const messages: ChatMessage[] = [{ role: 'user', content: 'read the demo spec' }];
      const result = await client.complete({ messages, tools, signal: new AbortController().signal });

      // The tools array went out on the wire as an OpenAI function tool.
      const sent = mock.captured[0].body as {
        tools?: Array<{ type: string; function: { name: string } }>;
      };
      assert.strictEqual(mock.captured[0].authorization, 'Bearer stub-key');
      assert.ok(Array.isArray(sent.tools) && sent.tools.length === 1, 'tools array sent on the wire');
      assert.strictEqual(sent.tools![0].function.name, 'read_spec', 'the tool round-tripped by name');
      // The tool_calls round-tripped back into the parsed result.
      assert.deepStrictEqual(result.tool_calls, [
        { id: 'call_1', name: 'read_spec', arguments: '{"slug":"demo"}' },
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
