import * as assert from 'assert';
import {
  runToolLoop,
  resolveRoundBound,
  ToolLoopDeps,
  DEFAULT_ROUND_BOUND,
} from '../src/orchestrator/toolLoop';
import { ChatMessage, CompletionRequest, CompletionResult, ModelClient } from '../src/orchestrator/modelClient';
import { ToolResult } from '../src/orchestrator/guard';
import { TranscriptRecord } from '../src/orchestrator/chatTranscript';

/**
 * Unit tests for the host-side tool loop mechanics and round-bound resolution
 * (Task 6.3). These exercise the concrete behaviors the design pins down for
 * `runToolLoop` and `resolveRoundBound`, driving the loop through injected seams
 * with no VS Code host:
 *
 * - each returned tool call is run through `call` with the model's tool-call id
 *   as the idempotency key (Req 9.2)
 * - a successful tool result is appended as a `tool` message carrying that id and
 *   the loop continues to a next completion (Req 9.3)
 * - a failed/throwing tool result is appended as an error `tool` message carrying
 *   that id and the loop continues (Req 9.4)
 * - a completion with no tool calls appends the assistant text and ends (Req 9.5)
 * - the loop performs at most `roundBound` completions and, on reaching the bound,
 *   appends a round-bound notice and stops (Req 9.6)
 * - an abort through the injected signal appends a stopped notice and ends (Req 14.7)
 * - `resolveRoundBound` returns a configured positive integer, else 20, for unset,
 *   `0`, negative, non-integer and valid inputs (Req 9.6)
 *
 * A scripted `ModelClient` returns a queued sequence of completions and records
 * every request it received, so the messages the loop sent (system prompt +
 * history including appended tool results) are directly assertable.
 */

/** The notices the loop appends, kept in sync with the module under test. */
const ROUND_BOUND_NOTICE =
  'The orchestrator reached the maximum number of tool-loop rounds and stopped.';
const STOPPED_NOTICE = 'The run was stopped.';

/** A scripted model client that yields queued completions and captures requests. */
class ScriptedClient implements ModelClient {
  public readonly requests: CompletionRequest[] = [];
  private readonly queue: CompletionResult[];

  constructor(queue: CompletionResult[]) {
    this.queue = [...queue];
  }

  public async complete(req: CompletionRequest): Promise<CompletionResult> {
    this.requests.push(req);
    const next = this.queue.shift();
    if (next === undefined) {
      throw new Error('ScriptedClient ran out of queued completions');
    }
    return next;
  }
}

/** Records every `call`/`append` the loop makes for later assertions. */
interface CallRecord {
  name: string;
  args: string;
  callId: string;
}

/** Builds `ToolLoopDeps` with sensible defaults over the injected seams. */
function makeDeps(
  overrides: Partial<ToolLoopDeps> & { client: ModelClient },
): {
  deps: ToolLoopDeps;
  appended: Array<Omit<TranscriptRecord, 'ts'>>;
  calls: CallRecord[];
} {
  const appended: Array<Omit<TranscriptRecord, 'ts'>> = [];
  const calls: CallRecord[] = [];
  const deps: ToolLoopDeps = {
    client: overrides.client,
    tools: overrides.tools ?? [],
    call:
      overrides.call ??
      (async (name, args, callId): Promise<ToolResult> => {
        calls.push({ name, args, callId });
        return { ok: true, data: 'ok' };
      }),
    systemPrompt: overrides.systemPrompt ?? (async (): Promise<string> => 'SYS'),
    append:
      overrides.append ??
      (async (msg): Promise<void> => {
        appended.push(msg);
      }),
    roundBound: overrides.roundBound ?? DEFAULT_ROUND_BOUND,
    signal: overrides.signal ?? new AbortController().signal,
    ...(overrides.sessionId !== undefined ? { sessionId: overrides.sessionId } : {}),
  };
  return { deps, appended, calls };
}

/** A completion that requests a single tool call. */
function toolCallCompletion(
  id: string,
  name: string,
  args: string,
  content?: string,
): CompletionResult {
  return { content, tool_calls: [{ id, name, arguments: args }] };
}

