/**
 * OpenAI-compatible chat orchestrator model client (Requirement 7).
 *
 * Speaks the OpenAI chat-completions protocol (`POST <endpoint>/v1/chat/completions`),
 * sending `tools` and reading `tool_calls` back (Req 7.1). Endpoint and model are
 * read from settings and the API key from secret storage through injected providers
 * — the client itself couples to no VS Code API and stores no model configuration in
 * the repository (Req 7.3, 7.4), which also keeps it unit-testable against a mock
 * HTTP server. Streaming is used when the endpoint advertises it, otherwise a
 * non-streaming request is issued (Req 7.2). Every request must connect within 30
 * seconds or abort with an unreachable-endpoint error (Req 7.1, 7.6). If the
 * endpoint, model, or key is missing the client aborts before any request with an
 * error naming the missing value (Req 7.5). The client holds no conversation state,
 * so all error paths leave the caller's transcript untouched (Req 7.5, 7.6).
 */
import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import { StringDecoder } from 'string_decoder';

/** A single chat message on the OpenAI chat-completions path. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** For a `tool` message, the id of the call it answers. */
  tool_call_id?: string;
  /**
   * For an `assistant` message, the tool calls it requested. OpenAI-compatible
   * endpoints require every `tool` message to follow an assistant message
   * carrying the matching call, so the loop records this turn verbatim.
   */
  tool_calls?: ToolCall[];
}

/** A tool the model may call, described with a JSON Schema parameter object. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: object; // JSON Schema
}

/** A tool invocation the model asked for, arguments carried as a JSON string. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** The parsed result of a completion: optional assistant text plus any tool calls. */
export interface CompletionResult {
  content?: string;
  tool_calls: ToolCall[];
}

/**
 * Receives each assistant-text fragment as it arrives on the streaming path.
 * Never called on the non-streaming path; the full text is still returned in
 * the {@link CompletionResult} either way, so callers need not accumulate.
 */
export type DeltaListener = (text: string) => void;

/** The arguments to a single completion request. */
export interface CompletionRequest {
  messages: ChatMessage[];
  tools: ToolSpec[];
  signal: AbortSignal;
  /** Optional listener for streamed assistant-text fragments (streaming path only). */
  onDelta?: DeltaListener;
}

/**
 * The orchestrator model client. Connects within 30s or aborts with an
 * unreachable-endpoint error.
 */
