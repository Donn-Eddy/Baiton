# Plan T08

## Steps

1. contextBudget.ts: reserve, overflow notice and the pure fitToWindow pre-flight

   Add to src/orchestrator/contextBudget.ts (no vscode import; keep imports type-only from './modelClient' and './modelCatalog' so no runtime cycle forms; do NOT import './contextTrim', which already imports estimateMessages from this module, so trimming is injected):

   1. `export const DEFAULT_OUTPUT_RESERVE = 8192;`
   2. `export function resolveOutputReserve(maxTokens: unknown, maxOutput: unknown): number` returns `maxTokens` when it is a positive integer, else `maxOutput` when it is a positive integer, else DEFAULT_OUTPUT_RESERVE. Use the existing private `positiveInteger`.
   3. `export function contextOverflowNotice(estimate: number, window: number): string` returns exactly `The conversation exceeds the model's context window (~${estimate} of ${window} tokens); compact it or start a new chat.` with plain integers and no separators.
   4. Types:
   ```ts
   export type FitVerdict =
     | { kind: 'send'; messages: ChatMessage[]; history?: ChatMessage[] }
     | { kind: 'overflow'; estimate: number; window: number };
   export interface FitOptions {
     /** The request about to be sent: [system, ...sendable]. */
     messages: readonly ChatMessage[];
     /** The loop's full (untrimmed) history. */
     history: readonly ChatMessage[];
     tools?: readonly ToolSpec[];
     window: number | undefined;
     reserve: number;
     /** Lossless trim of a history toward targetTokens under `estimate` (the controller binds trimHistory). */
     trim(history: readonly ChatMessage[], targetTokens: number, estimate: (h: readonly ChatMessage[]) => number): ChatMessage[];
     /** Lossy summarise; resolves the compacted history, or undefined when nothing was compacted / it failed. */
     summarise(): Promise<ChatMessage[] | undefined>;
   }
   export async function fitToWindow(opts: FitOptions): Promise<FitVerdict>
   ```
   Algorithm:
   - `window = positiveInteger(opts.window)`. When it is undefined, return `{ kind: 'send', messages: [...opts.messages] }`, because an unknown window never blocks.
   - `limit = window - opts.reserve`.
   - `system = opts.messages[0]?.role === 'system' ? [opts.messages[0]] : []`. `estimate = (h) => estimateMessages(system, undefined) + estimateMessages(h, opts.tools)`. When `system` is empty, the system cost is 0.
   - When `estimateMessages(opts.messages, opts.tools) <= limit`, return send with the original messages unchanged, so the common path is untouched.
   - Trim: `trimmed = opts.trim(opts.history, Math.max(0, limit), estimate)`. When `estimate(trimmed) <= limit`, return `{ kind: 'send', messages: [...system, ...trimmed] }`.
   - Summarise: `compacted = await opts.summarise()`. When it is defined, `best = estimate(compacted) <= limit ? compacted : opts.trim(compacted, Math.max(0, limit), estimate)`. When `estimate(best) <= limit`, return `{ kind: 'send', messages: [...system, ...best], history: compacted }`. Otherwise `best` stays `trimmed`.
   - Otherwise return `{ kind: 'overflow', estimate: estimate(best), window }`, where `best` is the smallest candidate tried: trimmed, or the trimmed compacted history when summarising ran.

   Document in a short JSDoc that the order is trim, then summarise, then re-estimate.

   Files: `src/orchestrator/contextBudget.ts`

