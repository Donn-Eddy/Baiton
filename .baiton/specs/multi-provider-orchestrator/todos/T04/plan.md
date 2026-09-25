# Plan T04

## Steps

1. Create src/orchestrator/copilotClient.ts with a type-only vscode import and an injected runtime API seam

   New file, header doc-comment in the style of modelClient.ts. Import VALUES only from './modelClient': `ChatMessage`, `CompletionRequest`, `CompletionResult`, `MissingConfigError`, `ModelClient`, `ModelProvider`, `ToolCall`, `ToolSpec`, `UnreachableEndpointError`. Import the host surface as TYPE ONLY: `import type * as vscode from 'vscode';` — this file must NOT emit a runtime `require('vscode')`, because src/orchestrator/index.ts re-exports it and host-free suites (test/askWatcher.routing.test.ts, test/chatController.autoMode.test.ts, test/chatController.interventions.test.ts) statically import that barrel before any loader hook is registered. Do not use `require()` either: @typescript-eslint/recommended (v8) errors on no-require-imports.

   Declare the runtime seam and config:

   ```ts
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
   export const COPILOT_JUSTIFICATION = 'Baiton runs the orchestrator chat and its tools through your Copilot subscription.';

   export interface CopilotClientConfig {
     /** The live `vscode` namespace (or a fake in tests); injected so this module stays host-import-free. */
     api: CopilotVscodeApi;
     /** Resolves the selected Copilot model id (the `id` or `family` of a `LanguageModelChat`). */
     getModel: ModelProvider;
     /** Consent justification; defaults to COPILOT_JUSTIFICATION. */
     justification?: string;
   }
   ```

   `api` is required: the T05 provider router lives under src/activation/ where `import * as vscode from 'vscode'` is already legal, so it passes `vscode` itself. Add that sentence as a comment so the next todo does not reintroduce a runtime import here.

   Files: `src/orchestrator/copilotClient.ts`

2. Implement the message and tool mapping helpers as exported pure functions

   All three take the injected `api` so tests can assert on them directly.

   1. `export function parseCopilotToolInput(args: string): object` — `JSON.parse` inside try/catch; return the parsed value only when it is a non-null, non-array object, otherwise `{}`. Never throws. (Deliberately named `parseCopilotToolInput`, not `parseToolInput`, so the barrel keeps unique export names.)

   2. `export function toCopilotTools(tools: readonly ToolSpec[], _api?: CopilotVscodeApi): vscode.LanguageModelChatTool[]` — map each spec to `{ name: t.name, description: t.description, inputSchema: t.parameters }`. Prefer a signature without the api argument (`toCopilotTools(tools)`) since no class construction is needed; `LanguageModelChatTool` is a plain interface. Keep `noUnusedParameters` in mind — do not add an argument you do not use.

   3. `export function toCopilotMessages(messages: readonly ChatMessage[], api: CopilotVscodeApi): vscode.LanguageModelChatMessage[]` — one forward pass, never mutating `messages`:
      - `system` and `user` → `api.LanguageModelChatMessage.User([new api.LanguageModelTextPart(m.content)])`. `vscode.lm` has no system role; document that the system prompt is prepended as a user turn.
      - `assistant` with a non-empty `tool_calls` array → `api.LanguageModelChatMessage.Assistant([...(m.content.trim() !== '' ? [new api.LanguageModelTextPart(m.content)] : []), ...m.tool_calls.map((c) => new api.LanguageModelToolCallPart(c.id, c.name, parseCopilotToolInput(c.arguments)))])`.
      - `assistant` without tool calls → `Assistant([new api.LanguageModelTextPart(m.content)])`.
      - `tool` → collapse each RUN of consecutive tool messages into ONE `User` message whose content is the run's `new api.LanguageModelToolResultPart(m.tool_call_id, [new api.LanguageModelTextPart(m.content)])` parts, in transcript order (a tool result may only ride on a User message, and a whole round's results belong together). A `tool` message with `tool_call_id === undefined` is skipped.
      - Skip any non-tool message whose `content.trim()` is empty and that carries no tool-call parts, so no zero-part message reaches the host.
      Implementation shape: iterate with an index, buffering `pendingToolParts: vscode.LanguageModelToolResultPart[]`; flush the buffer into a User message as soon as a non-tool message is reached and again after the loop.

   Files: `src/orchestrator/copilotClient.ts`