export interface ModelClient {
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

/** Which configuration value was missing, for {@link MissingConfigError}. */
export type MissingConfigValue = 'endpoint' | 'model' | 'apiKey';

/**
 * Raised before any request when the endpoint, model, or API key is absent
 * (Req 7.5). The {@link missing} field names the offending value.
 */
export class MissingConfigError extends Error {
  public readonly missing: MissingConfigValue;
  constructor(missing: MissingConfigValue) {
    super(`Orchestrator model configuration is missing: ${missing}`);
    this.name = 'MissingConfigError';
    this.missing = missing;
  }
}

/**
 * Raised when the endpoint cannot be reached, the socket does not connect within
 * the 30s budget, or the request is aborted (Req 7.6).
 */
export class UnreachableEndpointError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(`Orchestrator endpoint was unreachable: ${message}`);
    this.name = 'UnreachableEndpointError';
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/** Resolves the configured endpoint base URL, or `undefined` when unset. */
export type EndpointProvider = () => string | undefined | Promise<string | undefined>;
/** Resolves the configured model id, or `undefined` when unset. */
export type ModelProvider = () => string | undefined | Promise<string | undefined>;
/** Resolves the API key from secret storage, or `undefined` when unset. */
export type ApiKeyProvider = () => string | undefined | Promise<string | undefined>;

/**
 * Reports whether the configured endpoint advertises streaming responses (Req 7.2).
 * Defaults to non-streaming when omitted.
 */
export type StreamingCapabilityProvider = () => boolean | Promise<boolean>;

/**
 * Resolves the configured completion token cap. A positive integer is sent as
 * the request's `max_tokens`; anything else (unset, zero, negative,
 * non-integer) leaves `max_tokens` off the request entirely, so the endpoint's
 * own default applies.
 */
export type MaxTokensProvider = () => unknown | Promise<unknown>;

/**
 * Resolve a configured `max_tokens` value: a positive integer, or `undefined`
 * when the setting is unset, zero, negative, or not an integer.
 */
export function resolveMaxTokens(configured: unknown): number | undefined {
  return typeof configured === 'number' && Number.isInteger(configured) && configured > 0
    ? configured
    : undefined;
}

/** Providers and knobs the client depends on; all injected to stay testable. */
export interface ModelClientConfig {
  getEndpoint: EndpointProvider;
  getModel: ModelProvider;
  getApiKey: ApiKeyProvider;
  /** Whether the endpoint supports streaming; defaults to `false` (non-streaming). */
  isStreaming?: StreamingCapabilityProvider;
  /** The configured completion token cap; omitted from the request unless positive. */
  getMaxTokens?: MaxTokensProvider;
  /** Connect budget in milliseconds; defaults to 30000 (Req 7.1). */
  connectTimeoutMs?: number;
}

/** The default connect budget: 30 seconds (Req 7.1). */
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

/** Trims a trailing slash so we can safely append the completions path. */
function normalizeBase(endpoint: string): string {
  return endpoint.replace(/\/+$/, '');
}

/**
 * Resolves the absolute chat-completions URL from the configured endpoint.
 * Providers disagree on where the OpenAI-compatible path lives (OpenAI uses
 * `/v1`, DeepInfra `/v1/openai`, Zhipu `/api/paas/v4`), so accept any of:
 * - a full URL already ending in `/chat/completions`, used verbatim;
 * - a bare origin (`https://host` or `http://host:port`), given `/v1/chat/completions`;
 * - any other base path, given `/chat/completions`.
 */
export function completionsUrl(endpoint: string): URL {
  const base = normalizeBase(endpoint);
  if (/\/chat\/completions$/.test(base)) {
    return new URL(base);
  }
  const parsed = new URL(base);
  const hasPath = parsed.pathname.replace(/\/+$/, '') !== '';
  return new URL(hasPath ? `${base}/chat/completions` : `${base}/v1/chat/completions`);
}

/** Shapes the OpenAI `tools` array from our {@link ToolSpec}s. */
function toWireTools(tools: ToolSpec[]): unknown[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/** Shapes one recorded {@link ToolCall} back into the OpenAI assistant `tool_calls` entry. */
function toWireToolCall(call: ToolCall): unknown {
  return {
    id: call.id,
    type: 'function',
    function: { name: call.name, arguments: call.arguments },
  };
}

/**
 * Accumulates streamed `tool_calls` deltas by index. OpenAI streams a tool call
 * as a first chunk carrying `id`/`name` and subsequent chunks appending argument
 * fragments, so we merge on the delta index.
 */
interface ToolCallAccumulator {
  id?: string;
  name?: string;
  arguments: string;
}

/** Reads a field only when it is a non-empty string; `undefined` otherwise. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Merges a streamed tool-call delta into the per-index accumulator map.
 *
 * The delta is typed as `unknown`-shaped rather than `string`-shaped because
 * some OpenAI-compatible servers repeat the tool-call envelope on every
 * argument chunk with `"id": null` and `"function": {"name": null, ...}`. Those
 * nulls must never overwrite the real id/name captured from the first chunk, so
 * `id` and `name` are copied only when they are non-empty strings and
 * `arguments` is appended only when it is a string (Req 7.2).
 *
 * Index collisions are also tolerated: a server that restarts numbering at 0 for
 * a second call would otherwise have its two calls merged into one. When a chunk
 * carries a non-empty `id` that differs from the id already accumulated at that
 * index, a fresh accumulator entry is started at the next free index instead.
 */
function mergeToolCallDelta(acc: Map<number, ToolCallAccumulator>, delta: unknown): void {
  if (typeof delta !== 'object' || delta === null) {
    return;
  }
  const d = delta as { index?: unknown; id?: unknown; function?: unknown };
  const fn =
    typeof d.function === 'object' && d.function !== null
      ? (d.function as { name?: unknown; arguments?: unknown })
      : undefined;
  const id = nonEmptyString(d.id);
  const name = nonEmptyString(fn?.name);

  let index = typeof d.index === 'number' && Number.isFinite(d.index) ? d.index : 0;
  const existing = acc.get(index);
  if (existing !== undefined && id !== undefined && existing.id !== undefined && existing.id !== id) {
    // A distinct call reusing an occupied index: give it its own slot, ordered
    // after everything accumulated so far.
    index = nextFreeIndex(acc);
  }

  const current = acc.get(index) ?? { arguments: '' };
  if (id !== undefined) {
    current.id = id;
  }
  if (name !== undefined) {
    current.name = name;
  }
  if (typeof fn?.arguments === 'string') {
    current.arguments += fn.arguments;
  }
  acc.set(index, current);
}

/** The next accumulator slot after every index already in use. */
function nextFreeIndex(acc: Map<number, ToolCallAccumulator>): number {
  let max = -1;
  for (const key of acc.keys()) {
    if (key > max) {
      max = key;
    }
  }
  return max + 1;
}

/**
 * Turns the accumulator map into ordered {@link ToolCall}s, dropping any call
 * that never received a non-empty string id and name. This matches
 * {@link parseNonStreamingToolCalls}, and keeps a half-formed call (or one whose
 * envelope only ever carried nulls) from reaching the tool loop and the
 * transcript (Req 7.2).
 */
function finalizeToolCalls(acc: Map<number, ToolCallAccumulator>): ToolCall[] {
  const out: ToolCall[] = [];
  for (const [, c] of [...acc.entries()].sort((a, b) => a[0] - b[0])) {
    const id = nonEmptyString(c.id);
    const name = nonEmptyString(c.name);
    if (id === undefined || name === undefined) {
      continue;
    }
    out.push({ id, name, arguments: c.arguments });
  }
  return out;
}

/** Reads tool calls off a non-streaming choice message. */
function parseNonStreamingToolCalls(message: unknown): ToolCall[] {
  if (typeof message !== 'object' || message === null) {
    return [];
  }
  const raw = (message as { tool_calls?: unknown }).tool_calls;
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: ToolCall[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const e = entry as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
    const id = typeof e.id === 'string' ? e.id : undefined;
    const name = typeof e.function?.name === 'string' ? e.function.name : undefined;
    if (id === undefined || name === undefined) {
      continue;
    }
    const args = typeof e.function?.arguments === 'string' ? e.function.arguments : '';
    out.push({ id, name, arguments: args });
  }
  return out;
}

/** Reads assistant text off a non-streaming choice message. */
function parseNonStreamingContent(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null) {
    return undefined;
  }
  const content = (message as { content?: unknown }).content;
  return typeof content === 'string' ? content : undefined;
}

/**
 * OpenAI-compatible {@link ModelClient} backed by node's http/https so it runs
 * without DOM types and can be exercised against a mock server.
 */
export class OpenAiModelClient implements ModelClient {
  private readonly config: ModelClientConfig;

