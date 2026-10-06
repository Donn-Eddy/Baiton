# Execute T10

## Summary

Added the sub-agent tool surface (ToolSurface/ToolCaller/subagent flag), SubAgentSeam + MAX_SUBAGENT_DEPTH, spawn_subagent and send_to_subagent control tools with depth-2 refusal, surface-aware registry definitionsFor/assembleFor/call, and buildSubAgentPrompt with tests. compile, lint (0 errors) and the full test suite (2597 passing) succeed.

## Files changed

- `src/orchestrator/guard.ts`
- `src/orchestrator/seams.ts`
- `src/orchestrator/toolServices.ts`
- `src/orchestrator/controlTools.ts`
- `src/orchestrator/registry.ts`
- `src/orchestrator/systemPrompt.ts`
- `test/registry.controlTools.test.ts`
- `test/registry.assembleToolSpecs.test.ts`
- `test/systemPrompt.subagent.test.ts`

## Commands run

- `npm run compile`
- `npm run lint`
- `npm test`
- `grep -rn "from 'vscode'" src/orchestrator`

## Notes

- Lint reports one pre-existing warning in webviewProtocol.ts (_legacy unused); no errors.
- The vscode grep matches only copilotClient.ts, a pre-existing `import type` and a comment; nothing new from this todo.
- chatController/commands.ts still call registry.call with 5 args, so spawn_subagent from a real chat refuses with 'needs a calling chat' until the runner todo wires caller and surface.
