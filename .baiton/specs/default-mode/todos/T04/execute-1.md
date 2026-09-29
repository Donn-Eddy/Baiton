# Execute T04

## Summary

ChatController.effectiveMode() now pins a spec conversation to the literal 'spec'. Seeding still uses DEFAULT_MODE (now Default). Comments updated in chatController.ts, commands.ts and engineFacade.ts. The mode test file gained four new tests and updated pins.

## Files changed

- `src/activation/chatController.ts`
- `src/activation/commands.ts`
- `src/activation/engineFacade.ts`
- `test/chatController.mode.test.ts`

## Commands run

- `npx tsc -p ./ --noEmit`
- `npx mocha -g 'ChatController conversation mode'`
- `npx mocha`
- `git grep -n DEFAULT_MODE src/activation`

## Notes

- tsc clean; all 21 tests in chatController.mode.test.ts pass.
- Full mocha: 2230 passing, 2 failing. The failures are the webviewProtocol browser mirror and reducer 'conversation mode and run activity' parity tests, owned by later todos, and were not touched.
- DEFAULT_MODE in src/activation appears only in the import, the field initializer, the constructor seed, the commands.ts composerMode reader, and comments. effectiveMode() no longer uses it in code.
