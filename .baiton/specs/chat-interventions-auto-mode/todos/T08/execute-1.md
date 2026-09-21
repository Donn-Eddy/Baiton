# Execute T08

## Summary

Implemented T08: added the `ask_user` control tool in src/orchestrator/controlTools.ts (registered first in createControlTools; non-mutating, no dispatch flag, phases ['gather','drive']; argument validation via new readOptions/readBoolean helpers before the intervention seam is touched; option/text/declined/approved answer mapping; unavailable-host error when no seam is wired) and extended the module JSDoc and phase paragraph. Documented the `intervention` seam as ask_user's first direct consumer in src/orchestrator/toolServices.ts (JSDoc plus the interface bullet list). Added the exported ASK_USER_TEXT block to src/orchestrator/systemPrompt.ts, included it in every phase right after the refusal rule, amended the STYLE_TEXT bullet to 'one clarifying question at a time with `ask_user`', and extended the module JSDoc. Wired the real host: src/activation/commands.ts now takes the shared interventionSeam into buildToolServices (new trailing parameter after confirm, included in the returned bundle, passed at both call sites). Extended test/registry.controlTools.test.ts (EXPECTED_TOOLS, both EXPECTED_PHASE_TOOLS arrays, recordingIntervention seam helper, makeServices trailing intervention parameter, a nine-case ask_user describe block) and test/systemPrompt.test.ts (ASK_USER_TEXT verbatim in all four prompts, the instead-of-ending-the-turn rule, options/allow_free_text/blocking mentions, decline-is-a-refusal, and the tool-naming style bullet). npm run compile, npm run lint and npm test all pass: 938 passing / 1 pending / 0 failing, with the baseline case count topped up by the new registry and prompt cases and no pre-existing case regressed.

## Files changed

- `src/orchestrator/controlTools.ts`
- `src/orchestrator/toolServices.ts`
- `src/orchestrator/systemPrompt.ts`
- `src/activation/commands.ts`
- `test/registry.controlTools.test.ts`
- `test/systemPrompt.test.ts`

## Commands run

- `npm run compile`
- `npm run lint`
- `npm test`

## Notes

- ask_user deliberately sets no `dispatch` flag so it remains usable under Restricted Mode; only the mutating tools keep needing idempotency keys.
- A free-text question omits the `options` key entirely (not an empty array) so checkAnswer accepts a typed answer at the registry.
- A declined answer returns ok:false with the decline reason in the error message, including the Stop-driven 'the run was stopped' decline from PendingAskRegistry.rejectAll.
- One test-count nuance: the plan expected ~935 passing; the suite now shows 938 passing / 1 pending / 0 failing (new ask_user cases plus their phase-table and availability variants land slightly above the rough estimate mentioned in the plan).
