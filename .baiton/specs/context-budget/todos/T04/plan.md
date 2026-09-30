# Plan T04

## Steps

1. Add CompletionUsage and CompletionResult.usage

   In src/orchestrator/modelClient.ts, next to CompletionResult (around line 53):

   ```ts
   /** Token accounting the endpoint reported for one completion. */
   export interface CompletionUsage {
     promptTokens: number;
     completionTokens: number;
   }
   export interface CompletionResult {
     content?: string;
     tool_calls: ToolCall[];
     /** Present only when the endpoint reported usage; absent (key not set) otherwise. */
     usage?: CompletionUsage;
   }
   ```

   Add an exported pure helper `parseUsage(raw: unknown): CompletionUsage | undefined`. It reads the OpenAI `usage` object `{ prompt_tokens, completion_tokens }`. It returns undefined unless `raw` is a non-null object whose `prompt_tokens` is a finite integer >= 0. `completionTokens` is `completion_tokens` when that is a finite integer >= 0, else 0. It never throws.

   IMPORTANT: every producer must add the `usage` key only when parseUsage returned a value, for example `...(usage !== undefined ? { usage } : {})`. It must never write `usage: undefined`, so existing deepStrictEqual assertions on results (e.g. test/providerRouter.test.ts:1265, toolLoop tests) stay byte-identical.

   Files: `src/orchestrator/modelClient.ts`

2. Parse usage on the non-streaming path

   In OpenAiModelClient.parseNonStreaming (modelClient.ts around line 750), after computing `message`, compute `const usage = parseUsage((parsed as { usage?: unknown }).usage);`. Return `{ content, tool_calls, ...(usage !== undefined ? { usage } : {}) }`. Guard `parsed` being null/non-object the same way the existing `choices` read does: `(parsed as {usage?: unknown} | null)?.usage`.

   Files: `src/orchestrator/modelClient.ts`

3. Parse usage on the SSE path (keep the last one seen)

   In SseCompletionParser, add `private usage: CompletionUsage | undefined;`. In handleLine, after JSON.parse succeeds and BEFORE the `choices`/`delta` early return, run `const u = parseUsage((event as { usage?: unknown } | null)?.usage); if (u !== undefined) { this.usage = u; }`. With include_usage, the usage event is the final chunk and has `choices: []`, so the existing early return would otherwise drop it. `usage: null`, which some servers put on every chunk, parses to undefined and does not overwrite an earlier value. In finish(), return `{ content: ..., tool_calls: ..., ...(this.usage !== undefined ? { usage: this.usage } : {}) }`.

   Files: `src/orchestrator/modelClient.ts`

4. Send stream_options.include_usage behind a config provider

   In ModelClientConfig add:
   ```ts
   /** Whether to ask a streaming endpoint for usage via `stream_options.include_usage`; defaults to true. Ignored on the non-streaming path. */
   isUsageInStream?: () => boolean | Promise<boolean>;
   ```
   In OpenAiModelClient.complete, after `streaming` is resolved:
   ```ts
   const includeUsage = streaming && (this.config.isUsageInStream ? (await this.config.isUsageInStream()) !== false : true);
   ```
   Add `...(includeUsage ? { stream_options: { include_usage: true } } : {})` to the JSON body, after `stream` and before `max_tokens`. The non-streaming body must be unchanged, with no stream_options key.

   Files: `src/orchestrator/modelClient.ts`

5. Copilot leaves usage undefined

   src/orchestrator/copilotClient.ts needs no behavioural change: its return `{ content, tool_calls }` never sets `usage`. Add one short comment next to the final return (line ~340): `// vscode.lm reports no token usage, so `usage` is left unset and the tracker falls back to its estimate.` No other edits.

   Files: `src/orchestrator/copilotClient.ts`

6. Wire the setting through ProviderSettings and providerClientConfig

   In src/activation/providerRouter.ts, ProviderSettings (line ~111): add the OPTIONAL member `/** `baiton.orchestrator.usageInStream` — ask streaming endpoints for usage; absent means true. */ isUsageInStream?: () => boolean;`. It must be optional so the existing test fakes (test/providerRouter.test.ts:230, test/modelSelectorRefresh.test.ts:762) still compile. In providerClientConfig, add `isUsageInStream: () => deps.settings.isUsageInStream?.() ?? true,` beside isStreaming/getMaxTokens. Update the doc bullet 'streaming and `max_tokens` pass through unchanged' so it also names usageInStream.

   In src/activation/commands.ts, in the providerSettings literal (line ~610), add `isUsageInStream: () => orchCfg().get<boolean>('orchestrator.usageInStream') ?? true,`.

   Files: `src/activation/providerRouter.ts`, `src/activation/commands.ts`

