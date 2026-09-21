# Execute T19

## Summary

T19: wired Auto-mode to key its allow-list on the relayed run's trusted context (AutoModeRunContext: agent/role/runId) instead of the restrictive fallback. Added AutoModeRunContext + runId routing in the autoMode core (run-directory line in the stage-(b) prompt only when a runId is present), threaded the role from runQueue's AskWatcherFactory.create call site, carried the context from VscodeAskWatcher through the widened AskRoute.present seam, extended ChatController's AutoModeGate/presentIntervention with an optional run context, and rewrote the commands.ts gate to build agentAllowList(context.agent, context.role, context.runId) (falling back to AUTO_MODE_FALLBACK_ROLE/AUTO_MODE_UNKNOWN_RUN when no context). Added controller cases 11-14 (relayed context reach, no-context fallback, relayed allow-list audit, relayed escalation pending->settled audit), a routed-context case in the ask-watcher routing suite, and run-directory prompt cases in the evaluator suite. Compile, lint and full npm test pass (no pre-existing test removed).

## Files changed

- `src/orchestrator/autoMode.ts`
- `src/engine/runQueue.ts`
- `src/activation/vscodeAskWatcher.ts`
- `src/activation/chatController.ts`
- `src/activation/commands.ts`
- `test/chatController.autoMode.test.ts`
- `test/askWatcher.routing.test.ts`
- `test/autoMode.evaluator.test.ts`

## Commands run

- `npm run compile`
- `npm run lint`
- `npx mocha --no-config --require ts-node/register test/chatController.autoMode.test.ts test/askWatcher.routing.test.ts test/autoMode.evaluator.test.ts test/autoMode.allowList.test.ts test/engine.launcher.test.ts test/chatController.interventions.test.ts`
- `npm test`

## Notes

- --no-config mocha runs under the 2s default timeout and one waitFor blew it; the targeted suite plus npm test were run under the repo's .mocharc (60s) instead.
- test/chatController.autoMode.test.ts cases 11 and 14 poll on showIntervention >= 1 (the start-time refresh re-posts pending cards) and 14 adds a 50ms delay before reading the transcript because ChatTranscript writes are buffered — a direct read right after result.json the awaited answer returned only the pending record three out of three times.
- The queue-wiring deepStrictEqual in test/askWatcher.routing.test.ts also needed role: 'planner' because it asserts the whole AskWatcherFactory.create input object.
- The test count is now 1163 passing / 1 pending (the brief's baseline figure of 1053 does not match the current tree even before my change; no pre-existing test was removed or modified away from its original assertions except the routing create-input assertion, which gained the new required field).
