# Execute P05

## Summary

Added optional owning-repository context for plan conversations, qualified plan-addressing guidance, owner framing, and repository ownership instructions. Added prompt identity and addressing coverage.

## Files changed

- `src/orchestrator/systemPrompt.ts`
- `src/engine/roleInstructions.ts`
- `test/systemPrompt.repos.test.ts`
- `test/systemPrompt.test.ts`

## Commands run

- `npm run compile`
- `npm run lint`
- `npm test -- --reporter dot`
- `git diff --check`

## Notes

- Compile passed. Lint passed with zero errors and one existing unused-variable warning in src/orchestrator/webviewProtocol.ts:678.
- The full suite passed on rerun outside the sandbox: 3,133 passing, 1 pending. The sandboxed run hit git EPERM errors and a child-process stdout mismatch.
- git diff --check was clean.
