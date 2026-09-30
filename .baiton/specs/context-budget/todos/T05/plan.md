# Plan T05

## Steps

1. Create the pure trim module src/orchestrator/contextTrim.ts

   New file, NO `vscode` import; imports only types from './modelClient' (ChatMessage, ToolCall), './chatTranscript' (TranscriptRecord), './webviewProtocol' (InterventionView type) and values `interventionHistoryText` from './transcriptReader' and `estimateMessages` from './contextBudget'. File-top doc comment in the style of toolLoop.ts/contextBudget.ts: it trims one round's payload only, never the transcript, and never breaks tool pairing.

   Exports:

   1. `export const CONTEXT_TRIM_AT_SETTING = 'baiton.orchestrator.contextTrimAt';`
      `export const DEFAULT_CONTEXT_TRIM_AT = 0.5;`
      `export const TRIM_LARGE_RESULT_BYTES = 2048;` (threshold for pass 3)
      `export const TRIM_KEEP_RECENT_ROUNDS = 2;`

   2. `export function resolveContextTrimAt(configured: unknown): number` — returns `configured` when it is a finite number with 0 < v <= 1, else DEFAULT_CONTEXT_TRIM_AT. Pure, never throws.

   3. `export function trimmedResultStub(tool: string, bytes: number, callId: string): string` returning exactly `[trimmed ${tool} result: ${bytes} bytes; call ${callId}]` (bytes = Buffer.byteLength(original content,'utf8')). Use tool name `unknown` when the call id is not found among the preceding assistant tool_calls.

   4. `export function autoApprovedInterventionLines(records: readonly TranscriptRecord[]): Set<string>` — for each intervention id, take the settled view the same way `toHistory` does (last view with status 'resolved', else the first seen); if that view has `auto === true`, add `interventionHistoryText(view)` to the set. This is how the trim identifies replayed auto-approved intervention lines without changing `toHistory`'s output (which must stay exactly as today).

   5. `export interface TrimOptions { targetTokens: number; estimate?: (messages: readonly ChatMessage[]) => number; autoApprovedLines?: ReadonlySet<string>; keepRecentRounds?: number; largeResultBytes?: number; }` — `estimate` defaults to `(m) => estimateMessages(m)`.

   6. `export function trimHistory(history: readonly ChatMessage[], opts: TrimOptions): ChatMessage[]`
      - Never mutates `history` or any message object in it: work on `const out = history.map((m) => m)` (shallow array copy) and replace entries with NEW objects (`{ ...m, content: stub }`) — never assign to m.content.
      - If `estimate(out) <= targetTokens` return `out` immediately (unchanged copy).
      - Turn segmentation: turn boundaries are the indices of `role === 'user'` messages. `currentStart` = index of the last user message (0 if none); `prevStart` = index of the user message before it (0 if none, i.e. there is no earlier turn). "Earlier turns" = indices < prevStart. (If there is only one user message, earlier turns are indices < 0 = none; if none, whole history is the current turn.)
      - Build `callOwner: Map<callId, { tool: string }>` from every assistant message's `tool_calls` (name per id), used for the stub's tool name.
      - Pass 1 (drop auto-approved intervention lines), oldest first: for i ascending, if `m.role === 'assistant'` && no/empty `tool_calls` && `opts.autoApprovedLines?.has(m.content)` → remove it (splice out of `out`, adjusting indices; simplest is to build candidate index list first then remove one at a time from the front, recomputing segmentation after each pass or tracking by object identity). After each removal re-check `estimate(out) <= targetTokens` and return early when satisfied. Never remove a message that has tool_calls, a `tool` message, or a `user` message. Note: an intervention line removed from between messages cannot break pairing because toHistory never places intervention lines inside a call window.
      - Pass 2 (stub tool results from earlier turns), oldest first: for each `tool` message with index < prevStart (recompute prevStart after pass 1 or track messages by identity: easiest is to compute segmentation on `out` at the start of each pass), replace with `{ role: 'tool', tool_call_id: m.tool_call_id, content: trimmedResultStub(tool, bytes, id) }` ONLY when the stub is strictly shorter in UTF-8 bytes than the original content (so the estimate never grows and an already-stubbed result is left alone). Re-check the estimate after each replacement; return early when <= target.
      - Pass 3 (older rounds in the current turn): within [currentStart, end), a round starts at each assistant message carrying non-empty tool_calls. Keep the last `keepRecentRounds` (default 2) rounds untouched; for tool messages belonging to earlier rounds of the current turn whose content is > `largeResultBytes` (default 2048) bytes, stub them the same way (again only when strictly shorter). Also apply pass-3 rule to the previous turn? NO — the previous turn is protected entirely (overview: every turn except the current one and the one before it). Re-check after each replacement.
      - Return `out` (possibly still above target — the caller decides what happens next; summarising is a later todo).
      - Assistant `tool_calls` entries and every `tool_call_id` are always preserved, message count only shrinks via pass 1, and message order is preserved.

   Keep helpers private (`userIndices(out)`, `roundStarts(out, from)`, `utf8Bytes(s)`). Comment density: one short doc comment per export, matching contextBudget.ts.

   Files: `src/orchestrator/contextTrim.ts`

