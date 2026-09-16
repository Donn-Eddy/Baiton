import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as fsp from 'fs/promises';
import * as fc from 'fast-check';
import {
  guardTool,
  IdempotencyStore,
  Tool,
  ToolContext,
  ToolResult,
  GuardContext,
} from '../src/orchestrator/guard';

/**
 * Property test for the guard's idempotency of mutating tool calls
 * (Requirement 8.5, design "Orchestrator: tool registry and guard").
 *
 * Feature: baiton-first-pass, Property 11: Mutating tool calls are idempotent
 * under a repeated key
 *
 * For any mutating tool call, invoking it twice with the same idempotency key
 * (the model's tool-call id) leaves file state identical to invoking it once
 * and returns, on the second invocation, a result identical to the first
 * (Requirement 8.5). The guard achieves this by remembering the first result
 * per key in the {@link IdempotencyStore} and replaying it without re-running
 * the wrapped tool on a repeated key. A distinct key must run the tool again.
 *
 * The test builds a fake mutating tool whose `run` records how many times it
 * executed and mutates an in-memory state file (a temp file whose contents are
 * a monotonically increasing call counter), returning a result derived from
 * that state. Across many random keys, prompts, and repeat counts it asserts:
 *   - the wrapped tool's `run` executes exactly once per distinct key;
 *   - the state after N calls with one key equals the state after a single
 *     call with that key (no additional mutation);
 *   - the second (and later) `ToolResult` deep-equals the first;
 *   - a fresh, distinct key does run the tool again (guard is not a global no-op).
 */

/** A non-empty, non-whitespace tool-call id used as the idempotency key. */
const callIdArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 24 })
  .filter((s) => s.trim().length > 0);

/** An arbitrary payload the tool echoes back in its result. */
const argArb: fc.Arbitrary<string> = fc.string({ minLength: 0, maxLength: 40 });

/** How many extra times the same key is replayed (>= 1 total invocation). */
const repeatArb: fc.Arbitrary<number> = fc.integer({ min: 1, max: 5 });

/**
 * A GuardContext is required by ToolContext but this property exercises only
 * the idempotency path, which never touches the workspace path helpers. A
 * fixed, harmless context suffices.
 */
function makeCtx(): GuardContext {
  return new GuardContext({
    repoRoot: path.resolve('/tmp/baiton-guard-idempotency'),
    specsDir: path.resolve('/tmp/baiton-guard-idempotency/.baiton/specs'),
    restricted: false,
  });
}

/**
 * A fake mutating tool. Each real `run` increments an on-disk counter (the
 * "file state") and a private call counter, returning a result that embeds the
 * observed counter and the echoed argument. If the guard ever ran it twice for
 * one key, the counter — and therefore the result — would differ.
 */
function makeCountingTool(statePath: string): {
  tool: Tool;
  runCount: () => number;
} {
  let runs = 0;
  const tool: Tool = {
    name: 'fake_mutating',
    description: 'fake mutating tool for the idempotency harness',
    mutating: true,
    phases: ['gather', 'drive'],
    schema: {},
    async run(args: unknown, _tc: ToolContext): Promise<ToolResult> {
      runs += 1;
      // Mutate the "file state": read the current counter, bump it, write back.
      let current = 0;
      try {
        current = Number.parseInt(await fsp.readFile(statePath, 'utf8'), 10) || 0;
      } catch {
        current = 0;
      }
      const next = current + 1;
      await fsp.writeFile(statePath, String(next), 'utf8');
      return { ok: true, data: { counter: next, echoed: args } };
    },
  };
  return { tool, runCount: () => runs };
}

describe('Guard idempotency of mutating calls (property harness)', () => {
  // Feature: baiton-first-pass, Property 11: Mutating tool calls are idempotent
  // under a repeated key
  it('runs a mutating tool once per key, leaving state and result stable on repeat', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'baiton-idem-'));
    try {
      await fc.assert(
        fc.asyncProperty(
          callIdArb,
          argArb,
          repeatArb,
          callIdArb,
          async (callId, arg, repeat, otherId) => {
            // Fresh state, store, and tool per case so keys never collide across runs.
            const statePath = path.join(
              tmpDir,
              `state-${Math.random().toString(36).slice(2)}.txt`,
            );
            const store = new IdempotencyStore();
            const { tool, runCount } = makeCountingTool(statePath);
            const guarded = guardTool(tool, store);
            const ctx = makeCtx();

            // First invocation with the key: the tool runs and mutates state once.
            const first = await guarded(arg, { callId, ctx });
            const stateAfterFirst = await fsp.readFile(statePath, 'utf8');
            assert.strictEqual(
              runCount(),
              1,
              'tool must run exactly once on the first call',
            );

            // Repeated invocations with the SAME key: no re-run, no mutation.
            for (let i = 0; i < repeat; i++) {
              const again = await guarded(arg, { callId, ctx });
              // Second (and later) result deep-equals the first.
              assert.deepStrictEqual(
                again,
                first,
                'repeated key must replay the identical first result',
              );
            }

            // The tool's run executed only once across all same-key calls.
            assert.strictEqual(
              runCount(),
              1,
              'repeated key must not re-execute the tool',
            );

            // File state after N same-key calls equals state after exactly one call.
            const stateAfterRepeat = await fsp.readFile(statePath, 'utf8');
            assert.strictEqual(
              stateAfterRepeat,
              stateAfterFirst,
              'repeated key must leave file state identical to a single call',
            );

            // A distinct key DOES run the tool again (guard is per-key, not global).
            if (otherId !== callId) {
              const other = await guarded(arg, { callId: otherId, ctx });
              assert.strictEqual(
                runCount(),
                2,
                'a distinct key must re-execute the tool',
              );
              assert.notDeepStrictEqual(
                other,
                first,
                'a distinct key must produce a fresh result reflecting new state',
              );
            }
          },
        ),
        { numRuns: 200 },
      );
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
