import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createToolRegistry } from '../src/orchestrator/registry';
import {
  GuardContext,
  ORCHESTRATOR_PHASES,
  OrchestratorPhase,
} from '../src/orchestrator/guard';
import { ToolServices } from '../src/orchestrator/toolServices';
import { createRunQueueSeam } from '../src/activation/engineFacade';
import type { DispatchResult, RunQueue, RunRequest } from '../src/engine';
import { GitService, GitStatus } from '../src/git';
import { Result, ok } from '../src/model/result';
import {
  DraftSpecOutcome,
  DraftSpecRequest,
  RunDispatchOutcome,
  RunDispatchRequest,
  StartRunOutcome,
  StartRunRequest,
} from '../src/orchestrator/seams';
import type {
  InterventionAnswer,
  InterventionRequest,
  InterventionSeam,
} from '../src/orchestrator/interventions';

/**
 * Unit tests for the orchestrator tool registry and control tools (Task 13.8).
 *
 * Covers:
 *  - Tool presence: the registry advertises every read, spec-writing and
 *    control tool the design names (Req 9.1, 9.5, 9.6).
 *  - `approve_spec` confirmation and decline: the tool asks the confirm seam
 *    first (Req 10.1) and, on a decline, leaves the spec byte-for-byte
 *    unchanged and returns an error while touching no git (Req 10.2).
 *  - Phase scoping: each tool is advertised in exactly the orchestrator phases
 *    the design assigns it, and a call made in the wrong phase is refused
 *    before the tool runs, changing nothing (Req 11.1).
 *  - `run` stage rejection: the tool itself rejects `plan-review` (and the
 *    spec-scoped `pr`) before the run-queue seam is reached (Req 11.1).
 *  - `ask_user`: the question control tool forwards to the intervention seam,
 *    validates its arguments before the seam, maps answers and declines, and
 *    reports itself unavailable when no seam is wired.
 *
 * Every test builds the registry against a temp repo with a stub git and a
 * stub confirm seam, provides a valid idempotency `callId` for the one mutating
 * call, and drives calls through a {@link GuardContext} rooted at that repo so
 * path containment resolves. Temp dirs are cleaned up after each test.
 */

/** The complete tool surface the registry must advertise (Req 9.1, 9.5, 9.6, 10.1, 10.6). */
const EXPECTED_TOOLS = [
  // Read tools (Req 9.1)
  'list_specs',
  'read_spec',
  'list_files',
  'read_file',
  'search',
  'git_status',
  'git_diff',
  'git_log',
  // Spec-writing tools (Req 9.6)
  'update_overview',
  'add_todo',
  'edit_todo',
  'remove_todo',
  // Control tools (Req 10.1, 10.3)
  'ask_user',
  'draft_spec',
  'start_run',
  'investigate',
  'approve_spec',
  'run',
  'submit_pr',
];

/** A git stub whose every method throws, proving a code path touched no git. */
function throwingGit(): GitService {
  const boom = (name: string) => (): never => {
    throw new Error(`git.${name} must not be called on this path`);
  };
  return {
    status: boom('status'),
    isCleanExceptSpecFolder: boom('isCleanExceptSpecFolder'),
    fetch: boom('fetch'),
    resolveBaseCommit: boom('resolveBaseCommit'),
    createSpecBranch: boom('createSpecBranch'),
    checkout: boom('checkout'),
    commit: boom('commit'),
    head: boom('head'),
    currentBranch: boom('currentBranch'),
    diff: boom('diff'),
    diffAgainstWorkingTree: boom('diffAgainstWorkingTree'),
    log: boom('log'),
    resetWorkingTree: async (): Promise<Result<void, never>> => ok(undefined),
    findCommitByRunId: boom('findCommitByRunId'),
    push: async () => undefined,
    remoteUrl: async () => '',
  };
}

/** A benign git stub (used where a control tool is not expected to reach git). */
function benignGit(): GitService {
  return {
    status: async (): Promise<GitStatus> => ({ clean: true, changes: [] }),
    isCleanExceptSpecFolder: async () => true,
    fetch: async () => undefined,
    resolveBaseCommit: async () => '0'.repeat(40),
    createSpecBranch: async () => undefined,
    checkout: async () => undefined,
    commit: async () => 'a'.repeat(40),
    head: async () => 'a'.repeat(40),
    currentBranch: async () => 'main',
    diff: async () => '',
    diffAgainstWorkingTree: async () => '',
    log: async () => '',
    resetWorkingTree: async (): Promise<Result<void, never>> => ok(undefined),
    findCommitByRunId: async () => undefined,
    push: async () => undefined,
    remoteUrl: async () => '',
  };
}

/** A confirm seam that records its calls and answers a fixed verdict. */
function recordingConfirm(answer: boolean): {
  confirm: (message: string) => Promise<boolean>;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    confirm: async (message: string): Promise<boolean> => {
      calls.push(message);
      return answer;
    },
  };
}

/** An intervention seam that records the requests it received and answers a fixed answer. */
function recordingIntervention(answer: InterventionAnswer): {
  seam: InterventionSeam;
  calls: InterventionRequest[];
} {
  const calls: InterventionRequest[] = [];
  return {
    calls,
    seam: {
      ask: async (request: InterventionRequest): Promise<InterventionAnswer> => {
        calls.push(request);
        return answer;
      },
    },
  };
}

/** A run queue seam that is never expected to be dispatched into here. */
const noRunQueue = {
  dispatch: async (_req: RunDispatchRequest): Promise<RunDispatchOutcome> => ({
    kind: 'busy' as const,
  }),
};

/** A spec-draft seam that records the requests it received. */
function recordingDraft(
  outcome: DraftSpecOutcome = { kind: 'started', runId: 'draft-1' },
): { draft: (req: DraftSpecRequest) => Promise<DraftSpecOutcome>; calls: DraftSpecRequest[] } {
  const calls: DraftSpecRequest[] = [];
  return {
    calls,
    draft: async (req: DraftSpecRequest): Promise<DraftSpecOutcome> => {
      calls.push(req);
      return outcome;
    },
  };
}

/** A run-pipeline seam that records the requests it received. */
function spyingPipeline(
  outcome: StartRunOutcome = { kind: 'started', runId: 'run-1', branch: 'baiton/bug/run-1' },
): { start: (req: StartRunRequest) => Promise<StartRunOutcome>; calls: StartRunRequest[] } {
  const calls: StartRunRequest[] = [];
  return {
    calls,
    start: async (req: StartRunRequest): Promise<StartRunOutcome> => {
      calls.push(req);
      return outcome;
    },
  };
}