/** A completion that requests no tool calls (ends the loop). */
function finalCompletion(content: string): CompletionResult {
  return { content, tool_calls: [] };
}

describe('runToolLoop', () => {
  it('invokes call with the model tool-call id as the idempotency key', async () => {
    const client = new ScriptedClient([
      toolCallCompletion('call_42', 'read_file', '{"path":"a.txt"}'),
      finalCompletion('done'),
    ]);
    const { deps, calls } = makeDeps({ client });

    await runToolLoop([{ role: 'user', content: 'hi' }], deps);

    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0], {
      name: 'read_file',
      args: '{"path":"a.txt"}',
      callId: 'call_42',
    });
  });

  it('appends a success result as a tool message carrying the call id and re-calls', async () => {
    const client = new ScriptedClient([
      toolCallCompletion('call_1', 'read_file', '{}'),
      finalCompletion('all set'),
    ]);
    const { deps, appended } = makeDeps({
      client,
      call: async (): Promise<ToolResult> => ({ ok: true, data: 'file contents' }),
    });
    const history: ChatMessage[] = [{ role: 'user', content: 'read it' }];

    await runToolLoop(history, deps);

    // The tool result was appended as a `tool` message carrying the call id.
    const toolMsg = appended.find((m) => m.role === 'tool');
    assert.ok(toolMsg, 'expected a tool message to be appended');
    assert.strictEqual(toolMsg!.tool_call_id, 'call_1');
    assert.strictEqual(toolMsg!.content, 'file contents');

    // The loop re-called the model: two completions were requested.
    assert.strictEqual((client as ScriptedClient).requests.length, 2);

    // The final assistant text ends the loop.
    assert.strictEqual(appended[appended.length - 1].role, 'assistant');
    assert.strictEqual(appended[appended.length - 1].content, 'all set');
  });

  it('serializes a non-string success payload as JSON in the tool message', async () => {
    const client = new ScriptedClient([
      toolCallCompletion('call_j', 'list', '{}'),
      finalCompletion('done'),
    ]);
    const { deps, appended } = makeDeps({
      client,
      call: async (): Promise<ToolResult> => ({ ok: true, data: { items: [1, 2] } }),
    });

    await runToolLoop([{ role: 'user', content: 'list' }], deps);

    const toolMsg = appended.find((m) => m.role === 'tool');
    assert.ok(toolMsg);
    assert.strictEqual(toolMsg!.content, JSON.stringify({ items: [1, 2] }));
  });

  it('appends a failure result as an error tool message carrying the call id and re-calls', async () => {
    const client = new ScriptedClient([
      toolCallCompletion('call_err', 'write_file', '{}'),
      finalCompletion('recovered'),
    ]);
    const { deps, appended } = makeDeps({
      client,
      call: async (): Promise<ToolResult> => ({ ok: false, error: 'permission denied' }),
    });

    await runToolLoop([{ role: 'user', content: 'write' }], deps);

    const toolMsg = appended.find((m) => m.role === 'tool');
    assert.ok(toolMsg, 'expected a tool message to be appended');
    assert.strictEqual(toolMsg!.tool_call_id, 'call_err');
    assert.match(toolMsg!.content, /permission denied/);
    assert.match(toolMsg!.content, /^Error:/);

    // The loop continued after the failure to a second completion.
    assert.strictEqual((client as ScriptedClient).requests.length, 2);
  });

  it('turns a thrown tool failure into an error tool message and continues', async () => {
    const client = new ScriptedClient([
      toolCallCompletion('call_throw', 'boom', '{}'),
      finalCompletion('after throw'),
    ]);
    const { deps, appended } = makeDeps({
      client,
      call: async (): Promise<ToolResult> => {
        throw new Error('unexpected crash');
      },
    });

    await runToolLoop([{ role: 'user', content: 'go' }], deps);

    const toolMsg = appended.find((m) => m.role === 'tool');
    assert.ok(toolMsg);
    assert.strictEqual(toolMsg!.tool_call_id, 'call_throw');
    assert.match(toolMsg!.content, /unexpected crash/);
    assert.strictEqual((client as ScriptedClient).requests.length, 2);
  });

  it('ends the loop on a completion with no tool calls, appending the assistant text', async () => {
    const client = new ScriptedClient([finalCompletion('hello there')]);
    const { deps, appended, calls } = makeDeps({ client });

    await runToolLoop([{ role: 'user', content: 'hi' }], deps);

    assert.strictEqual(calls.length, 0);
    assert.strictEqual(appended.length, 1);
    assert.deepStrictEqual(appended[0], { role: 'assistant', content: 'hello there' });
    assert.strictEqual((client as ScriptedClient).requests.length, 1);
  });

  it('appends empty assistant content when the final completion carries no text', async () => {
    const client = new ScriptedClient([{ tool_calls: [] }]);
    const { deps, appended } = makeDeps({ client });

    await runToolLoop([{ role: 'user', content: 'hi' }], deps);

    assert.deepStrictEqual(appended, [{ role: 'assistant', content: '' }]);
  });

  it('records the assistant text on a tool-calling turn when present', async () => {
    const client = new ScriptedClient([
      toolCallCompletion('call_c', 'read_file', '{}', 'let me check'),
      finalCompletion('done'),
    ]);
    const { deps, appended } = makeDeps({ client });

    await runToolLoop([{ role: 'user', content: 'go' }], deps);

    // The assistant text that accompanied the tool call was appended before the tool message.
    const assistantIdx = appended.findIndex(
      (m) => m.role === 'assistant' && m.content === 'let me check',
    );
    const toolIdx = appended.findIndex((m) => m.role === 'tool');
    assert.ok(assistantIdx >= 0, 'expected the accompanying assistant text to be appended');
    assert.ok(toolIdx > assistantIdx, 'tool message should follow the assistant text');
  });

  it('rebuilds the system prompt each round and prepends it to the history', async () => {
    const client = new ScriptedClient([
      toolCallCompletion('call_s', 'read_file', '{}'),
      finalCompletion('done'),
    ]);
    let promptCalls = 0;
    const { deps } = makeDeps({
      client,
      systemPrompt: async (): Promise<string> => {
        promptCalls += 1;
        return `SYS-${promptCalls}`;
      },
    });

    await runToolLoop([{ role: 'user', content: 'go' }], deps);

    // Two rounds ran, so the prompt was rebuilt twice.
    assert.strictEqual(promptCalls, 2);
    const first = (client as ScriptedClient).requests[0].messages[0];
    assert.deepStrictEqual(first, { role: 'system', content: 'SYS-1' });
    const second = (client as ScriptedClient).requests[1].messages[0];
    assert.deepStrictEqual(second, { role: 'system', content: 'SYS-2' });
  });

  it('stops with a round-bound notice when the bound is reached without a tool-call-free completion', async () => {
    // Every completion keeps requesting a tool call, so the loop never ends on its own.
    const client = new ScriptedClient([
      toolCallCompletion('c1', 'read_file', '{}'),
      toolCallCompletion('c2', 'read_file', '{}'),
    ]);
    const { deps, appended } = makeDeps({ client, roundBound: 2 });

    await runToolLoop([{ role: 'user', content: 'go' }], deps);

    // Exactly `roundBound` completions were requested.
    assert.strictEqual((client as ScriptedClient).requests.length, 2);
    // The last appended message is the round-bound notice.
    const last = appended[appended.length - 1];
    assert.deepStrictEqual(last, { role: 'assistant', content: ROUND_BOUND_NOTICE });
  });

  it('appends a stopped notice and ends when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const client = new ScriptedClient([]);
    const { deps, appended } = makeDeps({ client, signal: controller.signal });

    await runToolLoop([{ role: 'user', content: 'go' }], deps);

    // No completion was ever requested.
    assert.strictEqual((client as ScriptedClient).requests.length, 0);
    assert.deepStrictEqual(appended, [{ role: 'assistant', content: STOPPED_NOTICE }]);
  });

  it('appends a stopped notice when aborted mid-flight after a completion', async () => {
    const controller = new AbortController();
    const client = new ScriptedClient([
      toolCallCompletion('call_mid', 'read_file', '{}'),
    ]);
    // Abort while the tool call runs, so the loop observes it before the next round.
    const { deps, appended } = makeDeps({
      client,
      signal: controller.signal,
      call: async (): Promise<ToolResult> => {
        controller.abort();
        return { ok: true, data: 'partial' };
      },
    });

    await runToolLoop([{ role: 'user', content: 'go' }], deps);

    // The loop stopped rather than requesting a second completion.
    assert.strictEqual((client as ScriptedClient).requests.length, 1);
    const last = appended[appended.length - 1];
    assert.deepStrictEqual(last, { role: 'assistant', content: STOPPED_NOTICE });
  });

  it('threads sessionId onto every completion when the dep is supplied', async () => {
    const client = new ScriptedClient([
      toolCallCompletion('call_s', 'read_file', '{}'),
      finalCompletion('done'),
    ]);
    const { deps } = makeDeps({ client, sessionId: 's-1' });

    await runToolLoop([{ role: 'user', content: 'go' }], deps);

    for (const req of (client as ScriptedClient).requests) {
      assert.strictEqual(req.sessionId, 's-1');
    }
    assert.strictEqual((client as ScriptedClient).requests.length, 2);
  });

  it('omits the sessionId key from the request when the dep is not supplied', async () => {
    const client = new ScriptedClient([finalCompletion('done')]);
    const { deps } = makeDeps({ client });

    await runToolLoop([{ role: 'user', content: 'hi' }], deps);

    const req = (client as ScriptedClient).requests[0];
    assert.strictEqual('sessionId' in req, false);
  });

  it('keeps history and the persisted transcript in sync as it appends', async () => {
    const client = new ScriptedClient([
      toolCallCompletion('call_h', 'read_file', '{}'),
      finalCompletion('done'),
    ]);
    const { deps, appended } = makeDeps({
      client,
      call: async (): Promise<ToolResult> => ({ ok: true, data: 'data' }),
    });
    const history: ChatMessage[] = [{ role: 'user', content: 'go' }];

    await runToolLoop(history, deps);

    // History now carries the user message plus everything the loop appended.
    const historyAppended = history.slice(1).map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.tool_call_id !== undefined ? { tool_call_id: m.tool_call_id } : {}),
      ...(m.tool_calls !== undefined ? { tool_calls: m.tool_calls } : {}),
    }));
    assert.deepStrictEqual(historyAppended, appended);
    // The assistant turn that requested the tool carries its calls so the next
    // request can legally follow it with a `tool` message.
    assert.deepStrictEqual(appended[0], {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_h', name: 'read_file', arguments: '{}' }],
    });
  });
});

