# Execute T05

## Summary

Added the pure per-mode run Brief context assembler for spec-less runs (src/engine/runContext.ts, exporting buildRunContext and RunContextInput) and made the Brief's Role section stage-aware so the investigate stage gets its own instruction text. runContext emits a fixed '# Run' section (mode, statement, target branch or the investigate read-only note, files or 'none named.') for every stage; bug adds '# Defect' + '# Reproduction' (with a fallback when no steps were supplied), refactor adds '# Behaviour preservation' naming the configured git.verify command (with a no-verify fallback), quick adds nothing; execute adds '# Plan' plus '# Latest review' exactly when attempt >= 2 or resume === true and the review is non-blank; review adds '# Plan', '# Execution' and '# Execute commit' with stageContext's wording ('todo' -> 'run'); investigate emits '# Run', '# Question' and '# Files' only. roleInstructions gained an optional trailing Stage parameter returning the new INVESTIGATE_INSTRUCTION for stage 'investigate' and the unchanged per-role text otherwise; buildBrief passes input.stage through, so every non-investigate brief is byte-identical to before. The module is re-exported from the engine barrel and covered by 30 new cases in test/runContext.test.ts.

## Files changed

- `src/engine/runContext.ts`
- `src/engine/roleInstructions.ts`
- `src/engine/brief.ts`
- `src/engine/index.ts`
- `test/runContext.test.ts`

## Commands run

- `npm run compile`
- `npm run lint`
- `npm test`

## Notes

- npm run compile is clean; npm run lint reports only the pre-existing warning "'_legacy' is assigned a value but never used" at src/orchestrator/webviewProtocol.ts:591; npm test passes 1825 tests, 1 pending, 0 failing.
- No existing test file or assertion was modified — git status shows only the three intended source edits plus the two new files. test/engine.briefWatcher.test.ts, test/engine.launcher.test.ts, test/stageContext.test.ts and test/stageContext.confinement.property.test.ts are untouched and still pass.
- runContext.ts imports only `import type { RunMode } from '../model/mode'` and `import type { RunStage } from './runStore'`; both are type-only and erased, so the module pulls in no fs/path/vscode at runtime.
- The hygiene test builds the 'spec.md' and '.baiton/specs' needles from concatenated fragments so the test file's own assertion text cannot make the substring check trivially pass.
- Per the plan, modeSections uses a `default: return []` arm rather than assertNever, so a future RunMode compiles but emits no framing; the bug/refactor arms are the only ones that emit.
- The '# Execution' / '# Execute commit' fallback wording is copied from stageContext.ts with 'todo' changed to 'run', as the plan's risk note anticipated — the two builders' commit sections are not byte-equal by that one word.
