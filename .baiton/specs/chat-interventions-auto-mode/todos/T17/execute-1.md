# Execute T17

## Summary

Implemented queue-level harness ask relaying, a VS Code ask watcher, scoped chat-card routing, and focused watcher coverage.

## Files changed

- `src/engine/runQueue.ts`
- `src/activation/vscodeAskWatcher.ts`
- `src/activation/chatController.ts`
- `src/activation/commands.ts`
- `src/activation/engineFacade.ts`
- `test/askWatcher.routing.test.ts`

## Commands run

- `npm run compile`
- `npx mocha --no-config test/askWatcher.routing.test.ts --require ts-node/register`
- `npm run lint`

## Notes

- Compile and lint passed.
- Focused watcher suite passed (2 tests).
- The focused Mocha run emits Node's MODULE_TYPELESS_PACKAGE_JSON warning only.
