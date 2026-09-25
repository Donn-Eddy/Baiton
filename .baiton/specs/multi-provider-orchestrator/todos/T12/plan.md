# Plan T12

## Steps

1. Re-read the exact T02 surface before judging it

   T02 is commit 2e1582f (`spec(multi-provider-orchestrator): T02 execute attempt 1`). It changed exactly four files: `src/orchestrator/modelClient.ts` (+213), `src/orchestrator/providers.ts` (+22), `test/modelClient.test.ts` (+322) and its own run note. Read the diff read-only with `git show 2e1582f -- src/orchestrator/modelClient.ts src/orchestrator/providers.ts test/modelClient.test.ts`, then read the current files whole, since T01 (ca1f007) created providers.ts underneath it. The reviewable claim is OVERVIEW item 2: OpenAiModelClient gains two injected hooks (`extraHeaders(req)` and a wire `dialect`), plus an optional `CompletionRequest.sessionId` that the tool loop and ChatController thread through. Do not re-review T01's catalog (ids, labels, base URLs, model lists, `normalizeModelSelection`) except where T02 touched it — T02 added only `dialect: DialectId` and `headerStyle: HeaderStyleId` to `ProviderInfo` and filled those two fields on all five entries.

   Files: `src/orchestrator/modelClient.ts`, `src/orchestrator/providers.ts`, `test/modelClient.test.ts`

2. Check the injected-hook seam against the interface it must preserve

   Confirm each of these in `src/orchestrator/modelClient.ts`, and note pass/fail per line: (a) `ModelClientConfig` gained optional `dialect?: WireDialect` and `extraHeaders?: ExtraHeadersProvider`, both optional so every existing `new OpenAiModelClient({...})` call site still compiles and behaves identically; (b) `complete()` resolves `const dialect = this.config.dialect ?? openAiDialect` and serialises `messages: dialect.shapeMessages(req.messages)` — and `shapeOpenAiMessages` reproduces the pre-T02 mapping byte for byte (`role`, always-present `content`, conditional `tool_call_id`, conditional non-empty `tool_calls` via `toWireToolCall`); (c) `postCompletion(url, apiKey, body, signal, onChunk?, extra = {})` spreads `...lowercaseKeys(extra)` FIRST and the base headers (`content-type`, `authorization`, `content-length`) after, so a provider's extras cannot clobber auth or framing; (d) `dialectFor(id: DialectId)` maps `'gemini'`→`geminiDialect` and everything else→`openAiDialect`, and providers.ts still imports nothing from modelClient (the dependency runs one way: modelClient imports `type { DialectId }` from providers). Fail the gate on any host (`vscode`) import appearing in either file.

   Files: `src/orchestrator/modelClient.ts`, `src/orchestrator/providers.ts`

3. Check the Gemini dialect against the three rejections it claims to fix

   `shapeGeminiMessages` must satisfy, and `test/modelClient.test.ts` must cover: (1) an assistant turn carrying a non-empty `tool_calls` array omits the `content` key entirely when `content.trim() === ''` (key absent, not `''` and not `null`), and preserves non-empty content untrimmed; (2) every emitted `tool` message carries exactly `role`, `tool_call_id`, `content` and no stray keys, and is emitted directly after the assistant turn whose `tool_calls` contains its id — verify by asserting `Object.keys(...)` on the wire message, not just the values; (3) `sanitizeToolArguments` returns the original string only when it parses to a non-null non-array object and `'{}'` otherwise, never throwing, and `toGeminiWireToolCall` routes every argument string through it. Also confirm the documented drops are deliberate and tested: orphan `tool` messages (no matching assistant call id) are dropped, and a `tool` message with `tool_call_id === undefined` is dropped silently by the `if (m.role === 'tool') continue` branch. Add one regression test if absent: a two-round chain (user → assistant tool_calls → tool → assistant tool_calls → tool → assistant text) shapes into the exact alternating order with no empty `content` on either tool-call turn — this is the multi-step chaining acceptance criterion and the single most important thing the gate is protecting.

   Files: `src/orchestrator/modelClient.ts`, `test/modelClient.test.ts`

