/**
 * GitHub Copilot chat orchestrator model client (Requirement 7).
 *
 * Speaks `vscode.lm`: the selected `LanguageModelChat` receives the transcript
 * mapped to `LanguageModelChatMessage`s and the tool surface mapped to
 * `LanguageModelChatTool`s, and its streamed `LanguageModelTextPart`s are
 * forwarded to `onDelta` while `LanguageModelToolCallPart`s are collected into
 * the returned `CompletionResult`. No API key is involved — access rides on the
 * user's Copilot subscription and the consent dialog, so this caller raises
 * `MissingConfigError('model')` but never `MissingConfigError('apiKey')`.
 *
 * The module imports `vscode` as a TYPE ONLY and takes the runtime surface
 * injected (`CopilotClientConfig.api`). `src/orchestrator/index.ts` re-exports
 * this module and that barrel is statically imported by host-free suites, so a
 * runtime `require('vscode')` here would break them; the provider router lives
 * under `src/activation/` where a host import is already legal and passes
 * `vscode` itself as the injected `api`.
 */
import type * as vscode from 'vscode';
import {
  ChatMessage,
  CompletionRequest,
  CompletionResult,
  MissingConfigError,
  ModelClient,
  ModelProvider,
  ToolCall,
  ToolSpec,
  UnreachableEndpointError,
} from './modelClient';

/** The subset of the `vscode` namespace the Copilot client needs at runtime. */
export type CopilotVscodeApi = Pick<
  typeof vscode,
  | 'lm'
  | 'LanguageModelChatMessage'
  | 'LanguageModelChatMessageRole'
  | 'LanguageModelTextPart'
  | 'LanguageModelToolCallPart'
  | 'LanguageModelToolResultPart'
  | 'CancellationTokenSource'
>;

/** The vendor string every Copilot model reports. */
export const COPILOT_VENDOR = 'copilot';
/** Shown in the consent dialog the first time `sendRequest` runs. */
export const COPILOT_JUSTIFICATION =
  'Baiton runs the orchestrator chat and its tools through your Copilot subscription.';

export interface CopilotClientConfig {
  /**
   * The live `vscode` namespace (or a fake in tests); injected so this module
   * stays host-import-free. The T05 provider router lives under
   * `src/activation/` where `import * as vscode from 'vscode'` is already
   * legal, so it passes `vscode` itself — do not reintroduce a runtime import
   * of `vscode` in this module.
   */
  api: CopilotVscodeApi;
  /** Resolves the selected Copilot model id (the `id` or `family` of a `LanguageModelChat`). */
  getModel: ModelProvider;
  /** Consent justification; defaults to `COPILOT_JUSTIFICATION`. */
  justification?: string;
}

/**
 * Parses a tool-call argument string into a plain object: a non-null,
 * non-array JSON object is returned as parsed, anything else (malformed JSON,
 * `null`, arrays, scalars) becomes `{}`. Never throws.
 */
export function parseCopilotToolInput(args: string): object {
  try {
    const parsed: unknown = JSON.parse(args);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as object)
      : {};
  } catch {
    return {};
  }
}

/** Shapes the `LanguageModelChatTool` list sent to `chat.sendRequest`. */
export function toCopilotTools(tools: readonly ToolSpec[]): vscode.LanguageModelChatTool[] {
  return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters }));
}

/**
 * Maps the recorded transcript to `LanguageModelChatMessage`s.
 *
 * `vscode.lm` has no system role: the system prompt (and every user turn) is
 * prepended as a User message. Tool results may only ride on a User message,
 * so each RUN of consecutive `tool` messages collapses into ONE User message
 * carrying a `LanguageModelToolResultPart` per result, in transcript order.
 * Never mutates `messages`.
 */
export function toCopilotMessages(
  messages: readonly ChatMessage[],
  api: CopilotVscodeApi,
): vscode.LanguageModelChatMessage[] {
  const out: vscode.LanguageModelChatMessage[] = [];
  let pendingToolParts: vscode.LanguageModelToolResultPart[] = [];

  const flushTools = (): void => {
    if (pendingToolParts.length === 0) {
      return;
    }
    out.push(api.LanguageModelChatMessage.User(pendingToolParts));
    pendingToolParts = [];
  };

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'tool') {
      // A whole round's tool results belong together on one User message.
      if (m.tool_call_id === undefined) {
        continue; // An orphan result cannot name the call it answers.
      }
      pendingToolParts.push(
        new api.LanguageModelToolResultPart(m.tool_call_id, [new api.LanguageModelTextPart(m.content)]),
      );
      continue;
    }
    // Emit any buffered tool results before the next non-tool turn.
    flushTools();
    if (m.role === 'assistant') {
      const calls = m.tool_calls ?? [];
      if (calls.length > 0) {
        out.push(
          api.LanguageModelChatMessage.Assistant([
            ...(m.content.trim() !== '' ? [new api.LanguageModelTextPart(m.content)] : []),
            ...calls.map(
              (c) =>
                new api.LanguageModelToolCallPart(c.id, c.name, parseCopilotToolInput(c.arguments)),
            ),
          ]),
        );
      } else if (m.content.trim() !== '') {
        out.push(api.LanguageModelChatMessage.Assistant([new api.LanguageModelTextPart(m.content)]));
      }
      continue;
    }
    // system and user: the system prompt rides as a leading user turn.
    if (m.content.trim() !== '') {
      out.push(api.LanguageModelChatMessage.User([new api.LanguageModelTextPart(m.content)]));
    }
  }
  flushTools();
  return out;
}