3. Implement model resolution and error mapping

   `export async function selectCopilotModel(api: CopilotVscodeApi, model: string): Promise<vscode.LanguageModelChat | undefined>` — `const models = await api.lm.selectChatModels({ vendor: COPILOT_VENDOR });` then return the first entry with `m.id === model`, else the first with `m.family === model`, else `undefined`. (Select by vendor only and match locally so a stale saved id cannot silently fall back to an arbitrary model, and so the test can assert the selector argument is exactly `{ vendor: 'copilot' }`.)

   `export function mapCopilotError(err: unknown): Error` — the single place `vscode.lm` failures become the classes chatController.ts already branches on (src/activation/chatController.ts:1026-1043):
     - `if (err instanceof MissingConfigError || err instanceof UnreachableEndpointError) return err;` (never re-wrap our own).
     - Read `code` defensively: `const code = typeof (err as { code?: unknown } | null)?.code === 'string' ? (err as { code: string }).code : undefined;` — do not use `instanceof api.LanguageModelError`, the fake's class is a different realm.
     - `code === 'NotFound'` → `new MissingConfigError('model')` (the saved model no longer exists → the controller shows "The orchestrator model is not configured." with the openSettings action).
     - `code === 'NoPermissions'` or `'Blocked'` → `new UnreachableEndpointError(\`Copilot request was refused (${code}): ${describe(err)}\`, { cause: err })` (consent declined / quota).
     - anything else → `new UnreachableEndpointError(\`Copilot request failed: ${describe(err)}\`, { cause: err })`.
     Add a local `function describe(err: unknown): string` returning `err instanceof Error ? err.message : String(err)`.

   Files: `src/orchestrator/copilotClient.ts`