4. Fix the blocking gap: CompletionRequest.sessionId is declared but never threaded

   CONFIRMED DEFECT — this is the finding that fails the re-review as-is. T02 added `sessionId?: string` to `CompletionRequest` and built `openCodeExtraHeaders` to key its uuid map on `req.sessionId ?? ''`, but no caller ever sets it: `src/orchestrator/toolLoop.ts:90` builds `deps.client.complete({ messages, tools, signal, ...onDelta })` with no `sessionId`, and `src/activation/chatController.ts:700` calls `runToolLoop(history, { client, tools, call, systemPrompt, append, roundBound, signal, onDelta })` with no session id either — although the id is already in scope there as the local `sessionId` computed at chatController.ts:680. Net effect: every OpenCode request falls into the `''` bucket and shares one process-wide uuid across all chat sessions, which is exactly what the OVERVIEW says must not happen. Fix it minimally and in the same shape as `onDelta`: (1) in `src/orchestrator/toolLoop.ts`, add `sessionId?: string;` to `ToolLoopDeps` (doc it as 'the chat session id, forwarded to every completion so provider headers stay stable for a conversation') and spread `...(deps.sessionId !== undefined ? { sessionId: deps.sessionId } : {})` into the `complete()` argument object; (2) in `src/activation/chatController.ts`, pass `sessionId,` in the `runToolLoop` deps object. Leave `evaluateAsk` in `src/orchestrator/autoMode.ts:1058` alone — the Auto-mode gate is a one-shot tool-free evaluation with no conversation to key on, and `EvaluateOptions` carries no session id; record that as a deliberate scope call rather than an omission.

   Files: `src/orchestrator/toolLoop.ts`, `src/activation/chatController.ts`

5. Cover the threading with tests at both seams

   In `test/toolLoop.test.ts`, add a case using the existing fake/recording `ModelClient` in that file: with `sessionId: 's-1'` in the deps, every recorded `CompletionRequest` across a multi-round run carries `sessionId === 's-1'`; with the dep omitted, the `sessionId` key is absent from the request object (assert with `'sessionId' in req === false`, so the optional-spread shape is pinned and the pre-T02 call shape is preserved). In `test/chatController.*.test.ts` (the existing suites already drive `ChatController` through a fake client), assert the client saw the same session id the controller wrote the transcript under, and that it stays stable across two sends in one session and differs after switching sessions. Keep `test/modelClient.test.ts`'s existing `openCodeExtraHeaders` cases (`reuses one uuid across completions with the same sessionId`, `mints different uuids for different sessionIds`, `shares one stable uuid across completions with no sessionId`) as they are — they already pin the client side of the contract.

   Files: `test/toolLoop.test.ts`, `test/chatController.autoMode.test.ts`, `test/chatController.interventions.test.ts`, `test/modelClient.test.ts`

6. Decide the duplicate-drain question in shapeGeminiMessages

   In `shapeGeminiMessages` the `buckets` map is read with `buckets.get(call.id) ?? []` but never consumed, so if the same `tool_call_id` appears in two assistant turns (a retried or repeated id in a recorded transcript) the same tool results are emitted after both turns — the duplicate is exactly the kind of shape Gemini rejects. Either confirm by construction that ids are unique per transcript and record that reasoning, or make the drain destructive: after the inner loop over `buckets.get(call.id)`, call `buckets.delete(call.id)`, and add a test with two assistant turns sharing one call id asserting the results are emitted once, after the first turn. Prefer the destructive drain — it is a two-line change and removes the reasoning dependency on id uniqueness.

   Files: `src/orchestrator/modelClient.ts`, `test/modelClient.test.ts`

7. Check the catalog fields T02 added are actually consumable

   `ProviderInfo` now carries `dialect: DialectId` and `headerStyle: HeaderStyleId`, with `google` → `'gemini'`, `opencode` → `'opencode'` header style, and `copilot`/`mistral`/`openai` → `'openai'`/`'default'`. `dialectFor(id)` gives the host glue a catalog-driven mapper for the dialect, but there is no counterpart for `headerStyle` — the glue would have to branch on the literal `'opencode'` by hand and supply `openCodeExtraHeaders({ version })` itself. That is acceptable only because the header provider needs a runtime argument (the extension version) that a host-free module cannot supply. Record the decision explicitly; if the gate wants parity, add `export function extraHeadersFor(style: HeaderStyleId, options: OpenCodeHeaderOptions): ExtraHeadersProvider | undefined` in `src/orchestrator/modelClient.ts` returning `openCodeExtraHeaders(options)` for `'opencode'` and `undefined` for `'default'`, with a test pinning both branches. Also verify `test/providers.test.ts` asserts the two new fields (it currently does not) — add cases pinning `PROVIDERS.google.dialect === 'gemini'`, `PROVIDERS.opencode.headerStyle === 'opencode'`, and that every other entry is `'openai'`/`'default'`.

   Files: `src/orchestrator/modelClient.ts`, `src/orchestrator/providers.ts`, `test/providers.test.ts`

8. Correct the stale base-URL comment in providers.ts

   The catalog header comment says base URLs are 'the prefix `completionsUrl()` appends `/chat/completions` to, so the Google base keeps its trailing slash'. `completionsUrl` (src/orchestrator/modelClient.ts:237) starts with `normalizeBase`, which strips every trailing slash, so the trailing slash on the Google base is irrelevant, not load-bearing. Verify the three catalog bases resolve correctly — `https://generativelanguage.googleapis.com/v1beta/openai/` → `.../v1beta/openai/chat/completions`, `https://api.mistral.ai/v1` → `.../v1/chat/completions`, `https://opencode.ai/zen/v1` → `.../zen/v1/chat/completions` (all non-empty paths, so the `/v1` auto-insert branch does not fire) — then reword the comment to say the trailing slash is harmless rather than required. Optionally pin the three resolutions in `test/providers.test.ts` or the `completionsUrl` describe block in `test/modelClient.test.ts`.

   Files: `src/orchestrator/providers.ts`, `test/modelClient.test.ts`, `test/providers.test.ts`

