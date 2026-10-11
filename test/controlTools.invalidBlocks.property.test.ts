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
import { parsePlan } from '../src/model/parser';
import { validatePlan } from '../src/model/validator';
import { PHASE_STATES, PhaseState } from '../src/model/phaseState';
import { Stage } from '../src/model/stage';

/**
 * Feature: baiton-first-pass, Property 5: Invalid plans block every phase stage
 *
 * For any document the validator reports invalid, the extension refuses to dispatch
 * ANY stage for that plan: the `run` control tool returns an error, surfaces the
 * validation problem, and never reaches the run queue — for every stage the
 * tool accepts (plan, execute, review) and every phase (Req 4.9).
 * As a positive control, a clean document free of every malformed construct and of
 * dependency cycles is allowed to dispatch.
 *
 * Validates: Requirements 4.9
 *
 * Strategy: generate a clean, acyclic base document, then inject exactly one
 * malformed construct so `validatePlan` reports it invalid. Drive `run` through
 * the real tool registry against a temp repo, using a run-queue seam that throws
 * if it is ever dispatched into. Because the gate reads and validates the plan
 * before touching the queue, an invalid plan must produce an error result with
 * the queue never called, for every stage. The valid half asserts the same
 * harness dispatches when the plan is clean, proving the gate is not a
 * blanket refusal.
 */

// --- plan generators (shared shape with the validator property test) -------

/** A legacy phase id: `T` followed by two or more decimal digits (Req 3.3). */
// Legacy spec fixture generator: invalid documents retain the old T## grammar.
const legacyPhaseIdArb: fc.Arbitrary<string> = fc
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

interface LegacyPhase {
  id: string;
  state: PhaseState;
  title: string;
  after: string[];
}

/** Renders a clean phase to a grammar-conformant line. */
function renderLegacyPhase(t: LegacyPhase): string {
  let line = `- [${t.state}] ${t.id} ${t.title}`;
  if (t.after.length > 0) {
    line += ` (after ${t.after.join(',')})`;
  }
  return line;
}

/**
 * A clean base plan: unique ids, known states, `after` targets restricted to
 * strictly-earlier ids (present, non-self, acyclic), no conflict markers.
 */
const legacyDocumentArb: fc.Arbitrary<{ ids: string[]; phases: LegacyPhase[]; overview: string }> = fc
  .record({
    ids: fc.uniqueArray(legacyPhaseIdArb, { minLength: 1, maxLength: 6 }),
    overview: fmValueArb,
  })
  .chain(({ ids, overview }) =>
    fc
      .tuple(
        ...ids.map((_id, index) =>
          fc.record({
            state: fc.constantFrom<PhaseState>(...PHASE_STATES),
            title: titleArb,
            after: fc.subarray(ids.slice(0, index)),
          }),
        ),
      )
      .map((parts) => ({
        overview,
        ids,
        phases: parts.map((p, i) => ({ id: ids[i], ...p })),
      })),
  );

/** Assembles full plan text from a base plan's phases and overview. */
function renderLegacyDocument(overview: string, phaseLines: string[]): string {
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
    ...phaseLines,
  ].join('\n');
}

/** The malformed constructs, each of which makes the plan invalid (Req 4). */
const INJECTIONS = [
  'grammar',
  'duplicate',
  'unknown-state',
  'missing-after',
  'self-after',
  'conflict',
  'cycle',
] as const;

/** Produces plan text with exactly one malformed construct injected. */
function injectMalformed(
  base: { ids: string[]; phases: LegacyPhase[]; overview: string },
  kind: (typeof INJECTIONS)[number],
  seed: number,
): string {
  const phases = base.phases.map(renderLegacyPhase);
  const pick = base.phases.length > 0 ? seed % base.phases.length : 0;

  switch (kind) {
    case 'grammar':
      phases.splice(pick, 0, '- [pending] notanid missing digits');
      return renderLegacyDocument(base.overview, phases);
    case 'duplicate':
      phases.push(`- [pending] ${base.phases[pick].id} a duplicate id`);
      return renderLegacyDocument(base.overview, phases);
    case 'unknown-state': {
      const t = base.phases[pick];
      phases[pick] = `- [bogusstate] ${t.id} ${t.title}`;
      return renderLegacyDocument(base.overview, phases);
    }
    case 'missing-after': {
      const t = base.phases[pick];
      const absent = pickAbsentId(base.ids, seed);
      phases[pick] = `- [${t.state}] ${t.id} ${t.title} (after ${absent})`;
      return renderLegacyDocument(base.overview, phases);
    }
    case 'self-after': {
      const t = base.phases[pick];
      phases[pick] = `- [${t.state}] ${t.id} ${t.title} (after ${t.id})`;
      return renderLegacyDocument(base.overview, phases);
    }
    case 'conflict': {
      const marker = ['<<<<<<< HEAD', '=======', '>>>>>>> branch'][seed % 3];
      phases.splice(pick, 0, marker);
      return renderLegacyDocument(base.overview, phases);
    }
    case 'cycle': {
      // Two mutually-dependent phases form a cycle (Req 4.7).
      phases.push('- [pending] T900001 first of a cycle (after T900002)');
      phases.push('- [pending] T900002 second of a cycle (after T900001)');
      return renderLegacyDocument(base.overview, phases);
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
    isCleanExceptPlanFolder: async () => true,
    fetch: async () => undefined,
    resolveBaseCommit: async () => '0'.repeat(40),
    createPlanBranch: async () => undefined,
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
    baitonDir: path.join(repoRoot, '.baiton'),
    restricted: false,
  });
}

