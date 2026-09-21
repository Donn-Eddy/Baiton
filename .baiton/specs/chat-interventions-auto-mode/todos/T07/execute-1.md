# Execute T07

## Summary

T07 done: ChatController now presents orchestrator confirmations as inline cards through the intervention seam. ToolServices gained the optional `intervention` seam with `confirm` documented as its yes/no adapter; ChatController owns the PendingAskRegistry, projects asks via toInterventionView, posts showIntervention cards, handles answerIntervention (valid → resolveIntervention + settled system transcript record; invalid → showError, ask stays pending; unknown id → settled declined), and stop declines every pending ask with STOP_DECLINE_REASON. The duplicated approve_spec modal gate, APPROVE_TOOL_NAME, approveSlugFromArgs and the callTool slug parameter were removed; the transcript-tagging toChatMessage/history projection emits `[intervention] <prompt>\nDecision: <outcome>`. commands.ts builds one shared PendingAskRegistry + InterventionSeam, passes confirmSeamFrom(seam) into both buildToolServices call sites, passes askRegistry to the controller, binds presentAsk to controller.presentIntervention once the chat view resolves, and keeps the modal as a pre-view fallback. New host-free suite test/chatController.interventions.test.ts (8 cases) covers card-raising/pause, settle-in-place, decline, persistence + re-render, invalid and unknown answers, stop, and history projection. npm run compile, npm run lint and npm test all pass: 920 passing / 1 pending / 0 failing (baseline 912 + 8 new).

## Files changed

- `src/orchestrator/toolServices.ts`
- `src/activation/chatController.ts`
- `src/activation/commands.ts`
- `test/chatController.interventions.test.ts`

## Commands run

- `npm run compile`
- `npm run lint`
- `npm test`
- `npx mocha --timeout 15000 test/chatController.interventions.test.ts`

## Notes

- ChatController's webview handler is fire-and-forget ((msg) => void handle(msg)), so the new tests poll for settlement (`waitFor` helpers and awaitRunEnd requiring a minimum completion count) instead of awaiting the fake webview's send promise; running a send without fixed polling raced the setBusy post.
- The plan's fake registry was written as a cast plain object over the shared InterventionSeam, as prescribed; the fake tool name `confirm_tool` is never matched against a real tool (registry is a class, cast via `as unknown as ToolRegistry`).
- media/chat.js and media/protocol.js untouched, as required; setAutoMode stays unhandled in the switch (non-exhaustive by design).