/**
 * Resolves the configured model among Copilot's chat models. Selecting by
 * vendor only and matching locally keeps a stale saved id from silently
 * falling back to an arbitrary model.
 */
export async function selectCopilotModel(
  api: CopilotVscodeApi,
  model: string,
): Promise<vscode.LanguageModelChat | undefined> {
  const models = await api.lm.selectChatModels({ vendor: COPILOT_VENDOR });
  return models.find((m) => m.id === model) ?? models.find((m) => m.family === model);
}

/** Renders an error's message without assuming it is an `Error` instance. */
function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Maps a `vscode.lm` failure to the error classes the chat controller already
 * branches on. Codes are read defensively rather than via `instanceof
 * LanguageModelError` — the test fake's class lives in a different module
 * realm (and a host may hand back proxies). Our own errors are returned
 * untouched.
 */
export function mapCopilotError(err: unknown): Error {
  if (err instanceof MissingConfigError || err instanceof UnreachableEndpointError) {
    return err;
  }
  const code =
    typeof (err as { code?: unknown } | null)?.code === 'string'
      ? (err as { code: string }).code
      : undefined;
  if (code === 'NotFound') {
    // The saved model no longer exists (models change over time).
    return new MissingConfigError('model');
  }
  if (code === 'NoPermissions' || code === 'Blocked') {
    // Consent declined or quota exhausted.
    return new UnreachableEndpointError(`Copilot request was refused (${code}): ${describe(err)}`, {
      cause: err,
    });
  }
  return new UnreachableEndpointError(`Copilot request failed: ${describe(err)}`, { cause: err });
}

/**
 * Copilot-backed {@link ModelClient} over `vscode.lm`. The `vscode` surface is
 * injected so the module stays host-import-free and testable against the fake.
 */
export class CopilotModelClient implements ModelClient {
  private readonly config: CopilotClientConfig;

  constructor(config: CopilotClientConfig) {
    this.config = config;
  }

  public async complete(req: CompletionRequest): Promise<CompletionResult> {
    const api = this.config.api;
    // Copilot needs no key, so `MissingConfigError('apiKey')` is never raised here.
    const model = await this.config.getModel();
    if (!model) {
      throw new MissingConfigError('model');
    }
    if (req.signal.aborted) {
      throw new UnreachableEndpointError('request was aborted before it started');
    }
    let chat: vscode.LanguageModelChat;
    try {
      const found = await selectCopilotModel(api, model);
      if (found === undefined) {
        throw new MissingConfigError('model');
      }
      chat = found;
    } catch (err) {
      throw mapCopilotError(err);
    }

    const tools = req.tools ?? [];
    const options: vscode.LanguageModelChatRequestOptions = {
      justification: this.config.justification ?? COPILOT_JUSTIFICATION,
      ...(tools.length > 0 ? { tools: toCopilotTools(tools) } : {}),
    };

    let content = '';
    let sawText = false;
    const toolCalls: ToolCall[] = [];
    const cts = new api.CancellationTokenSource();
    const onAbort = (): void => cts.cancel();
    req.signal.addEventListener('abort', onAbort);
    try {
      const response = await chat.sendRequest(toCopilotMessages(req.messages, api), options, cts.token);
      for await (const part of response.stream) {
        // Parts are classified by DUCK TYPE, not instanceof: the host may hand
        // back proxies, and the test fake's classes live in a different module
        // realm. Text shape first, then tool-call shape, so a part carrying
        // both cannot be double-counted.
        const value = (part as { value?: unknown }).value;
        if (typeof value === 'string') {
          content += value;
          sawText = true;
          if (value.length > 0) {
            req.onDelta?.(value);
          }
          continue;
        }
        const callId = (part as { callId?: unknown }).callId;
        const name = (part as { name?: unknown }).name;
        if (
          typeof callId === 'string' && callId.length > 0 &&
          typeof name === 'string' && name.length > 0
        ) {
          let args = '{}';
          try {
            args = JSON.stringify((part as { input?: unknown }).input ?? {});
          } catch {
            args = '{}'; // An uncloneable input degrades to no arguments.
          }
          toolCalls.push({ id: callId, name, arguments: args });
        }
        // Anything else (data parts, future parts) is ignored.
      }
    } catch (err) {
      throw req.signal.aborted ? new UnreachableEndpointError('request was aborted') : mapCopilotError(err);
    } finally {
      req.signal.removeEventListener('abort', onAbort);
      cts.dispose();
    }

    // `req.sessionId` is unused here: Copilot is in-process, so there are no
    // headers for a provider to derive a session id from.
    return { content: sawText ? content : undefined, tool_calls: toolCalls };
  }
}
