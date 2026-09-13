/**
 * Host-side tool loop core (Requirements 9.1–9.8, 14.7).
 *
 * When the user sends a message, the extension host runs this loop: it sends the
 * freshly built system prompt, the conversation history, and the assembled tool
 * definitions to the model client (Req 9.1), runs any returned tool calls through
 * the injected `call` seam using each call's model-provided tool-call id as the
 * idempotency key (Req 9.2), appends each result back as a `tool` message carrying
 * that id (success → result, failure/error → error indication, Req 9.3, 9.4), and
 * loops. A completion with no tool calls appends the assistant text and ends the
 * loop (Req 9.5). The loop performs at most `roundBound` completions; on reaching
 * the bound it appends a round-bound notice and stops (Req 9.6, 9.7). Each
 * completion resolves as a whole message; when the client streams, assistant
 * text fragments are forwarded to the optional `onDelta` listener along the way
 * (Req 9.8). On abort through the injected `AbortSignal` the loop appends a
 * stopped notice and ends (Req 14.7).
 *
 * This is a pure core: it carries no `vscode` import and depends only on injected
 * seams (`ModelClient`, the `call` function, the system-prompt builder, and the
 * transcript `append`), so it is directly unit- and property-testable (Req 9.9).
 */
import { ChatMessage, DeltaListener, ModelClient, ToolCall, ToolSpec } from './modelClient';
import { ToolResult } from './guard';
import { TranscriptRecord } from './chatTranscript';

/** The default round bound used when configuration is unset or invalid (Req 9.6). */
export const DEFAULT_ROUND_BOUND = 20;

/**
 * The seams the tool loop depends on, all injected so the loop stays a pure,
 * host-free core.
 *
 * - `client`      — the reused model client on the non-streaming completions path.
 * - `tools`       — the assembled tool definitions (each with a `description`).
 * - `call`        — runs one tool call through the guarded registry; `callId` is
 *                   the model's tool-call id, used as the idempotency key (Req 9.2),
 *                   and `signal` lets an in-flight tool observe an abort.
 * - `systemPrompt`— builds the system prompt; called each round so a spec
 *                   conversation re-reads its `spec.md` per round (Req 11.6).
 * - `append`      — persists one message to the conversation transcript.
 * - `roundBound`  — the resolved maximum number of completions (Req 9.6).
 * - `signal`      — aborts the loop via the caller's `AbortController` (Req 14.6).
 */
export interface ToolLoopDeps {
  client: ModelClient;
  tools: ToolSpec[];
  call(name: string, args: string, callId: string, signal: AbortSignal): Promise<ToolResult>;
  systemPrompt(): Promise<string>;
  append(msg: Omit<TranscriptRecord, 'ts'>): Promise<void>;
  roundBound: number;
  signal: AbortSignal;
  /**
   * Optional listener for streamed assistant-text fragments, forwarded to every
   * completion so the view can show text as it arrives. The loop still records
   * the complete assistant message once the completion resolves.
   */
  onDelta?: DeltaListener;
}

/** Serializes a tool result into the `content` of its answering `tool` message. */
function toolResultContent(result: ToolResult): string {
  if (result.ok) {
    return typeof result.data === 'string' ? result.data : JSON.stringify(result.data);
  }
  return `Error: ${result.error}`;
}

/**
 * Runs the tool loop for a single user message to completion.
 *
 * `history` is the conversation so far (already including the user's message);
 * the loop appends assistant, tool, and notice messages both to `history` (so
 * subsequent rounds see them) and, through `deps.append`, to the persisted
 * transcript. It resolves when the model returns no tool calls, the round bound
 * is reached, or the run is aborted.
 */
