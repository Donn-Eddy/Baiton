import * as assert from 'assert';
import * as fc from 'fast-check';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createToolRegistry } from '../src/orchestrator/registry';
import { GuardContext } from '../src/orchestrator/guard';
import { ToolServices } from '../src/orchestrator/toolServices';
import { GitService, GitStatus } from '../src/git';
import { Result, ok } from '../src/model/result';
import { RunDispatchOutcome, RunDispatchRequest } from '../src/orchestrator/seams';
import { parseSpec } from '../src/model/parser';
import { validateSpec } from '../src/model/validator';
import { TODO_STATES, TodoState } from '../src/model/todoState';
import { Stage } from '../src/model/stage';

/**
 * Feature: baiton-first-pass, Property 5: Invalid specs block every stage
 *
 * For any spec the validator reports invalid, the extension refuses to dispatch
 * ANY stage for that spec: the `run` control tool returns an error, surfaces the
 * validation problem, and never reaches the run queue — for every stage the
 * tool accepts (plan, execute, review) and every todo (Req 4.9).
 * As a positive control, a clean spec free of every malformed construct and of
 * dependency cycles is allowed to dispatch.
 *
 * Validates: Requirements 4.9
 *
 * Strategy: generate a clean, acyclic base spec, then inject exactly one
 * malformed construct so `validateSpec` reports it invalid. Drive `run` through
 * the real tool registry against a temp repo, using a run-queue seam that throws
 * if it is ever dispatched into. Because the gate reads and validates the spec
 * before touching the queue, an invalid spec must produce an error result with
 * the queue never called, for every stage. The valid half asserts the same
 * harness dispatches when the spec is clean, proving the gate is not a
 * blanket refusal.
 */

// --- Spec generators (shared shape with the validator property test) -------

/** A todo id: `T` followed by two or more decimal digits (Req 3.3). */
const idArb: fc.Arbitrary<string> = fc
  .integer({ min: 0, max: 999999 })
  .map((n) => 'T' + String(n).padStart(2, '0'));

/** A hint-free, newline-free title so only explicit `after` groups appear. */
const titleArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 30 })
  .map((s) => s.replace(/[()\n\r;]/g, ' ').trim())
  .filter((s) => s.length > 0);

/** A frontmatter/overview value with no newline (empty allowed). */
const fmValueArb: fc.Arbitrary<string> = fc
  .string({ maxLength: 20 })
  .map((s) => s.replace(/[\n\r]/g, '').trim());

interface CleanTodo {
  id: string;
  state: TodoState;
  title: string;
  after: string[];
}

/** Renders a clean todo to a grammar-conformant line. */
function renderTodo(t: CleanTodo): string {
  let line = `- [${t.state}] ${t.id} ${t.title}`;
  if (t.after.length > 0) {
    line += ` (after ${t.after.join(',')})`;
  }
  return line;
}

/**
 * A clean base spec: unique ids, known states, `after` targets restricted to
 * strictly-earlier ids (present, non-self, acyclic), no conflict markers.
 */
const baseSpecArb: fc.Arbitrary<{ ids: string[]; todos: CleanTodo[]; overview: string }> = fc
  .record({
    ids: fc.uniqueArray(idArb, { minLength: 1, maxLength: 6 }),
    overview: fmValueArb,
  })
  .chain(({ ids, overview }) =>
    fc
      .tuple(
        ...ids.map((_id, index) =>
          fc.record({
            state: fc.constantFrom<TodoState>(...TODO_STATES),
            title: titleArb,
            after: fc.subarray(ids.slice(0, index)),
          }),
        ),
      )
      .map((parts) => ({
        overview,
        ids,
        todos: parts.map((p, i) => ({ id: ids[i], ...p })),
      })),
  );

/** Assembles full spec text from a base spec's todos and overview. */
function renderSpec(overview: string, todoLines: string[]): string {
  return [
    '---',
    'version: 1',
    'name: sample',
    'status: draft',
    '---',
    '# OVERVIEW',
    '',
    overview,
    '',
    '# TODOS',
    '',
    ...todoLines,
  ].join('\n');
}

/** The malformed constructs, each of which makes the spec invalid (Req 4). */
const INJECTIONS = [
  'grammar',
  'duplicate',
  'unknown-state',
  'missing-after',
  'self-after',
  'conflict',
  'cycle',
] as const;

/** Produces spec text with exactly one malformed construct injected. */
function injectMalformed(
  base: { ids: string[]; todos: CleanTodo[]; overview: string },
  kind: (typeof INJECTIONS)[number],
  seed: number,
): string {
  const todos = base.todos.map(renderTodo);
  const pick = base.todos.length > 0 ? seed % base.todos.length : 0;

  switch (kind) {
    case 'grammar':
      todos.splice(pick, 0, '- [pending] notanid missing digits');
      return renderSpec(base.overview, todos);
    case 'duplicate':
      todos.push(`- [pending] ${base.todos[pick].id} a duplicate id`);
      return renderSpec(base.overview, todos);
    case 'unknown-state': {
      const t = base.todos[pick];
      todos[pick] = `- [bogusstate] ${t.id} ${t.title}`;
      return renderSpec(base.overview, todos);
    }
    case 'missing-after': {
      const t = base.todos[pick];
      const absent = pickAbsentId(base.ids, seed);
      todos[pick] = `- [${t.state}] ${t.id} ${t.title} (after ${absent})`;
      return renderSpec(base.overview, todos);
    }
    case 'self-after': {
      const t = base.todos[pick];
      todos[pick] = `- [${t.state}] ${t.id} ${t.title} (after ${t.id})`;
      return renderSpec(base.overview, todos);
    }
    case 'conflict': {
      const marker = ['<<<<<<< HEAD', '=======', '>>>>>>> branch'][seed % 3];
      todos.splice(pick, 0, marker);
      return renderSpec(base.overview, todos);
    }
    case 'cycle': {
      // Two mutually-dependent todos form a cycle (Req 4.7).
      todos.push('- [pending] T900001 first of a cycle (after T900002)');
      todos.push('- [pending] T900002 second of a cycle (after T900001)');
      return renderSpec(base.overview, todos);
    }
    default:
      throw new Error(`unknown injection kind: ${kind}`);
  }
}

