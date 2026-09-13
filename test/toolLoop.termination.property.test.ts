import * as assert from 'assert';
import * as fc from 'fast-check';
import {
  runToolLoop,
  resolveRoundBound,
  ToolLoopDeps,
  DEFAULT_ROUND_BOUND,
} from '../src/orchestrator/toolLoop';
import {
  ChatMessage,
  CompletionRequest,
  CompletionResult,
  ModelClient,
  ToolCall,
} from '../src/orchestrator/modelClient';
import { ToolResult } from '../src/orchestrator/guard';

/**
 * Property test for the host-side tool loop's termination guarantee
 * (Requirements 9.5, 9.6, 20.3, design Property 2).
 *
 * Feature: baiton-ui-first-pass, Property 2: Tool loop terminates within the
 * round bound
 *
 * For any sequence of model replies — including replies that always return tool
 * calls — the tool loop SHALL perform at most Round_Bound model completions and
 * then stop, appending the round-bound notice when it stops for having reached
 * the bound.
 *
 * The test drives `runToolLoop` with a fake `ModelClient` that replays a
 * generated reply sequence (empty replies, tool-call replies, and always-tool-
 * call replies) and a fake `call` that answers every tool invocation. It counts
 * the completions the loop performs and asserts the count never exceeds the
 * resolved Round_Bound, and that the round-bound notice is the final appended
 * message exactly when the bound was reached.
 */

/** The round-bound notice text the loop appends when it stops on the bound. */
const ROUND_BOUND_NOTICE =
  'The orchestrator reached the maximum number of tool-loop rounds and stopped.';

/** A single generated model reply: either no tool calls, or one tool call. */
type Reply = { kind: 'text'; content: string } | { kind: 'tool'; callName: string };

/**
 * A fake ModelClient that replays `replies` in order, counting the completions
 * it serves. Once the scripted replies run out it keeps returning a tool call so
 * the loop is forced to run to the round bound (the "always tool calls" case).
 */
class FakeClient implements ModelClient {
  public completions = 0;
  private readonly replies: Reply[];

  constructor(replies: Reply[]) {
    this.replies = replies;
  }

  async complete(_req: CompletionRequest): Promise<CompletionResult> {
    const reply = this.replies[this.completions] ?? { kind: 'tool', callName: 'always' };
    this.completions += 1;
    if (reply.kind === 'text') {
      return { content: reply.content, tool_calls: [] };
    }
    const toolCall: ToolCall = {
      id: `call-${this.completions}`,
      name: reply.callName,
      arguments: '{}',
    };
    return { content: undefined, tool_calls: [toolCall] };
  }
}

/** A generator over a single reply. */
const replyArb: fc.Arbitrary<Reply> = fc.oneof(
  fc.record({ kind: fc.constant<'text'>('text'), content: fc.string({ maxLength: 20 }) }),
  fc.record({
    kind: fc.constant<'tool'>('tool'),
    callName: fc.string({ minLength: 1, maxLength: 8 }).filter((s) => s.trim().length > 0),
  }),
);

describe('Tool loop termination (property harness)', () => {
  // Feature: baiton-ui-first-pass, Property 2: Tool loop terminates within the
  // round bound
  it('performs at most Round_Bound completions and appends the bound notice on the bound', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(replyArb, { maxLength: 30 }),
        // A configured round bound value spanning invalid and valid inputs.
        fc.oneof(
          fc.integer({ min: 1, max: 8 }),
          fc.constant(undefined),
          fc.constant(0),
          fc.integer({ min: -5, max: 0 }),
          fc.constant(3.5),
        ),
        async (replies, configured) => {
          const client = new FakeClient(replies);
          const roundBound = resolveRoundBound(configured);

          // A fake `call` that always succeeds, keyed by the model's call id.
          const seenCallIds: string[] = [];
          const call = async (
            _name: string,
            _args: string,
            callId: string,
            _signal: AbortSignal,
          ): Promise<ToolResult> => {
            seenCallIds.push(callId);
            return { ok: true, data: 'done' };
          };

          const appended: ChatMessage[] = [];
          const deps: ToolLoopDeps = {
            client,
            tools: [],
            call,
            systemPrompt: async () => 'system',
            append: async (msg) => {
              appended.push({
                role: msg.role,
                content: msg.content,
                ...(msg.tool_call_id !== undefined ? { tool_call_id: msg.tool_call_id } : {}),
              });
            },
            roundBound,
            signal: new AbortController().signal,
          };

          const history: ChatMessage[] = [{ role: 'user', content: 'hello' }];
          await runToolLoop(history, deps);

          // The resolved bound is always positive; invalid config falls back to 20.
          assert.ok(roundBound >= 1);
          if (
            configured === undefined ||
            (typeof configured === 'number' && (!Number.isInteger(configured) || configured < 1))
          ) {
            assert.strictEqual(roundBound, DEFAULT_ROUND_BOUND);
          }

          // The loop performs at most Round_Bound completions (Req 9.6).
          assert.ok(
            client.completions <= roundBound,
            `completions ${client.completions} exceeded roundBound ${roundBound}`,
          );

          // The loop terminated: `runToolLoop` resolved, and it appended at least
          // one message (the ending assistant text, notice, or tool results).
          assert.ok(appended.length > 0);

          // Determine whether the loop should have ended early on a no-tool reply
          // within the bound, or run to the bound. The FakeClient serves scripted
          // replies in order and, once they run out, keeps returning a tool call —
          // so only a scripted `text` reply within the first `roundBound` rounds
          // ends the loop early (a run-out index behaves as an always-tool reply).
          let endedEarlyAt = -1;
          for (let i = 0; i < roundBound; i += 1) {
            const reply = replies[i];
            if (reply !== undefined && reply.kind === 'text') {
              endedEarlyAt = i;
              break;
            }
          }

          const last = appended[appended.length - 1];
          if (endedEarlyAt >= 0) {
            // Ended early: exactly endedEarlyAt+1 completions, no bound notice.
            assert.strictEqual(client.completions, endedEarlyAt + 1);
            assert.notStrictEqual(
              last.content,
              ROUND_BOUND_NOTICE,
              'bound notice must not appear when the loop ended on a no-tool reply',
            );
          } else {
            // Ran to the bound: exactly roundBound completions and the bound notice.
            assert.strictEqual(client.completions, roundBound);
            assert.strictEqual(
              last.content,
              ROUND_BOUND_NOTICE,
              'the round-bound notice must be the final appended message on the bound',
            );
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
