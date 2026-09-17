import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  createRunQueue,
  type DispatchResult,
  type RunQueueDeps,
  type RunRequest,
  type ResultWatcherFactory,
  type SpecStore,
} from '../src/engine/runQueue';
import type { Adapter } from '../src/adapter';
import type { GitService } from '../src/git';
import type { HostTerminal, TerminalHost } from '../src/engine/terminalHost';
import type { ResultWatcher } from '../src/engine/resultWatcher';
import type { Stage } from '../src/model/stage';
import type { TodoState } from '../src/model/todoState';
import type { Role } from '../src/model/role';
import { parseSpec } from '../src/model/parser';
import { ok } from '../src/model/result';

/**
 * The run queue's Brief context wiring (Requirement 18.3, 11.3).
 *
 * The queue assembles each stage's Context section from the spec and the todo's
 * own artifacts and hands it to the launcher, which writes it into
 * `.baiton/runs/<run-id>/brief.md`. These tests read the brief off disk, which
 * is exactly what the sub-agent is told to read, and assert:
 *
 *   - Execute is briefed with the plan and the todo line, and with no OVERVIEW;
 *   - Plan is briefed with the OVERVIEW and carries no plan text;
 *   - Execute with no plan on file is refused as `launch-failed` before any
 *     state write, so the todo is left exactly as it was.
 */

const SLUG = 'demo';
const TODO_ID = 'T02';
const PLAN_MARK = 'PLANMARK-T02';
const OVERVIEW_MARK = 'OVERVIEWMARK';

const SPEC_TEXT = [
  '---',
  'title: demo',
  '---',
  '# OVERVIEW',
  '',
  `Build the thing ${OVERVIEW_MARK}.`,
  '',
  '# TODOS',
  '- [done] T01 First todo TODO-ONE',
  '- [planned] T02 Second todo TODO-TWO (after T01)',
  '',
].join('\n');

/** A schema-conformant execute result the fake sub-agent writes. */
const EXECUTE_RESULT = JSON.stringify({
  summary: 'did it',
  files_changed: [],
  commands_run: [],
  notes: [],
});

/** A schema-conformant plan result the fake sub-agent writes. */
const PLAN_RESULT = JSON.stringify({
  steps: [{ title: 'step', detail: 'do it', files: [] }],
  risks: [],
  acceptance: ['done'],
});

interface Rig {
  deps: RunQueueDeps;
  /** Every lifecycle state the queue wrote, in order. */
  writes: TodoState[];
  /** The brief path of the launched run, once one has launched. */
  briefPath: () => string | undefined;
  /** Whether any terminal was created at all. */
  terminalCount: () => number;
}

/**
 * Build a queue rig over a temp workspace. `artifacts` decides what the store
 * reports as on file for the todo, keyed by stage, so a test can run with or
 * without a plan; `state` is the todo's lifecycle state, which decides which
 * action is a legal transition.
 */
