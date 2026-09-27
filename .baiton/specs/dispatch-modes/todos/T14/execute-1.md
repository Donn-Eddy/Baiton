# Execute T14

## Summary

Implemented T14 ChatController mode handling. The controller now owns a workspaceState-backed conversation mode (new optional `modeMemory` dep, validated host-side with a silent fallback to Spec), echoes every inbound `setMode` host-authoritatively (refusing a change while busy, while a run is in flight, on a spec conversation, or for an off-union value), pins a spec conversation to Spec via `effectiveMode()`, and posts `setMode`/`setRunActive` on every refresh. A send now captures the mode alongside the phase and feeds it to `phaseFor` and `buildSystemPrompt`, so a spec-less Workspace conversation resolves phase 'run' and the run-phase prompt while Spec-mode and spec-conversation sends stay byte-identical to today. Two more optional deps were added: `runs` (a RunActivitySource, structurally satisfied by RunPipeline) subscribed in start() and unsubscribed in dispose(), which mirrors run activity, records a completion system note on the Workspace conversation (logging a failed run too) and, for an Investigate finding, posts a promote card; and `runPipeline` (RunPipelineSeam), which a Bug/Quick choice dispatches through only after the ordinary run confirm card is approved. Exported pure helpers `runCompletionNote`, `PROMOTE_MODES`, `promoteCardRequest`, `promoteRunConfirm` and `startedRunNote` make the wording assertable without a controller. A new 17-case suite covers seeding, echo/persistence, every refusal path, phase/tools/prompt per mode, run-activity mirroring, the completion note, the full promote flow (dismiss, decline, busy, missing seam, Restricted Mode, once-per-run-id) and subscription lifecycle.

## Files changed

- `src/activation/chatController.ts`
- `test/chatController.mode.test.ts`

## Commands run

- `npm run compile`
- `npm run lint`
- `npm test`
- `npx mocha test/chatController.mode.test.ts`

## Notes

- npm run compile is clean; npm run lint reports 0 errors and only the pre-existing '_legacy' warning in src/orchestrator/webviewProtocol.ts; npm test passes with 1994 passing, 1 pending, 0 failing (1977 before, plus the 17 new cases).
- Only src/activation/chatController.ts and the new test/chatController.mode.test.ts changed; commands.ts, media/*, src/orchestrator/* and every existing test are untouched, as the plan required.
- All three new deps are optional, so every existing construction site and both existing chatController suites kept compiling unchanged.
- Plan deviation in the test only: case 15 asserts one DISTINCT promote-card id rather than one showIntervention post, because `noteSystem` refreshes and `repostPendingCards` legitimately re-posts a still-pending card. The card is still created exactly once per run id.
- As the plan's Risks section anticipated, commands.ts still builds `toolsByPhase` with only 'gather'/'drive', so a run-mode send advertises an empty tool list until the host-wiring todo lands. Not fixed here by instruction.
- The promote and confirm cards deliberately leave `Intervention.scopeId` unset so `scopeForAsk` keeps them on the conversation in view.
