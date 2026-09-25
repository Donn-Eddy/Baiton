# Plan T03

## Steps

1. Start by auditing: most of this todo is already present in HEAD — verify, do not duplicate

   Before editing anything, read the four target files. As of the current commit (b5bb4a8, clean tree) every element of this todo already exists and the full unit suite is green (npx tsc --noEmit clean; npx mocha over the suite: 1274 passing / 1 pending; eslint clean on all four files). Concretely already in place: (1) src/orchestrator/toolLoop.ts declares `sessionId?: string` on `ToolLoopDeps` (with the doc comment "The chat session id, forwarded to every completion so provider headers stay stable for a conversation.") and spreads it onto every `deps.client.complete({...})` call via `...(deps.sessionId !== undefined ? { sessionId: deps.sessionId } : {})`, so the key is omitted entirely when the dep is absent; (2) src/activation/chatController.ts `onSend` passes `sessionId` (the same local `const sessionId = this.activeSessions.get(scopeId(scope)) ?? this.newSessionId(scope)` used for `transcriptFor(scope, sessionId)` and `this.runningKey`) as the last member of the `runToolLoop(history, { ... })` deps object; (3) test/toolLoop.test.ts `makeDeps` forwards `overrides.sessionId` with the same conditional-spread idiom and has the two cases 'threads sessionId onto every completion when the dep is supplied' and 'omits the sessionId key from the request when the dep is not supplied'; (4) test/chatController.interventions.test.ts's fake client records `public readonly sessionIds: Array<string | undefined>` from `req.sessionId` and has the case 'sends the same sessionId the transcript is written under, stable within a session and distinct after newChat'. Run the audit for each item; only implement the ones that are genuinely missing (see the following steps for their exact shape). Do not re-add anything that is already there, and do not reformat surrounding code.

   Files: `src/orchestrator/toolLoop.ts`, `src/activation/chatController.ts`, `test/toolLoop.test.ts`, `test/chatController.interventions.test.ts`

2. toolLoop.ts — optional sessionId on ToolLoopDeps, forwarded to every completion

   If missing: add to `export interface ToolLoopDeps` (after `onDelta?: DeltaListener`) the field `/** The chat session id, forwarded to every completion so provider headers stay stable for a conversation. */ sessionId?: string;`. In the single `deps.client.complete({ messages, tools: deps.tools, signal: deps.signal, ... })` call inside the `for (let round = 0; ...)` body, append `...(deps.sessionId !== undefined ? { sessionId: deps.sessionId } : {})` after the existing `onDelta` conditional spread. The conditional spread is required, not cosmetic: `CompletionRequest.sessionId` is optional and a test asserts `'sessionId' in req === false` when the dep is unset (exactOptionalPropertyTypes-style discipline used throughout this file). Change nothing else — the loop must not read, mint, default, or persist a session id, and `sessionId` must never reach `deps.append` or a `TranscriptRecord`; transcripts on disk stay byte-identical. The file must remain host-free (no `vscode` import, no `crypto` import added).

   Files: `src/orchestrator/toolLoop.ts`

3. chatController.ts — pass the session id the transcript is keyed under into runToolLoop

   In `private async onSend(text: string)`, the local `sessionId` is already computed before the transcript is opened (`const sessionId = this.activeSessions.get(scopeId(scope)) ?? this.newSessionId(scope);` followed by `await this.setActiveSession(scope, sessionId); const transcript = this.transcriptFor(scope, sessionId);`). If missing, add `sessionId,` as a member of the deps object literal passed to `runToolLoop(history, { client: ..., tools: ..., call: ..., systemPrompt: ..., append: ..., roundBound: ..., signal: this.abort.signal, onDelta: ..., sessionId })`. Reuse that exact local — do not mint a second id, do not read `activeSessions` again, and do not move the allocation: the invariant the tests pin is that the id handed to the model client is the same one the transcript filename is derived from (`transcriptFor`) and the same one `this.runningKey` embeds. No other call site needs changing: `runToolLoop` is invoked exactly once in the codebase (chatController.ts:700), and `this.deps.client.complete` is never called directly from the controller. Leave `evaluateAsk` in src/orchestrator/autoMode.ts alone — it already carries a comment explaining that no session id is threaded there deliberately (one-shot, tool-free evaluation, `EvaluateOptions` carries no session id); that file is out of scope for this todo.

   Files: `src/activation/chatController.ts`

4. test/toolLoop.test.ts — cover threading and omission

   If missing: extend the `makeDeps` helper's overrides object with `...(overrides.sessionId !== undefined ? { sessionId: overrides.sessionId } : {})` so a test can opt in, and add two `it` cases inside the `describe('runToolLoop', ...)` block, using the existing `ScriptedClient` (which records each `CompletionRequest` in `requests`) plus the existing `toolCallCompletion` / `finalCompletion` helpers: (a) 'threads sessionId onto every completion when the dep is supplied' — script a tool-call completion followed by a final completion, build deps with `{ client, sessionId: 's-1' }`, run the loop, then assert every entry of `client.requests` has `req.sessionId === 's-1'` and that `client.requests.length === 2` (so the assertion is not vacuous across a multi-round loop); (b) 'omits the sessionId key from the request when the dep is not supplied' — a single final completion, deps without `sessionId`, then `assert.strictEqual('sessionId' in req, false)` on the one recorded request. Make sure `ScriptedClient.complete` stores the whole request object (not a projection) so `in` checks are meaningful.

   Files: `test/toolLoop.test.ts`