4. Implement CopilotModelClient.complete: streaming, tool-call collection, abort

   ```ts
   export class CopilotModelClient implements ModelClient {
     private readonly config: CopilotClientConfig;
     constructor(config: CopilotClientConfig) { this.config = config; }
     public async complete(req: CompletionRequest): Promise<CompletionResult> { ... }
   }
   ```
   Body, in this order (mirroring OpenAiModelClient.complete so error ordering stays predictable):
   1. `const model = await this.config.getModel(); if (!model) throw new MissingConfigError('model');` — Copilot needs no key, so `MissingConfigError('apiKey')` is never raised here (document it).
   2. `if (req.signal.aborted) throw new UnreachableEndpointError('request was aborted before it started');` — before any `selectChatModels`/`sendRequest` call.
   3. `const chat = await selectCopilotModel(api, model); if (chat === undefined) throw new MissingConfigError('model');` — wrap the `selectChatModels` await in try/catch and rethrow `mapCopilotError(err)`.
   4. Cancellation: `const cts = new api.CancellationTokenSource();` then `const onAbort = () => cts.cancel(); req.signal.addEventListener('abort', onAbort);` inside a `try { ... } finally { req.signal.removeEventListener('abort', onAbort); cts.dispose(); }`.
   5. Options: `const tools = req.tools ?? []; const options: vscode.LanguageModelChatRequestOptions = { justification: this.config.justification ?? COPILOT_JUSTIFICATION, ...(tools.length > 0 ? { tools: toCopilotTools(tools) } : {}) };` — omit `tools` entirely when empty (the auto-mode evaluator sends none, and an empty array makes some models error). Leave `toolMode` unset (Auto).
   6. `const response = await chat.sendRequest(toCopilotMessages(req.messages, api), options, cts.token);` then `for await (const part of response.stream) { ... }`, both inside try/catch → `catch (err) { throw req.signal.aborted ? new UnreachableEndpointError('request was aborted') : mapCopilotError(err); }`.
   7. Part handling by DUCK TYPE, not `instanceof` (the stream may yield host proxies, and the test fake's classes live in another module realm — say so in a comment):
      - text part: `const value = (part as { value?: unknown }).value; if (typeof value === 'string')` → `content += value; sawText = true; if (value.length > 0) req.onDelta?.(value);`
      - tool-call part: `const callId = (part as { callId?: unknown }).callId; const name = (part as { name?: unknown }).name;` — when both are non-empty strings, push `{ id: callId, name, arguments: JSON.stringify((part as { input?: unknown }).input ?? {}) }` onto `toolCalls: ToolCall[]` in stream order. Guard the stringify with try/catch, falling back to `'{}'` for an uncloneable input.
      - anything else (data parts, future parts): ignore.
      Check the text shape first, then the tool-call shape, so a part carrying both cannot be double-counted.
   8. Return `{ content: sawText ? content : undefined, tool_calls: toolCalls }` — matching OpenAiModelClient, where `content` stays `undefined` when the model emitted no text at all.
   9. `req.sessionId` is unused (Copilot is in-process, no headers); note that in a comment so it is not mistaken for an omission.

   Files: `src/orchestrator/copilotClient.ts`

5. Export the new module from the orchestrator barrel

   In src/orchestrator/index.ts add `export * from './copilotClient';` directly after the existing `export * from './modelClient';` line. Export names (`CopilotModelClient`, `CopilotClientConfig`, `CopilotVscodeApi`, `COPILOT_VENDOR`, `COPILOT_JUSTIFICATION`, `toCopilotMessages`, `toCopilotTools`, `parseCopilotToolInput`, `selectCopilotModel`, `mapCopilotError`) collide with nothing currently exported. After the edit, confirm the barrel is still loadable with no VS Code host by running the suites that import it statically (step 8).

   Files: `src/orchestrator/index.ts`

6. Extend test/fixtures/vscodeFake.mjs with the language-model surface

   Follow the file's existing split: host interactions DELEGATE to `fake()` (so a test controls them per case), value classes are CONCRETE exports (like `Disposable`, `Uri`, `ViewColumn`). Append, with short doc comments:
   - `export const LanguageModelChatMessageRole = { User: 1, Assistant: 2 };`
   - `export class LanguageModelTextPart { constructor(value) { this.value = value; } }`
   - `export class LanguageModelToolCallPart { constructor(callId, name, input) { this.callId = callId; this.name = name; this.input = input; } }`
   - `export class LanguageModelToolResultPart { constructor(callId, content) { this.callId = callId; this.content = content; } }`
   - `export class LanguageModelChatMessage { constructor(role, content, name) { this.role = role; this.content = typeof content === 'string' ? [new LanguageModelTextPart(content)] : content; this.name = name; } static User(content, name) { return new LanguageModelChatMessage(LanguageModelChatMessageRole.User, content, name); } static Assistant(content, name) { return new LanguageModelChatMessage(LanguageModelChatMessageRole.Assistant, content, name); } }`
   - `export const LanguageModelChatToolMode = { Auto: 1, Required: 2 };`
   - `export class LanguageModelError extends Error { constructor(code, message) { super(message ?? code); this.name = 'LanguageModelError'; this.code = code; } static NotFound(m) { return new LanguageModelError('NotFound', m); } static NoPermissions(m) { return new LanguageModelError('NoPermissions', m); } static Blocked(m) { return new LanguageModelError('Blocked', m); } }`
   - `export class CancellationTokenSource { ... }` — a real working token: hold `#cancelled`/`listeners`; `token` exposes `isCancellationRequested` and `onCancellationRequested(cb)` returning `{ dispose() {} }` (invoke `cb` immediately when already cancelled); `cancel()` flips the flag and fires each listener once; `dispose()` sets a `disposed` flag and clears the listeners so a test can assert cleanup.
   - `export const lm = { selectChatModels: (selector) => fake().lm.selectChatModels(selector) };` — delegating, so each test supplies its own model list.
   Do not change any existing export in this file; several other suites depend on them.

   Files: `test/fixtures/vscodeFake.mjs`

7. Write test/copilotClient.test.ts

   Header comment in the repo's style explaining that `CopilotModelClient` takes its `vscode` surface injected, so the suite hands it the shared fake module loaded through `fixtures/vscodeLoader.mjs` (registered in `before()` exactly as test/setApiKey.test.ts:133-152 does: build `loaderUrl` from `process.cwd()`, `register(loaderUrl, pathToFileURL(join(root, '/')).href)`, then `await import('./fixtures/vscodeLoader.mjs')`). Then `const api = (await import('./fixtures/vscodeFake.mjs')) as unknown as CopilotVscodeApi;` and keep it in a suite-level variable. `CopilotModelClient` and the helpers are imported statically from '../src/orchestrator/copilotClient' (safe: that module has no runtime vscode import).

   Per-test scaffolding:
   - `beforeEach` installs `globalThis.__vscodeFake = { lm: { selectChatModels: (selector) => { selectorCalls.push(selector); return Promise.resolve(models); } } }` with mutable `models`/`selectorCalls`.
   - A `FakeChatModel` class implementing `{ id, family, vendor: 'copilot', name, version, maxInputTokens, countTokens, sendRequest }`: `sendRequest` records `{ messages, options, token }`, then returns `{ stream: asyncIterableOf(this.parts), text: ... }`. Give it knobs: `rejectWith?: unknown` (sendRequest rejects), `throwMidStream?: unknown` (the async generator yields the first part then throws), and `onIterate?: () => void` (used to trigger an abort between parts).
   - A `never`-aborting `AbortController` per test; helper `req(overrides)` building a `CompletionRequest`.

   Cases (one `describe` per area, each asserting on the recorded `sendRequest` call):
   1. Message mapping (via `toCopilotMessages` directly AND once end-to-end): system→User text part; user→User; plain assistant→Assistant; assistant with `tool_calls` and empty content → Assistant whose only parts are ToolCallParts with `input` parsed from the argument string; assistant with text + calls → text part first; a run of two consecutive `tool` messages → ONE User message with two ToolResultParts in order; a `tool` message with no `tool_call_id` dropped; an empty-content user message dropped; the input `ChatMessage[]` is not mutated (deep-equal against a clone).
   2. `parseCopilotToolInput`: valid object string kept; `'[]'`, `'"x"'`, `'null'`, `''` and malformed JSON all → `{}`.
   3. Tool mapping: `toCopilotTools` → `{ name, description, inputSchema }`; end-to-end `options.tools` matches; `options.tools` is ABSENT when `req.tools` is undefined or `[]`; `options.justification` is non-empty and overridable through config.
   4. Streaming text: three text parts → `onDelta` called with each non-empty value in order, result `content` is their concatenation; a stream with no text part → `content === undefined`, `tool_calls: []`.
   5. Tool-call collection: two ToolCallParts → `tool_calls` in stream order with `arguments` JSON strings (`'{}'` when `input` is `{}`/missing); a part that is neither text nor tool call is ignored.
   6. Model resolution: `selectChatModels` called once with exactly `{ vendor: 'copilot' }`; match by `id`; match by `family` when no `id` matches; empty list → rejects `MissingConfigError` with `.missing === 'model'` and `sendRequest` never called; `getModel` resolving `undefined` → `MissingConfigError('model')` with `selectChatModels` never called.
   7. Abort: an already-aborted signal → rejects `UnreachableEndpointError`, `selectChatModels`/`sendRequest` never called; aborting mid-stream (from `onIterate`) → the recorded token reports `isCancellationRequested === true` and the call rejects `UnreachableEndpointError`; on both the success and failure paths the token source ends up `disposed` (assert via the fake's flag).
   8. Error mapping: `sendRequest` rejecting with `api.LanguageModelError.NotFound()` → `MissingConfigError('model')`; `NoPermissions()` and `Blocked()` → `UnreachableEndpointError`; a plain `Error` → `UnreachableEndpointError` carrying it as `cause`; a mid-stream throw → `UnreachableEndpointError`.
   9. `sessionId` on the request changes nothing and is never forwarded into `options`.

   Files: `test/copilotClient.test.ts`

8. Verify

   Run, from the repo root, and report the output: `npx tsc --noEmit -p tsconfig.json` (clean); `npx eslint src/orchestrator/copilotClient.ts src/orchestrator/index.ts test/copilotClient.test.ts --ext .ts` (clean — the pre-existing no-unused-vars warning in src/orchestrator/webviewProtocol.ts is out of scope and must stay untouched); `npx mocha test/copilotClient.test.ts` (green); `npx mocha test/askWatcher.routing.test.ts test/chatController.autoMode.test.ts test/chatController.interventions.test.ts test/setApiKey.test.ts test/configPanel.controller.test.ts` (green — proves the new barrel export did not make src/orchestrator require a VS Code host and that the vscodeFake additions broke no existing consumer); `npm run test:unit` (must be >= the T02 baseline of 1189 passing / 1 pending, with no failures).

   Files: (none)

## Risks

- Barrel contamination: if copilotClient.ts ends up with a runtime `import * as vscode from 'vscode'` (or a `require`), `export * from './copilotClient'` in src/orchestrator/index.ts makes the whole orchestrator barrel unloadable outside a VS Code host, breaking test/askWatcher.routing.test.ts and both chatController suites, which import the barrel statically before any loader hook is registered. The type-only import plus the required injected `api` is the mitigation; step 8's targeted mocha run is the check.
- `instanceof` across realms: the test fake's LanguageModelTextPart/ToolCallPart are a different class identity from `vscode`'s, and the real host may hand back proxies. Classifying stream parts by `instanceof` would pass in one environment and silently drop every part in the other — hence duck-typing on `value` / `callId`+`name`.
- vscode.lm has no system role and no OpenAI-style `tool` role, so the mapping is lossy by construction: the system prompt becomes a leading user turn and tool results ride on User messages. If Copilot behaves oddly on multi-round tool chains, this mapping is the first place to look; the transcript on disk is unaffected either way.
- Sending `tools: []` makes some Copilot models reject the request, so the option must be omitted rather than sent empty — this is exactly the auto-mode evaluator's path (it passes no tools).
- `chat.sendRequest` must be triggered by a user action or the consent dialog can fail; a declined or quota-blocked request arrives as LanguageModelError NoPermissions/Blocked and maps to UnreachableEndpointError, which the controller renders with an `openSettings` fix action that cannot actually fix Copilot consent. Acceptable for this todo (the error classes are fixed by the interface) but worth noting for the T06/T07 UI work.
- A saved Copilot model id can go stale (models change over time); resolution must fail as MissingConfigError('model') rather than silently substituting another model, otherwise the user gets answers from a model they did not pick.
- `tsconfig` sets noUnusedLocals/noUnusedParameters and `strict`; an unused `api` parameter on `toCopilotTools` or an unused `sessionId` destructure will fail the build rather than warn.
- Missing `cts.dispose()` on an early throw leaks a CancellationTokenSource per completion in a long chat session; the dispose belongs in a `finally`, and the test asserts it on both paths.

## Acceptance

- src/orchestrator/copilotClient.ts exists, exports `CopilotModelClient implements ModelClient` plus `CopilotClientConfig`, `CopilotVscodeApi`, `toCopilotMessages`, `toCopilotTools`, `parseCopilotToolInput`, `selectCopilotModel`, `mapCopilotError`, `COPILOT_VENDOR`, `COPILOT_JUSTIFICATION`, and contains no runtime `vscode` import and no `require(`.
- `complete()` returns `{ content, tool_calls }` with `content === undefined` when the stream emitted no text part, streams every non-empty text part to `req.onDelta` in order, and collects tool-call parts as `ToolCall { id: callId, name, arguments: <JSON string> }` in stream order.
- ChatMessage mapping: system/user → User messages, assistant → Assistant messages (text part omitted when content is blank, tool calls as LanguageModelToolCallPart with parsed object input), each run of consecutive tool messages → a single User message of LanguageModelToolResultParts; `req.messages` is never mutated.
- ToolSpecs reach `sendRequest` as `{ name, description, inputSchema }`, and `options.tools` is absent entirely when the request carries no tools.
- Abort works both ways: a pre-aborted signal rejects with UnreachableEndpointError before any host call, and an abort mid-stream cancels the CancellationTokenSource (token reports cancellation) and rejects with UnreachableEndpointError; the token source is disposed on every path.
- Error mapping: LanguageModelError code `NotFound` and an unresolvable/absent model → MissingConfigError with `.missing === 'model'`; `NoPermissions`/`Blocked`/any other failure → UnreachableEndpointError carrying the original as `cause`; MissingConfigError/UnreachableEndpointError thrown internally are never re-wrapped.
- src/orchestrator/index.ts re-exports './copilotClient', and test/askWatcher.routing.test.ts, test/chatController.autoMode.test.ts and test/chatController.interventions.test.ts still pass with no VS Code host.
- test/fixtures/vscodeFake.mjs additionally exports lm (delegating to `globalThis.__vscodeFake`), LanguageModelChatMessage(+Role), LanguageModelTextPart, LanguageModelToolCallPart, LanguageModelToolResultPart, LanguageModelChatToolMode, LanguageModelError (with NotFound/NoPermissions/Blocked) and a working CancellationTokenSource, with every pre-existing export unchanged.
- test/copilotClient.test.ts loads the fake through fixtures/vscodeLoader.mjs and covers message mapping, tool mapping, streaming text, tool-call collection, model resolution, abort and error mapping; `npx mocha test/copilotClient.test.ts` is green.
- `npx tsc --noEmit -p tsconfig.json` is clean, `npx eslint` on the three changed .ts files is clean, and `npm run test:unit` has no failures with at least the T02 baseline of 1189 passing / 1 pending.