function makeRig(
  workspaceRoot: string,
  artifacts: Partial<Record<Stage, string>>,
  resultJson: string,
  state: TodoState = 'planned',
): Rig {
  const writes: TodoState[] = [];
  let briefPath: string | undefined;
  let terminalCount = 0;

  class FakeTerminal implements HostTerminal {
    disposed = false;
    sendText(): void {
      /* inert */
    }
    show(): void {
      /* inert */
    }
    dispose(): void {
      this.disposed = true;
    }
    get processId(): Promise<number | undefined> {
      return Promise.resolve(undefined);
    }
  }

  const terminalHost: TerminalHost = {
    createTerminal(): HostTerminal {
      terminalCount += 1;
      return new FakeTerminal();
    },
  };

  // The sub-agent is faked by emitting a valid result as soon as the watcher is
  // created; the run directory (and its brief) already exists by then.
  const watcherFactory: ResultWatcherFactory = {
    create(input): ResultWatcher {
      briefPath = path.join(path.dirname(input.resultPath), 'brief.md');
      let resultListeners: Array<(raw: string) => void> = [];
      setImmediate(() => {
        for (const listener of [...resultListeners]) {
          listener(resultJson);
        }
      });
      return {
        onResult(listener): () => void {
          resultListeners.push(listener);
          return () => {
            resultListeners = resultListeners.filter((l) => l !== listener);
          };
        },
        onTerminalClose(): () => void {
          return () => {};
        },
        dispose(): void {
          resultListeners = [];
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

  const git: GitService = {
    status: async () => ({ clean: true, changes: [] }),
    isCleanExceptSpecFolder: async () => true,
    fetch: async () => {},
    resolveBaseCommit: async () => 'base',
    createSpecBranch: async () => {},
    checkout: async () => {},
    commit: async () => 'commitsha',
    head: async () => 'HEAD0',
    currentBranch: async () => 'spec-branch',
    diff: async () => '',
    diffAgainstWorkingTree: async () => '',
    log: async () => '',
    resetWorkingTree: async () => ok(undefined),
    findCommitByRunId: async () => undefined,
    push: async () => undefined,
    remoteUrl: async () => '',
  };

  const specStore: SpecStore = {
    currentState: async () => state,
    readSpec: async () => parseSpec(SPEC_TEXT),
    readArtifact: async (_slug, _todoId, stage) => artifacts[stage],
    latestExecuteCommit: async () => 'deadbee',
    isApproved: async () => true,
    isBlocked: async () => false,
    inputRevMatches: async () => true,
    inputRev: async () => 'rev0',
    writeState: async (_slug, _todoId, state) => {
      writes.push(state);
      return true;
    },
  };

  const deps: RunQueueDeps = {
    workspaceRoot,
    adapterForRole: () => adapter,
    git,
    terminalHost,
    watcherFactory,
    specStore,
    journalPath: path.join(workspaceRoot, '.baiton', 'specs', SLUG, 'runs.jsonl'),
    modelForRole: (_role: Role) => ({ model: 'test-model' }),
    report: () => {},
    newRunId: (req) => `run-${req.todoId}-${req.action}`,
    newSessionId: () => '11111111-1111-1111-1111-111111111111',
  };

  return {
    deps,
    writes,
    briefPath: () => briefPath,
    terminalCount: () => terminalCount,
  };
}

function request(action: 'plan' | 'execute', role: Role): RunRequest {
  return { slug: SLUG, todoId: TODO_ID, action, role, attempt: 1, resume: false };
}

describe('run queue brief context (Req 18.3, 11.3)', () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-brief-'));
    fs.mkdirSync(path.join(workspaceRoot, '.baiton', 'specs', SLUG), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it('briefs the executor with the plan and the todo line, and no OVERVIEW', async () => {
    const rig = makeRig(
      workspaceRoot,
      { plan: `# Plan T02\n\n${PLAN_MARK}\n` },
      EXECUTE_RESULT,
    );
    const queue = createRunQueue(rig.deps);

    const result = await queue.dispatch(request('execute', 'executor'));
    assert.ok(result.ok, 'the execute dispatch ran');

    const briefPath = rig.briefPath();
    assert.ok(briefPath !== undefined && fs.existsSync(briefPath), 'a brief was written');
    const brief = fs.readFileSync(briefPath as string, 'utf8');

    assert.ok(brief.includes('# Context'), 'the brief carries a Context section');
    assert.ok(brief.includes(PLAN_MARK), 'the executor is given the plan text');
    assert.ok(brief.includes('TODO-TWO'), 'the executor is given its own todo line');
    assert.ok(!brief.includes(OVERVIEW_MARK), 'the executor is not given the OVERVIEW');
    assert.ok(!brief.includes('TODO-ONE'), "the executor is not given another todo's line");
  });

  it('briefs the planner with the OVERVIEW and no plan text', async () => {
    const rig = makeRig(
      workspaceRoot,
      // A stale plan from an earlier round is on file; the planner must not be
      // handed it back.
      { plan: `# Plan T02\n\n${PLAN_MARK}\n` },
      PLAN_RESULT,
      'pending',
    );
    const queue = createRunQueue(rig.deps);

    const result = await queue.dispatch(request('plan', 'planner'));
    assert.ok(result.ok, 'the plan dispatch ran');

    const brief = fs.readFileSync(rig.briefPath() as string, 'utf8');
    assert.ok(brief.includes(OVERVIEW_MARK), 'the planner is given the OVERVIEW');
    assert.ok(brief.includes('TODO-TWO'), 'the planner is given its todo line');
    assert.ok(
      !brief.includes(PLAN_MARK),
      'the planner is never handed the previous plan for the same todo',
    );
  });

  it('refuses Execute with no plan on file and leaves the todo untouched', async () => {
    const rig = makeRig(workspaceRoot, {}, EXECUTE_RESULT);
    const queue = createRunQueue(rig.deps);

    const result: DispatchResult = await queue.dispatch(request('execute', 'executor'));

    assert.strictEqual(result.ok, false, 'the dispatch was refused');
    if (result.ok) {
      return;
    }
    assert.strictEqual(result.error.kind, 'launch-failed');
    assert.ok(
      result.error.message.includes(`no plan on file for "${TODO_ID}"`),
      `the refusal names the todo: ${result.error.message}`,
    );
    assert.ok(
      result.error.message.includes('run Plan first'),
      'the refusal says what to do about it',
    );
    assert.deepStrictEqual(rig.writes, [], 'no lifecycle state was written');
    assert.strictEqual(rig.terminalCount(), 0, 'no sub-agent was launched');
    assert.strictEqual(rig.briefPath(), undefined, 'no brief was written');
  });

  it('persists the execute artifact under the todo folder', async () => {
    const rig = makeRig(
      workspaceRoot,
      { plan: `# Plan T02\n\n${PLAN_MARK}\n` },
      EXECUTE_RESULT,
    );
    const queue = createRunQueue(rig.deps);

    await queue.dispatch(request('execute', 'executor'));

    const artifact = path.join(
      workspaceRoot, '.baiton', 'specs', SLUG, 'todos', TODO_ID, 'execute-1.md',
    );
    assert.ok(fs.existsSync(artifact), "the artifact landed in the todo's own folder");
    assert.ok(
      fs.readFileSync(artifact, 'utf8').startsWith(`# Execute ${TODO_ID}`),
      'the artifact is the rendered markdown, not a JSON dump',
    );
  });
});