7. Contribute baiton.orchestrator.usageInStream in package.json

   In contributes.configuration.properties, add this right after `baiton.orchestrator.streaming` (line ~376):
   ```json
   "baiton.orchestrator.usageInStream": {
     "type": "boolean",
     "default": true,
     "description": "When streaming, ask the endpoint to report token usage (stream_options.include_usage) so the chat can show how much of the context window is loaded. Disable for endpoints that reject the stream_options field; the chat then falls back to a local estimate. Applies to the HTTP providers only."
   }
   ```
   Keep the JSON valid (commas).

   Files: `package.json`

8. Implement estimateTokens, estimateMessages and ContextTracker in contextBudget.ts

   Extend src/orchestrator/contextBudget.ts. Keep it host-free: only `import type` from './modelClient' and './modelCatalog', and no vscode.

   ```ts
   import type { ChatMessage, CompletionResult, ToolSpec } from './modelClient';

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
   export function estimateMessages(messages: readonly ChatMessage[], tools?: readonly ToolSpec[]): number

   export type ContextSource = 'usage' | 'estimate';
   export interface ContextStatus { loaded: number; window?: number; source: ContextSource; ratio?: number; }

   /** What one completion carried, as the tracker needs it. */
   export interface SentRequest { messages: readonly ChatMessage[]; tools?: readonly ToolSpec[]; }

   /**
    * Per-conversation context accounting. After each completion `record` sets
    * loaded = completion.usage.promptTokens when the endpoint reported usage
    * (source 'usage'), else estimateMessages(sent) (source 'estimate').
    * The window is read at status() time through the injected getter, so a
    * model switch is picked up without a new tracker.
    */
   export class ContextTracker {
     constructor(getWindow: () => number | undefined = () => undefined)
     record(sent: SentRequest, completion: Pick<CompletionResult, 'usage'>): void
     /** Forget the last measurement (new chat / compaction): loaded 0, source 'estimate'. */
     reset(): void
     status(): ContextStatus
   }
   ```

   status() semantics:
   - `loaded` is the last recorded value, or 0 before any record.
   - `source` is the last recorded source, or 'estimate' before any record.
   - `window` is `getWindow()`, used only when it is a positive integer. Otherwise the key is omitted.
   - `ratio = loaded / window`, set only when the window is present. Otherwise the key is omitted.

   Use the existing private `positiveInteger` helper to validate the window. A usage object whose promptTokens is not a finite non-negative number falls back to the estimate.

   Files: `src/orchestrator/contextBudget.ts`

9. Tests: modelClient usage and stream_options

   In test/modelClient.test.ts, add `parseUsage` to the import and add a `describe('usage', ...)` block that uses the existing startMockServer/makeConfig helpers:
   1. Non-streaming: the response carries `usage: { prompt_tokens: 120, completion_tokens: 7 }`, so result.usage deepEquals `{ promptTokens: 120, completionTokens: 7 }`.
   2. Non-streaming without usage: `'usage' in result` is false.
   3. Streaming (`isStreaming: () => true`, SSE body with content deltas, then a final `data: {"choices":[],"usage":{"prompt_tokens":50,"completion_tokens":3}}`, then `data: [DONE]`): the content is assembled and usage is `{ promptTokens: 50, completionTokens: 3 }`.
   4. The request body when streaming has `stream_options: { include_usage: true }` by default and when `isUsageInStream: () => true`. It has no `stream_options` key when `isUsageInStream: () => false`. It never has the key when not streaming.
   5. SseCompletionParser unit tests: an earlier valid usage followed by a chunk with `usage: null` keeps the earlier one, and two usage events keep the last one. A parser that never sees usage returns a result without a `usage` key.
   6. parseUsage: it rejects null, non-objects, a missing or negative or NaN prompt_tokens, and a string prompt_tokens. A missing completion_tokens gives completionTokens 0.
   Look at how the existing streaming tests build their SSE response (headers `content-type: text/event-stream`) and copy that shape.

   Files: `test/modelClient.test.ts`

