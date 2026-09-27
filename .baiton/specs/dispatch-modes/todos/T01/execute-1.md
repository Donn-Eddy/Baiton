# Execute T01

## Summary

Added the run-mode vocabulary and the investigate stage exactly as planned. New src/model/mode.ts exports RunMode, RUN_MODES, DEFAULT_MODE ('spec'), isRunMode and isSpecless (true for every mode but spec), re-exported from src/model/index.ts immediately after './stage'. Appended 'investigate' to the Stage union and STAGES (now 7 members, the six originals in their original order) and documented it in the module comment as run-scoped, run by the reviewer role, persisting a single finding.md. Added InvestigateResult to src/schema/types.ts and the strict investigateSchema (non-empty finding, string arrays for files/next_steps, additionalProperties:false, no if/then/else) to src/schema/schemas.ts. Wired it through src/schema/index.ts: compiled validator in VALIDATORS, entry in STAGE_SCHEMAS, re-exported schema, validateInvestigateResult wrapper, excluded from stageArtifactIsNumbered, and a 'finding.md' case in persistencePathForStage with the doc comment extended to say the path is run-relative rather than spec-relative. Added renderInvestigateArtifact to src/engine/resultFlow.ts (reusing the existing bullets() helper so empty lists render '- (none)') and its case in renderArtifact. Mapped investigate to the existing reviewer role in STAGE_ROLE. No new role, no config migration: src/model/role.ts, src/adapter/roleProfile.ts, the config roles mapping and defaultConfig are untouched. Tests: new test/mode.test.ts (18 cases across four describes, including the 'existing stages unchanged' regression guard), a new investigate describe plus two cross-stage guards in test/schema.examples.test.ts, and the three additive arms in the stage-exhaustive property tests. npm run compile and npm run lint are clean and the full suite passes at 1736 passing / 1 pending with no pre-existing assertion modified.

## Files changed

- `src/model/mode.ts`
- `src/model/index.ts`
- `src/model/stage.ts`
- `src/schema/types.ts`
- `src/schema/schemas.ts`
- `src/schema/index.ts`
- `src/engine/resultFlow.ts`
- `src/activation/engineFacade.ts`
- `test/mode.test.ts`
- `test/schema.examples.test.ts`
- `test/schema.reject.property.test.ts`
- `test/schema.roundtrip.property.test.ts`
- `test/schema.persistencePath.property.test.ts`

## Commands run

- `npm run compile`
- `npm run lint`
- `npm test`

## Notes

- npm run compile is clean. The Record<Stage, ...> totality checks did the work the plan predicted: before the test edits, tsc flagged exactly the two expected errors (baseResult lacking an ending return in test/schema.reject.property.test.ts, and 'investigate' missing from RESULT_ARBS in test/schema.roundtrip.property.test.ts). No Record<Stage, ...> turned up outside the files the plan named.
- npm run lint reports 0 errors and 1 warning: '_legacy' is assigned a value but never used at src/orchestrator/webviewProtocol.ts:591. That warning is pre-existing and in a file this todo does not touch.
- npm test: 1736 passing, 1 pending, 0 failing. The new test/mode.test.ts runs under plain mocha with no vscode import; importing STAGE_ROLE from src/activation/engineFacade works because that module is still host-free, as test/engineFacade.resume.test.ts already relies on.
- Step 9's three edits to existing test files are strictly additive — a new switch arm, a new arbitrary plus its map entry, and a new else-if arm — plus one added assertion and a rename in the closing 'the run- and spec-scoped stages ignore the todo id' case of test/schema.persistencePath.property.test.ts, as the plan specified. No existing assertion was weakened or removed.
- isSpecless is defined as mode !== 'spec', so it is true for investigate as well; callers wanting the three-mode build pipeline specifically must test mode !== 'spec' && mode !== 'investigate'. This is the plan's documented reading of the ambiguous OVERVIEW wording, and it is a one-line change if a later todo wants the narrower meaning.
- artifactPathFor is deliberately unchanged, so calling it with 'investigate' would join 'finding.md' under .baiton/specs/<slug>/. Only the persistencePathForStage doc comment notes this; avoiding it is the run-pipeline todo's job, since that todo supplies its own ArtifactWriter and run-dir path.
- renderArtifact's third parameter is still named todoId; an investigate run passes its run id through it. A comment on the new case records the reuse rather than renaming the parameter and rippling through every caller.
- The roundtrip arb uses fc.string({ minLength: 1 }) for finding, since the shared textArb can produce '' and investigateSchema rejects it.