/** An id guaranteed absent from `ids`, for the missing-after case. */
function pickAbsentId(ids: string[], seed: number): string {
  let n = 1000000 + (seed % 1000000);
  const present = new Set(ids);
  let candidate = 'T' + String(n);
  while (present.has(candidate)) {
    n += 1;
    candidate = 'T' + String(n);
  }
  return candidate;
}

// --- Harness ---------------------------------------------------------------

/** A benign git stub; the validity gate must run before any git is touched. */
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

/** A run-queue seam that records dispatches; used to prove refusal or allowance. */
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

function makeServices(
  repoRoot: string,
  queue: { dispatch: (req: RunDispatchRequest) => Promise<RunDispatchOutcome> },
): ToolServices {
  return {
    repoRoot,
    baitonDir: path.join(repoRoot, '.baiton'),
    git: benignGit(),
    confirm: { confirm: async () => true },
    runQueue: queue,
    clock: { now: () => '2024-01-01T00:00:00.000Z' },
    ids: { next: () => 'id-1' },
    gitSettings: { remote: 'origin', base: 'main' },
  };
}

function makeGuard(repoRoot: string): GuardContext {
  return new GuardContext({
    repoRoot,
    specsDir: path.join(repoRoot, '.baiton', 'specs'),
    restricted: false,
  });
}

/** Write a spec.md for `slug` under the temp repo. */
function writeSpec(repoRoot: string, slug: string, content: string): void {
  const specDir = path.join(repoRoot, '.baiton', 'specs', slug);
  fs.mkdirSync(specDir, { recursive: true });
  fs.writeFileSync(path.join(specDir, 'spec.md'), content, 'utf8');
}

/** Every stage the `run` tool accepts. */
const STAGES: Stage[] = ['plan', 'execute', 'review'];

describe('invalid specs block every stage (property, Task 11.8)', () => {
  const repos: string[] = [];

  function newRepo(): string {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-invalid-block-'));
    repos.push(repo);
    return repo;
  }

  afterEach(() => {
    while (repos.length > 0) {
      const repo = repos.pop()!;
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  // Feature: baiton-first-pass, Property 5: Invalid specs block every stage
  it('refuses to dispatch any stage while the spec is invalid, never touching the queue', async () => {
    await fc.assert(
      fc.asyncProperty(
        baseSpecArb,
        fc.constantFrom(...INJECTIONS),
        fc.integer({ min: 0, max: 100000 }),
        fc.constantFrom(...STAGES),
        async (base, kind, seed, stage) => {
          const raw = injectMalformed(base, kind, seed);

          // Precondition: the injected spec really is invalid.
          fc.pre(validateSpec(parseSpec(raw), raw).length > 0);

          const repo = newRepo();
          const slug = 'sample';
          writeSpec(repo, slug, raw);

          const queue = spyingQueue();
          const registry = createToolRegistry(makeServices(repo, queue));
          const todo = base.todos[seed % base.todos.length].id;

          const result = await registry.call(
            'run',
            { slug, todo, stage },
            undefined,
            makeGuard(repo),
            'drive',
          );

          // The dispatch is refused with an error (Req 4.9)...
          assert.strictEqual(
            result.ok,
            false,
            `invalid spec must not dispatch stage "${stage}"\n---\n${raw}`,
          );
          if (!result.ok) {
            assert.match(
              result.error,
              /invalid/i,
              'the refusal surfaces that the spec is invalid',
            );
          }
          // ...and the run queue was never reached for any stage (Req 4.9).
          assert.strictEqual(
            queue.calls.length,
            0,
            'an invalid spec must never reach the run queue',
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  // Positive control: the same gate lets a clean spec through, so it is not a
  // blanket refusal.
  // Feature: baiton-first-pass, Property 5: Invalid specs block every stage
  it('allows dispatch for a clean, valid spec (positive control)', async () => {
    await fc.assert(
      fc.asyncProperty(
        baseSpecArb,
        fc.integer({ min: 0, max: 100000 }),
        fc.constantFrom(...STAGES),
        async (base, seed, stage) => {
          const raw = renderSpec(base.overview, base.todos.map(renderTodo));

          // Precondition: the base spec is valid.
          fc.pre(validateSpec(parseSpec(raw), raw).length === 0);

          const repo = newRepo();
          const slug = 'sample';
          writeSpec(repo, slug, raw);

          const queue = spyingQueue();
          const registry = createToolRegistry(makeServices(repo, queue));
          const todo = base.todos[seed % base.todos.length].id;

          const result = await registry.call(
            'run',
            { slug, todo, stage },
            undefined,
            makeGuard(repo),
            'drive',
          );

          // A valid spec reaches the queue and the dispatch succeeds.
          assert.strictEqual(
            result.ok,
            true,
            `a valid spec must dispatch stage "${stage}"\n---\n${raw}`,
          );
          assert.strictEqual(
            queue.calls.length,
            1,
            'a valid spec dispatches exactly once',
          );
        },
      ),
      { numRuns: 100 },
    );
  });
});
