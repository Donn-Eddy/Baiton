# Execute T05

## Summary

Threaded apiLog through ProviderRouterConfig into every client the router builds (OpenAI-compatible via providerClientConfig with surfaceId = provider id; Copilot directly), wired surface.apiLog in commands.ts, left chatController untouched, and added router tests for 500, success, Copilot failure, missing-config, and createClient override.

## Files changed

- `src/activation/providerRouter.ts`
- `src/activation/commands.ts`
- `test/providerRouter.test.ts`

## Commands run

- `npm run compile`
- `npm run lint`
- `npm test`

## Notes

- chatController.ts unchanged (doc touch skipped)
- providerRouter.ts still has only a type-only vscode import; ApiLog imported as type
- compile, lint and full test suite pass (2292 passing)
