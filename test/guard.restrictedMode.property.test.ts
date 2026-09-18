import * as assert from 'assert';
import * as path from 'path';
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
 * Property test for Restricted Mode disabling writes and dispatch
 * (Requirements 22.1, 22.2, design "Orchestrator: tool registry and guard").
 *
 * Feature: baiton-first-pass, Property 26: Restricted mode disables writes and dispatch
 *
 * For any tool, when the workspace is in Restricted Mode, every mutating
 * ("write") tool and every dispatch tool is disabled: the guarded call returns
 * an error and the tool's `run` never executes (Requirements 22.1, 22.2), while
 * a read tool (neither mutating nor dispatch) still runs normally. The mirror
 * case anchors the property: when the workspace is NOT restricted, the same
 * write/dispatch tools run.
 *
 * The test builds fake tools with independently varied `mutating` and
 * `dispatch` flags, each tracking a `ran` flag its `run` sets on execution. It
 * wraps each with {@link guardTool} and invokes it under a restricted context,
 * asserting:
 *   - a mutating-or-dispatch tool returns `ok: false` and its `ran` flag stays
 *     false (nothing executed);
 *   - a pure read tool (mutating=false, dispatch=false) returns `ok: true` and
 *     its `ran` flag is set;
 *   - under a non-restricted context, the same write/dispatch tool runs
 *     (`ran` set) and returns success given a valid idempotency key.
 */

/** A tool name, kept simple and non-empty for readable failure messages. */
const nameArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 16 })
  .filter((s) => s.trim().length > 0);

/** A non-empty idempotency key, required for mutating calls when unrestricted. */
const callIdArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 24 })
  .filter((s) => s.trim().length > 0);

/**
 * A fake tool whose `run` flips a `ran` flag when (and only when) it executes.
 * The flag lets the test prove the guard blocked execution entirely rather than
 * merely masking a result.
 */
function makeTool(
  name: string,
  mutating: boolean,
  dispatch: boolean,
): { tool: Tool; didRun: () => boolean } {
  let ran = false;
  const tool: Tool = {
    name,
    description: 'fake tool for the restricted-mode guard harness',
    mutating,
    dispatch,
    phases: ['gather', 'drive'],
    schema: {},
    async run(_args: unknown, _tc: ToolContext): Promise<ToolResult> {
      ran = true;
      return { ok: true, data: { name } };
    },
  };
  return { tool, didRun: () => ran };
}

/** A GuardContext with the given Restricted Mode flag; paths are unused here. */
function makeCtx(restricted: boolean): GuardContext {
  return new GuardContext({
    repoRoot: path.resolve('/tmp/baiton-guard-restricted'),
    specsDir: path.resolve('/tmp/baiton-guard-restricted/.baiton/specs'),
    restricted,
  });
}

describe('Guard Restricted Mode disabling (property harness)', () => {
  // Feature: baiton-first-pass, Property 26: Restricted mode disables writes and dispatch
  it('disables every write and dispatch tool while a read tool still runs, under Restricted Mode', async () => {
    await fc.assert(
      fc.asyncProperty(
        nameArb,
        fc.boolean(),
        fc.boolean(),
        callIdArb,
        async (name, mutating, dispatch, callId) => {
          const isWriteOrDispatch = mutating || dispatch;

          // --- Restricted Mode: write/dispatch disabled, read allowed. ---
          {
            const store = new IdempotencyStore();
            const { tool, didRun } = makeTool(name, mutating, dispatch);
            const guarded = guardTool(tool, store);
            const ctx = makeCtx(true);

            const result = await guarded({}, { callId, ctx });

            if (isWriteOrDispatch) {
              assert.strictEqual(
                result.ok,
                false,
                'a write/dispatch tool must return an error under Restricted Mode',
              );
              assert.strictEqual(
                didRun(),
                false,
                'a write/dispatch tool must not execute under Restricted Mode',
              );
            } else {
              // A pure read tool (neither mutating nor dispatch) still runs.
              assert.strictEqual(
                result.ok,
                true,
                'a read tool must remain allowed under Restricted Mode',
              );
              assert.strictEqual(
                didRun(),
                true,
                'a read tool must execute under Restricted Mode',
              );
            }
          }

          // --- Not restricted: the same write/dispatch tool runs. ---
          if (isWriteOrDispatch) {
            const store = new IdempotencyStore();
            const { tool, didRun } = makeTool(name, mutating, dispatch);
            const guarded = guardTool(tool, store);
            const ctx = makeCtx(false);

            // A mutating tool needs an idempotency key; a pure dispatch tool
            // (mutating=false) carries none. Supply the key either way; the
            // guard ignores it for a non-mutating dispatch tool.
            const result = await guarded({}, { callId, ctx });

            assert.strictEqual(
              result.ok,
              true,
              'a write/dispatch tool must run when the workspace is not restricted',
            );
            assert.strictEqual(
              didRun(),
              true,
              'a write/dispatch tool must execute when not restricted',
            );
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