/** Build {@link ToolServices} rooted at `repoRoot` with the given git/confirm. */
function makeServices(
  repoRoot: string,
  git: GitService,
  confirm: { confirm: (message: string) => Promise<boolean> },
  draftSpec?: { draft: (req: DraftSpecRequest) => Promise<DraftSpecOutcome> },
  runQueue: { dispatch: (req: RunDispatchRequest) => Promise<RunDispatchOutcome> } = noRunQueue,
  intervention?: InterventionSeam,
  runPipeline?: { start: (req: StartRunRequest) => Promise<StartRunOutcome> },
): ToolServices {
  return {
    repoRoot,
    baitonDir: path.join(repoRoot, '.baiton'),
    git,
    confirm,
    runQueue,
    submitPr: async (): Promise<never> => {
      throw new Error('submit_pr must not reach the PR flow on this path');
    },
    ...(draftSpec !== undefined ? { draftSpec } : {}),
    ...(intervention !== undefined ? { intervention } : {}),
    ...(runPipeline !== undefined ? { runPipeline } : {}),
    clock: { now: () => '2024-01-01T00:00:00.000Z' },
    ids: { next: () => 'id-1' },
    gitSettings: { remote: 'origin', base: 'main' },
  };
}

/** A trusted {@link GuardContext} rooted at the temp repo (writes allowed). */
function makeGuard(repoRoot: string): GuardContext {
  return new GuardContext({
    repoRoot,
    specsDir: path.join(repoRoot, '.baiton', 'specs'),
    restricted: false,
  });
}

/** An untrusted {@link GuardContext} rooted at the temp repo (Restricted Mode). */
function makeRestrictedGuard(repoRoot: string): GuardContext {
  return new GuardContext({
    repoRoot,
    specsDir: path.join(repoRoot, '.baiton', 'specs'),
    restricted: true,
  });
}

/** Create a fresh temp repo; register it for cleanup by the caller. */
function makeRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-registry-'));
}

/** Write a spec.md for `slug` under the temp repo and return its absolute path. */
function writeSpec(repoRoot: string, slug: string, content: string): string {
  const specDir = path.join(repoRoot, '.baiton', 'specs', slug);
  fs.mkdirSync(specDir, { recursive: true });
  const specFile = path.join(specDir, 'spec.md');
  fs.writeFileSync(specFile, content, 'utf8');
  return specFile;
}

/** A minimal draft spec covering frontmatter + OVERVIEW + one todo. */
function draftSpec(): string {
  return [
    '---',
    'version: 1',
    'name: sample',
    'status: draft',
    '---',
    '',
    '# OVERVIEW',
    '',
    'A sample spec used by the registry unit tests.',
    '',
    '# TODOS',
    '',
    '- [pending] T01 Do the first thing',
    '',
  ].join('\n');
}