/** Legacy: write a spec.md for `slug` under the temp repo. */
function writeLegacySpec(repoRoot: string, slug: string, content: string): void {
  const legacySpecsDir = path.join(repoRoot, '.baiton', 'specs', slug);
  fs.mkdirSync(legacySpecsDir, { recursive: true });
  fs.writeFileSync(path.join(legacySpecsDir, 'spec.md'), content, 'utf8');
}

/** Every stage the `run` tool accepts. */
const STAGES: Stage[] = ['plan', 'execute', 'review'];

describe('invalid plans block every stage (property)', () => {
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

  // Feature: baiton-first-pass, Property 5: Invalid plans block every stage
  it('refuses to dispatch any stage while the plan is invalid, never touching the queue', async () => {
    await fc.assert(
      fc.asyncProperty(
        legacyDocumentArb,
        fc.constantFrom(...INJECTIONS),
        fc.integer({ min: 0, max: 100000 }),
        fc.constantFrom(...STAGES),
        async (base, kind, seed, stage) => {
          const raw = injectMalformed(base, kind, seed);

          // Precondition: the injected plan really is invalid.
          fc.pre(validatePlan(parsePlan(raw), raw).length > 0);

          const repo = newRepo();
          const slug = 'sample';
          writeLegacySpec(repo, slug, raw);

          const queue = spyingQueue();
          const registry = createToolRegistry(makeServices(repo, queue));
          const phase = base.phases[seed % base.phases.length].id;

          const result = await registry.call(
            'run',
            { slug, phase, stage },
            undefined,
            makeGuard(repo),
            'drive',
          );

          // The dispatch is refused with an error (Req 4.9)...
          assert.strictEqual(
            result.ok,
            false,
            `invalid document must not dispatch stage "${stage}"\n---\n${raw}`,
          );
          if (!result.ok) {
            assert.match(
              result.error,
              /invalid/i,
              'the refusal surfaces that the document is invalid',
            );
          }
          // ...and the run queue was never reached for any stage (Req 4.9).
          assert.strictEqual(
            queue.calls.length,
            0,
            'an invalid document must never reach the run queue',
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  // Positive control: the same gate lets a clean plan through, so it is not a
  // blanket refusal.
  // Feature: baiton-first-pass, Property 5: Invalid plans block every stage
  it('allows dispatch for a clean, valid plan (positive control)', async () => {
    await fc.assert(
      fc.asyncProperty(
        legacyDocumentArb,
        fc.integer({ min: 0, max: 100000 }),
        fc.constantFrom(...STAGES),
        async (base, seed, stage) => {
          const raw = renderLegacyDocument(base.overview, base.phases.map(renderLegacyPhase));

          // Precondition: the base plan is valid.
          fc.pre(validatePlan(parsePlan(raw), raw).length === 0);

          const repo = newRepo();
          const slug = 'sample';
          writeLegacySpec(repo, slug, raw);

          const queue = spyingQueue();
          const registry = createToolRegistry(makeServices(repo, queue));
          const phase = base.phases[seed % base.phases.length].id;

          const result = await registry.call(
            'run',
            { slug, phase, stage },
            undefined,
            makeGuard(repo),
            'drive',
          );

          // A valid plan reaches the queue and the dispatch succeeds.
          assert.strictEqual(
            result.ok,
            true,
            `a valid document must dispatch stage "${stage}"\n---\n${raw}`,
          );
          assert.strictEqual(
            queue.calls.length,
            1,
            'a valid document dispatches exactly once',
          );
        },
      ),
      { numRuns: 100 },
    );
  });
});
