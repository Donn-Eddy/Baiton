import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createToolRegistry } from '../src/orchestrator/registry';
import { GuardContext } from '../src/orchestrator/guard';
import { ToolServices } from '../src/orchestrator/toolServices';
import { GitService, GitStatus } from '../src/git';
import { Result, ok } from '../src/model/result';
import {
  DraftSpecOutcome,
  DraftSpecRequest,
  RunDispatchOutcome,
  RunDispatchRequest,
} from '../src/orchestrator/seams';

/**
 * Unit tests for the orchestrator tool registry and control tools (Task 13.8).
 *
 * Covers:
 *  - Tool presence: the registry advertises every read, spec-writing and
 *    control tool the design names (Req 9.1, 9.5, 9.6).
 *  - `approve_spec` confirmation and decline: the tool asks the confirm seam
 *    first (Req 10.1) and, on a decline, leaves the spec byte-for-byte
 *    unchanged and returns an error while touching no git (Req 10.2).
 *  - `read_artifact` found/not-found: it returns the artifact text when the
 *    file exists (Req 10.6) and a not-found error when it does not (Req 10.7).
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
  // Control tools (Req 10.1, 10.3, 10.6)
  'draft_spec',
  'approve_spec',
  'run',
  'read_artifact',
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

/** Build {@link ToolServices} rooted at `repoRoot` with the given git/confirm. */
function makeServices(
  repoRoot: string,
  git: GitService,
  confirm: { confirm: (message: string) => Promise<boolean> },
  draftSpec?: { draft: (req: DraftSpecRequest) => Promise<DraftSpecOutcome> },
): ToolServices {
  return {
    repoRoot,
    baitonDir: path.join(repoRoot, '.baiton'),
    git,
    confirm,
    runQueue: noRunQueue,
    ...(draftSpec !== undefined ? { draftSpec } : {}),
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
      const result = await registry.call('no_such_tool', {}, 'call-x', makeGuard(repo));
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
      );
      const bad = await registry.call(
        'draft_spec',
        { slug: '../escape', requirements: REQUIREMENTS },
        'call-draft-7',
        makeGuard(repo),
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

      const result = await registry.call('approve_spec', { slug }, undefined, makeGuard(repo));

      assert.strictEqual(result.ok, false);
      if (!result.ok) {
        assert.match(result.error, /idempotency key/i);
      }
      // Rejected before any confirmation prompt or git call.
      assert.strictEqual(confirm.calls.length, 0, 'no confirm on a keyless mutating call');
    });
  });

  describe('read_artifact found / not-found (Req 10.6, 10.7)', () => {
    it('returns the artifact text when the file exists (Req 10.6)', async () => {
      const repo = newRepo();
      const slug = 'sample';
      const todo = 'T01';
      writeSpec(repo, slug, draftSpec());

      const artifactDir = path.join(repo, '.baiton', 'specs', slug, 'todos', todo);
      fs.mkdirSync(artifactDir, { recursive: true });
      const artifactText = '# Plan\n\nDo the thing carefully.\n';
      fs.writeFileSync(path.join(artifactDir, 'plan.md'), artifactText, 'utf8');

      const registry = createToolRegistry(
        makeServices(repo, benignGit(), recordingConfirm(true)),
      );

      const result = await registry.call(
        'read_artifact',
        { slug, todo, name: 'plan.md' },
        undefined,
        makeGuard(repo),
      );

      assert.strictEqual(result.ok, true, 'reading an existing artifact succeeds');
      if (result.ok) {
        const data = result.data as {
          slug: string;
          todo: string;
          name: string;
          text: string;
          truncated: boolean;
        };
        assert.strictEqual(data.slug, slug);
        assert.strictEqual(data.todo, todo);
        assert.strictEqual(data.name, 'plan.md');
        assert.strictEqual(data.text, artifactText, 'returns the artifact contents verbatim');
        assert.strictEqual(data.truncated, false, 'a small artifact is not truncated');
      }
    });

    it('returns a not-found error when the artifact does not exist (Req 10.7)', async () => {
      const repo = newRepo();
      const slug = 'sample';
      const todo = 'T01';
      writeSpec(repo, slug, draftSpec());

      const registry = createToolRegistry(
        makeServices(repo, benignGit(), recordingConfirm(true)),
      );

      const result = await registry.call(
        'read_artifact',
        { slug, todo, name: 'review-1.md' },
        undefined,
        makeGuard(repo),
      );

      assert.strictEqual(result.ok, false, 'a missing artifact returns an error');
      if (!result.ok) {
        assert.match(result.error, /not found/i, 'error indicates the artifact was not found');
        assert.match(result.error, /review-1\.md/, 'error names the requested artifact');
      }
    });
  });
});
