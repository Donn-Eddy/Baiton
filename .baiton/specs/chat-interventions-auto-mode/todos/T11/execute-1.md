# Execute T11

## Summary

Wired Auto mode into the chat (T11): added the escalation field + escalatedInterventionView/labels helper to webviewProtocol (reduce/WebviewState untouched); gave ChatController an autoMode state seeded/persisted through a new AutoModeMemory seam, a setAutoMode message case with echo, an AutoModeGate seam type gated only on permission asks presented while on, an async presentIntervention with autoApprove/audit and escalate-on-card/audit paths, and a throwing-gate escalation; wired the real two-stage decideAsk gate and the workspaceState-backed autoModeMemory into commands.ts; added the host-free test/chatController.autoMode.test.ts with 10 cases.

## Files changed

- `src/orchestrator/webviewProtocol.ts`
- `src/activation/chatController.ts`
- `src/activation/commands.ts`
- `test/chatController.autoMode.test.ts`

## Commands run

- `npm run compile (clean, twice)`
- `npx mocha --timeout 15000 test/chatController.autoMode.test.ts (10 passing)`
- `npm run lint (no problems)`
- `npm test (1053 passing / 1 pending / 0 failing; baseline 1043 + 10 new cases)`
- `git status --porcelain (only the four intended files modified; media/*, protocol fixtures and src/orchestrator/autoMode.ts untouched)`

## Notes

- The plan's case 10 ordering as written is not observable: the seam's present promise does not resolve until the gate is released, so the paused tool cannot observe the stop's declined answer while the gate is held (the registry entry is already gone, but seam.ask is blocked inside await present). The test sends stop, releases the gate, and then asserts observed[0] === { kind: 'declined', reason: STOP_DECLINE_REASON }, no auto showIntervention, and zero transcript records — matching the acceptance bullet that a late gate approval neither posts a card nor writes a record.
- awaitRunEnd gained a minRequests parameter: after a stop the aborted tool loop finishes without a second model round, so the stop test waits with minRequests 1.
- escalation deep-equal assertions compare the what/why fields explicitly because the persisted view inlines the AutoModeOutcome's kind ('escalate') alongside them.
- The class-header duplicate interventions responsibility bullet was collapsed into one bullet mentioning the Auto-mode gate and the persisted audit trail.
