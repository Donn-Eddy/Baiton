# Execute T10

## Summary

Wired the Usage view: real Node seams (usageViewSeams.ts), WebviewView provider + registerUsageView (usageView.ts), extension.ts registration ahead of the activation gate with override-aware CLI resolution (agy -> antigravity), package.json view/command/view-title menu/setting, vscodeFake delegating members, contribution/glue/seam tests, and README docs. compile, lint (0 errors) and npm test (2812 passing) succeed.

## Files changed

- `src/activation/usageViewSeams.ts`
- `src/activation/usageView.ts`
- `src/extension.ts`
- `package.json`
- `test/fixtures/vscodeFake.mjs`
- `test/fixtures/vscodeFake.d.mts`
- `test/activation.gating.test.ts`
- `test/usageView.view.test.ts`
- `test/usageView.seams.test.ts`
- `README.md`

## Commands run

- `npm run compile`
- `npm run lint`
- `npm test`
- `grep for fs write APIs in new files (none)`

## Notes

- COMMANDS in commands.ts left unchanged (optional step skipped; constant kept in usageView.ts).
- Lint reports one pre-existing warning in src/orchestrator/webviewProtocol.ts.
- No new runtime dependency.