5. test/chatController.interventions.test.ts — end-to-end: stable per-conversation id, new id after newChat

   If missing: on the suite's fake model client add `public readonly sessionIds: Array<string | undefined> = [];` and push `req.sessionId` in `complete` (widen its request parameter type to `{ messages: { role: string; content: string }[]; sessionId?: string }`). Then add one `it` — 'sends the same sessionId the transcript is written under, stable within a session and distinct after newChat' — driving the existing harness: start a send, wait for the intervention card, answer it `{ kind: 'approved' }`, await the run end at 2 completions; capture `const first = client.sessionIds[0]`, assert it is defined and that `sessionIds[1] === first`; assert `path.basename(transcriptFile()).includes(first)` so the id is provably the transcript's key; fire a second `sendText` in the same session and assert `sessionIds[2] === first`; then post `{ type: 'newChat' }`, wait until `webview.last('setActiveSession')?.sessionId` differs from `first`, send again and assert the newest recorded id is defined and `!== first`. Use the suite's existing `waitFor` / `awaitRunEnd(n)` helpers and the fire-and-forget `void webview.send(...).catch(() => {})` idiom for sends whose promise only settles when the whole loop ends.

   Files: `test/chatController.interventions.test.ts`

6. Verify

   Run, from the repo root: `npx tsc --noEmit -p tsconfig.json` (must be clean); `npx eslint src/orchestrator/toolLoop.ts src/activation/chatController.ts test/toolLoop.test.ts test/chatController.interventions.test.ts --ext .ts` (must be clean — the pre-existing no-unused-vars warning in src/orchestrator/webviewProtocol.ts is unrelated and stays untouched); `npx mocha test/toolLoop.test.ts`; `npx mocha test/chatController.interventions.test.ts`; `npx mocha test/toolLoop.termination.property.test.ts` (the property suite builds `ToolLoopDeps` without a session id and must keep compiling and passing, which is the guard that the new field is genuinely optional); and `npm run test:unit` for the whole suite. Current green baseline on this branch: 1274 passing, 1 pending. If the audit in step 1 found everything already in place, the todo is done once these commands are green — report that rather than manufacturing a diff.

   Files: (none)

## Risks

- The work appears to have already landed on this branch (toolLoop.ts was last touched by commit 48131b3, 'T12 execute attempt 1'), so the main risk is an executor duplicating the field, the spread, or the test cases. Audit first; a no-op diff with green checks is the correct outcome if nothing is missing.
- Making `sessionId` non-optional on `ToolLoopDeps` would break every other construction site (notably test/toolLoop.termination.property.test.ts) and violate the 'omits the key when unset' test. Keep it optional and keep the conditional spread.
- Spreading `sessionId: undefined` unconditionally would put the key on the wire object and fail the `'sessionId' in req === false` assertion, and could leak a `sessionId: null` into a provider body if a future dialect serialises unknown keys.
- Minting a fresh id inside the loop or re-reading `activeSessions` inside the `runToolLoop` deps literal would break the invariant that the id matches the transcript filename and would give a different id per round, defeating OpenCode's stable `x-opencode-session`.
- `sessionId` must not reach `deps.append`/`TranscriptRecord`; if it did, persisted transcripts would change shape and the transcript round-trip tests (and on-disk history compatibility) would break.
- src/orchestrator/toolLoop.ts must stay host-free (no `vscode` import) or its unit tests stop loading; the session id is injected by the host, never derived in the core.
- Out of scope and deliberately unthreaded: `evaluateAsk` in src/orchestrator/autoMode.ts. Adding a session id there is not part of this todo and would contradict the comment already in that file.

## Acceptance

- `ToolLoopDeps` in src/orchestrator/toolLoop.ts declares an optional `sessionId?: string` with a doc comment, and toolLoop.ts carries no `vscode` import.
- Every completion issued by `runToolLoop` carries `sessionId` when the dep is supplied — verified across a multi-round (tool call then final) loop, not just the first round.
- When the dep is not supplied, the `sessionId` key is absent from the request object (`'sessionId' in req === false`), so callers that thread nothing are byte-identical to before.
- `ChatController.onSend` passes the same `sessionId` it used for `transcriptFor(scope, sessionId)` and `this.runningKey` into `runToolLoop`; no second id is minted.
- End-to-end through the controller harness: the id is stable across rounds and across multiple sends within one chat session, matches the transcript filename, and changes after `newChat`.
- No transcript shape change: `sessionId` never appears in an appended `TranscriptRecord` and existing transcripts still load and render.
- `npx tsc --noEmit -p tsconfig.json` clean; eslint clean on the four touched files; `npx mocha test/toolLoop.test.ts`, `npx mocha test/chatController.interventions.test.ts` and `npx mocha test/toolLoop.termination.property.test.ts` pass; `npm run test:unit` at or above the 1274 passing / 1 pending baseline.