2. toolLoop.ts: optional preflight on the ContextBudget seam

   In src/orchestrator/toolLoop.ts:
   - Import `FitVerdict` as a type and `contextOverflowNotice` as a value from './contextBudget'. There is no cycle: contextBudget imports only types from modelClient.
   - Extend `ContextBudget` with an OPTIONAL member, so the existing seams and tests compile unchanged:
   ```ts
   /**
    * Optional pre-flight run after prepare and before each completion. Resolves the
    * request to send (possibly reduced), optionally a replacement history (after a
    * summary), or an overflow verdict: the loop then appends the sized notice and
    * stops without calling the endpoint.
    */
   preflight?(req: { messages: ChatMessage[]; history: readonly ChatMessage[]; tools: readonly ToolSpec[]; signal: AbortSignal }): Promise<FitVerdict>;
   ```
   - In `runToolLoop`, change `const messages` to `let messages` after `sendable` is built, then add:
   ```ts
   if (deps.budget?.preflight !== undefined) {
     const verdict = await deps.budget.preflight({ messages, history, tools: deps.tools, signal: deps.signal });
     if (deps.signal.aborted) {
       await appendMessage(history, deps, { role: 'assistant', content: STOPPED_NOTICE });
       return;
     }
     if (verdict.kind === 'overflow') {
       await appendMessage(history, deps, { role: 'assistant', content: contextOverflowNotice(verdict.estimate, verdict.window) });
       return;
     }
     if (verdict.history !== undefined) {
       history.splice(0, history.length, ...verdict.history);
     }
     messages = verdict.messages;
   }
   ```
     The existing `observe({ messages, tools }, completion)` call keeps using the final `messages`. A preflight that throws propagates like any other loop error. With no budget, or a budget without `preflight`, the code path is byte-for-byte unchanged.
   - Update the ContextBudget doc comment to mention preflight.

   Files: `src/orchestrator/toolLoop.ts`

3. modelClient.ts: name the payload size on an empty-body 4xx

   In src/orchestrator/modelClient.ts:
   - `import { estimateMessages } from './contextBudget';` is a value import. contextBudget imports only types from modelClient, so no runtime cycle forms.
   - In `OpenAiModelClient.complete`, compute `const payloadTokens = estimateMessages(req.messages, req.tools ?? []);` and pass it to `postCompletion` as a new trailing optional parameter `payloadTokens?: number`, on both the streaming and non-streaming calls. Keep the parameter order compatible: add it after `extra`.
   - In `postCompletion`'s `res.on('end')` non-2xx branch:
   ```ts
   const emptyClientError = status >= 400 && status < 500 && text.trim().length === 0 && payloadTokens !== undefined;
   const detail = emptyClientError
     ? `endpoint returned HTTP ${status} (empty body; payload ~${payloadTokens} tokens)`
     : `endpoint returned HTTP ${status}: ${text.slice(0, 500)}`;
   finishReject(new UnreachableEndpointError(detail), { kind: 'http-status', status, message: emptyClientError ? detail : `endpoint returned HTTP ${status}`, bodyExcerpt: text });
   ```
     The thrown message then reads `Orchestrator endpoint was unreachable: endpoint returned HTTP 400 (empty body; payload ~N tokens)`, and the API-log line carries the same size, so the Baiton channel alone diagnoses the class-(b) failure. Non-empty bodies and 5xx keep today's exact text and log message, so the existing HTTP 500 and 401 tests stay green.

   Files: `src/orchestrator/modelClient.ts`

