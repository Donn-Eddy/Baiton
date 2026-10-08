import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { Adapter } from '../src/adapter';
import { GITIGNORE_CONTENTS } from '../src/config/gitignore';
import {
  createQueueWorktreeSeam,
  createRunQueue,
  type DispatchResult,
  type RunQueue,
  type RunRequest,
  type SpecStore,
} from '../src/engine/runQueue';
import type { ResultWatcher } from '../src/engine/resultWatcher';
import { createSpecBranchWriter } from '../src/engine/specBranchWriter';
import type { HostTerminal, TerminalHost } from '../src/engine/terminalHost';
import {
  createTodoWorktree,
  landTodoWorktree,
  todoBranchFor,
  todoWorktreeDirFor,
} from '../src/engine/todoWorktree';
import { createGitService } from '../src/git/gitService';
import { readSpecJournal, todoJournalPathFor } from '../src/journal';
import { parseSpec } from '../src/model/parser';
import type { Role } from '../src/model/role';
import type { Stage } from '../src/model/stage';
import type { TodoState } from '../src/model/todoState';

/**
 * The run queue in per-todo worktree mode, against a real temporary git
 * repository: two todos' queues run their stages concurrently, each committing
 * only on its own todo branch, while artifacts, state and journals stay in the
 * main checkout's spec folder (written through the spec-branch writer).
 */

const SLUG = 'demo';

const SPEC_TEXT = [
  '---',
  'title: demo',
  '---',
  '# OVERVIEW',
  '',
  'Build the thing.',
  '',
  '# TODOS',
  '- [planned] T01 First todo',
  '- [planned] T02 Second todo',
  '- [pending] T03 Third todo (after T01)',
  '',
].join('\n');