9. Run the checks and record the verdict

   Run `npm run compile` (tsc -p ./), `npm run lint` (eslint src test --ext .ts) and `npm test` (mocha over `test/**/*.test.ts` via ts-node). All three must be clean. Spot-check that the untouched suites still pass — `test/toolLoop.test.ts`, `test/toolLoop.termination.property.test.ts`, `test/autoMode.evaluator.test.ts`, `test/chatController.*` — since step 4 edits the tool loop's dep object and step 6 may change wire shaping. Then state the gate verdict in the run's execution note: PASS with the sessionId threading fix applied (and the duplicate-drain / comment corrections), or FAIL naming precisely which check failed. T03 is unblocked only once `sessionId` actually reaches `extraHeaders`, because the OpenCode session header and any later per-conversation provider state depend on that thread being live.

   Files: `src/orchestrator/modelClient.ts`, `src/orchestrator/toolLoop.ts`, `src/activation/chatController.ts`, `test/toolLoop.test.ts`, `test/modelClient.test.ts`

## Risks

- Scope creep: this is a review gate, not a re-implementation. The only source edits it authorises are the ones needed to make T02 meet its own stated contract — threading `sessionId`, the optional destructive bucket drain, the stale comment, and test additions. Copilot client, ProviderRouter, protocol and webview work belong to later todos and must not be started here.
- Adding `sessionId` to the `complete()` argument object unconditionally (rather than via optional spread) would change the object shape every existing modelClient test compares against, and could break strict `deepStrictEqual` assertions on recorded requests. Use the same conditional-spread idiom already used for `onDelta`.
- `ChatController` computes its `sessionId` at chatController.ts:680 but a fresh chat allocates the id on first send; passing it into `runToolLoop` must use that already-resolved local, not re-read `activeSessions`, or the first message of a new chat would key on a different value than later messages.
- Making the Gemini bucket drain destructive changes behaviour for transcripts with repeated tool_call ids. If any existing test relies on the current non-destructive read, it must be updated deliberately, with the reason recorded, rather than silently.
- The OpenCode base URL (`https://opencode.ai/zen/v1`) and model ids in the catalog were inherited from T01 and are not verifiable from the repo; they are out of scope for this gate. If they are wrong, that is a T01 correction, and the catalog comment already marks it a one-line edit.
- `openCodeExtraHeaders` keeps an unbounded-in-principle `Map` keyed by session id for the lifetime of the factory. It is bounded in practice by chat sessions per window, but note it so a later todo that constructs the factory per-window rather than per-request does not turn it into a leak.

## Acceptance

- `npm run compile`, `npm run lint` and `npm test` all pass from a clean tree.
- `ModelClientConfig.dialect` and `ModelClientConfig.extraHeaders` are both optional and, when omitted, the request body and headers are byte-for-byte what the pre-T02 client sent — pinned by an existing or added test.
- Provider extras cannot override `authorization`, `content-type` or `content-length`, and extra header names are lowercased — pinned by tests in the `extraHeaders` describe block.
- A `CompletionRequest` built by `runToolLoop` carries `sessionId` when `ToolLoopDeps.sessionId` is supplied and omits the key entirely when it is not, asserted in `test/toolLoop.test.ts`.
- `ChatController` passes its active session id into `runToolLoop`, so two sends in one chat session reach the client with the same `sessionId` and a different session yields a different one, asserted in a chatController test.
- `openCodeExtraHeaders` mints one uuid per distinct session id and reuses it across completions — already covered; still green after the threading change.
- `shapeGeminiMessages` omits the `content` key on an assistant tool-call turn with empty or whitespace content, emits each `tool` message with exactly the keys `role`, `tool_call_id`, `content` immediately after its requesting assistant turn, drops orphan tool messages, and routes every `arguments` string through `sanitizeToolArguments`.
- A two-round Gemini tool chain (assistant tool_calls → tool → assistant tool_calls → tool → assistant text) shapes into the correct alternating wire order with no empty `content` on either tool-call turn.
- `dialectFor('gemini')` returns `geminiDialect` and `dialectFor('openai')` returns `openAiDialect`; `src/orchestrator/providers.ts` and `src/orchestrator/modelClient.ts` contain no `vscode` import.
- The new `dialect` and `headerStyle` catalog fields are asserted in `test/providers.test.ts` for all five providers.
- The gate verdict (PASS or FAIL, with the findings and the fixes applied) is written into the run's execution note, and T03 is declared unblocked only if `sessionId` demonstrably reaches `extraHeaders`.
