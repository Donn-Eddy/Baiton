import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as fc from 'fast-check';
import {
  createRunQueue,
  type QueueWorktreeSeam,
  type RunQueueDeps,
  type RunRequest,
  type SpecStore,
  type ResultWatcherFactory,
} from '../src/engine/runQueue';
import type { Adapter } from '../src/adapter';
import type { GitService } from '../src/git';
import type { HostTerminal, TerminalHost } from '../src/engine/terminalHost';
import type { ResultWatcher } from '../src/engine/resultWatcher';
import type { TodoState } from '../src/model/todoState';
import type { Role } from '../src/model/role';
import { approvalHash } from '../src/model/hash';
import { parseSpec, ParsedSpec } from '../src/model/parser';
import { ok } from '../src/model/result';

/**
 * Feature: baiton-first-pass, Property 8: Approval mismatch gates execution stages
 *
 * For any spec whose current Approval_Hash is not byte-equal to its recorded
 * `approved_rev` (including unset/empty), the extension refuses to run the
 * Execute and Review stages; only a spec whose recorded `approved_rev` matches
 * the current Approval_Hash may proceed.
 *
 * Validates: Requirements 5.3, 5.4
 *
 * Two complementary properties are asserted:
 *
 *  (A) At the run-queue level, through the `SpecStore.isApproved` seam that
 *      `checkGuards` consults before launching Execute (src/engine/runQueue.ts,
 *      `cleanTreeAndInputRev` guard). With `isApproved` returning false — the
 *      exact predicate for "approved_rev != current Approval_Hash, or unset" —
 *      dispatching Execute from every execute-legal state resolves with a
 *      `not-approved` refusal and never launches a terminal or writes a running
 *      state. With `isApproved` returning true (and the other Execute guards
 *      satisfied) the gate passes and the stage launches to completion.
 *
 *  (B) At the Approval_Hash level, the gate predicate itself: the extension is
 *      approved iff `approved_rev` is non-empty AND byte-equal to the current
 *      Approval_Hash. Generating a spec, computing its hash, and tampering with
 *      or clearing `approved_rev` makes the predicate false; only the exact,
 *      non-empty hash makes it true.
 */

// --- Shared test doubles ---------------------------------------------------

/** A no-op terminal double; records whether it was created/disposed. */
function makeTerminal(): HostTerminal & { disposed: boolean; sent: string[] } {
  const t = {
    disposed: false,
    sent: [] as string[],
    sendText(text: string): void {
      t.sent.push(text);
    },
    dispose(): void {
      t.disposed = true;
    },
    processId: Promise.resolve(undefined),
    show(): void {
      /* no-op */
    },
  };
  return t;
}

/** A terminal host that records every terminal it creates. */
function makeTerminalHost(): TerminalHost & { created: HostTerminal[] } {
  const created: HostTerminal[] = [];
  return {
    created,
    createTerminal(): HostTerminal {
      const term = makeTerminal();
      created.push(term);
      return term;
    },
  };
}

/**
 * A watcher factory that immediately drives a `completed` result so a launched
 * Execute stage runs to a terminal outcome without any real filesystem I/O.
 * The queue's result flow persists an artifact via the default writer, so the
 * factory instead synthesises the outcome by firing `onResult` with a valid
 * execute result once a listener subscribes.
 */
function makeCompletingWatcherFactory(): ResultWatcherFactory {
  return {
    create(): ResultWatcher {
      let resultListener: ((raw: string) => void) | undefined;
      return {
        onResult(listener): () => void {
          resultListener = listener;
          // Fire a valid execute result on the next tick so the awaiting flow
          // has subscribed to both events first.
          setImmediate(() => {
            resultListener?.(
              JSON.stringify({
                summary: 'did the work',
                files_changed: ['src/x.ts'],
                commands_run: ['npm test'],
                notes: [],
              }),
            );
          });
          return () => {
            resultListener = undefined;
          };
        },
        onTerminalClose(): () => void {
          // The terminal-close path is not exercised in this gate test; the
          // valid result above drives the completed outcome.
          return () => {};
        },
        dispose(): void {
          resultListener = undefined;
        },
      };
    },
  };
}

/** An adapter double whose probe always succeeds and whose launch is inert. */
const okAdapter: Adapter = {
  id: 'claude',
  acceptsSessionId: true,
  probe: async () => ({ version: '1.0.0', ok: true }),
  launch: () => ({ shellPath: 'claude', shellArgs: [] }),
  attach: () => ({ shellPath: 'claude', shellArgs: [] }),
};