const EXECUTE_RESULT = JSON.stringify({
  summary: 'did it',
  files_changed: [],
  commands_run: [],
  notes: [],
});
const REVIEW_RESULT = JSON.stringify({
  verdict: 'pass',
  findings: [],
  tests: { ran: true, passed: true, output_tail: 'ok' },
});
const PLAN_RESULT = JSON.stringify({
  steps: [{ title: 'step', detail: 'do it', files: [] }],
  risks: [],
  acceptance: ['done'],
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function writeFile(root: string, rel: string, contents: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
}

/** A temp repo on `baiton/demo` with the Baiton gitignore, a spec and a base file committed. */
function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-rqwt-'));
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.name', 'Baiton Test');
  git(repo, 'config', 'user.email', 'baiton-test@example.com');
  git(repo, 'checkout', '-q', '-b', 'main');
  writeFile(repo, '.baiton/.gitignore', GITIGNORE_CONTENTS);
  writeFile(repo, `.baiton/specs/${SLUG}/spec.md`, SPEC_TEXT);
  writeFile(repo, 'src/base.txt', 'base\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'initial commit');
  git(repo, 'checkout', '-q', '-b', `baiton/${SLUG}`);
  return repo;
}

/** A driveable running stage. */
interface DrivenStage {
  runId: string;
  cwd: string | undefined;
  complete(resultJson: string): void;
  cancel(): void;
}

interface Rig {
  repo: string;
  specsDir: string;
  states: Map<string, TodoState>;
  stages: DrivenStage[];
  created: Array<string | undefined>;
  queueFor(todoId: string): RunQueue;
  dispatch(todoId: string, action: RunRequest['action'], role: Role, attempt?: number): Promise<DispatchResult>;
}

function makeRig(repo: string, initial: Record<string, TodoState>): Rig {
  const specsDir = path.join(repo, '.baiton', 'specs');
  const mainGit = createGitService(repo);
  const writer = createSpecBranchWriter({ specsDir, git: mainGit });
  const states = new Map<string, TodoState>(Object.entries(initial));
  const stages: DrivenStage[] = [];
  const created: Array<string | undefined> = [];

  const artifactDir = (todoId: string): string => path.join(specsDir, SLUG, 'todos', todoId);
  const latest = (todoId: string, stage: Stage): string | undefined => {
    let names: string[] = [];
    try {
      names = fs.readdirSync(artifactDir(todoId)).filter((n) => n.startsWith(`${stage}-`));
    } catch {
      return undefined;
    }
    names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const last = names[names.length - 1];
    return last === undefined ? undefined : fs.readFileSync(path.join(artifactDir(todoId), last), 'utf8');
  };

  const specStore: SpecStore = {
    currentState: async (_slug, todoId) => states.get(todoId),
    readSpec: async () => parseSpec(SPEC_TEXT),
    readArtifact: async (_slug, todoId, stage) => (stage === 'plan' ? '# Plan\n' : latest(todoId, stage)),
    latestExecuteCommit: async () => undefined,
    persistArtifact: (slug, artifactPath, contents) =>
      writer.apply(slug, () => {
        fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
        fs.writeFileSync(artifactPath, contents);
      }),
    isApproved: async () => true,
    isBlocked: async () => false,
    inputRevMatches: async () => true,
    inputRev: async () => 'rev0',
    writeState: async (_slug, todoId, state) => {
      states.set(todoId, state);
      return true;
    },
  };

  class FakeTerminal implements HostTerminal {
    disposed = false;
    onDispose?: () => void;
    constructor(readonly cwd: string | undefined) {}
    sendText(): void {}
    show(): void {}
    dispose(): void {
      if (!this.disposed) {
        this.disposed = true;
        this.onDispose?.();
      }
    }
    get processId(): Promise<number | undefined> {
      return Promise.resolve(undefined);
    }
  }
  const terminalHost: TerminalHost = {
    createTerminal(options): HostTerminal {
      created.push(options.cwd);
      return new FakeTerminal(options.cwd);
    },
  };

  const watcherFactory = {
    create(input: { runId: string; terminal: HostTerminal }): ResultWatcher {
      const terminal = input.terminal as FakeTerminal;
      let resultListeners: Array<(raw: string) => void> = [];
      let closeListeners: Array<(code: number | undefined) => void> = [];
      let settled = false;
      terminal.onDispose = (): void => {
        setImmediate(() => {
          if (settled) {
            return;
          }
          settled = true;
          for (const l of [...closeListeners]) {
            l(undefined);
          }
        });
      };
      stages.push({
        runId: input.runId,
        cwd: terminal.cwd,
        complete: (json) => {
          for (const l of [...resultListeners]) {
            l(json);
          }
        },
        cancel: () => terminal.dispose(),
      });
      return {
        onResult(l): () => void {
          resultListeners.push(l);
          return () => {
            resultListeners = resultListeners.filter((x) => x !== l);
          };
        },
        onTerminalClose(l): () => void {
          closeListeners.push(l);
          return () => {
            closeListeners = closeListeners.filter((x) => x !== l);
          };
        },
        dispose(): void {
          settled = true;
        },
      };
    },
  };

  const adapter: Adapter = {
    id: 'claude',
    acceptsSessionId: true,
    probe: async () => ({ version: 'test', ok: true }),
    launch: () => ({ shellPath: 'claude', shellArgs: [] }),
    attach: () => ({ shellPath: 'claude', shellArgs: [] }),
  };

  const worktrees = createQueueWorktreeSeam({ workspaceRoot: repo, git: mainGit, writer });
  let counter = 0;
  const queues = new Map<string, RunQueue>();
  const queueFor = (todoId: string): RunQueue => {
    let q = queues.get(todoId);
    if (q === undefined) {
      q = createRunQueue({
        workspaceRoot: repo,
        git: mainGit,
        slug: SLUG,
        todoId,
        worktrees,
        specWriter: writer,
        terminalHost,
        watcherFactory,
        specStore,
        journalPath: path.join(specsDir, SLUG, 'runs.jsonl'),
        journalPathFor: (id) => todoJournalPathFor(specsDir, SLUG, id),
        readJournal: () => readSpecJournal(specsDir, SLUG),
        modelForRole: () => ({ model: 'test-model' }),
        adapterForRole: () => adapter,
        newRunId: (req) => `run-${req.todoId}-${req.action}-${req.attempt}-${counter++}`,
      });
      queues.set(todoId, q);
    }
    return q;
  };

  return {
    repo,
    specsDir,
    states,
    stages,
    created,
    queueFor,
    dispatch: (todoId, action, role, attempt = 1) =>
      queueFor(todoId).dispatch({ slug: SLUG, todoId, action, role, attempt, resume: false }),
  };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Wait until `pred` holds (real git calls take several ticks). */
async function until(pred: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (pred()) {
      return;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail(`timed out waiting for ${what}`);
}

describe('run queue per-todo worktrees (real repo)', () => {
  const repos: string[] = [];

  function newRepo(): string {
    const r = makeRepo();
    repos.push(r);
    return r;
  }

  afterEach(() => {
    while (repos.length > 0) {
      const r = repos.pop() as string;
      try {
        git(r, 'worktree', 'prune');
      } catch {
        /* best effort */
      }
      fs.rmSync(r, { recursive: true, force: true });
    }
  });

  it('runs two todos concurrently, each committing only on its own todo branch', async () => {
    const repo = newRepo();
    const rig = makeRig(repo, { T01: 'planned', T02: 'planned' });
    const mainHeadBefore = git(repo, 'rev-parse', 'HEAD').trim();

    const a = rig.dispatch('T01', 'execute', 'executor');
    const b = rig.dispatch('T02', 'execute', 'executor');
    await until(() => rig.stages.length === 2, 'both stages to launch');

    assert.ok(rig.queueFor('T01').isRunning() && rig.queueFor('T02').isRunning(), 'both in flight');
    const wt1 = todoWorktreeDirFor(repo, SLUG, 'T01');
    const wt2 = todoWorktreeDirFor(repo, SLUG, 'T02');
    assert.deepStrictEqual([...rig.created].sort(), [wt1, wt2].sort());
    assert.strictEqual(rig.queueFor('T01').currentRun()?.worktreeDir, wt1);
    const registered = git(repo, 'worktree', 'list', '--porcelain');
    for (const [dir, id] of [
      [wt1, 'T01'],
      [wt2, 'T02'],
    ]) {
      assert.ok(fs.existsSync(dir));
      assert.ok(registered.includes(`branch refs/heads/${todoBranchFor(SLUG, id)}`));
    }

    const stageFor = (dir: string): DrivenStage => rig.stages.find((s) => s.cwd === dir) as DrivenStage;
    writeFile(wt1, 'src/t01.txt', 'one\n');
    writeFile(wt2, 'src/t02.txt', 'two\n');
    stageFor(wt2).complete(EXECUTE_RESULT);
    const rb = await b;
    stageFor(wt1).complete(EXECUTE_RESULT);
    const ra = await a;

    assert.ok(ra.ok && ra.outcome.kind === 'completed');
    assert.ok(rb.ok && rb.outcome.kind === 'completed');

    for (const [id, file, other] of [
      ['T01', 'src/t01.txt', 'src/t02.txt'],
      ['T02', 'src/t02.txt', 'src/t01.txt'],
    ]) {
      const branch = todoBranchFor(SLUG, id);
      const runId = (rig.stages.find((s) => s.runId.startsWith(`run-${id}-`)) as DrivenStage).runId;
      const body = git(repo, 'log', '-1', '--format=%B', branch);
      assert.ok(body.startsWith(`spec(${SLUG}): ${id} execute attempt 1`), body);
      assert.ok(body.includes(`Run-Id: ${runId}`), body);
      const files = git(repo, 'show', '--name-only', '--format=', branch).trim().split('\n');
      assert.deepStrictEqual(files, [file], `${id} commit holds only its own file (not ${other})`);

      assert.ok(fs.existsSync(path.join(rig.specsDir, SLUG, 'todos', id, 'execute-1.md')));
      const sha = git(repo, 'rev-parse', branch).trim();
      const records = fs
        .readFileSync(todoJournalPathFor(rig.specsDir, SLUG, id), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { runId?: string; commit?: string; result?: string; stage?: string });
      assert.strictEqual(records.length, 2, 'start + completion records');
      assert.ok(records.every((r) => r.runId === runId));
      const completion = records.find((e) => e.result === 'completed');
      assert.strictEqual(completion?.commit, sha, 'completion carries the todo-branch commit');
      assert.strictEqual(rig.states.get(id), 'executed');
    }

    assert.strictEqual(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), `baiton/${SLUG}`);
    assert.strictEqual(git(repo, 'rev-parse', 'HEAD').trim(), mainHeadBefore, 'main HEAD got no execute commit');
    assert.ok(!fs.existsSync(path.join(repo, 'src/t01.txt')));
    assert.ok(!fs.existsSync(path.join(repo, 'src/t02.txt')));
  });

  it('reuses the worktree for a later stage and resets it after a completed review', async () => {
    const repo = newRepo();
    const rig = makeRig(repo, { T01: 'planned' });
    const wt = todoWorktreeDirFor(repo, SLUG, 'T01');

    const first = rig.dispatch('T01', 'execute', 'executor');
    await until(() => rig.stages.length === 1, 'execute to launch');
    writeFile(wt, 'src/t01.txt', 'one\n');
    rig.stages[0].complete(EXECUTE_RESULT);
    assert.ok((await first).ok);
    const executeCommit = git(wt, 'rev-parse', 'HEAD').trim();
    const worktreeAdds = git(repo, 'worktree', 'list', '--porcelain').split('worktree ').length;
    const mainStatusBefore = git(repo, 'status', '--porcelain');

    const review = rig.dispatch('T01', 'review', 'reviewer');
    await until(() => rig.stages.length === 2, 'review to launch');
    assert.strictEqual(rig.stages[1].cwd, wt, 'same worktree dir');
    assert.strictEqual(git(wt, 'rev-parse', 'HEAD').trim(), executeCommit, 'reuse does not reset history');
    assert.strictEqual(git(repo, 'worktree', 'list', '--porcelain').split('worktree ').length, worktreeAdds);
    writeFile(wt, 'scratch.txt', 'reviewer scratch\n');
    rig.stages[1].complete(REVIEW_RESULT);
    assert.ok((await review).ok);

    assert.ok(!fs.existsSync(path.join(wt, 'scratch.txt')) || git(wt, 'status', '--porcelain', '--', 'scratch.txt').trim() === '', 'scratch is reset');
    assert.ok(fs.existsSync(path.join(wt, 'src/t01.txt')), 'committed work survives the reset');
    assert.strictEqual(git(repo, 'status', '--porcelain').replace(/.*\.baiton\/specs.*\n?/g, ''), mainStatusBefore.replace(/.*\.baiton\/specs.*\n?/g, ''));
    assert.strictEqual(rig.states.get('T01'), 'done');
  });

  it('checks the clean-tree guard on the worktree, not the main checkout', async () => {
    const repo = newRepo();
    const rig = makeRig(repo, { T01: 'planned' });
    const wt = todoWorktreeDirFor(repo, SLUG, 'T01');
    // Create the worktree up front, then dirty a tracked file in it.
    const created = await createTodoWorktree({ workspaceRoot: repo, git: createGitService(repo) }, { slug: SLUG, todoId: 'T01' });
    assert.ok(created.ok);
    fs.appendFileSync(path.join(wt, 'src/base.txt'), 'dirty\n');

    const refused = await rig.dispatch('T01', 'execute', 'executor');
    assert.ok(!refused.ok && refused.error.kind === 'dirty-tree');
    assert.strictEqual(rig.stages.length, 0);

    git(wt, 'checkout', '--', 'src/base.txt');
    writeFile(repo, 'untracked-main.txt', 'main is dirty\n');
    const run = rig.dispatch('T01', 'execute', 'executor');
    await until(() => rig.stages.length === 1, 'execute to launch');
    writeFile(wt, 'src/t01.txt', 'one\n');
    rig.stages[0].complete(EXECUTE_RESULT);
    const result = await run;
    assert.ok(result.ok, 'a dirty main checkout does not block a clean worktree');
    assert.ok(!git(repo, 'show', '--name-only', '--format=', todoBranchFor(SLUG, 'T01')).includes('untracked-main.txt'));
  });

  it('refuses Plan while a dependency is unlanded and plans in a fresh worktree once it is landed', async () => {
    const repo = newRepo();
    const rig = makeRig(repo, { T01: 'done', T03: 'pending' });
    const deps = { workspaceRoot: repo, git: createGitService(repo) };
    const t01 = await createTodoWorktree(deps, { slug: SLUG, todoId: 'T01' });
    assert.ok(t01.ok);
    writeFile(t01.value.worktreeDir, 'src/t01.txt', 'one\n');
    git(t01.value.worktreeDir, 'add', '-A');
    git(t01.value.worktreeDir, 'commit', '-q', '-m', 'T01 work');

    const refused = await rig.dispatch('T03', 'plan', 'planner');
    assert.ok(!refused.ok && refused.error.kind === 'deps-unlanded', JSON.stringify(refused));
    assert.ok(!fs.existsSync(todoWorktreeDirFor(repo, SLUG, 'T03')), 'no worktree for a refused Plan');
    assert.strictEqual(rig.stages.length, 0);

    const landed = await landTodoWorktree(deps, { slug: SLUG, todoId: 'T01' });
    assert.ok(landed.ok, JSON.stringify(landed));

    const plan = rig.dispatch('T03', 'plan', 'planner');
    await until(() => rig.stages.length === 1, 'plan to launch');
    const wt3 = todoWorktreeDirFor(repo, SLUG, 'T03');
    assert.strictEqual(rig.stages[0].cwd, wt3);
    assert.ok(fs.existsSync(path.join(wt3, 'src/t01.txt')), "the new worktree contains T01's file");
    rig.stages[0].complete(PLAN_RESULT);
    assert.ok((await plan).ok);
    assert.ok(fs.existsSync(path.join(rig.specsDir, SLUG, 'todos', 'T03', 'plan.md')));
  });

  it('leaves the worktree and branch in place after a cancelled stage', async () => {
    const repo = newRepo();
    const rig = makeRig(repo, { T01: 'planned' });
    const run = rig.dispatch('T01', 'execute', 'executor');
    await until(() => rig.stages.length === 1, 'execute to launch');
    rig.queueFor('T01').stop();
    const result = await run;
    await tick();

    assert.ok(!result.ok && result.error.kind === 'outcome');
    assert.strictEqual(rig.states.get('T01'), 'planned', 'state reverted');
    assert.ok(fs.existsSync(todoWorktreeDirFor(repo, SLUG, 'T01')));
    assert.ok(git(repo, 'branch', '--list', todoBranchFor(SLUG, 'T01')).includes(todoBranchFor(SLUG, 'T01')));
  });
});