export async function runToolLoop(history: ChatMessage[], deps: ToolLoopDeps): Promise<void> {
  // A pre-run abort ends immediately with a stopped notice (Req 14.7).
  if (deps.signal.aborted) {
    await appendMessage(history, deps, { role: 'assistant', content: STOPPED_NOTICE });
    return;
  }

  for (let round = 0; round < deps.roundBound; round += 1) {
    const system = await deps.systemPrompt();
    const messages: ChatMessage[] = [{ role: 'system', content: system }, ...history];

    let completion;
    try {
      completion = await deps.client.complete({
        messages,
        tools: deps.tools,
        signal: deps.signal,
        ...(deps.onDelta !== undefined ? { onDelta: deps.onDelta } : {}),
      });
    } catch (err) {
      // An abort surfaces as a rejected completion; treat it as a stop (Req 14.7).
      if (deps.signal.aborted) {
        await appendMessage(history, deps, { role: 'assistant', content: STOPPED_NOTICE });
        return;
      }
      throw err;
    }

    // The completion itself may have raced an abort (Req 14.7).
    if (deps.signal.aborted) {
      await appendMessage(history, deps, { role: 'assistant', content: STOPPED_NOTICE });
      return;
    }

    // No tool calls: record the assistant text and end the loop (Req 9.5).
    if (completion.tool_calls.length === 0) {
      await appendMessage(history, deps, {
        role: 'assistant',
        content: completion.content ?? '',
      });
      return;
    }

    // Record the assistant turn that requested the tool calls, carrying the calls
    // themselves: OpenAI-compatible endpoints reject a `tool` message that does not
    // answer a preceding assistant `tool_calls` entry.
    await appendMessage(history, deps, {
      role: 'assistant',
      content: completion.content ?? '',
      tool_calls: completion.tool_calls,
    });

    // Run each tool call and append its result as a `tool` message (Req 9.2–9.4).
    for (const toolCall of completion.tool_calls) {
      if (deps.signal.aborted) {
        await appendMessage(history, deps, { role: 'assistant', content: STOPPED_NOTICE });
        return;
      }
      let result: ToolResult;
      try {
        result = await deps.call(toolCall.name, toolCall.arguments, toolCall.id, deps.signal);
      } catch (err) {
        // A thrown tool failure becomes an error `tool` message (Req 9.4).
        result = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      await appendMessage(history, deps, {
        role: 'tool',
        content: toolResultContent(result),
        tool_call_id: toolCall.id,
      });
    }

    // A tool may have observed the abort while running; stop before the next round.
    if (deps.signal.aborted) {
      await appendMessage(history, deps, { role: 'assistant', content: STOPPED_NOTICE });
      return;
    }
  }

  // Reached the round bound without a tool-call-free completion (Req 9.7).
  await appendMessage(history, deps, { role: 'assistant', content: ROUND_BOUND_NOTICE });
}

/** The message appended when the round bound is reached (Req 9.7). */
const ROUND_BOUND_NOTICE =
  'The orchestrator reached the maximum number of tool-loop rounds and stopped.';

/** The message appended when the run is aborted (Req 14.7). */
const STOPPED_NOTICE = 'The run was stopped.';

/** Appends a message to both the in-memory history and the persisted transcript. */
async function appendMessage(
  history: ChatMessage[],
  deps: ToolLoopDeps,
  msg: { role: ChatMessage['role']; content: string; tool_call_id?: string; tool_calls?: ToolCall[] },
): Promise<void> {
  const record = {
    role: msg.role,
    content: msg.content,
    ...(msg.tool_call_id !== undefined ? { tool_call_id: msg.tool_call_id } : {}),
    ...(msg.tool_calls !== undefined ? { tool_calls: msg.tool_calls } : {}),
  };
  history.push(record);
  await deps.append(record);
}

/**
 * Resolves the configured round bound (Req 9.6). Returns the configured value
 * when it is a positive integer; otherwise (unset, non-integer, or `< 1`) returns
 * the default of 20.
 */
export function resolveRoundBound(configured: unknown): number {
  if (typeof configured === 'number' && Number.isInteger(configured) && configured >= 1) {
    return configured;
  }
  return DEFAULT_ROUND_BOUND;
}
