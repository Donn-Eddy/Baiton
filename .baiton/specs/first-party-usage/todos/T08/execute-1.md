# Execute T08

## Summary

Added the host-free usage webview protocol (src/usage/protocol.ts), re-exported it from the usage barrel, added UsageViewController (src/activation/usageViewController.ts) and unit tests for both. compile, lint and the full test suite pass.

## Files changed

- `src/usage/protocol.ts`
- `src/usage/index.ts`
- `src/activation/usageViewController.ts`
- `test/usage.protocol.test.ts`
- `test/usageView.controller.test.ts`

## Commands run

- `npm run compile`
- `npm run lint`
- `npm test`

## Notes

- Lint reports one pre-existing warning in src/orchestrator/webviewProtocol.ts; nothing in the new files.
- The controller owns and disposes the UsageService, so the later glue must create a fresh service per resolved view.
- Row-level refreshing is coarse: every row shows refreshing while any refresh is active.
- Polling runs only while the view is visible and stops when hidden.