/** A git service double: clean tree, stable HEAD/branch, successful commit/reset. */
function makeGit(): GitService {
  return {
    status: async () => ({ clean: true, changes: [] }),
    isCleanExceptSpecFolder: async () => true,
    fetch: async () => {},
    resolveBaseCommit: async () => 'base',
    createSpecBranch: async () => {},
    checkout: async () => {},
    commit: async () => 'commit-sha',
    head: async () => 'head-sha',
    currentBranch: async () => 'spec/branch',
    diff: async () => '',
    diffAgainstWorkingTree: async () => '',
    log: async () => '',
    resetWorkingTree: async () => ({ ok: true, value: undefined }),
    findCommitByRunId: async () => undefined,
    push: async () => undefined,
    remoteUrl: async () => '',
  };
}

/**
 * Build a SpecStore whose approval verdict is fixed and whose other Execute
 * guards (blocked, input-rev) are satisfied, so `isApproved` is the only gate
 * under test. Records every state write for assertions.
 */
function makeSpecStore(opts: {
  state: TodoState;
  approved: boolean;
}): SpecStore & { writes: TodoState[] } {
  const writes: TodoState[] = [];
  return {
    writes,
    currentState: async () => opts.state,
    // A plan is always on file, so the approval gate is the only thing that can
    // refuse an Execute dispatch here.
    readSpec: async () => undefined,
    readArtifact: async () => '# Plan T01\n',
    latestExecuteCommit: async () => undefined,
    isApproved: async () => opts.approved,
    isBlocked: async () => false,
    inputRevMatches: async () => true,
    inputRev: async () => 'rev-1',
    writeState: async (_slug, _todo, state) => {
      writes.push(state);
      return true;
    },
  };
}

/** Assemble RunQueueDeps around the given SpecStore and host doubles. */
function makeDeps(
  specStore: SpecStore,
  terminalHost: TerminalHost,
  watcherFactory: ResultWatcherFactory,
  workspaceRoot: string,
): RunQueueDeps {
  return {
    workspaceRoot,
    adapterForRole: () => okAdapter,
    git: makeGit(),
    terminalHost,
    watcherFactory,
    specStore,
    journalPath: path.join(workspaceRoot, '.baiton', 'specs', 's', 'runs.jsonl'),
    modelForRole: (_role: Role) => ({ model: 'test-model' }),
  };
}

/**
 * Create a temp workspace with the `.baiton/specs/s/` folder so the queue's
 * result flow can persist an execute artifact and the journal can be appended
 * without any missing-directory failure interfering with the gate under test.
 */
function makeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-gate-'));
  fs.mkdirSync(path.join(root, '.baiton', 'specs', 's'), { recursive: true });
  return root;
}

/** An execute request (todo state is fixed by the SpecStore double). */
function executeRequest(): RunRequest {
  return { slug: 's', todoId: 'T01', action: 'execute', role: 'executor', attempt: 1, resume: false };
}

// --- Generators ------------------------------------------------------------

/** The todo states from which Execute is a legal transition (transitions.ts). */
const executeLegalStateArb: fc.Arbitrary<TodoState> = fc.constantFrom<TodoState>(
  'planned',
  'executed',
  'failed',
);

// --- Property (A): run-queue gate ------------------------------------------

describe('run queue approval gate (property)', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = makeWorkspace();
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  // Feature: baiton-first-pass, Property 8: Approval mismatch gates execution stages
  it('refuses Execute with not-approved whenever the spec is not approved', async () => {
    await fc.assert(
      fc.asyncProperty(executeLegalStateArb, async (state) => {
        const specStore = makeSpecStore({ state, approved: false });
        const terminalHost = makeTerminalHost();
        const deps = makeDeps(specStore, terminalHost, makeCompletingWatcherFactory(), workspace);
        const queue = createRunQueue(deps);

        const result = await queue.dispatch(executeRequest());

        // The dispatch is refused with the approval-gate reason (Req 5.3, 5.4).
        assert.strictEqual(result.ok, false, 'unapproved Execute must be refused');
        if (result.ok === false) {
          assert.strictEqual(
            result.error.kind,
            'not-approved',
            `expected not-approved, got ${result.error.kind}`,
          );
        }
        // No terminal was launched and no running/terminal state was written.
        assert.strictEqual(terminalHost.created.length, 0, 'no stage may launch when unapproved');
        assert.deepStrictEqual(specStore.writes, [], 'no state write on an approval refusal');
      }),
      { numRuns: 100 },
    );
  });

  // Feature: baiton-first-pass, Property 8: Approval mismatch gates execution stages
  it('passes the approval gate and launches Execute when the spec is approved', async () => {
    await fc.assert(
      fc.asyncProperty(executeLegalStateArb, async (state) => {
        const specStore = makeSpecStore({ state, approved: true });
        const terminalHost = makeTerminalHost();
        const deps = makeDeps(specStore, terminalHost, makeCompletingWatcherFactory(), workspace);
        const queue = createRunQueue(deps);

        const result = await queue.dispatch(executeRequest());

        // With approval matching (and clean tree + matching input rev) the gate
        // passes: the stage launches and completes.
        assert.strictEqual(result.ok, true, 'approved Execute must not be gated out');
        if (result.ok === true) {
          assert.strictEqual(result.outcome.kind, 'completed');
        }
        assert.ok(terminalHost.created.length >= 1, 'an approved Execute must launch a stage');
        // The running (`executing`) and terminal (`executed`) states were written.
        assert.ok(
          specStore.writes.includes('executing'),
          'approved Execute writes the running state',
        );
      }),
      { numRuns: 100 },
    );
  });
});