describe('orchestrator registry and control tools (Task 13.8)', () => {
  const repos: string[] = [];

  function newRepo(): string {
    const repo = makeRepo();
    repos.push(repo);
    return repo;
  }

  afterEach(() => {
    while (repos.length > 0) {
      const repo = repos.pop()!;
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  describe('tool presence (Req 9.1, 9.5, 9.6, 10.1, 10.6)', () => {
    it('advertises exactly the expected read, write and control tools', () => {
      const repo = newRepo();
      const registry = createToolRegistry(
        makeServices(repo, benignGit(), recordingConfirm(true)),
      );

      const names = registry.names();
      for (const expected of EXPECTED_TOOLS) {
        assert.ok(
          registry.has(expected),
          `registry must include the "${expected}" tool`,
        );
        assert.ok(
          names.includes(expected),
          `names() must list the "${expected}" tool`,
        );
      }

      // The advertised set is exactly the expected set, no more, no less.
      assert.deepStrictEqual(
        [...names].sort(),
        [...EXPECTED_TOOLS].sort(),
        'registry advertises exactly the expected tools',
      );

      // definitions() carries the same names as the raw Tool shapes.
      const defNames = registry.definitions().map((d) => d.name).sort();
      assert.deepStrictEqual(defNames, [...EXPECTED_TOOLS].sort());
    });

    it('names() is sorted for a stable model spec / diagnostics view', () => {
      const repo = newRepo();
      const registry = createToolRegistry(
        makeServices(repo, benignGit(), recordingConfirm(true)),
      );
      const names = registry.names();
      const sorted = [...names].sort();
      assert.deepStrictEqual(names, sorted, 'names() should return a sorted list');
    });

    it('returns an error result for an unknown tool name', async () => {
      const repo = newRepo();
      const registry = createToolRegistry(
        makeServices(repo, benignGit(), recordingConfirm(true)),
      );
      const result = await registry.call('no_such_tool', {}, 'call-x', makeGuard(repo), 'gather');
      assert.strictEqual(result.ok, false);
      if (!result.ok) {
        assert.match(result.error, /unknown tool/i);
      }
    });
  });

  describe('draft_spec', () => {
    const REQUIREMENTS = 'Goal: add a greeting module.\nAcceptance: it is tested.';

    it('confirms the requirements, then dispatches and returns the run id', async () => {
      const repo = newRepo();
      const confirm = recordingConfirm(true);
      const draft = recordingDraft();
      const registry = createToolRegistry(
        makeServices(repo, benignGit(), confirm, draft),
      );

      const result = await registry.call(
        'draft_spec',
        { slug: 'greeting', requirements: REQUIREMENTS },
        'call-draft-1',
        makeGuard(repo),
        'gather',
      );

      assert.strictEqual(result.ok, true);
      if (result.ok) {
        assert.deepStrictEqual(result.data, { runId: 'draft-1' });
      }
      assert.strictEqual(confirm.calls.length, 1, 'the user is asked first');
      assert.ok(confirm.calls[0].includes('greeting'), 'the prompt names the slug');
      assert.ok(
        confirm.calls[0].includes('add a greeting module'),
        'the prompt summarizes the requirements',
      );
      assert.deepStrictEqual(draft.calls, [
        { slug: 'greeting', requirements: REQUIREMENTS },
      ]);
    });

    it('on a decline dispatches nothing and writes nothing', async () => {
      const repo = newRepo();
      const confirm = recordingConfirm(false);
      const draft = recordingDraft();
      const registry = createToolRegistry(
        makeServices(repo, throwingGit(), confirm, draft),
      );

      const result = await registry.call(
        'draft_spec',
        { slug: 'greeting', requirements: REQUIREMENTS },
        'call-draft-2',
        makeGuard(repo),
        'gather',
      );

      assert.strictEqual(result.ok, false);
      if (!result.ok) {
        assert.match(result.error, /declined/i);
      }
      assert.strictEqual(confirm.calls.length, 1);
      assert.strictEqual(draft.calls.length, 0, 'a decline dispatches nothing');
      assert.ok(
        !fs.existsSync(path.join(repo, '.baiton', 'specs', 'greeting')),
        'a decline creates no spec folder',
      );
    });

    it('refuses a slug that already has a spec, before confirming or dispatching', async () => {
      const repo = newRepo();
      const slug = 'sample';
      const specFile = writeSpec(repo, slug, draftSpec());
      const before = fs.readFileSync(specFile, 'utf8');
      const confirm = recordingConfirm(true);
      const draft = recordingDraft();
      const registry = createToolRegistry(
        makeServices(repo, throwingGit(), confirm, draft),
      );

      const result = await registry.call(
        'draft_spec',
        { slug, requirements: REQUIREMENTS },
        'call-draft-3',
        makeGuard(repo),
        'gather',
      );

      assert.strictEqual(result.ok, false);
      if (!result.ok) {
        assert.match(result.error, /already exists/i);
      }
      assert.strictEqual(confirm.calls.length, 0, 'a duplicate slug never prompts');
      assert.strictEqual(draft.calls.length, 0, 'a duplicate slug never dispatches');
      assert.strictEqual(fs.readFileSync(specFile, 'utf8'), before, 'the spec is untouched');
    });

    it('reports a busy repository without writing anything', async () => {
      const repo = newRepo();
      const registry = createToolRegistry(
        makeServices(repo, benignGit(), recordingConfirm(true), recordingDraft({ kind: 'busy' })),
      );

      const result = await registry.call(
        'draft_spec',
        { slug: 'greeting', requirements: REQUIREMENTS },
        'call-draft-4',
        makeGuard(repo),
        'gather',
      );

      assert.strictEqual(result.ok, false);
      if (!result.ok) {
        assert.match(result.error, /already running/i);
      }
    });

    it('surfaces a refusal reason from the runner', async () => {
      const repo = newRepo();
      const registry = createToolRegistry(
        makeServices(
          repo,
          benignGit(),
          recordingConfirm(true),
          recordingDraft({ kind: 'refused', reason: 'adapter probe failed: no CLI' }),
        ),
      );

      const result = await registry.call(
        'draft_spec',
        { slug: 'greeting', requirements: REQUIREMENTS },
        'call-draft-5',
        makeGuard(repo),
        'gather',
      );

      assert.strictEqual(result.ok, false);
      if (!result.ok) {
        assert.match(result.error, /adapter probe failed/);
      }
    });

    it('rejects empty requirements and an invalid slug', async () => {
      const repo = newRepo();
      const draft = recordingDraft();
      const registry = createToolRegistry(
        makeServices(repo, benignGit(), recordingConfirm(true), draft),
      );

      const empty = await registry.call(
        'draft_spec',
        { slug: 'greeting', requirements: '   ' },
        'call-draft-6',
        makeGuard(repo),
        'gather',
      );
      const bad = await registry.call(
        'draft_spec',
        { slug: '../escape', requirements: REQUIREMENTS },
        'call-draft-7',
        makeGuard(repo),
        'gather',
      );

      assert.strictEqual(empty.ok, false);
      assert.strictEqual(bad.ok, false);
      assert.strictEqual(draft.calls.length, 0);
    });

    it('reports the tool as unavailable when the host wired no runner', async () => {
      const repo = newRepo();
      const registry = createToolRegistry(
        makeServices(repo, benignGit(), recordingConfirm(true)),
      );

      const result = await registry.call(
        'draft_spec',
        { slug: 'greeting', requirements: REQUIREMENTS },
        'call-draft-8',
        makeGuard(repo),
        'gather',
      );

      assert.strictEqual(result.ok, false);
      if (!result.ok) {
        assert.match(result.error, /not available/i);
      }
    });
  });

  describe('approve_spec confirmation and decline (Req 10.1, 10.2)', () => {
    it('asks the confirm seam and, on decline, leaves the spec unchanged and returns an error', async () => {
      const repo = newRepo();
      const slug = 'sample';
      const specFile = writeSpec(repo, slug, draftSpec());
      const before = fs.readFileSync(specFile, 'utf8');

      // Decline the confirmation; a throwing git proves no git side effects run.
      const confirm = recordingConfirm(false);
      const registry = createToolRegistry(
        makeServices(repo, throwingGit(), confirm),
      );

      const result = await registry.call(
        'approve_spec',
        { slug },
        'call-approve-1',
        makeGuard(repo),
        'gather',
      );

      // Req 10.1: the confirmation was requested before any change.
      assert.strictEqual(confirm.calls.length, 1, 'approve_spec must ask to confirm');
      assert.match(confirm.calls[0], new RegExp(slug), 'the prompt names the spec');

      // Req 10.2: declined => error result and the spec is byte-for-byte unchanged.
      assert.strictEqual(result.ok, false, 'a declined approval returns an error');
      if (!result.ok) {
        assert.match(result.error, /declined|unchanged/i);
      }
      const after = fs.readFileSync(specFile, 'utf8');
      assert.strictEqual(after, before, 'a declined approval leaves the spec unchanged');
    });

    it('requires an idempotency key for the mutating approve_spec call (Req 8.4)', async () => {
      const repo = newRepo();
      const slug = 'sample';
      writeSpec(repo, slug, draftSpec());

      // No callId: the guard rejects the mutating call before confirming.
      const confirm = recordingConfirm(true);
      const registry = createToolRegistry(makeServices(repo, throwingGit(), confirm));

      const result = await registry.call(
        'approve_spec',
        { slug },
        undefined,
        makeGuard(repo),
        'gather',
      );

      assert.strictEqual(result.ok, false);
      if (!result.ok) {
        assert.match(result.error, /idempotency key/i);
      }
      // Rejected before any confirmation prompt or git call.
      assert.strictEqual(confirm.calls.length, 0, 'no confirm on a keyless mutating call');
    });
  });

  describe('phase scoping (Req 11.1)', () => {
    /**
     * The tool surface of each orchestrator phase. `gather` asks clarifying
     * questions and hands the agreed requirements to the spec writer; `drive`
     * dispatches stages for an approved spec. The repository read tools and
     * `draft_spec` belong to the first, `run` and `submit_pr` to the second,
     * and the spec-write tools plus the cheap orientation reads to both. The
     * third phase, `run`, is a spec-less (Bug/Quick/Refactor/Investigate)
     * conversation: it sees the read tools, `ask_user` and the two dispatch
     * tools `start_run` and `investigate`, and no spec tool at all. Note the
     * phase named `run` is not the tool named `run`, which stays drive-only.
     */
    const EXPECTED_PHASE_TOOLS: Record<OrchestratorPhase, string[]> = {
      gather: [
        'list_specs',
        'read_spec',
        'list_files',
        'read_file',
        'search',
        'git_status',
        'git_diff',
        'git_log',
        'update_overview',
        'add_todo',
        'edit_todo',
        'remove_todo',
        'ask_user',
        'draft_spec',
        'approve_spec',
      ],
      drive: [
        'list_specs',
        'read_spec',
        'git_status',
        'update_overview',
        'add_todo',
        'edit_todo',
        'remove_todo',
        'ask_user',
        'approve_spec',
        'run',
        'submit_pr',
      ],
      run: [
        'list_specs',
        'read_spec',
        'list_files',
        'read_file',
        'search',
        'git_status',
        'git_diff',
        'git_log',
        'ask_user',
        'start_run',
        'investigate',
      ],
    };

    it('advertises exactly the tools of each phase', () => {
      const repo = newRepo();
      const registry = createToolRegistry(
        makeServices(repo, benignGit(), recordingConfirm(true)),
      );

      for (const phase of ORCHESTRATOR_PHASES) {
        const names = registry.definitionsFor(phase).map((d) => d.name).sort();
        assert.deepStrictEqual(
          names,
          [...EXPECTED_PHASE_TOOLS[phase]].sort(),
          `the ${phase} phase advertises exactly its own tools`,
        );
      }
    });

    it('every registered tool belongs to at least one phase', () => {
      const repo = newRepo();
      const registry = createToolRegistry(
        makeServices(repo, benignGit(), recordingConfirm(true)),
      );
      for (const tool of registry.definitions()) {
        assert.ok(
          tool.phases.length > 0,
          `"${tool.name}" would be dead weight: it belongs to no phase`,
        );
      }
    });

    it('refuses a drive-only tool while gathering, before it can write anything', async () => {
      const repo = newRepo();
      const slug = 'sample';
      const specFile = writeSpec(repo, slug, draftSpec());
      const before = fs.readFileSync(specFile, 'utf8');

      // `submit_pr` is mutating and drive-only: a throwing git and a throwing
      // submit-PR seam prove the refusal happened before any of it ran.
      const confirm = recordingConfirm(true);
      const registry = createToolRegistry(makeServices(repo, throwingGit(), confirm));

      const result = await registry.call(
        'submit_pr',
        { slug },
        'call-phase-1',
        makeGuard(repo),
        'gather',
      );

      assert.strictEqual(result.ok, false, 'an out-of-phase tool must refuse');
      if (!result.ok) {
        assert.match(result.error, /submit_pr/, 'the refusal names the tool');
        assert.match(result.error, /gather/, 'the refusal names the phase');
      }
      assert.strictEqual(confirm.calls.length, 0, 'no confirmation was shown');
      assert.strictEqual(
        fs.readFileSync(specFile, 'utf8'),
        before,
        'an out-of-phase mutating call leaves the spec byte-for-byte unchanged',
      );
    });

    it('refuses a gather-only tool while driving, without dispatching it', async () => {
      const repo = newRepo();
      const draft = recordingDraft();
      const confirm = recordingConfirm(true);
      const registry = createToolRegistry(
        makeServices(repo, benignGit(), confirm, draft),
      );

      const result = await registry.call(
        'draft_spec',
        { slug: 'greeting', requirements: 'Goal: add a greeting module.' },
        'call-phase-2',
        makeGuard(repo),
        'drive',
      );

      assert.strictEqual(result.ok, false);
      if (!result.ok) {
        assert.match(result.error, /draft_spec/);
        assert.match(result.error, /drive/);
      }
      assert.strictEqual(draft.calls.length, 0, 'the spec writer was never dispatched');
      assert.strictEqual(confirm.calls.length, 0, 'no confirmation was shown');
    });

    it('refuses a repository read tool while driving, returning no file content', async () => {
      const repo = newRepo();
      fs.writeFileSync(path.join(repo, 'secret.ts'), 'export const answer = 42;\n', 'utf8');
      const registry = createToolRegistry(
        makeServices(repo, benignGit(), recordingConfirm(true)),
      );

      const result = await registry.call(
        'read_file',
        { path: 'secret.ts' },
        undefined,
        makeGuard(repo),
        'drive',
      );

      assert.strictEqual(result.ok, false, 'read_file is not part of the drive phase');
      if (!result.ok) {
        assert.match(result.error, /read_file/);
        assert.match(result.error, /drive/);
      }
    });

    it('runs the same tool when it is called in a phase it belongs to', async () => {
      const repo = newRepo();
      const slug = 'sample';
      writeSpec(repo, slug, draftSpec());
      const registry = createToolRegistry(
        makeServices(repo, benignGit(), recordingConfirm(true)),
      );

      // `read_spec` is in both phases: the refusals above are about the phase,
      // not a blanket block.
      for (const phase of ORCHESTRATOR_PHASES) {
        const result = await registry.call(
          'read_spec',
          { slug },
          undefined,
          makeGuard(repo),
          phase,
        );
        assert.strictEqual(result.ok, true, `read_spec runs while ${phase}`);
      }
    });

    it('refuses start_run outside the run phase, never reaching the pipeline', async () => {
      const repo = newRepo();
      const pipeline = spyingPipeline();
      const confirm = recordingConfirm(true);
      const registry = createToolRegistry(
        makeServices(repo, benignGit(), confirm, undefined, noRunQueue, undefined, pipeline),
      );

      for (const phase of ['gather', 'drive'] as const) {
        const result = await registry.call(
          'start_run',
          { mode: 'bug', statement: 'Fix it', files: [] },
          undefined,
          makeGuard(repo),
          phase,
        );
        assert.strictEqual(result.ok, false, `start_run must refuse while ${phase}`);
        if (!result.ok) {
          assert.match(result.error, /start_run/, 'the refusal names the tool');
          assert.match(result.error, new RegExp(phase), 'the refusal names the phase');
        }
      }
      assert.strictEqual(pipeline.calls.length, 0, 'the run pipeline was never reached');
      assert.strictEqual(confirm.calls.length, 0, 'no confirmation was shown');
    });

    it('refuses every spec tool while in the run phase, changing nothing', async () => {
      const repo = newRepo();
      const slug = 'sample';
      const specFile = writeSpec(repo, slug, draftSpec());
      const before = fs.readFileSync(specFile, 'utf8');
      const queue = {
        calls: [] as RunDispatchRequest[],
        dispatch: async (req: RunDispatchRequest): Promise<RunDispatchOutcome> => {
          queue.calls.push(req);
          return { kind: 'dispatched', runId: 'run-x' };
        },
      };
      const draft = recordingDraft();
      const confirm = recordingConfirm(true);
      const registry = createToolRegistry(
        makeServices(repo, throwingGit(), confirm, draft, queue),
      );

      const calls: [string, unknown][] = [
        ['run', { slug, todo: 'T01', stage: 'plan' }],
        ['draft_spec', { slug: 'other', requirements: 'Goal: something.' }],
        ['submit_pr', { slug }],
        ['approve_spec', { slug }],
        ['add_todo', { slug, text: 'T02 Another thing' }],
      ];
      for (const [name, args] of calls) {
        const result = await registry.call(name, args, `call-run-phase-${name}`, makeGuard(repo), 'run');
        assert.strictEqual(result.ok, false, `${name} must refuse while in the run phase`);
        if (!result.ok) {
          assert.match(result.error, new RegExp(name), 'the refusal names the tool');
          assert.match(result.error, /run/, 'the refusal names the phase');
        }
      }

      assert.strictEqual(confirm.calls.length, 0, 'no confirmation was shown');
      assert.strictEqual(queue.calls.length, 0, 'the run queue was never reached');
      assert.strictEqual(draft.calls.length, 0, 'the spec writer was never dispatched');
      assert.strictEqual(
        fs.readFileSync(specFile, 'utf8'),
        before,
        'an out-of-phase call leaves the spec byte-for-byte unchanged',
      );
    });
  });

  describe('start_run and investigate (run-phase dispatch tools)', () => {
    /** Build a registry whose run pipeline is `pipeline`. */
    function registryWith(
      repo: string,
      pipeline: { start: (req: StartRunRequest) => Promise<StartRunOutcome> } | undefined,
      confirm: { confirm: (message: string) => Promise<boolean> },
      intervention?: InterventionSeam,
      git: GitService = benignGit(),
    ) {
      return createToolRegistry(
        makeServices(repo, git, confirm, undefined, noRunQueue, intervention, pipeline),
      );
    }

    it('confirms, then dispatches the run with every argument it was given', async () => {
      const repo = newRepo();
      const pipeline = spyingPipeline();
      const confirm = recordingConfirm(true);
      const registry = registryWith(repo, pipeline, confirm);

      const result = await registry.call(
        'start_run',
        {
          mode: 'bug',
          statement: 'Fix the off-by-one in slice',
          files: ['src/a.ts', 'src/b.ts'],
          reproduction: 'call slice(0)',
        },
        'call-run-1',
        makeGuard(repo),
        'run',
      );

      assert.strictEqual(result.ok, true);
      if (result.ok) {
        const data = result.data as { runId: string; mode: string; branch?: string };
        assert.strictEqual(data.runId, 'run-1');
        assert.strictEqual(data.mode, 'bug');
        assert.strictEqual(data.branch, 'baiton/bug/run-1');
      }
      assert.deepStrictEqual(pipeline.calls, [
        {
          mode: 'bug',
          statement: 'Fix the off-by-one in slice',
          files: ['src/a.ts', 'src/b.ts'],
          reproduction: 'call slice(0)',
        },
      ]);
      assert.strictEqual(confirm.calls.length, 1, 'exactly one card was raised');
      const card = confirm.calls[0]!;
      assert.match(card, /bug/);
      assert.match(card, /Fix the off-by-one in slice/);
      assert.match(card, /src\/a\.ts/);
      assert.match(card, /src\/b\.ts/);
      assert.match(card, /main/, "the card names benignGit's current branch");
    });

    it('raises the card through the intervention seam when one is wired', async () => {
      const repo = newRepo();
      const pipeline = spyingPipeline();
      const intervention = recordingIntervention({ kind: 'approved' });
      const confirm = recordingConfirm(false);
      const registry = registryWith(repo, pipeline, confirm, intervention.seam);

      const result = await registry.call(
        'start_run',
        { mode: 'quick', statement: 'Rename the flag', files: ['src/flags.ts'] },
        'call-run-2',
        makeGuard(repo),
        'run',
      );

      assert.strictEqual(result.ok, true);
      assert.strictEqual(intervention.calls.length, 1, 'exactly one intervention request');
      const request = intervention.calls[0]!;
      assert.strictEqual(request.kind, 'confirm');
      const text = `${request.prompt}\n${'detail' in request ? request.detail ?? '' : ''}`;
      assert.match(text, /quick/);
      assert.match(text, /Rename the flag/);
      assert.match(text, /src\/flags\.ts/);
      assert.match(text, /main/);
      assert.strictEqual(confirm.calls.length, 0, 'the legacy seam is not used when the card is');
    });

    it('writes and dispatches nothing when the card is declined', async () => {
      for (const decline of ['intervention', 'confirm'] as const) {
        const repo = newRepo();
        const pipeline = spyingPipeline();
        const confirm = recordingConfirm(false);
        const intervention =
          decline === 'intervention' ? recordingIntervention({ kind: 'declined' }) : undefined;
        const registry = registryWith(repo, pipeline, confirm, intervention?.seam);

        for (const [name, args] of [
          ['start_run', { mode: 'refactor', statement: 'Split the module', files: ['src/a.ts'] }],
          ['investigate', { question: 'Where is X?', files: ['src/a.ts'] }],
        ] as [string, unknown][]) {
          const result = await registry.call(name, args, undefined, makeGuard(repo), 'run');
          assert.strictEqual(result.ok, false, `${name} must refuse on a decline`);
          if (!result.ok) {
            assert.match(result.error, /declined/i);
          }
        }

        assert.strictEqual(pipeline.calls.length, 0, 'a decline dispatches nothing');
        assert.strictEqual(
          fs.existsSync(path.join(repo, '.baiton', 'runs')),
          false,
          'a decline creates nothing under .baiton/runs/',
        );
      }
    });

    it('refuses invalid arguments before the card and before the seam', async () => {
      const cases: [string, unknown, RegExp][] = [
        ['start_run', { mode: 'spec', statement: 'x', files: [] }, /bug, quick, refactor/],
        ['start_run', { mode: 'investigate', statement: 'x', files: [] }, /bug, quick, refactor/],
        ['start_run', { mode: 'nope', statement: 'x', files: [] }, /bug, quick, refactor/],
        ['start_run', { mode: 'bug', files: [] }, /"statement"/],
        ['start_run', { mode: 'bug', statement: '   ', files: [] }, /"statement"/],
        ['start_run', { mode: 'bug', statement: 'a\nb', files: [] }, /single line/],
        ['start_run', { mode: 'bug', statement: 'x', files: 'nope' }, /"files"/],
        ['start_run', { mode: 'bug', statement: 'x', files: [''] }, /non-empty string/],
        ['start_run', { mode: 'bug', statement: 'x', files: ['/etc/passwd'] }, /repository-relative/],
        ['start_run', { mode: 'bug', statement: 'x', files: ['../outside.ts'] }, /repository-relative/],
        [
          'start_run',
          { mode: 'bug', statement: 'x', files: [], reproduction: '  ' },
          /"reproduction"/,
        ],
        ['investigate', { files: ['src/a.ts'] }, /"question"/],
        ['investigate', { question: 'a\nb', files: [] }, /single line/],
        ['investigate', { question: 'Where?' }, /"files"/],
      ];

      for (const [name, args, pattern] of cases) {
        const repo = newRepo();
        const pipeline = spyingPipeline();
        const confirm = recordingConfirm(true);
        const registry = registryWith(repo, pipeline, confirm);

        const result = await registry.call(name, args, undefined, makeGuard(repo), 'run');
        assert.strictEqual(result.ok, false, `${name} must refuse ${JSON.stringify(args)}`);
        if (!result.ok) {
          assert.match(result.error, pattern);
        }
        assert.strictEqual(confirm.calls.length, 0, 'no card on a malformed call');
        assert.strictEqual(pipeline.calls.length, 0, 'no dispatch on a malformed call');
      }
    });

    it('accepts an empty files array and collapses duplicates', async () => {
      const repo = newRepo();
      const pipeline = spyingPipeline();
      const registry = registryWith(repo, pipeline, recordingConfirm(true));

      const empty = await registry.call(
        'start_run',
        { mode: 'quick', statement: 'Nothing guessed', files: [] },
        undefined,
        makeGuard(repo),
        'run',
      );
      assert.strictEqual(empty.ok, true);
      assert.deepStrictEqual(pipeline.calls[0]!.files, []);

      const dupes = await registry.call(
        'start_run',
        { mode: 'quick', statement: 'Same file twice', files: ['a.ts', 'a.ts'] },
        undefined,
        makeGuard(repo),
        'run',
      );
      assert.strictEqual(dupes.ok, true);
      assert.deepStrictEqual(pipeline.calls[1]!.files, ['a.ts']);
    });

    it('surfaces busy and refused outcomes from the pipeline', async () => {
      const repo = newRepo();
      const busy = createToolRegistry(
        makeServices(
          repo,
          benignGit(),
          recordingConfirm(true),
          undefined,
          noRunQueue,
          undefined,
          spyingPipeline({ kind: 'busy' }),
        ),
      );
      const busyResult = await busy.call(
        'start_run',
        { mode: 'bug', statement: 'x', files: [] },
        undefined,
        makeGuard(repo),
        'run',
      );
      assert.strictEqual(busyResult.ok, false);
      if (!busyResult.ok) {
        assert.match(busyResult.error, /already running/i);
      }

      const refused = createToolRegistry(
        makeServices(
          repo,
          benignGit(),
          recordingConfirm(true),
          undefined,
          noRunQueue,
          undefined,
          spyingPipeline({ kind: 'refused', reason: 'the working tree is dirty' }),
        ),
      );
      const refusedResult = await refused.call(
        'start_run',
        { mode: 'bug', statement: 'x', files: [] },
        undefined,
        makeGuard(repo),
        'run',
      );
      assert.strictEqual(refusedResult.ok, false);
      if (!refusedResult.ok) {
        assert.match(refusedResult.error, /working tree is dirty/);
      }
    });

    it('reports itself unavailable when no run pipeline is wired', async () => {
      const repo = newRepo();
      const confirm = recordingConfirm(true);
      const registry = registryWith(repo, undefined, confirm);

      for (const [name, args] of [
        ['start_run', { mode: 'bug', statement: 'x', files: [] }],
        ['investigate', { question: 'Where?', files: [] }],
      ] as [string, unknown][]) {
        const result = await registry.call(name, args, undefined, makeGuard(repo), 'run');
        assert.strictEqual(result.ok, false);
        if (!result.ok) {
          assert.match(result.error, /not available/i);
        }
      }
      assert.strictEqual(confirm.calls.length, 0, 'an unavailable tool raises no card');
    });

    it('investigate dispatches the question as the run statement', async () => {
      const repo = newRepo();
      const pipeline = spyingPipeline({ kind: 'started', runId: 'run-2' });
      const confirm = recordingConfirm(true);
      const registry = registryWith(repo, pipeline, confirm);

      const result = await registry.call(
        'investigate',
        { question: 'Where is the retry budget enforced?', files: ['src/engine/runQueue.ts'] },
        undefined,
        makeGuard(repo),
        'run',
      );

      assert.strictEqual(result.ok, true);
      if (result.ok) {
        const data = result.data as { runId: string; mode: string };
        assert.strictEqual(data.runId, 'run-2');
        assert.strictEqual(data.mode, 'investigate');
      }
      assert.deepStrictEqual(pipeline.calls, [
        {
          mode: 'investigate',
          statement: 'Where is the retry budget enforced?',
          files: ['src/engine/runQueue.ts'],
        },
      ]);
      const card = confirm.calls[0]!;
      assert.match(card, /Where is the retry budget enforced\?/);
      assert.match(card, /src\/engine\/runQueue\.ts/);
      assert.match(card, /main/);
      assert.match(card, /Read-only/);
    });

    it('is callable without an idempotency key, being non-mutating', async () => {
      const repo = newRepo();
      const pipeline = spyingPipeline();
      const registry = registryWith(repo, pipeline, recordingConfirm(true));

      const a = await registry.call(
        'start_run',
        { mode: 'bug', statement: 'x', files: [] },
        undefined,
        makeGuard(repo),
        'run',
      );
      const b = await registry.call(
        'investigate',
        { question: 'Where?', files: [] },
        undefined,
        makeGuard(repo),
        'run',
      );
      assert.strictEqual(a.ok, true);
      assert.strictEqual(b.ok, true);
      assert.strictEqual(pipeline.calls.length, 2, 'both reached the seam without a call id');
    });

    it('is disabled under Restricted Mode, reaching neither card nor seam', async () => {
      const repo = newRepo();
      const pipeline = spyingPipeline();
      const confirm = recordingConfirm(true);
      const registry = registryWith(repo, pipeline, confirm, undefined, throwingGit());

      for (const [name, args] of [
        ['start_run', { mode: 'bug', statement: 'x', files: [] }],
        ['investigate', { question: 'Where?', files: [] }],
      ] as [string, unknown][]) {
        const result = await registry.call(
          name,
          args,
          'call-restricted-1',
          makeRestrictedGuard(repo),
          'run',
        );
        assert.strictEqual(result.ok, false, `${name} is disabled in Restricted Mode`);
        if (!result.ok) {
          assert.match(result.error, /Restricted Mode/);
        }
      }
      assert.strictEqual(confirm.calls.length, 0, 'no card in Restricted Mode');
      assert.strictEqual(pipeline.calls.length, 0, 'no dispatch in Restricted Mode');
    });

    it('advertises the schemas and flags the design fixes', () => {
      const repo = newRepo();
      const registry = registryWith(repo, spyingPipeline(), recordingConfirm(true));
      const defs = registry.definitions();

      const startRun = defs.find((d) => d.name === 'start_run')!;
      const startSchema = startRun.schema as {
        properties: { mode: { enum: string[] } };
        additionalProperties: boolean;
        required: string[];
      };
      assert.deepStrictEqual(startSchema.properties.mode.enum, ['bug', 'quick', 'refactor']);
      assert.strictEqual(startSchema.additionalProperties, false);
      assert.deepStrictEqual(startSchema.required, ['mode', 'statement', 'files']);

      const investigate = defs.find((d) => d.name === 'investigate')!;
      const investigateSchema = investigate.schema as {
        required: string[];
        additionalProperties: boolean;
      };
      assert.deepStrictEqual(investigateSchema.required, ['question', 'files']);
      assert.strictEqual(investigateSchema.additionalProperties, false);

      for (const tool of [startRun, investigate]) {
        assert.strictEqual(tool.dispatch, true, `${tool.name} is a dispatch tool`);
        assert.strictEqual(tool.mutating, false, `${tool.name} writes no spec file itself`);
        assert.deepStrictEqual([...tool.phases], ['run'], `${tool.name} is run-phase only`);
      }
    });
  });

  describe('run stage rejection (Req 11.1)', () => {
    /** A run-queue seam that records every dispatch it is asked for. */
    function spyingQueue(): {
      dispatch: (req: RunDispatchRequest) => Promise<RunDispatchOutcome>;
      calls: RunDispatchRequest[];
    } {
      const calls: RunDispatchRequest[] = [];
      return {
        calls,
        dispatch: async (req: RunDispatchRequest): Promise<RunDispatchOutcome> => {
          calls.push(req);
          return { kind: 'dispatched', runId: 'run-1' };
        },
      };
    }

    it('rejects plan-review itself, never reaching the run queue', async () => {
      const repo = newRepo();
      const slug = 'sample';
      writeSpec(repo, slug, draftSpec());
      const queue = spyingQueue();
      const registry = createToolRegistry(
        makeServices(repo, benignGit(), recordingConfirm(true), undefined, queue),
      );

      const result = await registry.call(
        'run',
        { slug, todo: 'T01', stage: 'plan-review' },
        undefined,
        makeGuard(repo),
        'drive',
      );

      assert.strictEqual(result.ok, false, 'plan-review is not a stage `run` accepts');
      if (!result.ok) {
        assert.match(result.error, /plan, execute, review/, 'the refusal names the legal stages');
        assert.match(
          result.error,
          /plan-review runs inside the plan stage/,
          'the refusal says who owns plan-review, so it is not read as a closed route',
        );
      }
      assert.strictEqual(queue.calls.length, 0, 'the queue was never reached');
    });

    it('rejects the spec-scoped pr stage and points at submit_pr', async () => {
      const repo = newRepo();
      const slug = 'sample';
      writeSpec(repo, slug, draftSpec());
      const queue = spyingQueue();
      const registry = createToolRegistry(
        makeServices(repo, benignGit(), recordingConfirm(true), undefined, queue),
      );

      const result = await registry.call(
        'run',
        { slug, todo: 'T01', stage: 'pr' },
        undefined,
        makeGuard(repo),
        'drive',
      );

      assert.strictEqual(result.ok, false);
      if (!result.ok) {
        assert.match(result.error, /submit_pr/);
      }
      assert.strictEqual(queue.calls.length, 0);
    });

    it("advertises exactly plan, execute and review in the tool's own schema", () => {
      const repo = newRepo();
      const registry = createToolRegistry(
        makeServices(repo, benignGit(), recordingConfirm(true)),
      );
      const run = registry.definitions().find((d) => d.name === 'run');
      assert.ok(run, 'the run tool is registered');
      const schema = run!.schema as {
        properties: { stage: { enum: string[] } };
      };
      assert.deepStrictEqual(schema.properties.stage.enum, ['plan', 'execute', 'review']);
      assert.ok(
        !run!.description.includes('plan-review'),
        'the description must not advertise a stage the tool rejects',
      );
    });

    it('dispatches a legal stage through to the queue (positive control)', async () => {
      const repo = newRepo();
      const slug = 'sample';
      writeSpec(repo, slug, draftSpec());
      const queue = spyingQueue();
      const registry = createToolRegistry(
        makeServices(repo, benignGit(), recordingConfirm(true), undefined, queue),
      );

      const result = await registry.call(
        'run',
        { slug, todo: 'T01', stage: 'plan' },
        undefined,
        makeGuard(repo),
        'drive',
      );

      assert.strictEqual(result.ok, true, 'a legal stage still dispatches');
      assert.deepStrictEqual(queue.calls, [{ slug, todoId: 'T01', stage: 'plan' }]);
    });
  });

  describe('ask_user', () => {
    const QUESTION = 'Which branch should this spec target?';

    it('forwards an option question to the seam and returns the chosen option', async () => {
      const repo = newRepo();
      const ask = recordingIntervention({ kind: 'option', optionId: 'b' });
      const registry = createToolRegistry(
        makeServices(repo, throwingGit(), recordingConfirm(true), undefined, undefined, ask.seam),
      );

      const result = await registry.call(
        'ask_user',
        {
          question: QUESTION,
          options: [
            { id: 'a', label: 'Option A' },
            { id: 'b', label: 'Option B' },
          ],
        },
        'call-ask-1',
        makeGuard(repo),
        'gather',
      );

      assert.strictEqual(result.ok, true);
      if (result.ok) {
        assert.deepStrictEqual(result.data, {
          answer: 'option',
          optionId: 'b',
          label: 'Option B',
        });
      }
      assert.strictEqual(ask.calls.length, 1);
      assert.deepStrictEqual(ask.calls[0], {
        kind: 'question',
        prompt: QUESTION,
        options: [
          { id: 'a', label: 'Option A' },
          { id: 'b', label: 'Option B' },
        ],
      });
    });

    it('returns a typed answer for a free-text question', async () => {
      const repo = newRepo();
      const ask = recordingIntervention({ kind: 'text', text: 'ship it' });
      const registry = createToolRegistry(
        makeServices(repo, throwingGit(), recordingConfirm(true), undefined, undefined, ask.seam),
      );

      const result = await registry.call(
        'ask_user',
        { question: 'What next?' },
        'call-ask-2',
        makeGuard(repo),
        'gather',
      );

      assert.strictEqual(result.ok, true);
      if (result.ok) {
        assert.deepStrictEqual(result.data, { answer: 'text', text: 'ship it' });
      }
      assert.ok(
        !('options' in ask.calls[0]),
        'a question with no options must send no options key',
      );
    });

    it('passes allow_free_text and placeholder through as allowFreeText/placeholder', async () => {
      const repo = newRepo();
      const ask = recordingIntervention({ kind: 'text', text: 'yes' });
      const registry = createToolRegistry(
        makeServices(repo, throwingGit(), recordingConfirm(true), undefined, undefined, ask.seam),
      );

      await registry.call(
        'ask_user',
        { question: QUESTION, allow_free_text: true, placeholder: 'type here' },
        'call-ask-3',
        makeGuard(repo),
        'gather',
      );

      assert.strictEqual(ask.calls.length, 1);
      assert.deepStrictEqual(ask.calls[0], {
        kind: 'question',
        prompt: QUESTION,
        allowFreeText: true,
        placeholder: 'type here',
      });
    });

    it('a decline is a refusal carrying the decline reason', async () => {
      const repo = newRepo();
      const ask = recordingIntervention({ kind: 'declined', reason: 'the run was stopped' });
      const registry = createToolRegistry(
        makeServices(repo, throwingGit(), recordingConfirm(true), undefined, undefined, ask.seam),
      );

      const result = await registry.call(
        'ask_user',
        { question: QUESTION },
        'call-ask-4',
        makeGuard(repo),
        'gather',
      );

      assert.strictEqual(result.ok, false);
      if (!result.ok) {
        assert.match(result.error, /the run was stopped/);
      }
    });

    it('reports itself as unavailable when no seam is wired', async () => {
      const repo = newRepo();
      const confirmation = recordingConfirm(true);
      const registry = createToolRegistry(
        makeServices(repo, throwingGit(), confirmation),
      );

      const result = await registry.call(
        'ask_user',
        { question: QUESTION },
        'call-ask-5',
        makeGuard(repo),
        'gather',
      );

      assert.strictEqual(result.ok, false);
      if (!result.ok) {
        assert.match(result.error, /not available in this host/);
      }
    });

    it('rejects an empty or missing question before the seam', async () => {
      const repo = newRepo();
      const ask = recordingIntervention({ kind: 'text', text: 'ignored' });
      const registry = createToolRegistry(
        makeServices(repo, throwingGit(), recordingConfirm(true), undefined, undefined, ask.seam),
      );

      const missing = await registry.call(
        'ask_user', {}, 'call-ask-6a', makeGuard(repo), 'gather',
      );
      const blank = await registry.call(
        'ask_user', { question: '   ' }, 'call-ask-6b', makeGuard(repo), 'gather',
      );

      assert.strictEqual(missing.ok, false);
      assert.strictEqual(blank.ok, false);
      if (!missing.ok) {
        assert.match(missing.error, /non-empty string "question"/);
      }
      assert.strictEqual(ask.calls.length, 0, 'a malformed call never raises a card');
    });

    it('rejects malformed options before the seam', async () => {
      const repo = newRepo();
      const ask = recordingIntervention({ kind: 'option', optionId: 'a' });
      const registry = createToolRegistry(
        makeServices(repo, throwingGit(), recordingConfirm(true), undefined, undefined, ask.seam),
      );

      const cases: Record<string, unknown>[] = [
        // an option missing label
        {
          question: QUESTION,
          options: [{ id: 'a' }],
        },
        // a duplicate id
        {
          question: QUESTION,
          options: [
            { id: 'a', label: 'A' },
            { id: 'a', label: 'A again' },
          ],
        },
        // a non-array options
        { question: QUESTION, options: 'nope' },
        // nine options
        {
          question: QUESTION,
          options: Array.from({ length: 9 }, (_, i) => ({ id: `o${i}`, label: `Option ${i}` })),
        },
      ];

      for (let i = 0; i < cases.length; i++) {
        const result = await registry.call(
          'ask_user', cases[i], `call-ask-7-${i}`, makeGuard(repo), 'gather',
        );
        assert.strictEqual(result.ok, false, `case ${i} must refuse`);
      }
      assert.strictEqual(ask.calls.length, 0, 'the seam was never reached');
    });

    it('rejects a non-boolean allow_free_text before the seam', async () => {
      const repo = newRepo();
      const ask = recordingIntervention({ kind: 'text', text: 'ignored' });
      const registry = createToolRegistry(
        makeServices(repo, throwingGit(), recordingConfirm(true), undefined, undefined, ask.seam),
      );

      const result = await registry.call(
        'ask_user',
        { question: QUESTION, allow_free_text: 'yes' },
        'call-ask-8',
        makeGuard(repo),
        'gather',
      );

      assert.strictEqual(result.ok, false);
      if (!result.ok) {
        assert.match(result.error, /must be a boolean/);
      }
      assert.strictEqual(ask.calls.length, 0);
    });

    it('is callable without an idempotency key (it is non-mutating)', async () => {
      const repo = newRepo();
      const ask = recordingIntervention({ kind: 'text', text: 'later' });
      const registry = createToolRegistry(
        makeServices(repo, throwingGit(), recordingConfirm(true), undefined, undefined, ask.seam),
      );

      const result = await registry.call(
        'ask_user',
        { question: QUESTION },
        undefined,
        makeGuard(repo),
        'gather',
      );

      assert.strictEqual(result.ok, true, 'a non-mutating call needs no key');
      assert.strictEqual(ask.calls.length, 1, 'the call still reaches the seam');
    });

    it('is available while driving', async () => {
      const repo = newRepo();
      const question = 'Is the spec good to approve?';
      const ask = recordingIntervention({ kind: 'text', text: 'yes' });
      const registry = createToolRegistry(
        makeServices(repo, throwingGit(), recordingConfirm(true), undefined, undefined, ask.seam),
      );

      const result = await registry.call(
        'ask_user',
        { question },
        'call-ask-10',
        makeGuard(repo),
        'drive',
      );

      assert.strictEqual(result.ok, true);
      if (result.ok) {
        assert.deepStrictEqual(result.data, { answer: 'text', text: 'yes' });
      }
      assert.deepStrictEqual(ask.calls, [{ kind: 'question', prompt: question }]);
    });
  });

  describe('run over per-todo queues', () => {
    interface FakeQueue extends RunQueue {
      requests: RunRequest[];
      running: boolean;
      pending: Array<(r: DispatchResult) => void>;
    }
    function fakeQueue(): FakeQueue {
      const q: FakeQueue = {
        requests: [],
        running: false,
        pending: [],
        dispatch: (req) => {
          q.requests.push(req);
          return new Promise<DispatchResult>((resolve) => q.pending.push(resolve));
        },
        stop: () => {},
        isRunning: () => q.running,
        currentRun: () => undefined,
      };
      return q;
    }
    const dispatched: DispatchResult = { ok: true, outcome: { kind: 'planned' } } as unknown as DispatchResult;

    it('names the todo when the seam answers busy', async () => {
      const repo = newRepo();
      const slug = 'sample';
      writeSpec(repo, slug, draftSpec());
      const registry = createToolRegistry(
        makeServices(repo, benignGit(), recordingConfirm(true), undefined, {
          dispatch: async () => ({ kind: 'busy' }),
        }),
      );
      const result = await registry.call(
        'run',
        { slug, todo: 'T01', stage: 'plan' },
        undefined,
        makeGuard(repo),
        'drive',
      );
      assert.strictEqual(result.ok, false);
      if (!result.ok) {
        assert.match(result.error, /todo "T01"/);
        assert.match(result.error, /other todos can run/);
      }
    });

    it('answers busy per todo, dispatches other todos, and clears in-flight state', async () => {
      const specsDir = path.join(newRepo(), '.baiton', 'specs');
      const queues = new Map<string, FakeQueue>([
        ['demo/T01', fakeQueue()],
        ['demo/T02', fakeQueue()],
      ]);
      const seam = createRunQueueSeam((slug, todoId) => queues.get(`${slug}/${todoId}`)!, specsDir, () => undefined);
      const t01 = queues.get('demo/T01')!;
      const t02 = queues.get('demo/T02')!;
      const req = (todoId: string) => ({ slug: 'demo', todoId, stage: 'plan' as const });

      const first = seam.dispatch(req('T01'));
      assert.deepStrictEqual(await seam.dispatch(req('T01')), { kind: 'busy' });
      assert.strictEqual(t01.requests.length, 1, 'the second dispatch never reached the queue');

      const other = seam.dispatch(req('T02'));
      assert.strictEqual(t02.requests.length, 1, 'T02 reached its own queue');
      t02.pending[0](dispatched);
      assert.strictEqual((await other).kind, 'dispatched');

      t01.pending[0](dispatched);
      assert.strictEqual((await first).kind, 'dispatched');

      const again = seam.dispatch(req('T01'));
      assert.strictEqual(t01.requests.length, 2, 'in-flight state was cleared');
      t01.pending[1](dispatched);
      await again;
    });

    it('answers busy while the queue itself is running and maps refusals to illegal', async () => {
      const specsDir = path.join(newRepo(), '.baiton', 'specs');
      const q = fakeQueue();
      const seam = createRunQueueSeam(() => q, specsDir, () => undefined);
      const req = { slug: 'demo', todoId: 'T01', stage: 'plan' as const };

      q.running = true;
      assert.deepStrictEqual(await seam.dispatch(req), { kind: 'busy' });
      assert.strictEqual(q.requests.length, 0);

      q.running = false;
      const refused = seam.dispatch(req);
      q.pending[0]({ ok: false, error: { kind: 'deps-unlanded', message: 'm' } } as unknown as DispatchResult);
      assert.deepStrictEqual(await refused, { kind: 'illegal', reason: 'm' });
    });
  });
});
