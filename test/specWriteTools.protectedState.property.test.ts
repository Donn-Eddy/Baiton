import * as assert from 'assert';
import * as fc from 'fast-check';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createSpecWriteTools } from '../src/orchestrator/specWriteTools';
import { GuardContext, Tool, ToolResult } from '../src/orchestrator/guard';
import { ToolServices } from '../src/orchestrator/toolServices';
import { GitService, GitStatus } from '../src/git';
import { Result, ok } from '../src/model/result';
import { RunDispatchOutcome, RunDispatchRequest } from '../src/orchestrator/seams';
import { TODO_STATES, TodoState } from '../src/model/todoState';

/**
 * Feature: baiton-first-pass, Property 13: Protected-state todos reject edit and remove
 *
 * For any todo whose state is `done`, `failed`, `planning`, `executing`, or
 * `reviewing`, the `edit_todo` and `remove_todo` tools refuse the change and
 * leave the todo line unchanged, and accept it otherwise (`pending`, `planned`,
 * `executed`).
 *
 * Validates: Requirements 9.8
 *
 * The property builds a temp repo containing a `.baiton/specs/<slug>/spec.md`
 * whose TODOS section carries one todo in every one of the eight lifecycle
 * states, then invokes `edit_todo` and `remove_todo` against a randomly chosen
 * todo. It asserts:
 *  - state ∈ {done, failed, planning, executing, reviewing}  →  ToolResult error
 *    AND the spec file on disk is byte-for-byte unchanged (the todo line stays);
 *  - state ∈ {pending, planned, executed}                    →  ToolResult ok
 *    AND the on-disk spec reflects the change (title rewritten / line removed).
 *
 * The tools are built against a stub git whose `commit` returns a fixed sha and
 * a {@link GuardContext} rooted at the temp repo so path containment resolves.
 */

/** States a protected todo cannot be edited or removed from (Req 9.8). */
const PROTECTED: ReadonlySet<TodoState> = new Set<TodoState>([
  'done',
  'failed',
  'planning',
  'executing',
  'reviewing',
]);

/** A git stub: `commit` yields a fixed sha; nothing else is exercised here. */
function stubGit(): GitService {
  const notUsed = (name: string) => (): never => {
    throw new Error(`stub git: ${name} not expected in this test`);
  };
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
    findCommitByRunId: notUsed('findCommitByRunId'),
    push: async () => undefined,
    remoteUrl: async () => '',
  };
}

/** A confirm seam that always affirms (unused by edit/remove; needed to build). */
const alwaysConfirm = { confirm: async (): Promise<boolean> => true };

/** A run queue seam that is never called by edit/remove. */
const noRunQueue = {
  dispatch: async (_req: RunDispatchRequest): Promise<RunDispatchOutcome> => ({
    kind: 'busy' as const,
  }),
};

/** Build {@link ToolServices} rooted at `repoRoot` with a stub git. */
function makeServices(repoRoot: string): ToolServices {
  return {
    repoRoot,
    baitonDir: path.join(repoRoot, '.baiton'),
    git: stubGit(),
    confirm: alwaysConfirm,
    runQueue: noRunQueue,
    clock: { now: () => '2024-01-01T00:00:00.000Z' },
    ids: { next: () => 'id-1' },
    gitSettings: { remote: 'origin', base: 'main' },
  };
}

/** A {@link GuardContext} rooted at the temp repo (trusted, writes allowed). */
function makeGuard(repoRoot: string): GuardContext {
  return new GuardContext({
    repoRoot,
    specsDir: path.join(repoRoot, '.baiton', 'specs'),
    restricted: false,
  });
}

/** Look up a tool by name from the built registry. */
function toolByName(tools: Tool[], name: string): Tool {
  const t = tools.find((x) => x.name === name);
  assert.ok(t !== undefined, `tool "${name}" must exist`);
  return t;
}

/**
 * Render a spec.md containing one todo per state. Returns the text and the map
 * of assigned id → state so the property knows each todo's protection status.
 */