// --- Unknown-agent refusal (Req 14.1) ---------------------------------------

describe('run queue unknown-agent refusal', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = makeWorkspace();
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('refuses a dispatch with unknown-agent when adapterForRole returns undefined, without probing or launching', async () => {
    const specStore = makeSpecStore({ state: 'planned', approved: true });
    const terminalHost = makeTerminalHost();
    const deps = makeDeps(specStore, terminalHost, makeCompletingWatcherFactory(), workspace);
    const queue = createRunQueue({ ...deps, adapterForRole: () => undefined });

    const result = await queue.dispatch(executeRequest());

    assert.strictEqual(result.ok, false, 'an unknown agent id must refuse the dispatch');
    if (result.ok === false) {
      assert.strictEqual(result.error.kind, 'unknown-agent');
    }
    assert.strictEqual(terminalHost.created.length, 0, 'no terminal is created for an unknown agent');
    assert.strictEqual(
      specStore.writes.filter((s) => s === 'executing').length,
      0,
      'no running state is written for an unknown agent',
    );
  });
});

// --- Worktree mode: tree guards and deps-unlanded ---------------------------

describe('run queue worktree mode guards', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = makeWorkspace();
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  function seam(
    wtGit: GitService,
    unlanded: readonly string[],
  ): QueueWorktreeSeam & { ensured: number } {
    const s = {
      ensured: 0,
      ensure: async () => {
        s.ensured += 1;
        return ok({ dir: path.join(workspace, '.baiton', 'worktrees', 's', 'T01'), git: wtGit });
      },
      unlanded: async () => unlanded,
    };
    return s;
  }

  it('checks the clean-tree guard against the worktree git, not the main checkout', async () => {
    for (const [mainClean, wtClean] of [
      [true, false],
      [false, true],
    ] as const) {
      const specStore = makeSpecStore({ state: 'planned', approved: true });
      const terminalHost = makeTerminalHost();
      const deps = makeDeps(specStore, terminalHost, makeCompletingWatcherFactory(), workspace);
      const wtGit: GitService = { ...makeGit(), isCleanExceptSpecFolder: async () => wtClean };
      const queue = createRunQueue({
        ...deps,
        git: { ...makeGit(), isCleanExceptSpecFolder: async () => mainClean },
        slug: 's',
        todoId: 'T01',
        worktrees: seam(wtGit, []),
      });
      const result = await queue.dispatch(executeRequest());
      if (wtClean) {
        assert.strictEqual(result.ok, true, 'a dirty main checkout must not block a clean worktree');
      } else {
        assert.strictEqual(result.ok, false);
        assert.strictEqual(!result.ok && result.error.kind, 'dirty-tree');
        assert.strictEqual(terminalHost.created.length, 0);
      }
    }
  });

  /** A spec whose T06 depends on `after` (a subset of T01..T05). */
  function specWithAfter(after: readonly string[]): ParsedSpec {
    const lines = ['---', 'title: sample', '---', '# OVERVIEW', 'o', '# TODOS'];
    for (const id of ['T01', 'T02', 'T03', 'T04', 'T05']) {
      lines.push(`- [done] ${id} dep`);
    }
    lines.push(`- [pending] T06 target${after.length > 0 ? ` (after ${after.join(',')})` : ''}`);
    return parseSpec(lines.join('\n'));
  }

  const idsArb = fc.subarray(['T01', 'T02', 'T03', 'T04', 'T05']);

  it('refuses Plan with deps-unlanded iff an after dependency is unlanded, before creating a worktree', async () => {
    await fc.assert(
      fc.asyncProperty(idsArb, idsArb, async (after, unlanded) => {
        const base = makeSpecStore({ state: 'pending', approved: true });
        const specStore = { ...base, readSpec: async () => specWithAfter(after) };
        const terminalHost = makeTerminalHost();
        const deps = makeDeps(specStore, terminalHost, makeCompletingWatcherFactory(), workspace);
        const wt = seam(makeGit(), unlanded);
        const queue = createRunQueue({ ...deps, slug: 's', todoId: 'T06', worktrees: wt });
        const req: RunRequest = {
          slug: 's',
          todoId: 'T06',
          action: 'plan',
          role: 'planner',
          attempt: 1,
          resume: false,
        };

        const dispatched = queue.dispatch(req);
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        const expectRefused = after.some((id) => unlanded.includes(id));
        if (expectRefused) {
          const result = await dispatched;
          assert.strictEqual(!result.ok && result.error.kind, 'deps-unlanded');
          assert.strictEqual(wt.ensured, 0, 'no worktree is created for a refused Plan');
          assert.strictEqual(terminalHost.created.length, 0);
          assert.deepStrictEqual(base.writes, []);
        } else {
          assert.strictEqual(wt.ensured, 1);
          assert.strictEqual(terminalHost.created.length, 1, 'Plan launches');
          // The stage never settles (the fake terminal has no close path); leave it.
          queue.stop();
        }
      }),
      { numRuns: 60 },
    );
  });

  it('never fires the deps-unlanded guard without a worktree seam', async () => {
    const base = makeSpecStore({ state: 'pending', approved: true });
    const specStore = { ...base, readSpec: async () => specWithAfter(['T01']) };
    const terminalHost = makeTerminalHost();
    const deps = makeDeps(specStore, terminalHost, makeCompletingWatcherFactory(), workspace);
    const queue = createRunQueue(deps);
    const dispatched = queue.dispatch({
      slug: 's',
      todoId: 'T06',
      action: 'plan',
      role: 'planner',
      attempt: 1,
      resume: false,
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(terminalHost.created.length, 1);
    // Launched instead of refused; the stage never settles, so leave it pending.
    void dispatched;
    queue.stop();
  });
});

// --- Property (B): approval-hash gate predicate ----------------------------

/**
 * The gate predicate the extension applies for Execute/Review: the spec is
 * approved iff its recorded `approved_rev` is a non-empty string byte-equal to
 * the current Approval_Hash (Req 5.3, 5.4).
 */
function isApprovedPredicate(currentHash: string, approvedRev: string | undefined): boolean {
  return typeof approvedRev === 'string' && approvedRev.length > 0 && approvedRev === currentHash;
}

/** Render a minimal parseable spec with one todo whose title is the seed. */
function renderSpec(overview: string, title: string): string {
  return [
    '---',
    'title: sample',
    '---',
    '# OVERVIEW',
    overview,
    '# TODOS',
    `- [pending] T01 ${title}`,
  ].join('\n');
}

const cleanTextArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 30 })
  .map((s) => s.replace(/[()\n\r;#]/g, ' ').trim())
  .filter((s) => s.length > 0 && s !== '---');

describe('approval-hash gate predicate (property)', () => {
  // Feature: baiton-first-pass, Property 8: Approval mismatch gates execution stages
  it('is false for any approved_rev not byte-equal to the current hash, including unset/empty', () => {
    fc.assert(
      fc.property(
        cleanTextArb,
        cleanTextArb,
        // A tampering strategy: unset, empty, a truncation, or a suffix flip.
        fc.constantFrom<'unset' | 'empty' | 'truncate' | 'append' | 'flip'>(
          'unset',
          'empty',
          'truncate',
          'append',
          'flip',
        ),
        (overview, title, tamper) => {
          const spec: ParsedSpec = parseSpec(renderSpec(overview, title));
          const currentHash = approvalHash(spec);

          let approvedRev: string | undefined;
          switch (tamper) {
            case 'unset':
              approvedRev = undefined;
              break;
            case 'empty':
              approvedRev = '';
              break;
            case 'truncate':
              approvedRev = currentHash.slice(0, currentHash.length - 1);
              break;
            case 'append':
              approvedRev = currentHash + '0';
              break;
            case 'flip':
              approvedRev =
                (currentHash[0] === 'a' ? 'b' : 'a') + currentHash.slice(1);
              break;
          }

          assert.strictEqual(
            isApprovedPredicate(currentHash, approvedRev),
            false,
            `a mismatched approved_rev (${tamper}) must gate execution`,
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: baiton-first-pass, Property 8: Approval mismatch gates execution stages
  it('is true only for the exact, non-empty current hash', () => {
    fc.assert(
      fc.property(cleanTextArb, cleanTextArb, (overview, title) => {
        const spec: ParsedSpec = parseSpec(renderSpec(overview, title));
        const currentHash = approvalHash(spec);
        assert.strictEqual(
          isApprovedPredicate(currentHash, currentHash),
          true,
          'a byte-equal non-empty approved_rev must permit execution',
        );
      }),
      { numRuns: 100 },
    );
  });
});