10. Tests: contextBudget estimates and tracker

   Extend test/contextBudget.test.ts and keep the existing resolveContextWindow, setting and host-free tests:
   - estimateTokens: '' gives 0, 'abcd' gives 1, 'abcde' gives 2, and a multi-byte string such as 'é'.repeat(4) (8 bytes) gives 2.
   - estimateMessages: `[{role:'user',content:'abcd'}]` gives MESSAGE_OVERHEAD_TOKENS + 1. Adding an assistant message with tool_calls raises the total by at least estimateTokens(arguments). Passing tools raises it by estimateTokens(JSON.stringify({name,description,parameters})) per tool. Calling it without tools does not throw.
   - ContextTracker: before any record, status() deepEquals `{ loaded: 0, source: 'estimate' }` with no window. Recording a completion with usage gives loaded = promptTokens and source 'usage'. Recording without usage gives loaded = estimateMessages(sent.messages, sent.tools) and source 'estimate'. With getWindow () => 1000 and loaded 250, ratio is 0.25 and window is 1000. With getWindow returning 0 or undefined, the window and ratio keys are absent. A usage record followed by a no-usage record switches the source back to 'estimate'. reset() returns the tracker to the initial status.
   - Setting: package.json contributes USAGE_IN_STREAM_SETTING ('baiton.orchestrator.usageInStream') as type 'boolean' with default true, using the same readFileSync pattern as the existing contextWindow test.

   Files: `test/contextBudget.test.ts`

11. Verify

   Run `npm run compile`, `npm run lint` and `npm test`. All must pass with no existing test expectations changed.

   Files: (none)

## Risks

- The SSE usage event arrives with `choices: []`, so it must be read before SseCompletionParser.handleLine's delta early return, or streaming usage is silently dropped.
- Adding `usage: undefined` as an explicit key would break existing deepStrictEqual assertions on CompletionResult (e.g. test/providerRouter.test.ts:1265 and toolLoop tests). Spread the key in only when it is defined.
- Some OpenAI-compatible endpoints reject the unknown `stream_options` field with HTTP 400. That is why it defaults on but can be turned off with baiton.orchestrator.usageInStream, and it is never sent on the non-streaming path.
- ProviderSettings.isUsageInStream must stay optional, or the ProviderSettings fakes in test/providerRouter.test.ts and test/modelSelectorRefresh.test.ts stop compiling. Neither file is in this todo's file list.
- contextBudget.ts must use only `import type` from modelClient/modelCatalog and must not import vscode. The existing host-free test enforces the vscode part.
- Some providers send `usage: null` on every chunk. parseUsage must treat null as absent so it does not overwrite a real value seen earlier.

## Acceptance

- CompletionResult has an optional `usage?: { promptTokens: number; completionTokens: number }`, and results carry the key only when the endpoint reported usage.
- OpenAiModelClient returns usage parsed from the non-streaming `usage` object and from the last valid SSE event carrying `usage`, including a final `choices: []` chunk.
- Streaming requests include `stream_options: { include_usage: true }` unless ModelClientConfig.isUsageInStream returns false. Non-streaming requests never include stream_options.
- package.json contributes `baiton.orchestrator.usageInStream` (boolean, default true). commands.ts reads it into ProviderSettings.isUsageInStream, and providerClientConfig forwards it as ModelClientConfig.isUsageInStream (default true when the setting accessor is absent).
- CopilotModelClient results never carry `usage`.
- contextBudget.ts exports estimateTokens (ceil(UTF-8 bytes/4)), estimateMessages(messages, tools?), MESSAGE_OVERHEAD_TOKENS, USAGE_IN_STREAM_SETTING, ContextStatus/ContextSource types and ContextTracker. The tracker's status() prefers usage.promptTokens, falls back to the estimate, and reports window/ratio only when the window is a positive integer. The module has no vscode import.
- New tests in test/modelClient.test.ts and test/contextBudget.test.ts cover the behaviours above.
- `npm run compile`, `npm run lint` and `npm test` all pass, with no existing test expectations modified.