  constructor(config: ModelClientConfig) {
    this.config = config;
  }

  public async complete(req: CompletionRequest): Promise<CompletionResult> {
    // Resolve configuration and abort before any request when a value is missing
    // (Req 7.5). Order (endpoint → model → key) makes the surfaced message stable.
    const endpoint = await this.config.getEndpoint();
    if (!endpoint) {
      throw new MissingConfigError('endpoint');
    }
    const model = await this.config.getModel();
    if (!model) {
      throw new MissingConfigError('model');
    }
    const apiKey = await this.config.getApiKey();
    if (!apiKey) {
      throw new MissingConfigError('apiKey');
    }

    if (req.signal.aborted) {
      throw new UnreachableEndpointError('request was aborted before it started');
    }

    const streaming = this.config.isStreaming ? await this.config.isStreaming() : false;
    const maxTokens = resolveMaxTokens(
      this.config.getMaxTokens ? await this.config.getMaxTokens() : undefined,
    );
    const url = completionsUrl(endpoint);
    const body = JSON.stringify({
      model,
      messages: req.messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.tool_call_id !== undefined ? { tool_call_id: m.tool_call_id } : {}),
        ...(m.tool_calls !== undefined && m.tool_calls.length > 0
          ? { tool_calls: m.tool_calls.map(toWireToolCall) }
          : {}),
      })),
      tools: toWireTools(req.tools),
      stream: streaming,
      ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
    });

    if (!streaming) {
      const raw = await this.postCompletion(url, apiKey, body, req.signal);
      return this.parseNonStreaming(raw);
    }

    // Streaming: feed each response chunk to the SSE parser as it arrives so
    // assistant text reaches `onDelta` incrementally rather than at end of body.
    const parser = new SseCompletionParser(req.onDelta);
    await this.postCompletion(url, apiKey, body, req.signal, (chunk) => parser.feed(chunk));
    return parser.finish();
  }

  /**
   * Issues the POST and resolves with the raw response body text. Enforces the
   * 30s connect budget and maps connection/timeout/abort failures to
   * {@link UnreachableEndpointError} (Req 7.1, 7.6). When `onChunk` is given,
   * each successful-status body chunk is also handed to it as it arrives.
   */
  private postCompletion(
    url: URL,
    apiKey: string,
    body: string,
    signal: AbortSignal,
    onChunk?: (text: string) => void,
  ): Promise<string> {
    const connectTimeoutMs = this.config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    const transport = url.protocol === 'https:' ? https : http;

    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const finishReject = (err: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        request.destroy();
        reject(err);
      };
      const finishResolve = (value: string): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(value);
      };

      const onAbort = (): void => {
        finishReject(new UnreachableEndpointError('request was aborted'));
      };
      const cleanup = (): void => {
        signal.removeEventListener('abort', onAbort);
      };

      const request = transport.request(
        url,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
            'content-length': Buffer.byteLength(body).toString(),
          },
        },
        (res) => {
          const status = res.statusCode ?? 0;
          const ok = status >= 200 && status < 300;
          const chunks: Buffer[] = [];
          // Decode incrementally so a multi-byte character split across chunks
          // is not corrupted when streamed to the listener.
          const decoder = new StringDecoder('utf8');
          res.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
            if (ok && onChunk !== undefined && !settled) {
              const text = decoder.write(chunk);
              if (text.length > 0) {
                onChunk(text);
              }
            }
          });
          res.on('end', () => {
            if (ok && onChunk !== undefined && !settled) {
              const tail = decoder.end();
              if (tail.length > 0) {
                onChunk(tail);
              }
            }
            const text = Buffer.concat(chunks).toString('utf8');
            if (status < 200 || status >= 300) {
              finishReject(
                new UnreachableEndpointError(`endpoint returned HTTP ${status}: ${text.slice(0, 500)}`),
              );
              return;
            }
            finishResolve(text);
          });
          res.on('error', (err) =>
            finishReject(new UnreachableEndpointError('response stream failed', { cause: err })),
          );
        },
      );

      // 30s connect budget: fire once the socket fails to connect in time (Req 7.1).
      request.setTimeout(connectTimeoutMs, () => {
        finishReject(
          new UnreachableEndpointError(`connection did not complete within ${connectTimeoutMs}ms`),
        );
      });
      request.on('error', (err) =>
        finishReject(new UnreachableEndpointError('connection failed', { cause: err })),
      );

      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort);

      request.write(body);
      request.end();
    });
  }

  /** Parses a non-streaming JSON completion body into a {@link CompletionResult}. */
  private parseNonStreaming(raw: string): CompletionResult {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new UnreachableEndpointError('endpoint returned a non-JSON response', { cause: err });
    }
    const choices = (parsed as { choices?: unknown }).choices;
    const first = Array.isArray(choices) ? choices[0] : undefined;
    const message = (first as { message?: unknown } | undefined)?.message;
    return {
      content: parseNonStreamingContent(message),
      tool_calls: parseNonStreamingToolCalls(message),
    };
  }

}