function renderSpecAllStates(): { text: string; idStates: { id: string; state: TodoState }[] } {
  const lines: string[] = [];
  lines.push('---');
  lines.push('version: 1');
  lines.push('name: sample');
  lines.push('status: draft');
  lines.push('---');
  lines.push('');
  lines.push('# OVERVIEW');
  lines.push('');
  lines.push('A sample spec exercising every todo lifecycle state.');
  lines.push('');
  lines.push('# TODOS');
  lines.push('');
  const idStates: { id: string; state: TodoState }[] = [];
  TODO_STATES.forEach((state, i) => {
    const id = `T${String(i + 1).padStart(2, '0')}`;
    idStates.push({ id, state });
    lines.push(`- [${state}] ${id} Todo in ${state} state`);
  });
  lines.push('');
  return { text: lines.join('\n'), idStates };
}

/** Create a fresh temp repo with a spec.md covering every state. */
function makeRepoWithSpec(slug: string): {
  repoRoot: string;
  specFile: string;
  idStates: { id: string; state: TodoState }[];
} {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-prot-'));
  const specDir = path.join(repoRoot, '.baiton', 'specs', slug);
  fs.mkdirSync(specDir, { recursive: true });
  const { text, idStates } = renderSpecAllStates();
  const specFile = path.join(specDir, 'spec.md');
  fs.writeFileSync(specFile, text, 'utf8');
  return { repoRoot, specFile, idStates };
}

describe('spec-writing tools: protected-state edit/remove rejection (property)', () => {
  it('Property 13: edit_todo/remove_todo refuse protected states and accept others', async () => {
    const slug = 'sample';
    let callSeq = 0;

    await fc.assert(
      fc.asyncProperty(
        // Pick which todo (by index into the eight states) and which tool.
        fc.nat({ max: TODO_STATES.length - 1 }),
        fc.constantFrom<'edit_todo' | 'remove_todo'>('edit_todo', 'remove_todo'),
        fc.string({ minLength: 1, maxLength: 30 }),
        async (todoPick, toolName, rawTitle) => {
          const { repoRoot, specFile, idStates } = makeRepoWithSpec(slug);
          try {
            const services = makeServices(repoRoot);
            const guard = makeGuard(repoRoot);
            const tools = createSpecWriteTools(services);
            const tool = toolByName(tools, toolName);

            const target = idStates[todoPick];
            const before = fs.readFileSync(specFile, 'utf8');

            // A distinct idempotency key per invocation so the guard never
            // replays a prior stored result across property runs.
            const callId = `call-${callSeq++}`;
            // A title free of hint/section-reserved characters so edit_todo
            // round-trips cleanly when accepted.
            const title = rawTitle.replace(/[()\n\r;]/g, ' ').trim() || 'edited title';

            const args =
              toolName === 'edit_todo'
                ? { slug, id: target.id, title }
                : { slug, id: target.id };

            const result: ToolResult = await tool.run(args, { callId, ctx: guard });
            const after = fs.readFileSync(specFile, 'utf8');

            if (PROTECTED.has(target.state)) {
              // Refused: error result AND the file is byte-for-byte unchanged.
              assert.strictEqual(
                result.ok,
                false,
                `${toolName} on ${target.state} todo ${target.id} must be refused`,
              );
              if (!result.ok) {
                assert.match(
                  result.error,
                  /protected state/i,
                  'error must indicate a protected state',
                );
              }
              assert.strictEqual(
                after,
                before,
                `${toolName} on protected ${target.state} must leave the todo line unchanged`,
              );
            } else {
              // Accepted: ok result AND the on-disk spec reflects the change.
              assert.strictEqual(
                result.ok,
                true,
                `${toolName} on ${target.state} todo ${target.id} must be accepted`,
              );
              assert.notStrictEqual(
                after,
                before,
                `${toolName} on ${target.state} must change the spec file`,
              );
              if (toolName === 'remove_todo') {
                assert.ok(
                  !after.includes(` ${target.id} `),
                  `remove_todo must delete the ${target.id} line`,
                );
              } else {
                assert.ok(
                  after.includes(`- [${target.state}] ${target.id} ${title}`),
                  'edit_todo must rewrite the title while preserving the state',
                );
              }
            }
          } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: 120 },
    );
  });
});