4. chatController.ts: wire preflight into contextBudget; new maxTokens/maxOutput deps

   In src/activation/chatController.ts:
   - Extend `ChatControllerDeps` with optional getters (both absent → reserve 8192):
   ```ts
   /** The raw `baiton.orchestrator.maxTokens` value; with maxOutput it sizes the pre-flight output reserve. */
   maxTokens?(): unknown;
   /** The selected model's catalog `maxOutput`, or undefined. */
   maxOutput?(): number | undefined;
   ```
   - Import `fitToWindow` and `resolveOutputReserve` from '../orchestrator/contextBudget', and add them to the existing import line.
   - Change the signature to `contextBudget(key, tools, autoApprovedLines, transcript: ChatTranscript, sessionId: string)` and update the one call site in `onSend` (currently `budget: this.contextBudget(key, tools, autoApprovedLines)`) to pass `transcript, sessionId`.
   - Add a `preflight` member to the returned object:
   ```ts
   preflight: (req) => fitToWindow({
     messages: req.messages,
     history: req.history,
     tools: req.tools,
     window: this.deps.contextWindow?.(),
     reserve: resolveOutputReserve(this.deps.maxTokens?.(), this.deps.maxOutput?.()),
     trim: (h, targetTokens, estimate) => trimHistory(h, { targetTokens, estimate, autoApprovedLines }),
     summarise: async () => {
       const compacted = await this.compact(transcript, key, req.signal, sessionId);
       if (compacted !== undefined) {
         this.postContextUsage(key);
       }
       return compacted;
     },
   }),
   ```
     `compact` already appends the compaction record, posts it, resets the tracker, surfaces a failed summary inline and returns undefined on abort or failure. When compaction finds nothing older than the last two turns, it returns undefined and fitToWindow reports overflow.
   - Also update the `onSend` doc and the `contextBudget` JSDoc to mention the pre-flight.

   Outside the listed files but needed for the reserve to work in production: in src/activation/commands.ts, in the `new ChatController({...})` literal next to `contextWindow:`, add
   `maxTokens: () => orchCfg().get('orchestrator.maxTokens'),`
   `maxOutput: () => selectedCatalogEntry(router.getSelection())?.maxOutput,`
   This is a two-line wiring edit, the same kind T06 made. When a reviewer forbids the edit, leave it out: the reserve then falls back to 8192, which is still correct behaviour.

   Files: `src/activation/chatController.ts`, `src/activation/commands.ts`

5. Tests: loop notice path, fitToWindow, reserve, and the empty-body error text

   test/toolLoop.test.ts, inside `describe('budget seam')`:
   - 'stops with the sized notice and never calls the endpoint on overflow': ScriptedClient([]) with an empty queue, where calling it would throw. The budget has `prepare: h => [...h]`, `observe` that counts calls, and `preflight: async () => ({ kind: 'overflow', estimate: 1234, window: 1000 })`. Assert `client.requests.length === 0`, observe count 0, `appended` deep-equals `[{ role: 'assistant', content: "The conversation exceeds the model's context window (~1234 of 1000 tokens); compact it or start a new chat." }]`, and history ends with the same message.
   - 'sends preflight messages and adopts its history': preflight returns `{ kind: 'send', messages: [{role:'system',content:'SYS'},{role:'assistant',content:'[context summary] s'},{role:'user',content:'q'}], history: [{role:'assistant',content:'[context summary] s'},{role:'user',content:'q'}] }`. Assert client.requests[0].messages equals those messages, and that after the loop `history[0].content` is '[context summary] s' followed by the final assistant 'done'.
   - 'preflight sees the prepared request each round': record `req.messages` and assert it equals `[system, ...prepare(h)]`.
   - 'abort during preflight appends the stopped notice': preflight aborts the controller, then returns send. Assert no request and `[STOPPED_NOTICE]` appended.
   - The existing 'sends [system, ...history] when no budget is given' test stays unchanged.

   test/contextBudget.test.ts (existing suite for this module):
   - `resolveOutputReserve`: returns (4096, 9999) → 4096; (0, 9999) → 9999; (undefined, undefined) → 8192; ('x', 1.5) → 8192.
   - `contextOverflowNotice(5, 10)` returns the exact string.
   - `fitToWindow`:
     - When window is undefined, it returns send with the same messages, and neither trim nor summarise is called.
     - When the payload is under `window - reserve`, it returns send unchanged with no trim call.
     - When trim is enough, it returns send with `[system, ...trimmed]` and summarise is not called.
     - When trim is not enough and summarise returns a small history, it returns send with that history and `history` set.
     - When summarise returns undefined, it returns overflow whose `estimate` equals the trimmed estimate and whose `window` is the window.
     - When the summary is still too big, it returns overflow.
     - Use large `'x'.repeat(n)` contents so the estimates are deterministic: ceil(bytes/4) plus 4 per message.

   test/modelClient.test.ts, next to the HTTP 500 logging test:
   - 'names the payload size on an empty-body HTTP 400': the mock server returns `{ status: 400, body: '' }` and the request has messages `[{ role: 'user', content: 'x'.repeat(400) }]`. Assert the error is an UnreachableEndpointError with message `Orchestrator endpoint was unreachable: endpoint returned HTTP 400 (empty body; payload ~104 tokens)`, where 104 = 4 + 100. Compute the expected N with `estimateMessages` imported from '../src/orchestrator/contextBudget' when the req() helper also sends tools. The one api-log line contains `(empty body; payload ~`.
   - 'keeps the body text on a non-empty 400': `{ status: 400, body: 'bad' }` gives a message ending `HTTP 400: bad`.
   - A whitespace-only body such as '  \n' counts as empty.

   Optional: in test/chatController.compaction.test.ts, add one controller test with contextWindow 1000, a fat seeded transcript and a summary request that fails. Assert the last transcript record is the overflow notice and that no tool-loop request carries the tools. Skip it when it is brittle against the ~1200-token system prompt noted in T06.

   Files: `test/toolLoop.test.ts`, `test/contextBudget.test.ts`, `test/modelClient.test.ts`, `test/chatController.compaction.test.ts`