2. Add the optional budget seam to runToolLoop

   In src/orchestrator/toolLoop.ts:
   - Import `CompletionResult` type from './modelClient' (add to the existing import list).
   - Add and export:
   ```ts
   /**
    * Optional per-round context budget. `prepare` returns the history to send this
    * round (it must not mutate `history`; the loop keeps appending to the real
    * history and the transcript); `observe` sees what was sent and the completion.
    */
   export interface ContextBudget {
     prepare(history: readonly ChatMessage[]): ChatMessage[];
     observe(sent: { messages: readonly ChatMessage[]; tools: readonly ToolSpec[] }, completion: CompletionResult): void;
   }
   ```
   - Add `budget?: ContextBudget;` to `ToolLoopDeps` with a doc line (absent → the loop sends the full history exactly as before).
   - In the round body replace
     `const messages: ChatMessage[] = [{ role: 'system', content: system }, ...history];`
     with
     `const sendable = deps.budget !== undefined ? deps.budget.prepare(history) : history;`
     `const messages: ChatMessage[] = [{ role: 'system', content: system }, ...sendable];`
   - Right after the `try { completion = await deps.client.complete(...) } catch {...}` block and BEFORE the post-completion abort check, add `deps.budget?.observe({ messages, tools: deps.tools }, completion);` Wrap nothing else; if observe throws, let it propagate like any other error (controller's observe must not throw — note it in the doc).
   - Everything else (appendMessage pushing onto `history`, notices, abort handling) stays byte-for-byte identical, so existing tests pass unchanged when `budget` is absent.

   Files: `src/orchestrator/toolLoop.ts`

3. Wire the controller: tracker, trim threshold, budget seam

   In src/activation/chatController.ts:
   - Imports: `import { ContextTracker, estimateMessages } from '../orchestrator/contextBudget';` and `import { autoApprovedInterventionLines, resolveContextTrimAt, trimHistory } from '../orchestrator/contextTrim';` plus `type ContextBudget` from '../orchestrator' (toolLoop is re-exported by the barrel) or directly from '../orchestrator/toolLoop'.
   - `ChatControllerDeps` gains two optional seams (with doc comments like their neighbours):
     `contextWindow?(): number | undefined;` — the selected model's context window in tokens (already resolved through `resolveContextWindow`), undefined when unknown. Absent → unknown.
     `contextTrimAt?(): unknown;` — the raw `baiton.orchestrator.contextTrimAt` value, resolved through `resolveContextTrimAt`. Absent → default 0.5.
   - Add field `private readonly trackers = new Map<string, ContextTracker>();` (doc: one tracker per conversation, keyed `<scopeKey>/<sessionId>`), and a private `trackerFor(key: string): ContextTracker` that lazily creates `new ContextTracker(() => this.deps.contextWindow?.())`. (The meter that posts `tracker.status()` is a later todo; do not add webview messages here.)
   - In `onSend`: replace `const history = await this.loadHistory(transcript.path);` with reading the records once:
     `const records = await readTranscript(transcript.path);`
     `const history = toHistory(records);`
     `const autoApprovedLines = autoApprovedInterventionLines(records);`
     Keep `loadHistory` if it has other callers (it currently has only this one; if it becomes unused delete it so lint stays clean — `readTranscript`/`toHistory` are already imported).
   - Build the budget and pass it to runToolLoop as `budget: this.contextBudget(this.runningKey, tools, autoApprovedLines)` where `tools = this.deps.toolsFor(phase)` is hoisted into a local and reused for the `tools:` dep. Implement:
   ```ts
   /**
    * The per-send context budget: trims the round's payload once the local
    * estimate passes `contextTrimAt` of a known window, and records each
    * completion on the conversation's tracker. Unknown window → sends everything.
    */
   private contextBudget(key: string, tools: ToolSpec[], autoApprovedLines: ReadonlySet<string>): ContextBudget {
     const tracker = this.trackerFor(key);
     let systemTokens = 0; // last system prompt's estimate, learned in observe
     const estimate = (h: readonly ChatMessage[]): number => systemTokens + estimateMessages(h, tools);
     return {
       prepare: (history) => {
         const window = this.deps.contextWindow?.();
         if (window === undefined) { return [...history]; }
         const trimAt = resolveContextTrimAt(this.deps.contextTrimAt?.());
         if (estimate(history) / window <= trimAt) { return [...history]; }
         return trimHistory(history, { targetTokens: Math.floor(window * trimAt), estimate, autoApprovedLines });
       },
       observe: (sent, completion) => {
         const system = sent.messages[0];
         systemTokens = system?.role === 'system' ? estimateMessages([system]) : 0;
         tracker.record(sent, completion);
       },
     };
   }
   ```
     Validate `contextWindow()` output defensively (positive integer, else treat as unknown) — reuse the same rule as contextBudget's `positiveInteger` by checking `Number.isInteger(w) && w > 0` inline. `runningKey` is set just before the try; compute the key string locally (`${scopeId(scope)}/${sessionId}`) and use it for both `runningKey` and the tracker so no non-null assertion is needed.
   - Nothing else in onSend changes; `renderConversation` still renders the full transcript.

   Files: `src/activation/chatController.ts`

4. Contribute the setting and wire the host seams

   package.json: under contributes.configuration properties, next to `baiton.orchestrator.contextWindow`, add
   ```json
   "baiton.orchestrator.contextTrimAt": {
     "type": "number",
     "default": 0.5,
     "minimum": 0,
     "maximum": 1,
     "description": "Fraction of the model's context window at which the chat starts trimming what it sends: auto-approved intervention lines are dropped, then tool results from earlier turns and older rounds are replaced with short stubs. The transcript is never changed. Applies only when the context window is known (catalog or baiton.orchestrator.contextWindow)."
   }
   ```

   src/activation/commands.ts (the ChatController construction at ~line 842; `orchCfg` is defined at ~line 601 and `router` is the ProviderRouter; `getModelCatalogStore` is already imported):
   - `contextTrimAt: () => orchCfg().get('orchestrator.contextTrimAt'),`
   - `contextWindow: () => resolveContextWindow(selectedCatalogEntry(router.getSelection()), orchCfg().get('orchestrator.contextWindow')),` with `resolveContextWindow` imported from '../orchestrator/contextBudget'.
   - Add a small private helper in commands.ts: `function selectedCatalogEntry(selection: ModelSelection | undefined): ModelEntry | undefined` that reads `getModelCatalogStore()?.get('models.dev')?.models`, returns the entry with `id === selection.model && provider === selection.provider`, else the first entry with `id === selection.model`, else undefined (undefined selection → undefined). Import the `ModelEntry`/`ModelSelection` types from their modules if not already imported. Keep it minimal; a later todo may replace it when the meter lands.

   Files: `package.json`, `src/activation/commands.ts`

5. Unit tests for trimHistory: test/contextTrim.test.ts

   Mocha + assert, importing from '../src/orchestrator/contextTrim' and estimateMessages from '../src/orchestrator/contextBudget'. Helpers: `user(t)`, `asstCalls(...ids)` (assistant with tool_calls [{id, name:'read_file', arguments:'{}'}]), `tool(id, bytes)` (content 'x'.repeat(bytes)), `asst(t)`. Cases:
   1. Under target → returns an equal array (deepStrictEqual) and the input array/objects are not mutated (deep-freeze or JSON snapshot before/after).
   2. Pass 1: history containing `interventionHistoryText` line of an auto-approved card (build set via `autoApprovedInterventionLines` from records with `intervention: { id:'a', kind:'permission', prompt:'Run ls', status:'resolved', answer:{kind:'approved'}, auto:true }`) and one non-auto card → only the auto line is dropped, the manual one kept; with a target reached after pass 1, no tool result is stubbed.
   3. `autoApprovedInterventionLines`: pending+resolved pair where resolved has auto:true → included; resolved without auto → excluded.
   4. Pass 2: three turns each with a large tool result → earlier-turn result becomes exactly `[trimmed read_file result: <n> bytes; call <id>]`, `tool_call_id` preserved, the assistant tool_calls entry unchanged; previous and current turn results untouched when the target is met.
   5. Oldest first: two earlier-turn results, target reachable by stubbing one → only the oldest is stubbed.
   6. Pass 3: single turn with 4 rounds of large results and an unreachable target → rounds 1–2 stubbed, last 2 rounds intact; a small (< TRIM_LARGE_RESULT_BYTES) old-round result is left alone.
   7. Previous turn protected: even with an unreachable target, tool results in the turn before the current one are never stubbed.
   8. Stub never grows: a tool result shorter than its stub is left as is; running trimHistory twice is idempotent.
   9. `resolveContextTrimAt`: 0.7→0.7, 1→1, 0/-1/1.5/NaN/'0.6'/undefined → 0.5.
   10. `trimmedResultStub('x', 10, 'c1')` exact string.

   Files: `test/contextTrim.test.ts`

6. Property test: test/contextTrim.property.test.ts

   fast-check (already a devDependency; see test/transcriptReader.test.ts for the import style `import * as fc from 'fast-check'`). Arbitrary: a valid history = array of turns; each turn = user message, then 0–4 rounds, each round = assistant with 1–3 unique tool_calls (ids unique across the history, e.g. `c${n}` from a counter in a `.map`) followed immediately by one `tool` message per call in order with content of random length (0–6000 chars, use fc.string or 'x'.repeat(n) for speed), then optionally a final plain assistant message; optionally interleave intervention lines (plain assistant `[intervention] p\nDecision: approved`) between rounds/after turns, a random subset of whose contents goes into `autoApprovedLines`. targetTokens = fc.nat up to the full estimate. Properties (numRuns ~200):
   (a) pairing: in the output, every `tool` message's tool_call_id is among the tool_calls of the nearest preceding non-tool message, which must be an assistant with tool_calls, and every assistant tool_calls id is answered by the tool messages immediately following it (same set, same order as input);
   (b) `estimateMessages(out) <= estimateMessages(input)` (never grows) and output length <= input length;
   (c) input is not mutated (compare JSON.stringify before/after);
   (d) user messages and assistant messages carrying tool_calls are all present and in the same relative order;
   (e) only messages whose content is in autoApprovedLines are ever removed;
   (f) if the output estimate is still above target, then every earlier-turn tool result whose stub is shorter has been stubbed (passes ran to exhaustion).

   Files: `test/contextTrim.property.test.ts`

7. Tool-loop seam tests in test/toolLoop.test.ts

   Add a new `describe('budget seam', ...)` block using the existing ScriptedClient and makeDeps helpers (pass `budget` via overrides; makeDeps spreads overrides into deps — check and add `...(overrides.budget !== undefined ? { budget: overrides.budget } : {})` in makeDeps if it does not spread all overrides). Do NOT change existing test expectations. Cases:
   1. prepare's return value is what the client receives: a budget whose prepare returns `[{ role:'user', content:'trimmed' }]` → `client.requests[0].messages` deep-equals `[system, {user 'trimmed'}]`, while the `history` array passed to runToolLoop still contains the original user message plus appended assistant/tool messages, and `appended` (transcript) contains the full untrimmed tool results.
   2. prepare is called once per round with the live history (length grows between rounds; a second-round call sees the tool message appended in round 1).
   3. observe is called once per completion with `sent.messages` identical to the request's messages, `sent.tools === deps.tools`, and the completion object returned by the client (including a `usage` field when scripted).
   4. observe is not called when the completion rejects (abort path) — the stopped notice is still appended.
   5. Without `budget`, requests are identical to before (one existing-style assertion that messages === [system, ...history]).

   Files: `test/toolLoop.test.ts`

8. Verify

   Run `npm run compile`, `npm run lint`, `npm test`. Confirm with grep that `src/orchestrator/contextTrim.ts` has no `vscode` import, and that `git diff` of toolLoop.ts touches only the budget interface/field, the `sendable` line and the `observe` call. Existing tests must pass unmodified (only additions in test/toolLoop.test.ts). If a chatController test constructs deps without the new optional seams, it must keep passing (unknown window → no trimming).

   Files: (none)

## Risks

- toHistory's output carries no `auto` flag, so pass 1 identifies auto-approved lines by exact content match against `interventionHistoryText(view)` of auto-settled cards; a manual card with the identical prompt and decision text would also be dropped. Acceptable (same information) but note it; do not change toHistory's output format.
- The trim decision uses the local bytes/4 estimate of the about-to-send payload (plus the last round's system prompt estimate learned in observe; 0 on the first round), not the endpoint's usage count, so it can under-count; the tracker still records usage for the later meter/pre-flight todos.
- trimHistory must not mutate history messages: the loop keeps pushing to the same `history` array and the transcript must keep full results. Replace entries with new objects only.
- Host-side window lookup matches the selection's model id against the models.dev snapshot by exact id (provider preferred); providers whose selection ids differ from models.dev ids resolve to the contextWindow setting or unknown, in which case no automatic trimming happens (by design).
- makeDeps in test/toolLoop.test.ts may not forward arbitrary overrides; adding `budget` forwarding must not alter defaults for existing tests.
- commands.ts is not in the todo's listed files but is the only place the host seams can be wired; keep the change to two deps lines plus one small helper.

## Acceptance

- src/orchestrator/contextTrim.ts exists, imports no `vscode`, and exports trimHistory, autoApprovedInterventionLines, trimmedResultStub, resolveContextTrimAt, CONTEXT_TRIM_AT_SETTING, DEFAULT_CONTEXT_TRIM_AT.
- trimHistory applies passes in order (auto-approved intervention lines, earlier-turn tool results, older-than-last-two-rounds large results in the current turn), oldest first, stopping once the estimate is <= targetTokens; stubs read `[trimmed <tool> result: <m> bytes; call <id>]` and keep tool_call_id and the assistant tool_calls entries.
- ToolLoopDeps has an optional `budget?: ContextBudget` with `prepare(history)` and `observe(sent, completion)`; with no budget the loop's requests and appends are unchanged and all pre-existing toolLoop tests pass without edits.
- With a budget, the client receives `[system, ...prepare(history)]` while the in-memory history and the transcript receive the full, untrimmed messages.
- ChatController builds a budget per send that trims only when the context window is known and estimate/window exceeds resolveContextTrimAt(baiton.orchestrator.contextTrimAt), and records each completion on a per-conversation ContextTracker.
- package.json contributes `baiton.orchestrator.contextTrimAt` (number, default 0.5).
- test/contextTrim.property.test.ts asserts trimming never breaks tool pairing and never grows estimateMessages, and passes.
- `npm run compile`, `npm run lint` (no new warnings/errors) and `npm test` all pass.
