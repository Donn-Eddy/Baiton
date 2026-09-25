# Plan T02

## Steps

1. Add dialect + header-style fields to the provider catalog

   In src/orchestrator/providers.ts add, above `ProviderInfo`:

     /** Which wire shaping a provider's OpenAI-compatible payload needs. */
     export type DialectId = 'openai' | 'gemini';
     /** Which extra request headers a provider needs beyond the OpenAI defaults. */
     export type HeaderStyleId = 'default' | 'opencode';

   Add two required fields to `ProviderInfo` with doc comments: `dialect: DialectId` ('the wire shaping applied to messages before serialisation; `gemini` fixes Google's tool-chaining rejections') and `headerStyle: HeaderStyleId` ('extra headers added to every request; `opencode` adds User-Agent and x-opencode-session').

   Fill them in the `PROVIDERS` record: copilot `{ dialect: 'openai', headerStyle: 'default' }` (unused — the Copilot client is not HTTP, note that in a comment), google `{ dialect: 'gemini', headerStyle: 'default' }`, opencode `{ dialect: 'openai', headerStyle: 'opencode' }`, mistral `{ dialect: 'openai', headerStyle: 'default' }`, openai `{ dialect: 'openai', headerStyle: 'default' }`.

   Keep providers.ts host-free and dependency-free: do NOT import anything from modelClient.ts (providers.ts stays pure data; modelClient.ts maps these ids to implementations). Existing test/providers.test.ts makes no whole-object deepStrictEqual on `ProviderInfo`, so adding fields does not break it; leave that file untouched.

   Files: `src/orchestrator/providers.ts`

2. Add `sessionId` to CompletionRequest

   In src/orchestrator/modelClient.ts add to `CompletionRequest`:

     /**
      * The chat session this completion belongs to. Never serialised into the
      * request body; it is handed to `extraHeaders` so a provider can derive a
      * per-conversation header (OpenCode's `x-opencode-session`).
      */
     sessionId?: string;

   It is optional, so `runToolLoop` (src/orchestrator/toolLoop.ts) and `evaluateAsk` (src/orchestrator/autoMode.ts) keep compiling untouched — threading it from the controller is a later todo and is out of scope here. Assert in a test that `sessionId` never appears in the JSON body.

   Files: `src/orchestrator/modelClient.ts`

3. Introduce the WireDialect seam and the default OpenAI dialect

   In src/orchestrator/modelClient.ts, below `toWireToolCall`, add:

     /** One message as it goes on the wire; `content` may be omitted entirely. */
     export interface WireMessage {
       role: 'system' | 'user' | 'assistant' | 'tool';
       content?: string;
       tool_call_id?: string;
       tool_calls?: unknown[];
     }

     /** Shapes the recorded transcript into the messages array a provider accepts. */
     export interface WireDialect {
       shapeMessages(messages: ChatMessage[]): WireMessage[];
     }

     export function shapeOpenAiMessages(messages: ChatMessage[]): WireMessage[]
     export const openAiDialect: WireDialect = { shapeMessages: shapeOpenAiMessages };

   `shapeOpenAiMessages` must reproduce today's serialisation byte for byte — lift the existing inline `req.messages.map(...)` in `complete()` verbatim: `{ role, content, ...(tool_call_id !== undefined ? { tool_call_id } : {}), ...(tool_calls?.length ? { tool_calls: tool_calls.map(toWireToolCall) } : {}) }`.

   Add `dialect?: WireDialect;` to `ModelClientConfig` (doc: 'defaults to {@link openAiDialect}'). In `complete()`, replace the inline map with `const dialect = this.config.dialect ?? openAiDialect;` and `messages: dialect.shapeMessages(req.messages)`. Nothing else in the body changes (`tools`, `stream`, `max_tokens` keep their current shape and order).

   Also export a lookup so the host glue can go from catalog to implementation:

     export function dialectFor(id: DialectId): WireDialect  // 'gemini' -> geminiDialect, else openAiDialect

   importing `DialectId` (type-only import) from './providers'. modelClient.ts may depend on providers.ts; the reverse must not happen.

   Files: `src/orchestrator/modelClient.ts`

4. Implement the Gemini dialect (the tool-chaining fix)

   In src/orchestrator/modelClient.ts add `export function shapeGeminiMessages(messages: ChatMessage[]): WireMessage[]` and `export const geminiDialect: WireDialect = { shapeMessages: shapeGeminiMessages };`, with a doc comment stating the three rejections it works around (empty assistant content on a tool_calls turn, stray keys / detached position on tool messages, non-object argument strings).

   Rules, all enforced in one pass:

   1. Assistant turn with a non-empty `tool_calls`: emit `{ role: 'assistant', ...(content.trim() !== '' ? { content } : {}), tool_calls: [...] }` — the `content` key is OMITTED, not set to `''`, when the recorded content is empty or whitespace-only. Content that is non-empty is preserved verbatim (untrimmed).
   2. Argument sanitising: a helper `export function sanitizeToolArguments(args: string): string` returns `args` unchanged when `JSON.parse(args)` yields a non-null, non-array object; otherwise `'{}'` (covers `''`, malformed JSON, `'null'`, `'[1,2]'`, `'"x"'`, `'3'`). Never throws. Applied to every call's `arguments` when building the wire `tool_calls` entry `{ id, type: 'function', function: { name, arguments } }`.
   3. Tool messages carry exactly three keys — `role`, `tool_call_id`, `content` — in that order; any `tool_calls` on a recorded `tool` message is dropped and `content` falls back to `''` when undefined. A tool message with no `tool_call_id` is dropped.
   4. Ordering: each `tool` message is emitted immediately after the assistant turn that requested its `tool_call_id`, in the order of that turn's `tool_calls` (and, for repeats of the same id, in transcript order). Implement by first bucketing tool messages by `tool_call_id` into a `Map<string, ChatMessage[]>`, then walking `messages` in order: skip `tool` messages in the main walk; when emitting an assistant tool_calls turn, drain each call's bucket right after it.
   5. Orphan tool messages — ones whose `tool_call_id` matches no assistant call anywhere in `messages` — are dropped entirely rather than trailing the transcript.
   6. Every other message (`system`, `user`, plain `assistant` with no calls) is emitted as `{ role, content }`; an assistant turn with an empty `tool_calls` array is treated as a plain assistant message and keeps `content: ''`.

   Files: `src/orchestrator/modelClient.ts`

5. Add the extraHeaders hook and the OpenCode header provider

   In src/orchestrator/modelClient.ts add:

     /** Extra request headers for one completion, keyed by lowercase header name. */
     export type ExtraHeadersProvider = (req: CompletionRequest) => Record<string, string> | undefined;

   and `extraHeaders?: ExtraHeadersProvider;` on `ModelClientConfig`.

   In `complete()`, compute `const extra = this.config.extraHeaders?.(req) ?? {};` and pass it into `postCompletion(url, apiKey, body, req.signal, extra, onChunk?)` — add the parameter rather than reading config again there, so the value is computed once per completion. Inside `postCompletion`, build the header map as `{ ...lowercaseKeys(extra), 'content-type': 'application/json', authorization: `Bearer ${apiKey}`, 'content-length': Buffer.byteLength(body).toString() }` — the three base headers are spread LAST so an extras provider can never clobber auth, content type or length. Add a small `function lowercaseKeys(h: Record<string, string>): Record<string, string>` so casing from a provider (`User-Agent`) cannot produce a duplicate header.

   Then add the OpenCode provider factory:

     export interface OpenCodeHeaderOptions {
       /** Extension version, rendered as `baiton/<version>` in User-Agent. */
       version: string;
       /** Session-uuid generator; defaults to crypto.randomUUID (injectable for tests). */
       newSessionId?: () => string;
     }
     export function openCodeExtraHeaders(options: OpenCodeHeaderOptions): ExtraHeadersProvider

   Behaviour: returns `{ 'user-agent': `baiton/${version}`, 'x-opencode-session': <uuid> }`. The uuid must be stable for the whole conversation: keep a closed-over `Map<string, string>` keyed by `req.sessionId ?? ''`, minting through `newSessionId` on first miss and reusing thereafter — so two completions with the same `sessionId` send the same header, two different `sessionId`s send different ones, and calls with no `sessionId` share one stable per-factory value. Import `randomUUID` from 'crypto' (the repo already does this in src/engine/runQueue.ts).

   Files: `src/orchestrator/modelClient.ts`

6. Mock-server tests for headers, sessionId and both dialects

   In test/modelClient.test.ts, first extend the harness: add `headers: http.IncomingHttpHeaders;` to `CapturedRequest` and record `req.headers` alongside `authorization`/`body` in `startMockServer`. Existing tests are unaffected.

   Add these describe blocks inside `describe('OpenAiModelClient')`:

   1. `describe('extraHeaders')` — a client configured with `extraHeaders: () => ({ 'User-Agent': 'baiton/9.9.9', 'x-opencode-session': 'abc' })` sends both headers (assert on `mock.captured[0].headers['user-agent']` and `['x-opencode-session']`, proving the casing is normalised); a provider returning `{ authorization: 'Bearer evil', 'content-type': 'text/plain', 'content-length': '0' }` does NOT override the base headers (assert authorization is still `Bearer test-key`, content-type `application/json`, and the request still succeeds); a provider returning `undefined` sends the base headers unchanged; the provider receives the live `CompletionRequest` (capture the argument and assert its `sessionId` and `messages`).

   2. `describe('sessionId')` — `complete({ ..., sessionId: 's-1' })` produces a body with no `sessionId` key (`assert.ok(!('sessionId' in (mock.captured[0].body as object)))`).

   3. `describe('openCodeExtraHeaders')` — with `newSessionId` a deterministic counter (`() => `uuid-${n++}``): two completions with `sessionId: 's-1'` send the same `x-opencode-session`; a completion with `sessionId: 's-2'` sends a different one; two completions with no `sessionId` share one value; `user-agent` is exactly `baiton/0.0.1` for `version: '0.0.1'`. Drive these end-to-end through the mock server so the headers are asserted as received.

   4. `describe('openAiDialect (default)')` — a regression guard: with no `dialect` configured, an assistant `tool_calls` turn recorded with `content: ''` still serialises `content: ''` and the wire `tool_calls` entry keeps `{ id, type: 'function', function: { name, arguments } }` with the arguments string verbatim (including a malformed one), i.e. nothing about today's payload changed.

   5. `describe('geminiDialect')` — unit-test `shapeGeminiMessages` directly with `assert.deepStrictEqual` for: (a) assistant turn with `content: ''` + tool_calls → no `content` key (assert via `Object.keys`); (b) `content: '   '` → also omitted; (c) non-empty content preserved; (d) a tool message keyed exactly `['content','role','tool_call_id']` after sorting, with a stray `tool_calls` on it dropped and missing content becoming `''`; (e) a transcript where the tool message is separated from its assistant turn by a later user message is reordered so the tool message directly follows the assistant turn; (f) a tool message whose `tool_call_id` matches nothing is dropped; (g) two tool calls in one assistant turn emit their two tool messages in call order; (h) `sanitizeToolArguments` table: `'{"a":1}'` → unchanged, `''` → `'{}'`, `'not json'` → `'{}'`, `'null'` → `'{}'`, `'[1]'` → `'{}'`, `'"x"'` → `'{}'`, `'3'` → `'{}'`. Then one end-to-end case through the mock server with `dialect: geminiDialect` asserting the received body's `messages` array matches the shaped form.

   Files: `test/modelClient.test.ts`

7. Verify

   Run, from the repo root: `npx tsc --noEmit -p tsconfig.json`; `npx eslint src/orchestrator/modelClient.ts src/orchestrator/providers.ts test/modelClient.test.ts --ext .ts` (the pre-existing no-unused-vars warning in src/orchestrator/webviewProtocol.ts is unrelated — do not touch that file); `npx mocha test/modelClient.test.ts`; `npx mocha test/providers.test.ts`; `npm run test:unit` (baseline on this branch: 1170 passing / 1 pending — it must not regress). src/orchestrator/index.ts already re-exports both modules with `export *`, so the new symbols are exported automatically; check the new names (`WireMessage`, `WireDialect`, `DialectId`, `HeaderStyleId`, `ExtraHeadersProvider`, `openAiDialect`, `geminiDialect`, `dialectFor`, `shapeOpenAiMessages`, `shapeGeminiMessages`, `sanitizeToolArguments`, `openCodeExtraHeaders`, `OpenCodeHeaderOptions`) collide with nothing else re-exported there — tsc will flag it if they do.

   Files: `src/orchestrator/index.ts`

## Risks

- Byte-drift on the default path: `shapeOpenAiMessages` must be a verbatim lift of the current inline map. Any change (e.g. omitting empty `content` for everyone) would alter payloads for Mistral/OpenAI/OpenCode and can break the existing streaming and tool round-trip tests. Keep the Gemini-only rules inside `shapeGeminiMessages`.
- Import direction: providers.ts is host-free pure data and must not import modelClient.ts. modelClient.ts may type-import `DialectId` from providers.ts; an import the other way would create a cycle through src/orchestrator/index.ts.
- Header precedence: if `extraHeaders` were spread after the base headers, a buggy or hostile provider could replace `authorization` or corrupt `content-length` and every request would fail opaquely. Spread extras first, base last, and pin it with a test.
- Dropping messages in the Gemini dialect (orphan tool messages, tool messages with no `tool_call_id`) changes what the model sees relative to the recorded transcript. It must only affect the wire payload — `shapeMessages` takes and returns values, never mutates its input, and the on-disk transcript is untouched.
- Reordering tool messages could scramble a transcript that legitimately interleaves several assistant tool_calls turns. Bucketing by `tool_call_id` and draining per call keeps each result attached to its own turn; the multi-call test (g) guards it.
- The OpenCode session-uuid Map grows one entry per distinct `sessionId` for the lifetime of the client. Acceptable (a handful of chat sessions per window) but worth the doc comment; do not key it on anything unbounded like the message array.
- `sessionId` is optional, so the tool loop and Auto-mode evaluator still send none — the OpenCode header will fall back to the per-factory uuid until a later todo threads the chat session id through. Note it rather than editing toolLoop.ts/autoMode.ts, which are outside this todo's file list.

## Acceptance

- src/orchestrator/providers.ts exports `DialectId` and `HeaderStyleId`, and every `PROVIDERS` entry carries `dialect` and `headerStyle`, with google = 'gemini' and opencode = 'opencode' respectively; providers.ts still imports nothing.
- `CompletionRequest` has an optional `sessionId`, and a request made with one produces a JSON body containing no `sessionId` key.
- `ModelClientConfig` accepts `dialect` and `extraHeaders`; with neither set, the serialised request body is identical to the pre-change payload (regression test on an assistant `tool_calls` turn with empty content).
- Headers returned by `extraHeaders` reach the server lowercased, and `authorization`, `content-type` and `content-length` cannot be overridden by them.
- `openCodeExtraHeaders({ version })` sends `user-agent: baiton/<version>` and an `x-opencode-session` uuid that is identical across two completions sharing a `sessionId` and different for a different `sessionId`.
- `shapeGeminiMessages` omits the `content` key on an assistant turn that has tool_calls and empty/whitespace content, emits tool messages with exactly `role`/`tool_call_id`/`content` directly after their assistant turn, drops orphan tool messages, and replaces any non-JSON-object `arguments` string with '{}'.
- `npx tsc --noEmit -p tsconfig.json` is clean and eslint on the three changed files reports nothing new.
- `npx mocha test/modelClient.test.ts` and `npx mocha test/providers.test.ts` are green, and `npm run test:unit` is green at no fewer than the 1170 passing tests on this branch.