describe('resolveRoundBound', () => {
  it('returns the default when unset (undefined)', () => {
    assert.strictEqual(resolveRoundBound(undefined), DEFAULT_ROUND_BOUND);
  });

  it('returns the default for null', () => {
    assert.strictEqual(resolveRoundBound(null), DEFAULT_ROUND_BOUND);
  });

  it('returns the default for zero', () => {
    assert.strictEqual(resolveRoundBound(0), DEFAULT_ROUND_BOUND);
  });

  it('returns the default for a negative value', () => {
    assert.strictEqual(resolveRoundBound(-5), DEFAULT_ROUND_BOUND);
  });

  it('returns the default for a non-integer value', () => {
    assert.strictEqual(resolveRoundBound(3.5), DEFAULT_ROUND_BOUND);
  });

  it('returns the default for a non-number value', () => {
    assert.strictEqual(resolveRoundBound('10'), DEFAULT_ROUND_BOUND);
    assert.strictEqual(resolveRoundBound(NaN), DEFAULT_ROUND_BOUND);
    assert.strictEqual(resolveRoundBound(Infinity), DEFAULT_ROUND_BOUND);
  });

  it('returns a configured positive integer unchanged', () => {
    assert.strictEqual(resolveRoundBound(1), 1);
    assert.strictEqual(resolveRoundBound(7), 7);
    assert.strictEqual(resolveRoundBound(100), 100);
  });
});
