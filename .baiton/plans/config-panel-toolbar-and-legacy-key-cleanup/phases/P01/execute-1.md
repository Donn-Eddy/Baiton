# Execute P01

## Summary

Added the More settings and Manage API keys toolbar hand-offs, widened the settings filter to all Baiton settings, and covered their behavior.

## Files changed

- `media/config.html`
- `media/config.js`
- `src/extension.ts`
- `src/activation/configPanel.ts`
- `src/activation/configPanelController.ts`
- `test/activation.gating.test.ts`
- `test/configPanel.view.test.ts`
- `test/modelSelectorRefresh.test.ts`

## Commands run

- `git diff --check`
- `npm run compile`
- `npx mocha --no-config --node-option no-strip-types --require ts-node/register --timeout 60000 test/configPanel.mirror.test.ts test/configPanel.controller.test.ts test/configPanel.view.test.ts test/activation.gating.test.ts`
- `npm test`

## Notes

- Compile passed; the four targeted files passed with 206 tests.
- The full test suite passed with 3,055 passing and 1 pending. Its sandboxed attempt hit git EPERM, so the successful full run was performed outside the sandbox.
- The config panel view fixture does not expose its mocked persisted state; draft preservation is covered through the visible form value and Save state.
