# Execute T08

## Summary

Renamed the activation UI to Plan Explorer and phase terminology, preserved legacy document and persisted-field compatibility, and added coverage for both plan roots.

## Files changed

- `media/chat.html`
- `media/chat.js`
- `media/config.html`
- `media/config.js`
- `media/usage.html`
- `media/usage.js`
- `package.json`
- `src/activation/chatController.ts`
- `src/activation/commands.ts`
- `src/activation/configRefresh.ts`
- `src/activation/engineFacade.ts`
- `src/activation/planExplorer.ts`
- `src/activation/runsExplorer.ts`
- `src/activation/specExplorer.ts`
- `src/extension.ts`
- `src/model/phaseActions.ts`
- `src/model/planActions.ts`
- `src/orchestrator/webviewProtocol.ts`
- `test/activation.gating.test.ts`
- `test/chatController.mode.test.ts`
- `test/chatView.mode.test.ts`
- `test/engine.planDraft.test.ts`
- `test/engineFacade.resume.test.ts`
- `test/fixtures/vscodeFake.mjs`
- `test/integration.plan-execute-review.test.ts`
- `test/integration.run-modes.test.ts`
- `test/integration.sub-agent-chats.test.ts`
- `test/phaseActions.property.test.ts`
- `test/planActions.property.test.ts`
- `test/planExplorer.test.ts`
- `test/runCommands.test.ts`

## Commands run

- `npm run compile`
- `npm run lint`
- `npm test`
- `git diff --check`
- `Retired-identifier and whole-word terminology rg sweeps`

## Notes

- Full test suite passed: 2,875 passing, 1 pending. The sandboxed run hit EPERM when integration tests spawned git; the elevated rerun passed.
- Lint reported 0 errors and one warning at src/orchestrator/webviewProtocol.ts:678 for the unused _legacy binding.
- The workspace .git index is read-only, so git mv could not run; the explorer file was moved with mv and appears as a deleted old path plus an untracked new path until Git processes it.