/**
 * Incremental Server-Sent Events parser for a streaming completion (Req 7.2).
 * Feed it response text as it arrives: complete `data:` lines are parsed at
 * once, assistant-text fragments are forwarded to the listener immediately,
 * and tool-call argument deltas accumulate by index. A partial trailing line is
 * held until the next chunk completes it. {@link finish} flushes any remainder
 * and returns the assembled {@link CompletionResult}.
 */
export class SseCompletionParser {
  private readonly toolCalls = new Map<number, ToolCallAccumulator>();
  private readonly onDelta: DeltaListener | undefined;
  private content = '';
  private sawContent = false;
  private pending = '';

  constructor(onDelta?: DeltaListener) {
    this.onDelta = onDelta;
  }

  /** Consume a chunk of body text, processing every line it completes. */
  public feed(chunk: string): void {
    this.pending += chunk;
    let newline = this.pending.indexOf('\n');
    while (newline !== -1) {
      const line = this.pending.slice(0, newline);
      this.pending = this.pending.slice(newline + 1);
      this.handleLine(line);
      newline = this.pending.indexOf('\n');
    }
  }

  /** Flush a trailing unterminated line and return the assembled completion. */
  public finish(): CompletionResult {
    if (this.pending.length > 0) {
      const tail = this.pending;
      this.pending = '';
      this.handleLine(tail);
    }
    return {
      content: this.sawContent ? this.content : undefined,
      tool_calls: finalizeToolCalls(this.toolCalls),
    };
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) {
      return;
    }
    const payload = trimmed.slice('data:'.length).trim();
    if (payload === '' || payload === '[DONE]') {
      return;
    }
    let event: unknown;
    try {
      event = JSON.parse(payload);
    } catch {
      return; // Skip malformed keep-alive or partial frames.
    }
    const choices = (event as { choices?: unknown }).choices;
    const first = Array.isArray(choices) ? choices[0] : undefined;
    const delta = (first as { delta?: unknown } | undefined)?.delta;
    if (typeof delta !== 'object' || delta === null) {
      return;
    }
    const d = delta as {
      content?: unknown;
      tool_calls?: unknown[];
    };
    if (typeof d.content === 'string') {
      this.content += d.content;
      this.sawContent = true;
      if (d.content.length > 0 && this.onDelta !== undefined) {
        this.onDelta(d.content);
      }
    }
    if (Array.isArray(d.tool_calls)) {
      for (const tc of d.tool_calls) {
        mergeToolCallDelta(this.toolCalls, tc);
      }
    }
  }
}
