# Execute T01

## Summary

Added the host-free usage reading model (src/usage/model.ts), a barrel (src/usage/index.ts) and unit tests (test/usage.model.test.ts). Compile, lint and the full test suite pass.

## Files changed

- `src/usage/model.ts`
- `src/usage/index.ts`
- `test/usage.model.test.ts`

## Commands run

- `npm run compile`
- `npm run lint`
- `npm test`

## Notes

- Lint shows one existing warning in src/orchestrator/webviewProtocol.ts (_legacy unused); none in the new files.
- npm run compile re-ran copy:media, which left no git changes.
- The todo text was truncated, so the reading shape follows the plan's reconstruction.
- model.ts has no import or require statements; a test enforces this.
- Tool id 'opencode-go' is distinct from AgentId 'opencode'; later wiring must map them explicitly.
