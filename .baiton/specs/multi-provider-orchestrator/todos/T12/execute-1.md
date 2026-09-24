# Execute T12

## Summary

T12 gate re-review of T02: PASS with fixes applied. Confirmed the injected-hook seam (optional dialect/extraHeaders, base-header precedence, dialectFor, no vscode imports) and the Gemini dialect against its three rejections. Fixed the confirmed defect: CompletionRequest.sessionId is now threaded from ChatController through ToolLoopDeps (optional spread, same idiom as onDelta) into every complete() call, so openCodeExtraHeaders keys per chat session instead of one process-wide uuid. Made the Gemini bucket drain destructive (repeated tool_call_ids are consumed after their first requester) with a regression test. Added the missing two-round Gemini tool-chain test, sessionId threading tests at both seams (toolLoop and ChatController incl. newChat), catalog dialect/headerStyle assertions plus completionsUrl resolution pins in providers.test.ts, and corrected the stale trailing-slash comment in providers.ts. evaluateAsk threading a session id is a recorded deliberate scope call; no extraHeadersFor mapper (recorded decision: needs the runtime version arg). npm run compile clean; npm run lint 0 errors (one pre-existing webviewProtocol warning, verified on a clean tree); npm test 1274 passing / 1 pending / 0 failing.

## Files changed

- `src/orchestrator/toolLoop.ts`
- `src/activation/chatController.ts`
- `src/orchestrator/modelClient.ts`
- `src/orchestrator/providers.ts`
- `src/orchestrator/autoMode.ts`
- `test/toolLoop.test.ts`
- `test/chatController.autoMode.test.ts`
- `test/chatController.interventions.test.ts`
- `test/modelClient.test.ts`
- `test/providers.test.ts`
- `.baiton/specs/multi-provider-orchestrator/todos/T12/execute-1.md`

## Commands run

- `git show 2e1582f -- src/orchestrator/modelClient.ts src/orchestrator/providers.ts test/modelClient.test.ts`
- `npm run compile`
- `npm run lint (also re-run on a stashed clean tree to confirm the single warning is pre-existing)`
- `npm test`
- `npx mocha --require ts-node/register test/modelClient.test.ts (targeted reruns during test development)`

## Notes

- Gate verdict: PASS — T03 unblocked; sessionId now demonstrably reaches extraHeaders through the tool loop and ChatController.
- Confurning defect fixed minimally: optional-spread sessionId in ToolLoopDeps uses the same idiom as onDelta so strict deepStrictEqual request-shape assertions are unaffected.
- Gemini bucket drain made destructive per plan; a repeated tool_call_id's results are emitted after its first requester only — no existing test depended on the old non-destructive read.
- evaluateAsk (autoMode) deliberately gets no sessionId: one-shot tool-free evaluation, documented in its doc comment.
- No extraHeadersFor(style) mapper added: the OpenCode header provider needs the runtime extension version a host-free module cannot supply; decision documented next to HeaderStyleId in providers.ts.
- openCodeExtraHeaders' closed-over uuid map is bounded in practice by sessions per window; later todo should construct the factory per-window.
- Lint warning '_legacy' at src/orchestrator/webviewProtocol.ts:509 is pre-existing (verified against a clean stash).
- The chatController sessionId test pins sessionId against the transcript filename, stability within one session, and divergence after newChat.
