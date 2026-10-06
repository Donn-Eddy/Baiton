# Execute T12

## Summary

Integrated sub-agent chats into ChatController and commands.ts. The controller now owns a SubAgentRunner (public `subAgents`, plus `subAgentInterventionSeam`) and passes surface 'top' and a depth-0 caller on top-level tool calls. Live posts are gated on the session in view. A sub-agent's ask card is shown on and persisted to the root chat, with a 'Sub-agent `x` asks:' prefix. Top-level asks raised during a run are bound to the running session. Stop settles every card and aborts descendants. The session list is the tree, children are read-only, and selecting the running session's descendants while busy is allowed. send, compact and delete are refused on a child. commands.ts wires the late-bound SubAgentSeam and origin-stamping intervention seam. New suite plus additions to the interventions and mode suites.

## Files changed

- `src/activation/chatController.ts`
- `src/activation/commands.ts`
- `test/chatController.subAgents.test.ts`
- `test/chatController.interventions.test.ts`
- `test/chatController.mode.test.ts`

## Commands run

- `npm run compile`
- `npm run lint`
- `npm test`
- `npx mocha test/chatController.subAgents.test.ts`
- `npx mocha test/chatController.interventions.test.ts test/chatController.mode.test.ts`

## Notes

- compile passes; lint reports only the pre-existing _legacy warning; npm test: 2620 passing, 1 pending, 0 failing.
- The sub-agent tool surface name used by the runner is 'subagent'; the controller only passes 'top'.
- declinePendingAsks was removed (unused after the onStop rewrite); public declineAsk is unchanged.
- A top-level ask raised during a run binds to the running session when ask.scopeId is undefined or equals the running scope; other scoped asks keep the existing scopeForAsk path.
- Tests poll with waitFor after webview.send because the controller's message handler is not awaited.
- The tests cover all six planned subAgents cases, including stop and reload into a read-only child.
