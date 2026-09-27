# Execute T09

## Summary

Added the orchestrator 'run' phase and the two spec-less dispatch tools. OrchestratorPhase is now 'gather' | 'drive' | 'run' (ORCHESTRATOR_PHASES ['gather','drive','run']), with doc comments distinguishing the run PHASE from the run TOOL. seams.ts gained StartRunRequest, StartRunOutcome and RunPipelineSeam (importing RunMode from ../model/mode only), and ToolServices carries an optional runPipeline. All eight read tools plus ask_user are advertised in the run phase. controlTools.ts gained start_run(mode, statement, files, reproduction?) and investigate(question, files), both mutating:false, dispatch:true, phases:['run'], each validating arguments before raising one confirm card (mode, statement, files, target branch) through the intervention seam (falling back to the legacy ConfirmSeam with identical text) and then dispatching through RunPipelineSeam.start; a decline writes and dispatches nothing, and Restricted Mode disables both for free via the existing dispatch gate. Shared helpers readFileList, readOneLine, askConfirmCard and targetBranch were added beside the existing arg readers. Tests were extended in all three named files.

## Files changed

- `src/orchestrator/guard.ts`
- `src/orchestrator/seams.ts`
- `src/orchestrator/toolServices.ts`
- `src/orchestrator/readTools.ts`
- `src/orchestrator/controlTools.ts`
- `src/orchestrator/registry.ts`
- `test/registry.controlTools.test.ts`
- `test/registry.assembleToolSpecs.test.ts`
- `test/guard.restrictedMode.property.test.ts`

## Commands run

- `npm run compile`
- `npm run lint`
- `npm test`

## Notes

- npm run compile: clean. npm run lint: 0 errors, 1 pre-existing warning ('_legacy' unused at src/orchestrator/webviewProtocol.ts:591), untouched by this todo. npm test: 1894 passing, 1 pending, 0 failing.
- The plan's step 4 covered only the eight read tools, but the OVERVIEW, the acceptance criteria and the run-phase entry of EXPECTED_PHASE_TOOLS in step 9.2 all require ask_user in the run phase, so askUserTool's phases became ['gather','drive','run'] and the controlTools header paragraph now says ask_user is in all three phases. No other tool's phases changed; `run`, `draft_spec`, `approve_spec`, `submit_pr` and the spec-write tools are unchanged.
- registry.ts took only the documented header-comment change; definitionsFor/assembleFor/call were already phase-generic. Verified by grep that the sole exhaustive Record<OrchestratorPhase, ...> in the tree is EXPECTED_PHASE_TOOLS in test/registry.controlTools.test.ts, which tsc flagged exactly as the plan predicted before it was extended.
- src/activation/commands.ts, src/activation/chatController.ts and src/orchestrator/systemPrompt.ts are unmodified, as the plan requires; commands.ts:618's Map<OrchestratorPhase, ToolSpec[]> read through `?? []` compiles unchanged.
- The Restricted-Mode registry test asserts the dispatch-tool name list is exactly ['draft_spec','investigate','run','start_run'], so a future dispatch tool cannot silently drop out of that coverage. Its git stub is a Proxy whose every property throws, proving no git call is made.
- readFileList rejects a '..' segment by splitting on both separators (path.isAbsolute plus a segment check), so validation stays purely lexical and touches no filesystem, as the plan's risk note requires.
