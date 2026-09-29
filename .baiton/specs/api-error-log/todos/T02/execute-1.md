# Execute T02

## Summary

Surface now owns a second silent 'API' output channel (API_CHANNEL_NAME, apiOutputChannel getter, apiLog built with createApiLog, logApiFailure). extension.ts registers it for disposal right after the Baiton channel. Added test/surface.apiChannel.test.ts with fake channels covering all planned cases.

## Files changed

- `src/activation/surface.ts`
- `src/extension.ts`
- `test/surface.apiChannel.test.ts`

## Commands run

- `npm run compile`
- `npm run lint`
- `npm test`
- `grep -nE "show\(|reveal|show[A-Za-z]*Message" src/activation/surface.ts`

## Notes

- compile passes; lint shows only the pre-existing webviewProtocol.ts warning; npm test: 2263 passing, 1 pending.
- The grep finds only the pre-existing showInformation/Warning/ErrorMessage calls in info/warn/error, plus doc comments that mention 'reveals'. The new code adds no show() or reveal call.
- The constructor uses ?? short-circuiting, so injecting both fake channels never touches vscode.window.createOutputChannel.
