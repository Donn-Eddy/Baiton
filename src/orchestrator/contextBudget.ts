/**
 * The chat orchestrator's context budget (host-free core).
 *
 * Resolves how large the selected model's context window is. This module
 * carries no `vscode` import so it can be unit-tested under plain mocha.
 */

import type { ChatMessage, CompletionResult, ToolSpec } from './modelClient';
import type { ModelEntry } from './modelCatalog';

/** The `baiton.orchestrator.contextWindow` setting key (0 = unset). */
export const CONTEXT_WINDOW_SETTING = 'baiton.orchestrator.contextWindow';

/**
 * The selected model's context window in tokens: the catalog entry's
 * `contextWindow` first, else the user's `baiton.orchestrator.contextWindow`
 * setting, else `undefined` (unknown). A value counts only when it is a
 * positive finite integer — `0` (the setting's default), negatives,
 * fractions, NaN/Infinity, strings and other shapes are "unset". Pure; never throws.
 */
export function resolveContextWindow(entry: ModelEntry | undefined, configured: unknown): number | undefined {
  const fromCatalog = positiveInteger(entry?.contextWindow);
  if (fromCatalog !== undefined) {
    return fromCatalog;
  }
  return positiveInteger(configured);
}

/** The `baiton.orchestrator.usageInStream` setting key. */
export const USAGE_IN_STREAM_SETTING = 'baiton.orchestrator.usageInStream';

/** Fixed per-message framing cost added by estimateMessages (role, separators). */
export const MESSAGE_OVERHEAD_TOKENS = 4;

/** Local token estimate: ceil(UTF-8 bytes / 4). 0 for ''. */
export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4);
}

/**
 * Estimated prompt tokens for a request: per message MESSAGE_OVERHEAD_TOKENS +
 * estimateTokens(content) + for each tool_calls entry estimateTokens(name) +
 * estimateTokens(arguments) (+ estimateTokens(tool_call_id) when set);
 * plus, per tool, estimateTokens(JSON.stringify({ name, description, parameters })).
 * `tools` is optional (a text-only completion). Pure.
 */
export function estimateMessages(messages: readonly ChatMessage[], tools?: readonly ToolSpec[]): number {
  let total = 0;
  for (const m of messages) {
    total += MESSAGE_OVERHEAD_TOKENS + estimateTokens(m.content);
    for (const tc of m.tool_calls ?? []) {
      total += estimateTokens(tc.name) + estimateTokens(tc.arguments);
    }
    if (m.tool_call_id) {
      total += estimateTokens(m.tool_call_id);
    }
  }
  for (const t of tools ?? []) {
    total += estimateTokens(JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters }));
  }
  return total;
}

export type ContextSource = 'usage' | 'estimate';
export interface ContextStatus {
  loaded: number;
  window?: number;
  source: ContextSource;
  ratio?: number;
}

/** What one completion carried, as the tracker needs it. */
export interface SentRequest {
  messages: readonly ChatMessage[];
  tools?: readonly ToolSpec[];
}

/**
 * Per-conversation context accounting. After each completion `record` sets
 * loaded = completion.usage.promptTokens when the endpoint reported usage
 * (source 'usage'), else estimateMessages(sent) (source 'estimate').
 * The window is read at status() time through the injected getter, so a
 * model switch is picked up without a new tracker.
 */
export class ContextTracker {
  private loaded = 0;
  private source: ContextSource = 'estimate';

  constructor(private readonly getWindow: () => number | undefined = () => undefined) {}

  record(sent: SentRequest, completion: Pick<CompletionResult, 'usage'>): void {
    const prompt = completion.usage?.promptTokens;
    if (typeof prompt === 'number' && Number.isFinite(prompt) && prompt >= 0) {
      this.loaded = prompt;
      this.source = 'usage';
    } else {
      this.loaded = estimateMessages(sent.messages, sent.tools);
      this.source = 'estimate';
    }
  }

  /** Forget the last measurement (new chat / compaction): loaded 0, source 'estimate'. */
  reset(): void {
    this.loaded = 0;
    this.source = 'estimate';
  }

  status(): ContextStatus {
    const window = positiveInteger(this.getWindow());
    return {
      loaded: this.loaded,
      source: this.source,
      ...(window !== undefined ? { window, ratio: this.loaded / window } : {}),
    };
  }
}

/** `value` when a positive finite integer, else undefined. */
function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}