6. Verify

   Run `npm run compile`, `npm run lint` and `npm test`, and confirm all three are green. Then run `grep -rn "from 'vscode'" src/orchestrator`, which must show only the existing copilotClient.ts type import. `runToolLoop` without a budget, or with a budget that lacks preflight, must be unchanged, and the existing toolLoop tests must pass untouched.

   Files: (none)

## Risks

- The real system prompt is about 1200 tokens (T06 note). Controller-level tests with a tiny window always overflow. Keep the pre-flight logic tested at the fitToWindow and loop-seam level, and pick windows large enough for any controller test.
- When window − reserve is ≤ 0 (a tiny window, or max_tokens ≥ window), every request overflows. This is intended: the endpoint would refuse it anyway. `Math.max(0, limit)` keeps trim's target non-negative.
- Mid-loop summarising appends a compaction record while the current turn is in flight. compactionCut keeps the last two turns, so the open tool_calls/tool pairs of the current round stay verbatim. The loop's `history` array is replaced in place with splice, so later rounds and the controller's re-render stay consistent.
- commands.ts is not in the todo's file list, but without the two-line wiring the reserve always falls back to 8192, which ignores the configured max_tokens and the catalog maxOutput. This is flagged in the step so the reviewer can accept it.
- The modelClient ↔ contextBudget value import could form a cycle if contextBudget ever gains a value import from modelClient. Today it imports only types, so it is safe; keep it type-only.
- The failure log's `message` changes only for empty-body 4xx. Existing api-log regexes for 500 and 401 with bodies must stay byte-identical, so do not alter the non-empty branch.

## Acceptance

- `ContextBudget` has an optional `preflight`. With an overflow verdict, `runToolLoop` appends exactly `The conversation exceeds the model's context window (~N of W tokens); compact it or start a new chat.` to history and the transcript and returns without calling `client.complete` or `observe`.
- A send verdict's `messages` is what the client receives. Its optional `history` replaces the loop's history in place.
- `fitToWindow` in src/orchestrator/contextBudget.ts returns send unchanged when the window is unknown or the payload fits within window − reserve. Otherwise it tries trim, then summarise, then re-estimates, and returns overflow with the best estimate. It is covered by unit tests.
- `resolveOutputReserve` picks configured max_tokens, else maxOutput, else 8192.
- ChatController's per-send budget wires preflight through fitToWindow, using trimHistory and the existing `compact`, with reserve from new optional deps `maxTokens`/`maxOutput`.
- An HTTP 4xx with an empty or whitespace body throws `UnreachableEndpointError` with message `Orchestrator endpoint was unreachable: endpoint returned HTTP 400 (empty body; payload ~N tokens)`, where N = estimateMessages(req.messages, req.tools). Non-empty bodies and 5xx keep today's text. modelClient tests cover both.
- No new `vscode` import in src/orchestrator/. runToolLoop without a budget or preflight behaves exactly as before, and the existing toolLoop tests pass unmodified.
- `npm run compile`, `npm run lint` and `npm test` are all green.
